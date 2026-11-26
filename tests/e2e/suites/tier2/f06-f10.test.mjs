async function openAtStep(ctx, fixtureOverrides, stepRegex, mockOptions = {}) {
  await ctx.cli.ensureBuild();
  const base = ctx.fixtures.makeBaseFixture(fixtureOverrides);
  const serial = base.specs?.serialNumber || "PF4X9102";
  const fixture = {
    ...base,
    savedSession: {
      serialNumber: serial,
      model: `${base.specs?.manufacturer || "LENOVO"} ${base.specs?.model || "QC"}`,
      savedAt: "2026-11-25T18:50:00Z",
      activeStressStage: null,
      stateJson: JSON.stringify({
        unlockedIndex: 20,
        modules: {},
        signoff: {
          portsChecked: false,
          portsNotes: "",
          speakersChecked: false,
          speakersNotes: "",
        },
      }),
    },
  };
  const app = await ctx.browser.openApp(fixture, {
    mountTimeoutMs: 20000,
    mockOptions: { stepDelayMs: 0, ...mockOptions },
  });
  try {
    await app.waitForText("Resume Session");
    await app.clickButton("Resume Session");
    await app.clickStep(stepRegex);
    return app;
  } catch (err) {
    await app.close();
    throw err;
  }
}

export const tests = [
  // =========================================================================
  // F6 — Storage Bench & DriveDx SMART Log 0x02 Boundaries
  // =========================================================================
  {
    id: "T2-F06-01",
    tier: 2,
    feature: "F6",
    title: "Percentage Used > 100% worn NVMe boundary",
    tags: ["tier2", "storage", "smart", "boundary"],
    async run(ctx) {
      const worn = ctx.fixtures.wornNvmeLowSpace();
      const app = await openAtStep(
        ctx,
        {
          specs: worn.specs,
          storageSmart: worn.storageSmart,
          storageBench: worn.storageBench,
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("104%", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("0%"), "Expected 0% Health remaining on >100% worn NVMe");
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL status on worn NVMe");
        ctx.assert.ok(body.includes("104% Percentage Used"), "Expected DriveDx 104% Percentage Used note");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.ok(
        !/log\[5\]\s*as\s*u32\)\.min\(100\)/.test(storageRs),
        "storage.rs NVMe Log 0x02 log[5] (Percentage Used) must NOT truncate values > 100% via .min(100)"
      );
    },
  },
  {
    id: "T2-F06-02",
    tier: 2,
    feature: "F6",
    title: "Media Errors > 0 critical alert boundary",
    tags: ["tier2", "storage", "smart", "boundary"],
    async run(ctx) {
      const baseSmart = ctx.fixtures.makeBaseFixture().storageSmart;
      const baseDrive = baseSmart.drives[0];
      const app = await openAtStep(
        ctx,
        {
          storageSmart: {
            status: "fail",
            drives: [
              {
                ...baseDrive,
                status: "fail",
                mediaErrors: 3,
                wearPercent: 5,
                healthPercent: 95,
                notes: "3 media errors detected",
              },
            ],
            summary: "1 NVMe drive critical: 3 media errors detected.",
          },
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("3 media errors detected", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL badge on Media Errors > 0");
        const mediaErrText = await app.evaluate(() => {
          const labels = Array.from(document.querySelectorAll("div")).filter(
            (d) => (d.innerText || "").trim() === "MEDIA ERR" || (d.innerText || "").trim() === "Media Err"
          );
          return labels[0]?.parentElement?.innerText || "";
        });
        ctx.assert.ok(mediaErrText.includes("3"), `Expected 3 in Media Err cell, got: ${mediaErrText}`);
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.match(storageRs, /media_errors\.unwrap_or\(0\)\s*>\s*0/);
    },
  },
  {
    id: "T2-F06-03",
    tier: 2,
    feature: "F6",
    title: "Critical Warning != 0 failure flagging boundary",
    tags: ["tier2", "storage", "smart", "boundary"],
    async run(ctx) {
      const baseSmart = ctx.fixtures.makeBaseFixture().storageSmart;
      const baseDrive = baseSmart.drives[0];
      const app = await openAtStep(
        ctx,
        {
          storageSmart: {
            status: "fail",
            drives: [
              {
                ...baseDrive,
                healthStatus: "Critical Warning",
                status: "fail",
                notes: "Critical Warning 0x04",
              },
            ],
            summary: "CRITICAL: NVMe Critical Warning 0x04.",
          },
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("Critical Warning 0x04", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL badge on Critical Warning != 0");
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.match(storageRs, /critical_warning\s*=\s*log\[0\]/);
      ctx.assert.match(storageRs, /nvme_crit\s*!=\s*0/);
    },
  },
  {
    id: "T2-F06-04",
    tier: 2,
    feature: "F6",
    title: "Available Spare <= Threshold low-spare boundary",
    tags: ["tier2", "storage", "smart", "boundary"],
    async run(ctx) {
      const baseSmart = ctx.fixtures.makeBaseFixture().storageSmart;
      const baseDrive = baseSmart.drives[0];
      const app = await openAtStep(
        ctx,
        {
          storageSmart: {
            status: "warn",
            drives: [
              {
                ...baseDrive,
                status: "warn",
                tbwGb: null,
                availableSparePct: 10,
                notes: "Available spare 10% at threshold",
              },
            ],
            summary: "WARN: Available spare at threshold (10%).",
          },
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("Available spare 10% at threshold", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("10%"), "Expected 10% spare rendered in TBW / Spare cell");
        ctx.assert.ok(body.includes("WARN"), "Expected WARN badge on low available spare");
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.ok(
        /available_spare_threshold|log\[4\]/.test(storageRs),
        "storage.rs must read NVMe Log 0x02 log[4] (Available Spare Threshold) and compare available_spare <= threshold"
      );
    },
  },
  {
    id: "T2-F06-05",
    tier: 2,
    feature: "F6",
    title: "Zero / missing NVMe SMART volume fallback",
    tags: ["tier2", "storage", "smart", "boundary", "negative"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          specs: { volumes: [] },
          storageSmart: {
            status: "warn",
            drives: [],
            summary: "No SMART-capable drives enumerated.",
          },
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("No SMART-capable drives enumerated.", 5000);
        const btns = await app.queryAll("button");
        const rescan = btns.find((b) => /Re-Scan SMART/i.test(b.text));
        const skip = btns.find((b) => /Skip Step/i.test(b.text));
        ctx.assert.ok(rescan && !rescan.disabled, "Expected Re-Scan SMART button enabled");
        ctx.assert.ok(skip && !skip.disabled, "Expected Skip Step button enabled");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.match(storageRs, /drives\.is_empty\(\)/);
      ctx.assert.match(storageRs, /TestStatus::Warn/);
    },
  },

  // =========================================================================
  // F7 — RAM Stress (TestMem5 Kernels) & OS Headroom Boundaries
  // =========================================================================
  {
    id: "T2-F07-01",
    tier: 2,
    feature: "F7",
    title: "4GB / low-RAM max(512, 22% RAM) OS reserve clamping",
    tags: ["tier2", "ram", "safety", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          specs: { totalRamGb: 4.0 },
          ramTest: { totalRamMb: 4096, allocatedMb: 2048 },
        },
        /RAM Stress/i
      );
      try {
        await app.clickButton("Start Continuous Test");
        await app.waitForText("2048 / 4096 MB", 5000);
      } finally {
        await app.close();
      }

      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.ok(
        /RAM_OS_RESERVE_PCT|total_ram_mb\s*\*\s*22\s*\/\s*100/.test(ramRs),
        "ram_test.rs must compute OS reserve using 22% (RAM_OS_RESERVE_PCT) and 512 MB floor instead of hardcoded saturating_sub(1800)"
      );
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_os_ram_reserve_bounds\s+\.\.\.\s+ok/
      );
    },
  },
  {
    id: "T2-F07-02",
    tier: 2,
    feature: "F7",
    title: "16GB+ 1800 MB OS reserve cap boundary",
    tags: ["tier2", "ram", "safety", "boundary"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      ctx.assert.match(typesRs, /RAM_OS_RESERVE_16GB_CAP_MB\s*:\s*\w+\s*=\s*1800/);

      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.ok(
        /1800|RAM_OS_RESERVE_16GB_CAP_MB/.test(ramRs),
        "ram_test.rs must cap OS reserve at 1800 MB on >= 16GB systems"
      );

      const app = await openAtStep(
        ctx,
        {
          specs: { totalRamGb: 32.0 },
          ramTest: { totalRamMb: 32768, allocatedMb: 10240 },
        },
        /RAM Stress/i
      );
      try {
        await app.clickButton("Start Continuous Test");
        await app.waitForText("10240 / 32768 MB", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("0 bit errors"), "Expected 0 bit errors on healthy 32GB sweep");
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F07-03",
    tier: 2,
    feature: "F7",
    title: "memPct slider bounds 30..75 and over-allocation guard",
    tags: ["tier2", "ram", "boundary"],
    async run(ctx) {
      const app = await openAtStep(ctx, {}, /RAM Stress/i);
      try {
        await app.fillInput("Free-RAM Allocation Window", "20");
        await app.waitForText("30%", 3000);
        await app.fillInput("Free-RAM Allocation Window", "95");
        await app.waitForText("75%", 3000);

        await app.clickButton("Start Continuous Test");
        await app.waitForText("Verified Metrics", 5000);

        const ramCalls = (await app.getInvokeLog()).filter((e) => e.cmd === "run_ram_stress");
        ctx.assert.ok(ramCalls.length >= 1);
        ctx.assert.equal(ramCalls[ramCalls.length - 1].args?.memoryPercent, 75);
      } finally {
        await app.close();
      }

      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.match(
        ramRs,
        /\.clamp\(\s*30\s*,\s*75\s*\)/,
        "ram_test.rs must clamp memory_percent to 30..=75 (not 25..=78)"
      );
    },
  },
  {
    id: "T2-F07-04",
    tier: 2,
    feature: "F7",
    title: "Single-channel RAM bottleneck warning across RamTestView and SpecsView",
    tags: ["tier2", "ram", "boundary"],
    async run(ctx) {
      const sc = ctx.fixtures.singleChannelSlowWifi();
      const app = await openAtStep(
        ctx,
        {
          specs: sc.specs,
          ramTest: sc.ramTest,
        },
        /RAM Stress/i
      );
      try {
        await app.clickButton("Start Continuous Test");
        await app.waitForText("BELOW NORMAL", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("56.0% OF NORMAL"));
        ctx.assert.ok(body.includes("19.4 / 16.8 GB/s"));
        ctx.assert.ok(body.includes("WARN"));

        await app.clickStep(/All-Hardware Specs/i);
        await app.waitForText("Single-Channel", 4000);
        const specsBody = await app.getBodyText();
        ctx.assert.ok(
          specsBody.includes("Single-channel RAM detected"),
          "Expected ramConfigWarning banner on SpecsView"
        );
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F07-05",
    tier: 2,
    feature: "F7",
    title: "ECC / bit-flip error detection and thermal abort guard",
    tags: ["tier2", "ram", "safety", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          ramTest: {
            status: "fail",
            errorsFound: 4,
            perTestErrors: [0, 2, 0, 2, 0, 0],
            summary: "RAM FAILURE: 4 bit error(s)",
          },
        },
        /RAM Stress/i
      );
      try {
        await app.clickButton("Start Continuous Test");
        await app.waitForText("4 bit errors", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL verdict on bit-flip errors");
      } finally {
        await app.close();
      }

      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.ok(
        /TelemetryReader|cpu_temp_c|CPU_THERMAL_CUTOFF/.test(ramRs),
        "ram_test.rs must check CPU thermal cutoff during RAM stress"
      );
    },
  },

  // =========================================================================
  // F8 — CPU/Memory Perf Bench + Mid-Run Thermal Cutoff Boundaries
  // =========================================================================
  {
    id: "T2-F08-01",
    tier: 2,
    feature: "F8",
    title: "CPU temp >= 95C mid-run thermal cutoff abort boundary",
    tags: ["tier2", "perf", "thermal", "safety", "boundary"],
    async run(ctx) {
      const hot = ctx.fixtures.throttlingGamingLaptop();
      const app = await openAtStep(
        ctx,
        {
          specs: hot.specs,
          telemetry: hot.telemetry,
          perfBench: {
            ...hot.perfBench,
            peakCpuTempC: 96.0,
          },
          progressEvents: {
            "perf:progress": [
              {
                phase: "14/14 Thermal Throttle Verification",
                percent: 75,
                elapsedSecs: 10.0,
                cpuUsagePct: 99.0,
                cpuClockMhz: 2150,
                cpuTempC: 96.0,
                raytracePreviewUrl: null,
                telemetry: hot.telemetry,
              },
            ],
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("CPU Thermal Curve", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("THROTTLE -32%") || body.includes("31.5%"),
          "Expected thermal throttle drop readout in PerformanceView"
        );
        ctx.assert.match(
          body,
          /(?:96(?:\.0+)?\s*°?\s*C|(?<!no\s+)thermal\s*(?:cutoff|abort|limit)|(?<!no\s+)cutoff\s*(?:triggered|aborted))/i,
          "Expected 96C / thermal cutoff abort status rendered in PerformanceView"
        );
      } finally {
        await app.close();
      }

      const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
      ctx.assert.ok(
        /CPU_THERMAL_CUTOFF|thermal_cutoff|cutoff_c/.test(perfRs),
        "perf_bench.rs must enforce mid-stage thermal cutoff abort (<= 95.0C / default 92.0C)"
      );
    },
  },
  {
    id: "T2-F08-02",
    tier: 2,
    feature: "F8",
    title: "CPU temp == 91C just-below-92C default cutoff passes cleanly",
    tags: ["tier2", "perf", "thermal", "boundary"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      ctx.assert.match(typesRs, /CPU_THERMAL_CUTOFF_DEFAULT_C\s*:\s*f32\s*=\s*92\.0/);

      const app = await openAtStep(
        ctx,
        {
          perfBench: {
            status: "pass",
            peakCpuTempC: 91.0,
            throttleDropPct: 6.2,
            compositeScore: 15200,
          },
          progressEvents: {
            "perf:progress": [
              {
                phase: "Sustained Compute",
                percent: 80,
                elapsedSecs: 12.0,
                cpuUsagePct: 98.0,
                cpuClockMhz: 3900,
                cpuTempC: 91.0,
                raytracePreviewUrl: null,
                telemetry: {
                  cpuUsagePct: 98,
                  cpuClockMhz: 3900,
                  cpuTempC: 91.0,
                  cpuPowerW: 35,
                  gpuTempC: 58,
                  gpuLoadPct: 10,
                  gpuPowerW: 5,
                  fanRpm: 4200,
                  acPlugged: true,
                  batteryPercent: 92,
                  batteryWatts: 0,
                  sensorSource: "Mock",
                },
              },
            ],
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("15,200", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("PASS"), "Expected PASS badge at 91C < 92C cutoff");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F08-03",
    tier: 2,
    feature: "F8",
    title: "Sensor Temp = None graceful fallback without false thermal abort",
    tags: ["tier2", "perf", "thermal", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          telemetry: { cpuTempC: null },
          perfBench: { status: "pass", peakCpuTempC: null },
          progressEvents: {
            "perf:progress": [
              {
                phase: "Sustained Compute",
                percent: 60,
                elapsedSecs: 8.0,
                cpuUsagePct: 95.0,
                cpuClockMhz: 3600,
                cpuTempC: null,
                raytracePreviewUrl: null,
                telemetry: null,
              },
            ],
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("BOUNDED SAFE TELEMETRY BRIDGE", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("Sensor unavailable (<= 6s/stage cap)"),
          "Expected ThresholdAuditTable row for Sensor unavailable (<= 6s/stage cap)"
        );
        ctx.assert.ok(body.includes("PASS"), "Expected PASS when CPU temp sensor is unavailable (None)");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F08-04",
    tier: 2,
    feature: "F8",
    title: "Cancellation mid-stage resets running state and marks WARN",
    tags: ["tier2", "perf", "cancellation", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          progressEvents: {
            "perf:progress": Array.from({ length: 10 }, (_, i) => ({
              phase: `Stage ${i + 1}/14`,
              percent: (i + 1) * 9,
              elapsedSecs: (i + 1) * 0.5,
              cpuUsagePct: 95,
              cpuClockMhz: 3800,
              cpuTempC: 72,
              raytracePreviewUrl: null,
              telemetry: null,
            })),
          },
        },
        /Perf & Creator/i,
        { stepDelayMs: 120 }
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("Abort Suite", 3000);
        await app.clickButton("Abort Suite");
        await app.waitForText("Run 14-Stage Suite", 5000);

        const cmds = (await app.getInvokeLog()).map((e) => e.cmd);
        ctx.assert.ok(cmds.includes("cancel_performance_benchmark"), "Expected cancel_performance_benchmark IPC");
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("WARN"), "Expected WARN status badge after cancelling suite");
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F08-05",
    tier: 2,
    feature: "F8",
    title: "Zero / degenerate timing stability guards against divide-by-zero",
    tags: ["tier2", "perf", "boundary"],
    async run(ctx) {
      const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
      ctx.assert.match(perfRs, /\.max\(\s*0\.001\s*\)/);
      ctx.assert.match(perfRs, /memory_latency_ns\.max\(\s*1\.0\s*\)/);

      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      ctx.assert.match(baselinesRs, /!metrics\.latency_ns\.is_finite\(\)\s*\|\|\s*metrics\.latency_ns\s*<=\s*0\.0/);

      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_weighted_harmonic_mean_guards_zero_negative_nan_inf_empty\s+\.\.\.\s+ok/
      );

      const app = await openAtStep(
        ctx,
        {
          perfBench: {
            status: "warn",
            compositeScore: 0,
            throttleDropPct: 0,
            memoryLatencyNs: 0,
            memoryBandwidthGbS: 0,
            elapsedSecs: 0,
            baseline: {
              detectedClass: "Test CPU",
              expectedNormal: ">= 10000",
              percentOfNormal: 0,
              grade: "POOR",
              verdictNote: "Degenerate zero timing boundary.",
            },
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("PASSMARK WEIGHTED HARMONIC COMPOSITE MARK", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(!body.includes("NaN"));
        ctx.assert.ok(!body.includes("Infinity"));
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F9 — GPU/VRAM/Power Torture Safety & FurMark 2 Diagnostics Boundaries
  // =========================================================================
  {
    id: "T2-F09-01",
    tier: 2,
    feature: "F9",
    title: "GPU temp >= 92C cutoff abort across gpu_stress, power_torture, and vram_test",
    tags: ["tier2", "gpu", "vram", "thermal", "safety", "boundary"],
    async run(ctx) {
      const hot = ctx.fixtures.throttlingGamingLaptop();
      const app = await openAtStep(
        ctx,
        {
          specs: hot.specs,
          telemetry: hot.telemetry,
          gpuAdapters: hot.gpuAdapters,
          gpuStress: hot.gpuStress,
          powerTorture: hot.powerTorture,
        },
        /GPU, VRAM/i
      );
      try {
        await app.clickButton("Start GPU Burn-In");
        await app.waitForText("TRIGGERED", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL on thermal cutoff triggered");
      } finally {
        await app.close();
      }

      const gpuRs = ctx.cli.readRepoFile("src-tauri/src/modules/gpu_stress.rs");
      const tortureRs = ctx.cli.readRepoFile("src-tauri/src/modules/power_torture.rs");
      const vramRs = ctx.cli.readRepoFile("src-tauri/src/modules/vram_test.rs");
      ctx.assert.match(gpuRs, /thermal_cutoff_triggered\s*=\s*true/);
      ctx.assert.match(tortureRs, /thermal_cutoff_triggered\s*=\s*true/);
      ctx.assert.ok(
        /thermal_cutoff_c|GPU_THERMAL_CUTOFF/.test(vramRs),
        "vram_test.rs must also enforce thermal_cutoff_c abort"
      );
    },
  },
  {
    id: "T2-F09-02",
    tier: 2,
    feature: "F9",
    title: "GPU thermal cutoff clamp bounds 75..92/95C and default 92C",
    tags: ["tier2", "gpu", "safety", "boundary"],
    async run(ctx) {
      const app = await openAtStep(ctx, {}, /GPU, VRAM/i);
      try {
        const cutoffAttrs = await app.evaluate(() => {
          const el = document.querySelector('input[type="number"]');
          return el ? { value: el.value, min: el.min, max: el.max } : null;
        });
        ctx.assert.ok(cutoffAttrs, "Expected numeric cutoff input on GpuStressView");
        const minNum = Number(cutoffAttrs.min);
        const maxNum = Number(cutoffAttrs.max);
        ctx.assert.equal(
          cutoffAttrs.value,
          "92",
          `Expected GpuStressView default thermal cutoff to be 92C, got ${cutoffAttrs.value}`
        );
        ctx.assert.ok(
          Number.isFinite(minNum) && minNum >= 75 && minNum < maxNum,
          `Expected GpuStressView min thermal cutoff >= 75C and < max (${cutoffAttrs.max}), got ${cutoffAttrs.min}`
        );
        ctx.assert.ok(
          Number.isFinite(maxNum) && maxNum >= 92 && maxNum <= 95,
          `Expected GpuStressView max thermal cutoff in 92..95C, got ${cutoffAttrs.max}`
        );

        await app.fillInput('input[type="number"]', "75");
        await app.clickButton("Start GPU Burn-In");
        await app.waitForText("Live GPU & FurMark-2 Telemetry", 5000);
        await app.waitForText("GPU 3D & THERMAL CALIBRATION", 5000);
        const gpuCalls = (await app.getInvokeLog()).filter((e) => e.cmd === "run_gpu_stress");
        ctx.assert.ok(gpuCalls.length >= 1);
        ctx.assert.equal(gpuCalls[gpuCalls.length - 1].args?.thermalCutoffC, 75);
      } finally {
        await app.close();
      }

      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(
        /GPU_THERMAL_CUTOFF_DEFAULT_C|unwrap_or\(\s*92\.0\s*\)/.test(libRs),
        "lib.rs must default GPU thermal cutoff to 92.0C"
      );
      ctx.assert.ok(
        /\.clamp\(\s*(?:75\.0|GPU_THERMAL_CUTOFF_MIN_C)\s*,\s*(?:9[2-5]\.0|GPU_THERMAL_CUTOFF_MAX_C)\s*\)|clamp_gpu_thermal_cutoff/.test(libRs) &&
          !/\.clamp\(\s*75(?:\.0)?\s*,\s*(?:9[6-9]|1\d\d)/.test(libRs),
        "lib.rs must clamp GPU thermal cutoff within 75.0..=92.0/95.0C (never > 95.0C)"
      );
    },
  },
  {
    id: "T2-F09-03",
    tier: 2,
    feature: "F9",
    title: "VRAM artifact mismatch detection on bit-flip errors",
    tags: ["tier2", "gpu", "vram", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          vramTest: {
            status: "fail",
            errorsFound: 7,
            totalGbVerified: 4.0,
            allocatedVramMb: 2048,
            summary: "FAIL: 7 errors",
          },
          progressEvents: {
            "vram:progress": [
              {
                running: true,
                adapterName: "Intel(R) Iris(R) Xe Graphics",
                patternName: "Walking Bit Inversion",
                passNumber: 2,
                percent: 66,
                allocatedVramMb: 2048,
                totalGbVerified: 4.0,
                bandwidthGbS: 52.4,
                errorsFound: 7,
                elapsedSecs: 5.5,
                durationSecs: 8.5,
                gpuTempC: 60.0,
              },
            ],
          },
        },
        /GPU, VRAM/i
      );
      try {
        await app.clickButton("02. VRAM Integrity");
        await app.clickButton("Start VRAM Sweep");
        await app.waitForText("7 errors", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL on VRAM bit-flip errors");
        ctx.assert.ok(body.includes("GPU VRAM Bit-Flip Errors"));
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F09-04",
    tier: 2,
    feature: "F9",
    title: "Office iGPU Mark N/A boundary vs dGPU omission",
    tags: ["tier2", "gpu", "boundary"],
    async run(ctx) {
      const office = await openAtStep(ctx, {}, /GPU, VRAM/i);
      try {
        await office.waitForText("Mark N/A (Office iGPU)", 4000);
        await office.clickButton("Mark N/A (Office iGPU)");
        await office.waitForText("N/A", 4000);
        const nextBtn = (await office.queryAll("button")).find((b) =>
          /Next: Stage/i.test(b.text)
        );
        ctx.assert.ok(nextBtn && !nextBtn.disabled, "Expected Next: Stage enabled after Mark N/A");
      } finally {
        await office.close();
      }

      const hot = ctx.fixtures.throttlingGamingLaptop();
      const gaming = await openAtStep(
        ctx,
        {
          specs: hot.specs,
          telemetry: hot.telemetry,
          gpuAdapters: hot.gpuAdapters,
        },
        /GPU, VRAM/i
      );
      try {
        await gaming.waitForText("01. 3D Shader Burn-In", 4000);
        const btns = await gaming.queryAll("button");
        const naBtn = btns.find((b) => /Mark N\/A/i.test(b.text));
        ctx.assert.equal(naBtn, undefined, "Expected no Mark N/A button when isGamingCapable === true");
      } finally {
        await gaming.close();
      }
    },
  },
  {
    id: "T2-F09-05",
    tier: 2,
    feature: "F9",
    title: "High GPU throttle drop % and AC charger battery drain warning",
    tags: ["tier2", "gpu", "power", "boundary"],
    async run(ctx) {
      const hot = ctx.fixtures.throttlingGamingLaptop();
      const app = await openAtStep(
        ctx,
        {
          specs: hot.specs,
          telemetry: hot.telemetry,
          gpuAdapters: hot.gpuAdapters,
          gpuStress: hot.gpuStress,
          powerTorture: hot.powerTorture,
        },
        /GPU, VRAM/i
      );
      try {
        await app.clickButton("Start GPU Burn-In");
        await app.waitForText("41.0%", 5000);

        await app.clickButton("03. Power & AC Torture");
        await app.clickButton("Launch Combined Torture");
        await app.waitForText("ALERT: BATTERY DRAINING WHILE AC CHARGER PLUGGED IN", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("DRAINING ON AC (-4.0%)"));
        ctx.assert.ok(body.includes("38.0%"));
        ctx.assert.match(body, /Durability Grade/i);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F10 — Robust Cross-Platform Telemetry Fallbacks Boundaries
  // =========================================================================
  {
    id: "T2-F10-01",
    tier: 2,
    feature: "F10",
    title: "All temp sensors None renders N/A gracefully without NaN/undefined",
    tags: ["tier2", "telemetry", "boundary"],
    async run(ctx) {
      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        telemetry: {
          cpuTempC: null,
          gpuTempC: null,
          cpuPowerW: null,
          gpuPowerW: null,
          fanRpm: null,
          sensorSource: "Unavailable",
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 6000);
        const headerText = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.ok(
          headerText.includes("Sensor unavailable"),
          `Expected Sensor unavailable in header, got: ${headerText}`
        );
        ctx.assert.ok(!headerText.includes("NaN") && !headerText.includes("undefined"));
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F10-02",
    tier: 2,
    feature: "F10",
    title: "Missing CPU temp falls back to GPU temp in strip and NVML range check",
    tags: ["tier2", "telemetry", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.equal(cargoRes.exitCode, 0, `Expected cargo test exitCode 0, got ${cargoRes.exitCode}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_parse_nvidia_smi_csv_valid_and_partial\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_sensor_availability_flags_all_missing_vs_partial\s+\.\.\.\s+ok/
      );

      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        telemetry: {
          cpuTempC: null,
          gpuTempC: 57.0,
          gpuPowerW: null,
          sensorSource: "ACPI Fallback",
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("GPU 57°C", 6000);
      } finally {
        await app.close();
      }

      const telemetryRs = ctx.cli.readRepoFile("src-tauri/src/modules/telemetry.rs");
      const sampleStart = telemetryRs.indexOf("pub fn sample(");
      const sampleEnd = telemetryRs.indexOf("fn sample_battery_fast(", sampleStart);
      ctx.assert.ok(
        sampleStart > 0 && sampleEnd > sampleStart,
        "Expected TelemetryReader::sample definition in telemetry.rs"
      );
      const sampleBody = telemetryRs.slice(sampleStart, sampleEnd);
      const nvmlCallIdx = sampleBody.indexOf("read_nvidia_gpu_telemetry(");
      const lhmCallIdx = sampleBody.indexOf("read_lhm_wmi_sensors_throttled(");
      ctx.assert.ok(
        nvmlCallIdx > 0 && lhmCallIdx > nvmlCallIdx,
        "TelemetryReader::sample must invoke NVML (read_nvidia_gpu_telemetry) before LHM fallback (read_lhm_wmi_sensors_throttled)"
      );

      const csvStart = telemetryRs.indexOf("fn parse_nvidia_smi_csv(");
      const csvEnd = telemetryRs.indexOf("fn classify_sysinfo_component_temp(", csvStart);
      ctx.assert.ok(
        csvStart > 0 && csvEnd > csvStart,
        "Expected parse_nvidia_smi_csv definition in telemetry.rs"
      );
      const csvBody = telemetryRs.slice(csvStart, csvEnd);
      ctx.assert.match(
        csvBody,
        /\*t\s*>\s*10\.0\s*&&\s*\*t\s*<\s*125\.0|15\.0.*120\.0/,
        "telemetry.rs parse_nvidia_smi_csv must range-validate gpu_temp_c"
      );
    },
  },
  {
    id: "T2-F10-03",
    tier: 2,
    feature: "F10",
    title: "AC vs Battery vs Unknown (PWR) power source transitions",
    tags: ["tier2", "telemetry", "boundary"],
    async run(ctx) {
      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        telemetry: {
          acPlugged: true,
          batteryPercent: 95,
          batteryWatts: 0,
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("95%", 6000);
        let headerText = await app.evaluate(() => document.querySelector("header")?.innerText || "");
        ctx.assert.ok(headerText.includes("AC") && headerText.includes("95%"));

        await app.emitTauriEvent("perf:progress", {
          phase: "On Battery",
          percent: 40,
          elapsedSecs: 2,
          cpuUsagePct: 45,
          cpuClockMhz: 2900,
          cpuTempC: 60,
          raytracePreviewUrl: null,
          telemetry: {
            cpuUsagePct: 45,
            cpuClockMhz: 2900,
            cpuTempC: 60,
            cpuPowerW: 12,
            gpuTempC: 48,
            gpuLoadPct: 5,
            gpuPowerW: 2,
            fanRpm: 1900,
            acPlugged: false,
            batteryPercent: 94,
            batteryWatts: -18.5,
            sensorSource: "Mock",
          },
        });
        await app.waitForText("BAT", 3000);
        headerText = await app.evaluate(() => document.querySelector("header")?.innerText || "");
        ctx.assert.ok(headerText.includes("94%") && headerText.includes("-18.5W"));

        await app.emitTauriEvent("perf:progress", {
          phase: "Unknown Power",
          percent: 60,
          elapsedSecs: 3,
          cpuUsagePct: 30,
          cpuClockMhz: 2600,
          cpuTempC: 55,
          raytracePreviewUrl: null,
          telemetry: {
            cpuUsagePct: 30,
            cpuClockMhz: 2600,
            cpuTempC: 55,
            cpuPowerW: null,
            gpuTempC: null,
            gpuLoadPct: null,
            gpuPowerW: null,
            fanRpm: null,
            acPlugged: null,
            batteryPercent: null,
            batteryWatts: null,
            sensorSource: "Mock",
          },
        });
        await app.waitForText("PWR", 3000);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F10-04",
    tier: 2,
    feature: "F10",
    title: "Spike / out-of-range telemetry filtering and UI stability",
    tags: ["tier2", "telemetry", "boundary"],
    async run(ctx) {
      const telemetryRs = ctx.cli.readRepoFile("src-tauri/src/modules/telemetry.rs");
      ctx.assert.match(telemetryRs, /15\.0.*120\.0/);
      ctx.assert.match(telemetryRs, /400.*8000/);
      ctx.assert.match(telemetryRs, /15000/);

      await ctx.cli.ensureBuild();
      const app = await ctx.browser.openApp(ctx.fixtures.makeBaseFixture(), {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 6000);
        await app.emitTauriEvent("perf:progress", {
          phase: "Spike",
          percent: 90,
          elapsedSecs: 5,
          cpuUsagePct: 100,
          cpuClockMhz: 5200,
          cpuTempC: 119.0,
          raytracePreviewUrl: null,
          telemetry: {
            cpuUsagePct: 100,
            cpuClockMhz: 5200,
            cpuTempC: 119.0,
            cpuPowerW: 45,
            gpuTempC: 88,
            gpuLoadPct: 95,
            gpuPowerW: 30,
            fanRpm: 5000,
            acPlugged: true,
            batteryPercent: 92,
            batteryWatts: -0.0,
            sensorSource: "Mock",
          },
        });
        await app.waitForText("119°C", 3000);
        const body = await app.getBodyText();
        ctx.assert.ok(!body.includes("NaN"));
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F10-05",
    tier: 2,
    feature: "F10",
    title: "IPC sample_live_telemetry error recovery on next 3.5s poll cycle",
    tags: ["tier2", "telemetry", "ipc", "recovery", "boundary"],
    async run(ctx) {
      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        commandErrors: {
          sample_live_telemetry: "Telemetry WMI timeout",
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 6000);
        const headerBefore = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.ok(
          headerBefore.includes("—") && headerBefore.includes("PWR") && !headerBefore.includes("54°C"),
          `Expected fallback header (— / PWR without 54°C) on initial telemetry failure, got: ${headerBefore}`
        );
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Expected 0 unhandled page errors, got: ${JSON.stringify(errs)}`);

        const failedTelemetryCalls = (await app.getInvokeLog()).filter(
          (e) => e.cmd === "sample_live_telemetry" && e.ok === false
        );
        ctx.assert.ok(failedTelemetryCalls.length >= 1);

        await app.evaluate(() => {
          window.__TAURI_MOCK__.setFixturePatch({
            commandErrors: { sample_live_telemetry: "" },
          });
        });

        await app.waitForText("54°C", 6000);
        const headerAfter = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.ok(headerAfter.includes("AC"), `Expected AC telemetry recovery, got: ${headerAfter}`);
      } finally {
        await app.close();
      }
    },
  },
];
