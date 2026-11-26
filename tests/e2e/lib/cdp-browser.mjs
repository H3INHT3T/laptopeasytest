import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createTauriInitScript } from "./tauri-ipc-mock.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverChromiumExecutable() {
  const candidates = [];

  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const msPlaywrightDir = path.join(localAppData, "ms-playwright");
    if (fs.existsSync(msPlaywrightDir)) {
      const entries = fs.readdirSync(msPlaywrightDir, { withFileTypes: true }).filter((d) => d.isDirectory());

      const headlessShellDirs = entries
        .filter((d) => d.name.startsWith("chromium_headless_shell-"))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dir of headlessShellDirs) {
        candidates.push(path.join(msPlaywrightDir, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe"));
      }

      const chromiumDirs = entries
        .filter((d) => d.name.startsWith("chromium-"))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dir of chromiumDirs) {
        candidates.push(path.join(msPlaywrightDir, dir, "chrome-win64", "chrome.exe"));
      }
    }

    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No Chromium/Chrome/Edge executable found. Checked:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}

function startStaticServer(distDir) {
  const absDist = path.resolve(distDir);
  if (!fs.existsSync(absDist)) {
    throw new Error(`Built frontend directory not found: ${absDist}`);
  }

  const server = http.createServer((req, res) => {
    try {
      const rawUrl = (req.url || "/").split("?")[0];
      let decoded;
      try {
        decoded = decodeURIComponent(rawUrl);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
        return;
      }

      const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      const target = path.resolve(absDist, rel);
      if (target !== absDist && !target.startsWith(absDist + path.sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(target).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const body = fs.readFileSync(target);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err?.message || "Internal Server Error");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function createCdpConnection(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = (ev) => {
      ws.removeEventListener("open", onOpen);
      reject(new Error(`CDP WebSocket connection failed (${wsUrl}): ${ev?.message || "error"}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onErr, { once: true });
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message} (${msg.error.code})`));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }

    if (msg.method) {
      const set = listeners.get(msg.method);
      if (set) {
        for (const fn of set) {
          try {
            fn(msg.params || {});
          } catch {
            // Ignore listener exceptions
          }
        }
      }
    }
  });

  ws.addEventListener("close", () => {
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      entry.reject(new Error(`CDP connection closed while awaiting ${entry.method}`));
    }
  });

  function send(method, params = {}) {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP WebSocket not open for ${method}`));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method)?.delete(fn);
  }

  function close() {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      // Ignore
    }
  }

  return { send, on, close };
}

function mapKeyDefinition(key) {
  const k = String(key);
  const special = {
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "" },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
  };
  if (special[k]) return special[k];

  if (k.length === 1) {
    const upper = k.toUpperCase();
    const charCode = upper.charCodeAt(0);
    if (charCode >= 65 && charCode <= 90) {
      return { key: k, code: `Key${upper}`, windowsVirtualKeyCode: charCode, text: k };
    }
    if (charCode >= 48 && charCode <= 57) {
      return { key: k, code: `Digit${k}`, windowsVirtualKeyCode: charCode, text: k };
    }
    return { key: k, code: k, windowsVirtualKeyCode: k.charCodeAt(0), text: k };
  }

  return { key: k, code: k, windowsVirtualKeyCode: 0, text: "" };
}

function killPidTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Process may have already exited
  }
}

function safeRmDirSync(dirPath) {
  if (!dirPath) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      return;
    } catch {
      // Brief pause on Windows file lock release
      const end = Date.now() + 40;
      while (Date.now() < end) {
        // spin briefly
      }
    }
  }
}

function serializeMatcher(textOrRegex) {
  if (textOrRegex instanceof RegExp) {
    return { isRegex: true, source: textOrRegex.source, flags: textOrRegex.flags.replace(/g/g, "") };
  }
  return { isRegex: false, text: String(textOrRegex) };
}

export function createBrowserManager({ distDir, rootDir } = {}) {
  const resolvedDist = distDir
    ? path.resolve(distDir)
    : rootDir
    ? path.resolve(rootDir, "dist")
    : null;
  if (!resolvedDist) {
    throw new Error("createBrowserManager requires { distDir } or { rootDir }");
  }

  const activeSessions = new Set();

  function syncCleanupOnExit() {
    for (const session of Array.from(activeSessions)) {
      try {
        session.pageClient?.close();
        session.browserClient?.close();
      } catch {
        // ignore
      }
      try {
        session.server?.closeAllConnections?.();
        session.server?.close();
      } catch {
        // ignore
      }
      if (!session.childExited && session.child?.pid) {
        killPidTreeSync(session.child.pid);
      }
      safeRmDirSync(session.userDataDir);
      activeSessions.delete(session);
    }
  }

  const onExit = () => syncCleanupOnExit();
  const onSigInt = () => {
    syncCleanupOnExit();
    process.exit(130);
  };
  const onSigTerm = () => {
    syncCleanupOnExit();
    process.exit(143);
  };

  process.once("exit", onExit);
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  async function openApp(fixture = {}, opts = {}) {
    const exePath = discoverChromiumExecutable();
    const { server, port } = await startStaticServer(resolvedDist);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "laptopbench-e2e-"));
    const extraArgs = Array.isArray(opts.chromiumArgs) ? opts.chromiumArgs : [];

    const args = [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      "--window-size=1360,880",
      `--user-data-dir=${userDataDir}`,
      ...extraArgs,
      "about:blank",
    ];

    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session = {
      server,
      child,
      userDataDir,
      childExited: false,
      browserClient: null,
      pageClient: null,
      closed: false,
    };
    activeSessions.add(session);

    child.once("exit", () => {
      session.childExited = true;
    });

    async function close() {
      if (session.closed) return;
      session.closed = true;
      activeSessions.delete(session);

      try {
        if (session.browserClient && !session.childExited) {
          await Promise.race([
            session.browserClient.send("Browser.close").catch(() => {}),
            sleep(1000),
          ]);
        }
      } catch {
        // ignore
      }

      if (!session.childExited) {
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          sleep(1500),
        ]);
      }

      session.pageClient?.close();
      session.browserClient?.close();

      if (!session.childExited && child.pid) {
        killPidTreeSync(child.pid);
        await sleep(150);
      }

      try {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      } catch {
        // ignore
      }

      safeRmDirSync(userDataDir);
    }

    session.close = close;

    try {
      const browserWsUrl = await new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for Chromium DevTools WS URL. Output:\n${output}`));
        }, 15000);

        const onChunk = (chunk) => {
          output += chunk.toString("utf8");
          const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            child.stderr?.off("data", onChunk);
            child.stdout?.off("data", onChunk);
            resolve(match[1]);
          }
        };

        child.stderr?.on("data", onChunk);
        child.stdout?.on("data", onChunk);
        child.once("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn Chromium (${exePath}): ${err.message}`));
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Chromium exited early with code ${code}. Output:\n${output}`));
        });
      });

      const debugPort = new URL(browserWsUrl).port;
      session.browserClient = await createCdpConnection(browserWsUrl);

      let pageTarget = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await res.json();
        pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (pageTarget) break;
        await sleep(50);
      }
      if (!pageTarget) {
        throw new Error("Could not locate CDP page target in /json/list");
      }

      const pageClient = await createCdpConnection(pageTarget.webSocketDebuggerUrl);
      session.pageClient = pageClient;

      const cdpErrors = [];
      pageClient.on("Runtime.exceptionThrown", (params) => {
        const details = params.exceptionDetails || {};
        const desc =
          details.exception?.description ||
          details.text ||
          "Unhandled Runtime exception";
        cdpErrors.push({
          source: "Runtime.exceptionThrown",
          message: desc,
          lineNumber: details.lineNumber,
          columnNumber: details.columnNumber,
        });
      });
      pageClient.on("Runtime.consoleAPICalled", (params) => {
        if (params.type === "error") {
          const text = (params.args || [])
            .map((a) => a.value ?? a.description ?? a.type)
            .join(" ");
          cdpErrors.push({
            source: "console.error",
            message: text,
          });
        }
      });

      await pageClient.send("Page.enable");
      await pageClient.send("Runtime.enable");
      await pageClient.send("DOM.enable");

      const maxTouchPoints =
        opts.maxTouchPoints !== undefined
          ? opts.maxTouchPoints
          : fixture?.touchCapabilities?.maxTouchPoints ?? 5;
      if (maxTouchPoints > 0) {
        await pageClient.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints,
        });
      } else {
        await pageClient.send("Emulation.setTouchEmulationEnabled", {
          enabled: false,
        });
      }

      const initScript = createTauriInitScript(fixture, opts.mockOptions);
      await pageClient.send("Page.addScriptToEvaluateOnNewDocument", {
        source: initScript,
      });

      const loadFired = new Promise((resolve) => {
        const off = pageClient.on("Page.loadEventFired", () => {
          off();
          resolve();
        });
      });

      const appUrl = `http://127.0.0.1:${port}/`;
      await pageClient.send("Page.navigate", { url: appUrl });
      await Promise.race([loadFired, sleep(10000)]);

      async function evaluate(fnOrExpr, ...fnArgs) {
        const expression =
          typeof fnOrExpr === "function"
            ? `(${fnOrExpr.toString()})(...${JSON.stringify(fnArgs)})`
            : String(fnOrExpr);
        const result = await pageClient.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          const msg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Runtime.evaluate exception";
          throw new Error(`Browser evaluate failed: ${msg}`);
        }
        return result.result?.value;
      }

      // Wait for React root mount
      const mountDeadline = Date.now() + (opts.mountTimeoutMs ?? 10000);
      while (Date.now() < mountDeadline) {
        const mounted = await evaluate(
          () => Boolean(document.querySelector("#root") && document.querySelector("#root").children.length > 0)
        );
        if (mounted) break;
        await sleep(35);
      }
      const isMounted = await evaluate(
        () => Boolean(document.querySelector("#root") && document.querySelector("#root").children.length > 0)
      );
      if (!isMounted) {
        throw new Error(`App did not mount into #root within timeout. Errors: ${JSON.stringify(cdpErrors)}`);
      }

      // Give initial mount Promise.all IPC calls a brief tick to settle if desired
      await sleep(30);

      async function getBodyText() {
        return evaluate(() => document.body?.innerText || "");
      }

      async function waitForText(textOrRegex, timeoutMs = 5000) {
        const matcher = serializeMatcher(textOrRegex);
        const deadline = Date.now() + timeoutMs;
        let lastText = "";
        while (Date.now() < deadline) {
          const snapshot = await evaluate(() => ({
            innerText: document.body?.innerText || "",
            textContent: document.body?.textContent || "",
          }));
          lastText = snapshot?.innerText || "";
          const tc = snapshot?.textContent || "";
          const matched = matcher.isRegex
            ? new RegExp(matcher.source, matcher.flags).test(lastText) ||
              new RegExp(matcher.source, matcher.flags).test(tc)
            : lastText.includes(matcher.text) || tc.includes(matcher.text);
          if (matched) return lastText;
          await sleep(40);
        }
        throw new Error(
          `waitForText timed out after ${timeoutMs}ms waiting for ${String(textOrRegex)}. Body snippet: ${lastText
            .replace(/\s+/g, " ")
            .slice(0, 300)}`
        );
      }

      async function dispatchMouseClick(x, y) {
        await pageClient.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "none",
        });
        await pageClient.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await pageClient.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await sleep(25);
      }

      async function clickButton(textOrRegex) {
        const matcher = serializeMatcher(textOrRegex);
        const info = await evaluate((m) => {
          const rx = m.isRegex ? new RegExp(m.source, m.flags) : null;
          const matches = (str) => {
            const norm = String(str || "").replace(/\s+/g, " ").trim();
            return rx ? rx.test(norm) : norm.includes(m.text);
          };
          const buttons = Array.from(document.querySelectorAll("button"));
          const matched = [];
          for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            const cs = getComputedStyle(btn);
            const visible = rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
            const candidates = [
              btn.innerText || "",
              btn.textContent || "",
              btn.getAttribute("aria-label") || "",
              btn.getAttribute("title") || "",
            ];
            if (visible && candidates.some(matches)) {
              const label = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || btn.getAttribute("title") || "")
                .replace(/\s+/g, " ")
                .trim();
              matched.push({
                btn,
                disabled: Boolean(btn.disabled),
                text: label,
              });
            }
          }
          const target = matched.find((x) => !x.disabled) || matched[0];
          if (!target) {
            return { found: false };
          }
          if (target.disabled) {
            return { found: true, disabled: true, text: target.text };
          }
          target.btn.scrollIntoView({ block: "center", inline: "center" });
          const rect = target.btn.getBoundingClientRect();
          return {
            found: true,
            disabled: false,
            text: target.text,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }, matcher);

        if (!info.found) {
          throw new Error(`clickButton: no visible button matching ${String(textOrRegex)}`);
        }
        if (info.disabled) {
          throw new Error(`clickButton: matched button "${info.text}" is disabled`);
        }
        await dispatchMouseClick(info.x, info.y);
        return info.text;
      }

      async function clickStep(stepLabelOrRegex) {
        const matcher = serializeMatcher(stepLabelOrRegex);
        const info = await evaluate((m) => {
          const rx = m.isRegex ? new RegExp(m.source, m.flags) : null;
          const matches = (str) => {
            const norm = String(str || "").replace(/\s+/g, " ").trim();
            return rx ? rx.test(norm) : norm.includes(m.text);
          };
          const buttons = Array.from(document.querySelectorAll("aside nav button, aside button"));
          for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            const candidates = [
              btn.innerText || "",
              btn.textContent || "",
              btn.getAttribute("title") || "",
            ];
            if (visible && candidates.some(matches)) {
              const label = (btn.innerText || btn.textContent || btn.getAttribute("title") || "").replace(/\s+/g, " ").trim();
              if (btn.disabled) {
                return { found: true, disabled: true, text: label };
              }
              btn.scrollIntoView({ block: "center", inline: "center" });
              const r = btn.getBoundingClientRect();
              return {
                found: true,
                disabled: false,
                text: label,
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
              };
            }
          }
          return { found: false };
        }, matcher);

        if (!info.found) {
          throw new Error(`clickStep: no sidebar step button matching ${String(stepLabelOrRegex)}`);
        }
        if (info.disabled) {
          throw new Error(`clickStep: step button "${info.text}" is locked/disabled`);
        }
        await dispatchMouseClick(info.x, info.y);
        return info.text;
      }

      async function fillInput(placeholderOrLabel, value) {
        const matcher = serializeMatcher(placeholderOrLabel);
        const res = await evaluate((m, nextVal) => {
          const rx = m.isRegex ? new RegExp(m.source, m.flags) : null;
          const matches = (str) => {
            const norm = String(str || "").replace(/\s+/g, " ").trim();
            return rx ? rx.test(norm) : norm.toLowerCase().includes(m.text.toLowerCase());
          };

          let targetEl = null;
          if (!m.isRegex && /^[.#\[]|^(input|textarea|select)\b/i.test(m.text)) {
            targetEl = document.querySelector(m.text);
          }

          if (!targetEl) {
            const inputs = Array.from(document.querySelectorAll("input, textarea, select"));
            targetEl = inputs.find((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return false;
              const ph = el.getAttribute("placeholder") || "";
              const aria = el.getAttribute("aria-label") || "";
              return matches(ph) || matches(aria);
            });
          }

          if (!targetEl) {
            const labels = Array.from(document.querySelectorAll("label"));
            for (const lbl of labels) {
              if (matches(lbl.innerText || "")) {
                if (lbl.htmlFor) {
                  const byFor = document.getElementById(lbl.htmlFor);
                  if (byFor) {
                    targetEl = byFor;
                    break;
                  }
                }
                const inside = lbl.querySelector("input, textarea, select");
                if (inside) {
                  targetEl = inside;
                  break;
                }
                const sibling = lbl.parentElement?.querySelector("input, textarea, select");
                if (sibling) {
                  targetEl = sibling;
                  break;
                }
              }
            }
          }

          if (!targetEl) return { found: false };

          targetEl.scrollIntoView({ block: "center" });
          targetEl.focus();

          const proto =
            targetEl.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : targetEl.tagName === "SELECT"
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
          if (descriptor && descriptor.set) {
            descriptor.set.call(targetEl, String(nextVal));
          } else {
            targetEl.value = String(nextVal);
          }
          targetEl.dispatchEvent(new Event("input", { bubbles: true }));
          targetEl.dispatchEvent(new Event("change", { bubbles: true }));
          return { found: true, value: targetEl.value };
        }, matcher, value);

        if (!res.found) {
          throw new Error(`fillInput: no visible input/textarea matching ${String(placeholderOrLabel)}`);
        }
        await sleep(20);
        return res.value;
      }

      async function getElementRect(selectorOrText) {
        const matcher = serializeMatcher(selectorOrText);
        return evaluate((m) => {
          let el = null;
          if (!m.isRegex) {
            try {
              el = document.querySelector(m.text);
            } catch {
              el = null;
            }
          }
          if (!el) {
            const rx = m.isRegex ? new RegExp(m.source, m.flags) : null;
            const all = Array.from(document.querySelectorAll("button, a, h1, h2, h3, div, span, section, canvas, input, textarea"));
            el = all.find((node) => {
              const r = node.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              const txt1 = (node.innerText || "").replace(/\s+/g, " ").trim();
              const txt2 = (node.textContent || "").replace(/\s+/g, " ").trim();
              return rx ? rx.test(txt1) || rx.test(txt2) : txt1.includes(m.text) || txt2.includes(m.text);
            });
          }
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: r.left,
            y: r.top,
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
            centerX: r.left + r.width / 2,
            centerY: r.top + r.height / 2,
          };
        }, matcher);
      }

      async function querySelectorAllInfo(selector) {
        return evaluate((sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              tagName: el.tagName.toLowerCase(),
              id: el.id || "",
              className: typeof el.className === "string" ? el.className : "",
              text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
              disabled: Boolean(el.disabled),
              title: el.getAttribute("title") || "",
              rect: {
                x: r.left,
                y: r.top,
                width: r.width,
                height: r.height,
                centerX: r.left + r.width / 2,
                centerY: r.top + r.height / 2,
              },
              style: {
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
                pointerEvents: cs.pointerEvents,
                position: cs.position,
                zIndex: cs.zIndex,
              },
            };
          });
        }, selector);
      }

      async function pressKey(key) {
        const def = mapKeyDefinition(key);
        await pageClient.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          nativeVirtualKeyCode: def.windowsVirtualKeyCode,
        });
        if (def.text) {
          await pageClient.send("Input.dispatchKeyEvent", {
            type: "char",
            key: def.key,
            code: def.code,
            text: def.text,
            unmodifiedText: def.text,
            windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          });
        }
        await pageClient.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          nativeVirtualKeyCode: def.windowsVirtualKeyCode,
        });
        await sleep(25);
      }

      async function hoverAt(x, y) {
        await pageClient.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "none",
        });
        await sleep(20);
      }

      async function dispatchTouchGesture(points = []) {
        if (!Array.isArray(points) || points.length === 0) {
          throw new Error("dispatchTouchGesture requires a non-empty array of { x, y } points");
        }
        const first = points[0];
        await pageClient.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x: first.x, y: first.y, id: first.id ?? 0, radiusX: 4, radiusY: 4, force: 1 },
          ],
        });
        for (let i = 1; i < points.length; i += 1) {
          await sleep(16);
          const p = points[i];
          await pageClient.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              { x: p.x, y: p.y, id: p.id ?? 0, radiusX: 4, radiusY: 4, force: 1 },
            ],
          });
        }
        await sleep(16);
        await pageClient.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await sleep(20);
      }

      async function dispatchMultiTouch(contacts = []) {
        if (!Array.isArray(contacts) || contacts.length === 0) {
          throw new Error("dispatchMultiTouch requires a non-empty array of { id, points }");
        }
        const maxSteps = Math.max(...contacts.map((c) => (c.points ? c.points.length : 0)));
        if (maxSteps === 0) {
          throw new Error("dispatchMultiTouch contacts must contain non-empty points arrays");
        }

        const buildFrame = (idx) =>
          contacts.map((c, ci) => {
            const pts = c.points;
            const pt = pts[Math.min(idx, pts.length - 1)];
            return {
              x: pt.x,
              y: pt.y,
              id: c.id ?? ci,
              radiusX: 4,
              radiusY: 4,
              force: 1,
            };
          });

        await pageClient.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: buildFrame(0),
        });
        for (let i = 1; i < maxSteps; i += 1) {
          await sleep(16);
          await pageClient.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: buildFrame(i),
          });
        }
        await sleep(16);
        await pageClient.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await sleep(20);
      }

      async function auditSwissPalette(auditOpts = {}) {
        const { excludeDisplaySwatches = true, excludeSelectors = [] } = auditOpts;
        return evaluate(
          (exSwatches, exSels) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            const colorCache = new Map();

            function toSrgb(raw) {
              if (!raw || raw === "none" || raw === "transparent") return null;
              if (colorCache.has(raw)) return colorCache.get(raw);

              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = "rgba(0,0,0,0)";
              ctx.fillStyle = raw;
              ctx.fillRect(0, 0, 1, 1);
              const d0 = ctx.getImageData(0, 0, 1, 1).data;
              if (d0[3] === 0) {
                colorCache.set(raw, null);
                return null;
              }

              let rgb = [d0[0], d0[1], d0[2], d0[3]];
              if (d0[3] < 255) {
                // Composite over pure white Swiss canvas background
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, 1, 1);
                ctx.fillStyle = raw;
                ctx.fillRect(0, 0, 1, 1);
                const d1 = ctx.getImageData(0, 0, 1, 1).data;
                rgb = [d1[0], d1[1], d1[2], d0[3]];
              }
              colorCache.set(raw, rgb);
              return rgb;
            }

            function classifyRgb(r, g, b) {
              const max = Math.max(r, g, b);
              const min = Math.min(r, g, b);
              if (max - min <= 18) return { ok: true, hue: null };

              const d = max - min;
              const rn = r / 255;
              const gn = g / 255;
              const bn = b / 255;
              const maxN = max / 255;
              const dN = d / 255;
              let hue = 0;
              if (dN > 0) {
                if (maxN === bn) hue = ((rn - gn) / dN + 4) * 60;
                else if (maxN === gn) hue = ((bn - rn) / dN + 2) * 60;
                else hue = (((gn - bn) / dN) % 6) * 60;
                if (hue < 0) hue += 360;
              }
              const ok = b > r && b >= g && hue >= 195 && hue <= 250;
              return { ok, hue: Math.round(hue * 10) / 10 };
            }

            const portalRoots = new Set();
            for (const child of Array.from(document.body.children)) {
              const cs = getComputedStyle(child);
              if (cs.position === "fixed" && cs.zIndex === "999999") {
                portalRoots.add(child);
              }
            }

            function isExcluded(el) {
              const tag = el.tagName.toLowerCase();
              if (tag === "canvas" || tag === "img" || tag === "video") return true;
              for (const portal of portalRoots) {
                if (portal === el || portal.contains(el)) return true;
              }
              if (exSwatches && el.classList && el.classList.contains("h-9") && el.classList.contains("rounded-lg") && el.closest("button")) {
                return true;
              }
              if (Array.isArray(exSels)) {
                for (const sel of exSels) {
                  try {
                    if (el.matches(sel) || el.closest(sel)) return true;
                  } catch {
                    // ignore invalid selector
                  }
                }
              }
              return false;
            }

            const props = [
              "color",
              "backgroundColor",
              "borderTopColor",
              "borderRightColor",
              "borderBottomColor",
              "borderLeftColor",
              "outlineColor",
            ];

            let totalChecked = 0;
            const violations = [];
            const elements = Array.from(document.querySelectorAll("*"));

            for (const el of elements) {
              if (isExcluded(el)) continue;
              const cs = getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;

              const isSvg = el instanceof SVGElement;
              const checkProps = isSvg ? [...props, "fill", "stroke"] : props;

              for (const prop of checkProps) {
                if (prop.startsWith("border")) {
                  const widthProp = prop.replace("Color", "Width");
                  if (parseFloat(cs[widthProp]) === 0) continue;
                }
                const rawColor = cs[prop];
                const rgba = toSrgb(rawColor);
                if (!rgba) continue;

                totalChecked += 1;
                const { ok, hue } = classifyRgb(rgba[0], rgba[1], rgba[2]);
                if (!ok) {
                  violations.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
                    prop,
                    rawColor,
                    rgb: [rgba[0], rgba[1], rgba[2]],
                    hue,
                  });
                }
              }
            }

            return {
              ok: violations.length === 0,
              totalChecked,
              violations,
            };
          },
          Boolean(excludeDisplaySwatches),
          excludeSelectors
        );
      }

      async function getInvokeLog() {
        return (await evaluate(() => window.__TAURI_MOCK__?.getInvokeLog() || [])) || [];
      }

      async function getPageErrors() {
        const mockErrors = (await evaluate(() => window.__TAURI_MOCK__?.getErrors() || [])) || [];
        return [...cdpErrors, ...mockErrors];
      }

      async function getWindowState() {
        return evaluate(() => window.__TAURI_MOCK__?.getWindowState() || null);
      }

      async function emitTauriEvent(eventName, payload) {
        return evaluate((name, data) => {
          window.__TAURI_MOCK__?.emit(name, data);
        }, eventName, payload);
      }

      const handle = {
        waitForText,
        clickButton,
        clickStep,
        fillInput,
        getBodyText,
        getText: getBodyText,
        getElementRect,
        querySelectorAllInfo,
        queryAll: querySelectorAllInfo,
        pressKey,
        hoverAt,
        dispatchTouchGesture,
        dispatchTouch: dispatchTouchGesture,
        dispatchMultiTouch,
        auditSwissPalette,
        checkSwissPalette: auditSwissPalette,
        getInvokeLog,
        getPageErrors,
        getWindowState,
        emitTauriEvent,
        emitEvent: emitTauriEvent,
        evaluate,
        close,
      };
      handle.page = handle;
      return handle;
    } catch (err) {
      await close();
      throw err;
    }
  }

  async function closeAll() {
    for (const session of Array.from(activeSessions)) {
      if (typeof session.close === "function") {
        await session.close();
        continue;
      }
      try {
        session.pageClient?.close();
        session.browserClient?.close();
      } catch {
        // ignore
      }
      if (!session.childExited && session.child?.pid) {
        killPidTreeSync(session.child.pid);
      }
      try {
        session.server?.closeAllConnections?.();
        await new Promise((resolve) => session.server?.close(() => resolve()));
      } catch {
        // ignore
      }
      safeRmDirSync(session.userDataDir);
      activeSessions.delete(session);
    }
  }

  return {
    openApp,
    closeAll,
  };
}
