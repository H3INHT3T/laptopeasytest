function syncFixtureCaveat1Fields(fixture) {
  if (fixture.batteryDischarge && !fixture.batteryDischarge.status) {
    fixture.batteryDischarge.status =
      fixture.batteryDischarge.verdict === "NORMAL"
        ? "pass"
        : fixture.batteryDischarge.verdict === "NOT_APPLICABLE"
        ? "notApplicable"
        : fixture.batteryDischarge.verdict === "ABNORMAL"
        ? "fail"
        : "warn";
  }
  if (fixture.networkDiagnostics && !fixture.networkDiagnostics.status) {
    fixture.networkDiagnostics.status =
      fixture.networkDiagnostics.verdict === "PASS" ? "pass" : "warn";
  }
  if (fixture.userBenchmark && !fixture.userBenchmark.sourceMode) {
    fixture.userBenchmark.sourceMode = "offline_calibrated";
  }
  if (fixture.progressEvents && Array.isArray(fixture.progressEvents["battery:discharge"])) {
    fixture.progressEvents["battery:discharge"] = fixture.progressEvents["battery:discharge"].map(
      (evt) => ({
        chargeDropPct: evt.chargeDropPct ?? evt.maxStepDropPct ?? 0.2,
        note: evt.note ?? evt.phase ?? "Sampling discharge telemetry",
        ...evt,
      })
    );
  }
  return fixture;
}

async function navigateToStage(app, modelText, targetHeadingRegex) {
  await app.waitForText(modelText, 6000);
  await app.clickButton("Begin Stage 01");

  for (let i = 0; i < 16; i += 1) {
    const bodyText = await app.getBodyText();
    if (targetHeadingRegex.test(bodyText)) {
      return;
    }

    const action = await app.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const isVisible = (b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
      };
      const enabled = buttons.filter((b) => isVisible(b) && !b.disabled);
      const getLabel = (b) => (b.textContent || b.innerText || "").replace(/\s+/g, " ").trim();
      const skip = enabled.find((b) => /skip step/i.test(getLabel(b)));
      if (skip) return "skip";
      const next = enabled.find((b) => /^next: stage \d+/i.test(getLabel(b)));
      if (next) return "next";
      return "none";
    });

    if (action === "skip") {
      await app.clickButton("Skip Step");
    } else if (action === "next") {
      await app.clickButton(/^Next: Stage \d+/);
    } else {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  const finalBody = await app.getBodyText();
  if (!targetHeadingRegex.test(finalBody)) {
    throw new Error(`Failed to reach stage matching ${String(targetHeadingRegex)} within 16 steps.`);
  }
}

export const tests = [
  // =========================================================================
  // F1: Windows GNU cargo test & toolchain build fix
  // =========================================================================
  {
    id: "T1-F01-01",
    tier: 1,
    feature: "F1",
    title: "cargo test compiles and passes all unit tests on Windows GNU without .rsrc/CRT errors",
    tags: ["tier1", "cli", "cargo"],
    async run(ctx) {
      const res = await ctx.cli.runCargoTest();
      ctx.assert.equal(
        res.ok,
        true,
        `cargo test failed (exit=${res.exitCode}): ${res.stderr || res.stdout}`
      );
      const combined = `${res.stdout}\n${res.stderr}`;
      ctx.assert.match(combined, /test result:\s*ok\.\s*\d+\s*passed;\s*0\s*failed/i);
      const passedCounts = [...combined.matchAll(/(\d+)\s+passed;\s*0\s+failed/gi)].map((m) =>
        Number(m[1])
      );
      const totalPassed = passedCounts.reduce((acc, n) => acc + n, 0);
      ctx.assert.ok(totalPassed >= 1, `Expected at least 1 passing Rust unit test, got ${totalPassed}`);
    },
  },
  {
    id: "T1-F01-02",
    tier: 1,
    feature: "F1",
    title: "cargo check validates src-tauri/Cargo.toml with zero compilation errors",
    tags: ["tier1", "cli", "cargo"],
    async run(ctx) {
      const res = await ctx.cli.runCargoCheck();
      ctx.assert.equal(
        res.ok,
        true,
        `cargo check failed (exit=${res.exitCode}): ${res.stderr || res.stdout}`
      );
      ctx.assert.equal(res.exitCode, 0);
    },
  },
  {
    id: "T1-F01-03",
    tier: 1,
    feature: "F1",
    title: "Frontend build (dist/index.html + assets) is valid and loadable",
    tags: ["tier1", "cli", "build"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr || buildRes.stdout}`);
      const indexHtml = ctx.cli.readRepoFile("dist/index.html");
      ctx.assert.ok(indexHtml.includes("<div id=\"root\""), "dist/index.html missing #root mount");
      ctx.assert.match(indexHtml, /assets\/[^"']+\.js/, "dist/index.html missing bundled JS asset reference");
    },
  },
  {
    id: "T1-F01-04",
    tier: 1,
    feature: "F1",
    title: "src-tauri/build.rs maintains Windows GNU debug test manifest linkage, WebView2Loader copy, and release UAC opt-out",
    tags: ["tier1", "static", "toolchain"],
    async run(ctx) {
      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      ctx.assert.ok(buildRs.includes('target_env == "gnu"'), "build.rs missing target_env == gnu guard");
      ctx.assert.ok(buildRs.includes("!is_release"), "build.rs missing !is_release debug test guard");
      ctx.assert.ok(buildRs.includes("libresource.a"), "build.rs missing libresource.a link-arg handling");
      ctx.assert.ok(buildRs.includes("cargo:rustc-link-arg="), "build.rs missing cargo:rustc-link-arg");
      ctx.assert.ok(buildRs.includes("WebView2Loader.dll"), "build.rs missing WebView2Loader.dll deps copy");
      ctx.assert.ok(buildRs.includes("LAPTOPBENCH_NO_ELEVATE"), "build.rs missing LAPTOPBENCH_NO_ELEVATE support");
      ctx.assert.ok(buildRs.includes("tauri_build::build()"), "build.rs missing tauri_build::build()");
    },
  },
  {
    id: "T1-F01-05",
    tier: 1,
    feature: "F1",
    title: "Debug binary --self-test executes cleanly and exits 0 with SELF-TESTS PASSED",
    tags: ["tier1", "cli", "selftest"],
    async run(ctx) {
      const res = await ctx.cli.runSelfTest();
      ctx.assert.equal(
        res.ok,
        true,
        `--self-test failed (exit=${res.exitCode}): ${res.stderr || res.stdout}`
      );
      ctx.assert.ok(res.stdout.includes("[PASS]"), "Expected [PASS] markers in --self-test stdout");
      ctx.assert.match(res.stdout, /SELF-TESTS PASSED/i);
    },
  },

  // =========================================================================
  // F2: PassMark-style Weighted Harmonic Mean scoring calibration
  // =========================================================================
  {
    id: "T1-F02-01",
    tier: 1,
    feature: "F2",
    title: "Rust baselines::tests harmonic unit tests pass under cargo test",
    tags: ["tier1", "cli", "cargo"],
    async run(ctx) {
      const res = await ctx.cli.runCargoTest();
      ctx.assert.equal(res.ok, true, `cargo test failed: ${res.stderr || res.stdout}`);
      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      for (const testFn of [
        "test_weighted_harmonic_mean_identity_and_constant",
        "test_harmonic_penalizes_bottlenecks_more_than_arithmetic",
        "test_memory_mark_harmonic_exact_weights_and_ordering",
        "test_office_creator_composite_harmonic",
        "test_durability_grade_boundaries",
      ]) {
        ctx.assert.ok(baselinesRs.includes(testFn), `Missing unit test ${testFn} in baselines.rs`);
      }
      ctx.assert.match(res.stdout, /test result:\s*ok\.\s*\d+\s*passed;\s*0\s*failed/i);
    },
  },
  {
    id: "T1-F02-02",
    tier: 1,
    feature: "F2",
    title: "baselines.rs defines exact PassMark 11 Memory Mark weights and 9-subtest CPU harmonic weights",
    tags: ["tier1", "static", "calibration"],
    async run(ctx) {
      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      for (const token of [
        "W_MEM_DATABASE",
        "0.0388",
        "W_MEM_READ_CACHED",
        "12.8505",
        "W_MEM_READ_UNCACHED",
        "5.8283",
        "W_MEM_WRITE",
        "3.5454",
        "W_MEM_AVAILABLE_RAM",
        "0.00002",
        "W_MEM_LATENCY",
        "2.2560",
        "W_MEM_THREADED",
        "7.9271",
        "MEMORY_MARK_CONSTANT",
        "0.14",
        "PASSMARK_CPU_WEIGHTS",
        "weighted_harmonic_mean",
        "1_000_000.0 / metrics.latency_ns",
      ]) {
        ctx.assert.ok(baselinesRs.includes(token), `Missing calibration symbol/weight "${token}" in baselines.rs`);
      }
    },
  },
  {
    id: "T1-F02-03",
    tier: 1,
    feature: "F2",
    title: "baselines.rs exposes harmonic aggregators, durability grades, and baseline ratio labels",
    tags: ["tier1", "static", "calibration"],
    async run(ctx) {
      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      for (const fnName of [
        "pub fn compute_cpu_mark_harmonic",
        "pub fn compute_memory_mark_harmonic",
        "pub fn compute_office_mark_harmonic",
        "pub fn compute_creator_mark_harmonic",
        "pub fn compute_composite_mark_harmonic",
        "pub fn compute_durability_grade",
        "fn grade_from_ratio",
      ]) {
        ctx.assert.ok(baselinesRs.includes(fnName), `Missing function ${fnName} in baselines.rs`);
      }
      for (const label of ["EXCELLENT", "NORMAL", "BELOW NORMAL", "POOR / UNDERPERFORMING"]) {
        ctx.assert.ok(baselinesRs.includes(label), `Missing grade label ${label} in baselines.rs`);
      }
    },
  },
  {
    id: "T1-F02-04",
    tier: 1,
    feature: "F2",
    title: "perf_bench.rs uses Weighted Harmonic Mean aggregators instead of linear arithmetic score sums",
    tags: ["tier1", "static", "calibration"],
    async run(ctx) {
      const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
      const usesHarmonic =
        /baselines::compute_.*_harmonic|weighted_harmonic_mean/.test(perfRs);
      ctx.assert.equal(
        usesHarmonic,
        true,
        "perf_bench.rs must compute CPU/Memory/Office/Creator/Composite marks via baselines Weighted Harmonic Mean instead of linear arithmetic sums"
      );
    },
  },
  {
    id: "T1-F02-05",
    tier: 1,
    feature: "F2",
    title: "PerformanceView displays composite, office, creator, memory marks, BaselineCard, and 14 subtests with Swiss palette",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.healthyUltrabook());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ThinkPad X1 Carbon Gen 11", /360° All-Scope Performance/i);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("16,450", 5000);

        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("CALIBRATION BASELINE"), "Missing BaselineCard header");
        ctx.assert.ok(body.includes("108.4% OF NORMAL"), "Missing BaselineCard percentOfNormal");
        ctx.assert.ok(body.includes("EXCELLENT"), "Missing EXCELLENT baseline grade");
        ctx.assert.match(body, /PASSMARK WEIGHTED HARMONIC COMPOSITE MARK/i, "Missing Composite Mark plate");
        ctx.assert.ok(body.includes("17,120"), "Missing Office Scope mark");
        ctx.assert.ok(body.includes("14,950"), "Missing Creator & AI mark");
        ctx.assert.ok(body.includes("16,890"), "Missing CPU Multi-Core mark");
        ctx.assert.ok(body.includes("3,180"), "Missing Memory Mark");
        ctx.assert.match(body, /14-Category Subtest Breakdown/i, "Missing 14-Category Subtest Breakdown");

        const invokeLog = await app.getInvokeLog();
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_performance_benchmark" && e.ok),
          "Expected run_performance_benchmark IPC invocation"
        );
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);

        const errors = await app.getPageErrors();
        ctx.assert.equal(errors.length, 0, `Unexpected page errors: ${JSON.stringify(errors)}`);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F3: UserBenchmark offline-first comparison & Vehicle Tiers
  // =========================================================================
  {
    id: "T1-F03-01",
    tier: 1,
    feature: "F3",
    title: "Rust userbenchmark::tests cover Vehicle Tiers, mobile CPU/GPU/SSD/RAM calibration, and offline fallback",
    tags: ["tier1", "cli", "cargo"],
    async run(ctx) {
      const res = await ctx.cli.runCargoTest();
      ctx.assert.equal(res.ok, true, `cargo test failed: ${res.stderr || res.stdout}`);
      const ubRs = ctx.cli.readRepoFile("src-tauri/src/modules/userbenchmark.rs");
      const modTests = [...ubRs.matchAll(/fn\s+(test_[a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      ctx.assert.ok(modTests.length >= 8, `Expected >= 8 unit tests in userbenchmark.rs, found ${modTests.length}`);
      ctx.assert.match(res.stdout, /test result:\s*ok\.\s*\d+\s*passed;\s*0\s*failed/i);
    },
  },
  {
    id: "T1-F03-02",
    tier: 1,
    feature: "F3",
    title: "userbenchmark.rs defines all 9 Vehicle Tiers, 4 standings, offline_calibrated mode, and bounded 800ms live probe",
    tags: ["tier1", "static", "ipc"],
    async run(ctx) {
      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.ok(libRs.includes("compare_userbenchmark"), "lib.rs missing compare_userbenchmark registration");

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
        ctx.assert.ok(ubRs.includes(`"${standing}"`), `Missing standing label "${standing}" in userbenchmark.rs`);
      }
      ctx.assert.ok(ubRs.includes("offline_calibrated"), "Missing offline_calibrated mode");
      ctx.assert.ok(ubRs.includes("LIVE_LOOKUP_TIMEOUT_MS") && ubRs.includes("800"), "Missing 800ms live probe cap");
    },
  },
  {
    id: "T1-F03-03",
    tier: 1,
    feature: "F3",
    title: "PerformanceView invokes compare_userbenchmark and displays Vehicle Tier, Gaming/Desktop/Workstation %, and Same-Class Standing",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.healthyUltrabook());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ThinkPad X1 Carbon Gen 11", /360° All-Scope Performance/i);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("16,450", 5000);

        const invokeLog = await app.getInvokeLog();
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "compare_userbenchmark" && e.ok),
          "Expected PerformanceView to invoke compare_userbenchmark IPC command"
        );

        const body = await app.getBodyText();
        ctx.assert.match(body, /Aircraft Carrier/i, "Expected UserBenchmark Vehicle Tier 'Aircraft Carrier' in UI");
        ctx.assert.match(body, /34\.2%|34%/, "Expected UserBenchmark Gaming % in UI");
        ctx.assert.match(body, /91\.5%|92%/, "Expected UserBenchmark Desktop % in UI");
        ctx.assert.match(body, /76\.4%|76%/, "Expected UserBenchmark Workstation % in UI");
        ctx.assert.match(body, /Above Expectations/i, "Expected Same-Class Standing 'Above Expectations' in UI");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F03-04",
    tier: 1,
    feature: "F3",
    title: "Degraded laptop renders Raft Vehicle Tier, Underperforming standing, and service recommendation in Swiss Light UI",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.throttlingGamingLaptop());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ROG Zephyrus G16 GU603", /360° All-Scope Performance/i);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("9,850", 5000);

        const body = await app.getBodyText();
        ctx.assert.match(body, /\bRaft\b/, "Expected 'Raft' Vehicle Tier for severely throttling laptop");
        ctx.assert.match(body, /Underperforming/i, "Expected 'Underperforming' UserBenchmark standing");
        ctx.assert.match(body, /thermal paste|cooling|service/i, "Expected plain-language thermal service recommendation");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F03-05",
    tier: 1,
    feature: "F3",
    title: "Offline shop QC displays UserBenchmark Aircraft Carrier rating without internet connectivity",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.offlineShopQc());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ThinkPad X1 Carbon Gen 11", /360° All-Scope Performance/i);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("16,450", 5000);

        const body = await app.getBodyText();
        ctx.assert.match(body, /Aircraft Carrier/i, "Expected offline UserBenchmark Vehicle Tier 'Aircraft Carrier'");
        ctx.assert.match(body, /offline/i, "Expected offline calibration indicator in UserBenchmark display");
        const errors = await app.getPageErrors();
        ctx.assert.equal(errors.length, 0);
        const invokeLog = await app.getInvokeLog();
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F4: Expanded IPC types & contracts + browser mock round-trips
  // =========================================================================
  {
    id: "T1-F04-01",
    tier: 1,
    feature: "F4",
    title: "src-tauri/src/types.rs defines v2.3.0 safety constants and camelCase IPC contracts",
    tags: ["tier1", "static", "contracts"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      for (const token of [
        "CPU_THERMAL_CUTOFF_DEFAULT_C",
        "GPU_THERMAL_CUTOFF_DEFAULT_C",
        "SSD_WRITE_BUDGET_QUICK_MB",
        "SSD_WRITE_BUDGET_STD_MB",
        "SSD_WRITE_BUDGET_MAX_MB",
        "SSD_FREE_SPACE_MULTIPLIER",
        "RAM_OS_RESERVE_FLOOR_MB",
        "RAM_OS_RESERVE_PCT",
        "BATTERY_LOW_SOC_ABORT_PCT",
        "BATTERY_DISCHARGE_MAX_SECS",
        "HardwareSafetyBounds",
        "UserBenchmarkComparison",
        "UserBenchmarkComponentRating",
        "BatteryDischargeProgress",
        "BatteryDischargeResult",
        "NetworkDiagnosticsReport",
        "source_mode",
        "charge_drop_pct",
        "pub note: String",
        "pub status: TestStatus",
      ]) {
        ctx.assert.ok(typesRs.includes(token), `Missing v2.3.0 contract symbol "${token}" in types.rs`);
      }
    },
  },
  {
    id: "T1-F04-02",
    tier: 1,
    feature: "F4",
    title: "src-tauri/src/lib.rs registers all 46 baseline + v2.3.0 Tauri IPC commands",
    tags: ["tier1", "static", "ipc"],
    async run(ctx) {
      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      const handlerMatch = libRs.match(/tauri::generate_handler!\s*\[([\s\S]*?)\]/);
      ctx.assert.ok(handlerMatch, "lib.rs missing tauri::generate_handler![...] block");
      const handlerBody = handlerMatch[1]
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const registeredCommands = new Set(
        handlerBody
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => entry.split("::").pop())
      );

      const baselineCommands = [
        "get_system_specs",
        "run_security_audit",
        "get_battery_health",
        "start_battery_monitor",
        "stop_battery_monitor",
        "run_battery_sag_pulse",
        "cancel_battery_sag_pulse",
        "list_usb_devices",
        "start_usb_monitor",
        "stop_usb_monitor",
        "save_qc_session",
        "load_qc_session",
        "clear_qc_session",
        "scan_error_logs",
        "scan_storage_smart",
        "run_storage_benchmark",
        "cancel_storage_benchmark",
        "run_ram_stress",
        "cancel_ram_stress",
        "detect_biometrics_hardware",
        "trigger_biometric_prompt",
        "start_keyboard_capture",
        "stop_keyboard_capture",
        "run_performance_benchmark",
        "cancel_performance_benchmark",
        "list_gpu_adapters",
        "run_gpu_stress",
        "cancel_gpu_stress",
        "run_vram_test",
        "cancel_vram_test",
        "run_power_torture",
        "cancel_power_torture",
        "run_shelf_burnin",
        "cancel_shelf_burnin",
        "get_shop_model_comparison",
        "list_shop_history",
        "export_shop_history",
        "import_shop_history",
        "sample_live_telemetry",
        "load_shop_profile",
        "save_shop_profile",
        "export_qc_report",
      ];
      const v23Commands = [
        "compare_userbenchmark",
        "run_battery_discharge_test",
        "cancel_battery_discharge_test",
        "run_network_diagnostics",
      ];

      for (const cmd of [...baselineCommands, ...v23Commands]) {
        ctx.assert.ok(
          registeredCommands.has(cmd),
          `lib.rs generate_handler! missing IPC command "${cmd}"`
        );
      }
    },
  },
  {
    id: "T1-F04-03",
    tier: 1,
    feature: "F4",
    title: "src/types.ts defines touchscreen step ID and TypeScript interfaces matching Rust v2.3.0 contracts",
    tags: ["tier1", "static", "contracts"],
    async run(ctx) {
      const typesTs = ctx.cli.readRepoFile("src/types.ts");
      ctx.assert.ok(typesTs.includes('"touchscreen"'), 'src/types.ts StepModuleId missing "touchscreen"');
      for (const iface of [
        "UserBenchmarkComparison",
        "BatteryDischargeResult",
        "BatteryDischargeProgress",
        "NetworkDiagnosticsReport",
        "TouchscreenTestResult",
      ]) {
        ctx.assert.ok(typesTs.includes(iface), `src/types.ts missing interface ${iface}`);
      }
    },
  },
  {
    id: "T1-F04-04",
    tier: 1,
    feature: "F4",
    title: "Tauri IPC mock handles v2.3.0 commands, battery:discharge events, Caveat #1 fields, and setFixturePatch",
    tags: ["tier1", "ui", "ipc-mock"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.healthyUltrabook());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 5000);

        const roundTrip = await app.evaluate(async () => {
          const captured = [];
          const cbId = window.__TAURI_INTERNALS__.transformCallback((evt) => {
            captured.push(evt.payload);
          });
          await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
            event: "battery:discharge",
            target: { kind: "Any" },
            handler: cbId,
          });

          const ub = await window.__TAURI_INTERNALS__.invoke("compare_userbenchmark", {});
          const bat = await window.__TAURI_INTERNALS__.invoke("run_battery_discharge_test", {});
          await window.__TAURI_INTERNALS__.invoke("cancel_battery_discharge_test", {});
          const net = await window.__TAURI_INTERNALS__.invoke("run_network_diagnostics", {});

          window.__TAURI_MOCK__.setFixturePatch({
            networkDiagnostics: { status: "warn", verdict: "WARN", linkSpeedMbps: 54 },
          });
          const netPatched = await window.__TAURI_INTERNALS__.invoke("run_network_diagnostics", {});

          return { ub, bat, net, netPatched, captured };
        });

        ctx.assert.equal(roundTrip.ub.overallVehicleTier, "Aircraft Carrier");
        ctx.assert.equal(roundTrip.ub.sourceMode, "offline_calibrated");
        ctx.assert.equal(roundTrip.bat.verdict, "NORMAL");
        ctx.assert.equal(roundTrip.bat.status, "pass");
        ctx.assert.equal(roundTrip.net.verdict, "PASS");
        ctx.assert.equal(roundTrip.net.status, "pass");
        ctx.assert.equal(roundTrip.netPatched.verdict, "WARN");
        ctx.assert.equal(roundTrip.netPatched.linkSpeedMbps, 54);

        ctx.assert.ok(roundTrip.captured.length >= 2, "Expected >= 2 battery:discharge progress events");
        for (const evt of roundTrip.captured) {
          ctx.assert.equal(typeof evt.chargeDropPct, "number");
          ctx.assert.equal(typeof evt.note, "string");
          ctx.assert.equal(typeof evt.durationSecs, "number");
        }

        const invokeLog = await app.getInvokeLog();
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        const errors = await app.getPageErrors();
        ctx.assert.equal(errors.length, 0);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F04-05",
    tier: 1,
    feature: "F4",
    title: "IPC mock cleanly surfaces commandErrors, telemetrySequence updates, and emitTauriEvent delivery",
    tags: ["tier1", "ui", "ipc-mock"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const base = ctx.fixtures.healthyUltrabook();
      const fixture = syncFixtureCaveat1Fields(
        ctx.fixtures.makeBaseFixture({
          commandErrors: {
            run_security_audit: "Mocked security audit failure",
          },
          telemetrySequence: [
            { ...base.telemetry, cpuTempC: 61.0, cpuClockMhz: 3800 },
            { ...base.telemetry, cpuTempC: 73.0, cpuClockMhz: 4100 },
          ],
        })
      );

      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await app.waitForText("ThinkPad X1 Carbon Gen 11", 5000);
        await app.waitForText("61°C", 3000);

        const nextSnap = await app.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke("sample_live_telemetry", {})
        );
        ctx.assert.equal(nextSnap.cpuTempC, 73.0);

        await app.emitTauriEvent("perf:progress", {
          phase: "Mock Telemetry Burst",
          percent: 55,
          elapsedSecs: 2.0,
          cpuUsagePct: 88,
          cpuClockMhz: 4400,
          cpuTempC: 79.0,
          raytracePreviewUrl: null,
          telemetry: { ...base.telemetry, cpuTempC: 79.0, cpuClockMhz: 4400 },
        });
        await app.waitForText("79°C", 3000);

        const invokeLog = await app.getInvokeLog();
        const secEntry = invokeLog.find((e) => e.cmd === "run_security_audit");
        ctx.assert.ok(secEntry && secEntry.ok === false, "Expected run_security_audit mock error logged");
        ctx.assert.match(secEntry.error, /Mocked security audit failure/);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F5: Safe SSD write budget & free-space / RAII cleanup guard
  // =========================================================================
  {
    id: "T1-F05-01",
    tier: 1,
    feature: "F5",
    title: "storage.rs caps SSD benchmark write budgets to <=128/256/512 MB (never 1024/2048/4096 MB)",
    tags: ["tier1", "static", "safety"],
    async run(ctx) {
      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      const storageProd = storageRs.split("#[cfg(test)]")[0];
      const hasLegacyBudgets =
        /\(\s*(1024|2048|4096)\s*,/.test(storageProd) ||
        /\btotal_budget_mb\s*:\s*(1024|2048|4096)\b/.test(storageProd);
      ctx.assert.equal(
        hasLegacyBudgets,
        false,
        "storage.rs production code must not contain legacy 1024/2048/4096 MB SSD write budget literals"
      );
      const usesSafeBudget =
        storageProd.includes("SSD_WRITE_BUDGET_") ||
        (/\b128\b/.test(storageProd) && /\b256\b/.test(storageProd) && /\b512\b/.test(storageProd));
      ctx.assert.equal(
        usesSafeBudget,
        true,
        "storage.rs must enforce safe <=128/256/512 MB SSD write budgets instead of 1024/2048/4096 MB"
      );
    },
  },
  {
    id: "T1-F05-02",
    tier: 1,
    feature: "F5",
    title: "storage.rs validates free disk space >= budget * 4 before creating temp benchmark file",
    tags: ["tier1", "static", "safety"],
    async run(ctx) {
      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      const hasFreeSpaceGuard =
        storageRs.includes("SSD_FREE_SPACE_MULTIPLIER") ||
        (/free.*space|available_space/i.test(storageRs) && /\*\s*4\b/.test(storageRs));
      ctx.assert.equal(
        hasFreeSpaceGuard,
        true,
        "storage.rs must verify free disk space >= budget * 4 (SSD_FREE_SPACE_MULTIPLIER) before writing"
      );
    },
  },
  {
    id: "T1-F05-03",
    tier: 1,
    feature: "F5",
    title: "storage.rs implements RAII TempFileGuard with Drop cleanup constructed prior to writes",
    tags: ["tier1", "static", "safety"],
    async run(ctx) {
      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      const storageProd = storageRs.split("#[cfg(test)]")[0];
      ctx.assert.ok(storageProd.includes("struct TempFileGuard"), "Missing TempFileGuard struct");
      ctx.assert.ok(storageProd.includes("impl Drop for TempFileGuard"), "Missing Drop impl for TempFileGuard");
      ctx.assert.ok(storageProd.includes("remove_file"), "TempFileGuard::drop must remove temp file");
      const benchIdx = storageProd.indexOf("pub fn run_storage_benchmark(");
      ctx.assert.ok(benchIdx >= 0, "Missing run_storage_benchmark function");
      const benchBody = storageProd.slice(benchIdx);
      const guardPos = benchBody.indexOf("TempFileGuard(");
      const firstOpenPos = benchBody.indexOf("open_direct_bench_file(");
      const guardedOpenPos = benchBody.indexOf("open_direct_bench_file(guard.path())");
      ctx.assert.ok(
        guardPos > 0 && firstOpenPos > guardPos && guardedOpenPos >= firstOpenPos,
        "TempFileGuard must be created before any open_direct_bench_file(guard.path()) call"
      );
    },
  },
  {
    id: "T1-F05-04",
    tier: 1,
    feature: "F5",
    title: "StorageView presets advertise safe <=512 MB write budgets and execute Direct-IO audit cleanly",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.healthyUltrabook());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ThinkPad X1 Carbon Gen 11", /SSD SMART Health/i);

        const optionsText = await app.evaluate(() =>
          Array.from(document.querySelectorAll("select option")).map((o) => o.textContent || "")
        );
        const joined = optionsText.join(" | ");
        ctx.assert.ok(
          !/\b(1|2|4)\s*GB\b/i.test(joined) && /\b128\s*MB\b/i.test(joined),
          `StorageView preset options must advertise safe <=512 MB budgets (e.g. 128 MB / 256 MB / 512 MB), found: ${joined}`
        );

        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("6120", 5000);
        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("3250"), "Missing Seq Write speed");
        ctx.assert.ok(body.includes("0 ERR"), "Missing 0 ERR surface integrity");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F05-05",
    tier: 1,
    feature: "F5",
    title: "wornNvmeLowSpace surfaces low-space write guard error cleanly and keeps Skip Step enabled",
    tags: ["tier1", "ui", "browser"],
    async run(ctx) {
      const buildRes = await ctx.cli.ensureBuild();
      ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

      const fixture = syncFixtureCaveat1Fields(ctx.fixtures.wornNvmeLowSpace());
      const app = await ctx.browser.openApp(fixture, {
        mockOptions: { stepDelayMs: 0 },
        mountTimeoutMs: 20000,
      });
      try {
        await navigateToStage(app, "ThinkPad X1 Carbon Gen 11", /SSD SMART Health/i);
        await app.waitForText("WDC PC SN530 256GB", 3000);

        const preBody = await app.getBodyText();
        ctx.assert.ok(preBody.includes("104%"), "Missing 104% wear display");
        ctx.assert.ok(preBody.includes("12"), "Missing 12 media errors display");
        ctx.assert.match(preBody, /INSUFFICIENT FREE SPACE/i, "Missing proactive INSUFFICIENT FREE SPACE guard banner");
        ctx.assert.match(preBody, /2048\s*MB/i, "Missing 2048 MB (4x/floor) free-space guard threshold");
        ctx.assert.match(preBody, /0\.4\s*GB\s*free/i, "Missing 0.4 GB free disk readout");

        const buttons = await app.querySelectorAllInfo("button");
        const runBtn = buttons.find((b) => /Run Direct-IO Audit/i.test(b.text));
        const skipBtn = buttons.find((b) => /^Skip Step$/i.test(b.text));
        ctx.assert.ok(runBtn && runBtn.disabled === true, "Expected Run Direct-IO Audit button to be disabled on low disk space");
        ctx.assert.ok(skipBtn && skipBtn.disabled === false, "Expected Skip Step button to remain enabled");

        const invokeLog = await app.getInvokeLog();
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "run_storage_benchmark"),
          false,
          "run_storage_benchmark must not be invoked when low-space guard blocks execution"
        );
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(preBody);

        await app.clickButton(/^Skip Step$/i);
        await app.waitForText(/Display Check \(MonitorTest/i, 4000);
      } finally {
        await app.close();
      }
    },
  },
];
