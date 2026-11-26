import path from "node:path";

function syncUserBenchmark(override = {}) {
  return {
    sourceMode: "offline_calibrated",
    ...override,
  };
}

function syncBatteryDischarge(override = {}) {
  return {
    status: "pass",
    ...override,
  };
}

async function advanceToStage(app, headingRegex, maxSteps = 16) {
  await app.waitForText("STAGE 00", 6000);
  await app.clickButton(/Begin Stage 01|Resume Stage/i);

  for (let i = 0; i < maxSteps; i += 1) {
    const mainText = await app.evaluate(
      () => document.querySelector("main")?.innerText || ""
    );
    if (headingRegex.test(mainText)) {
      return;
    }
    const buttons = await app.queryAll("button");
    const nextBtn = buttons.find((b) => /Next: Stage/i.test(b.text) && !b.disabled);
    if (nextBtn) {
      await app.clickButton(/Next: Stage/i);
      continue;
    }
    const skipBtn = buttons.find((b) => /^Skip Step$/i.test(b.text) && !b.disabled);
    if (skipBtn) {
      await app.clickButton(/^Skip Step$/i);
      continue;
    }
    throw new Error(`advanceToStage stuck before matching ${String(headingRegex)}`);
  }
  throw new Error(`advanceToStage exceeded ${maxSteps} steps waiting for ${String(headingRegex)}`);
}

async function advanceToReportModal(app, maxSteps = 16) {
  await app.waitForText("STAGE 00", 6000);
  await app.clickButton(/Begin Stage 01|Resume Stage/i);

  for (let i = 0; i < maxSteps; i += 1) {
    const modalText = await app.evaluate(
      () => document.querySelector(".fixed.inset-0")?.innerText || ""
    );
    if (modalText.includes("Issue Branded Hardware Certificate")) {
      return;
    }
    const buttons = await app.queryAll("button");
    const certBtn = buttons.find(
      (b) => /Issue QC Certificate/i.test(b.text) && !b.disabled && !/Locked/i.test(b.text)
    );
    if (certBtn) {
      await app.clickButton(/Issue QC Certificate/i);
      continue;
    }
    const nextBtn = buttons.find((b) => /Next: Stage/i.test(b.text) && !b.disabled);
    if (nextBtn) {
      await app.clickButton(/Next: Stage/i);
      continue;
    }
    const skipBtn = buttons.find((b) => /^Skip Step$/i.test(b.text) && !b.disabled);
    if (skipBtn) {
      await app.clickButton(/^Skip Step$/i);
      continue;
    }
    throw new Error("advanceToReportModal stuck before opening PreReportModal");
  }
  await app.waitForText("Issue Branded Hardware Certificate", 4000);
}

export const tests = [
  // =========================================================================
  // F16 — Keyboard / Media / Ports Boundaries
  // =========================================================================
  {
    id: "T2-F16-01",
    tier: 2,
    feature: "F16",
    title: "Stuck-key pre-check flags a held key without keyup in KeyboardTestView",
    tags: ["tier2", "boundary", "keyboard", "stuck-key"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToStage(app, /Keyboard & Touchpad/i);

        await app.evaluate(() => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true })
          );
        });
        await app.waitForText(/Held \/ Peak Rollover[\s\r\n]+1\s*held\b/i, 2000);
        const bodyHeld = await app.getBodyText();
        ctx.assert.ok(bodyHeld.includes("DOWN: KeyW"), "Expected DOWN: KeyW telemetry");

        const stuckBtn = (await app.queryAll("button")).find((b) =>
          /Stuck.*Check|Pre-Check/i.test(b.text)
        );
        if (stuckBtn && !stuckBtn.disabled) {
          await app.clickButton(/Stuck.*Check|Pre-Check/i);
        }
        await app.waitForText(/STUCK KEY DETECTED:.*\bKeyW\b/i, 3000);

        const bodyAfter = await app.getBodyText();
        ctx.assert.match(
          bodyAfter,
          /STUCK KEY DETECTED:.*\bKeyW\b/i,
          "Expected KeyboardTestView stuck-key pre-check banner to flag held KeyW"
        );
        ctx.assert.match(
          bodyAfter,
          /Stuck-Key Check[\s\r\n]+1\s*STUCK\b/i,
          "Expected Stuck-Key Check tile to display 1 STUCK"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F16-02",
    tier: 2,
    feature: "F16",
    title: "KeyboardTestView measures 0-key vs 2KRO simultaneous rollover and resets cleanly",
    tags: ["tier2", "boundary", "keyboard", "nkro"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToStage(app, /Keyboard & Touchpad/i);

        const initialBody = await app.getBodyText();
        ctx.assert.match(initialBody, /Keys Tested[\s\r\n]+0\s*\/\s*\d+/i);
        ctx.assert.match(initialBody, /Held \/ Peak Rollover[\s\r\n]+0\s*held\b/i);
        ctx.assert.match(
          initialBody,
          /NKRO|Rollover/i,
          "Expected NKRO / Rollover counter readout in KeyboardTestView"
        );

        await app.evaluate(() => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true })
          );
          window.dispatchEvent(
            new KeyboardEvent("keydown", { code: "KeyS", key: "s", bubbles: true })
          );
        });
        await new Promise((r) => setTimeout(r, 60));

        const heldBody = await app.getBodyText();
        ctx.assert.match(heldBody, /Held \/ Peak Rollover[\s\r\n]+2\s*held\b/i);
        ctx.assert.match(
          heldBody,
          /2\s*held\s*•\s*2KRO/i,
          "Expected 2 held • 2KRO readout when 2 keys are held simultaneously"
        );

        await app.evaluate(() => {
          window.dispatchEvent(
            new KeyboardEvent("keyup", { code: "KeyA", key: "a", bubbles: true })
          );
          window.dispatchEvent(
            new KeyboardEvent("keyup", { code: "KeyS", key: "s", bubbles: true })
          );
        });

        await app.clickButton(/^Reset$/);
        await app.waitForText(/Keys Tested[\s\r\n]+0\s*\/\s*\d+/i, 2000);
        const resetBody = await app.getBodyText();
        ctx.assert.match(resetBody, /Held \/ Peak Rollover[\s\r\n]+0\s*held\b/i);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F16-03",
    tier: 2,
    feature: "F16",
    title: "MediaTestView handles NotAllowedError and NotFoundError from getUserMedia without crashing",
    tags: ["tier2", "boundary", "media", "error-handling"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToStage(app, /Camera & Microphone Test/i);

        await app.evaluate(() => {
          const fakeMedia = {
            enumerateDevices: async () => [],
            getUserMedia: async () => {
              throw new DOMException("Permission denied", "NotAllowedError");
            },
          };
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: fakeMedia,
          });
        });

        await app.clickButton("Start Camera");
        await app.waitForText(/Camera access failed:.*(NotAllowedError|Permission denied)/i, 3000);

        await app.clickButton("Start Mic");
        await app.waitForText(/Microphone access failed:.*(NotAllowedError|Permission denied)/i, 3000);

        await app.evaluate(() => {
          navigator.mediaDevices.getUserMedia = async () => {
            throw new DOMException("Requested device not found", "NotFoundError");
          };
        });
        await app.clickButton("Start Camera");
        await app.waitForText(/Camera access failed:.*(NotFoundError|not found)/i, 3000);

        ctx.assert.equal((await app.getPageErrors()).length, 0);
        const buttons = await app.queryAll("button");
        ctx.assert.equal(
          buttons.find((b) => /^Skip Step$/i.test(b.text))?.disabled,
          false,
          "Expected Skip Step enabled after media errors"
        );
        ctx.assert.equal(
          buttons.find((b) => /^Fail Camera \/ Mic$/i.test(b.text))?.disabled,
          false,
          "Expected Fail Camera / Mic enabled after media errors"
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F16-04",
    tier: 2,
    feature: "F16",
    title: "PortsSpeakersView cancels/closes active audio sweep on stop or unmount and survives blocked AudioContext",
    tags: ["tier2", "boundary", "audio", "ports"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToStage(app, /Live USB4\/3\.x Speed Detector/i);

        await app.evaluate(() => {
          const spy = { created: 0, closed: false, stopped: false };
          window.__audioSpy = spy;
          function SpyAudioContext() {
            spy.created += 1;
            this.currentTime = 0;
            this.destination = {};
            this.createOscillator = () => ({
              type: "sine",
              frequency: {
                setValueAtTime() {},
                exponentialRampToValueAtTime() {},
              },
              connect() {},
              start() {},
              stop() {
                spy.stopped = true;
              },
            });
            this.createGain = () => ({
              gain: {
                setValueAtTime() {},
                linearRampToValueAtTime() {},
                exponentialRampToValueAtTime() {},
              },
              connect() {},
            });
            this.createStereoPanner = () => ({
              pan: { setValueAtTime() {} },
              connect() {},
            });
            this.close = async () => {
              spy.closed = true;
            };
          }
          window.AudioContext = SpyAudioContext;
          window.webkitAudioContext = SpyAudioContext;
        });

        await app.clickButton("Full Frequency Sweep (80 Hz → 12 kHz • 4.0s)");
        await app.waitForText("Stop Audio", 2000);
        const stopBtn = (await app.queryAll("button")).find((b) =>
          /Stop Audio|Stop Sweep|Cancel Sweep|Mute/i.test(b.text)
        );
        ctx.assert.ok(stopBtn && !stopBtn.disabled, "Expected Stop Audio button while sweep is active");
        await app.clickButton(/Stop Audio|Stop Sweep|Cancel Sweep|Mute/i);

        const spyResult = await app.evaluate(() => window.__audioSpy);
        ctx.assert.ok(spyResult.created >= 1, "Expected AudioContext to be created for sweep");
        ctx.assert.ok(
          spyResult.closed && spyResult.stopped,
          "Expected sweep AudioContext.close() and oscillator.stop() on Stop Audio"
        );

        // Test blocked AudioContext error safety
        await app.evaluate(() => {
          const BrokenAudio = function () {
            throw new Error("AudioContext blocked/muted");
          };
          window.AudioContext = BrokenAudio;
          window.webkitAudioContext = BrokenAudio;
        });
        await app.clickButton("Left (440 Hz)");
        await app.clickButton("Full Frequency Sweep (80 Hz → 12 kHz • 4.0s)");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F16-05",
    tier: 2,
    feature: "F16",
    title: "Touchpad 12x6 grid transitions cleanly between 0% (0/72), 100% (72/72), and Reset Pad",
    tags: ["tier2", "boundary", "touchpad", "keyboard"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToStage(app, /Keyboard & Touchpad/i);
        await app.clickButton(/02\. Touchpad/);
        await app.waitForText(/0% \(0\/72\)/, 2000);
        const initialBody = await app.getBodyText();
        ctx.assert.ok(initialBody.includes("NOT RUN"), "Expected initial Phantom Drift NOT RUN");

        const cells = await app.queryAll(".grid.grid-cols-12 > div");
        ctx.assert.equal(cells.length, 72, `Expected 72 touchpad grid cells, got ${cells.length}`);

        for (const c of cells) {
          await app.hoverAt(c.rect.centerX, c.rect.centerY);
        }

        await app.waitForText(/100% \(72\/72\)/, 3000);
        const fullBody = await app.getBodyText();
        ctx.assert.match(fullBody, /02\. Touchpad \(100%\)/i);

        await app.clickButton("Reset Pad");
        await app.waitForText(/0% \(0\/72\)/, 2000);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F17 — Theme & Attribution Boundaries
  // =========================================================================
  {
    id: "T2-F17-01",
    tier: 2,
    feature: "F17",
    title: "auditSwissPalette passes clean baseline and rejects injected green/red/yellow/SVG rainbow elements",
    tags: ["tier2", "boundary", "theme", "swiss"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 5000);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());

        await app.evaluate(() => {
          const wrap = document.createElement("div");
          wrap.id = "__rainbow_probe";
          wrap.style.cssText = "position:fixed;top:12px;left:12px;z-index:99999;display:flex;gap:8px;";

          const greenDiv = document.createElement("div");
          greenDiv.textContent = "GREEN";
          greenDiv.style.cssText = "width:40px;height:24px;background:#16a34a;color:#ffffff;";

          const oklchSpan = document.createElement("span");
          oklchSpan.textContent = "RED";
          oklchSpan.style.cssText = "width:40px;height:24px;color:oklch(0.637 0.237 25.331);background:#ffffff;";

          const yellowBorder = document.createElement("div");
          yellowBorder.textContent = "YLW";
          yellowBorder.style.cssText = "width:40px;height:24px;border:2px solid #eab308;background:#ffffff;";

          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("width", "24");
          svg.setAttribute("height", "24");
          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("cx", "12");
          circle.setAttribute("cy", "12");
          circle.setAttribute("r", "10");
          circle.setAttribute("fill", "#dc2626");
          svg.appendChild(circle);

          wrap.append(greenDiv, oklchSpan, yellowBorder, svg);
          document.body.appendChild(wrap);
        });

        const dirty = await app.auditSwissPalette();
        ctx.assert.equal(dirty.ok, false, "Expected auditSwissPalette to reject injected rainbow elements");
        ctx.assert.ok(
          dirty.violations.length >= 4,
          `Expected >= 4 Swiss palette violations, got ${dirty.violations.length}`
        );
        ctx.assert.throws(
          () => ctx.assert.assertSwissPalette(dirty),
          /Swiss Precision Light palette violations/i
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F17-02",
    tier: 2,
    feature: "F17",
    title: "Static Tailwind/CSS scan confirms zero forbidden rainbow classes and Swiss index.css tokens",
    tags: ["tier2", "boundary", "theme", "static"],
    async run(ctx) {
      const res = ctx.cli.checkSwissStaticColors();
      ctx.assert.ok(res.filesScanned >= 15, `Expected >= 15 scanned files, got ${res.filesScanned}`);
      ctx.assert.equal(
        res.ok,
        true,
        `Static Swiss color violations found: ${JSON.stringify(res.violations)}`
      );
      ctx.assert.equal(res.violations.length, 0);

      const indexCss = ctx.cli.readRepoFile("src/index.css");
      ctx.assert.ok(indexCss.includes("background-color: #ffffff;"));
      ctx.assert.ok(indexCss.includes("color: #09090b;"));
      ctx.assert.ok(indexCss.includes("#2563eb"));
    },
  },

  {
    id: "T2-F17-03",
    tier: 2,
    feature: "F17",
    title: "Creator attribution (Hein Htet Zaw, @ich8g92) remains visible across dashboard modals, stages, and PreReportModal",
    tags: ["tier2", "boundary", "attribution", "ui"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        ctx.assert.assertAttributionVisible(await app.getBodyText());

        // Shelf Burn-In modal
        await app.clickButton("Shelf Burn-In");
        await app.waitForText(/Shelf Burn-In Marathon/i, 3000);
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.evaluate(() => {
          const modalBtns = Array.from(document.querySelectorAll(".fixed.inset-0 button"));
          const closeBtn = modalBtns.find((b) => (b.innerText || "").trim() === "");
          if (!closeBtn) throw new Error("Missing Burn-In modal close X button");
          closeBtn.click();
        });

        // Shop DB modal
        await app.clickButton("Shop DB");
        await app.waitForText(/Shop Model History Database/i, 3000);
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.evaluate(() => {
          const modalBtns = Array.from(document.querySelectorAll(".fixed.inset-0 button"));
          const closeBtn = modalBtns.find((b) => (b.innerText || "").trim() === "");
          if (!closeBtn) throw new Error("Missing Shop DB modal close X button");
          closeBtn.click();
        });

        const checkSidebarAttributionRect = async (stageLabel) => {
          const rect = await app.evaluate(() => {
            const aside = document.querySelector("aside");
            if (!aside) return null;
            const txt = aside.innerText || "";
            if (!txt.includes("Hein Htet Zaw") || !txt.includes("@ich8g92")) return null;
            const r = aside.getBoundingClientRect();
            return { width: r.width, height: r.height };
          });
          ctx.assert.ok(
            rect && rect.width > 0 && rect.height > 0,
            `Expected visible Sidebar attribution on ${stageLabel}`
          );
        };

        // Stage 01 & Stage 03
        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);
        await checkSidebarAttributionRect("Stage 01");

        await app.clickButton(/Next: Stage 02/i);
        await app.clickButton(/Next: Stage 03/i);
        await app.waitForText(/Battery/i, 4000);
        await checkSidebarAttributionRect("Stage 03");

        // Advance to PreReportModal
        await app.clickStep("Inspection Manifest");
        await advanceToReportModal(app);
        const modalText = await app.evaluate(
          () => document.querySelector(".fixed.inset-0")?.innerText || ""
        );
        ctx.assert.ok(modalText.includes("Created by Hein Htet Zaw"));
        ctx.assert.ok(modalText.includes("@ich8g92"));
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F17-04",
    tier: 2,
    feature: "F17",
    title: "BaselineCard percentOfNormal=0 omits NaN/percentage and PerformanceView renders UserBenchmark unavailable fallback",
    tags: ["tier2", "boundary", "userbenchmark", "baseline-card"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        commandErrors: {
          compare_userbenchmark: "UserBenchmark offline lookup unavailable",
        },
        userBenchmark: null,
        perfBench: {
          baseline: {
            detectedClass: "Unknown CPU Class",
            expectedNormal: "N/A",
            percentOfNormal: 0,
            grade: "UNKNOWN",
            verdictNote: "Fallback baseline when class lookup is unavailable.",
          },
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await advanceToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/PASSMARK WEIGHTED HARMONIC COMPOSITE MARK/i, 5000);

        const body = await app.getBodyText();
        ctx.assert.match(body, /CALIBRATION BASELINE \/\/ .*Unknown CPU Class/i);
        ctx.assert.ok(body.includes("UNKNOWN"));
        ctx.assert.equal(body.includes("OF NORMAL"), false);
        ctx.assert.equal(body.includes("NaN"), false);
        ctx.assert.equal(body.includes("undefined"), false);
        ctx.assert.equal((await app.getPageErrors()).length, 0);

        const log = await app.getInvokeLog();
        const calledUb = log.some((e) => e.cmd === "compare_userbenchmark");
        ctx.assert.ok(
          calledUb ||
            /UserBenchmark.*(unavailable|error|offline|fallback)|Offline Calibration/i.test(body),
          "Expected PerformanceView to invoke compare_userbenchmark or render UserBenchmark fallback notice"
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F17-05",
    tier: 2,
    feature: "F17",
    title: "Extreme long manufacturer/model/CPU/serial strings do not cause horizontal overflow or clip attribution",
    tags: ["tier2", "boundary", "layout", "overflow"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        specs: {
          manufacturer: "SUPERLONG_MANUFACTURER_CORP_INTERNATIONAL_HOLDINGS",
          model:
            "ThinkPad X1 Carbon Extreme Workstation Titanium Edition Gen 11 Ultra-Wide-Model-Name-Boundary-Test-2026-000111222333444555",
          cpuBrand:
            "Intel Core Ultra 9 285HX Extreme Engineering Sample 24-Core 5.8GHz Long-Model-Name-Overflow-Boundary-Check",
          serialNumber: "SN-EXTREME-LONG-SERIAL-0123456789ABCDEF-0123456789",
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await app.waitForText("SUPERLONG_MANUFACTURER_CORP_INTERNATIONAL_HOLDINGS", 5000);

        const layoutDash = await app.evaluate(() => {
          const aside = document.querySelector("aside");
          const r = aside?.getBoundingClientRect();
          const txt = aside?.innerText || "";
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            asideRect: r ? { width: r.width, right: r.right, bottom: r.bottom } : null,
            hasAttribution: txt.includes("Hein Htet Zaw") && txt.includes("@ich8g92"),
          };
        });
        ctx.assert.ok(
          layoutDash.scrollWidth <= layoutDash.innerWidth,
          `Dashboard horizontal overflow: scrollWidth=${layoutDash.scrollWidth} > innerWidth=${layoutDash.innerWidth}`
        );
        ctx.assert.ok(layoutDash.hasAttribution, "Expected Sidebar attribution text");
        ctx.assert.ok(layoutDash.asideRect && layoutDash.asideRect.width > 0);
        ctx.assert.ok(layoutDash.asideRect.right <= layoutDash.innerWidth);
        ctx.assert.ok(layoutDash.asideRect.bottom <= layoutDash.innerHeight);

        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);
        const layoutSpecs = await app.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        ctx.assert.ok(
          layoutSpecs.scrollWidth <= layoutSpecs.innerWidth,
          `SpecsView horizontal overflow: scrollWidth=${layoutSpecs.scrollWidth} > innerWidth=${layoutSpecs.innerWidth}`
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F18 — Report & PreReportModal Boundaries
  // =========================================================================
  {
    id: "T2-F18-01",
    tier: 2,
    feature: "F18",
    title: "PreReportModal rejects whitespace-only shopName and technicianName without calling export_qc_report",
    tags: ["tier2", "boundary", "report", "validation"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        shopProfile: {
          shopName: "   ",
          technicianName: "   ",
          logoDataUrl: null,
          defaultOutputDir: null,
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await advanceToReportModal(app);
        await app.clickButton("Issue Official QC Certificate");
        await app.waitForText("Please enter at least a Shop Name or Technician Username.", 3000);

        const exports = (await app.getInvokeLog()).filter((e) => e.cmd === "export_qc_report");
        ctx.assert.equal(exports.length, 0, "export_qc_report must not be called when both names are blank");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F18-02",
    tier: 2,
    feature: "F18",
    title: "PreReportModal permits shop-only or technician-only identity and exports PDF/HTML/JSON actions",
    tags: ["tier2", "boundary", "report", "export"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        shopProfile: {
          shopName: "",
          technicianName: "",
          logoDataUrl: null,
          defaultOutputDir: "C:\\QC_Reports",
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await advanceToReportModal(app);

        // 1. Shop-only
        await app.fillInput("e.g. ProTech Laptop Store", "Solo Shop Lab");
        await app.clickButton("Issue Official QC Certificate");
        await app.waitForText("Certificate Issued Successfully", 3000);

        let exports = (await app.getInvokeLog()).filter((e) => e.cmd === "export_qc_report");
        ctx.assert.equal(exports.length, 1);
        ctx.assert.equal(exports[0].args?.payload?.shopProfile?.shopName, "Solo Shop Lab");
        ctx.assert.equal(exports[0].args?.payload?.shopProfile?.technicianName, "");

        // 2. Technician-only
        await app.fillInput("e.g. ProTech Laptop Store", "");
        await app.fillInput("e.g. Hein Htet Zaw", "Solo Tech");
        await app.clickButton("Issue Official QC Certificate");

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          exports = (await app.getInvokeLog()).filter((e) => e.cmd === "export_qc_report");
          if (exports.length >= 2) break;
          await new Promise((r) => setTimeout(r, 30));
        }
        ctx.assert.equal(exports.length, 2);
        ctx.assert.equal(exports[1].args?.payload?.shopProfile?.shopName, "");
        ctx.assert.equal(exports[1].args?.payload?.shopProfile?.technicianName, "Solo Tech");

        const body = await app.getBodyText();
        ctx.assert.match(body, /Open PDF/i);
        ctx.assert.match(body, /Open HTML/i);
        ctx.assert.match(body, /Folder/i);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F18-03",
    tier: 2,
    feature: "F18",
    title: "export_qc_report IPC error renders cleanly in PreReportModal and leaves retry enabled",
    tags: ["tier2", "boundary", "report", "error-handling"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        commandErrors: {
          export_qc_report: "Disk write error: Read-only filesystem (EACCES)",
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await advanceToReportModal(app);
        await app.clickButton("Issue Official QC Certificate");
        await app.waitForText("Disk write error: Read-only filesystem (EACCES)", 3000);

        const body = await app.getBodyText();
        ctx.assert.equal(/Certificate Issued Successfully/i.test(body), false);

        const retryBtn = (await app.queryAll("button")).find((b) =>
          /Issue Official QC Certificate/i.test(b.text)
        );
        ctx.assert.ok(retryBtn);
        ctx.assert.equal(retryBtn.disabled, false);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F18-04",
    tier: 2,
    feature: "F18",
    title: "Exported payload preserves notApplicable/skipped statuses and matches 14-stage v2.3.0 backend report templates",
    tags: ["tier2", "boundary", "report", "14-stage"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseDesktop = ctx.fixtures.desktopAcOnly();
      const fixture = {
        ...baseDesktop,
        batteryDischarge: syncBatteryDischarge({
          ...baseDesktop.batteryDischarge,
          status: "notApplicable",
        }),
        userBenchmark: syncUserBenchmark(baseDesktop.userBenchmark),
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await advanceToReportModal(app);
        await app.clickButton("Issue Official QC Certificate");
        await app.waitForText("Certificate Issued Successfully", 3000);

        const exportCall = (await app.getInvokeLog()).find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "Expected export_qc_report IPC invocation");
        const payload = exportCall.args?.payload;
        ctx.assert.ok(payload, "Expected payload in export_qc_report call");
        ctx.assert.ok(
          payload.tests.some((t) => t.id === "battery" && t.status === "notApplicable"),
          "Expected battery status notApplicable in exported payload"
        );
        ctx.assert.ok(
          payload.tests.some((t) => t.status === "skipped"),
          "Expected skipped status in exported payload"
        );
        ctx.assert.equal(payload.specs?.chassisType, "Desktop");
        ctx.assert.notEqual(payload.overallVerdict, "FAILED");
        ctx.assert.notEqual(payload.durabilityGrade, "A");
        ctx.assert.notEqual(payload.durabilityGrade, "A+");

        // v2.3.0 14-stage + touchscreen + backend report template parity
        ctx.assert.ok(
          payload.tests.length >= 14 && payload.tests.some((t) => t.id === "touchscreen"),
          `Expected >= 14 stages including touchscreen in report payload, got ${payload.tests.length}`
        );

        const reportRs = ctx.cli.readRepoFile("src-tauri/src/modules/report.rs");
        const pdfRs = ctx.cli.readRepoFile("src-tauri/src/modules/pdf_gen.rs");
        const reportProd = reportRs.split("#[cfg(test)]")[0];
        const pdfProd = pdfRs.split("#[cfg(test)]")[0];
        ctx.assert.ok(
          reportProd.length > 0 && reportProd.length < reportRs.length,
          "Expected production section before #[cfg(test)] in report.rs"
        );
        ctx.assert.ok(
          pdfProd.length > 0 && pdfProd.length < pdfRs.length,
          "Expected production section before #[cfg(test)] in pdf_gen.rs"
        );
        ctx.assert.equal(
          /13-stage/i.test(reportProd),
          false,
          "report.rs must not hardcode stale '13-stage'"
        );
        ctx.assert.equal(
          /13-stage/i.test(pdfProd),
          false,
          "pdf_gen.rs must not hardcode stale '13-stage'"
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F18-05",
    tier: 2,
    feature: "F18",
    title: "FAILED seal in PreReportModal and HTML/PDF templates preserve Swiss Light palette and attribution",
    tags: ["tier2", "boundary", "report", "swiss", "attribution"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.nonTouchCorporate(), {
        maxTouchPoints: 0,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await advanceToReportModal(app);
        await app.waitForText("Issue Branded Hardware Certificate", 3000);

        const modalText = await app.evaluate(
          () => document.querySelector(".fixed.inset-0")?.innerText || ""
        );
        ctx.assert.ok(modalText.includes("FAILED"), "Expected FAILED verdict seal in PreReportModal");
        ctx.assert.ok(modalText.includes("Hein Htet Zaw"));
        ctx.assert.ok(modalText.includes("@ich8g92"));

        ctx.assert.assertSwissPalette(await app.auditSwissPalette());

        const reportRs = ctx.cli.readRepoFile("src-tauri/src/modules/report.rs");
        const pdfRs = ctx.cli.readRepoFile("src-tauri/src/modules/pdf_gen.rs");
        const reportProd = reportRs.split("#[cfg(test)]")[0];
        const pdfProd = pdfRs.split("#[cfg(test)]")[0];
        ctx.assert.ok(
          reportProd.length > 0 && reportProd.length < reportRs.length,
          "Expected production section before #[cfg(test)] in report.rs"
        );
        ctx.assert.ok(
          pdfProd.length > 0 && pdfProd.length < pdfRs.length,
          "Expected production section before #[cfg(test)] in pdf_gen.rs"
        );
        for (const [name, src] of [
          ["report.rs", reportProd],
          ["pdf_gen.rs", pdfProd],
        ]) {
          ctx.assert.ok(src.includes("Created by Hein Htet Zaw"), `${name} missing creator attribution`);
          ctx.assert.ok(src.includes("@ich8g92"), `${name} missing @ich8g92`);
        }
        for (const forbiddenHex of ["#dc2626", "#16a34a", "#eab308", "#f59e0b"]) {
          ctx.assert.equal(
            reportProd.toLowerCase().includes(forbiddenHex),
            false,
            `report.rs contains forbidden rainbow hex ${forbiddenHex}`
          );
        }
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F19 — --self-test & Version Alignment Boundaries
  // =========================================================================
  {
    id: "T2-F19-01",
    tier: 2,
    feature: "F19",
    title: "Version alignment check covers all 8 targets and asserts exact 2.3.0 parity",
    tags: ["tier2", "boundary", "version", "cli"],
    async run(ctx) {
      const stale = ctx.cli.checkVersionAlignment("2.2.0");
      ctx.assert.equal(stale.findings.length, 8, `Expected 8 version targets, got ${stale.findings.length}`);
      ctx.assert.equal(
        stale.ok,
        false,
        "Negative boundary: checkVersionAlignment('2.2.0') must fail once version is bumped to 2.3.0"
      );
      ctx.assert.ok(
        stale.findings.some((f) => !f.ok),
        "Negative boundary: expected at least one target to report mismatch against 2.2.0"
      );

      const v = ctx.cli.checkVersionAlignment("2.3.0");
      ctx.assert.equal(v.findings.length, 8, `Expected 8 version targets, got ${v.findings.length}`);
      ctx.assert.equal(
        v.ok,
        true,
        `Version mismatch across targets: ${JSON.stringify(v.findings.filter((f) => !f.ok))}`
      );
    },
  },

  {
    id: "T2-F19-02",
    tier: 2,
    feature: "F19",
    title: "CLI rejects unknown runner flags cleanly and --self-test ignores unrelated flags without GUI launch",
    tags: ["tier2", "boundary", "cli", "self-test"],
    async run(ctx) {
      const mainRs = ctx.cli.readRepoFile("src-tauri/src/main.rs");
      ctx.assert.ok(mainRs.includes("--self-test"), "main.rs must handle --self-test");
      ctx.assert.ok(mainRs.includes("std::process::exit(1)"), "main.rs must exit(1) on self-test failure");

      const bogusRunner = await ctx.cli.runCommand("node", ["tests/e2e/run.mjs", "--bogus-flag"]);
      ctx.assert.equal(bogusRunner.ok, false);
      ctx.assert.equal(bogusRunner.exitCode, 1);
      ctx.assert.match(bogusRunner.stderr, /Unknown CLI argument/i);

      const selfTest = await ctx.cli.runSelfTest();
      ctx.assert.equal(
        selfTest.ok,
        true,
        `runSelfTest failed: ${selfTest.stderr || selfTest.stdout}`
      );

      const exeRel = path.join(
        "src-tauri",
        "target",
        "debug",
        process.platform === "win32" ? "laptopbench-qc.exe" : "laptopbench-qc"
      );
      const extraFlagSelfTest = await ctx.cli.runCommand(path.join(ctx.rootDir, exeRel), [
        "--self-test",
        "--unrelated-flag",
      ]);
      ctx.assert.equal(
        extraFlagSelfTest.ok,
        true,
        `--self-test --unrelated-flag failed (exitCode=${extraFlagSelfTest.exitCode}): stderr=${
          extraFlagSelfTest.stderr || ""
        } stdout=${extraFlagSelfTest.stdout || ""}`
      );
      ctx.assert.equal(
        extraFlagSelfTest.exitCode,
        0,
        `Expected exitCode 0 for --self-test --unrelated-flag: stderr=${
          extraFlagSelfTest.stderr || ""
        } stdout=${extraFlagSelfTest.stdout || ""}`
      );
    },
  },

  {
    id: "T2-F19-03",
    tier: 2,
    feature: "F19",
    title: "--self-test exits 0 with zero [FAIL] and verifies v2.3.0 safety/UserBenchmark/discharge probes",
    tags: ["tier2", "boundary", "cli", "self-test"],
    async run(ctx) {
      const res = await ctx.cli.runSelfTest();
      ctx.assert.equal(res.ok, true, `Self-test failed: ${res.stderr || res.stdout}`);
      ctx.assert.equal(res.exitCode, 0);
      ctx.assert.equal(/\[FAIL\]/.test(res.stdout + res.stderr), false);

      for (const baselineLine of [
        "RAM pattern verifier",
        "SIMD Kernels",
        "3D Path-Tracer",
        "Native PDF 1.4",
        "Telemetry",
        "Specs",
        "Storage SMART",
      ]) {
        ctx.assert.ok(
          res.stdout.includes(baselineLine),
          `Expected baseline self-test output "${baselineLine}"`
        );
      }

      ctx.assert.match(res.stdout, /v2\.3/, "Expected v2.3 banner in --self-test output");
      ctx.assert.match(res.stdout, /UserBenchmark/i, "Expected UserBenchmark check in --self-test");
      ctx.assert.match(
        res.stdout,
        /Battery.*Discharge|Discharge.*Normality/i,
        "Expected Battery Discharge check in --self-test"
      );
      ctx.assert.match(
        res.stdout,
        /Write Budget|SSD.*Budget|RAM.*Reserve|Thermal.*Cutoff/i,
        "Expected hardware safety bounds check in --self-test"
      );
    },
  },

  {
    id: "T2-F19-04",
    tier: 2,
    feature: "F19",
    title: "README.md, DashboardView.tsx, and PreReportModal.tsx reflect 14-step v2.3.0 pipeline without 13-step drift",
    tags: ["tier2", "boundary", "docs", "version"],
    async run(ctx) {
      const readme = ctx.cli.readRepoFile("README.md");
      ctx.assert.ok(readme.includes("2.3.0"), "README.md must mention 2.3.0");
      ctx.assert.match(readme, /14-Step/i, "README.md must describe 14-Step pipeline");
      ctx.assert.equal(/13-Step/i.test(readme), false, "README.md must not retain stale 13-Step");
      ctx.assert.ok(readme.includes("14."), "README.md must list numbered step 14.");
      ctx.assert.match(readme, /Touchscreen/i);
      ctx.assert.match(readme, /UserBenchmark/i);
      ctx.assert.match(readme, /Discharge/i);

      const dash = ctx.cli.readRepoFile("src/tests/DashboardView.tsx");
      const modal = ctx.cli.readRepoFile("src/components/PreReportModal.tsx");
      ctx.assert.equal(/13-Stage/i.test(dash), false, "DashboardView.tsx still contains stale 13-Stage");
      ctx.assert.equal(/13-stage/i.test(modal), false, "PreReportModal.tsx still contains stale 13-stage");
    },
  },

  {
    id: "T2-F19-05",
    tier: 2,
    feature: "F19",
    title: "Sidebar.tsx source and rendered DOM display exact v2.3.0 badge without stale v2.1 or 13-step tooltip",
    tags: ["tier2", "boundary", "version", "sidebar"],
    async run(ctx) {
      const sidebarSrc = ctx.cli.readRepoFile("src/components/Sidebar.tsx");
      ctx.assert.ok(sidebarSrc.includes("v2.3.0"), "Sidebar.tsx source must contain v2.3.0");
      ctx.assert.equal(sidebarSrc.includes("v2.1"), false, "Sidebar.tsx must not contain stale v2.1");
      ctx.assert.equal(
        sidebarSrc.includes("all 13 steps"),
        false,
        "Sidebar.tsx must not hardcode 'all 13 steps'"
      );

      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("LaptopBench QC", 5000);
        const asideText = await app.evaluate(
          () => document.querySelector("aside")?.innerText || ""
        );
        ctx.assert.ok(asideText.includes("v2.3.0"), "Rendered Sidebar must display v2.3.0");
        ctx.assert.equal(/v2\.1/i.test(asideText), false, "Rendered Sidebar must not display v2.1");
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F20 — Windows GNU Bundle & macOS Parity Boundaries
  // =========================================================================
  {
    id: "T2-F20-01",
    tier: 2,
    feature: "F20",
    title: "Zero proprietary or compiled binary archives bundled inside src-tauri, src, public, or repo root",
    tags: ["tier2", "boundary", "bundle", "clean-repo"],
    async run(ctx) {
      const binCheck = ctx.cli.checkNoBundledBinaries();
      ctx.assert.equal(
        binCheck.ok,
        true,
        `Unexpected bundled binaries: ${JSON.stringify(binCheck.found)}`
      );
      ctx.assert.equal(binCheck.found.length, 0);

      const repoFiles = ctx.cli.listFiles(".", {
        recursive: true,
        excludeDirs: new Set(["node_modules", "target", ".git", ".agents", "dist"]),
      });
      const forbiddenRefs = [
        "montest.exe",
        "testmem5.7z",
        "performancetest_windows_x86-64.exe",
        "performancetest_mac_cmd.zip",
        "furmark_2.11.0.4_win64_setup.exe",
      ];
      for (const f of repoFiles) {
        const lower = path.basename(f).toLowerCase();
        ctx.assert.equal(
          forbiddenRefs.includes(lower),
          false,
          `Forbidden external reference binary found in repo: ${f}`
        );
      }
    },
  },

  {
    id: "T2-F20-02",
    tier: 2,
    feature: "F20",
    title: "GitHub Actions release.yml configures both windows-latest and macos-latest universal-apple-darwin targets",
    tags: ["tier2", "boundary", "ci", "macos"],
    async run(ctx) {
      const yml = ctx.cli.readRepoFile(".github/workflows/release.yml");
      ctx.assert.ok(yml.includes("windows-latest"));
      ctx.assert.ok(yml.includes("Windows-x64"));
      ctx.assert.ok(yml.includes("macos-latest"));
      ctx.assert.ok(yml.includes("--target universal-apple-darwin"));
      ctx.assert.ok(yml.includes("macOS-Universal"));
      ctx.assert.ok(yml.includes("aarch64-apple-darwin,x86_64-apple-darwin"));
      ctx.assert.ok(yml.includes("cargo check --manifest-path src-tauri/Cargo.toml"));
      ctx.assert.ok(yml.includes("tauri-apps/tauri-action@v0"));
      for (const ext of [".msi", ".exe", ".dmg", ".app.tar.gz"]) {
        ctx.assert.ok(yml.includes(ext), `release.yml missing artifact glob for ${ext}`);
      }
    },
  },

  {
    id: "T2-F20-03",
    tier: 2,
    feature: "F20",
    title: "build.rs enforces LAPTOPBENCH_NO_ELEVATE=1 gating, GNU libresource.a/WebView2Loader.dll handling, and passes cargo check",
    tags: ["tier2", "boundary", "windows-gnu", "build"],
    async run(ctx) {
      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      ctx.assert.ok(buildRs.includes("LAPTOPBENCH_NO_ELEVATE"));
      ctx.assert.ok(buildRs.includes("requireAdministrator"));
      ctx.assert.ok(buildRs.includes("target_env") && buildRs.includes("gnu"));
      ctx.assert.ok(buildRs.includes("libresource.a"));
      ctx.assert.ok(buildRs.includes("WebView2Loader.dll"));
      ctx.assert.ok(buildRs.includes("cargo:rustc-link-arg="));

      const checkRes = await ctx.cli.runCargoCheck();
      ctx.assert.equal(checkRes.ok, true, `cargo check failed: ${checkRes.stderr}`);
    },
  },

  {
    id: "T2-F20-04",
    tier: 2,
    feature: "F20",
    title: "tauri.conf.json and Info.plist configure macOS Universal permissions, icons, and 2.3.0 version",
    tags: ["tier2", "boundary", "macos", "manifest"],
    async run(ctx) {
      const conf = ctx.cli.readJson("src-tauri/tauri.conf.json");
      ctx.assert.equal(conf.bundle?.macOS?.minimumSystemVersion, "12.0");
      ctx.assert.equal(conf.bundle?.macOS?.infoPlist, "Info.plist");
      ctx.assert.ok(Array.isArray(conf.bundle?.icon));
      ctx.assert.ok(conf.bundle.icon.includes("icons/icon.icns"));
      ctx.assert.ok(conf.bundle.icon.includes("icons/icon.ico"));

      const plist = ctx.cli.readRepoFile("src-tauri/Info.plist");
      ctx.assert.ok(plist.includes("NSCameraUsageDescription"));
      ctx.assert.ok(plist.includes("NSMicrophoneUsageDescription"));
      ctx.assert.ok(plist.includes("NSInputMonitoringUsageDescription"));

      ctx.assert.equal(conf.version, "2.3.0", `Expected tauri.conf.json version 2.3.0, got ${conf.version}`);
    },
  },

  {
    id: "T2-F20-05",
    tier: 2,
    feature: "F20",
    title: "All platform hardware modules retain #[cfg(target_os = \"macos\")] parity and compile cleanly",
    tags: ["tier2", "boundary", "macos", "cfg-parity"],
    async run(ctx) {
      const macosModules = [
        "src-tauri/src/modules/battery.rs",
        "src-tauri/src/modules/biometrics.rs",
        "src-tauri/src/modules/error_logs.rs",
        "src-tauri/src/modules/security_audit.rs",
        "src-tauri/src/modules/specs.rs",
        "src-tauri/src/modules/storage.rs",
        "src-tauri/src/modules/usb_ports.rs",
      ];
      for (const rel of macosModules) {
        const src = ctx.cli.readRepoFile(rel);
        ctx.assert.ok(
          src.includes('target_os = "macos"'),
          `Expected #[cfg(target_os = "macos")] in ${rel}`
        );
      }

      const modFiles = ctx.cli.listFiles("src-tauri/src/modules");
      if (modFiles.includes("src-tauri/src/modules/network.rs")) {
        const netSrc = ctx.cli.readRepoFile("src-tauri/src/modules/network.rs");
        ctx.assert.ok(
          netSrc.includes('target_os = "macos"') || netSrc.includes('not(target_os = "windows")'),
          "Expected macOS / non-Windows cfg gating in src-tauri/src/modules/network.rs"
        );
      }

      const simdSrc = ctx.cli.readRepoFile("src-tauri/src/modules/simd_kernels.rs");
      ctx.assert.ok(simdSrc.includes('target_arch = "aarch64"'));

      const kbHookSrc = ctx.cli.readRepoFile("src-tauri/src/modules/keyboard_hook.rs");
      ctx.assert.ok(kbHookSrc.includes('not(target_os = "windows")'));

      const telSrc = ctx.cli.readRepoFile("src-tauri/src/modules/telemetry.rs");
      ctx.assert.ok(telSrc.includes('target_os = "windows"'));

      const checkRes = await ctx.cli.runCargoCheck();
      ctx.assert.equal(checkRes.ok, true, `cargo check failed: ${checkRes.stderr}`);
    },
  },
];
