function enrichScenario(fixture) {
  if (fixture.batteryDischarge && !fixture.batteryDischarge.status) {
    const v = fixture.batteryDischarge.verdict;
    fixture.batteryDischarge.status =
      v === "NORMAL" ? "pass" : v === "ABNORMAL" ? "fail" : v === "NOT_APPLICABLE" ? "notApplicable" : "warn";
  }
  if (fixture.networkDiagnostics && !fixture.networkDiagnostics.status) {
    fixture.networkDiagnostics.status = fixture.networkDiagnostics.verdict === "PASS" ? "pass" : "warn";
  }
  if (fixture.userBenchmark && !fixture.userBenchmark.sourceMode) {
    fixture.userBenchmark.sourceMode = fixture.userBenchmark.cpu?.sourceMode || "offline_calibrated";
  }
  return fixture;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withApp(ctx, fixture, opts, fn) {
  const build = await ctx.cli.ensureBuild();
  ctx.assert.equal(build.ok, true, `ensureBuild failed: ${build.stderr || build.stdout}`);
  let app = null;
  try {
    app = await ctx.browser.openApp(fixture, opts);
    await app.waitForText(/STAGE 00 \/\/ HARDWARE INSPECTION MANIFEST/i, 8000);
    await waitForButtonEnabled(app, /Begin Stage 01|Resume Stage/i, 5000);
    return await fn(app);
  } finally {
    if (app) {
      await app.close();
    }
  }
}

async function assertCleanRuntime(ctx, app) {
  const pageErrors = await app.getPageErrors();
  ctx.assert.equal(pageErrors.length, 0, `Unexpected page/console errors: ${JSON.stringify(pageErrors)}`);
  const invokeLog = await app.getInvokeLog();
  const unknown = invokeLog.filter((entry) => entry.unknownCommand);
  ctx.assert.equal(unknown.length, 0, `Unknown IPC commands invoked: ${JSON.stringify(unknown)}`);
  return invokeLog;
}

async function waitForButtonEnabled(app, labelRegex, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btns = await app.queryAll("button");
    const match = btns.find(
      (b) =>
        b.rect.width > 0 &&
        b.rect.height > 0 &&
        !b.disabled &&
        (labelRegex.test(b.text) || labelRegex.test(b.title))
    );
    if (match) return match;
    await sleep(30);
  }
  throw new Error(`Timed out waiting for enabled button matching ${labelRegex}`);
}

async function advanceCurrentStage(app) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const btns = await app.queryAll("button");
    const nextBtn = btns.find(
      (b) =>
        b.rect.width > 0 &&
        b.rect.height > 0 &&
        !b.disabled &&
        (/Next:\s*Stage/i.test(b.text) || /^Issue QC Certificate$/i.test(b.text))
    );
    if (nextBtn) {
      await app.clickButton(new RegExp(`^${nextBtn.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      await sleep(30);
      return "next";
    }
    const skipBtn = btns.find(
      (b) => b.rect.width > 0 && b.rect.height > 0 && !b.disabled && /^Skip Step$/i.test(b.text)
    );
    if (skipBtn) {
      await app.clickButton(/^Skip Step$/i);
      await sleep(30);
      return "skip";
    }
    await sleep(40);
  }
  throw new Error("Neither enabled Next: Stage / Issue QC Certificate nor Skip Step button found");
}

async function navigateToStage(app, headingRegex, maxHops = 16) {
  const body = await app.getBodyText();
  if (/STAGE 00 \/\/ HARDWARE INSPECTION MANIFEST/i.test(body)) {
    await app.clickButton(/Begin Stage 01|Resume Stage/i);
    await sleep(40);
  }
  for (let i = 0; i < maxHops; i += 1) {
    const text = await app.getBodyText();
    if (headingRegex.test(text)) {
      return;
    }
    await advanceCurrentStage(app);
    await sleep(40);
  }
  throw new Error(`Failed to reach stage matching ${headingRegex} within ${maxHops} steps`);
}

async function advanceRemainingToReportModal(app, maxHops = 18) {
  const body = await app.getBodyText();
  if (/STAGE 00 \/\/ HARDWARE INSPECTION MANIFEST/i.test(body)) {
    await app.clickButton(/Begin Stage 01|Resume Stage/i);
    await sleep(40);
  }
  for (let i = 0; i < maxHops; i += 1) {
    const text = await app.getBodyText();
    if (/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i.test(text)) {
      return;
    }
    await advanceCurrentStage(app);
    await sleep(40);
  }
  throw new Error(`Failed to reach PreReportModal within ${maxHops} steps`);
}

export const tests = [
  {
    id: "T5-01",
    tier: 5,
    feature: "F3",
    title: "Enriched userbenchmarkComparison overrides un-enriched result.userbenchmarkRating in StorageView, RamTestView, and GpuStressView",
    tags: ["tier5", "adversarial", "userbenchmark", "F3"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      const fixture = {
        ...base,
        specs: {
          ...base.specs,
          isGamingCapable: true,
        },
        storageBench: {
          ...base.storageBench,
          userbenchmarkRating: {
            component: "ssd",
            detectedModel: "UNENRICHED_NVME_FALLBACK",
            effectiveSpeedPct: 35.0,
            expectedClassPct: 90.0,
            relativeStandingPct: 38.9,
            vehicleTier: "Raft",
            standingLabel: "Underperforming",
            plainSummary: "Un-enriched SSD fallback rating without specs model.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        ramTest: {
          ...base.ramTest,
          userbenchmarkRating: {
            component: "ram",
            detectedModel: "UNENRICHED_RAM_FALLBACK",
            effectiveSpeedPct: 32.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 37.6,
            vehicleTier: "Jet Ski",
            standingLabel: "Underperforming",
            plainSummary: "Un-enriched RAM fallback rating without channel context.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        gpuStress: {
          ...base.gpuStress,
          userbenchmarkRating: {
            component: "gpu",
            detectedModel: "UNENRICHED_GPU_FALLBACK",
            effectiveSpeedPct: 31.0,
            expectedClassPct: 88.0,
            relativeStandingPct: 35.2,
            vehicleTier: "Raft",
            standingLabel: "Underperforming",
            plainSummary: "Un-enriched GPU fallback rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        userBenchmark: {
          ...base.userBenchmark,
          ssd: {
            component: "ssd",
            detectedModel: "Samsung PM9A1 Enriched SSD",
            effectiveSpeedPct: 96.0,
            expectedClassPct: 92.0,
            relativeStandingPct: 104.3,
            vehicleTier: "Nuclear Submarine",
            standingLabel: "As Expected",
            plainSummary: "Enriched SSD rating with full NVMe model context.",
            sourceMode: "offline_calibrated",
            subMetrics: [["Seq Read", "5800 MB/s"]],
            bottleneckFlag: null,
          },
          ram: {
            component: "ram",
            detectedModel: "16GB DDR5-5200 Enriched",
            effectiveSpeedPct: 68.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 80.0,
            vehicleTier: "Cruiser",
            standingLabel: "Below Expectations",
            plainSummary: "Enriched RAM rating with channel topology context.",
            sourceMode: "offline_calibrated",
            subMetrics: [["Bandwidth", "32 GB/s"]],
            bottleneckFlag: "Single-channel bottleneck detected via specs",
          },
          gpu: {
            component: "gpu",
            detectedModel: "RTX 4060 Enriched Laptop GPU",
            effectiveSpeedPct: 86.0,
            expectedClassPct: 88.0,
            relativeStandingPct: 97.7,
            vehicleTier: "Aircraft Carrier",
            standingLabel: "As Expected",
            plainSummary: "Enriched GPU rating with specs thermal envelope.",
            sourceMode: "offline_calibrated",
            subMetrics: [["Avg FPS", "62.0 FPS"]],
            bottleneckFlag: null,
          },
        },
      };

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/Enriched SSD rating with full NVMe model context/i, 5000);
        const ssdBody = await app.getBodyText();
        ctx.assert.match(ssdBody, /Samsung PM9A1 Enriched SSD/i);
        ctx.assert.equal(/UNENRICHED_NVME_FALLBACK/i.test(ssdBody), false, "StorageView shadowed by un-enriched rating");

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/Enriched RAM rating with channel topology context/i, 5000);
        const ramBody = await app.getBodyText();
        ctx.assert.match(ramBody, /Single-channel bottleneck detected via specs/i);
        ctx.assert.equal(/UNENRICHED_RAM_FALLBACK/i.test(ramBody), false, "RamTestView shadowed by un-enriched rating");

        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/RTX 4060 Enriched Laptop GPU/i, 5000);
        const gpuBody = await app.getBodyText();
        ctx.assert.match(gpuBody, /RTX 4060 Enriched Laptop GPU/i);
        ctx.assert.match(gpuBody, /Aircraft Carrier/i);
        ctx.assert.equal(/UNENRICHED_GPU_FALLBACK/i.test(gpuBody), false, "GpuStressView shadowed by un-enriched rating");

        await assertCleanRuntime(ctx, app);
      });
    },
  },

  {
    id: "T5-02",
    tier: 5,
    feature: "F18",
    title: "PreReportModal never exports durabilityGrade A or A+ when stages are skipped (PASSED WITH WARNINGS)",
    tags: ["tier5", "adversarial", "report", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        // Run Performance (which returns durabilityGrade: "A+") while skipping earlier stages
        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/16,450/, 5000);
        await advanceRemainingToReportModal(app);

        await app.waitForText(/PASSED WITH WARNINGS/i, 4000);
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "Expected export_qc_report invocation");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.overallVerdict, "PASSED WITH WARNINGS");
        ctx.assert.notEqual(payload.durabilityGrade, "A", "Skipped stages must not export Grade A");
        ctx.assert.notEqual(payload.durabilityGrade, "A+", "Skipped stages must not export Grade A+");
        ctx.assert.equal(payload.durabilityGrade, "B");
      });
    },
  },

  {
    id: "T5-03",
    tier: 5,
    feature: "F3",
    title: "BaselineCard renders cleanly with zero pageErrors when userbenchmarkRating.subMetrics is omitted",
    tags: ["tier5", "adversarial", "baselinecard", "F3"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      const stripSubMetrics = (r) => {
        if (!r) return r;
        const copy = { ...r };
        delete copy.subMetrics;
        return copy;
      };
      const fixture = {
        ...base,
        specs: { ...base.specs, isGamingCapable: true },
        perfBench: {
          ...base.perfBench,
          userbenchmarkRating: stripSubMetrics(base.userBenchmark.cpu),
        },
        gpuStress: {
          ...base.gpuStress,
          userbenchmarkRating: stripSubMetrics(base.userBenchmark.gpu),
        },
        ramTest: {
          ...base.ramTest,
          userbenchmarkRating: stripSubMetrics({
            component: "ram",
            detectedModel: "16GB DDR5",
            effectiveSpeedPct: 75.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 88.2,
            vehicleTier: "Cruiser",
            standingLabel: "As Expected",
            plainSummary: "RAM rating without subMetrics.",
            sourceMode: "offline_calibrated",
            bottleneckFlag: null,
          }),
        },
        storageBench: {
          ...base.storageBench,
          userbenchmarkRating: stripSubMetrics({
            component: "ssd",
            detectedModel: "NVMe SSD",
            effectiveSpeedPct: 82.0,
            expectedClassPct: 90.0,
            relativeStandingPct: 91.1,
            vehicleTier: "Battleship",
            standingLabel: "As Expected",
            plainSummary: "SSD rating without subMetrics.",
            sourceMode: "offline_calibrated",
            bottleneckFlag: null,
          }),
        },
        userBenchmark: {
          ...base.userBenchmark,
          cpu: stripSubMetrics(base.userBenchmark.cpu),
          gpu: stripSubMetrics(base.userBenchmark.gpu),
          ssd: {
            component: "ssd",
            detectedModel: "NVMe SSD",
            effectiveSpeedPct: 82.0,
            expectedClassPct: 90.0,
            relativeStandingPct: 91.1,
            vehicleTier: "Battleship",
            standingLabel: "As Expected",
            plainSummary: "SSD rating without subMetrics.",
            sourceMode: "offline_calibrated",
            bottleneckFlag: null,
          },
          ram: {
            component: "ram",
            detectedModel: "16GB DDR5",
            effectiveSpeedPct: 75.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 88.2,
            vehicleTier: "Cruiser",
            standingLabel: "As Expected",
            plainSummary: "RAM rating without subMetrics.",
            sourceMode: "offline_calibrated",
            bottleneckFlag: null,
          },
        },
      };

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/SSD rating without subMetrics/i, 5000);

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/RAM rating without subMetrics/i, 5000);

        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/USERBENCHMARK CALIBRATION/i, 5000);

        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/USERBENCHMARK CALIBRATION/i, 5000);

        await assertCleanRuntime(ctx, app);
      });
    },
  },

  {
    id: "T5-04",
    tier: 5,
    feature: "F11",
    title: "Mid-run Battery Discharge cancellation emits CANCELLED verdict consistently across IPC mock and UI",
    tags: ["tier5", "adversarial", "battery", "cancel", "F11"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixture = {
        ...base,
        batteryHealth: {
          ...base.batteryHealth,
          acPlugged: false,
          isCharging: false,
          currentChargePercent: 88.0,
        },
        telemetry: {
          ...base.telemetry,
          acPlugged: false,
          batteryPercent: 88.0,
        },
        progressEvents: {
          ...base.progressEvents,
          "battery:discharge": Array.from({ length: 10 }, (_, i) => ({
            running: true,
            phase: i < 3 ? "Phase 1: Idle" : "Phase 2: Controlled Load",
            elapsedSecs: (i + 1) * 3,
            durationSecs: 45,
            chargePercent: Number((88.0 - i * 0.1).toFixed(1)),
            voltageMv: 15850,
            watts: i < 3 ? 6.5 : 23.0,
            avgWatts: i < 3 ? 6.5 : 23.0,
            acPlugged: false,
            voltageSagMv: 210,
            chargeDropPct: Number((i * 0.1).toFixed(1)),
            maxStepDropPct: 0.1,
            verdictSoFar: "TRACKING",
            note: "Sampling live battery discharge telemetry",
          })),
        },
      };

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 90 } }, async (app) => {
        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        await app.clickButton(/Run Discharge Normality Test/i);
        await app.waitForText(/Sampling live battery discharge telemetry/i, 4000);
        await app.clickButton(/Abort Discharge Test/i);
        await waitForButtonEnabled(app, /Run Discharge Normality Test/i, 5000);

        const body = await app.getBodyText();
        ctx.assert.match(body, /\bCANCELLED\b/, "Expected CANCELLED verdict rendered in BatteryView");
        ctx.assert.equal(body.includes("ABORTED_BY_USER"), false, "Must not render stale ABORTED_BY_USER verdict");
        const log = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(log.some((e) => e.cmd === "cancel_battery_discharge_test" && e.ok), true);
      });
    },
  },

  {
    id: "T5-05",
    tier: 5,
    feature: "F11",
    title: "Simulated run_battery_discharge_test failure surfaces backend error without false AC_CONNECTED match",
    tags: ["tier5", "adversarial", "battery", "F11"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.acPlugged());
      const fixture = {
        ...base,
        commandErrors: {
          ...base.commandErrors,
          run_battery_discharge_test: "SIMULATED_BACKEND_CRASH_NO_AC_CHECK",
        },
      };
      await withApp(
        ctx,
        fixture,
        {
          maxTouchPoints: 10,
          mockOptions: { stepDelayMs: 0 },
        },
        async (app) => {
          await navigateToStage(app, /Battery Health, Discharge Normality/i);
          await app.clickButton(/Run Discharge Normality Test/i);
          await app.waitForText(/SIMULATED_BACKEND_CRASH_NO_AC_CHECK/i, 4000);
          const body = await app.getBodyText();
          ctx.assert.equal(
            /AC power adapter is currently plugged in|true battery discharge cannot be measured/i.test(body),
            false,
            "Post-run AC_CONNECTED verdict card must NOT appear when backend call throws"
          );
          const log = await app.getInvokeLog();
          const call = log.find((e) => e.cmd === "run_battery_discharge_test");
          ctx.assert.ok(call && call.ok === false, "Expected failed run_battery_discharge_test invoke entry");
        }
      );
    },
  },

  {
    id: "T5-06",
    tier: 5,
    feature: "F15",
    title: "DisplayTestView unobstructed fullscreen portal hides HUD initially and restores window chrome on Exit",
    tags: ["tier5", "adversarial", "display", "fullscreen", "F15"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await sleep(50);

        const winDuring = await app.getWindowState();
        ctx.assert.equal(winDuring.fullscreen, true);
        ctx.assert.equal(winDuring.alwaysOnTop, true);
        ctx.assert.equal(winDuring.decorations, false);

        const hudInitial = await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((el) => getComputedStyle(el).zIndex === "999999");
          const hud = portal
            ? Array.from(portal.querySelectorAll("div")).find((d) => /Click \/ Space: Next/i.test(d.textContent || ""))
            : null;
          return hud ? { opacity: getComputedStyle(hud).opacity, pointerEvents: getComputedStyle(hud).pointerEvents } : null;
        });
        ctx.assert.deepEqual(hudInitial, { opacity: "0", pointerEvents: "none" });

        // Reveal HUD via keyboard 'h' and click Exit
        await app.pressKey("h");
        await sleep(60);
        await app.clickButton(/^Exit$/i);
        await sleep(50);

        const winAfter = await app.getWindowState();
        ctx.assert.equal(winAfter.fullscreen, false, "Exit must restore fullscreen=false");
        ctx.assert.equal(winAfter.alwaysOnTop, false, "Exit must restore alwaysOnTop=false");
        ctx.assert.equal(winAfter.decorations, true, "Exit must restore decorations=true");
        await assertCleanRuntime(ctx, app);
      });
    },
  },

  {
    id: "T5-07",
    tier: 5,
    feature: "F14",
    title: "TouchscreenTestView clears active contacts on pointercancel and clamps out-of-bounds coordinates",
    tags: ["tier5", "adversarial", "touchscreen", "F14"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /Touchscreen & Multi-Touch Digitizer Test/i);
        await app.evaluate(() => {
          document.querySelector('[data-testid="touchscreen-matrix"]')?.scrollIntoView({ block: "center" });
        });
        await sleep(30);

        const rect = await app.getElementRect('[data-testid="touchscreen-matrix"]');
        ctx.assert.ok(rect && rect.width > 100 && rect.height > 100);

        // Dispatch synthetic touch pointerdown inside, pointermove out-of-bounds, and pointercancel
        await app.evaluate(({ cx, cy }) => {
          const el = document.querySelector('[data-testid="touchscreen-matrix"]');
          const mk = (type, x, y) =>
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: "touch",
              clientX: x,
              clientY: y,
              buttons: type === "pointercancel" ? 0 : 1,
            });
          el.dispatchEvent(mk("pointerdown", cx, cy));
          el.dispatchEvent(mk("pointermove", -40, -40));
          el.dispatchEvent(mk("pointercancel", -40, -40));
        }, { cx: rect.left + rect.width * 0.5, cy: rect.top + rect.height * 0.5 });

        await sleep(50);
        const body = await app.getBodyText();
        ctx.assert.match(body, /Active now:\s*0/i, "pointercancel must clear active touch contacts");
        const covMatch = body.match(/(\d+)\s*\/\s*160\s*\(/);
        ctx.assert.ok(covMatch, "Coverage fraction should still render");
        const covered = Number(covMatch[1]);
        ctx.assert.ok(covered >= 1 && covered <= 160, `Clamped covered cells out of range: ${covered}`);
        await assertCleanRuntime(ctx, app);
      });
    },
  },

  {
    id: "T5-08",
    tier: 5,
    feature: "F18",
    title: "PreReportModal exports consistent enriched userbenchmarkComparison across Section 02, Appendix A, and Section 03",
    tags: ["tier5", "adversarial", "userbenchmark", "report", "F18"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      const fixture = {
        ...base,
        specs: { ...base.specs, isGamingCapable: true },
        storageBench: {
          ...base.storageBench,
          userbenchmarkRating: {
            component: "ssd",
            detectedModel: "STALE_SSD_MODEL",
            effectiveSpeedPct: 35.0,
            expectedClassPct: 90.0,
            relativeStandingPct: 38.9,
            vehicleTier: "Raft",
            standingLabel: "Underperforming",
            plainSummary: "Stale un-enriched SSD rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        ramTest: {
          ...base.ramTest,
          userbenchmarkRating: {
            component: "ram",
            detectedModel: "STALE_RAM_MODEL",
            effectiveSpeedPct: 32.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 37.6,
            vehicleTier: "Jet Ski",
            standingLabel: "Underperforming",
            plainSummary: "Stale un-enriched RAM rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        perfBench: {
          ...base.perfBench,
          userbenchmarkRating: {
            component: "cpu",
            detectedModel: "STALE_CPU_MODEL",
            effectiveSpeedPct: 62.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 72.9,
            vehicleTier: "Cruiser",
            standingLabel: "Below Expectations",
            plainSummary: "Stale un-enriched CPU rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        gpuStress: {
          ...base.gpuStress,
          userbenchmarkRating: {
            component: "gpu",
            detectedModel: "STALE_GPU_MODEL",
            effectiveSpeedPct: 31.0,
            expectedClassPct: 88.0,
            relativeStandingPct: 35.2,
            vehicleTier: "Raft",
            standingLabel: "Underperforming",
            plainSummary: "Stale un-enriched GPU rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
        userBenchmark: {
          ...base.userBenchmark,
          ssd: {
            component: "ssd",
            detectedModel: "Samsung PM9A1 Enriched SSD",
            effectiveSpeedPct: 96.0,
            expectedClassPct: 92.0,
            relativeStandingPct: 104.3,
            vehicleTier: "Nuclear Submarine",
            standingLabel: "As Expected",
            plainSummary: "Enriched SSD rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
          ram: {
            component: "ram",
            detectedModel: "16GB DDR5-5200 Enriched",
            effectiveSpeedPct: 84.0,
            expectedClassPct: 85.0,
            relativeStandingPct: 98.8,
            vehicleTier: "Aircraft Carrier",
            standingLabel: "As Expected",
            plainSummary: "Enriched RAM rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
          cpu: {
            component: "cpu",
            detectedModel: "Intel Core i7-13700H Enriched",
            effectiveSpeedPct: 102.0,
            expectedClassPct: 90.0,
            relativeStandingPct: 113.3,
            vehicleTier: "UFO",
            standingLabel: "Above Expectations",
            plainSummary: "Enriched CPU rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
          gpu: {
            component: "gpu",
            detectedModel: "RTX 4060 Laptop Enriched",
            effectiveSpeedPct: 76.0,
            expectedClassPct: 80.0,
            relativeStandingPct: 95.0,
            vehicleTier: "Battleship",
            standingLabel: "As Expected",
            plainSummary: "Enriched GPU rating.",
            sourceMode: "offline_calibrated",
            subMetrics: [],
            bottleneckFlag: null,
          },
        },
      };

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/Nuclear Submarine/i, 5000);

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/Aircraft Carrier/i, 5000);

        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/\bUFO\b/, 5000);

        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/Battleship/i, 5000);

        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);

        const previewBody = await app.getBodyText();
        ctx.assert.match(previewBody, /UB Nuclear Submarine/);
        ctx.assert.equal(/UB Raft/i.test(previewBody), false, "Preview Section 02 must not show stale UB Raft");

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "Expected export_qc_report invocation");
        const payload = exportCall.args?.payload || exportCall.args;

        // Section 02 SSD Direct-IO bar must reflect enriched userBenchmark.ssd
        const ssdBar = payload.subsystemScores.find((s) => s.label === "SSD Direct-IO");
        ctx.assert.ok(ssdBar, "Expected SSD Direct-IO bar in Section 02");
        ctx.assert.match(ssdBar.metricText, /UB Nuclear Submarine/);
        ctx.assert.equal(/Raft/i.test(ssdBar.metricText), false, `Stale SSD UB tier leaked into Section 02: ${ssdBar.metricText}`);

        // Appendix A metrics must reflect enriched userBenchmark.* across all 4 subsystems
        const getMetric = (stageId, key) => {
          const st = payload.tests.find((t) => t.id === stageId);
          ctx.assert.ok(st, `Missing stage ${stageId} in payload.tests`);
          const pair = st.metrics.find(([k]) => k === key);
          return pair ? pair[1] : null;
        };
        ctx.assert.equal(getMetric("storage", "UB SSD"), "Nuclear Submarine (As Expected)");
        ctx.assert.equal(getMetric("ram", "UB RAM"), "Aircraft Carrier (As Expected)");
        ctx.assert.equal(getMetric("performance", "UB CPU"), "UFO (Above Expectations)");
        ctx.assert.equal(getMetric("gpu", "UB GPU"), "Battleship (As Expected)");

        // Section 03 must match the exact same enriched tiers
        ctx.assert.equal(payload.userBenchmark?.ssd?.vehicleTier, "Nuclear Submarine");
        ctx.assert.equal(payload.userBenchmark?.ram?.vehicleTier, "Aircraft Carrier");
        ctx.assert.equal(payload.userBenchmark?.cpu?.vehicleTier, "UFO");
        ctx.assert.equal(payload.userBenchmark?.gpu?.vehicleTier, "Battleship");
      });
    },
  },

  {
    id: "T5-09",
    tier: 5,
    feature: "F18",
    title: "Cancelled Power Torture with 0 skipped stages never exports Grade A+/A and never overrides lower completed perfResult grade",
    tags: ["tier5", "adversarial", "power_torture", "cancel", "report", "F18"],
    async run(ctx) {
      async function completeStages01To11WithoutSkipping(app) {
        await app.clickButton(/Begin Stage 01/i);

        // 01 Specs
        await app.waitForText(/Complete Hardware Specifications/i, 4000);
        await waitForButtonEnabled(app, /Next: Stage 02/i, 4000);
        await app.clickButton(/Next: Stage 02/i);

        // 02 Security
        await app.waitForText(/Lock, MDM & License Audit/i, 4000);
        await waitForButtonEnabled(app, /Next: Stage 03/i, 4000);
        await app.clickButton(/Next: Stage 03/i);

        // 03 Battery
        await app.waitForText(/Battery Health, Discharge Normality/i, 4000);
        await app.clickButton(/Run 15s Sag Pulse/i);
        await app.waitForText(/Battery sag pulse normal/i, 4000);
        const btns = await app.queryAll("button");
        const confirmPass = btns.find((b) => /Confirm PASS/i.test(b.text) && !b.disabled);
        if (confirmPass) await app.clickButton(/Confirm PASS/i);
        await waitForButtonEnabled(app, /Next: Stage 04/i, 4000);
        await app.clickButton(/Next: Stage 04/i);

        // 04 Error Logs
        await app.waitForText(/System Error & Crash Logs/i, 4000);
        await waitForButtonEnabled(app, /Next: Stage 05/i, 4000);
        await app.clickButton(/Next: Stage 05/i);

        // 05 Storage
        await app.waitForText(/SSD SMART Health & Direct-IO Durability Audit/i, 4000);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/0 ERR/, 5000);
        await waitForButtonEnabled(app, /Next: Stage 06/i, 4000);
        await app.clickButton(/Next: Stage 06/i);

        // 06 Display
        await app.waitForText(/Display Check/i, 4000);
        await app.clickButton(/Pass Display Check/i);
        await waitForButtonEnabled(app, /Next: Stage 07/i, 4000);
        await app.clickButton(/Next: Stage 07/i);

        // 07 Touchscreen
        await app.waitForText(/Touchscreen & Multi-Touch Digitizer Test/i, 4000);
        await app.evaluate(() => {
          document.querySelector('[data-testid="touchscreen-matrix"]')?.scrollIntoView({ block: "center" });
        });
        await sleep(30);
        const rect = await app.getElementRect('[data-testid="touchscreen-matrix"]');
        await app.dispatchMultiTouch([
          {
            id: 1,
            points: [
              { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.4 },
              { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.4 },
            ],
          },
          {
            id: 2,
            points: [
              { x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.6 },
              { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.6 },
            ],
          },
        ]);
        await waitForButtonEnabled(app, /Pass Touchscreen Test/i, 4000);
        await app.clickButton(/Pass Touchscreen Test/i);
        await waitForButtonEnabled(app, /Next: Stage 08/i, 4000);
        await app.clickButton(/Next: Stage 08/i);

        // 08 Keyboard
        await app.waitForText(/Keyboard & Touchpad Dead-Zone Audit/i, 4000);
        await app.pressKey("a");
        await app.clickButton(/Pass Input Audit/i);
        await waitForButtonEnabled(app, /Next: Stage 09/i, 4000);
        await app.clickButton(/Next: Stage 09/i);

        // 09 Biometrics
        await app.waitForText(/Fingerprint & Face ID Biometrics/i, 4000);
        await app.clickButton(/Approve Hardware OK/i);
        await waitForButtonEnabled(app, /Next: Stage 10/i, 4000);
        await app.clickButton(/Next: Stage 10/i);

        // 10 Media
        await app.waitForText(/Camera & Microphone Test/i, 4000);
        await app.clickButton(/Pass Camera & Mic/i);
        await waitForButtonEnabled(app, /Next: Stage 11/i, 4000);
        await app.clickButton(/Next: Stage 11/i);

        // 11 RAM
        await app.waitForText(/RAM Continuous Durability Audit/i, 4000);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/24\.0 GB/, 5000);
        await waitForButtonEnabled(app, /Next: Stage 12/i, 4000);
        await app.clickButton(/Next: Stage 12/i);
      }

      // Sub-case (a): Cancelled Power Torture (and cancelled Perf) with 0 skipped stages must NOT export A+ or A
      const baseA = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureA = {
        ...baseA,
        progressEvents: {
          ...baseA.progressEvents,
          "perf:progress": Array.from({ length: 10 }, (_, i) => ({
            ...baseA.progressEvents["perf:progress"][0],
            percent: (i + 1) * 9,
            elapsedSecs: i + 1,
          })),
          "torture:progress": Array.from({ length: 10 }, (_, i) => ({
            ...baseA.progressEvents["torture:progress"][0],
            percent: (i + 1) * 9,
            elapsedSecs: i + 1,
          })),
        },
      };

      await withApp(ctx, fixtureA, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 90 } }, async (app) => {
        await completeStages01To11WithoutSkipping(app);

        // 12 Performance: start and abort mid-run
        await app.waitForText(/360° All-Scope Performance/i, 4000);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/Multi-Core SIMD & Prime/i, 4000);
        await app.clickButton(/Abort Suite/i);
        await waitForButtonEnabled(app, /Next: Stage 13/i, 5000);
        await app.clickButton(/Next: Stage 13/i);

        // 13 GPU / Power Torture: switch to Torture tab, launch, and abort mid-run
        await app.waitForText(/GPU Burn-In, Dedicated VRAM Integrity/i, 4000);
        await app.clickButton(/03\. Power & AC Torture/i);
        await app.clickButton(/Launch Combined Torture/i);
        await waitForButtonEnabled(app, /Abort Torture/i, 4000);
        await app.clickButton(/Abort Torture/i);
        await waitForButtonEnabled(app, /Next: Stage 14/i, 5000);
        const gpuBody = await app.getBodyText();
        ctx.assert.match(gpuBody, /CANCELLED/, "Cancelled Power Torture UI must display CANCELLED grade");
        await app.clickButton(/Next: Stage 14/i);

        // 14 Ports & Speakers: pass without skipping
        await app.waitForText(/Live USB4\/3\.x Speed Detector/i, 4000);
        await app.clickButton(/Pass Ports & Speakers/i);
        await app.clickButton(/Issue QC Certificate/i);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const logA = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(logA.some((e) => e.cmd === "cancel_power_torture" && e.ok), true);
        const exportA = logA.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportA, "Expected export_qc_report in T5-09a");
        const payloadA = exportA.args?.payload || exportA.args;
        const skippedA = payloadA.tests.filter((t) => t.status === "skipped").length;
        ctx.assert.equal(skippedA, 0, "Expected 0 skipped stages in T5-09a");
        ctx.assert.equal(payloadA.overallVerdict, "PASSED WITH WARNINGS");
        ctx.assert.notEqual(payloadA.durabilityGrade, "A+", "Cancelled Power Torture must never export Grade A+");
        ctx.assert.notEqual(payloadA.durabilityGrade, "A", "Cancelled Power Torture must never export Grade A");
      });

      // Sub-case (b): Cancelled Power Torture (even with stale durabilityGrade "A+") must NOT override completed perfResult "C"
      const baseB = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureB = {
        ...baseB,
        perfBench: {
          ...baseB.perfBench,
          status: "warn",
          cancelled: false,
          durabilityGrade: "C",
          throttleDropPct: 24.0,
          summary: "Composite 12100 | 24.0% throttle drop | Grade C.",
        },
        powerTorture: {
          ...baseB.powerTorture,
          status: "warn",
          cancelled: true,
          durabilityGrade: "A+",
          summary: "Power torture cancelled.",
        },
      };

      await withApp(
        ctx,
        fixtureB,
        {
          maxTouchPoints: 10,
          mockOptions: { stepDelayMs: 0 },
        },
        async (app) => {
          await completeStages01To11WithoutSkipping(app);

          // 12 Performance: complete with Grade C
          await app.waitForText(/360° All-Scope Performance/i, 4000);
          await app.clickButton(/Run 14-Stage Suite/i);
          await app.waitForText(/16,450/, 5000);
          await app.clickButton(/Next: Stage 13/i);

          // 13 Power Torture: run cancelled torture carrying stale A+
          await app.waitForText(/GPU Burn-In, Dedicated VRAM Integrity/i, 4000);
          await app.clickButton(/03\. Power & AC Torture/i);
          await app.clickButton(/Launch Combined Torture/i);
          await waitForButtonEnabled(app, /Next: Stage 14/i, 5000);
          await app.clickButton(/Next: Stage 14/i);

          // 14 Ports & Speakers: pass without skipping
          await app.waitForText(/Live USB4\/3\.x Speed Detector/i, 4000);
          await app.clickButton(/Pass Ports & Speakers/i);
          await app.clickButton(/Issue QC Certificate/i);
          await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);
          await app.clickButton(/Issue Official QC Certificate/i);
          await app.waitForText(/Certificate Issued Successfully/i, 5000);

          const logB = await assertCleanRuntime(ctx, app);
          const exportB = logB.find((e) => e.cmd === "export_qc_report");
          ctx.assert.ok(exportB, "Expected export_qc_report in T5-09b");
          const payloadB = exportB.args?.payload || exportB.args;
          const skippedB = payloadB.tests.filter((t) => t.status === "skipped").length;
          ctx.assert.equal(skippedB, 0, "Expected 0 skipped stages in T5-09b");
          ctx.assert.equal(payloadB.overallVerdict, "PASSED WITH WARNINGS");
          ctx.assert.equal(
            payloadB.durabilityGrade,
            "C",
            `Cancelled Power Torture must not override completed perfResult Grade C (got ${payloadB.durabilityGrade})`
          );
        }
      );
    },
  },

  {
    id: "T5-10",
    tier: 5,
    feature: "F9",
    title: "Aborted Shelf Burn-In in DashboardView invokes cancel_shelf_burnin and displays INCOMPLETE monochrome verdict (never GRADE A+/A)",
    tags: ["tier5", "adversarial", "burnin", "cancel", "F9"],
    async run(ctx) {
      const base = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixture = {
        ...base,
        progressEvents: {
          ...base.progressEvents,
          "burnin:progress": Array.from({ length: 10 }, (_, i) => ({
            running: true,
            stageIndex: i < 3 ? 1 : i < 6 ? 2 : 3,
            totalStages: 3,
            stageName:
              i < 3
                ? "Stage 1/3: TestMem5 RAM Stability"
                : i < 6
                ? "Stage 2/3: Dedicated GPU VRAM Integrity"
                : "Stage 3/3: Combined CPU + GPU + RAM Power Torture",
            stageDetail: "Running unattended durability stage...",
            overallPercent: (i + 1) * 9,
            elapsedSecs: (i + 1) * 5,
            totalDurationSecs: 300,
            ramErrors: 0,
            vramErrors: 0,
            batteryDrainAlert: false,
            telemetry: base.telemetry,
          })),
        },
      };

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 90 } }, async (app) => {
        await app.clickButton(/Shelf Burn-In/i);
        await app.waitForText(/Shelf Burn-In Marathon/i, 4000);
        await app.clickButton(/Run \d+m Marathon/i);
        await waitForButtonEnabled(app, /^Abort$/i, 4000);
        await app.clickButton(/^Abort$/i);
        await app.waitForText(/MARATHON FINAL VERDICT/i, 5000);

        const body = await app.getBodyText();
        ctx.assert.match(body, /\bINCOMPLETE\b/, "Aborted Shelf Burn-In must display INCOMPLETE");
        ctx.assert.equal(/\bGRADE\s*A\+?/i.test(body), false, "Aborted Shelf Burn-In must never display GRADE A or GRADE A+");

        const badgeStyle = await app.evaluate(() => {
          const badge = document.querySelector('[data-testid="burnin-verdict-badge"]');
          if (!badge) return null;
          const cs = getComputedStyle(badge);
          return {
            text: badge.textContent?.trim() || "",
            backgroundColor: cs.backgroundColor,
            className: badge.className,
          };
        });
        ctx.assert.ok(badgeStyle, "Expected burnin-verdict-badge element");
        ctx.assert.match(badgeStyle.text, /\bINCOMPLETE\b/);
        ctx.assert.notEqual(badgeStyle.backgroundColor, "rgb(37, 99, 235)", "INCOMPLETE badge must not use Cobalt Blue bg-blue-600");
        ctx.assert.equal(badgeStyle.className.includes("bg-blue-600"), false);

        const log = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          log.some((e) => e.cmd === "cancel_shelf_burnin" && e.ok),
          true,
          "Expected cancel_shelf_burnin invocation"
        );
      });
    },
  },

  {
    id: "T5-11",
    tier: 5,
    feature: "F18",
    title: "PreReportModal Section 02 subsystemScores honors thermalCutoffTriggered and mid-run cancellation with non-blue monochrome bars",
    tags: ["tier5", "adversarial", "report", "thermal", "cancel", "F18"],
    async run(ctx) {
      // Sub-case (a): Storage + RAM thermal cutoff triggered with 0 errors -> statusLabel FAIL + dark bg-black bars
      const baseA = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureA = {
        ...baseA,
        storageBench: {
          ...baseA.storageBench,
          status: "fail",
          integrityErrors: 0,
          thermalCutoffTriggered: true,
          peakDriveTempC: 85.0,
          baseline: {
            ...baseA.storageBench.baseline,
            percentOfNormal: 96.0,
            grade: "NORMAL",
          },
          summary: "THERMAL CUTOFF (85C) during Direct-IO SSD audit (0 integrity errors).",
        },
        ramTest: {
          ...baseA.ramTest,
          status: "fail",
          errorsFound: 0,
          thermalCutoffTriggered: true,
          peakCpuTempC: 96.0,
          cancelled: false,
          baseline: {
            ...baseA.ramTest.baseline,
            percentOfNormal: 100.0,
            grade: "EXCELLENT",
          },
          summary: "THERMAL CUTOFF (96C) during TestMem5 RAM audit (0 bit errors).",
        },
      };

      await withApp(ctx, fixtureA, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/0 ERR/, 5000);

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/24\.0 GB/, 5000);

        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);

        const previewBars = await app.evaluate(() => {
          const readBar = (label) => {
            const row = document.querySelector(`[data-subsystem-row="${label}"]`);
            const bar = document.querySelector(`[data-subsystem-bar="${label}"]`);
            if (!row || !bar) return null;
            const statusSpan = row.querySelector("span:last-child");
            return {
              rowText: row.innerText || row.textContent || "",
              statusText: (statusSpan?.textContent || "").trim(),
              barClass: bar.className,
              barBg: getComputedStyle(bar).backgroundColor,
            };
          };
          return {
            ssd: readBar("SSD Direct-IO"),
            ram: readBar("RAM Stability (TM5)"),
          };
        });

        ctx.assert.ok(previewBars.ssd, "Expected SSD Direct-IO bar in PreReportModal preview");
        ctx.assert.ok(previewBars.ram, "Expected RAM Stability (TM5) bar in PreReportModal preview");
        ctx.assert.equal(previewBars.ssd.statusText, "FAIL", `Expected SSD statusLabel FAIL, got: ${previewBars.ssd.rowText}`);
        ctx.assert.equal(/\bNORMAL\b/.test(previewBars.ssd.rowText), false, `SSD thermal cutoff leaked NORMAL: ${previewBars.ssd.rowText}`);
        ctx.assert.equal(previewBars.ssd.barClass.includes("bg-black"), true, `Expected bg-black for failed SSD bar: ${previewBars.ssd.barClass}`);
        ctx.assert.notEqual(previewBars.ssd.barBg, "rgb(37, 99, 235)", "Failed SSD bar must not be Cobalt Blue");

        ctx.assert.equal(previewBars.ram.statusText, "FAIL", `Expected RAM statusLabel FAIL, got: ${previewBars.ram.rowText}`);
        ctx.assert.equal(/0 ERR PASS/.test(previewBars.ram.rowText), false, `RAM thermal cutoff leaked 0 ERR PASS: ${previewBars.ram.rowText}`);
        ctx.assert.equal(previewBars.ram.barClass.includes("bg-black"), true, `Expected bg-black for failed RAM bar: ${previewBars.ram.barClass}`);
        ctx.assert.notEqual(previewBars.ram.barBg, "rgb(37, 99, 235)", "Failed RAM bar must not be Cobalt Blue");

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const logA = await assertCleanRuntime(ctx, app);
        const exportA = logA.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportA, "Expected export_qc_report in T5-11a");
        const payloadA = exportA.args?.payload || exportA.args;
        const ssdBar = payloadA.subsystemScores.find((s) => s.label === "SSD Direct-IO");
        const ramBar = payloadA.subsystemScores.find((s) => s.label === "RAM Stability (TM5)");
        ctx.assert.equal(ssdBar?.statusLabel, "FAIL");
        ctx.assert.ok((ssdBar?.scorePct ?? 100) <= 20, `Expected low SSD scorePct on thermal cutoff, got ${ssdBar?.scorePct}`);
        ctx.assert.match(ssdBar?.metricText || "", /Thermal Cutoff/i);
        ctx.assert.equal(ramBar?.statusLabel, "FAIL");
        ctx.assert.ok((ramBar?.scorePct ?? 100) <= 20, `Expected low RAM scorePct on thermal cutoff, got ${ramBar?.scorePct}`);
        ctx.assert.match(ramBar?.metricText || "", /Thermal Cutoff/i);
      });

      // Sub-case (b): Abort RAM mid-run (cancelled: true, 0 errors) -> statusLabel CANCELLED + non-blue bar
      const baseB = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureB = {
        ...baseB,
        ramTest: {
          ...baseB.ramTest,
          totalGbVerified: 2.5,
          cyclesCompleted: 0,
          errorsFound: 0,
        },
        progressEvents: {
          ...baseB.progressEvents,
          "ram:progress": Array.from({ length: 10 }, (_, i) => ({
            running: true,
            profileName: "TestMem5 Default",
            testIndex: i % 6,
            patternName: "Prime Stride & 256-Byte",
            cycle: 1,
            percent: (i + 1) * 9,
            allocatedMb: 8192,
            totalGbVerified: 2.5,
            bandwidthGbS: 38.0,
            errorsFound: 0,
            perTestPasses: [0, 0, 0, 0, 0, 0],
            perTestErrors: [0, 0, 0, 0, 0, 0],
            elapsedSecs: i + 1,
            durationSecs: 60,
          })),
        },
      };

      await withApp(ctx, fixtureB, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 90 } }, async (app) => {
        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await waitForButtonEnabled(app, /Abort RAM Test/i, 4000);
        await app.clickButton(/Abort RAM Test/i);
        await waitForButtonEnabled(app, /Start Continuous Test/i, 5000);

        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);

        const previewRam = await app.evaluate(() => {
          const row = document.querySelector('[data-subsystem-row="RAM Stability (TM5)"]');
          const bar = document.querySelector('[data-subsystem-bar="RAM Stability (TM5)"]');
          if (!row || !bar) return null;
          const statusSpan = row.querySelector("span:last-child");
          return {
            rowText: row.innerText || row.textContent || "",
            statusText: (statusSpan?.textContent || "").trim(),
            barClass: bar.className,
            barBg: getComputedStyle(bar).backgroundColor,
          };
        });
        ctx.assert.ok(previewRam, "Expected RAM Stability (TM5) bar in PreReportModal preview");
        ctx.assert.equal(previewRam.statusText, "CANCELLED", `Expected RAM statusLabel CANCELLED, got: ${previewRam.rowText}`);
        ctx.assert.equal(/0 ERR PASS/.test(previewRam.rowText), false, `Aborted RAM leaked 0 ERR PASS: ${previewRam.rowText}`);
        ctx.assert.equal(previewRam.barClass.includes("bg-blue-600"), false, `Aborted RAM bar must not use bg-blue-600: ${previewRam.barClass}`);
        ctx.assert.notEqual(previewRam.barBg, "rgb(37, 99, 235)", "Aborted RAM bar must not render Cobalt Blue");

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const logB = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(logB.some((e) => e.cmd === "cancel_ram_stress" && e.ok), true);
        const exportB = logB.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportB, "Expected export_qc_report in T5-11b");
        const payloadB = exportB.args?.payload || exportB.args;
        const ramBar = payloadB.subsystemScores.find((s) => s.label === "RAM Stability (TM5)");
        ctx.assert.equal(ramBar?.statusLabel, "CANCELLED");
        ctx.assert.ok((ramBar?.scorePct ?? 100) < 100, `Expected capped partial scorePct for cancelled RAM, got ${ramBar?.scorePct}`);
      });
    },
  },

  {
    id: "T5-12",
    tier: 5,
    feature: "F18",
    title: "PreReportModal Section 02 classifies Network POOR_LINK / NO_ACTIVE_LINK and non-normal Battery Discharge verdicts with non-blue monochrome bars",
    tags: ["tier5", "adversarial", "report", "network", "battery", "cancel", "F18"],
    async run(ctx) {
      const readSection02Bars = async (app) =>
        app.evaluate(() => {
          const readBar = (label) => {
            const row = document.querySelector(`[data-subsystem-row="${label}"]`);
            const bar = document.querySelector(`[data-subsystem-bar="${label}"]`);
            if (!row || !bar) return null;
            const statusSpan = row.querySelector("span:last-child");
            return {
              rowText: row.innerText || row.textContent || "",
              statusText: (statusSpan?.textContent || "").trim(),
              barClass: bar.className,
              barBg: getComputedStyle(bar).backgroundColor,
            };
          };
          return {
            network: readBar("Network & Wi-Fi Link"),
            battery: readBar("Battery Health & Discharge"),
          };
        });

      // Subcase A: POOR_LINK + 92% capacity + aborted Discharge Normality (CANCELLED)
      const baseA = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureA = {
        ...baseA,
        networkDiagnostics: {
          ...baseA.networkDiagnostics,
          status: "fail",
          interfaceName: "Wi-Fi",
          linkSpeedMbps: 54,
          gatewayPingMs: 142.0,
          packetLossPct: 40.0,
          dnsResolveOk: true,
          verdict: "POOR_LINK",
          plainSummary: "POOR LINK on Wi-Fi: severe gateway packet loss (40%).",
        },
        batteryHealth: {
          ...baseA.batteryHealth,
          present: true,
          healthPercent: 92.0,
          wearPercent: 8.0,
          cycleCount: 64,
        },
        progressEvents: {
          ...baseA.progressEvents,
          "battery:discharge": Array.from({ length: 10 }, (_, i) => ({
            ...baseA.progressEvents["battery:discharge"][0],
            elapsedSecs: (i + 1) * 4,
            durationSecs: 45,
          })),
        },
      };

      await withApp(ctx, fixtureA, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 90 } }, async (app) => {
        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        await app.clickButton(/Run Discharge Normality Test/i);
        await waitForButtonEnabled(app, /Abort Discharge Test/i, 4000);
        await app.clickButton(/Abort Discharge Test/i);
        await waitForButtonEnabled(app, /Run Discharge Normality Test/i, 5000);

        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);

        const barsA = await readSection02Bars(app);
        ctx.assert.ok(barsA.network, "Expected Network & Wi-Fi Link bar in PreReportModal preview (Subcase A)");
        ctx.assert.ok(barsA.battery, "Expected Battery Health & Discharge bar in PreReportModal preview (Subcase A)");

        ctx.assert.equal(barsA.network.statusText, "POOR_LINK", `Expected POOR_LINK statusLabel, got: ${barsA.network.rowText}`);
        ctx.assert.equal(barsA.network.barClass.includes("bg-black"), true, `Expected bg-black for POOR_LINK bar: ${barsA.network.barClass}`);
        ctx.assert.equal(barsA.network.barClass.includes("bg-blue-600"), false, `POOR_LINK bar must not use bg-blue-600: ${barsA.network.barClass}`);
        ctx.assert.notEqual(barsA.network.barBg, "rgb(37, 99, 235)", "POOR_LINK bar must not render Cobalt Blue");

        ctx.assert.equal(barsA.battery.statusText, "CANCELLED", `Expected CANCELLED statusLabel (never PASS), got: ${barsA.battery.rowText}`);
        ctx.assert.notEqual(barsA.battery.statusText, "PASS", "High capacity must not mask aborted Discharge Normality as PASS");
        ctx.assert.equal(barsA.battery.barClass.includes("bg-zinc-700"), true, `Expected bg-zinc-700 for CANCELLED battery bar: ${barsA.battery.barClass}`);
        ctx.assert.equal(barsA.battery.barClass.includes("bg-blue-600"), false, `CANCELLED battery bar must not use bg-blue-600: ${barsA.battery.barClass}`);
        ctx.assert.notEqual(barsA.battery.barBg, "rgb(37, 99, 235)", "CANCELLED battery bar must not render Cobalt Blue");

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const logA = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(logA.some((e) => e.cmd === "cancel_battery_discharge_test" && e.ok), true);
        const exportA = logA.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportA, "Expected export_qc_report in T5-12a");
        const payloadA = exportA.args?.payload || exportA.args;
        const netBarA = payloadA.subsystemScores.find((s) => s.label === "Network & Wi-Fi Link");
        const batBarA = payloadA.subsystemScores.find((s) => s.label === "Battery Health & Discharge");
        ctx.assert.equal(netBarA?.statusLabel, "POOR_LINK");
        ctx.assert.equal(batBarA?.statusLabel, "CANCELLED");
      });

      // Subcase B: NO_ACTIVE_LINK + healthPercent: null + ABORTED_LOW_BATTERY
      const baseB = enrichScenario(ctx.fixtures.healthyUltrabook());
      const fixtureB = {
        ...baseB,
        networkDiagnostics: {
          ...baseB.networkDiagnostics,
          status: "warn",
          interfaceName: "Disconnected",
          linkSpeedMbps: null,
          wifiSsid: null,
          wifiSignalPct: null,
          rssiDbm: null,
          gatewayPingMs: null,
          packetLossPct: 100.0,
          dnsResolveOk: false,
          verdict: "NO_ACTIVE_LINK",
          plainSummary: "No active Wi-Fi or Ethernet link detected.",
        },
        batteryHealth: {
          ...baseB.batteryHealth,
          present: true,
          healthPercent: null,
          wearPercent: null,
          cycleCount: 64,
        },
        batteryDischarge: {
          ...baseB.batteryDischarge,
          status: "warn",
          verdict: "ABORTED_LOW_BATTERY",
          plainSummary: "Battery dropped to <=15% under load; stopped automatically.",
        },
      };

      await withApp(ctx, fixtureB, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 0 } }, async (app) => {
        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        await app.clickButton(/Run Discharge Normality Test/i);
        await app.waitForText(/ABORTED_LOW_BATTERY/, 5000);

        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);

        const barsB = await readSection02Bars(app);
        ctx.assert.ok(barsB.network, "Expected Network & Wi-Fi Link bar in PreReportModal preview (Subcase B)");
        ctx.assert.ok(barsB.battery, "Expected Battery Health & Discharge bar in PreReportModal preview (Subcase B)");

        ctx.assert.equal(barsB.network.statusText, "NO_ACTIVE_LINK", `Expected NO_ACTIVE_LINK statusLabel, got: ${barsB.network.rowText}`);
        ctx.assert.equal(barsB.network.barClass.includes("bg-zinc-700"), true, `Expected bg-zinc-700 for NO_ACTIVE_LINK bar: ${barsB.network.barClass}`);
        ctx.assert.equal(barsB.network.barClass.includes("bg-blue-600"), false, `NO_ACTIVE_LINK bar must not use bg-blue-600: ${barsB.network.barClass}`);
        ctx.assert.notEqual(barsB.network.barBg, "rgb(37, 99, 235)", "NO_ACTIVE_LINK bar must not render Cobalt Blue");

        ctx.assert.equal(barsB.battery.statusText, "ABORTED_LOW_BATTERY", `Expected ABORTED_LOW_BATTERY statusLabel, got: ${barsB.battery.rowText}`);
        ctx.assert.equal(barsB.battery.barClass.includes("bg-zinc-700"), true, `Expected bg-zinc-700 for ABORTED_LOW_BATTERY bar: ${barsB.battery.barClass}`);
        ctx.assert.equal(barsB.battery.barClass.includes("bg-blue-600"), false, `ABORTED_LOW_BATTERY bar must not use bg-blue-600: ${barsB.battery.barClass}`);
        ctx.assert.notEqual(barsB.battery.barBg, "rgb(37, 99, 235)", "ABORTED_LOW_BATTERY bar must not render Cobalt Blue");

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const logB = await assertCleanRuntime(ctx, app);
        const exportB = logB.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportB, "Expected export_qc_report in T5-12b");
        const payloadB = exportB.args?.payload || exportB.args;
        const netBarB = payloadB.subsystemScores.find((s) => s.label === "Network & Wi-Fi Link");
        const batBarB = payloadB.subsystemScores.find((s) => s.label === "Battery Health & Discharge");
        ctx.assert.equal(netBarB?.statusLabel, "NO_ACTIVE_LINK");
        ctx.assert.equal(batBarB?.statusLabel, "ABORTED_LOW_BATTERY");
      });
    },
  },

  {
    id: "T5-13",
    tier: 5,
    feature: "F15",
    title: "Three.js 3D+2D Fullscreen Graphics Lab never resets every 2-3s across telemetry polls, pauses timer in Play Mode, and advances cleanly to Next scene",
    tags: ["tier5", "adversarial", "graphics_lab", "threejs", "no_reset", "F15"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 15 } }, async (app) => {
        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/04\. Graphics & FPS Lab/i);
        await app.waitForText(/Three\.js 3D Game Engine & 2D Graphics Benchmark Suite/i, 5000);

        await app.clickButton(/Launch Three\.js 3D\+2D Suite/i);

        // Wait for fullscreen portal & initial HUD tick
        const waitPortalDeadline = Date.now() + 5000;
        let portalReady = false;
        while (Date.now() < waitPortalDeadline) {
          portalReady = await app.evaluate(() => Boolean(document.querySelector('[data-testid="graphics-fullscreen-portal"]')));
          if (portalReady) break;
          await sleep(50);
        }
        ctx.assert.equal(portalReady, true, "Fullscreen portal must mount when launching Three.js 3D+2D Suite");

        const readClockSecs = async () =>
          app.evaluate(() => {
            const el = document.querySelector('[data-testid="graphics-elapsed-clock"]');
            if (!el) return null;
            const m = (el.textContent || "").match(/([0-9]+(?:\.[0-9]+)?)s/);
            return m ? parseFloat(m[1]) : null;
          });

        // Sample across >3.4s (spanning multiple 1.4s telemetry polls & native compute completion)
        // to prove the v3.2/v3.3 2-3s scene reset loop bug is permanently fixed.
        await sleep(1100);
        const t1 = await readClockSecs();
        await sleep(2300);
        const t2 = await readClockSecs();

        ctx.assert.ok(typeof t1 === "number" && t1 >= 0.4, `Expected initial elapsed clock >= 0.4s, got ${t1}`);
        ctx.assert.ok(
          typeof t2 === "number" && t2 > t1 && t2 >= 2.4,
          `Scene clock reset or stalled across telemetry ticks (t1=${t1}s, t2=${t2}s) — 2-3s loop regression!`
        );

        // Activate Play Mode: countdown timer must pause (PAUSED (PLAY) + Resume Suite)
        await app.clickButton(/Take Control \(Play\)/i);
        await app.waitForText(/PAUSED \(PLAY\)/i, 3000);
        const pausedBody = await app.getBodyText();
        ctx.assert.match(pausedBody, /Resume Suite/, "Play Mode in suite must show Resume Suite button");

        // Advance cleanly to Scene 02 (3D Studio) via Next button
        await app.clickButton(/^Next$/i);
        await app.waitForText(/02\/9/, 4000);
        await app.waitForText(/3D Studio/i, 4000);

        // Exit fullscreen cleanly with Escape
        await app.pressKey("Escape");
        const closeDeadline = Date.now() + 4000;
        let stillOpen = true;
        while (Date.now() < closeDeadline) {
          stillOpen = await app.evaluate(() => Boolean(document.querySelector('[data-testid="graphics-fullscreen-portal"]')));
          if (!stillOpen) break;
          await sleep(50);
        }
        ctx.assert.equal(stillOpen, false, "Pressing Escape must cleanly unmount the fullscreen graphics portal");

        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "sample_live_telemetry" && e.ok),
          true,
          "Fullscreen HUD should poll sample_live_telemetry cleanly without restarting scene"
        );
      });
    },
  },

  {
    id: "T5-14",
    tier: 5,
    feature: "F15",
    title: "v3.5.0 Dual-Engine Powerhouse: Native Uncapped 3D launcher, Cinebench Live Tile Path-Tracer, Heavy 75% VRAM, 4 GB SLC SSD & Certificate Export",
    tags: ["tier5", "adversarial", "native3d", "pathtracer", "vram75", "slc_ssd", "F15"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());

      await withApp(ctx, fixture, { maxTouchPoints: 10, mockOptions: { stepDelayMs: 10 } }, async (app) => {
        // 1. Stage 05 Storage: verify 4 GB SLC-Cache Saturation option exists
        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        const hasSlcOpt = await app.evaluate(() =>
          Array.from(document.querySelectorAll("option")).some((o) => o.value === "slc_saturation")
        );
        ctx.assert.equal(hasSlcOpt, true, "Stage 05 Storage preset dropdown must include slc_saturation (4 GB)");

        // 2. Stage 12 Performance: run Cinebench-Class Live Tile Path-Tracer
        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run Cine Path-Tracer/i);
        await app.waitForText(/8,420|8420/, 5000);

        // 3. Stage 13 GPU: verify Heavy 75% VRAM option + launch Native Uncapped 3D Suite
        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        await app.clickButton(/02\. VRAM Integrity/i);
        const hasHeavy75 = await app.evaluate(() =>
          Array.from(document.querySelectorAll("option")).some((o) => o.value === "0" && /75%/i.test(o.textContent || ""))
        );
        ctx.assert.equal(hasHeavy75, true, "Stage 13 VRAM pool selector must offer Heavy 75% Auto-Detect VRAM option");

        await app.clickButton(/04\. Graphics & FPS Lab/i);
        await app.waitForText(/Native Rust wgpu Uncapped Fullscreen 3D Suite/i, 4000);
        await app.clickButton(/Launch Native Uncapped 3D/i);
        await app.waitForText(/74\.2 FPS AVG/i, 5000);

        // 4. Advance to PreReportModal and verify export_qc_report carries both native3d & cinePathtracer
        await advanceRemainingToReportModal(app);
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "run_cine_pathtracer" && e.ok), true);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "run_native_3d_suite" && e.ok), true);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "Expected export_qc_report invocation in T5-14");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.native3d?.compositeScore, 6840, "Exported payload must carry native3d result");
        ctx.assert.equal(payload.cinePathtracer?.multiCorePts, 8420, "Exported payload must carry cinePathtracer result");
      });
    },
  },
];
