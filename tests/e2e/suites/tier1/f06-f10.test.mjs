function withSavedSession(fixture) {
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
  const serial = fixture.specs?.serialNumber || "PF4X9102";
  fixture.savedSession = {
    serialNumber: serial,
    model: fixture.specs?.model || "Test Laptop",
    savedAt: "2026-11-25T18:00:00Z",
    activeStressStage: null,
    stateJson: JSON.stringify({
      unlockedIndex: 15,
      modules: {},
      signoff: {
        portsChecked: false,
        portsNotes: "",
        speakersChecked: false,
        speakersNotes: "",
      },
    }),
  };
  return fixture;
}

async function openAtStep(ctx, fixture, stepRegex) {
  const buildRes = await ctx.cli.ensureBuild();
  ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

  const app = await ctx.browser.openApp(withSavedSession(fixture), {
    mockOptions: { stepDelayMs: 0 },
    mountTimeoutMs: 20000,
  });
  try {
    await app.waitForText(/STAGE 00/i, 6000);
    await app.waitForText("Resume Session", 5000);
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
  // F6: Expanded Storage Bench & DriveDx NVMe SMART Audit
  // =========================================================================
  {
    id: "T1-F06-01",
    tier: 1,
    feature: "F6",
    title: "DriveDx NVMe SMART --self-test passes and StorageView renders SMART counters & Log 0x02 notes",
    tags: ["tier1", "cli", "ui"],
    async run(ctx) {
      const stRes = await ctx.cli.runSelfTest();
      ctx.assert.equal(stRes.ok, true, `--self-test failed: ${stRes.stderr || stRes.stdout}`);
      ctx.assert.ok(stRes.stdout.includes("[PASS] Storage SMART"), "Expected [PASS] Storage SMART in --self-test");

      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /SSD SMART & Speed/i);
      try {
        await app.waitForText("Samsung PM9A1 NVMe 512GB", 4000);
        const body = await app.getBodyText();
        for (const token of ["98%", "2%", "39°C", "410h", "3.4 TB", "Log 0x02"]) {
          ctx.assert.ok(body.includes(token), `Missing SMART detail "${token}" in StorageView`);
        }
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F06-02",
    tier: 1,
    feature: "F6",
    title: "StorageView Direct-IO benchmark streams storage:progress and renders 4K IOPS, P99, and BaselineCard",
    tags: ["tier1", "ui", "ipc"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /SSD SMART & Speed/i);
      try {
        await app.waitForText("Samsung PM9A1 NVMe 512GB", 4000);
        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("6120", 5000);

        const body = await app.getBodyText();
        for (const token of [
          "3250",
          "20,121",
          "53,862",
          "0.14 ms",
          "0 ERR",
        ]) {
          ctx.assert.ok(body.includes(token), `Missing storage bench metric "${token}"`);
        }
        ctx.assert.match(body, /PCIe 4\.0 x4 NVMe SSD/i, 'Missing storage bench class "PCIe 4.0 x4 NVMe SSD"');

        const invokeLog = await app.getInvokeLog();
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_storage_benchmark" && e.ok),
          "Expected run_storage_benchmark IPC invocation"
        );
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F06-03",
    tier: 1,
    feature: "F6",
    title: "DriveDx critical SMART failure (104% wear, 8% spare, 12 media errors) surfaces FAIL diagnostics",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.wornNvmeLowSpace(), /SSD SMART & Speed/i);
      try {
        await app.waitForText("WDC PC SN530 256GB", 4000);
        const body = await app.getBodyText();
        for (const token of ["FAIL", "104%", "12", "158.4 TB", "84 Unsafe Shutdowns"]) {
          ctx.assert.ok(body.includes(token), `Missing critical SMART marker "${token}"`);
        }
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F06-04",
    tier: 1,
    feature: "F6",
    title: "Backend storage.rs / types.rs implements QD32 4K, 70/30 mixed workload, SLC-cache curve, and Log 0x02 fields",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      const combined = `${storageRs}\n${typesRs}`;

      ctx.assert.match(combined, /qd32|queue_depth/i, "Missing QD32 / multi-queue 4K storage benchmark scope");
      ctx.assert.match(combined, /mixed.*70|70.*30|mixed_rw|rand_mixed/i, "Missing 70/30 mixed R/W workload scope");
      ctx.assert.match(combined, /slc/i, "Missing SLC-cache sustained throughput curve scope");
      ctx.assert.match(combined, /available_spare/i, "Missing DriveDx Log 0x02 available spare field");
      ctx.assert.match(combined, /unsafe_shutdowns/i, "Missing DriveDx Log 0x02 unsafe shutdowns field");
    },
  },
  {
    id: "T1-F06-05",
    tier: 1,
    feature: "F6",
    title: "StorageView displays <=512 MB safe write-budget presets and expanded QD32/Mixed/SLC scopes",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /SSD SMART & Speed/i);
      try {
        await app.waitForText("Samsung PM9A1 NVMe 512GB", 4000);
        const options = await app.evaluate(() =>
          Array.from(document.querySelectorAll("select option")).map((o) => o.textContent || "")
        );
        const joined = options.join(" | ");
        ctx.assert.equal(
          /\b(1|2|4)\s*GB\b/i.test(joined),
          false,
          `StorageView preset options must not advertise unsafe 1GB/2GB/4GB writes: ${joined}`
        );

        await app.clickButton("Run Direct-IO Audit");
        await app.waitForText("6120", 5000);
        const body = await app.getBodyText();
        ctx.assert.match(body, /QD32|Mixed|SLC/i, "Expected expanded QD32 / Mixed / SLC metrics in StorageView");
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F7: Expanded RAM Stress (TestMem5 Kernels) & OS Headroom
  // =========================================================================
  {
    id: "T1-F07-01",
    tier: 1,
    feature: "F7",
    title: "CLI --self-test verifies native TestMem5 RAM pattern verifier with 0 errors",
    tags: ["tier1", "cli"],
    async run(ctx) {
      const stRes = await ctx.cli.runSelfTest();
      ctx.assert.equal(stRes.ok, true, `--self-test failed: ${stRes.stderr || stRes.stdout}`);
      ctx.assert.ok(
        stRes.stdout.includes("[PASS] RAM pattern verifier") && stRes.stdout.includes("0 errors"),
        `Missing RAM pattern verifier PASS output:\n${stRes.stdout}`
      );
    },
  },
  {
    id: "T1-F07-02",
    tier: 1,
    feature: "F7",
    title: "RamTestView executes run_ram_stress, handles ram:progress, and renders 6 TM5 stages and BaselineCard",
    tags: ["tier1", "ui", "ipc"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /RAM Stress/i);
      try {
        await app.waitForText("RAM Continuous Durability Audit", 4000);
        const preBody = await app.getBodyText();
        for (const kernel of [
          "Test0: RefreshStable (Retention)",
          "Test1: SimpleTest Mode 0 Constant",
          "Test2: SimpleTest Mode 1 (1MB L3 Edge)",
          "Test3: SimpleTest Mode 1 (256 Bank Stride)",
          "Test4: MirrorMove (64-bit Bus)",
          "Test5: SimpleTest Mode 2 PRNG (Prime 257)",
          "Test6: MirrorMove128 (128-bit SIMD)",
          "Test7: BlockMove (64B Cache-Line)",
        ]) {
          ctx.assert.ok(preBody.includes(kernel), `Missing v2.3.0 MT0 kernel "${kernel}"`);
        }

        await app.clickButton("Start Continuous Test");
        await app.waitForText("24.0 GB", 5000);

        const body = await app.getBodyText();
        for (const token of [
          "44.8 / 39.2 GB/s",
          "8192 / 16384 MB",
          "3604 MB",
          "Walking 1s/0s",
          "Prime Stride & 256-Byte",
          "BlockMove 64MB",
          "RefreshStable Hold",
          "MirrorMove 128",
          "Checkerboard PRNG",
        ]) {
          ctx.assert.ok(body.includes(token), `Missing RAM test display token "${token}"`);
        }
        ctx.assert.match(body, /LPDDR5-6400 Dual-Channel/i, 'Missing RAM baseline class "LPDDR5-6400 Dual-Channel"');

        const invokeLog = await app.getInvokeLog();
        const ramCall = invokeLog.find((e) => e.cmd === "run_ram_stress");
        ctx.assert.ok(ramCall && ramCall.ok, "Expected run_ram_stress IPC call");
        ctx.assert.equal(ramCall.args.preset, "quick");
        ctx.assert.equal(ramCall.args.memoryPercent, 65);
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F07-03",
    tier: 1,
    feature: "F7",
    title: "RamTestView flags single-channel RAM bottleneck as BELOW NORMAL / WARN",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.singleChannelSlowWifi(), /RAM Stress/i);
      try {
        await app.waitForText("RAM Continuous Durability Audit", 4000);
        await app.clickButton("Start Continuous Test");
        await app.waitForText("DDR4-3200 Single-Channel", 5000);

        const body = await app.getBodyText();
        ctx.assert.ok(body.includes("BELOW NORMAL"), "Missing BELOW NORMAL grade");
        ctx.assert.ok(body.includes("19.4 / 16.8 GB/s"), "Missing single-channel bandwidth");
        ctx.assert.ok(body.includes("WARN"), "Missing WARN badge");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F07-04",
    tier: 1,
    feature: "F7",
    title: "Backend ram_test.rs implements expanded TestMem5 MT0.dll kernels (prime/256 strides, BlockMove 1MB..64MB)",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const cargoRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoRes.ok, true, `cargo test failed: ${cargoRes.stderr || cargoRes.stdout}`);
      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.match(ramRs, /block_?move/i, "Missing TestMem5 BlockMove kernel in ram_test.rs");
      ctx.assert.match(ramRs, /prime.*stride|stride.*256|256.*stride/i, "Missing TestMem5 prime/256-byte stride kernel in ram_test.rs");
    },
  },
  {
    id: "T1-F07-05",
    tier: 1,
    feature: "F7",
    title: "Backend ram_test.rs enforces >= max(512MB, 22% RAM) OS reserve headroom and thermal check",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
      ctx.assert.match(
        ramRs,
        /RAM_OS_RESERVE_PCT|\b22\b\s*\/\s*100/,
        "ram_test.rs must enforce >= max(512MB, 22% RAM) dynamic OS reserve"
      );
      ctx.assert.match(
        ramRs,
        /TelemetryReader|CPU_THERMAL_CUTOFF|thermal/i,
        "ram_test.rs must integrate thermal safety check during stress cycles"
      );
    },
  },

  // =========================================================================
  // F8: Expanded CPU/Memory Perf Bench + Mid-Run Thermal Cutoff
  // =========================================================================
  {
    id: "T1-F08-01",
    tier: 1,
    feature: "F8",
    title: "CLI --self-test verifies SIMD AI GEMM, Creator Image filter, and 3D Path-Tracer kernels",
    tags: ["tier1", "cli"],
    async run(ctx) {
      const stRes = await ctx.cli.runSelfTest();
      ctx.assert.equal(stRes.ok, true, `--self-test failed: ${stRes.stderr || stRes.stdout}`);
      ctx.assert.ok(stRes.stdout.includes("[PASS] SIMD Kernels"), "Missing [PASS] SIMD Kernels");
      ctx.assert.ok(stRes.stdout.includes("[PASS] 3D Path-Tracer"), "Missing [PASS] 3D Path-Tracer");
      ctx.assert.ok(stRes.stdout.includes("MRays/s"), "Missing MRays/s throughput output");
      ctx.assert.ok(stRes.stdout.includes("JPEG ok"), "Missing JPEG preview verification");
    },
  },
  {
    id: "T1-F08-02",
    tier: 1,
    feature: "F8",
    title: "PerformanceView runs 14-Stage Suite, processes perf:progress, and renders PassMark subtests & Memory Mark",
    tags: ["tier1", "ui", "ipc"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /360° Perf/i);
      try {
        await app.waitForText("360° All-Scope Performance", 4000);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("16,450", 5000);

        const body = await app.getBodyText();
        for (const token of [
          "A+",
          "17,120",
          "14,950",
          "3,180",
          "94 / 44.8 / 38.6 GB/s",
          "68.4 ns",
          "LZ Compression",
          "SHA-256 Encryption",
          "3D N-Body Physics",
          "Prime Numbers Sieve",
          "Parallel Sorting",
          "Database Operations",
          "Memory Mark",
        ]) {
          ctx.assert.ok(body.includes(token), `Missing PerformanceView metric/subtest "${token}"`);
        }

        const invokeLog = await app.getInvokeLog();
        ctx.assert.ok(
          invokeLog.some((e) => e.cmd === "run_performance_benchmark" && e.ok),
          "Expected run_performance_benchmark IPC invocation"
        );
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F08-03",
    tier: 1,
    feature: "F8",
    title: "PerformanceView flags severe thermal throttling (31.5%, BELOW NORMAL) and shop model parity",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.throttlingGamingLaptop(), /360° Perf/i);
      try {
        await app.waitForText("360° All-Scope Performance", 4000);
        await app.clickButton("Run 14-Stage Suite");
        await app.waitForText("9,850", 5000);

        const body = await app.getBodyText();
        for (const token of [
          "BELOW NORMAL (THROTTLING)",
          "31.5%",
          "104%",
        ]) {
          ctx.assert.ok(body.includes(token), `Missing throttling diagnostic token "${token}"`);
        }
        ctx.assert.match(body, /Shop Model History Calibration/i, "Missing Shop Model History Calibration section");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(body);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F08-04",
    tier: 1,
    feature: "F8",
    title: "Backend perf_bench.rs enforces mid-run CPU thermal cutoff (<=95°C) with clean abort",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
      ctx.assert.match(
        perfRs,
        /CPU_THERMAL_CUTOFF|thermal_cutoff/i,
        "perf_bench.rs must enforce mid-run CPU thermal cutoff <= 95°C"
      );
    },
  },
  {
    id: "T1-F08-05",
    tier: 1,
    feature: "F8",
    title: "Backend perf_bench.rs aggregates composite/category marks via Weighted Harmonic Mean",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      ctx.assert.ok(baselinesRs.includes("weighted_harmonic_mean"), "baselines.rs missing weighted_harmonic_mean");
      ctx.assert.match(
        perfRs,
        /weighted_harmonic_mean|compute_.*_harmonic/,
        "perf_bench.rs must call baselines harmonic mean functions"
      );
    },
  },

  // =========================================================================
  // F9: GPU / VRAM / Power Torture Safety & FurMark 2 Diagnostics
  // =========================================================================
  {
    id: "T1-F09-01",
    tier: 1,
    feature: "F9",
    title: "CLI --self-test enumerates wgpu GPU adapters and checks VRAM compute shader",
    tags: ["tier1", "cli"],
    async run(ctx) {
      const stRes = await ctx.cli.runSelfTest();
      ctx.assert.equal(stRes.ok, true, `--self-test failed: ${stRes.stderr || stRes.stdout}`);
      ctx.assert.ok(stRes.stdout.includes("wgpu GPU Adapters detected:"), "Missing wgpu adapter enumeration");
      ctx.assert.match(
        stRes.stdout,
        /(\[PASS\] VRAM Compute Shader|\[WARN\] VRAM Compute Shader skipped)/,
        "Missing VRAM Compute Shader check in --self-test"
      );
    },
  },
  {
    id: "T1-F09-02",
    tier: 1,
    feature: "F9",
    title: "GpuStressView runs 3D Shader Burn-In and Dedicated VRAM Integrity sweep cleanly",
    tags: ["tier1", "ui", "ipc"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /GPU, VRAM & Power/i);
      try {
        await app.waitForText("GPU Burn-In, Dedicated VRAM Integrity", 4000);
        await app.clickButton("Start GPU Burn-In");
        await app.waitForText(/Integrated Ultrabook GPU/i, 5000);

        const gpuBody = await app.getBodyText();
        ctx.assert.ok(gpuBody.includes("52.4"), "Missing GPU avg FPS 52.4");
        ctx.assert.match(gpuBody, /(65|68)°C/, "Missing GPU temperature readout");
        ctx.assert.match(gpuBody, /Integrated Ultrabook GPU/i, "Missing GPU baseline class");

        await app.clickButton("02. VRAM Integrity");
        await app.waitForText("Start VRAM Sweep", 3000);
        await app.clickButton("Start VRAM Sweep");
        await app.waitForText("6.0 GB", 5000);

        const vramBody = await app.getBodyText();
        ctx.assert.ok(vramBody.includes("52.4 GB/s"), "Missing VRAM compute sweep bandwidth");
        ctx.assert.match(vramBody, /VRAM Bit Errors/i, "Missing VRAM Bit Errors panel");

        const invokeLog = await app.getInvokeLog();
        ctx.assert.ok(invokeLog.some((e) => e.cmd === "run_gpu_stress" && e.ok));
        ctx.assert.ok(invokeLog.some((e) => e.cmd === "run_vram_test" && e.ok));
        ctx.assert.equal(invokeLog.filter((e) => e.unknownCommand).length, 0);
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(vramBody);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F09-03",
    tier: 1,
    feature: "F9",
    title: "GpuStressView reports thermal cutoff and AC charger battery drain on throttlingGamingLaptop",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.throttlingGamingLaptop(), /GPU, VRAM & Power/i);
      try {
        await app.waitForText("GPU Burn-In, Dedicated VRAM Integrity", 4000);
        await app.clickButton("Start GPU Burn-In");
        await app.waitForText("FAIL / THERMAL CUTOFF", 5000);

        const gpuBody = await app.getBodyText();
        ctx.assert.ok(gpuBody.includes("TRIGGERED"), "Expected thermal cutoff TRIGGERED audit row");

        await app.clickButton("03. Power & AC Torture");
        await app.waitForText("Launch Combined Torture", 3000);
        await app.clickButton("Launch Combined Torture");
        await app.waitForText("ALERT: BATTERY DRAINING WHILE AC CHARGER PLUGGED IN", 5000);

        const tortureBody = await app.getBodyText();
        ctx.assert.ok(tortureBody.includes("CUTOFF TRIGGERED"), "Expected combined torture CUTOFF TRIGGERED");
        ctx.assert.match(tortureBody, /Durability Grade[\s\S]*\bF\b/i, "Expected Durability Grade F");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(tortureBody);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F09-04",
    tier: 1,
    feature: "F9",
    title: "Backend lib.rs, gpu_stress.rs, power_torture.rs, and vram_test.rs enforce <=92°C default / <=95°C max GPU cutoff",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      const vramRs = ctx.cli.readRepoFile("src-tauri/src/modules/vram_test.rs");
      ctx.assert.ok(
        libRs.includes("GPU_THERMAL_CUTOFF_DEFAULT_C") || libRs.includes("unwrap_or(92.0)"),
        "lib.rs must default GPU/torture thermal cutoff to <= 92.0°C"
      );
      ctx.assert.match(
        vramRs,
        /thermal_cutoff|GPU_THERMAL_CUTOFF/i,
        "vram_test.rs must enforce GPU thermal cutoff abort"
      );
    },
  },
  {
    id: "T1-F09-05",
    tier: 1,
    feature: "F9",
    title: "GpuStressView defaults thermal cutoff to <=92°C (max <=95°C) and passes thermalCutoffC to run_vram_test",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.throttlingGamingLaptop(), /GPU, VRAM & Power/i);
      try {
        await app.waitForText("GPU Burn-In, Dedicated VRAM Integrity", 4000);
        const inputInfo = await app.evaluate(() => {
          const el = document.querySelector('input[type="number"]');
          return el
            ? { value: Number(el.value), min: Number(el.min), max: Number(el.max) }
            : null;
        });
        ctx.assert.ok(inputInfo, "Expected numeric thermal cutoff input in GpuStressView");
        ctx.assert.ok(inputInfo.value <= 92, `Expected default cutoff <= 92°C, got ${inputInfo.value}`);
        ctx.assert.ok(inputInfo.max <= 95, `Expected max cutoff <= 95°C, got ${inputInfo.max}`);

        await app.clickButton("02. VRAM Integrity");
        await app.clickButton("Start VRAM Sweep");
        await app.waitForText("6.0 GB", 5000);
        const vramCall = (await app.getInvokeLog()).find((e) => e.cmd === "run_vram_test");
        ctx.assert.ok(vramCall && typeof vramCall.args.thermalCutoffC === "number", "run_vram_test must pass thermalCutoffC");
      } finally {
        await app.close();
      }
    },
  },

  // =========================================================================
  // F10: Robust Cross-Platform Telemetry Fallbacks
  // =========================================================================
  {
    id: "T1-F10-01",
    tier: 1,
    feature: "F10",
    title: "CLI --self-test executes live cross-platform telemetry probe cleanly",
    tags: ["tier1", "cli"],
    async run(ctx) {
      const stRes = await ctx.cli.runSelfTest();
      ctx.assert.equal(stRes.ok, true, `--self-test failed: ${stRes.stderr || stRes.stdout}`);
      ctx.assert.match(
        stRes.stdout,
        /\[PASS\] Telemetry \([^)]+\): CPU .* @ \d+ MHz \| Temp=.* \| AC=.* \| Bat=/,
        `Missing expected telemetry probe line in --self-test:\n${stRes.stdout}`
      );
    },
  },
  {
    id: "T1-F10-02",
    tier: 1,
    feature: "F10",
    title: "TopTelemetryStrip renders initial sample_live_telemetry and updates live from perf:progress telemetry",
    tags: ["tier1", "ui", "ipc"],
    async run(ctx) {
      const base = ctx.fixtures.healthyUltrabook();
      const app = await openAtStep(ctx, base, /360° Perf/i);
      try {
        await app.waitForText("54°C", 4000);
        const headerBefore = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.match(headerBefore, /2[45]%/, "Missing CPU % in TopTelemetryStrip");
        ctx.assert.ok(headerBefore.includes("3650MHz"), "Missing CPU clock in TopTelemetryStrip");
        ctx.assert.ok(headerBefore.includes("AC"), "Missing AC indicator in TopTelemetryStrip");
        ctx.assert.ok(headerBefore.includes("92%"), "Missing battery % in TopTelemetryStrip");

        await app.emitTauriEvent("perf:progress", {
          phase: "Telemetry Stress Check",
          percent: 60,
          elapsedSecs: 5.0,
          cpuUsagePct: 97,
          cpuClockMhz: 4300,
          cpuTempC: 81.0,
          raytracePreviewUrl: null,
          telemetry: {
            ...base.telemetry,
            cpuUsagePct: 97,
            cpuClockMhz: 4300,
            cpuTempC: 81.0,
          },
        });
        await app.waitForText("81°C", 3000);
        const headerAfter = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.ok(headerAfter.includes("4300MHz"), "TopTelemetryStrip did not update to 4300MHz");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F10-03",
    tier: 1,
    feature: "F10",
    title: "TopTelemetryStrip falls back cleanly CPU temp -> GPU temp -> N/A when sensors are null",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const fixture = ctx.fixtures.makeBaseFixture({
        telemetry: {
          cpuTempC: null,
          gpuTempC: 58.0,
          cpuPowerW: null,
          fanRpm: null,
          sensorSource: "OS Native",
        },
      });
      const app = await openAtStep(ctx, fixture, /360° Perf/i);
      try {
        await app.waitForText("GPU 58°C", 4000);
        await app.emitTauriEvent("perf:progress", {
          phase: "Sensor Missing Probe",
          percent: 25,
          elapsedSecs: 1.0,
          cpuUsagePct: 45,
          cpuClockMhz: 3200,
          cpuTempC: null,
          raytracePreviewUrl: null,
          telemetry: {
            ...fixture.telemetry,
            cpuTempC: null,
            gpuTempC: null,
          },
        });
        await app.waitForText(/Sensor unavailable/i, 3000);
        const headerAfter = await app.evaluate(
          () => document.querySelector("header")?.innerText || ""
        );
        ctx.assert.match(headerAfter, /Sensor unavailable/i, "Expected Sensor unavailable fallback in TopTelemetryStrip");
        ctx.assert.equal((await app.getPageErrors()).length, 0);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
      } finally {
        await app.close();
      }
    },
  },
  {
    id: "T1-F10-04",
    tier: 1,
    feature: "F10",
    title: "Backend telemetry.rs provides explicit macOS #[cfg(target_os = \"macos\")] fallback, power/thermal fallbacks, and unit tests",
    tags: ["tier1", "cli", "contract"],
    async run(ctx) {
      const telRs = ctx.cli.readRepoFile("src-tauri/src/modules/telemetry.rs");
      ctx.assert.ok(
        telRs.includes('#[cfg(target_os = "macos")]'),
        'telemetry.rs must include explicit #[cfg(target_os = "macos")] sensor fallback block'
      );
      ctx.assert.ok(
        telRs.includes("#[cfg(test)]"),
        "telemetry.rs must include #[cfg(test)] unit tests for fallback logic"
      );
    },
  },
  {
    id: "T1-F10-05",
    tier: 1,
    feature: "F10",
    title: "UI surfaces active telemetry sensorSource / sensor availability cleanly to the technician",
    tags: ["tier1", "ui"],
    async run(ctx) {
      const app = await openAtStep(ctx, ctx.fixtures.healthyUltrabook(), /360° Perf/i);
      try {
        await app.waitForText("360° All-Scope Performance", 4000);
        const body = await app.getBodyText();
        ctx.assert.ok(
          body.includes("PDH + ACPI (Mocked)"),
          "Expected UI to surface active telemetry sensorSource ('PDH + ACPI (Mocked)')"
        );
      } finally {
        await app.close();
      }
    },
  },
];
