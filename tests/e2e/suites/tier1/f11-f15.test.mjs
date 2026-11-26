// Tier 1 Feature Coverage Tests: F11 (Battery Discharge Normality), F12 (Expanded Reliability Diagnostics),
// F13 (Pipeline & Skip-Step Integration), F14 (Interactive Touchscreen Display Test),
// F15 (Expanded MonitorTest Display Suite + Unobstructed Fullscreen Portal).

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
  const dischargeVerdict = base.batteryDischarge?.verdict;
  const netVerdict = base.networkDiagnostics?.verdict;
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
      status: base.batteryDischarge?.status ?? mapDischargeStatus(dischargeVerdict),
    },
    networkDiagnostics: {
      status: base.networkDiagnostics?.status ?? mapNetworkStatus(netVerdict),
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

async function findTouchSurface(app) {
  return app.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll(
        '[data-testid="touchscreen-matrix"], [data-testid="touchscreen-grid"], [data-testid="touch-grid"], [data-touch-surface], [data-testid="touchscreen-surface"], main canvas, main [role="grid"], main .grid'
      )
    );
    const best = candidates
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 40 && r.height >= 40)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    if (!best) return null;
    return { left: best.r.left, top: best.r.top, width: best.r.width, height: best.r.height };
  });
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

async function assertCleanSession(ctx, app) {
  const pageErrors = await app.getPageErrors();
  ctx.assert.equal(pageErrors.length, 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);
  const invokeLog = await app.getInvokeLog();
  const unknown = invokeLog.filter((e) => e.unknownCommand);
  ctx.assert.equal(unknown.length, 0, `Unexpected unknown IPC commands: ${JSON.stringify(unknown)}`);
  return invokeLog;
}

const DISCHARGE_BTN_REGEX = /(discharge.*normal|normal.*discharge|run.*discharge|start.*discharge)/i;
const DISCHARGE_EXCLUDE_REGEX = /(sag pulse|live monitor|stop monitor|start live)/i;

export const tests = [
  // =========================================================================
  // F11 — Battery Discharge Normality Test
  // =========================================================================
  {
    id: "T1-F11-01",
    tier: 1,
    feature: "F11",
    title: "Backend BatteryDischargeResult/Progress contracts and IPC handler registration",
    tags: ["tier1", "cli", "rust", "battery"],
    run: async (ctx) => {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      for (const token of [
        "BATTERY_LOW_SOC_ABORT_PCT",
        "BATTERY_DISCHARGE_MAX_SECS",
        "BatteryDischargeProgress",
        "BatteryDischargeResult",
        "charge_drop_pct",
        "note:",
        "power_cv_pct",
        "voltage_sag_mv",
        "bms_drift_ratio",
      ]) {
        ctx.assert.ok(typesRs.includes(token), `types.rs missing Battery Discharge token "${token}"`);
      }

      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(
        libRs.includes("run_battery_discharge_test"),
        "src-tauri/src/lib.rs does not register run_battery_discharge_test IPC command"
      );
      ctx.assert.ok(
        libRs.includes("cancel_battery_discharge_test"),
        "src-tauri/src/lib.rs does not register cancel_battery_discharge_test IPC command"
      );

      const batteryRs = ctx.cli.readRepoFile("src-tauri/src/modules/battery.rs");
      ctx.assert.ok(
        batteryRs.includes("run_battery_discharge_test"),
        "src-tauri/src/modules/battery.rs does not implement run_battery_discharge_test"
      );
    },
  },

  {
    id: "T1-F11-02",
    tier: 1,
    feature: "F11",
    title: "BatteryView invokes run_battery_discharge_test and renders live battery:discharge progress",
    tags: ["tier1", "ui", "ipc", "battery"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 300 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Battery Health/i);
        await assertAndClickButton(
          ctx,
          app,
          DISCHARGE_BTN_REGEX,
          "BatteryView missing Battery Discharge Normality trigger button",
          { excludeRegex: DISCHARGE_EXCLUDE_REGEX }
        );

        await app.emitTauriEvent("battery:discharge", {
          running: true,
          phase: "Phase 2: Controlled Load",
          elapsedSecs: 30,
          durationSecs: 45,
          chargePercent: 91.0,
          voltageMv: 15780,
          watts: 24.6,
          acPlugged: false,
          voltageSagMv: 340,
          chargeDropPct: 0.8,
          note: "Power draw steady at 24.6 W",
        });

        await app.waitForText(/24\.6/, 1500);
        await app.waitForText(/\bNORMAL\b/, 5000);
        const body = await app.getBodyText();
        ctx.assert.match(body, /22\.8/, "Expected final load wattage 22.8 W in BatteryView");
        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_battery_discharge_test" && e.ok),
          "Expected run_battery_discharge_test IPC call to succeed"
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F11-03",
    tier: 1,
    feature: "F11",
    title: "BatteryView displays NORMAL verdict, idle/load watts, power CV%, voltage sag, and reasons",
    tags: ["tier1", "ui", "battery", "theme"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook, {
        batteryDischarge: {
          status: "pass",
          verdict: "NORMAL",
          idleAvgWatts: 5.4,
          loadAvgWatts: 22.8,
          powerCvPct: 4.2,
          voltageSagMv: 360,
        },
      });
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
        await app.waitForText(/NORMAL/, 5000);
        const body = await app.getBodyText();
        for (const expected of ["NORMAL", "5.4", "22.8", "4.2", "360", "discharges smoothly"]) {
          ctx.assert.ok(body.includes(expected), `Expected BatteryView discharge report to include "${expected}"`);
        }
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F11-04",
    tier: 1,
    feature: "F11",
    title: "BatteryView displays ABNORMAL verdict and diagnostic reasons on worn battery",
    tags: ["tier1", "ui", "battery", "theme"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.throttlingGamingLaptop);
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
        await app.waitForText(/ABNORMAL/, 5000);
        const body = await app.getBodyText();
        for (const expected of ["ABNORMAL", "24.0", "1180", "4.5", "unstable cell delivery"]) {
          ctx.assert.ok(body.includes(expected), `Expected ABNORMAL BatteryView output to include "${expected}"`);
        }
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F11-05",
    tier: 1,
    feature: "F11",
    title: "BatteryView handles AC_CONNECTED and missing-battery NOT_APPLICABLE states gracefully",
    tags: ["tier1", "ui", "battery"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.acPlugged);
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
        await app.waitForText(/AC[_ ]CONNECTED|cannot be measured while charging|disconnect\s*AC|unplug\s*AC(?!\s*power\b)/i, 5000);

        const desktopBattery = ctx.fixtures.desktopAcOnly().batteryHealth;
        await app.evaluate((bh) => {
          window.__TAURI_MOCK__.setFixturePatch({ batteryHealth: bh });
        }, desktopBattery);
        await app.clickButton(/^Refresh$/i);
        await app.waitForText(/No Internal Battery Detected/i, 5000);
        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_battery_discharge_test" && e.ok),
          "Expected run_battery_discharge_test IPC call to succeed"
        );
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F12 — Expanded Second-Hand Reliability Diagnostics
  // =========================================================================
  {
    id: "T1-F12-01",
    tier: 1,
    feature: "F12",
    title: "Backend NetworkDiagnosticsReport contract and run_network_diagnostics IPC registration",
    tags: ["tier1", "cli", "rust", "network"],
    run: async (ctx) => {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      for (const token of [
        "NetworkDiagnosticsReport",
        "gateway_ping_ms",
        "dns_resolve_ok",
        "packet_loss_pct",
        "verdict:",
        "plain_summary:",
      ]) {
        ctx.assert.ok(typesRs.includes(token), `types.rs missing NetworkDiagnosticsReport field "${token}"`);
      }

      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(
        libRs.includes("run_network_diagnostics"),
        "src-tauri/src/lib.rs does not register run_network_diagnostics IPC command"
      );
    },
  },

  {
    id: "T1-F12-02",
    tier: 1,
    feature: "F12",
    title: "SpecsView invokes run_network_diagnostics and renders Wi-Fi/ping/DNS/packet-loss audit",
    tags: ["tier1", "ui", "ipc", "network"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await enterPipelineFromDashboard(app);
        const netBtns = await findVisibleButtons(
          app,
          /(network.*diag|run.*network|test.*network|ping.*dns|wi-?fi.*audit)/i,
          { enabledOnly: true }
        );
        if (netBtns.length > 0) {
          await app.clickButton(/(network.*diag|run.*network|test.*network|ping.*dns|wi-?fi.*audit)/i);
        }

        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_network_diagnostics" && e.ok),
          "Expected SpecsView to invoke run_network_diagnostics IPC command"
        );
        const body = await app.getBodyText();
        ctx.assert.match(body, /LabBench-5G/, "Expected Wi-Fi SSID LabBench-5G");
        ctx.assert.match(body, /2\.4/, "Expected gateway ping 2.4 ms");
        ctx.assert.match(body, /0(?:\.0)?%/, "Expected 0% packet loss");
        ctx.assert.match(body, /Strong Wi-Fi 6E signal/i, "Expected plainSummary network finding");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F12-03",
    tier: 1,
    feature: "F12",
    title: "SecurityAuditView executes run_security_audit and displays MDM, BitLocker, TPM 2.0, Secure Boot & License",
    tags: ["tier1", "ui", "security", "theme"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Security, Activation Lock|MDM \/ Autopilot Enrollment/i);
        const body = await app.getBodyText();
        for (const label of [
          "MDM / Autopilot Enrollment",
          "BitLocker Status",
          "TPM 2.0",
          "Secure Boot",
          "OS Activation",
          "No MDM lock, no activation lock, TPM 2.0 & Secure Boot clean.",
        ]) {
          ctx.assert.ok(body.includes(label), `SecurityAuditView missing "${label}"`);
        }
        await app.clickButton(/Re-run Audit/i);
        await app.waitForText(/MDM \/ Autopilot Enrollment/i, 5000);
        const invokeLog = await assertCleanSession(ctx, app);
        const calls = invokeLog.filter((e) => e.cmd === "run_security_audit" && e.ok);
        ctx.assert.ok(calls.length >= 2, `Expected >= 2 run_security_audit calls after Re-run Audit, got ${calls.length}`);
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F12-04",
    tier: 1,
    feature: "F12",
    title: "ErrorLogsView runs scan_error_logs and filters hardware WHEA crashes vs system logs",
    tags: ["tier1", "ui", "logs"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook, {
        errorLogs: {
          status: "warn",
          daysScanned: 30,
          criticalCount: 1,
          errorCount: 2,
          bsodOrPanicCount: 0,
          wheaOrHwCount: 1,
          diskErrorCount: 0,
          gpuResetCount: 0,
          minidumpFiles: [],
          entries: [
            {
              timestamp: "2026-11-24T12:00:00Z",
              level: "Critical",
              category: "Hardware / WHEA",
              source: "WHEA-Logger",
              message: "Corrected hardware PCIe bus warning",
            },
            {
              timestamp: "2026-11-24T12:05:00Z",
              level: "Error",
              category: "System / App",
              source: "AppCrashService",
              message: "Background updater exited unexpectedly",
            },
          ],
          summary: "1 WHEA hardware warning and 1 system app entry.",
        },
      });
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /System Error & Crash Logs/i);
        let body = await app.getBodyText();
        ctx.assert.ok(body.includes("WHEA-Logger"), "Expected WHEA-Logger entry in ErrorLogsView");
        ctx.assert.ok(body.includes("AppCrashService"), "Expected AppCrashService entry in ErrorLogsView");

        // Toggle Hardware / Crash Only checkbox specifically by label text
        const hwChecked = await app.evaluate(() => {
          const labels = Array.from(document.querySelectorAll("main label"));
          const hwLabel = labels.find((l) => /Hardware\s*\/\s*Crash Only/i.test(l.textContent || ""));
          const cb = hwLabel?.querySelector('input[type="checkbox"]');
          if (!cb) return false;
          cb.click();
          return cb.checked;
        });
        ctx.assert.equal(hwChecked, true, "Expected Hardware / Crash Only checkbox to be found and checked");
        await app.waitForText(/WHEA-Logger/, 3000);
        body = await app.getBodyText();
        ctx.assert.ok(body.includes("WHEA-Logger"), "Expected WHEA-Logger to remain when Hardware Only is checked");
        ctx.assert.equal(body.includes("AppCrashService"), false, "Expected System / App entry to be filtered out");

        await app.fillInput("Filter source, ID, or message...", "PCIe bus");
        body = await app.getBodyText();
        ctx.assert.ok(body.includes("WHEA-Logger"), "Expected text filter to keep matching WHEA row");

        await app.clickButton(/Re-scan Logs/i);
        const invokeLog = await assertCleanSession(ctx, app);
        const scans = invokeLog.filter((e) => e.cmd === "scan_error_logs" && e.ok);
        ctx.assert.ok(scans.length >= 2, `Expected >= 2 scan_error_logs calls, got ${scans.length}`);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F12-05",
    tier: 1,
    feature: "F12",
    title: "StorageView DriveDx SMART audit and PortsSpeakersView USB SuperSpeed live monitor",
    tags: ["tier1", "ui", "storage", "usb"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /SSD SMART Health/i);
        const storageBody = await app.getBodyText();
        for (const token of [
          "Samsung PM9A1 NVMe 512GB",
          "98%",
          "2%",
          "39°C",
          "410h",
          "DriveDx NVMe Log 0x02 clean",
        ]) {
          ctx.assert.ok(storageBody.includes(token), `StorageView missing SMART token "${token}"`);
        }

        await skipOrAdvanceTo(ctx, app, /Live USB4\/3\.x Speed Detector/i);
        await app.waitForText(/SanDisk Ultra Fit USB 3\.2 Gen 1/i, 5000);
        const portsBody = await app.getBodyText();
        ctx.assert.ok(
          portsBody.includes("USB 3.2 Gen 1 SuperSpeed (5 Gbps)"),
          "Expected negotiated SuperSpeed USB speed class"
        );

        await app.emitTauriEvent("usb:event", {
          eventKind: "CONNECTED",
          timestamp: "2026-11-25T19:15:00Z",
          device: {
            instanceId: "USB\\VID_0951&PID_1666\\LIVEHOTPLUG",
            name: "Kingston DataTraveler 3.0",
            speedClass: "USB 3.2 Gen 1 SuperSpeed (5 Gbps)",
            isSuperspeed: true,
            status: "OK",
          },
          devices: [
            ...fixture.usbDevices,
            {
              instanceId: "USB\\VID_0951&PID_1666\\LIVEHOTPLUG",
              name: "Kingston DataTraveler 3.0",
              speedClass: "USB 3.2 Gen 1 SuperSpeed (5 Gbps)",
              isSuperspeed: true,
              status: "OK",
            },
          ],
        });
        await app.waitForText(/Kingston DataTraveler 3\.0/i, 5000);
        const updatedPorts = await app.getBodyText();
        ctx.assert.ok(updatedPorts.includes("CONNECTED"), "Expected live CONNECTED usb:event log entry");

        const invokeLog = await assertCleanSession(ctx, app);
        ctx.assert.ok(invokeLog.some((e) => e.cmd === "scan_storage_smart" && e.ok), "Expected scan_storage_smart IPC");
        ctx.assert.ok(invokeLog.some((e) => e.cmd === "start_usb_monitor" && e.ok), "Expected start_usb_monitor IPC");
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F13 — Pipeline & Skip-Step Integration
  // =========================================================================
  {
    id: "T1-F13-01",
    tier: 1,
    feature: "F13",
    title: "Touchscreen stage is positioned directly after Display in STEP_ORDER, Sidebar, and Dashboard",
    tags: ["tier1", "ui", "pipeline"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.length >= 14,
          `Expected >= 14 pipeline steps in Sidebar (including Touchscreen), found ${navButtons.length}`
        );
        const displayIdx = navButtons.findIndex((b) => /Display Fullscreen/i.test(b.text));
        ctx.assert.ok(displayIdx >= 0, "Could not find Display Fullscreen step in Sidebar");
        ctx.assert.match(
          navButtons[displayIdx + 1]?.text || "",
          /Touchscreen/i,
          `Expected Touchscreen directly after Display Fullscreen, found "${navButtons[displayIdx + 1]?.text || ""}"`
        );

        const rowTexts = await app.evaluate(() =>
          Array.from(document.querySelectorAll("tbody tr")).map((tr) =>
            (tr.innerText || "").replace(/\s+/g, " ").trim()
          )
        );
        ctx.assert.ok(rowTexts.length >= 14, `Expected >= 14 Dashboard ledger rows, found ${rowTexts.length}`);
        ctx.assert.match(
          rowTexts[displayIdx + 1] || "",
          /Touchscreen/i,
          `Expected Dashboard row ${displayIdx + 2} to be Touchscreen`
        );
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F13-02",
    tier: 1,
    feature: "F13",
    title: "Sequential lock keeps steps 2..N disabled and Certificate locked on initial boot",
    tags: ["tier1", "ui", "pipeline"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(navButtons.length >= 13, `Expected >= 13 sidebar step buttons, found ${navButtons.length}`);
        ctx.assert.equal(navButtons[0].disabled, false, "Step 01 (All-Hardware Specs) should be unlocked on boot");
        for (let i = 1; i < navButtons.length; i += 1) {
          ctx.assert.equal(
            navButtons[i].disabled,
            true,
            `Step ${i + 1} (${navButtons[i].text}) must be locked on initial boot`
          );
        }

        await ctx.assert.rejects(
          () => app.clickStep(/Lock, MDM/i),
          /locked|disabled/i,
          "Clicking locked Step 02 must be rejected"
        );

        const asideButtons = await app.querySelectorAllInfo("aside button");
        const certBtn = asideButtons.find((b) => /Locked \(\d+\/\d+\)|Issue QC Certificate/i.test(b.text));
        ctx.assert.ok(certBtn, "Sidebar Certificate button not found");
        ctx.assert.equal(certBtn.disabled, true, "Certificate button must be disabled on boot");
        ctx.assert.match(certBtn.text, /Locked \(\d+\/\d+\)/i, "Certificate button must show Locked (x/N)");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F13-03",
    tier: 1,
    feature: "F13",
    title: "Sequential progression unlocks next step via Next: Stage and Skip Step (SKIP badge)",
    tags: ["tier1", "ui", "pipeline"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await enterPipelineFromDashboard(app);
        await assertAndClickButton(ctx, app, /^Next:\s*Stage 02$/i, "Expected enabled Next: Stage 02 button on Specs");
        await app.waitForText(/Lock, MDM & License Audit/i, 5000);

        let navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.equal(navButtons[1].disabled, false, "Stage 02 must be unlocked after advancing from Stage 01");
        ctx.assert.equal(navButtons[2].disabled, true, "Stage 03 (Battery) must remain locked while on Stage 02");

        await assertAndClickButton(ctx, app, /^Next:\s*Stage 03$/i, "Expected enabled Next: Stage 03 button on Security");
        await app.waitForText(/Battery Health/i, 5000);

        const skipBtns = await findVisibleButtons(app, /^Skip Step$/i, { enabledOnly: true });
        ctx.assert.ok(skipBtns.length > 0, "Expected enabled Skip Step button on pending Battery stage");
        const nextStage4 = await findVisibleButtons(app, /^Next:\s*Stage 04$/i, { enabledOnly: false });
        ctx.assert.ok(nextStage4.length > 0 && nextStage4[0].disabled, "Next: Stage 04 must be disabled until Battery verdict or skip");

        await app.clickButton(/^Skip Step$/i);
        await app.waitForText(/System Error & Crash Logs/i, 5000);

        navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.match(navButtons[2].text, /SKIP/i, "Skipped Battery stage must display SKIP badge in Sidebar");
        ctx.assert.equal(navButtons[3].disabled, false, "Stage 04 (Logs) must unlock after skipping Stage 03");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F13-04",
    tier: 1,
    feature: "F13",
    title: "Explicit Skip Step works across every interactive stage including Touchscreen",
    tags: ["tier1", "ui", "pipeline"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.nonTouchCorporate);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Expected Touchscreen stage in Sidebar STEP_ORDER for explicit Skip Step audit"
        );

        await enterPipelineFromDashboard(app);
        const skippedHeadings = [];
        for (let step = 0; step < 18; step += 1) {
          const modalOpen = (await findVisibleButtons(app, /^Issue Official QC Certificate$/i)).length > 0;
          if (modalOpen) break;

          const skipBtns = await findVisibleButtons(app, /^Skip Step$/i, { enabledOnly: true });
          if (skipBtns.length > 0) {
            const h1 = await app.evaluate(() => document.querySelector("main h1")?.innerText || "");
            skippedHeadings.push(h1);
            await app.clickButton(/^Skip Step$/i);
            continue;
          }
          const nextBtns = await findVisibleButtons(app, /^Next:\s*Stage/i, { enabledOnly: true });
          if (nextBtns.length > 0) {
            await app.clickButton(/^Next:\s*Stage/i);
            continue;
          }
          break;
        }

        ctx.assert.ok(
          skippedHeadings.some((h) => /Touchscreen/i.test(h)),
          `Expected Touchscreen stage to have explicit Skip Step; skipped headings were: ${JSON.stringify(skippedHeadings)}`
        );
        ctx.assert.ok(
          skippedHeadings.length >= 10,
          `Expected >= 10 interactive stages skipped via Skip Step, got ${skippedHeadings.length}`
        );
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F13-05",
    tier: 1,
    feature: "F13",
    title: "Certificate button remains locked through N-1 stages and unlocks only when final stage completes",
    tags: ["tier1", "ui", "pipeline"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Live USB4\/3\.x Speed Detector/i);

        let asideButtons = await app.querySelectorAllInfo("aside button");
        const lockedCert = asideButtons.find((b) => /Locked \(\d+\/\d+\)|Issue QC Certificate/i.test(b.text));
        ctx.assert.ok(lockedCert, "Sidebar Certificate button not found on final stage before verdict");
        ctx.assert.equal(lockedCert.disabled, true, "Certificate button must stay locked until final stage verdict");

        await app.clickButton(/Pass Ports & Speakers/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);

        asideButtons = await app.querySelectorAllInfo("aside button");
        const unlockedCert = asideButtons.find((b) => /Issue QC Certificate/i.test(b.text));
        ctx.assert.ok(unlockedCert && !unlockedCert.disabled, "Sidebar Issue QC Certificate button must be enabled");

        // Also verify Dashboard Certificate button is unlocked
        await app.clickStep(/Inspection Manifest/i);
        await app.waitForText(/HARDWARE INSPECTION MANIFEST/i, 5000);
        const dashCert = await findVisibleButtons(app, /^Certificate$/i, { enabledOnly: true });
        ctx.assert.ok(dashCert.length > 0, "Dashboard Certificate button must be enabled once all steps complete");

        await app.clickButton(/Issue QC Certificate/i);
        await app.waitForText(/Issue Branded Hardware Certificate/i, 5000);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F14 — Interactive Touchscreen Display Test
  // =========================================================================
  {
    id: "T1-F14-01",
    tier: 1,
    feature: "F14",
    title: "TouchscreenTestView renders 16x10 interactive grid (160 cells) and touch capability status",
    tags: ["tier1", "ui", "touchscreen"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Touchscreen stage missing from Sidebar STEP_ORDER"
        );
        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);
        const body = await app.getBodyText();
        ctx.assert.match(body, /16\s*[×x]\s*10|160/, "Expected 16x10 / 160 grid dimensions in TouchscreenTestView");
        ctx.assert.match(
          body,
          /(?:10[\s-]*(?:touch|point|contact)|(?:max\s*touch\s*points|maxTouchPoints|multi-?touch).{0,12}10)/i,
          "Expected 10-point touch capability display"
        );
        const skipBtns = await findVisibleButtons(app, /^Skip Step$/i, { enabledOnly: true });
        ctx.assert.ok(skipBtns.length > 0, "Expected explicit Skip Step button on TouchscreenTestView");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F14-02",
    tier: 1,
    feature: "F14",
    title: "Touch grid coverage increments live via dispatchTouchGesture",
    tags: ["tier1", "ui", "touchscreen", "cdp"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Touchscreen stage missing from Sidebar STEP_ORDER"
        );
        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);

        const rect = await findTouchSurface(app);
        ctx.assert.ok(rect, "Could not locate Touchscreen interactive grid/surface element");

        await app.dispatchTouchGesture([
          { x: rect.left + rect.width * 0.15, y: rect.top + rect.height * 0.2 },
          { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.4 },
          { x: rect.left + rect.width * 0.65, y: rect.top + rect.height * 0.6 },
          { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.8 },
        ]);

        const body = await app.getBodyText();
        const match = body.match(/(\d+)\s*\/\s*160/);
        ctx.assert.ok(match && Number(match[1]) >= 3, `Expected >= 3/160 covered cells after gesture, got ${match?.[0]}`);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F14-03",
    tier: 1,
    feature: "F14",
    title: "Multi-touch pointerId tracking records simultaneous contacts via dispatchMultiTouch",
    tags: ["tier1", "ui", "touchscreen", "cdp"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Touchscreen stage missing from Sidebar STEP_ORDER"
        );
        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);

        const rect = await findTouchSurface(app);
        ctx.assert.ok(rect, "Could not locate Touchscreen interactive grid/surface element");

        await app.dispatchMultiTouch([
          {
            id: 0,
            points: [
              { x: rect.left + rect.width * 0.2, y: rect.top + rect.height * 0.3 },
              { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.5 },
            ],
          },
          {
            id: 1,
            points: [
              { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.3 },
              { x: rect.left + rect.width * 0.55, y: rect.top + rect.height * 0.5 },
            ],
          },
          {
            id: 2,
            points: [
              { x: rect.left + rect.width * 0.8, y: rect.top + rect.height * 0.3 },
              { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.5 },
            ],
          },
        ]);

        const body = await app.getBodyText();
        ctx.assert.match(
          body,
          /Multi-Touch Peak[\s\r\n]+(?:[2-9]|10)\s*\/\s*10\s*Points/i,
          "Expected Multi-Touch Peak tile to record >= 2 / 10 Points in TouchscreenTestView"
        );
        ctx.assert.match(
          body,
          /Multi-Touch:\s*(?:[2-9]|10)-pt/i,
          "Expected Multi-Touch verdict summary to record >= 2-pt in TouchscreenTestView"
        );
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F14-04",
    tier: 1,
    feature: "F14",
    title: "Touchscreen swipe linearity RMS, touch polling Hz, and PASS verdict recording",
    tags: ["tier1", "ui", "touchscreen", "cdp"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Touchscreen stage missing from Sidebar STEP_ORDER"
        );
        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);

        const rect = await findTouchSurface(app);
        ctx.assert.ok(rect, "Could not locate Touchscreen interactive grid/surface element");

        const swipePoints = Array.from({ length: 10 }, (_, i) => ({
          x: rect.left + rect.width * (0.1 + i * 0.08),
          y: rect.top + rect.height * (0.15 + i * 0.07),
        }));
        await app.dispatchTouchGesture(swipePoints);

        const body = await app.getBodyText();
        const hzMatch = body.match(/Touch Polling Rate[\s\r\n]+([1-9]\d*(?:\.\d+)?)\s*Hz/i);
        ctx.assert.ok(
          hzMatch && Number(hzMatch[1]) > 0,
          `Expected non-zero Touch Polling Rate (Hz) in dynamic tile, got: ${hzMatch?.[0] ?? "none"}`
        );
        ctx.assert.match(
          body,
          /Swipe Linearity RMS[\s\r\n]+\d+(?:\.\d+)?\s*px/i,
          "Expected Swipe Linearity RMS (px) in dynamic tile"
        );

        await assertAndClickButton(
          ctx,
          app,
          /(Pass.*Touch|Confirm PASS)/i,
          "Expected Pass Touchscreen verdict button"
        );
        await app.waitForText(/RECORDED \[pass\]/i, 5000);
        const nextBtns = await findVisibleButtons(app, /^Next:\s*Stage/i, { enabledOnly: true });
        ctx.assert.ok(nextBtns.length > 0, "Expected Next: Stage button enabled after Touchscreen PASS");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F14-05",
    tier: 1,
    feature: "F14",
    title: "Non-touch laptop (maxTouchPoints=0) displays non-touch notice and 1-click Skip Step",
    tags: ["tier1", "ui", "touchscreen"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.nonTouchCorporate);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        const touchPts = await app.evaluate(() => navigator.maxTouchPoints);
        ctx.assert.equal(touchPts, 0, "Expected navigator.maxTouchPoints === 0 for nonTouchCorporate");

        const navButtons = await app.querySelectorAllInfo("aside nav button");
        ctx.assert.ok(
          navButtons.some((b) => /Touchscreen/i.test(b.text)),
          "Touchscreen stage missing from Sidebar STEP_ORDER"
        );
        await skipOrAdvanceTo(ctx, app, /Touchscreen & Multi-Touch Digitizer Test/i);

        const body = await app.getBodyText();
        ctx.assert.match(
          body,
          /(non-touch|no touch|0 touch|not equipped)/i,
          "Expected non-touch hardware notice on TouchscreenTestView"
        );

        await assertAndClickButton(ctx, app, /^Skip Step$/i, "Expected 1-click Skip Step button on non-touch laptop");
        await app.waitForText(/Keyboard & Touchpad Dead-Zone Audit/i, 5000);

        const updatedNav = await app.querySelectorAllInfo("aside nav button");
        const touchStep = updatedNav.find((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchStep && /SKIP/i.test(touchStep.text), "Touchscreen step should show SKIP badge after skipping");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F15 — Expanded MonitorTest Display Suite + Unobstructed Fullscreen Portal
  // =========================================================================
  {
    id: "T1-F15-01",
    tier: 1,
    feature: "F15",
    title: "Expanded MonitorTest suite includes Moire, persistence/burn-in, and power-supply zooming patterns",
    tags: ["tier1", "ui", "display"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Display Check/i);
        const body = await app.getBodyText();
        const tileButtons = await findVisibleButtons(app, /Pattern #/i);
        ctx.assert.ok(
          tileButtons.length >= 22,
          `Expected >= 22 MonitorTest patterns (including Moire, Persistence/Burn-In, Power-Supply Zoom), found ${tileButtons.length}`
        );

        ctx.assert.match(body, /moir[eé]/i, "Expected Moire interference pattern in DisplayTestView");
        ctx.assert.match(body, /persistence|burn-?in/i, "Expected Persistence / Burn-In pattern in DisplayTestView");
        ctx.assert.match(body, /power[- ]?supply|zoom/i, "Expected Power-Supply / Zooming pattern in DisplayTestView");
        for (const core of ["Pure Black", "256-Step", "Gamma", "1px Pixel-Walk", "Sharpness", "Motion Clarity"]) {
          ctx.assert.ok(body.includes(core), `Expected core MonitorTest pattern "${core}"`);
        }
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F15-02",
    tier: 1,
    feature: "F15",
    title: "Unobstructed fullscreen portal uses fixed z-index 999999 100vw x 100vh and Tauri window IPC",
    tags: ["tier1", "ui", "display", "ipc"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        const activeWin = await app.getWindowState();
        ctx.assert.deepEqual(
          {
            fullscreen: activeWin?.fullscreen,
            decorations: activeWin?.decorations,
            alwaysOnTop: activeWin?.alwaysOnTop,
          },
          { fullscreen: true, decorations: false, alwaysOnTop: true },
          "Expected Tauri window state { fullscreen: true, decorations: false, alwaysOnTop: true }"
        );

        const portal = await app.evaluate(() => {
          const el = Array.from(document.body.children).find((child) => {
            const cs = getComputedStyle(child);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            position: cs.position,
            zIndex: cs.zIndex,
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          };
        });
        ctx.assert.ok(portal, "Expected fixed z-index 999999 portal attached to document.body");
        ctx.assert.equal(portal.left, 0, "Fullscreen portal must start at left=0");
        ctx.assert.equal(portal.top, 0, "Fullscreen portal must start at top=0");
        ctx.assert.ok(portal.width >= 1360, `Expected portal width >= 1360, got ${portal.width}`);
        ctx.assert.ok(portal.height >= 880, `Expected portal height >= 880, got ${portal.height}`);

        await app.pressKey("Escape");
        const restoredWin = await app.getWindowState();
        ctx.assert.deepEqual(
          {
            fullscreen: restoredWin?.fullscreen,
            decorations: restoredWin?.decorations,
            alwaysOnTop: restoredWin?.alwaysOnTop,
          },
          { fullscreen: false, decorations: true, alwaysOnTop: false },
          "Expected Escape to restore window state { fullscreen: false, decorations: true, alwaysOnTop: false }"
        );
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F15-03",
    tier: 1,
    feature: "F15",
    title: "Floating HUD remains hidden (opacity 0, pointer-events none) until bottom hover or H key",
    tags: ["tier1", "ui", "display"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        const getHudStyle = () =>
          app.evaluate(() => {
            const portal = Array.from(document.body.children).find((child) => {
              const cs = getComputedStyle(child);
              return cs.position === "fixed" && cs.zIndex === "999999";
            });
            if (!portal) return null;
            const exitBtn = Array.from(portal.querySelectorAll("button")).find(
              (b) => (b.innerText || "").trim() === "Exit"
            );
            const hud = exitBtn?.parentElement;
            if (!hud) return null;
            const cs = getComputedStyle(hud);
            return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
          });

        const waitHudOpacity = async (expectedOpacity, timeoutMs = 1000) => {
          const deadline = Date.now() + timeoutMs;
          let latest = await getHudStyle();
          while (Date.now() < deadline) {
            if (latest && latest.opacity === expectedOpacity) return latest;
            await new Promise((r) => setTimeout(r, 40));
            latest = await getHudStyle();
          }
          return latest;
        };

        let hud = await getHudStyle();
        ctx.assert.ok(hud, "HUD element inside fullscreen portal not found");
        ctx.assert.equal(hud.opacity, "0", "HUD must be hidden (opacity: 0) initially");
        ctx.assert.equal(hud.pointerEvents, "none", "HUD must have pointer-events: none when hidden");

        await app.hoverAt(680, 860);
        hud = await waitHudOpacity("1", 1000);
        ctx.assert.equal(hud.opacity, "1", "HUD must become visible (opacity: 1) on bottom-edge hover");
        ctx.assert.equal(hud.pointerEvents, "auto", "HUD must have pointer-events: auto when visible");

        await app.hoverAt(680, 200);
        hud = await waitHudOpacity("0", 1000);
        ctx.assert.equal(hud.opacity, "0", "HUD must hide again when cursor leaves bottom edge");

        await app.pressKey("h");
        hud = await waitHudOpacity("1", 1000);
        ctx.assert.equal(hud.opacity, "1", "Pressing H must pin HUD visible (opacity: 1)");

        await app.pressKey("Escape");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F15-04",
    tier: 1,
    feature: "F15",
    title: "Fullscreen keyboard navigation (ArrowRight/Space/ArrowLeft) and Escape + right-click exit",
    tags: ["tier1", "ui", "display"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        await app.pressKey("ArrowRight");
        await app.pressKey("Space");
        await app.pressKey("ArrowLeft");
        await app.pressKey("h");

        const hudText = await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((child) => {
            const cs = getComputedStyle(child);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          return portal ? portal.innerText : "";
        });
        ctx.assert.match(hudText, /\[2\//, `Expected pattern index [2/...] after ArrowRight+Space+ArrowLeft, got "${hudText}"`);

        await app.pressKey("Escape");
        await app.waitForText(/Launch True Fullscreen Test \(3\//i, 5000);

        // Re-launch and test right-click (contextmenu) exit
        await app.clickButton(/Launch True Fullscreen Test/i);
        await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((child) => {
            const cs = getComputedStyle(child);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          if (portal) {
            portal.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
          }
        });
        await app.waitForText(/Display Check/i, 5000);
        const portalAfter = await app.evaluate(() =>
          Array.from(document.body.children).some((child) => {
            const cs = getComputedStyle(child);
            return cs.position === "fixed" && cs.zIndex === "999999";
          })
        );
        ctx.assert.equal(portalAfter, false, "Right-click contextmenu must close fullscreen portal");
        const winAfter = await app.getWindowState();
        ctx.assert.equal(winAfter?.fullscreen, false, "Right-click exit must restore fullscreen: false");
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T1-F15-05",
    tier: 1,
    feature: "F15",
    title: "Display verdict buttons (Pass/WARN/Fail), notes persistence, and Swiss palette compliance",
    tags: ["tier1", "ui", "display", "theme"],
    run: async (ctx) => {
      const fixture = syncedFixture(ctx.fixtures.healthyUltrabook);
      const app = await openReadyApp(ctx, fixture, { mockOptions: { stepDelayMs: 0 } });
      try {
        await skipOrAdvanceTo(ctx, app, /Display Check/i);
        await app.fillInput("Optional panel notes", "0 dead pixels, clean uniformity");

        await app.clickButton(/Mark Minor Issue \(WARN\)/i);
        await app.waitForText(/RECORDED \[warn\]/i, 5000);
        let nextBtns = await findVisibleButtons(app, /^Next:\s*Stage 07$/i, { enabledOnly: true });
        ctx.assert.ok(nextBtns.length > 0, "Next: Stage 07 must enable after WARN verdict");

        await app.clickButton(/Fail Display Check/i);
        await app.waitForText(/RECORDED \[fail\]/i, 5000);

        await app.clickButton(/Pass Display Check/i);
        await app.waitForText(/RECORDED \[pass\]/i, 5000);

        const noteVal = await app.evaluate(() => {
          const inp = document.querySelector('input[placeholder*="panel notes"]');
          return inp ? inp.value : "";
        });
        ctx.assert.equal(noteVal, "0 dead pixels, clean uniformity", "Panel notes input must persist across verdict clicks");

        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);

        nextBtns = await findVisibleButtons(app, /^Next:\s*Stage 07$/i, { enabledOnly: true });
        ctx.assert.ok(nextBtns.length > 0, "Next: Stage 07 must remain enabled after Pass Display Check");
        await app.clickButton(/^Next:\s*Stage 07$/i);
        await assertCleanSession(ctx, app);
      } finally {
        await app.close();
      }
    },
  },
];
