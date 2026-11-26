function syncBatteryDischarge(override = {}) {
  return {
    status: "pass",
    ...override,
  };
}

function syncNetworkDiagnostics(override = {}) {
  return {
    status: "pass",
    ...override,
  };
}

function syncUserBenchmark(override = {}) {
  return {
    sourceMode: "offline_calibrated",
    ...override,
  };
}

function withUnlockedStage(fixture, targetIndex, extraModules = {}) {
  const stepIds = [
    "specs",
    "security",
    "battery",
    "logs",
    "storage",
    "display",
    "touchscreen",
    "keyboard",
    "biometrics",
    "media",
    "ram",
    "performance",
    "gpu",
    "ports_speakers",
  ];
  const modules = {};
  for (let i = 0; i < targetIndex && i < stepIds.length; i += 1) {
    modules[stepIds[i]] = {
      id: stepIds[i],
      stepNumber: i + 1,
      name: stepIds[i],
      category: "System",
      status: "pass",
      summary: "Pre-completed in session",
      notes: "",
    };
  }
  Object.assign(modules, extraModules);
  return {
    ...fixture,
    savedSession: {
      serialNumber: fixture.specs.serialNumber,
      model: `${fixture.specs.manufacturer} ${fixture.specs.model}`.trim(),
      savedAt: "2026-11-25T18:00:00Z",
      activeStressStage: null,
      stateJson: JSON.stringify({
        unlockedIndex: targetIndex,
        modules,
        signoff: {
          portsChecked: false,
          portsNotes: "",
          speakersChecked: false,
          speakersNotes: "",
        },
      }),
    },
  };
}

async function navigateFromStage00ToBattery(app) {
  await app.waitForText("STAGE 00", 6000);
  await app.clickButton(/Begin Stage 01/i);
  await app.waitForText(/Hardware Specifications/i, 4000);
  await app.clickButton(/Next: Stage 02/i);
  await app.waitForText(/Lock, MDM/i, 4000);
  await app.clickButton(/Next: Stage 03/i);
  await app.waitForText(/Battery/i, 4000);
}

async function resumeAndOpenStep(app, stepRegex, headingRegex) {
  await app.waitForText("STAGE 00", 6000);
  await app.clickButton("Resume Session");
  await app.clickStep(stepRegex);
  if (headingRegex) {
    await app.waitForText(headingRegex, 4000);
  }
}

async function clickMainButton(app, regex) {
  const res = await app.evaluate(
    (source, flags) => {
      const rx = new RegExp(source, flags);
      const buttons = Array.from(document.querySelectorAll("main button"));
      const matches = [];
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        const visible =
          rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
        const label = (
          btn.innerText ||
          btn.textContent ||
          btn.getAttribute("aria-label") ||
          btn.getAttribute("title") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (visible && rx.test(label)) {
          matches.push({ btn, disabled: Boolean(btn.disabled), text: label });
        }
      }
      const target = matches.find((x) => !x.disabled) || matches[0];
      if (!target) return { found: false };
      if (target.disabled) return { found: true, disabled: true, text: target.text };
      target.btn.scrollIntoView({ block: "center", inline: "center" });
      target.btn.click();
      return { found: true, disabled: false, text: target.text };
    },
    regex.source,
    regex.flags
  );
  if (!res.found) {
    throw new Error(`clickMainButton: no visible button in <main> matching ${String(regex)}`);
  }
  if (res.disabled) {
    throw new Error(`clickMainButton: matched button "${res.text}" in <main> is disabled`);
  }
  return res.text;
}

async function waitForHudState(app, expectedOpacity, expectedPointerEvents, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await app.evaluate(() => {
      const portal = Array.from(document.body.children).find((el) => {
        const cs = getComputedStyle(el);
        return cs.position === "fixed" && cs.zIndex === "999999";
      });
      if (!portal) return { found: false };
      const exitBtn = Array.from(portal.querySelectorAll("button")).find((b) =>
        (b.innerText || "").includes("Exit")
      );
      const hud = exitBtn?.parentElement;
      if (!hud) return { found: false };
      const cs = getComputedStyle(hud);
      return {
        found: true,
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        text: (hud.innerText || "").replace(/\s+/g, " ").trim(),
      };
    });
    if (
      last?.found &&
      last.opacity === expectedOpacity &&
      last.pointerEvents === expectedPointerEvents
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return last;
}

export const tests = [
  // =========================================================================
  // F11 — Battery Discharge Normality Boundaries
  // =========================================================================
  {
    id: "T2-F11-01",
    tier: 2,
    feature: "F11",
    title: "Boundary <=15% starting SoC aborts Battery Discharge Normality safely (ABORTED_LOW_BATTERY)",
    tags: ["tier2", "boundary", "battery", "safety"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      ctx.assert.match(
        typesRs,
        /BATTERY_LOW_SOC_ABORT_PCT\s*:\s*f64\s*=\s*15\.0/,
        "Expected BATTERY_LOW_SOC_ABORT_PCT: f64 = 15.0 in src-tauri/src/types.rs"
      );

      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseLow = ctx.fixtures.lowBattery();
      const fixture = {
        ...baseLow,
        batteryHealth: { ...baseLow.batteryHealth, currentChargePercent: 15.0 },
        telemetry: { ...baseLow.telemetry, batteryPercent: 15.0 },
        batteryDischarge: syncBatteryDischarge({
          ...baseLow.batteryDischarge,
          status: "warn",
          verdict: "ABORTED_LOW_BATTERY",
          socStartPct: 15.0,
          socEndPct: 15.0,
          plainSummary:
            "Discharge test aborted safely: starting charge (15.0%) is at or below the 15% hardware safety floor.",
          reasons: ["Starting SoC 15.0% <= 15.0% safety threshold."],
        }),
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await navigateFromStage00ToBattery(app);
        const buttons = await app.queryAll("button");
        const dischargeBtn = buttons.find((b) =>
          /Discharge.*Normality|Run.*Discharge/i.test(b.text)
        );
        ctx.assert.ok(
          dischargeBtn,
          "Expected Battery Discharge Normality trigger button in BatteryView"
        );
        await app.clickButton(/Discharge.*Normality|Run.*Discharge/i);
        await app.waitForText(/ABORTED_LOW_BATTERY|15(\.0)?%|safety floor/i, 4000);

        const log = await app.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "run_battery_discharge_test"),
          "Expected run_battery_discharge_test IPC invocation"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F11-02",
    tier: 2,
    feature: "F11",
    title: "AC-only workstation with missing battery reports NOT_APPLICABLE gracefully",
    tags: ["tier2", "boundary", "battery", "ac-only"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseDesktop = ctx.fixtures.desktopAcOnly();
      const fixture = {
        ...baseDesktop,
        batteryDischarge: syncBatteryDischarge({
          ...baseDesktop.batteryDischarge,
          status: "notApplicable",
          verdict: "NOT_APPLICABLE",
          plainSummary:
            "No battery present on this AC-only workstation; discharge normality test is not applicable.",
          reasons: ["System reports no internal battery."],
        }),
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await navigateFromStage00ToBattery(app);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("No Internal Battery Detected"),
          "Expected 'No Internal Battery Detected' banner on AC-only workstation"
        );
        ctx.assert.match(
          body,
          /NOT_APPLICABLE|discharge normality.*not applicable|not applicable.*discharge/i,
          "Expected Battery Discharge Normality NOT_APPLICABLE status/notice in BatteryView"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F11-03",
    tier: 2,
    feature: "F11",
    title: "AC charger connected prompts technician with AC_CONNECTED before discharge",
    tags: ["tier2", "boundary", "battery", "ac-connected"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseAc = ctx.fixtures.acPlugged();
      const fixture = {
        ...baseAc,
        batteryDischarge: syncBatteryDischarge({
          ...baseAc.batteryDischarge,
          status: "warn",
          verdict: "AC_CONNECTED",
          plainSummary:
            "AC power adapter is currently plugged in; unplug AC charger to run the Battery Discharge Normality test.",
          reasons: ["acPlugged=true; true battery discharge cannot be measured while charging on AC."],
        }),
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await navigateFromStage00ToBattery(app);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("AC CHARGING"), "Expected AC CHARGING live indicator");

        const buttons = await app.queryAll("button");
        const dischargeBtn = buttons.find((b) =>
          /Discharge.*Normality|Run.*Discharge/i.test(b.text)
        );
        ctx.assert.ok(
          dischargeBtn,
          "Expected Battery Discharge Normality trigger button in BatteryView"
        );
        await app.clickButton(/Discharge.*Normality|Run.*Discharge/i);
        await app.waitForText(/AC_CONNECTED|unplug AC/i, 4000);

        const log = await app.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "run_battery_discharge_test"),
          "Expected run_battery_discharge_test IPC invocation"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F11-04",
    tier: 2,
    feature: "F11",
    title: "ABNORMAL discharge flags SoC cliff (>=3%/5s), high power CV%, and battery wear",
    tags: ["tier2", "boundary", "battery", "abnormal"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseHot = ctx.fixtures.throttlingGamingLaptop();
      const fixture = {
        ...baseHot,
        batteryDischarge: syncBatteryDischarge({
          ...baseHot.batteryDischarge,
          status: "fail",
          verdict: "ABNORMAL",
          maxStepDropPct: 4.5,
          powerCvPct: 24.0,
          wearPct: 46.0,
        }),
        progressEvents: {
          ...baseHot.progressEvents,
          "battery:discharge": [
            {
              running: true,
              phase: "Phase 2: Controlled Load",
              elapsedSecs: 30,
              durationSecs: 45,
              chargePercent: 57.2,
              voltageMv: 12940,
              watts: 48.5,
              avgWatts: 48.5,
              acPlugged: false,
              voltageSagMv: 1180,
              chargeDropPct: 8.8,
              maxStepDropPct: 4.5,
              verdictSoFar: "ABNORMAL",
              note: "SoC cliff 4.5%/5s detected",
            },
          ],
        },
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await navigateFromStage00ToBattery(app);
        const buttons = await app.queryAll("button");
        const dischargeBtn = buttons.find((b) =>
          /Discharge.*Normality|Run.*Discharge/i.test(b.text)
        );
        ctx.assert.ok(
          dischargeBtn,
          "Expected Battery Discharge Normality trigger button in BatteryView"
        );
        await app.clickButton(/Discharge.*Normality|Run.*Discharge/i);
        await app.waitForText(/ABNORMAL/, 4000);

        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("4.5%"), "Expected 4.5% SoC cliff metric in result");
        ctx.assert.ok(body.includes("24.0%"), "Expected 24.0% power CV metric in result");
        ctx.assert.ok(body.includes("46.0%"), "Expected 46.0% wear metric in result");
        ctx.assert.match(body, /unstable cell delivery|replacement threshold|cliff threshold/i);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F11-05",
    tier: 2,
    feature: "F11",
    title: "Discharge test enforces <=90s max bound in backend and supports mid-run cancellation",
    tags: ["tier2", "boundary", "battery", "cancel", "safety"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      ctx.assert.match(
        typesRs,
        /BATTERY_DISCHARGE_MAX_SECS\s*:\s*u64\s*=\s*90/,
        "Expected BATTERY_DISCHARGE_MAX_SECS: u64 = 90 in src-tauri/src/types.rs"
      );

      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(
        libRs.includes("run_battery_discharge_test") &&
          libRs.includes("cancel_battery_discharge_test"),
        "Expected run_battery_discharge_test and cancel_battery_discharge_test registered in src-tauri/src/lib.rs"
      );

      const batteryRs = ctx.cli.readRepoFile("src-tauri/src/modules/battery.rs");
      ctx.assert.ok(
        batteryRs.includes("BATTERY_DISCHARGE_MAX_SECS") || /\.min\(\s*90\b|clamp\([^)]*90/.test(batteryRs),
        "Expected <=90s duration clamp in src-tauri/src/modules/battery.rs"
      );

      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.healthyUltrabook();
      const fixture = {
        ...base,
        batteryHealth: {
          ...base.batteryHealth,
          acPlugged: false,
          isCharging: false,
          currentChargePercent: 92.0,
        },
        batteryDischarge: syncBatteryDischarge({
          ...base.batteryDischarge,
          status: "warn",
          verdict: "ABORTED_BY_USER",
          plainSummary: "Cancelled by technician.",
        }),
        progressEvents: {
          ...base.progressEvents,
          "battery:discharge": Array.from({ length: 6 }, (_, i) => ({
            running: true,
            phase: i < 2 ? "Phase 1: Idle" : "Phase 2: Load",
            elapsedSecs: (i + 1) * 5,
            durationSecs: 45,
            chargePercent: Number((92.0 - i * 0.2).toFixed(1)),
            voltageMv: 15900,
            watts: 18.0,
            avgWatts: 18.0,
            acPlugged: false,
            voltageSagMv: 220,
            chargeDropPct: Number((i * 0.2).toFixed(1)),
            maxStepDropPct: 0.2,
            verdictSoFar: "TRACKING",
            note: "Sampling battery telemetry",
          })),
        },
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 120 } });
      try {
        await navigateFromStage00ToBattery(app);
        const buttons = await app.queryAll("button");
        const dischargeBtn = buttons.find((b) =>
          /Discharge.*Normality|Run.*Discharge/i.test(b.text)
        );
        ctx.assert.ok(
          dischargeBtn,
          "Expected Battery Discharge Normality trigger button in BatteryView"
        );
        await app.clickButton(/Discharge.*Normality|Run.*Discharge/i);
        await app.waitForText(/Phase 1: Idle|Sampling battery telemetry/i, 3000);
        await app.clickButton(/Abort.*Discharge|Cancel.*Discharge|Abort|Stop/i);

        const log = await app.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "cancel_battery_discharge_test"),
          "Expected cancel_battery_discharge_test IPC invocation"
        );
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F12 — Second-Hand Reliability Diagnostics Boundaries
  // =========================================================================
  {
    id: "T2-F12-01",
    tier: 2,
    feature: "F12",
    title: "Offline/disconnected Wi-Fi with 100% packet loss & DNS failure in run_network_diagnostics",
    tags: ["tier2", "boundary", "network", "offline"],
    async run(ctx) {
      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(
        libRs.includes("run_network_diagnostics"),
        "Expected run_network_diagnostics command registered in src-tauri/src/lib.rs"
      );

      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const baseOffline = ctx.fixtures.offlineShopQc();
      const fixture = {
        ...baseOffline,
        networkDiagnostics: syncNetworkDiagnostics({
          ...baseOffline.networkDiagnostics,
          status: "warn",
          packetLossPct: 100.0,
          dnsResolveOk: false,
          linkSpeedMbps: 0,
          verdict: "WARN",
        }),
        userBenchmark: syncUserBenchmark(baseOffline.userBenchmark),
      };

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);

        const bodyBefore = await app.getBodyText();
        ctx.assert.ok(bodyBefore.includes("Disconnected"), "Expected Disconnected adapter state");
        ctx.assert.ok(bodyBefore.includes("0 Mbps"), "Expected 0 Mbps adapter link speed");

        const netBtn = (await app.queryAll("button")).find((b) =>
          /Network.*Diag|Run.*Network|Test.*Wi-?Fi/i.test(b.text)
        );
        if (netBtn && !netBtn.disabled) {
          await app.clickButton(/Network.*Diag|Run.*Network|Test.*Wi-?Fi/i);
        }

        const log = await app.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "run_network_diagnostics"),
          "Expected run_network_diagnostics to be invoked from SpecsView"
        );

        const bodyAfter = await app.getBodyText();
        ctx.assert.match(bodyAfter, /100(\.0)?%/, "Expected 100% packet loss displayed");
        ctx.assert.match(bodyAfter, /DNS.*fail|Offline|Disconnected/i);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F12-02",
    tier: 2,
    feature: "F12",
    title: "Corporate MDM & BitLocker lock renders Swiss black failure verdict in SecurityAuditView",
    tags: ["tier2", "boundary", "security", "mdm", "swiss"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.nonTouchCorporate();
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);
        await app.clickButton(/Next: Stage 02/i);
        await app.waitForText("Lock, MDM & License Audit", 4000);

        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("ENROLLED (Contoso Corp)"));
        ctx.assert.ok(body.includes("Encrypted (Active)"));
        ctx.assert.ok(body.includes("BitLocker volume encryption enabled."));
        ctx.assert.ok(body.includes("CRITICAL: Corporate MDM / Autopilot lock active; BitLocker enabled."));

        const bannerBg = await app.evaluate(() => {
          const divs = Array.from(document.querySelectorAll("div"));
          const banner = divs.find(
            (el) =>
              (el.innerText || "").includes("Ownership & Security Verdict") &&
              getComputedStyle(el).backgroundColor === "rgb(0, 0, 0)"
          );
          return banner ? getComputedStyle(banner).backgroundColor : null;
        });
        ctx.assert.equal(bannerBg, "rgb(0, 0, 0)", "Expected black Swiss fail banner background");

        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F12-03",
    tier: 2,
    feature: "F12",
    title: "ErrorLogsView Hardware/Crash filter, search text filter, and 60-day rescan boundary",
    tags: ["tier2", "boundary", "error-logs"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.makeBaseFixture({
        errorLogs: {
          status: "fail",
          daysScanned: 30,
          criticalCount: 1,
          errorCount: 2,
          bsodOrPanicCount: 0,
          wheaOrHwCount: 1,
          diskErrorCount: 0,
          gpuResetCount: 1,
          minidumpFiles: [],
          entries: [
            {
              timestamp: "2026-11-25 10:00:00",
              source: "Microsoft-Windows-WHEA-Logger",
              level: "Critical",
              eventId: 17,
              category: "Hardware (WHEA)",
              message: "PCIe Root Port hardware fault",
            },
            {
              timestamp: "2026-11-25 09:30:00",
              source: "nvlddmkm",
              level: "Error",
              eventId: 14,
              category: "GPU / Display Driver",
              message: "Display driver TDR reset detected",
            },
            {
              timestamp: "2026-11-25 09:00:00",
              source: "Service Control Manager",
              level: "Error",
              eventId: 7000,
              category: "System / App",
              message: "Background service failed",
            },
          ],
          summary: "1 WHEA hardware fault, 1 GPU TDR reset.",
        },
      });
      const fixture = withUnlockedStage(base, 3);

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /System Error Logs/i, "System Error & Crash Logs");

        const getTbodyText = () =>
          app.evaluate(() => document.querySelector("tbody")?.innerText || "");

        let tbody = await getTbodyText();
        ctx.assert.ok(tbody.includes("Microsoft-Windows-WHEA-Logger"));
        ctx.assert.ok(tbody.includes("nvlddmkm"));
        ctx.assert.ok(tbody.includes("Service Control Manager"));

        // Toggle "Hardware / Crash Only" checkbox
        await app.evaluate(() => {
          const lbl = Array.from(document.querySelectorAll("label")).find((l) =>
            (l.innerText || "").includes("Hardware / Crash Only")
          );
          if (!lbl) throw new Error("Missing Hardware / Crash Only label");
          lbl.click();
        });
        tbody = await getTbodyText();
        ctx.assert.equal(tbody.includes("Service Control Manager"), false);
        ctx.assert.ok(tbody.includes("Microsoft-Windows-WHEA-Logger"));
        ctx.assert.ok(tbody.includes("nvlddmkm"));

        // Filter text "WHEA" -> "TDR" -> ""
        await app.fillInput("Filter source, ID, or message...", "WHEA");
        tbody = await getTbodyText();
        ctx.assert.ok(tbody.includes("Microsoft-Windows-WHEA-Logger"));
        ctx.assert.equal(tbody.includes("nvlddmkm"), false);

        await app.fillInput("Filter source, ID, or message...", "TDR");
        tbody = await getTbodyText();
        ctx.assert.ok(tbody.includes("nvlddmkm"));
        ctx.assert.equal(tbody.includes("Microsoft-Windows-WHEA-Logger"), false);

        await app.fillInput("Filter source, ID, or message...", "");
        tbody = await getTbodyText();
        ctx.assert.ok(tbody.includes("Microsoft-Windows-WHEA-Logger"));
        ctx.assert.ok(tbody.includes("nvlddmkm"));

        // Change days <select> to 60
        await app.fillInput("select", "60");
        const log = await app.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "scan_error_logs" && e.args?.days === 60),
          "Expected scan_error_logs invoked with days === 60"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F12-04",
    tier: 2,
    feature: "F12",
    title: "PortsSpeakersView handles empty USB device list and live DISCONNECTED usb:event",
    tags: ["tier2", "boundary", "usb", "ports"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.makeBaseFixture({
        usbDevices: [],
        progressEvents: {
          "usb:event": [
            {
              eventKind: "SNAPSHOT",
              timestamp: "2026-11-25T18:45:00Z",
              device: null,
              devices: [],
            },
          ],
        },
      });
      const fixture = withUnlockedStage(base, 13);

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(
          app,
          /Ports & Speakers/i,
          "Live USB Hot-Plug & Negotiated Controller Speed Monitor"
        );

        const placeholder =
          "Plug any USB flash drive or peripheral into a port to test live speed negotiation...";
        await app.waitForText(placeholder, 3000);

        await app.emitTauriEvent("usb:event", {
          eventKind: "DISCONNECTED",
          timestamp: "2026-11-25T18:46:00Z",
          device: {
            instanceId: "USB\\VID_0781&PID_5583\\1",
            name: "SanDisk Ultra Fit",
            speedClass: "USB 3.2 Gen 1 SuperSpeed (5 Gbps)",
            isSuperspeed: true,
            status: "Disconnected",
          },
          devices: [],
        });

        await app.waitForText("DISCONNECTED", 3000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("SanDisk Ultra Fit"));
        ctx.assert.ok(body.includes(placeholder));
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F12-05",
    tier: 2,
    feature: "F12",
    title: "IPC commandErrors on auto-checks degrade gracefully with zero page errors and navigable pipeline",
    tags: ["tier2", "boundary", "error-handling", "ipc"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = ctx.fixtures.makeBaseFixture({
        commandErrors: {
          get_system_specs: "WMI timeout (simulated)",
          run_security_audit: "dsregcmd denied (simulated)",
          scan_error_logs: "EventLog unavailable (simulated)",
        },
      });

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.waitForText("Spec scan error:", 4000);
        await app.waitForText(/Warnings\s*03/i, 4000);

        ctx.assert.equal((await app.getPageErrors()).length, 0);

        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);
        await app.clickButton(/Next: Stage 02/i);
        await app.waitForText("Lock, MDM & License Audit", 4000);

        await app.clickStep("Inspection Manifest");
        await app.waitForText("Security audit error:", 4000);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F13 — Pipeline & Skip-Step Boundaries
  // =========================================================================
  {
    id: "T2-F13-01",
    tier: 2,
    feature: "F13",
    title: "Locked future sidebar buttons and dashboard rows cannot be bypassed before completing prior step",
    tags: ["tier2", "boundary", "pipeline", "lock"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);

        const navButtons = await app.queryAll("aside nav button");
        ctx.assert.ok(navButtons.length >= 13, `Expected >= 13 nav buttons, got ${navButtons.length}`);
        ctx.assert.equal(navButtons[0].disabled, false, "Step 01 should be unlocked initially");
        for (let i = 1; i < navButtons.length; i += 1) {
          ctx.assert.equal(
            navButtons[i].disabled,
            true,
            `Expected navButtons[${i}] (${navButtons[i].text}) to be disabled initially`
          );
          ctx.assert.match(navButtons[i].title, /Complete or skip Step \d+ first to unlock/);
        }

        // Click locked row in Dashboard table -> must remain on STAGE 00
        await app.evaluate(() => {
          const row = Array.from(document.querySelectorAll("tr")).find((tr) =>
            (tr.innerText || "").includes("Lock, MDM & License")
          );
          if (row) row.click();
        });
        const bodyAfterRowClick = await app.getBodyText();
        ctx.assert.ok(
          bodyAfterRowClick.includes("STAGE 00"),
          "Clicking locked dashboard row must not leave STAGE 00"
        );

        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);
        await app.clickButton(/Next: Stage 02/i);
        await app.waitForText("Lock, MDM & License Audit", 4000);

        const navAfter = await app.queryAll("aside nav button");
        ctx.assert.equal(navAfter[1].disabled, false, "Step 02 should now be unlocked");
        ctx.assert.equal(navAfter[2].disabled, true, "Step 03 should remain locked");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F13-02",
    tier: 2,
    feature: "F13",
    title: "Certificate button remains locked when 1 step is incomplete and unlocks once final step is skipped",
    tags: ["tier2", "boundary", "pipeline", "certificate"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.healthyUltrabook();
      const fixture = withUnlockedStage(base, 13);
      const parsedState = JSON.parse(fixture.savedSession.stateJson);
      delete parsedState.modules.ports_speakers;
      fixture.savedSession.stateJson = JSON.stringify(parsedState);

      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const asideButtons = await app.queryAll("aside button");
        const lockedCertBtn = asideButtons.find((b) => /Locked \(\d+\/\d+\)/i.test(b.text));
        ctx.assert.ok(lockedCertBtn, "Expected sidebar Locked (N/Total) certificate button");
        ctx.assert.equal(lockedCertBtn.disabled, true);

        const dashButtons = await app.queryAll("main button");
        ctx.assert.equal(
          dashButtons.some((b) => /^Certificate$/i.test(b.text) && !b.disabled),
          false,
          "Dashboard must not show enabled Certificate button before all steps are complete"
        );

        await app.clickStep(/Ports & Speakers/i);
        await app.waitForText("Live USB Hot-Plug & Negotiated Controller Speed Monitor", 4000);
        await app.clickButton("Skip Step");
        await app.waitForText("Issue Official QC Certificate", 4000);
        await app.clickButton("Close");

        const asideAfter = await app.queryAll("aside button");
        const unlockedCertBtn = asideAfter.find((b) => /Issue QC Certificate/i.test(b.text));
        ctx.assert.ok(unlockedCertBtn, "Expected sidebar button to read Issue QC Certificate");
        ctx.assert.equal(unlockedCertBtn.disabled, false);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F13-03",
    tier: 2,
    feature: "F13",
    title: "Skipping or advancing every stage 01..last unlocks all steps sequentially and opens certificate modal",
    tags: ["tier2", "boundary", "pipeline", "skip-step"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton(/Begin Stage 01/i);
        await app.waitForText("Complete Hardware Specifications", 4000);

        const totalSteps = (await app.queryAll("aside nav button")).length;
        ctx.assert.ok(totalSteps >= 13, `Expected >= 13 steps, got ${totalSteps}`);

        for (let stepIdx = 0; stepIdx < totalSteps; stepIdx += 1) {
          const allButtons = await app.queryAll("button");
          const skipBtn = allButtons.find((b) => /^Skip Step$/i.test(b.text) && !b.disabled);
          if (skipBtn) {
            await app.clickButton(/^Skip Step$/i);
            if (stepIdx < totalSteps - 1) {
              const navAfterSkip = await app.queryAll("aside nav button");
              ctx.assert.ok(
                navAfterSkip[stepIdx].text.includes("SKIP"),
                `Expected step ${stepIdx + 1} sidebar badge to show SKIP`
              );
            }
          } else {
            await app.clickButton(/Next: Stage|Issue QC Certificate/i);
          }
        }

        await app.waitForText("Issue Official QC Certificate", 4000);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F13-04",
    tier: 2,
    feature: "F13",
    title: "Crash-session banner Start Fresh clears session while Resume Session flags crashed stage FAIL",
    tags: ["tier2", "boundary", "session", "crash-recovery"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const crashFixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 10);
      crashFixture.savedSession.activeStressStage = "Stage 10: RAM TestMem5 Stress";

      // Session A: Start Fresh
      const appA = await ctx.browser.openApp(crashFixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await appA.waitForText(/CRITICAL: UNEXPECTED SHUTDOWN/i, 5000);
        await appA.clickButton("Start Fresh");
        const log = await appA.getInvokeLog();
        ctx.assert.ok(
          log.some((e) => e.cmd === "clear_qc_session"),
          "Expected clear_qc_session IPC call on Start Fresh"
        );
        const navA = await appA.queryAll("aside nav button");
        ctx.assert.equal(navA[1].disabled, true, "Start Fresh should keep Stage 02 locked");
        const bodyA = await appA.getBodyText();
        ctx.assert.equal(bodyA.includes("CRITICAL: UNEXPECTED SHUTDOWN"), false);
      } finally {
        await appA.close();
      }

      // Session B: Resume Session
      const appB = await ctx.browser.openApp(crashFixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await appB.waitForText(/CRITICAL: UNEXPECTED SHUTDOWN/i, 5000);
        await appB.clickButton("Resume Session");
        await appB.waitForText(/UNEXPECTED SHUTDOWN \/ CRASH DETECTED/i, 4000);

        const navB = await appB.queryAll("aside nav button");
        const ramBtn = navB.find((b) => /RAM/i.test(b.text));
        ctx.assert.ok(ramBtn, "Expected RAM step in sidebar");
        ctx.assert.equal(ramBtn.disabled, false, "Resumed session should unlock RAM stage");
        ctx.assert.ok(ramBtn.text.includes("FAIL"), "Expected crashed RAM stage to be marked FAIL");
      } finally {
        await appB.close();
      }
    },
  },

  {
    id: "T2-F13-05",
    tier: 2,
    feature: "F13",
    title: "Touchscreen stage sits right after Display Fullscreen and Skip Step advances to Keyboard & Touchpad",
    tags: ["tier2", "boundary", "pipeline", "touchscreen"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.nonTouchCorporate(), 6);
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 0,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        const displayIdx = nav.findIndex((b) => /Display Fullscreen/i.test(b.text));
        const touchIdx = nav.findIndex((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchIdx !== -1, "Expected Touchscreen step in Sidebar pipeline");
        ctx.assert.equal(
          touchIdx,
          displayIdx + 1,
          "Expected Touchscreen step immediately after Display Fullscreen"
        );

        await app.clickStep(/Touchscreen/i);
        await app.clickButton("Skip Step");
        await app.waitForText(/Keyboard & Touchpad/i, 4000);

        const navAfter = await app.queryAll("aside nav button");
        ctx.assert.ok(
          navAfter[touchIdx].text.includes("SKIP"),
          "Expected Touchscreen sidebar badge to show SKIP"
        );
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F14 — Touchscreen Display Test Boundaries
  // =========================================================================
  {
    id: "T2-F14-01",
    tier: 2,
    feature: "F14",
    title: "Non-touch laptop (maxTouchPoints === 0) displays notice and allows 1-click Skip Step",
    tags: ["tier2", "boundary", "touchscreen", "non-touch"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.nonTouchCorporate(), 6);
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 0,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        const maxPts = await app.evaluate(() => navigator.maxTouchPoints);
        ctx.assert.equal(maxPts, 0);

        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        const touchBtn = nav.find((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchBtn, "Expected Touchscreen step button in Sidebar");

        await app.clickStep(/Touchscreen/i);
        await app.waitForText(/non-touch|no touch|0 touch|not equipped|maxTouchPoints/i, 4000);
        await app.clickButton("Skip Step");
        await app.waitForText(/Keyboard & Touchpad/i, 4000);

        const navAfter = await app.queryAll("aside nav button");
        const touchAfter = navAfter.find((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchAfter?.text.includes("SKIP"));
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F14-02",
    tier: 2,
    feature: "F14",
    title: "Partial touch grid coverage (<20%) does not report 100% and records FAIL verdict",
    tags: ["tier2", "boundary", "touchscreen", "dead-zone"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.displayTouchscreenFail(), 6);
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 10,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        ctx.assert.ok(
          nav.some((b) => /Touchscreen/i.test(b.text)),
          "Expected Touchscreen step button in Sidebar"
        );
        await app.clickStep(/Touchscreen/i);

        const surface = await app.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll(
              '[data-testid="touch-grid"], [data-testid="touchscreen-surface"], main canvas, main [role="grid"], main .grid'
            )
          );
          const best = candidates
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
          if (!best || best.r.width < 40 || best.r.height < 40) return null;
          return { x: best.r.left, y: best.r.top, width: best.r.width, height: best.r.height };
        });
        ctx.assert.ok(surface, "Expected interactive touchscreen grid/surface in TouchscreenTestView");

        const rowY = Math.round(surface.y + surface.height * 0.05);
        await app.dispatchTouchGesture([
          { x: Math.round(surface.x + surface.width * 0.1), y: rowY },
          { x: Math.round(surface.x + surface.width * 0.5), y: rowY },
          { x: Math.round(surface.x + surface.width * 0.9), y: rowY },
        ]);

        const body = await app.getBodyText();
        ctx.assert.equal(/\b100(\.0)?%\b/.test(body), false, "Partial single-row swipe must not report 100%");

        await clickMainButton(app, /Fail/i);
        const navAfter = await app.queryAll("aside nav button");
        const touchAfter = navAfter.find((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchAfter?.text.includes("FAIL"));
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F14-03",
    tier: 2,
    feature: "F14",
    title: "High-jitter zigzag swipe reports non-zero linearity RMS / jitter metric",
    tags: ["tier2", "boundary", "touchscreen", "jitter"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 6);
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 10,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        ctx.assert.ok(
          nav.some((b) => /Touchscreen/i.test(b.text)),
          "Expected Touchscreen step button in Sidebar"
        );
        await app.clickStep(/Touchscreen/i);

        const surface = await app.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll(
              '[data-testid="touch-grid"], [data-testid="touchscreen-surface"], main canvas, main [role="grid"], main .grid'
            )
          );
          const best = candidates
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
          if (!best || best.r.width < 40 || best.r.height < 40) return null;
          return { x: best.r.left, y: best.r.top, width: best.r.width, height: best.r.height };
        });
        ctx.assert.ok(surface, "Expected interactive touchscreen grid/surface in TouchscreenTestView");

        const midY = surface.y + surface.height / 2;
        const zigzagPoints = Array.from({ length: 16 }, (_, i) => ({
          x: Math.round(surface.x + 12 + ((surface.width - 24) * i) / 15),
          y: Math.round(midY + (i % 2 === 0 ? -40 : 40)),
        }));
        await app.dispatchTouchGesture(zigzagPoints);

        const body = await app.getBodyText();
        ctx.assert.match(
          body,
          /(?:rms|jitter|linearity)[^0-9]*(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)\s*px/i,
          "Expected non-zero swipe linearity RMS / jitter reading (px) on zigzag touch input"
        );
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F14-04",
    tier: 2,
    feature: "F14",
    title: "Zero touch input keeps 0% coverage with Next disabled until manual Fail verdict",
    tags: ["tier2", "boundary", "touchscreen", "zero-touch"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 6);
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 10,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        ctx.assert.ok(
          nav.some((b) => /Touchscreen/i.test(b.text)),
          "Expected Touchscreen step button in Sidebar"
        );
        await app.clickStep(/Touchscreen/i);

        const body = await app.getBodyText();
        ctx.assert.match(body, /0(\.0)?%|0\/160/);

        const nextBtnBefore = (await app.queryAll("button")).find((b) =>
          /Next: Stage/i.test(b.text)
        );
        ctx.assert.ok(nextBtnBefore, "Expected Next: Stage button");
        ctx.assert.equal(nextBtnBefore.disabled, true, "Next: Stage must stay disabled before verdict/skip");

        await clickMainButton(app, /Fail/i);
        const navAfter = await app.queryAll("aside nav button");
        const touchAfter = navAfter.find((b) => /Touchscreen/i.test(b.text));
        ctx.assert.ok(touchAfter?.text.includes("FAIL"));

        const nextBtnAfter = (await app.queryAll("button")).find((b) =>
          /Next: Stage/i.test(b.text)
        );
        ctx.assert.equal(nextBtnAfter?.disabled, false);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F14-05",
    tier: 2,
    feature: "F14",
    title: "Single-finger digitizer (maxTouchPoints === 1) tracks 1 contact safely without false multi-touch",
    tags: ["tier2", "boundary", "touchscreen", "single-touch"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.healthyUltrabook();
      const fixture = withUnlockedStage(
        {
          ...base,
          touchCapabilities: { maxTouchPoints: 1 },
        },
        6
      );
      const app = await ctx.browser.openApp(fixture, {
        maxTouchPoints: 1,
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        const maxPts = await app.evaluate(() => navigator.maxTouchPoints);
        ctx.assert.equal(maxPts, 1);

        await app.waitForText("STAGE 00", 6000);
        await app.clickButton("Resume Session");

        const nav = await app.queryAll("aside nav button");
        ctx.assert.ok(
          nav.some((b) => /Touchscreen/i.test(b.text)),
          "Expected Touchscreen step button in Sidebar"
        );
        await app.clickStep(/Touchscreen/i);

        const surface = await app.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll(
              '[data-testid="touch-grid"], [data-testid="touchscreen-surface"], main canvas, main [role="grid"], main .grid'
            )
          );
          const best = candidates
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
          if (!best || best.r.width < 40 || best.r.height < 40) return null;
          return { x: best.r.left, y: best.r.top, width: best.r.width, height: best.r.height };
        });
        ctx.assert.ok(surface, "Expected interactive touchscreen grid/surface in TouchscreenTestView");

        await app.dispatchTouchGesture([
          { x: Math.round(surface.x + 20), y: Math.round(surface.y + surface.height / 2) },
          { x: Math.round(surface.x + surface.width - 20), y: Math.round(surface.y + surface.height / 2) },
        ]);

        const body = await app.getBodyText();
        ctx.assert.match(
          body,
          /Multi-Touch Peak[\s\r\n]+1\s*\/\s*10\s*Points/i,
          "Expected Multi-Touch Peak tile to record 1 / 10 Points on single-finger touch"
        );
        ctx.assert.equal(
          /Multi-Touch Peak[\s\r\n]+(?:[2-9]|10)\s*\/\s*10\s*Points/i.test(body),
          false,
          "Single-finger touch must not record false multi-touch (>= 2 / 10 Points)"
        );
        const coveredCount = Number(body.match(/(\d+)\s*\/\s*160/)?.[1] ?? 0);
        ctx.assert.ok(
          coveredCount >= 2,
          `Expected >= 2 / 160 grid cells covered from single-finger swipe, got ${coveredCount}`
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F15 — MonitorTest Display & Fullscreen Boundaries
  // =========================================================================
  {
    id: "T2-F15-01",
    tier: 2,
    feature: "F15",
    title: "MonitorTest pattern index wraps cleanly at pattern 0 ArrowLeft and last pattern ArrowRight",
    tags: ["tier2", "boundary", "display", "monitortest"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 5);
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /Display Fullscreen/i, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await app.pressKey("h");

        const hud1 = await waitForHudState(app, "1", "auto");
        ctx.assert.ok(hud1?.found, "Expected HUD inside fullscreen portal");
        const match1 = hud1.text.match(/\[(\d+)\/(\d+)\]/);
        ctx.assert.ok(match1, `Expected [1/N] counter in HUD, got: ${hud1.text}`);
        const total = Number(match1[2]);
        ctx.assert.equal(Number(match1[1]), 1);
        ctx.assert.ok(total >= 19, `Expected >= 19 MonitorTest patterns, got ${total}`);

        // Verify bidirectional navigation is live before boundary wrap/clamp checks
        await app.pressKey("ArrowRight");
        const hud2 = await waitForHudState(app, "1", "auto");
        const match2 = hud2?.text?.match(/\[(\d+)\/(\d+)\]/);
        ctx.assert.ok(match2, "Expected counter after ArrowRight from [1/N]");
        ctx.assert.equal(
          Number(match2[1]),
          2,
          `Expected ArrowRight from [1/${total}] to advance to 2, got ${match2[1]}`
        );

        await app.pressKey("ArrowLeft");
        const hudBack1 = await waitForHudState(app, "1", "auto");
        const matchBack1 = hudBack1?.text?.match(/\[(\d+)\/(\d+)\]/);
        ctx.assert.ok(matchBack1, "Expected counter after ArrowLeft from [2/N]");
        ctx.assert.equal(
          Number(matchBack1[1]),
          1,
          `Expected ArrowLeft from [2/${total}] to return to 1, got ${matchBack1[1]}`
        );

        // At index 0 -> ArrowLeft wraps to [N/N] (or clamps to [1/N], never [0/N])
        await app.pressKey("ArrowLeft");
        const hudAfterLeft = await waitForHudState(app, "1", "auto");
        const matchLeft = hudAfterLeft.text.match(/\[(\d+)\/(\d+)\]/);
        ctx.assert.ok(matchLeft, "Expected counter after ArrowLeft");
        const idxAfterLeft = Number(matchLeft[1]);
        ctx.assert.notEqual(idxAfterLeft, 0, "Pattern index must never become 0");
        ctx.assert.ok(
          idxAfterLeft === total || idxAfterLeft === 1,
          `Expected wrap to ${total} or clamp to 1, got ${matchLeft[1]}`
        );

        // If clamped to 1, confirm ArrowRight actually advances 1 -> 2, then step to [N/N]
        if (idxAfterLeft === 1) {
          await app.pressKey("ArrowRight");
          const hudStep2 = await waitForHudState(app, "1", "auto");
          const matchStep2 = hudStep2.text.match(/\[(\d+)\/(\d+)\]/);
          ctx.assert.ok(matchStep2, "Expected counter after first ArrowRight");
          ctx.assert.equal(
            Number(matchStep2[1]),
            2,
            `Expected ArrowRight from [1/${total}] to advance to 2, got ${matchStep2[1]}`
          );

          for (let i = 2; i < total; i += 1) {
            await app.pressKey("ArrowRight");
          }
          const hudAtLast = await waitForHudState(app, "1", "auto");
          const matchAtLast = hudAtLast.text.match(/\[(\d+)\/(\d+)\]/);
          ctx.assert.ok(matchAtLast, "Expected counter at final pattern");
          ctx.assert.equal(
            Number(matchAtLast[1]),
            total,
            `Expected stepping ArrowRight ${total - 1} times to reach [${total}/${total}], got ${matchAtLast[1]}`
          );
        }

        // At last pattern [N/N] -> ArrowRight wraps to [1/N] (or clamps to [N/N])
        await app.pressKey("ArrowRight");
        const hudAfterRight = await waitForHudState(app, "1", "auto");
        const matchRight = hudAfterRight.text.match(/\[(\d+)\/(\d+)\]/);
        ctx.assert.ok(matchRight, "Expected counter after ArrowRight at final pattern");
        const idxAfterRight = Number(matchRight[1]);
        ctx.assert.ok(
          idxAfterRight === 1 || idxAfterRight === total,
          `Expected wrap to 1 or clamp to ${total}, got ${matchRight[1]}`
        );

        if (idxAfterRight === 1 && idxAfterLeft === total) {
          // Wrapped 1 -> N -> 1: confirm ArrowRight advances 1 -> 2
          await app.pressKey("ArrowRight");
          const hudNext = await waitForHudState(app, "1", "auto");
          const matchNext = hudNext.text.match(/\[(\d+)\/(\d+)\]/);
          ctx.assert.ok(matchNext, "Expected counter after ArrowRight from wrapped [1/N]");
          ctx.assert.equal(
            Number(matchNext[1]),
            2,
            `Expected ArrowRight from wrapped [1/${total}] to advance to 2, got ${matchNext[1]}`
          );
        } else if (idxAfterRight === total) {
          // Clamped at N: confirm ArrowLeft decrements N -> N - 1
          await app.pressKey("ArrowLeft");
          const hudPrev = await waitForHudState(app, "1", "auto");
          const matchPrev = hudPrev.text.match(/\[(\d+)\/(\d+)\]/);
          ctx.assert.ok(matchPrev, "Expected counter after ArrowLeft from clamped [N/N]");
          ctx.assert.equal(
            Number(matchPrev[1]),
            total - 1,
            `Expected ArrowLeft from clamped [${total}/${total}] to decrement to ${total - 1}, got ${matchPrev[1]}`
          );
        }
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F15-02",
    tier: 2,
    feature: "F15",
    title: "Fullscreen HUD stays opacity 0 when cursor is above bottom edge and reveals on bottom hover",
    tags: ["tier2", "boundary", "display", "hud"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 5);
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /Display Fullscreen/i, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        await app.hoverAt(400, 200);
        const hiddenState = await waitForHudState(app, "0", "none");
        ctx.assert.equal(hiddenState.opacity, "0");
        ctx.assert.equal(hiddenState.pointerEvents, "none");

        await app.hoverAt(680, 860);
        const shownState = await waitForHudState(app, "1", "auto");
        ctx.assert.equal(shownState.opacity, "1");
        ctx.assert.equal(shownState.pointerEvents, "auto");

        await app.hoverAt(680, 200);
        const reHiddenState = await waitForHudState(app, "0", "none");
        ctx.assert.equal(reHiddenState.opacity, "0");
        ctx.assert.equal(reHiddenState.pointerEvents, "none");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F15-03",
    tier: 2,
    feature: "F15",
    title: "Pressing H toggles pinned HUD visibility even when cursor is away from bottom edge",
    tags: ["tier2", "boundary", "display", "hud"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 5);
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /Display Fullscreen/i, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        await app.hoverAt(400, 200);
        const initialHidden = await waitForHudState(app, "0", "none");
        ctx.assert.equal(initialHidden.opacity, "0");

        await app.pressKey("h");
        const pinned = await waitForHudState(app, "1", "auto");
        ctx.assert.equal(pinned.opacity, "1");
        ctx.assert.equal(pinned.pointerEvents, "auto");

        await app.pressKey("h");
        const unpinned = await waitForHudState(app, "0", "none");
        ctx.assert.equal(unpinned.opacity, "0");
        ctx.assert.equal(unpinned.pointerEvents, "none");
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F15-04",
    tier: 2,
    feature: "F15",
    title: "Escape and right-click contextmenu both exit Display Fullscreen and restore window flags",
    tags: ["tier2", "boundary", "display", "fullscreen"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 5);
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /Display Fullscreen/i, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        const countPortals = () =>
          app.evaluate(
            () =>
              Array.from(document.body.children).filter((el) => {
                const cs = getComputedStyle(el);
                return cs.position === "fixed" && cs.zIndex === "999999";
              }).length
          );

        ctx.assert.equal(await countPortals(), 1);
        const wsEnter = await app.getWindowState();
        ctx.assert.equal(wsEnter.fullscreen, true);
        ctx.assert.equal(wsEnter.alwaysOnTop, true);
        ctx.assert.equal(wsEnter.decorations, false);

        await app.pressKey("Escape");
        ctx.assert.equal(await countPortals(), 0, "Expected Escape to unmount fullscreen portal");
        const wsEsc = await app.getWindowState();
        ctx.assert.equal(wsEsc.fullscreen, false);
        ctx.assert.equal(wsEsc.alwaysOnTop, false);
        ctx.assert.equal(wsEsc.decorations, true);

        // Re-enter and exit via right-click contextmenu
        await app.clickButton(/Launch True Fullscreen Test/i);
        ctx.assert.equal(await countPortals(), 1);
        await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((el) => {
            const cs = getComputedStyle(el);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          portal?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
          );
        });
        await new Promise((r) => setTimeout(r, 50));

        ctx.assert.equal(await countPortals(), 0, "Expected contextmenu to unmount fullscreen portal");
        const wsRightClick = await app.getWindowState();
        ctx.assert.equal(wsRightClick.fullscreen, false);
        ctx.assert.equal(wsRightClick.alwaysOnTop, false);
        ctx.assert.equal(wsRightClick.decorations, true);
      } finally {
        await app.close();
      }
    },
  },

  {
    id: "T2-F15-05",
    tier: 2,
    feature: "F15",
    title: "Fullscreen portal mounts at z-index 999999 over entire viewport and blocks sidebar hit-testing",
    tags: ["tier2", "boundary", "display", "fullscreen", "portal"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = withUnlockedStage(ctx.fixtures.healthyUltrabook(), 5);
      const app = await ctx.browser.openApp(fixture, { mountTimeoutMs: 20000, mockOptions: { stepDelayMs: 0 } });
      try {
        await resumeAndOpenStep(app, /Display Fullscreen/i, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);

        const geometry = await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((el) => {
            const cs = getComputedStyle(el);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          const aside = document.querySelector("aside");
          if (!portal || !aside) return { found: false };
          const cs = getComputedStyle(portal);
          const rect = portal.getBoundingClientRect();
          const hitSidebarArea = document.elementFromPoint(80, 200);
          const hitCenterArea = document.elementFromPoint(680, 440);
          return {
            found: true,
            isDirectBodyChild: portal.parentElement === document.body,
            position: cs.position,
            zIndex: cs.zIndex,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            sidebarCoveredByPortal: Boolean(
              hitSidebarArea && (portal === hitSidebarArea || portal.contains(hitSidebarArea)) && !aside.contains(hitSidebarArea)
            ),
            centerCoveredByPortal: Boolean(
              hitCenterArea && (portal === hitCenterArea || portal.contains(hitCenterArea))
            ),
          };
        });

        ctx.assert.equal(geometry.found, true, "Expected fullscreen portal element");
        ctx.assert.equal(geometry.isDirectBodyChild, true);
        ctx.assert.equal(geometry.position, "fixed");
        ctx.assert.equal(geometry.zIndex, "999999");
        ctx.assert.equal(geometry.rect.x, 0);
        ctx.assert.equal(geometry.rect.y, 0);
        ctx.assert.equal(geometry.rect.width, geometry.viewport.width);
        ctx.assert.equal(geometry.rect.height, geometry.viewport.height);
        ctx.assert.equal(geometry.sidebarCoveredByPortal, true);
        ctx.assert.equal(geometry.centerCoveredByPortal, true);

        await app.pressKey("Escape");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
      } finally {
        await app.close();
      }
    },
  },
];
