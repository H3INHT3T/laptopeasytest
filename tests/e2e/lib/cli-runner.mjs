import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function isHostileMinGwPathEntry(entry) {
  const unquoted = entry.replace(/^"(.*)"$/, "$1");
  if (/mingw|WinLibs/i.test(unquoted)) return true;
  if (/WinGet/i.test(unquoted)) {
    if (/gcc|windres/i.test(unquoted)) return true;
    try {
      if (
        fs.existsSync(path.join(unquoted, "gcc.exe")) ||
        fs.existsSync(path.join(unquoted, "windres.exe"))
      ) {
        return true;
      }
    } catch {
      // Ignore probe errors on malformed PATH segments
    }
  }
  return false;
}

function buildCargoEnv() {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA || "";
  if (!localAppData) return undefined;
  const windresOnly = path.join(localAppData, "w64devkit", "windres-only");
  if (!fs.existsSync(windresOnly)) return undefined;

  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const rawPath = process.env[pathKey] || "";
  const cleanedEntries = rawPath
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !isHostileMinGwPathEntry(entry) && entry.toLowerCase() !== windresOnly.toLowerCase());

  return { [pathKey]: [windresOnly, ...cleanedEntries].join(";") };
}

function runProcess(command, args, { cwd, env } = {}) {
  const startedAt = Date.now();
  const displayCommand = [command, ...args].join(" ");
  const isWin32 = process.platform === "win32";
  const isShellTool =
    isWin32 && (command === "pnpm" || command === "npm" || command === "npx" || /\.(cmd|bat)$/i.test(command));

  const execFile = isShellTool ? "cmd.exe" : command;
  const execArgs = isShellTool ? ["/d", "/s", "/c", command, ...args] : args;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode, errMessage = "") => {
      if (settled) return;
      settled = true;
      const finalStderr = errMessage ? (stderr ? `${stderr}\n${errMessage}` : errMessage) : stderr;
      resolve({
        ok: exitCode === 0,
        exitCode: typeof exitCode === "number" ? exitCode : -1,
        stdout,
        stderr: finalStderr,
        durationMs: Date.now() - startedAt,
        command: displayCommand,
      });
    };

    try {
      const child = spawn(execFile, execArgs, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        finish(-1, err?.message || String(err));
      });
      child.on("close", (code) => {
        finish(typeof code === "number" ? code : -1);
      });
    } catch (err) {
      finish(-1, err?.message || String(err));
    }
  });
}

export function createCliRunner({ rootDir, noBuild = false } = {}) {
  if (!rootDir) {
    throw new Error("createCliRunner requires { rootDir }");
  }
  const absRoot = path.resolve(rootDir);
  const cache = {
    ensureBuild: null,
    runBuild: null,
    runCargoTest: null,
    runCargoCheck: null,
    runSelfTest: null,
  };

  function resolveInsideRoot(relPath) {
    const target = path.resolve(absRoot, relPath);
    if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
      throw new Error(`Path escapes rootDir: ${relPath}`);
    }
    return target;
  }

  function readRepoFile(relPath) {
    const target = resolveInsideRoot(relPath);
    return fs.readFileSync(target, "utf8");
  }

  function readJson(relPath) {
    return JSON.parse(readRepoFile(relPath));
  }

  function listFiles(relDir = ".", opts = {}) {
    const {
      recursive = true,
      excludeDirs = new Set(["node_modules", "target", ".git", ".agents"]),
    } = opts;
    const startDir = resolveInsideRoot(relDir);
    if (!fs.existsSync(startDir)) return [];
    const results = [];

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirs.has(entry.name)) continue;
          if (recursive) walk(full);
        } else if (entry.isFile()) {
          results.push(path.relative(absRoot, full).replace(/\\/g, "/"));
        }
      }
    }

    walk(startDir);
    return results;
  }

  function findFilesByExt(relDir = ".", exts = []) {
    const normExts = new Set(
      (Array.isArray(exts) ? exts : [exts]).map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`))
    );
    return listFiles(relDir).filter((f) => normExts.has(path.extname(f).toLowerCase()));
  }

  function runBuild() {
    if (!cache.runBuild) {
      cache.runBuild = runProcess("pnpm", ["build"], { cwd: absRoot });
    }
    return cache.runBuild;
  }

  function ensureBuild() {
    if (!cache.ensureBuild) {
      const distIndex = resolveInsideRoot("dist/index.html");
      if (noBuild && fs.existsSync(distIndex)) {
        cache.ensureBuild = Promise.resolve({
          ok: true,
          exitCode: 0,
          stdout: "Skipped pnpm build (--no-build and dist/index.html exists).",
          stderr: "",
          durationMs: 0,
          command: "pnpm build (skipped via --no-build)",
        });
      } else {
        cache.ensureBuild = runBuild();
      }
    }
    return cache.ensureBuild;
  }

  function runCargoTest() {
    if (!cache.runCargoTest) {
      cache.runCargoTest = runProcess("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], {
        cwd: absRoot,
        env: buildCargoEnv(),
      });
    }
    return cache.runCargoTest;
  }

  function runCargoCheck() {
    if (!cache.runCargoCheck) {
      cache.runCargoCheck = runProcess("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"], {
        cwd: absRoot,
        env: buildCargoEnv(),
      });
    }
    return cache.runCargoCheck;
  }

  function runSelfTest() {
    if (!cache.runSelfTest) {
      const exeRel =
        process.platform === "win32"
          ? "src-tauri/target/debug/laptopbench-qc.exe"
          : "src-tauri/target/debug/laptopbench-qc";
      const exePath = resolveInsideRoot(exeRel);
      if (!fs.existsSync(exePath)) {
        cache.runSelfTest = Promise.resolve({
          ok: false,
          exitCode: -1,
          stdout: "",
          stderr: `Self-test binary not found at ${exePath}`,
          durationMs: 0,
          command: `${exePath} --self-test`,
        });
      } else {
        cache.runSelfTest = runProcess(exePath, ["--self-test"], { cwd: absRoot });
      }
    }
    return cache.runSelfTest;
  }

  function checkVersionAlignment(expectedVersion = "3.2.0") {
    const findings = [];
    const expectedMajorMinor = expectedVersion.split(".").slice(0, 2).join(".");

    const pkg = readJson("package.json");
    findings.push({
      file: "package.json",
      actual: pkg.version,
      expected: expectedVersion,
      ok: pkg.version === expectedVersion,
    });

    const cargoToml = readRepoFile("src-tauri/Cargo.toml");
    const cargoVerMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
    const cargoVer = cargoVerMatch ? cargoVerMatch[1] : null;
    findings.push({
      file: "src-tauri/Cargo.toml",
      actual: cargoVer,
      expected: expectedVersion,
      ok: cargoVer === expectedVersion,
    });

    const tauriConf = readJson("src-tauri/tauri.conf.json");
    findings.push({
      file: "src-tauri/tauri.conf.json",
      actual: tauriConf.version,
      expected: expectedVersion,
      ok: tauriConf.version === expectedVersion,
    });

    const sidebar = readRepoFile("src/components/Sidebar.tsx");
    const sidebarMatches = sidebar.includes(expectedVersion) || sidebar.includes(`v${expectedMajorMinor}`);
    const sidebarActual = sidebar.match(/v\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
    findings.push({
      file: "src/components/Sidebar.tsx",
      actual: sidebarActual,
      expected: `v${expectedVersion}`,
      ok: sidebar.includes(`v${expectedVersion}`) || (sidebarMatches && sidebarActual === `v${expectedVersion}`),
    });

    const libRs = readRepoFile("src-tauri/src/lib.rs");
    const libVer = libRs.match(/LaptopBench QC v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
    findings.push({
      file: "src-tauri/src/lib.rs",
      actual: libVer,
      expected: expectedVersion,
      ok: libVer === expectedVersion || libVer === expectedMajorMinor,
    });

    const reportRs = readRepoFile("src-tauri/src/modules/report.rs");
    const reportVer = reportRs.match(/LaptopBench QC v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
    findings.push({
      file: "src-tauri/src/modules/report.rs",
      actual: reportVer,
      expected: expectedVersion,
      ok: reportVer === expectedVersion || reportVer === expectedMajorMinor,
    });

    const pdfRs = readRepoFile("src-tauri/src/modules/pdf_gen.rs");
    const pdfVer = pdfRs.match(/LaptopBench QC v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
    findings.push({
      file: "src-tauri/src/modules/pdf_gen.rs",
      actual: pdfVer,
      expected: expectedVersion,
      ok: pdfVer === expectedVersion || pdfVer === expectedMajorMinor,
    });

    const readme = readRepoFile("README.md");
    const readmeVer = readme.match(/v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
    findings.push({
      file: "README.md",
      actual: readmeVer,
      expected: expectedVersion,
      ok: readme.includes(expectedVersion),
    });

    return {
      ok: findings.every((f) => f.ok),
      expectedVersion,
      findings,
    };
  }

  function checkSwissStaticColors() {
    const files = findFilesByExt("src", [".ts", ".tsx", ".css"]);
    const forbiddenTwRegex =
      /\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|decoration|accent|divide)-(?:red|green|emerald|amber|yellow|orange|purple|violet|pink|rose|teal|cyan|indigo|lime|fuchsia|sky)-\d{2,3}\b/g;
    const violations = [];

    for (const rel of files) {
      const content = readRepoFile(rel);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const matches = lines[i].match(forbiddenTwRegex);
        if (matches) {
          violations.push({
            file: rel,
            line: i + 1,
            classes: matches,
          });
        }
      }
    }

    return {
      ok: violations.length === 0,
      filesScanned: files.length,
      violations,
    };
  }

  function checkNoBundledBinaries() {
    const disallowedExts = new Set([".exe", ".dll", ".7z", ".zip", ".msi", ".so", ".dylib", ".cab"]);
    const scanDirs = ["src-tauri", "src", "public"];
    const found = [];

    for (const dir of scanDirs) {
      const files = listFiles(dir, {
        recursive: true,
        excludeDirs: new Set(["node_modules", "target", ".git", ".agents"]),
      });
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (disallowedExts.has(ext)) {
          found.push(f);
        }
      }
    }

    return {
      ok: found.length === 0,
      found,
    };
  }

  return {
    rootDir: absRoot,
    noBuild: Boolean(noBuild),
    runCommand: (cmd, args = [], opts = {}) => runProcess(cmd, args, { cwd: absRoot, ...opts }),
    ensureBuild,
    runBuild,
    runCargoTest,
    runCargoCheck,
    runSelfTest,
    readRepoFile,
    readJson,
    listFiles,
    findFilesByExt,
    checkVersionAlignment,
    checkSwissStaticColors,
    checkNoBundledBinaries,
  };
}
