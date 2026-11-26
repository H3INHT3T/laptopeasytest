// Tier 1 Feature Coverage Tests: F16 (Expanded Keyboard/Media/Ports/Stress Views),
// F17 (Plain-Language Data Displays, Swiss Precision Light Theme & Attribution),
// F18 (Plain-Language HTML/PDF/JSON Reports), F19 (Expanded --self-test & Version 2.3.0),
// F20 (Windows GNU Bundle, Zero Proprietary Executables & macOS #[cfg] Parity).

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function mergeDeep(target, source) {
  if (!isPlainObject(source)) return source;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, val] of Object.entries(source)) {
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = mergeDeep(out[key], val);
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) => (isPlainObject(item) ? mergeDeep({}, item) : item));
    } else {
      out[key] = val;
    }
  }
  return out;
}

function mapDischargeStatus(verdict) {
  const v = String(verdict || "").toUpperCase();
  if (v === "NORMAL") return "pass";
  if (v === "ABNORMAL") return "fail";
  if (v === "NOT_APPLICABLE") return "notApplicable";
  return "warn";
}

function mapNetworkStatus(verdict) {
  const v = String(verdict || "").toUpperCase();
  if (v === "PASS") return "pass";
  if (v === "FAIL") return "fail";
  return "warn";
}

function syncedFixture(builderFn, overrides = {}) {
  const base = builderFn();
  const rawDischargeEvents = Array.isArray(base.progressEvents?.["battery:discharge"])
    ? base.progressEvents["battery:discharge"]
    : [];
  const syncedEvents = rawDischargeEvents.map((ev, idx) => ({
    ...ev,
    chargeDropPct: typeof ev.chargeDropPct === "number" ? ev.chargeDropPct : idx === 0 ? 0.2 : 0.8,
    note:
      typeof ev.note === "string"
        ? ev.note
        : idx === 0
        ? "Phase 1 idle baseline steady."
        : "Phase 2 controlled load steady at 22.8 W.",
  }));

  const synced = mergeDeep(base, {
    batteryDischarge: {
      status: base.batteryDischarge?.status ?? mapDischargeStatus(base.batteryDischarge?.verdict),
    },
    networkDiagnostics: {
      status: base.networkDiagnostics?.status ?? mapNetworkStatus(base.networkDiagnostics?.verdict),
    },
    userBenchmark: {
      sourceMode: base.userBenchmark?.sourceMode ?? "offline_calibrated",
    },
    progressEvents: {
      "battery:discharge": syncedEvents,
    },
  });

  return mergeDeep(synced, overrides);
}

async function openReadyApp(ctx, fixture, opts = {}) {
  const buildRes = await ctx.cli.ensureBuild();
  ctx.assert.equal(buildRes.ok, true, `Frontend build failed: ${buildRes.stderr || buildRes.stdout}`);
  const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, ...opts });
  try {
    await app.waitForText("Inspection Manifest", 8000);
    return app;
  } catch (err) {
    await app.close();
    throw err;
  }
}

async function findVisibleButtons(app, regex, { enabledOnly = false, excludeRegex = null } = {}) {
  const buttons = await app.querySelectorAllInfo("button");
  return buttons.filter((b) => {
    const visible =
      b.rect.width > 0 &&
      b.rect.height > 0 &&
      b.style.display !== "none" &&
      b.style.visibility !== "hidden";
    if (!visible) return false;
    if (enabledOnly && b.disabled) return false;
    if (excludeRegex && excludeRegex.test(b.text)) return false;
    return regex.test(b.text);
  });
}

async function assertAndClickButton(ctx, app, regex, failMessage, opts = {}) {
  const matches = await findVisibleButtons(app, regex, { enabledOnly: true, excludeRegex: opts.excludeRegex || null });
  ctx.assert.ok(matches.length > 0, failMessage);
  if (opts.excludeRegex && matches[0].text) {
    const exactRx = new RegExp(`^${matches[0].text.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    return app.clickButton(exactRx);
  }
  return app.clickButton(regex);
}

const DISCHARGE_BTN_REGEX = /(discharge.*normal|normal.*discharge|run.*discharge|start.*discharge)/i;
const DISCHARGE_EXCLUDE_REGEX = /(sag pulse|live monitor|stop monitor|start live)/i;

async function enterPipelineFromDashboard(app) {
  const beginBtns = await findVisibleButtons(app, /^Begin Stage 01$/i, { enabledOnly: true });
  if (beginBtns.length > 0) {
    await app.clickButton(/^Begin Stage 01$/i);
    await app.waitForText(/Complete Hardware Specifications/i, 5000);
  }
}

async function getMainText(app) {
  return app.evaluate(() => document.querySelector("main")?.innerText || document.body?.innerText || "");
}

async function skipOrAdvanceTo(ctx, app, targetRegex, maxSteps = 16) {
  await enterPipelineFromDashboard(app);
  for (let i = 0; i < maxSteps; i += 1) {
    const mainText = await getMainText(app);
    if (targetRegex.test(mainText)) {
      return mainText;
    }
    const nextBtns = await findVisibleButtons(app, /^Next:\s*Stage/i, { enabledOnly: true });
    if (nextBtns.length > 0) {
      await app.clickButton(/^Next:\s*Stage/i);
      continue;
    }
    const skipBtns = await findVisibleButtons(app, /^Skip Step$/i, { enabledOnly: true });
    if (skipBtns.length > 0) {
      await app.clickButton(/^Skip Step$/i);
      continue;
    }
    break;
  }
  const finalMain = await getMainText(app);
  ctx.assert.match(finalMain, targetRegex, `Expected to navigate to stage matching ${String(targetRegex)}`);
  return finalMain;
}

async function openPreReportModalAtEnd(ctx, app, maxSteps = 18) {
  await enterPipelineFromDashboard(app);
  for (let i = 0; i < maxSteps; i += 1) {
    const modalBtns = await findVisibleButtons(app, /^Issue Official QC Certificate$/i, { enabledOnly: true });
    if (modalBtns.length > 0) return;

    const asideCert = await findVisibleButtons(app, /^Issue QC Certificate$/i, { enabledOnly: true });
    if (asideCert.length > 0) {
      await app.clickButton(/^Issue QC Certificate$/i);
      await app.waitForText(/Issue Branded Hardware Certificate/i, 5000);
      return;
    }

    const nextBtns = await findVisibleButtons(app, /^Next:\s*Stage/i, { enabledOnly: true });
    if (nextBtns.length > 0) {
      await app.clickButton(/^Next:\s*Stage/i);
      continue;
    }
    const skipBtns = await findVisibleButtons(app, /^Skip Step$/i, { enabledOnly: true });
    if (skipBtns.length > 0) {
      await app.clickButton(/^Skip Step$/i);
      continue;
    }
    break;
  }
  await app.waitForText(/Issue Branded Hardware Certificate/i, 5000);
}

async function assertCleanSession(ctx, app) {
  const pageErrors = await app.getPageErrors();
  ctx.assert.equal(pageErrors.length, 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);
  const invokeLog = await app.getInvokeLog();
  const unknown = invokeLog.filter((e) => e.unknownCommand);
  ctx.assert.equal(unknown.length, 0, `Unexpected unknown IPC commands: ${JSON.stringify(unknown)}`);
  return invokeLog;
}

export const tests = [
  // =========================================================================
  // F16 — Expanded Keyboard (en.key-test.ru), Media, Ports & Stress Views
  // =========================================================================
  {
    id: "T1-F16-01",
    tier: 1,
    feature: "F16",
    title: "Keyboard layouts, live key testing, and en.key-test.ru stuck-key/NKRO/latency scopes",
    tags: ["tier1", "ui", "keyboard"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Keyboard & Touchpad Dead-Zone Audit/i);
        await app.clickButton(/^Win Compact$/i);
        await app.clickButton(/^Win \+ Numpad$/i);
        let body = await getMainText(app);
        ctx.assert.ok(/PgUp/i.test(body) && /Num/i.test(body), "Win + Numpad layout missing PgUp/Num keys");

        await app.clickButton(/^MacBook$/i);
        body = await getMainText(app);
        ctx.assert.ok(/cmd/i.test(body) && /option/i.test(body), "MacBook layout missing command/option keys");

        await app.pressKey("a");
        await app.pressKey("Enter");
        body = await getMainText(app);
        const testedMatch = body.match(/(?:Keys Tested[\s\r\n]+|01\.\s*Keyboard\s*\()(\d+)\s*\//i);
        ctx.assert.ok(testedMatch && Number(testedMatch[1]) >= 2, `Expected Keys Tested >= 2 after key presses, got ${testedMatch?.[0]}`);

        ctx.assert.match(body, /stuck[- ]?key/i, "Expected en.key-test.ru stuck-key pre-check indicator");
        ctx.assert.match(body, /NKRO|rollover/i, "Expected NKRO rollover counter in KeyboardTestView");
        ctx.assert.match(body, /latency[\s\S]{0,40}\bms\b|\bms\b[\s\S]{0,40}latency/i, "Expected key latency (ms) telemetry in KeyboardTestView");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F16-02",
    tier: 1,
    feature: "F16",
    title: "Touchpad 72-cell grid coverage, clicks, Reset Pad, and Pass Input Audit verdict",
    tags: ["tier1", "ui", "keyboard"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Keyboard & Touchpad Dead-Zone Audit/i);
        await app.clickButton(/02\. Touchpad/i);
        await app.waitForText(/0\/72/, 5000);

        let body = await getMainText(app);
        ctx.assert.match(body, /3s Cursor-Drift Check/i, "Expected 3s Cursor-Drift Check button");
        ctx.assert.match(body, /Reset Pad/i, "Expected Reset Pad button");

        const cellRects = await app.evaluate(() => {
          const grid = document.querySelector(".grid-cols-12");
          if (!grid) return [];
          const cells = Array.from(grid.children);
          return cells.slice(0, 6).map((c) => {
            const r = c.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, total: cells.length };
          });
        });
        ctx.assert.equal(cellRects[0]?.total, 72, `Expected 72 touchpad grid cells, got ${cellRects[0]?.total}`);

        for (const pt of cellRects.slice(0, 4)) {
          await app.hoverAt(pt.x, pt.y);
        }
        await app.evaluate(() => {
          const grid = document.querySelector(".grid-cols-12");
          grid?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        body = await app.getBodyText();
        ctx.assert.match(body, /[1-9]\d*\/72/, "Expected touchpad cell coverage counter > 0/72");
        ctx.assert.match(body, /L:[1-9]/, "Expected left-click counter L:>=1");

        await app.clickButton(/Reset Pad/i);
        await app.waitForText(/0\/72/, 3000);

        await app.clickButton(/Pass Input Audit/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F16-03",
    tier: 1,
    feature: "F16",
    title: "MediaTestView camera/mic controls, waveform canvas, and expanded SNR diagnostic",
    tags: ["tier1", "ui", "media"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Camera & Microphone Test/i);
        const body = await app.getBodyText();
        for (const label of ["Start Camera", "Start Mic", "Record 3s & Playback", "Input Signal Level"]) {
          ctx.assert.ok(body.includes(label), `MediaTestView missing "${label}"`);
        }
        const hasCanvas = await app.evaluate(() => document.querySelectorAll("main canvas").length > 0);
        ctx.assert.equal(hasCanvas, true, "MediaTestView must render microphone waveform <canvas>");

        ctx.assert.match(
          body,
          /SNR|signal[- ]to[- ]noise|noise floor|audio quality/i,
          "Expected expanded microphone SNR / audio signal quality diagnostic in MediaTestView"
        );

        await app.clickButton(/Pass Camera & Mic/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F16-04",
    tier: 1,
    feature: "F16",
    title: "PortsSpeakersView live usb:event hot-plug, L/R/Sweep audio controls, ports checklist, and verdict",
    tags: ["tier1", "ui", "ports"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Live USB4\/3\.x Speed Detector/i);
        await app.waitForText(/SanDisk Ultra Fit USB 3\.2 Gen 1/i, 5000);

        await app.emitTauriEvent("usb:event", {
          eventKind: "CONNECTED",
          timestamp: "2026-11-25T19:20:00Z",
          device: {
            instanceId: "USB\\VID_0781&PID_5591\\PORTTEST",
            name: "SanDisk Extreme Pro USB 3.2",
            speedClass: "USB 3.2 Gen 2 (10 Gbps)",
            isSuperspeed: true,
            status: "OK",
          },
          devices: fixture.usbDevices,
        });
        await app.waitForText(/SanDisk Extreme Pro USB 3\.2/i, 5000);

        const body = await getMainText(app);
        for (const label of [
          "CONNECTED",
          "Left (440 Hz)",
          "Right (587 Hz)",
          "Balanced Stereo",
          "Full Frequency Sweep (80 Hz → 12 kHz • 4.0s)",
          "USB-A Ports",
        ]) {
          ctx.assert.match(
            body,
            new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
            `PortsSpeakersView missing "${label}"`
          );
        }

        await app.clickButton(/Pass Ports & Speakers/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);
        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(invokeLog.some((e) => e.cmd === "start_usb_monitor" && e.ok), "Expected start_usb_monitor call");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F16-05",
    tier: 1,
    feature: "F16",
    title: "Expanded Stress Views (Storage safe <=512 MB budget/QD32/Log 0x02, RAM TM5, GPU/VRAM/Torture)",
    tags: ["tier1", "ui", "stress", "ipc"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        // StorageView
        await skipOrAdvanceTo(ctx, app, /SSD SMART Health/i);
        const storageInitialText = await getMainText(app);
        const storageSelectOptions = await app.evaluate(() =>
          Array.from(document.querySelectorAll("main select option")).map((o) => o.textContent || "")
        );
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/6120/, 5000);

        // RAM Test View
        await skipOrAdvanceTo(ctx, app, /RAM Continuous Durability Audit/i);
        const ramBody = await getMainText(app);
        ctx.assert.ok(
          ramBody.includes("Test0: RefreshStable (Retention)") && ramBody.includes("Test7: BlockMove (64B Cache-Line)"),
          "Expected Test0..Test7 v2.3.0 MT0 kernel matrix"
        );
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/24\.0 GB/, 5000);

        // GPU / VRAM / Power Torture View
        await skipOrAdvanceTo(ctx, app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/52\.4/, 5000);
        await app.clickButton(/02\. VRAM Integrity/i);
        await app.clickButton(/Start VRAM Sweep/i);
        await app.waitForText(/6\.0 GB/, 5000);
        await app.clickButton(/03\. Power & AC Torture/i);
        await app.clickButton(/Launch Combined Torture/i);
        await app.waitForText(/Ultrabook Combined Thermal Envelope|4\.1%/i, 5000);

        const invokeLog = await assertCleanSession(ctx, app);
        for (const cmd of [
          "run_storage_benchmark",
          "run_ram_stress",
          "run_gpu_stress",
          "run_vram_test",
          "run_power_torture",
        ]) {
          ctx.assert.ok(invokeLog.some((e) => e.cmd === cmd && e.ok), `Expected ${cmd} IPC call to succeed`);
        }

        // Verify v2.3.0 StorageView safe <=512 MB budget & expanded scopes
        const joinedOptions = storageSelectOptions.join(" | ");
        ctx.assert.match(
          joinedOptions,
          /128\s*MB|256\s*MB|512\s*MB/i,
          `Expected StorageView presets to use safe <=512 MB budgets, got: ${joinedOptions}`
        );
        ctx.assert.equal(
          /\b(?:1|2|4)\s*GB\b/i.test(joinedOptions),
          false,
          `StorageView presets must not advertise unsafe 1GB/2GB/4GB write sizes: ${joinedOptions}`
        );
        ctx.assert.match(storageInitialText, /QD32|70\/30|SLC/i, "Expected QD32 / 70-30 Mixed / SLC display in StorageView");
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F17 — Plain-Language Data Displays, Swiss Precision Light Theme & Attribution
  // =========================================================================
  {
    id: "T1-F17-01",
    tier: 1,
    feature: "F17",
    title: "Static Swiss Precision Light palette scan finds zero non-Swiss color classes",
    tags: ["tier1", "cli", "theme"],
    run: async (ctx) => {
      const res = ctx.cli.checkSwissStaticColors();
      ctx.assert.ok(res.filesScanned > 10, `Expected > 10 frontend files scanned, got ${res.filesScanned}`);
      ctx.assert.equal(
        res.ok && res.violations.length === 0,
        true,
        `Static Swiss palette violations: ${JSON.stringify(res.violations)}`
      );
    },
  },

  {
    id: "T1-F17-02",
    tier: 1,
    feature: "F17",
    title: "Runtime DOM Swiss Precision Light palette audit across Dashboard, Performance, and PreReportModal",
    tags: ["tier1", "ui", "theme"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const dashPalette = await app.auditSwissPalette();
        ctx.assert.ok(dashPalette.totalChecked > 100, `Expected >100 checked elements on Dashboard, got ${dashPalette.totalChecked}`);
        ctx.assert.assertSwissPalette(dashPalette);

        await skipOrAdvanceTo(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/16,450|16450/i, 5000);
        const perfPalette = await app.auditSwissPalette();
        ctx.assert.ok(perfPalette.totalChecked > 100, `Expected >100 checked elements on Performance, got ${perfPalette.totalChecked}`);
        ctx.assert.assertSwissPalette(perfPalette);

        await openPreReportModalAtEnd(ctx, app);
        const modalPalette = await app.auditSwissPalette();
        ctx.assert.ok(modalPalette.totalChecked > 100, `Expected >100 checked elements on PreReportModal, got ${modalPalette.totalChecked}`);
        ctx.assert.assertSwissPalette(modalPalette);

        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F17-03",
    tier: 1,
    feature: "F17",
    title: "Visible creator attribution (Hein Htet Zaw / @ich8g92) across Dashboard, Sidebar, and PreReportModal",
    tags: ["tier1", "ui", "attribution"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const dashText = await app.getBodyText();
        ctx.assert.assertAttributionVisible(dashText);
        ctx.assert.ok(dashText.includes("Created by"), 'Expected "Created by Hein Htet Zaw" attribution on Dashboard');

        await openPreReportModalAtEnd(ctx, app);
        const modalText = await app.evaluate(() => {
          const modal = document.querySelector(".fixed.inset-0");
          return modal ? modal.innerText : "";
        });
        ctx.assert.assertAttributionVisible(modalText);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F17-04",
    tier: 1,
    feature: "F17",
    title: "UserBenchmark Vehicle Tiers (Aircraft Carrier) & Gaming/Desktop/Workstation profiles in PerformanceView",
    tags: ["tier1", "ui", "userbenchmark", "ipc"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/CALIBRATION BASELINE/i, 5000);

        const body = await getMainText(app);
        ctx.assert.ok(body.includes("% OF NORMAL") && body.includes("85% NORMAL"), "Expected BaselineCard calibration output");

        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "compare_userbenchmark" && e.ok),
          "Expected PerformanceView to invoke compare_userbenchmark IPC"
        );
        for (const expected of ["Aircraft Carrier", "34.2", "91.5", "76.4", "Above Expectations"]) {
          ctx.assert.ok(body.includes(expected), `PerformanceView missing UserBenchmark display "${expected}"`);
        }
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F17-05",
    tier: 1,
    feature: "F17",
    title: "Plain-language diagnostic summaries across Specs, Battery, and UserBenchmark views",
    tags: ["tier1", "ui", "userbenchmark", "battery"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.singleChannelSlowWifi);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await enterPipelineFromDashboard(app);
        const specsBody = await getMainText(app);
        ctx.assert.ok(
          specsBody.includes("Single-channel RAM detected") && specsBody.includes("Weak Wi-Fi signal"),
          "Expected plain-language RAM/Wi-Fi warnings on SpecsView"
        );

        await skipOrAdvanceTo(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/CALIBRATION BASELINE/i, 5000);
        const perfBody = await getMainText(app);
        ctx.assert.ok(
          perfBody.includes("Destroyer") && perfBody.includes("Single-channel memory configuration"),
          "Expected plain-language UserBenchmark summary in PerformanceView"
        );
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F18 — Plain-Language HTML/PDF/JSON Reports (PreReportModal + Exports)
  // =========================================================================
  {
    id: "T1-F18-01",
    tier: 1,
    feature: "F18",
    title: "PreReportModal validation and happy-path certificate export links",
    tags: ["tier1", "ui", "report"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook, {
        shopProfile: {
          shopName: "",
          technicianName: "",
          logoDataUrl: null,
          defaultOutputDir: "C:\\QC_Reports",
        },
      });
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await openPreReportModalAtEnd(ctx, app);
        await app.clickButton(/^Issue Official QC Certificate$/i);
        await app.waitForText(/Please enter at least a Shop Name or Technician Username\./i, 5000);

        await app.fillInput("Shop / Lab Name (Saved)", "Swiss Lab QC");
        await app.fillInput("Technician Username (Saved)", "Hein Htet Zaw");
        await app.fillInput("Customer / SKU", "SKU-2026-041");
        await app.fillInput("Technician Remarks", "Clean Grade A unit verified.");

        await app.clickButton(/^Issue Official QC Certificate$/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const body = await app.getBodyText();
        for (const btnLabel of ["Open PDF", "Open HTML", "Folder"]) {
          ctx.assert.match(
            body,
            new RegExp(btnLabel, "i"),
            `Expected exported action link "${btnLabel}"`
          );
        }
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F18-02",
    tier: 1,
    feature: "F18",
    title: "export_qc_report IPC payload includes shopProfile, verdict, durabilityGrade, scores, specs, tests, signoff",
    tags: ["tier1", "ui", "ipc", "report"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /SSD SMART Health/i);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/6120/, 5000);

        await skipOrAdvanceTo(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/16,450|16450/i, 5000);

        await skipOrAdvanceTo(ctx, app, /Live USB4\/3\.x Speed Detector/i);
        await app.clickButton(/Pass Ports & Speakers/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);
        await app.clickButton(/^Issue QC Certificate$/i);
        await app.waitForText(/Issue Branded Hardware Certificate/i, 5000);

        await app.clickButton(/^Issue Official QC Certificate$/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanSession(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report" && e.ok);
        ctx.assert.ok(exportCall, "Expected export_qc_report IPC call");
        const payload = exportCall.args?.payload;
        ctx.assert.ok(payload, "export_qc_report missing args.payload");
        ctx.assert.equal(payload.shopProfile?.shopName, "ProTech Precision Lab");
        ctx.assert.ok(typeof payload.overallVerdict === "string" && payload.overallVerdict.length > 0);
        ctx.assert.ok(typeof payload.durabilityGrade === "string" && payload.durabilityGrade.length > 0);
        ctx.assert.ok(Array.isArray(payload.subsystemScores) && payload.subsystemScores.length > 0);
        ctx.assert.ok(payload.specs && payload.specs.serialNumber === "PF4X9102");
        ctx.assert.ok(Array.isArray(payload.tests) && payload.tests.length >= 13);
        ctx.assert.ok(payload.signoff && payload.signoff.portsChecked === true);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F18-03",
    tier: 1,
    feature: "F18",
    title: "PreReportModal & export_qc_report payload include touchscreen, UserBenchmark, Battery Normality, and v2.3.0 stage count",
    tags: ["tier1", "ui", "ipc", "report"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Battery Health/i);
        await assertAndClickButton(
          ctx,
          app,
          DISCHARGE_BTN_REGEX,
          "BatteryView missing Battery Discharge Normality trigger button",
          { excludeRegex: DISCHARGE_EXCLUDE_REGEX }
        );
        await app.waitForText(/\bNORMAL\b/, 5000);

        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);
        await skipOrAdvanceTo(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/CALIBRATION BASELINE/i, 5000);

        await openPreReportModalAtEnd(ctx, app);
        const modalText = await app.getBodyText();
        ctx.assert.equal(
          modalText.includes("13-stage"),
          false,
          'PreReportModal still references obsolete "13-stage" copy instead of 14-stage v2.3.0 ledger'
        );

        await app.clickButton(/^Issue Official QC Certificate$/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_battery_discharge_test" && e.ok),
          "Expected run_battery_discharge_test IPC call before exporting report"
        );
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report" && e.ok);
        const payload = exportCall?.args?.payload;
        ctx.assert.ok(payload, "Missing export_qc_report payload");
        ctx.assert.ok(
          Array.isArray(payload.tests) && payload.tests.some((t) => t.id === "touchscreen"),
          "ExportReportPayload.tests missing touchscreen stage"
        );
        ctx.assert.ok(payload.userBenchmark, "ExportReportPayload missing userBenchmark data");
        ctx.assert.ok(payload.batteryDischarge, "ExportReportPayload missing batteryDischarge data");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F18-04",
    tier: 1,
    feature: "F18",
    title: "Backend HTML report generator (report.rs) enforces Swiss palette, attribution, SHA-256, and v2.3.0 sections",
    tags: ["tier1", "cli", "rust", "report"],
    run: async (ctx) => {
      const reportRs = ctx.cli.readRepoFile("src-tauri/src/modules/report.rs");
      const reportProd = reportRs.split("#[cfg(test)]")[0];
      for (const token of ["#2563eb", "#09090b", "#1d4ed8", "Hein Htet Zaw", "@ich8g92", "compute_certificate_id"]) {
        ctx.assert.ok(reportProd.includes(token), `report.rs missing required token "${token}"`);
      }
      ctx.assert.equal(reportProd.includes("v2.1"), false, 'report.rs production code still hardcodes "v2.1"');
      ctx.assert.equal(/13-stage/i.test(reportProd), false, 'report.rs production code still hardcodes "13-stage"');
      ctx.assert.match(reportProd, /user_benchmark|UserBenchmark/i, "report.rs missing UserBenchmark report rendering");
      ctx.assert.match(reportProd, /battery_discharge|Discharge Normality/i, "report.rs missing Battery Discharge Normality rendering");
    },
  },

  {
    id: "T1-F18-05",
    tier: 1,
    feature: "F18",
    title: "Backend PDF generator (pdf_gen.rs) enforces Swiss palette, QR, attribution, and v2.3.0 sections",
    tags: ["tier1", "cli", "rust", "report"],
    run: async (ctx) => {
      const pdfRs = ctx.cli.readRepoFile("src-tauri/src/modules/pdf_gen.rs");
      const pdfProd = pdfRs.split("#[cfg(test)]")[0];
      for (const token of ["COL_BLACK", "COL_BLUE", "COL_BLUE_DARK", "COL_WHITE", "draw_qr", "Hein Htet Zaw", "@ich8g92", "%PDF-1.4"]) {
        ctx.assert.ok(pdfProd.includes(token), `pdf_gen.rs missing required token "${token}"`);
      }
      ctx.assert.equal(pdfProd.includes("v2.1"), false, 'pdf_gen.rs production code still hardcodes "v2.1"');
      ctx.assert.equal(/13-stage/i.test(pdfProd), false, 'pdf_gen.rs production code still hardcodes "13-stage"');
      ctx.assert.match(pdfProd, /user_benchmark|UserBenchmark/i, "pdf_gen.rs missing UserBenchmark summary rendering");
      ctx.assert.match(pdfProd, /battery_discharge|Discharge Normality/i, "pdf_gen.rs missing Battery Discharge Normality rendering");
    },
  },

  // =========================================================================
  // F19 — Expanded --self-test & Version Unification (2.3.0)
  // =========================================================================
  {
    id: "T1-F19-01",
    tier: 1,
    feature: "F19",
    title: "Version unification checks 2.3.0 across all 8 tracked manifests, UI, Rust, and README",
    tags: ["tier1", "cli", "version"],
    run: async (ctx) => {
      const aligned = ctx.cli.checkVersionAlignment("2.10.0");
      const mismatches = aligned.findings.filter((f) => !f.ok);
      ctx.assert.equal(
        aligned.ok,
        true,
        `Version alignment to 2.3.0 failed in ${mismatches.length} file(s): ${JSON.stringify(mismatches)}`
      );
    },
  },

  {
    id: "T1-F19-02",
    tier: 1,
    feature: "F19",
    title: "Debug --self-test executes cleanly and verifies all core hardware/diagnostic probes",
    tags: ["tier1", "cli", "self-test"],
    run: async (ctx) => {
      const st = await ctx.cli.runSelfTest();
      ctx.assert.equal(st.ok, true, `--self-test failed (exit ${st.exitCode}): ${st.stderr || st.stdout}`);
      ctx.assert.equal(st.exitCode, 0);
      for (const probe of [
        "RAM",
        "SIMD",
        "Path-Tracer",
        "PDF 1.4",
        "Telemetry",
        "Specs",
        "USB",
        "Security",
        "Battery",
        "Error Logs",
        "Storage SMART",
        "Biometrics",
        "wgpu",
      ]) {
        ctx.assert.ok(
          st.stdout.toLowerCase().includes(probe.toLowerCase()),
          `--self-test output missing core probe "${probe}"`
        );
      }
    },
  },

  {
    id: "T1-F19-03",
    tier: 1,
    feature: "F19",
    title: "Expanded --self-test reports v2.3.0 banner and verifies UserBenchmark calibration",
    tags: ["tier1", "cli", "self-test", "userbenchmark"],
    run: async (ctx) => {
      const st = await ctx.cli.runSelfTest();
      ctx.assert.equal(st.ok, true, `--self-test failed: ${st.stderr || st.stdout}`);
      ctx.assert.match(st.stdout, /v2\.(?:[3-9]|10)(?:\.0)?/i, "--self-test banner must reflect v2.10.0");
      ctx.assert.match(
        st.stdout,
        /UserBenchmark|Vehicle Tier/i,
        "--self-test output must verify UserBenchmark / Vehicle Tier calibration"
      );
    },
  },

  {
    id: "T1-F19-04",
    tier: 1,
    feature: "F19",
    title: "Expanded --self-test verifies SSD write-budget, RAM OS reserve, and thermal cutoff bounds",
    tags: ["tier1", "cli", "self-test", "safety"],
    run: async (ctx) => {
      const st = await ctx.cli.runSelfTest();
      ctx.assert.equal(st.ok, true, `--self-test failed: ${st.stderr || st.stdout}`);
      ctx.assert.match(st.stdout, /128|256|512/, "--self-test must verify safe SSD write budget constants");
      ctx.assert.match(st.stdout, /22%|reserve/i, "--self-test must verify RAM OS reserve safety bound");
      ctx.assert.match(st.stdout, /thermal.*cutoff|92|95/i, "--self-test must verify thermal cutoff enforcement");
    },
  },

  {
    id: "T1-F19-05",
    tier: 1,
    feature: "F19",
    title: "Expanded --self-test verifies Battery Discharge/Network and README.md documents v2.3.0",
    tags: ["tier1", "cli", "self-test", "docs"],
    run: async (ctx) => {
      const st = await ctx.cli.runSelfTest();
      ctx.assert.equal(st.ok, true, `--self-test failed: ${st.stderr || st.stdout}`);
      ctx.assert.match(
        st.stdout,
        /Battery Discharge|Discharge Normality/i,
        "--self-test must verify Battery Discharge Normality"
      );
      ctx.assert.match(st.stdout, /Network/i, "--self-test must verify Network diagnostics");

      const readme = ctx.cli.readRepoFile("README.md");
      ctx.assert.ok(readme.includes("2.10.0"), "README.md must document v2.10.0");
      for (const topic of ["UserBenchmark", "Battery Discharge", "Touchscreen", "14"]) {
        ctx.assert.match(readme, new RegExp(topic, "i"), `README.md missing v2.3.0 topic "${topic}"`);
      }
    },
  },

  // =========================================================================
  // F20 — Windows GNU Bundle, Zero Proprietary Executables & macOS #[cfg] Parity
  // =========================================================================
  {
    id: "T1-F20-01",
    tier: 1,
    feature: "F20",
    title: "Zero bundled external proprietary executables or archives in repo and tauri.conf.json",
    tags: ["tier1", "cli", "security", "bundle"],
    run: async (ctx) => {
      const binRes = ctx.cli.checkNoBundledBinaries();
      ctx.assert.equal(
        binRes.ok && binRes.found.length === 0,
        true,
        `Found disallowed bundled binaries: ${JSON.stringify(binRes.found)}`
      );

      const tauriConf = ctx.cli.readJson("src-tauri/tauri.conf.json");
      ctx.assert.equal(tauriConf.bundle?.externalBin, undefined, "tauri.conf.json must not declare externalBin");
      const resources = JSON.stringify(tauriConf.bundle?.resources ?? []);
      ctx.assert.equal(/\.(exe|dll|7z|zip|msi|so|dylib|cab)/i.test(resources), false, "tauri.conf.json resources must not bundle binaries");
    },
  },

  {
    id: "T1-F20-02",
    tier: 1,
    feature: "F20",
    title: "Windows GNU build.rs, Cargo.toml crate-type rlib, and NSIS/WiX/macOS bundle manifests",
    tags: ["tier1", "cli", "build"],
    run: async (ctx) => {
      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      for (const token of [
        "libresource.a",
        "WebView2Loader.dll",
        "deps",
        "LAPTOPBENCH_NO_ELEVATE",
        "requireAdministrator",
      ]) {
        ctx.assert.ok(buildRs.includes(token), `src-tauri/build.rs missing "${token}"`);
      }

      const cargoToml = ctx.cli.readRepoFile("src-tauri/Cargo.toml");
      ctx.assert.ok(cargoToml.includes('crate-type = ["rlib"]'), 'Cargo.toml missing crate-type = ["rlib"]');
      ctx.assert.ok(cargoToml.includes("windows-sys"), "Cargo.toml missing windows-sys dependency");

      const tauriConf = ctx.cli.readJson("src-tauri/tauri.conf.json");
      ctx.assert.ok(tauriConf.bundle?.windows?.nsis, "tauri.conf.json missing windows.nsis config");
      ctx.assert.ok(tauriConf.bundle?.windows?.wix, "tauri.conf.json missing windows.wix config");
      ctx.assert.equal(tauriConf.bundle?.macOS?.infoPlist, "Info.plist", "tauri.conf.json missing macOS infoPlist");
    },
  },

  {
    id: "T1-F20-03",
    tier: 1,
    feature: "F20",
    title: "macOS #[cfg(target_os = 'macos')] parity across modules and Info.plist permissions",
    tags: ["tier1", "cli", "macos", "parity"],
    run: async (ctx) => {
      const plist = ctx.cli.readRepoFile("src-tauri/Info.plist");
      for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSInputMonitoringUsageDescription"]) {
        ctx.assert.ok(plist.includes(key), `Info.plist missing macOS permission key "${key}"`);
      }

      for (const mod of [
        "battery.rs",
        "biometrics.rs",
        "error_logs.rs",
        "security_audit.rs",
        "specs.rs",
        "storage.rs",
        "usb_ports.rs",
      ]) {
        const src = ctx.cli.readRepoFile(`src-tauri/src/modules/${mod}`);
        ctx.assert.ok(
          src.includes('cfg(target_os = "macos")'),
          `src-tauri/src/modules/${mod} missing #[cfg(target_os = "macos")] parity`
        );
      }

      const kbdHook = ctx.cli.readRepoFile("src-tauri/src/modules/keyboard_hook.rs");
      ctx.assert.ok(
        kbdHook.includes('cfg(not(target_os = "windows"))'),
        'keyboard_hook.rs missing #[cfg(not(target_os = "windows"))] fallback'
      );

      const moduleFiles = ctx.cli.listFiles("src-tauri/src/modules");
      if (moduleFiles.includes("src-tauri/src/modules/network.rs")) {
        const netRs = ctx.cli.readRepoFile("src-tauri/src/modules/network.rs");
        ctx.assert.ok(
          netRs.includes('target_os = "macos"') || netRs.includes('not(target_os = "windows")'),
          "network.rs missing macOS/non-Windows #[cfg] parity"
        );
      }
    },
  },

  {
    id: "T1-F20-04",
    tier: 1,
    feature: "F20",
    title: "GitHub Actions release.yml builds Windows-x64 + macOS-Universal with v2.3.0 releaseBody",
    tags: ["tier1", "cli", "ci"],
    run: async (ctx) => {
      const yml = ctx.cli.readRepoFile(".github/workflows/release.yml");
      for (const token of [
        "windows-latest",
        "macos-latest",
        "--target universal-apple-darwin",
        "aarch64-apple-darwin,x86_64-apple-darwin",
        "cargo check --manifest-path src-tauri/Cargo.toml",
        "tauri-apps/tauri-action@v0",
        ".msi",
        ".exe",
        ".dmg",
      ]) {
        ctx.assert.ok(yml.includes(token), `release.yml missing "${token}"`);
      }

      ctx.assert.match(yml, /Touchscreen/i, "release.yml releaseBody missing v2.3.0 Touchscreen diagnostic");
      ctx.assert.match(yml, /Battery Discharge/i, "release.yml releaseBody missing v2.3.0 Battery Discharge Normality");
      ctx.assert.match(yml, /UserBenchmark/i, "release.yml releaseBody missing v2.3.0 UserBenchmark comparison");
    },
  },

  {
    id: "T1-F20-05",
    tier: 1,
    feature: "F20",
    title: "Rust compilation (cargo check) and frontend production build (ensureBuild) succeed",
    tags: ["tier1", "cli", "build", "rust"],
    run: async (ctx) => {
      const chk = await ctx.cli.runCargoCheck();
      ctx.assert.equal(chk.ok, true, `cargo check failed (exit ${chk.exitCode}): ${chk.stderr || chk.stdout}`);
      ctx.assert.equal(chk.exitCode, 0);

      const bld = await ctx.cli.ensureBuild();
      ctx.assert.equal(bld.ok, true, `Frontend build failed (exit ${bld.exitCode}): ${bld.stderr || bld.stdout}`);
      ctx.assert.equal(bld.exitCode, 0);
    },
  },
];
