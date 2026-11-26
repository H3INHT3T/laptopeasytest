import fs from "node:fs";
import path from "node:path";

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
  // F1 — Toolchain, build.rs, CLI & cargo test Boundaries
  // =========================================================================
  {
    id: "T2-F01-01",
    tier: 2,
    feature: "F1",
    title: "Unknown CLI flags and invalid filter args on runner exit non-zero cleanly",
    tags: ["tier2", "cli", "boundary", "negative"],
    async run(ctx) {
      const bogus = await ctx.cli.runCommand(process.execPath, [
        "tests/e2e/run.mjs",
        "--bogus-flag",
      ]);
      ctx.assert.equal(bogus.ok, false, "Expected --bogus-flag to fail");
      ctx.assert.equal(bogus.exitCode, 1, `Expected exitCode 1, got ${bogus.exitCode}`);
      ctx.assert.match(bogus.stderr, /Unknown CLI argument/i);

      const badTier = await ctx.cli.runCommand(process.execPath, [
        "tests/e2e/run.mjs",
        "--tier",
        "99",
      ]);
      ctx.assert.equal(badTier.exitCode, 1, `Expected --tier 99 exitCode 1, got ${badTier.exitCode}`);
      ctx.assert.match(badTier.stderr, /Invalid --tier value/i);

      const badTimeout = await ctx.cli.runCommand(process.execPath, [
        "tests/e2e/run.mjs",
        "--timeout-ms",
        "-1",
      ]);
      ctx.assert.equal(badTimeout.exitCode, 1, `Expected --timeout-ms -1 exitCode 1, got ${badTimeout.exitCode}`);
      ctx.assert.match(badTimeout.stderr, /Invalid --timeout-ms value/i);

      const help = await ctx.cli.runCommand(process.execPath, [
        "tests/e2e/run.mjs",
        "--help",
      ]);
      ctx.assert.equal(help.ok, true, "Expected --help to exit 0");
      ctx.assert.equal(help.exitCode, 0);
      ctx.assert.match(help.stdout, /LaptopBench QC E2E Runner/);
    },
  },
  {
    id: "T2-F01-02",
    tier: 2,
    feature: "F1",
    title: "Missing executable path and path-traversal boundaries fail gracefully",
    tags: ["tier2", "cli", "boundary", "negative"],
    async run(ctx) {
      const missing = await ctx.cli.runCommand(
        "src-tauri/target/debug/nonexistent-laptopbench-qc.exe",
        ["--self-test"]
      );
      ctx.assert.equal(missing.ok, false);
      ctx.assert.equal(missing.exitCode, -1, `Expected missing exe exitCode -1, got ${missing.exitCode}`);
      ctx.assert.ok(missing.stderr.length > 0, "Expected non-empty stderr on missing executable");

      ctx.assert.throws(
        () => ctx.cli.readRepoFile("../package.json"),
        /escapes rootDir/
      );

      const selfTestExe = path.join(
        ctx.rootDir,
        "src-tauri",
        "target",
        "debug",
        process.platform === "win32" ? "laptopbench-qc.exe" : "laptopbench-qc"
      );
      const selfRes = await ctx.cli.runSelfTest();
      if (fs.existsSync(selfTestExe)) {
        ctx.assert.equal(selfRes.ok, true, `Expected --self-test to pass: ${selfRes.stderr}`);
        ctx.assert.equal(selfRes.exitCode, 0);
      } else {
        ctx.assert.equal(selfRes.ok, false);
        ctx.assert.equal(selfRes.exitCode, -1);
      }
    },
  },
  {
    id: "T2-F01-03",
    tier: 2,
    feature: "F1",
    title: "LAPTOPBENCH_NO_ELEVATE=1 and GNU debug vs release manifest gate in build.rs",
    tags: ["tier2", "toolchain", "boundary"],
    async run(ctx) {
      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      ctx.assert.match(buildRs, /LAPTOPBENCH_NO_ELEVATE/);
      ctx.assert.match(buildRs, /==\s*"1"/);
      ctx.assert.match(buildRs, /requireAdministrator/);
      ctx.assert.match(buildRs, /is_release\s*&&\s*!skip_elevate/);
      ctx.assert.match(buildRs, /target_env\s*==\s*"gnu"\s*&&\s*!is_release/);
      ctx.assert.match(buildRs, /libresource\.a/);
      ctx.assert.ok(
        !/println!\(\s*"cargo:rustc-link-arg-tests/.test(buildRs),
        "build.rs must not pass rustc-link-arg-tests (causes Windows GNU test CRT crashes)"
      );

      const cargoToml = ctx.cli.readRepoFile("src-tauri/Cargo.toml");
      ctx.assert.match(cargoToml, /\[lib\]/);
      ctx.assert.match(cargoToml, /crate-type\s*=\s*\[\s*"rlib"\s*\]/);
    },
  },
  {
    id: "T2-F01-04",
    tier: 2,
    feature: "F1",
    title: "Zero .rsrc or WebView2Loader.dll startup crash (0xc0000139/0xc0000005) on GNU debug binaries",
    tags: ["tier2", "toolchain", "cargo"],
    async run(ctx) {
      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      ctx.assert.match(buildRs, /WebView2Loader\.dll/);
      ctx.assert.match(buildRs, /deps/);

      const depsDir = path.join(ctx.rootDir, "src-tauri", "target", "debug", "deps");
      if (fs.existsSync(depsDir)) {
        const depsEntries = fs.readdirSync(depsDir);
        const hasTestExe = depsEntries.some((f) => f.endsWith(".exe"));
        if (hasTestExe && process.platform === "win32") {
          ctx.assert.equal(
            fs.existsSync(path.join(depsDir, "WebView2Loader.dll")),
            true,
            "Expected WebView2Loader.dll copied into src-tauri/target/debug/deps/"
          );
        }
      }

      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.ok(
        ![3221225785, 3221225477, -1073741511, -1073741819].includes(cargoRes.exitCode),
        `cargo test crashed with Windows loader/access fault exitCode ${cargoRes.exitCode}`
      );
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr || cargoRes.stdout}`);
      ctx.assert.equal(cargoRes.exitCode, 0);
    },
  },
  {
    id: "T2-F01-05",
    tier: 2,
    feature: "F1",
    title: "cargo test deterministic exit 0 across repeated cached invocation",
    tags: ["tier2", "toolchain", "cargo"],
    async run(ctx) {
      const r1 = await ctx.cli.runCargoTest();
      const r2 = await ctx.cli.runCargoTest();
      ctx.assert.equal(r1, r2, "Expected cached runCargoTest() handle identity");
      ctx.assert.equal(r1.ok, true, `cargo test failed: ${r1.stderr || r1.stdout}`);
      ctx.assert.equal(r1.exitCode, 0);

      const m = r1.stdout.match(/test result: ok\.\s+(\d+)\s+passed;\s+0\s+failed/);
      ctx.assert.ok(m, `Expected passing cargo test summary, got: ${r1.stdout.slice(-300)}`);
      const passedCount = Number(m[1]);
      ctx.assert.ok(passedCount >= 15, `Expected >= 15 unit tests passed, got ${passedCount}`);
    },
  },

  // =========================================================================
  // F2 — Weighted Harmonic Mean Scoring Calibration Boundaries
  // =========================================================================
  {
    id: "T2-F02-01",
    tier: 2,
    feature: "F2",
    title: "Zero, negative, NaN/Inf and empty harmonic inputs guard against NaN/Inf",
    tags: ["tier2", "harmonic", "boundary"],
    async run(ctx) {
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
            singleCoreScore: 0,
            multiCoreScore: 0,
            officeScore: 0,
            creatorScore: 0,
            memoryMark: 0,
            memoryLatencyNs: 0,
            baseline: {
              percentOfNormal: 0,
              grade: "POOR / UNDERPERFORMING",
            },
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("POOR / UNDERPERFORMING", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(!body.includes("NaN"), "UI must never display NaN on zero scores");
        ctx.assert.ok(!body.includes("Infinity"), "UI must never display Infinity on zero scores");
        ctx.assert.ok(
          !body.includes("% OF NORMAL"),
          "Expected % OF NORMAL pill to remain hidden when percentOfNormal <= 0"
        );
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F02-02",
    tier: 2,
    feature: "F2",
    title: "Single severe bottleneck drags harmonic composite down vs arithmetic average",
    tags: ["tier2", "harmonic", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_harmonic_penalizes_bottlenecks_more_than_arithmetic\s+\.\.\.\s+ok/
      );

      const app = await openAtStep(
        ctx,
        {
          perfBench: {
            status: "warn",
            singleCoreScore: 1000,
            integerMathScore: 11125,
            floatMathScore: 11125,
            primeScore: 11125,
            vectorScore: 11125,
            compressionScore: 11125,
            encryptionScore: 11125,
            physicsScore: 11125,
            sortingScore: 11125,
            databaseScore: 11125,
            multiCoreScore: 4400,
            compositeScore: 3900,
            baseline: {
              percentOfNormal: 38.2,
              grade: "POOR / UNDERPERFORMING",
            },
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("38.2% OF NORMAL", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("3,900"), "Expected formatted composite score 3,900");
        ctx.assert.ok(body.includes("FAIL"), "Expected FAIL row in ThresholdAuditTable for < 65% composite");
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F02-03",
    tier: 2,
    feature: "F2",
    title: "Missing/nullable optional perf fields and floored fallback boundary",
    tags: ["tier2", "harmonic", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_weighted_harmonic_mean_floored_penalizes_without_zeroing\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_weighted_harmonic_mean_identity_and_constant\s+\.\.\.\s+ok/
      );

      const app = await openAtStep(
        ctx,
        {
          perfBench: {
            shopComparison: null,
            raytracePreviewUrl: null,
            peakCpuTempC: null,
            throttleDropPct: 0.0,
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("PASSMARK WEIGHTED HARMONIC COMPOSITE MARK", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(!body.includes("NaN"));
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F02-04",
    tier: 2,
    feature: "F2",
    title: "Single-channel RAM penalty and PassMark Memory weights ordering boundary",
    tags: ["tier2", "harmonic", "memory", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_memory_mark_harmonic_exact_weights_and_ordering\s+\.\.\.\s+ok/
      );

      const singleCh = ctx.fixtures.singleChannelSlowWifi();
      const app = await openAtStep(
        ctx,
        {
          specs: singleCh.specs,
          perfBench: {
            memoryBandwidthGbS: 16.8,
            memoryLatencyNs: 118.5,
            memoryMark: 1420,
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("118.5 ns", 5000);
        const latencyVerdict = await app.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("tr"));
          const latRow = rows.find((r) => (r.innerText || "").includes("DRAM Pointer-Chase Latency"));
          return latRow ? latRow.innerText : "";
        });
        ctx.assert.match(latencyVerdict, /WARN/, `Expected WARN on DRAM Pointer-Chase Latency > 110ns, got: ${latencyVerdict}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F02-05",
    tier: 2,
    feature: "F2",
    title: "Extreme high-end mark (>120%) clamps BaselineCard bar to 100% cleanly",
    tags: ["tier2", "harmonic", "boundary", "ui"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_weighted_harmonic_mean_large_values_and_small_weights\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_durability_grade_boundaries\s+\.\.\.\s+ok/
      );

      const app = await openAtStep(
        ctx,
        {
          perfBench: {
            compositeScore: 35000,
            baseline: {
              percentOfNormal: 250.0,
              grade: "EXCELLENT",
            },
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("250.0% OF NORMAL", 5000);
        const barWidth = await app.evaluate(() => {
          const cards = Array.from(document.querySelectorAll("div")).filter((el) =>
            (el.innerText || "").includes("250.0% OF NORMAL")
          );
          for (const card of cards) {
            const fill = card.querySelector("div.h-2 > div.h-full");
            if (fill) return fill.style.width;
          }
          return null;
        });
        ctx.assert.equal(barWidth, "100%", `Expected BaselineCard bar width clamped to 100%, got ${barWidth}`);
        const palette = await app.auditSwissPalette();
        ctx.assert.assertSwissPalette(palette);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F3 — UserBenchmark Offline-First Comparison Engine Boundaries
  // =========================================================================
  {
    id: "T2-F03-01",
    tier: 2,
    feature: "F3",
    title: "0% / <30% Raft lower bound on thermal cutoff or integrity fail",
    tags: ["tier2", "userbenchmark", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_gpu_resolution_normalization_and_thermal_cutoff\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_ssd_classification_and_integrity_hard_fail\s+\.\.\.\s+ok/
      );

      const hot = ctx.fixtures.throttlingGamingLaptop();
      const app = await openAtStep(
        ctx,
        {
          specs: hot.specs,
          telemetry: hot.telemetry,
          perfBench: hot.perfBench,
          userBenchmark: {
            ...hot.userBenchmark,
            sourceMode: "offline_calibrated",
            overallVehicleTier: "Raft",
            gamingPct: 0,
            desktopPct: 18.5,
            workstationPct: 12.0,
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("PASSMARK WEIGHTED HARMONIC COMPOSITE MARK", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("Raft"),
          "Expected UserBenchmark UI on PerformanceView to render Raft lower-bound Vehicle Tier"
        );
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F03-02",
    tier: 2,
    feature: "F3",
    title: "100% / >100% UFO upper boundary across Gaming, Desktop, Workstation",
    tags: ["tier2", "userbenchmark", "boundary"],
    async run(ctx) {
      const ws = ctx.fixtures.desktopAcOnly();
      const app = await openAtStep(
        ctx,
        {
          specs: ws.specs,
          telemetry: ws.telemetry,
          userBenchmark: {
            ...ws.userBenchmark,
            sourceMode: "offline_calibrated",
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("PASSMARK WEIGHTED HARMONIC COMPOSITE MARK", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("UFO"),
          "Expected UserBenchmark UI on PerformanceView to render UFO upper-bound Vehicle Tier"
        );
        ctx.assert.ok(
          body.includes("128") && body.includes("116") && body.includes("132"),
          "Expected Gaming (128%), Desktop (116%), and Workstation (132%) UserBenchmark scores to render"
        );
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F03-03",
    tier: 2,
    feature: "F3",
    title: "Exact Vehicle Tier (30/40/60/65/70/80/90/100) and Standing (70/85/105) boundaries",
    tags: ["tier2", "userbenchmark", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_vehicle_tier_exact_boundaries\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_standing_label_exact_boundaries\s+\.\.\.\s+ok/
      );

      const ubRs = ctx.cli.readRepoFile("src-tauri/src/modules/userbenchmark.rs");
      for (const tier of [
        "UFO",
        "Nuclear Submarine",
        "Aircraft Carrier",
        "Battleship",
        "Cruiser",
        "Destroyer",
        "Speedboat",
        "Jet Ski",
        "Raft",
      ]) {
        ctx.assert.ok(ubRs.includes(`"${tier}"`), `Missing Vehicle Tier "${tier}" in userbenchmark.rs`);
      }
      for (const standing of [
        "Above Expectations",
        "As Expected",
        "Below Expectations",
        "Underperforming",
      ]) {
        ctx.assert.ok(ubRs.includes(`"${standing}"`), `Missing Standing label "${standing}" in userbenchmark.rs`);
      }
    },
  },
  {
    id: "T2-F03-04",
    tier: 2,
    feature: "F3",
    title: "Unknown / unrecognized CPU and GPU model graceful fallback",
    tags: ["tier2", "userbenchmark", "boundary", "negative"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_mobile_cpu_matching_and_apple_silicon\s+\.\.\.\s+ok/
      );
      ctx.assert.match(
        cargoRes.stdout,
        /test_embedded_specs_and_camel_case_json_contract\s+\.\.\.\s+ok/
      );

      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        specs: {
          cpuBrand: "Custom Quantum CPU X9000",
          gpus: [
            {
              name: "Unknown Display Adapter",
              vendor: "Unknown",
              vramMb: 512,
              driverVersion: "1.0",
              driverDate: "2026-01-01",
              pnpDeviceId: "PCI\\UNK",
              isDiscrete: false,
            },
          ],
        },
        userBenchmark: {
          sourceMode: "offline_calibrated",
          overallVehicleTier: "Speedboat",
          cpu: {
            detectedModel: "Custom Quantum CPU X9000",
            effectiveSpeedPct: 58.0,
            vehicleTier: "Speedboat",
            standingLabel: "As Expected",
            sourceMode: "offline_calibrated",
          },
          gpu: {
            detectedModel: "Standard Integrated Graphics",
            effectiveSpeedPct: 8.0,
            vehicleTier: "Raft",
            standingLabel: "As Expected",
            sourceMode: "offline_calibrated",
          },
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("Inspection Manifest", 6000);
        await app.clickStep("All-Hardware Specs");
        await app.waitForText("Custom Quantum CPU X9000", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("Unknown Display Adapter"));
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
        const unknown = (await app.getInvokeLog()).filter((e) => e.unknownCommand);
        ctx.assert.equal(unknown.length, 0, `Unknown commands: ${JSON.stringify(unknown)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F03-05",
    tier: 2,
    feature: "F3",
    title: "Offline / network-error offline_calibrated fallback",
    tags: ["tier2", "userbenchmark", "offline", "boundary"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_offline_comparison_and_bounded_live_fallback\s+\.\.\.\s+ok/
      );

      const offline = ctx.fixtures.offlineShopQc();
      const app = await openAtStep(
        ctx,
        {
          specs: offline.specs,
          networkDiagnostics: {
            ...offline.networkDiagnostics,
            status: "warn",
          },
          userBenchmark: {
            ...offline.userBenchmark,
            sourceMode: "offline_calibrated",
          },
        },
        /Perf & Creator/i
      );
      try {
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("PASSMARK WEIGHTED HARMONIC COMPOSITE MARK", 5000);
        const body = await app.getBodyText();
        ctx.assert.match(
          body,
          /offline_calibrated|Offline/i,
          "Expected UserBenchmark UI to display offline calibration standing/mode"
        );
        ctx.assert.ok(
          body.includes("Aircraft Carrier"),
          "Expected UserBenchmark UI to display Aircraft Carrier tier"
        );
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F4 — Expanded IPC Contracts & Boundary Payloads
  // =========================================================================
  {
    id: "T2-F04-01",
    tier: 2,
    feature: "F4",
    title: "All optional/nullable IPC fields null and empty arrays without UI crash",
    tags: ["tier2", "ipc", "boundary", "negative"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          specs: {
            cpuMaxMhz: null,
            cpuL2Kb: null,
            cpuL3Kb: null,
            cpuVirtualization: null,
            ramSlotsTotal: null,
            ramMaxCapacityGb: null,
            wifiSsid: null,
            wifiSignalPct: null,
            wifiRssiDbm: null,
            wifiRadioType: null,
            wifiAntennaWarning: null,
            ramChannelMode: null,
            ramConfigWarning: null,
            gpus: [],
            disks: [],
            volumes: [],
            displays: [],
            networkAdapters: [],
            peripherals: [],
          },
          telemetry: {
            cpuTempC: null,
            cpuPowerW: null,
            gpuTempC: null,
            gpuLoadPct: null,
            gpuPowerW: null,
            fanRpm: null,
            acPlugged: null,
            batteryPercent: null,
            batteryWatts: null,
          },
        },
        /All-Hardware Specs/i
      );
      try {
        await app.waitForText("Complete Hardware Specifications", 5000);
        const headerText = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.ok(
          headerText.includes("Sensor unavailable"),
          `Expected Sensor unavailable in header telemetry, got: ${headerText}`
        );
        ctx.assert.ok(headerText.includes("PWR"), `Expected PWR in header telemetry, got: ${headerText}`);

        await app.clickStep(/Lock, MDM/i);
        await app.waitForText(/Security|MDM/i, 4000);
        await app.clickStep(/Battery & Charging/i);
        await app.waitForText(/Battery/i, 4000);
        await app.clickStep(/System Error Logs/i);
        await app.waitForText(/Error Logs|Log/i, 4000);
        await app.clickStep(/SSD SMART/i);
        await app.waitForText("SSD SMART Health", 4000);

        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors on null/empty payloads: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F04-02",
    tier: 2,
    feature: "F4",
    title: "commandErrors IPC rejection propagation without unhandled UI crashes",
    tags: ["tier2", "ipc", "boundary", "negative"],
    async run(ctx) {
      await ctx.cli.ensureBuild();
      const fixture = ctx.fixtures.makeBaseFixture({
        commandErrors: {
          get_system_specs: "WMI probe failed",
          scan_storage_smart: "IOCTL denied",
          run_storage_benchmark: "Insufficient free space",
        },
      });
      const app = await ctx.browser.openApp(fixture, {
        mountTimeoutMs: 20000,
        mockOptions: { stepDelayMs: 0 },
      });
      try {
        await app.waitForText("Inspection Manifest", 6000);
        await app.waitForText("Spec scan error", 5000);
        await app.clickStep(/All-Hardware Specs/i);
        await app.waitForText("Complete Hardware Specifications", 5000);

        for (let i = 0; i < 6; i += 1) {
          const text = await app.getBodyText();
          if (text.includes("SSD SMART Health")) break;
          await app.clickButton(/Skip Step|Next: Stage/i);
        }
        await app.waitForText("SSD SMART Health", 4000);
        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("Insufficient free space", 5000);

        const actionBtn = (await app.queryAll("button")).find((b) =>
          /Skip Step|Next: Stage/i.test(b.text)
        );
        ctx.assert.ok(
          actionBtn && !actionBtn.disabled,
          "Expected Skip Step or Next: Stage button to remain enabled after IPC error"
        );
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors on commandErrors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F04-03",
    tier: 2,
    feature: "F4",
    title: "types.rs vs src/types.ts v2.3.0 contract and TestStatus serialization alignment",
    tags: ["tier2", "ipc", "contracts"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      const typesTs = ctx.cli.readRepoFile("src/types.ts");

      for (const variant of [
        "pending",
        "running",
        "pass",
        "warn",
        "fail",
        "skipped",
        "notApplicable",
      ]) {
        ctx.assert.ok(
          typesTs.includes(`"${variant}"`),
          `src/types.ts TestStatus missing variant "${variant}"`
        );
      }

      for (const rustStruct of [
        "UserBenchmarkComparison",
        "BatteryDischargeResult",
        "NetworkDiagnosticsReport",
      ]) {
        ctx.assert.ok(
          typesRs.includes(rustStruct),
          `src-tauri/src/types.rs missing ${rustStruct}`
        );
      }

      for (const tsType of [
        "UserBenchmarkComparison",
        "BatteryDischargeResult",
        "NetworkDiagnosticsReport",
        "TouchscreenTestResult",
      ]) {
        ctx.assert.ok(
          typesTs.includes(tsType),
          `src/types.ts missing v2.3.0 IPC contract export ${tsType}`
        );
      }
    },
  },
  {
    id: "T2-F04-04",
    tier: 2,
    feature: "F4",
    title: "HardwareSafetyBounds constants and boundary invariants in types.rs",
    tags: ["tier2", "ipc", "safety", "boundary"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      const num = (name) => {
        const m = typesRs.match(new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*[^=]+=\\s*([0-9_.]+)`));
        ctx.assert.ok(m, `Missing HardwareSafetyBounds constant ${name} in types.rs`);
        return Number(m[1].replace(/_/g, ""));
      };

      const cpuMin = num("CPU_THERMAL_CUTOFF_MIN_C");
      const cpuDef = num("CPU_THERMAL_CUTOFF_DEFAULT_C");
      const cpuMax = num("CPU_THERMAL_CUTOFF_MAX_C");
      ctx.assert.equal(cpuMin, 80);
      ctx.assert.equal(cpuDef, 92);
      ctx.assert.equal(cpuMax, 95);
      ctx.assert.ok(cpuMin <= cpuDef && cpuDef <= cpuMax);

      const gpuMin = num("GPU_THERMAL_CUTOFF_MIN_C");
      const gpuDef = num("GPU_THERMAL_CUTOFF_DEFAULT_C");
      const gpuMax = num("GPU_THERMAL_CUTOFF_MAX_C");
      ctx.assert.ok(
        gpuMin >= 75 && gpuMin < gpuMax,
        `Expected GPU_THERMAL_CUTOFF_MIN_C >= 75 and < gpuMax (${gpuMax}), got ${gpuMin}`
      );
      ctx.assert.ok(
        gpuDef >= gpuMin && gpuDef <= 92 && gpuDef <= gpuMax,
        `Expected GPU_THERMAL_CUTOFF_DEFAULT_C in ${gpuMin}..=min(92, ${gpuMax}), got ${gpuDef}`
      );
      ctx.assert.ok(
        gpuMax >= 92 && gpuMax <= 95,
        `Expected GPU_THERMAL_CUTOFF_MAX_C in 92..=95, got ${gpuMax}`
      );
      ctx.assert.ok(gpuMin <= gpuDef && gpuDef <= gpuMax);

      const qMb = num("SSD_WRITE_BUDGET_QUICK_MB");
      const sMb = num("SSD_WRITE_BUDGET_STD_MB");
      const mMb = num("SSD_WRITE_BUDGET_MAX_MB");
      ctx.assert.equal(qMb, 128);
      ctx.assert.equal(sMb, 256);
      ctx.assert.equal(mMb, 512);
      ctx.assert.ok(qMb < sMb && sMb < mMb);

      ctx.assert.equal(num("SSD_FREE_SPACE_MULTIPLIER"), 4);
      ctx.assert.equal(num("RAM_OS_RESERVE_FLOOR_MB"), 512);
      ctx.assert.equal(num("RAM_OS_RESERVE_PCT"), 22);
      ctx.assert.equal(num("RAM_OS_RESERVE_16GB_CAP_MB"), 1800);
      ctx.assert.equal(num("BATTERY_LOW_SOC_ABORT_PCT"), 15);
      ctx.assert.equal(num("BATTERY_DISCHARGE_MAX_SECS"), 90);
    },
  },
  {
    id: "T2-F04-05",
    tier: 2,
    feature: "F4",
    title: "Event stream 0%..100% progress boundaries (storage:progress & perf:progress)",
    tags: ["tier2", "ipc", "events", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          progressEvents: {
            "storage:progress": [
              { phase: "Start 0%", percent: 0, currentMbS: 0, elapsedSecs: 0, integrityErrors: 0 },
              { phase: "Mid 50%", percent: 50, currentMbS: 2500, elapsedSecs: 1.5, integrityErrors: 0 },
              { phase: "End 100%", percent: 100, currentMbS: 3200, elapsedSecs: 3.0, integrityErrors: 0 },
            ],
          },
        },
        /SSD SMART/i
      );
      try {
        await app.emitTauriEvent("perf:progress", {
          phase: "Boundary 0%",
          percent: 0,
          elapsedSecs: 0,
          cpuUsagePct: 50,
          cpuClockMhz: 3800,
          cpuTempC: 71,
          raytracePreviewUrl: null,
          telemetry: {
            cpuUsagePct: 50,
            cpuClockMhz: 3800,
            cpuTempC: 71,
            cpuPowerW: 20,
            gpuTempC: 55,
            gpuLoadPct: 10,
            gpuPowerW: 5,
            fanRpm: 2500,
            acPlugged: true,
            batteryPercent: 90,
            batteryWatts: 0,
            sensorSource: "Mock",
          },
        });
        await app.emitTauriEvent("perf:progress", {
          phase: "Boundary 100%",
          percent: 100,
          elapsedSecs: 10,
          cpuUsagePct: 100,
          cpuClockMhz: 4100,
          cpuTempC: 71,
          raytracePreviewUrl: null,
          telemetry: {
            cpuUsagePct: 100,
            cpuClockMhz: 4100,
            cpuTempC: 71,
            cpuPowerW: 28,
            gpuTempC: 58,
            gpuLoadPct: 15,
            gpuPowerW: 7,
            fanRpm: 3200,
            acPlugged: true,
            batteryPercent: 90,
            batteryWatts: 0,
            sensorSource: "Mock",
          },
        });
        await app.waitForText("71°C", 3000);

        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("Seq Read", 5000);
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F5 — Safe SSD Write Budget & Free-Space / RAII Cleanup Guard Boundaries
  // =========================================================================
  {
    id: "T2-F05-01",
    tier: 2,
    feature: "F5",
    title: "free_space < max(2048, budget * 4) proactive abort/block guard (backend + StorageView UI)",
    tags: ["tier2", "storage", "safety", "boundary"],
    async run(ctx) {
      const lowSpace = ctx.fixtures.wornNvmeLowSpace();
      const app = await openAtStep(
        ctx,
        {
          commandErrors: lowSpace.commandErrors,
          specs: lowSpace.specs,
          storageSmart: lowSpace.storageSmart,
          storageBench: lowSpace.storageBench,
        },
        /SSD SMART/i
      );
      try {
        await app.waitForText("INSUFFICIENT FREE SPACE", 5000);
        await app.waitForText("2048 MB", 3000);

        const buttons = await app.queryAll("button");
        const runBtn = buttons.find((b) => /Run Direct-IO Audit/i.test(b.text));
        ctx.assert.ok(runBtn && runBtn.disabled, "Expected Run Direct-IO Audit button to be disabled on low disk space");

        const skipBtn = buttons.find((b) => /Skip Step/i.test(b.text));
        ctx.assert.ok(skipBtn && !skipBtn.disabled, "Expected Skip Step button to remain enabled on low disk space");

        const benchCalls = (await app.getInvokeLog()).filter((e) => e.cmd === "run_storage_benchmark");
        ctx.assert.equal(benchCalls.length, 0, "Proactive UI guard must block run_storage_benchmark IPC on low disk space");

        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.ok(
        /SSD_FREE_SPACE_MULTIPLIER|free.*<\s*.*size_mb\s*\*\s*4|required_free/i.test(storageRs),
        "storage.rs must enforce free_space >= max(2048, budget * 4) (SSD_FREE_SPACE_MULTIPLIER) before writing"
      );
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_free_space_guard_enforces_4x_budget_and_2gb_floor\s+\.\.\.\s+ok/
      );
    },
  },
  {
    id: "T2-F05-02",
    tier: 2,
    feature: "F5",
    title: "Exact free_space == max(2048, budget * 4) (2048 MB / 2.0 GB) pass boundary",
    tags: ["tier2", "storage", "safety", "boundary"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          specs: {
            volumes: [
              {
                mount: "C:\\",
                label: "Windows",
                fileSystem: "NTFS",
                totalGb: 256,
                freeGb: 2.0,
              },
            ],
          },
          storageBench: {
            status: "pass",
            preset: "quick",
            testSizeMb: 128,
          },
        },
        /SSD SMART/i
      );
      try {
        const runBtn = (await app.queryAll("button")).find((b) =>
          /Run Direct-IO Audit/i.test(b.text)
        );
        ctx.assert.ok(runBtn && !runBtn.disabled, "Expected Run Direct-IO Audit enabled at exact 2048 MB (2.0 GB) floor");
        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("Seq Read", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          !/INSUFFICIENT FREE SPACE|Insufficient free/i.test(body),
          "Exact 2048 MB floor boundary (2.0 GB for 128 MB) must pass"
        );
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.ok(
        /SSD_FREE_SPACE_MULTIPLIER|free_.*<\s*.*4|required_free/i.test(storageRs),
        "storage.rs must enforce < max(2048, budget * 4) rejection while permitting exact == 2048 MB"
      );
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr}`);
      ctx.assert.match(
        cargoRes.stdout,
        /test_free_space_guard_enforces_4x_budget_and_2gb_floor\s+\.\.\.\s+ok/
      );
    },
  },
  {
    id: "T2-F05-03",
    tier: 2,
    feature: "F5",
    title: "budget <= 128 / 256 / 512 MB clamping on burnin and extreme presets",
    tags: ["tier2", "storage", "safety", "boundary"],
    async run(ctx) {
      const app = await openAtStep(ctx, {}, /SSD SMART/i);
      try {
        const burninLabel = await app.evaluate(() => {
          const selects = Array.from(document.querySelectorAll("select"));
          const presetSel = selects.find((s) =>
            Array.from(s.options).some((o) => o.value === "burnin")
          );
          if (!presetSel) return null;
          const desc = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value"
          );
          desc.set.call(presetSel, "burnin");
          presetSel.dispatchEvent(new Event("input", { bubbles: true }));
          presetSel.dispatchEvent(new Event("change", { bubbles: true }));
          const opt = Array.from(presetSel.options).find((o) => o.value === "burnin");
          return opt ? opt.textContent : null;
        });
        ctx.assert.ok(burninLabel, "Expected burnin <option> in StorageView preset <select>");
        ctx.assert.match(
          burninLabel,
          /512\s*MB/i,
          `Expected StorageView burnin preset label to reflect <= 512 MB safe budget, got "${burninLabel}"`
        );
      } finally {
        await app.close();
      }

      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      ctx.assert.ok(
        /SSD_WRITE_BUDGET_QUICK_MB|SSD_WRITE_BUDGET_MAX_MB|\(\s*512\s*,/.test(storageRs),
        "storage.rs must cap write budgets at <= 128 / 256 / 512 MB"
      );
      ctx.assert.ok(
        !/\(\s*(?:1024|2048|4096)\s*,\s*(?:4096|8192|16384)\s*\)/.test(storageRs),
        "storage.rs must not allocate unsafe 1024/2048/4096 MB write sizes"
      );
    },
  },
  {
    id: "T2-F05-04",
    tier: 2,
    feature: "F5",
    title: "Cancellation / error mid-write RAII TempFileGuard cleanup boundary",
    tags: ["tier2", "storage", "safety", "cancellation"],
    async run(ctx) {
      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      const storageProd = storageRs.split("#[cfg(test)]")[0];
      ctx.assert.ok(
        storageProd.length > 0 && storageProd.length < storageRs.length,
        "Expected production section before #[cfg(test)] in storage.rs"
      );
      ctx.assert.match(storageProd, /struct\s+TempFileGuard/);
      ctx.assert.match(storageProd, /impl\s+Drop\s+for\s+TempFileGuard/);
      ctx.assert.match(storageProd, /remove_file/);
      const guardMatch = storageProd.match(/let\s+_?\w*\s*=\s*TempFileGuard\(/);
      const guardIdx = guardMatch ? guardMatch.index : -1;
      const openIdx = storageProd.indexOf("open_direct_bench_file(guard.path())");
      ctx.assert.ok(guardIdx >= 0 && openIdx > guardIdx, "TempFileGuard binding must be created before opening bench file");

      const app = await openAtStep(
        ctx,
        {
          progressEvents: {
            "storage:progress": Array.from({ length: 10 }, (_, i) => ({
              phase: "1/4 Write",
              percent: (i + 1) * 9,
              currentMbS: 1800,
              elapsedSecs: 0.5,
              integrityErrors: 0,
            })),
          },
        },
        /SSD SMART/i,
        { stepDelayMs: 120 }
      );
      try {
        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("Abort", 3000);
        await app.clickButton("Abort");
        await app.waitForText("Run Direct-IO Audit", 5000);
        const cmds = (await app.getInvokeLog()).map((e) => e.cmd);
        ctx.assert.ok(cmds.includes("cancel_storage_benchmark"), "Expected cancel_storage_benchmark IPC");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T2-F05-05",
    tier: 2,
    feature: "F5",
    title: "Read-only / unwritable volume error handling boundary",
    tags: ["tier2", "storage", "boundary", "negative"],
    async run(ctx) {
      const app = await openAtStep(
        ctx,
        {
          specs: {
            volumes: [
              { mount: "C:\\", label: "Windows", fileSystem: "NTFS", totalGb: 256, freeGb: 100 },
              { mount: "R:\\", label: "ReadOnly", fileSystem: "UDF", totalGb: 4.7, freeGb: 4.7 },
            ],
          },
          commandErrors: {
            run_storage_benchmark:
              "Could not create temp benchmark file: Read-only file system (os error 30).",
          },
        },
        /SSD SMART/i
      );
      try {
        const selected = await app.evaluate(() => {
          const selects = Array.from(document.querySelectorAll("select"));
          const mountSel = selects.find((s) =>
            Array.from(s.options).some((o) => o.value === "R:\\")
          );
          if (!mountSel) return null;
          const desc = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value"
          );
          desc.set.call(mountSel, "R:\\");
          mountSel.dispatchEvent(new Event("input", { bubbles: true }));
          mountSel.dispatchEvent(new Event("change", { bubbles: true }));
          return mountSel.value;
        });
        ctx.assert.equal(selected, "R:\\", "Expected R:\\ volume selected");

        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText(/Read-only file system/i, 5000);

        const benchCalls = (await app.getInvokeLog()).filter(
          (e) => e.cmd === "run_storage_benchmark"
        );
        ctx.assert.ok(benchCalls.length >= 1);
        ctx.assert.equal(benchCalls[benchCalls.length - 1].args?.targetMount, "R:\\");

        const skipBtn = (await app.queryAll("button")).find((b) =>
          /Skip Step/i.test(b.text)
        );
        ctx.assert.ok(skipBtn && !skipBtn.disabled, "Expected Skip Step enabled after read-only volume error");
        const errs = await app.getPageErrors();
        ctx.assert.equal(errs.length, 0, `Unexpected page errors: ${JSON.stringify(errs)}`);
      } finally {
        await app.close();
      }
    },
  },
];
