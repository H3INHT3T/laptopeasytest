function enrichV230Fixture(ctx, overrides = {}) {
  const f = ctx.fixtures.makeBaseFixture(overrides);
  if (f.batteryDischarge && !f.batteryDischarge.status) {
    const v = f.batteryDischarge.verdict;
    f.batteryDischarge.status =
      v === "NORMAL" ? "pass" : v === "ABNORMAL" ? "fail" : v === "NOT_APPLICABLE" ? "notApplicable" : "warn";
  }
  if (f.networkDiagnostics && !f.networkDiagnostics.status) {
    f.networkDiagnostics.status = f.networkDiagnostics.verdict === "PASS" ? "pass" : "warn";
  }
  if (f.userBenchmark && !f.userBenchmark.sourceMode) {
    f.userBenchmark.sourceMode = f.userBenchmark.cpu?.sourceMode || "offline_calibrated";
  }
  if (f.progressEvents && Array.isArray(f.progressEvents["battery:discharge"])) {
    f.progressEvents["battery:discharge"] = f.progressEvents["battery:discharge"].map((evt, idx) => ({
      chargeDropPct: idx === 0 ? 0.2 : 1.0,
      note: evt.phase || "Sampling battery discharge telemetry",
      ...evt,
    }));
  }
  return f;
}

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

async function waitForBodyMatch(app, regex, timeoutMs = 5000) {
  return app.waitForText(regex, timeoutMs);
}

async function hasTouchscreenStep(app) {
  const navButtons = await app.queryAll("aside nav button, aside button");
  return navButtons.some((b) => /Touchscreen/i.test(b.text));
}

async function advanceCurrentStage(app) {
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
  throw new Error("Neither enabled Next: Stage / Issue QC Certificate nor Skip Step button found");
}

async function navigateToStage(ctx, app, headingRegex, maxHops = 16) {
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
  throw new Error("Failed to reach PreReportModal");
}

export const tests = [
  {
    id: "T3-01",
    tier: 3,
    feature: "F20",
    title: "F1 × F20: Windows GNU cargo test + zero bundled binaries + macOS universal CI parity",
    tags: ["pairwise", "F1", "F20"],
    async run(ctx) {
      const cargoTest = await ctx.cli.runCargoTest();
      ctx.assert.equal(
        cargoTest.ok,
        true,
        `cargo test failed (exit=${cargoTest.exitCode}): ${(cargoTest.stderr || cargoTest.stdout).slice(0, 500)}`
      );

      const binaries = ctx.cli.checkNoBundledBinaries();
      ctx.assert.equal(
        binaries.ok,
        true,
        `Bundled proprietary/native binaries found: ${JSON.stringify(binaries.found)}`
      );

      const buildRs = ctx.cli.readRepoFile("src-tauri/build.rs");
      ctx.assert.match(buildRs, /libresource\.a|WebView2Loader\.dll/, "build.rs missing Windows GNU test/resource handling");

      const releaseYml = ctx.cli.readRepoFile(".github/workflows/release.yml");
      ctx.assert.match(releaseYml, /windows-latest/, "release.yml missing windows-latest job");
      ctx.assert.match(releaseYml, /macos-latest/, "release.yml missing macos-latest job");
      ctx.assert.match(releaseYml, /universal-apple-darwin/, "release.yml missing universal-apple-darwin target");
    },
  },

  {
    id: "T3-02",
    tier: 3,
    feature: "F2",
    title: "F2 × F3: Weighted Harmonic Mean calibration & UserBenchmark Vehicle Tier integration in PerformanceView",
    tags: ["pairwise", "F2", "F3"],
    async run(ctx) {
      const baselinesRs = ctx.cli.readRepoFile("src-tauri/src/modules/baselines.rs");
      ctx.assert.match(baselinesRs, /weighted_harmonic|harmonic/i, "baselines.rs should implement Weighted Harmonic Mean");
      const ubRs = ctx.cli.readRepoFile("src-tauri/src/modules/userbenchmark.rs");
      ctx.assert.match(ubRs, /Aircraft Carrier/, "userbenchmark.rs missing Vehicle Tier mapping");

      const cargoTest = await ctx.cli.runCargoTest();
      ctx.assert.equal(cargoTest.ok, true, `cargo test failed: ${(cargoTest.stderr || cargoTest.stdout).slice(0, 400)}`);

      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await waitForBodyMatch(app, /16,450/, 6000);
        const text = await app.getBodyText();
        ctx.assert.match(text, /108\.4% OF NORMAL/);
        ctx.assert.match(text, /EXCELLENT/);
        const invokeLog = await assertCleanRuntime(ctx, app);

        // v2.3.0 requirement: frontend invokes compare_userbenchmark and displays Vehicle Tier
        const ubInvoked = invokeLog.some((e) => e.cmd === "compare_userbenchmark");
        ctx.assert.equal(ubInvoked, true, "v2.3.0: PerformanceView must invoke compare_userbenchmark");
        ctx.assert.match(
          text,
          /Aircraft Carrier|Nuclear Submarine|UFO|Battleship|Cruiser|Destroyer|Speedboat|Jet Ski|Raft/,
          "v2.3.0: PerformanceView/BaselineCard must display UserBenchmark Vehicle Tier"
        );
      });
    },
  },

  {
    id: "T3-03",
    tier: 3,
    feature: "F3",
    title: "F3 × F4: UserBenchmark IPC contracts across types.rs, lib.rs, src/types.ts, and frontend invocation",
    tags: ["pairwise", "F3", "F4"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      ctx.assert.match(typesRs, /struct UserBenchmarkComponentRating/);
      ctx.assert.match(typesRs, /struct UserBenchmarkComparison/);
      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.match(libRs, /compare_userbenchmark/);

      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await waitForBodyMatch(app, /16,450/, 6000);
        const invokeLog = await assertCleanRuntime(ctx, app);

        // v2.3.0 requirement: src/types.ts mirrors UserBenchmarkComparison and frontend invokes compare_userbenchmark
        const srcTypes = ctx.cli.readRepoFile("src/types.ts");
        ctx.assert.match(
          srcTypes,
          /(?:interface|type)\s+UserBenchmarkComparison\b/,
          "v2.3.0: src/types.ts missing UserBenchmarkComparison"
        );
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "compare_userbenchmark"),
          true,
          "v2.3.0: frontend did not invoke compare_userbenchmark"
        );
      });
    },
  },

  {
    id: "T3-04",
    tier: 3,
    feature: "F4",
    title: "F4 × F19: HardwareSafetyBounds IPC contract & --self-test v2.3.0 probe coverage",
    tags: ["pairwise", "F4", "F19"],
    async run(ctx) {
      const typesRs = ctx.cli.readRepoFile("src-tauri/src/types.rs");
      for (const sym of [
        "CPU_THERMAL_CUTOFF_DEFAULT_C",
        "GPU_THERMAL_CUTOFF_DEFAULT_C",
        "SSD_WRITE_BUDGET_QUICK_MB",
        "SSD_WRITE_BUDGET_STD_MB",
        "SSD_WRITE_BUDGET_MAX_MB",
        "RAM_OS_RESERVE_FLOOR_MB",
        "BATTERY_LOW_SOC_ABORT_PCT",
        "BATTERY_DISCHARGE_MAX_SECS",
        "HardwareSafetyBounds",
      ]) {
        ctx.assert.match(typesRs, new RegExp(`\\b${sym}\\b`), `types.rs missing ${sym}`);
      }

      const selfTest = await ctx.cli.runSelfTest();
      ctx.assert.equal(
        selfTest.ok,
        true,
        `--self-test failed (exit=${selfTest.exitCode}): ${(selfTest.stderr || selfTest.stdout).slice(0, 500)}`
      );
      const out = `${selfTest.stdout}\n${selfTest.stderr}`;
      ctx.assert.match(out, /\[PASS\]/, "--self-test output missing [PASS] markers");

      // v2.3.0 assertions
      ctx.assert.match(out, /2\.3\.0/, "v2.3.0: --self-test header must report version 2.3.0");
      ctx.assert.match(
        out,
        /UserBenchmark/i,
        "v2.3.0: --self-test must exercise UserBenchmark offline comparison"
      );
      ctx.assert.match(
        out,
        /Battery.*Discharge|Safety/i,
        "v2.3.0: --self-test must verify Battery Discharge / HardwareSafetyBounds"
      );
    },
  },

  {
    id: "T3-05",
    tier: 3,
    feature: "F5",
    title: "F5 × F6: SSD low-space write-budget guard & DriveDx NVMe SMART Log 0x02 audit",
    tags: ["pairwise", "F5", "F6"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.wornNvmeLowSpace());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /SSD SMART Health & Direct-IO Durability Audit/i);
        const smartText = await app.getBodyText();
        ctx.assert.match(smartText, /WDC PC SN530 256GB/);
        ctx.assert.match(smartText, /104%/);
        ctx.assert.match(smartText, /12/);
        ctx.assert.match(smartText, /8% Available Spare/);
        ctx.assert.match(smartText, /84 Unsafe Shutdowns/);

        const btns = await app.queryAll("button");
        const runBtn = btns.find(
          (b) => b.rect.width > 0 && b.rect.height > 0 && /Run Direct-IO Audit/i.test(b.text)
        );
        ctx.assert.ok(runBtn, "Expected visible Run Direct-IO Audit button");
        ctx.assert.equal(runBtn.disabled, true, "Proactive low-space guard must disable Run Direct-IO Audit");

        const skipBtn = btns.find(
          (b) => b.rect.width > 0 && b.rect.height > 0 && /^Skip Step$/i.test(b.text)
        );
        ctx.assert.ok(skipBtn && !skipBtn.disabled, "Skip Step must remain enabled when low-space guard blocks Direct-IO");

        ctx.assert.match(smartText, /INSUFFICIENT FREE SPACE/i);
        ctx.assert.match(smartText, /2048\s*MB|2\.0\s*GB/i);
        ctx.assert.match(smartText, /0\.4\s*GB free/i);

        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "run_storage_benchmark"),
          false,
          "Proactive low-space guard must prevent run_storage_benchmark IPC invocation"
        );

        // v2.3.0: safe write budget labels in StorageView & TempFileGuard / free-space guard in storage.rs
        const options = await app.queryAll("select option");
        const optionLabels = options.map((o) => o.text).join(" | ");
        ctx.assert.match(
          optionLabels,
          /128\s*MB/i,
          `v2.3.0: StorageView preset labels must display safe write budget (128 MB / 256 MB / 512 MB), got: ${optionLabels}`
        );
        const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
        ctx.assert.match(storageRs, /validate_free_space_mb/, "v2.3.0: storage.rs must implement validate_free_space_mb");
        ctx.assert.match(storageRs, /SSD_FREE_SPACE_MULTIPLIER/, "v2.3.0: storage.rs must enforce SSD_FREE_SPACE_MULTIPLIER");
        ctx.assert.match(storageRs, /\.max\(2048\)/, "v2.3.0: storage.rs must enforce 2048 MB minimum free-space guard");
        ctx.assert.match(storageRs, /TempFileGuard/, "v2.3.0: storage.rs must implement RAII TempFileGuard");
        ctx.assert.match(storageRs, /SSD_WRITE_BUDGET_QUICK_MB/, "v2.3.0: storage.rs must enforce SSD_WRITE_BUDGET_QUICK_MB");
      });
    },
  },

  {
    id: "T3-06",
    tier: 3,
    feature: "F6",
    title: "F6 × F18: Failing NVMe SMART propagates into PreReportModal and export_qc_report",
    tags: ["pairwise", "F6", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.wornNvmeLowSpace());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /SSD SMART Health & Direct-IO Durability Audit/i);
        await app.clickButton(/^Skip Step$/i);
        await advanceRemainingToReportModal(app);

        await app.fillInput(/ProTech Laptop Store/i, "DriveDx Cert Lab");
        await app.fillInput(/Hein Htet Zaw/i, "Hein Htet Zaw");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());

        await app.clickButton(/Issue Official QC Certificate/i);
        await waitForBodyMatch(app, /Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report was not invoked");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.ok(payload && Array.isArray(payload.tests), "export_qc_report missing tests array");
        const storageEntry = payload.tests.find((t) => /SSD SMART|storage/i.test(t.name || t.id || ""));
        ctx.assert.ok(storageEntry, "export_qc_report missing Stage 05 storage entry");

        const metricMap = new Map(storageEntry.metrics || []);
        ctx.assert.equal(metricMap.get("SMART Health"), "0%", "storageEntry.metrics missing SMART Health");
        ctx.assert.equal(metricMap.get("Wear (Log 0x02)"), "104%", "storageEntry.metrics missing Wear (Log 0x02)");
        ctx.assert.equal(metricMap.get("Spare"), "8%", "storageEntry.metrics missing Spare");
        ctx.assert.equal(metricMap.get("Media Err"), "12", "storageEntry.metrics missing Media Err");
        ctx.assert.equal(metricMap.get("Unsafe Off"), "84", "storageEntry.metrics missing Unsafe Off");

        // v2.3.0: report.rs / payload includes DriveDx Log 0x02 interpretation and v2.3.0 stamp
        const reportRs = ctx.cli.readRepoFile("src-tauri/src/modules/report.rs");
        const reportProd = reportRs.split("#[cfg(test)]")[0];
        ctx.assert.match(reportProd, /2\.3\.0/, "v2.3.0: report.rs must stamp version 2.3.0");
        ctx.assert.match(reportProd, /t\.metrics/, "v2.3.0: report.rs must render t.metrics");
        ctx.assert.match(reportProd, /available_spare/, "v2.3.0: report.rs must interpret available_spare");
        ctx.assert.match(reportProd, /unsafe_shutdowns/, "v2.3.0: report.rs must interpret unsafe_shutdowns");
        ctx.assert.match(reportProd, /Log 0x02/i, "v2.3.0: report.rs must render DriveDx SMART Log 0x02 details");

        const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
        ctx.assert.match(storageRs, /parse_nvme_smart_log_0x02/, "v2.3.0: storage.rs must parse NVMe Log 0x02");
      });
    },
  },

  {
    id: "T3-07",
    tier: 3,
    feature: "F10",
    title: "F7 × F10: RAM TestMem5 stress with hot-start thermal EnvironmentGuard telemetry",
    tags: ["pairwise", "F7", "F10"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /RAM Continuous Durability Audit/i);
        const preText = await app.getBodyText();
        ctx.assert.match(preText, /Pre-Test Reliability Advisory/i);
        ctx.assert.match(preText, /START TEMP:\s*96°C\s*\(HOT\)/i);
        ctx.assert.match(preText, /Test0: RefreshStable \(Retention\)/);
        ctx.assert.match(preText, /Test7: BlockMove \(64B Cache-Line\)/);

        await app.clickButton(/Start Continuous Test/i);
        await waitForBodyMatch(app, /24\.0 GB/, 5000);
        const afterText = await app.getBodyText();
        ctx.assert.match(afterText, /44\.8/);
        ctx.assert.match(afterText, /RefreshStable Hold/);
        ctx.assert.match(afterText, /Prime Stride & 256-Byte/);
        ctx.assert.match(afterText, /BlockMove 64MB/);
        ctx.assert.match(afterText, /Checkerboard PRNG/);
        ctx.assert.match(afterText, /3604 MB/);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: ram_test.rs enforces OS headroom reserve & thermal check
        const ramRs = ctx.cli.readRepoFile("src-tauri/src/modules/ram_test.rs");
        ctx.assert.match(ramRs, /RAM_OS_RESERVE|os_reserve/i, "v2.3.0: ram_test.rs must enforce OS RAM reserve headroom");
        ctx.assert.match(ramRs, /CPU_THERMAL_CUTOFF|thermal_cutoff/i, "v2.3.0: ram_test.rs must enforce thermal safety check");
      });
    },
  },

  {
    id: "T3-08",
    tier: 3,
    feature: "F7",
    title: "F7 × F17: Single-channel RAM bottleneck audit, Swiss palette, and plain-language UserBenchmark advice",
    tags: ["pairwise", "F7", "F17"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.singleChannelSlowWifi());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Complete Hardware Specifications/i);
        const specsText = await app.getBodyText();
        ctx.assert.match(specsText, /RAM CONFIGURATION AUDIT/i);
        ctx.assert.match(specsText, /Single-channel RAM detected/i);

        await navigateToStage(ctx, app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await waitForBodyMatch(app, /16\.8/, 5000);
        const ramText = await app.getBodyText();
        ctx.assert.match(ramText, /BELOW NORMAL/);
        ctx.assert.match(ramText, /56\.0% OF NORMAL/);

        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(ramText);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: plain-language UserBenchmark RAM standing in UI
        ctx.assert.match(
          ramText,
          /Speedboat|Below Expectations|adding a matching 8GB stick/i,
          "v2.3.0: RamTestView must render plain-language UserBenchmark RAM standing & upgrade guidance"
        );
      });
    },
  },

  {
    id: "T3-09",
    tier: 3,
    feature: "F8",
    title: "F8 × F9: Combined CPU perf throttling & GPU/Power thermal cutoff diagnostics",
    tags: ["pairwise", "F8", "F9"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await waitForBodyMatch(app, /31\.5%/, 5000);
        const perfText = await app.getBodyText();
        ctx.assert.match(perfText, /BELOW NORMAL \(THROTTLING\)/);

        await advanceCurrentStage(app);
        await waitForBodyMatch(app, /GPU Burn-In, Dedicated VRAM Integrity/i, 5000);

        await app.clickButton(/Start GPU Burn-In/i);
        await waitForBodyMatch(app, /FAIL \/ THERMAL CUTOFF/i, 5000);
        let gpuText = await app.getBodyText();
        ctx.assert.match(gpuText, /41\.0%/);
        ctx.assert.match(gpuText, /93/);

        await app.clickButton(/03\. Power & AC Torture/i);
        await app.clickButton(/Launch Combined Torture/i);
        await waitForBodyMatch(app, /ALERT: BATTERY DRAINING WHILE AC CHARGER PLUGGED IN/i, 5000);
        await waitForBodyMatch(app, /Durability Grade/i, 5000);
        await waitForButtonEnabled(app, /Next: Stage/i, 5000);
        gpuText = await app.getBodyText();
        ctx.assert.match(gpuText, /-4\.0%/);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: GPU thermal cutoff default must be 92C (not 95C) & perf_bench.rs enforces mid-run CPU cutoff
        const cutoffVal = await app.evaluate(() => {
          const inp = document.querySelector('input[type="number"][min="75"]');
          return inp ? Number(inp.value) : null;
        });
        ctx.assert.equal(cutoffVal, 92, `v2.3.0: GPU thermal cutoff default must be 92C, got ${cutoffVal}`);
        const perfRs = ctx.cli.readRepoFile("src-tauri/src/modules/perf_bench.rs");
        ctx.assert.match(perfRs, /CPU_THERMAL_CUTOFF|thermal_cutoff/i, "v2.3.0: perf_bench.rs must enforce mid-run thermal cutoff");
      });
    },
  },

  {
    id: "T3-10",
    tier: 3,
    feature: "F8",
    title: "F8 × F2: Performance suite live progress, 14-subtest bars & weighted harmonic calibration",
    tags: ["pairwise", "F8", "F2"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await waitForBodyMatch(app, /16,450/, 6000);
        const text = await app.getBodyText();
        ctx.assert.match(text, /17,120/);
        ctx.assert.match(text, /14,950/);
        ctx.assert.match(text, /3,180/);
        ctx.assert.match(text, /104% of shop average/);
        ctx.assert.match(text, /4 unit\(s\) in your shop/);
        ctx.assert.match(text, /108\.4% OF NORMAL/);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: UserBenchmark standing & harmonic calibration surfaced in PerformanceView
        ctx.assert.match(
          text,
          /Aircraft Carrier|Above Expectations|UserBenchmark/i,
          "v2.3.0: PerformanceView must surface UserBenchmark standing"
        );
      });
    },
  },

  {
    id: "T3-11",
    tier: 3,
    feature: "F9",
    title: "F9 × F10: GPU thermal warning telemetry stream + Swiss dark-surface contrast + VRAM thermal cutoff",
    tags: ["pairwise", "F9", "F10"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        const stripText = await app.getBodyText();
        ctx.assert.match(stripText, /96°C/);
        ctx.assert.match(stripText, /64%/);

        await app.emitTauriEvent("gpu:progress", {
          running: true,
          adapterName: "NVIDIA GeForce RTX 4060 Laptop GPU",
          width: 1280,
          height: 720,
          fps: 42.0,
          avgFps: 50.0,
          minFps: 38.0,
          low1pctFps: 39.0,
          frameTimeMs: 23.8,
          framesRendered: 500,
          elapsedSecs: 10.0,
          durationSecs: 30.0,
          gpuTempC: 91.5,
          gpuLoadPct: 99.0,
          gpuPowerW: 115.0,
          thermalWarning: true,
          previewDataUrl: null,
        });
        await waitForBodyMatch(app, /HIGH GPU TEMPERATURE APPROACHING CUTOFF|92°C/i, 4000);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        await assertCleanRuntime(ctx, app);

        // v2.3.0: vram_test.rs must enforce GPU_THERMAL_CUTOFF_DEFAULT_C
        const vramRs = ctx.cli.readRepoFile("src-tauri/src/modules/vram_test.rs");
        ctx.assert.match(vramRs, /GPU_THERMAL_CUTOFF|thermal_cutoff/i, "v2.3.0: vram_test.rs must enforce GPU thermal cutoff");
      });
    },
  },

  {
    id: "T3-12",
    tier: 3,
    feature: "F11",
    title: "F11 × F10: Battery Discharge Normality ABNORMAL detection on worn battery with live telemetry",
    tags: ["pairwise", "F11", "F10"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Battery Health, Discharge Normality/i);
        const text = await app.getBodyText();
        ctx.assert.match(text, /54\.0%/);
        ctx.assert.match(text, /Wear:\s*46\.0%/);
        ctx.assert.match(text, /512/);

        await app.clickButton(/Run 15s Sag Pulse/i);
        await waitForBodyMatch(app, /Battery sag pulse normal/i, 4000);
        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "run_battery_sag_pulse"), true);

        // v2.3.0: BatteryView exposes Battery Discharge Normality UI invoking run_battery_discharge_test
        const btns = await app.queryAll("button");
        const hasDischargeBtn = btns.some((b) =>
          b.rect.width > 0 && b.rect.height > 0 && /Discharge Normality|Run Discharge Test/i.test(b.text)
        );
        ctx.assert.equal(
          hasDischargeBtn,
          true,
          "v2.3.0: BatteryView must expose Battery Discharge Normality UI button"
        );
        await app.clickButton(/Discharge Normality|Run Discharge Test/i);
        await waitForBodyMatch(app, /ABNORMAL/i, 4000);
        const postText = await app.getBodyText();
        ctx.assert.match(postText, /24\.0%/);
        ctx.assert.match(postText, /4\.5%/);
      });
    },
  },

  {
    id: "T3-13",
    tier: 3,
    feature: "F11",
    title: "F11 × F13: Battery Discharge safety guards (NOT_APPLICABLE, ABORTED_LOW_BATTERY, AC_CONNECTED) & pipeline unlock",
    tags: ["pairwise", "F11", "F13"],
    async run(ctx) {
      // Subcase A: Desktop AC-only auto-marks notApplicable and unlocks Stage 04
      await withApp(ctx, enrichScenario(ctx.fixtures.desktopAcOnly()), { maxTouchPoints: 0 }, async (app) => {
        await navigateToStage(ctx, app, /Battery Health, Discharge Normality/i);
        const text = await app.getBodyText();
        ctx.assert.match(text, /No Internal Battery Detected/i);
        await waitForButtonEnabled(app, /Next: Stage 04/i, 3000);
        await app.clickButton(/Next: Stage 04/i);
        await waitForBodyMatch(app, /System Error & Crash Logs/i, 4000);
        await assertCleanRuntime(ctx, app);
      });

      // Subcase B: Low battery (12%) allows Skip Step without trapping pipeline
      await withApp(ctx, enrichScenario(ctx.fixtures.lowBattery()), { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Battery Health, Discharge Normality/i);
        const text = await app.getBodyText();
        ctx.assert.match(text, /12%/);
        ctx.assert.match(text, /ON BATTERY/i);
        await app.clickButton(/^Skip Step$/i);
        await waitForBodyMatch(app, /System Error & Crash Logs/i, 4000);
        await assertCleanRuntime(ctx, app);
      });

      // Subcase C: AC plugged (78%) must expose v2.3.0 Discharge Normality guard (AC_CONNECTED)
      await withApp(ctx, enrichScenario(ctx.fixtures.acPlugged()), { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Battery Health, Discharge Normality/i);
        const text = await app.getBodyText();
        ctx.assert.match(text, /78%/);
        ctx.assert.match(text, /AC CHARGING/i);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: run_battery_discharge_test registered in lib.rs and runnable in BatteryView
        const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
        ctx.assert.match(libRs, /run_battery_discharge_test/, "v2.3.0: lib.rs missing run_battery_discharge_test");
        await app.clickButton(/Discharge Normality|Run Discharge Test/i);
        await waitForBodyMatch(
          app,
          /AC power adapter is currently plugged in|Unplug AC charger before running discharge normality test\.|true battery discharge cannot be measured/i,
          4000
        );
        const acLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          acLog.some((e) => e.cmd === "run_battery_discharge_test" && e.ok),
          true,
          "v2.3.0: run_battery_discharge_test must invoke and succeed for AC_CONNECTED guard"
        );
      });
    },
  },

  {
    id: "T3-14",
    tier: 3,
    feature: "F17",
    title: "F12 × F17: Network/MDM/Error-Log reliability alerts with Swiss Precision Light & attribution",
    tags: ["pairwise", "F12", "F17"],
    async run(ctx) {
      await withApp(ctx, enrichScenario(ctx.fixtures.singleChannelSlowWifi()), { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Complete Hardware Specifications/i);
        const specsText = await app.getBodyText();
        ctx.assert.match(specsText, /WI-FI ANTENNA \/ COAX RSSI ALERT/i);
        ctx.assert.match(specsText, /-82 dBm/);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(specsText);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Network Diagnostics UI invokes run_network_diagnostics & renders metrics
        const netBtn = await waitForButtonEnabled(app, /Run Network Check/i, 4000);
        ctx.assert.ok(netBtn, "v2.3.0: UI must expose Run Network Check button invoking run_network_diagnostics");
        await app.clickButton(/Run Network Check/i);
        await waitForBodyMatch(app, /68\.5\s*ms/i, 4000);
        const postNetText = await app.getBodyText();
        ctx.assert.match(postNetText, /6\.0%|6%/);
        const postNetLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          postNetLog.some((e) => e.cmd === "run_network_diagnostics"),
          true,
          "v2.3.0: Clicking Run Network Check must invoke run_network_diagnostics"
        );
      });
    },
  },

  {
    id: "T3-15",
    tier: 3,
    feature: "F12",
    title: "F12 × F16: Live USB hot-plug & speaker test + Network Diagnostics backend registration",
    tags: ["pairwise", "F12", "F16"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Live USB4\/3\.x Speed Detector/i);
        await sleep(80);
        await app.emitTauriEvent("usb:event", {
          eventKind: "CONNECTED",
          timestamp: new Date().toISOString(),
          device: {
            instanceId: "USB\\VID_0951&PID_1666\\TEST",
            name: "Kingston DataTraveler 3.2",
            speedClass: "USB 3.2 Gen 1 SuperSpeed (5 Gbps)",
            isSuperspeed: true,
            status: "OK",
          },
          devices: [],
        });
        await waitForBodyMatch(app, /Kingston DataTraveler 3\.2/, 4000);
        const text = await app.getBodyText();
        ctx.assert.match(text, /CONNECTED/);
        ctx.assert.match(text, /SuperSpeed \(5 Gbps\)/);

        await app.clickButton(/Left \(440 Hz\)/i);
        await app.clickButton(/Right \(587 Hz\)/i);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "start_usb_monitor"), true);

        // v2.3.0: run_network_diagnostics registered in lib.rs
        const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
        ctx.assert.match(libRs, /run_network_diagnostics/, "v2.3.0: lib.rs missing run_network_diagnostics");
      });
    },
  },

  {
    id: "T3-16",
    tier: 3,
    feature: "F13",
    title: "F13 × F14: Sequential pipeline lock & non-touch Touchscreen 1-click Skip Step",
    tags: ["pairwise", "F13", "F14"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.nonTouchCorporate());
      await withApp(ctx, fixture, { maxTouchPoints: 0 }, async (app) => {
        const touchPts = await app.evaluate(() => navigator.maxTouchPoints);
        ctx.assert.equal(touchPts, 0, `Expected navigator.maxTouchPoints === 0, got ${touchPts}`);

        // Locked steps cannot be clicked directly
        await ctx.assert.rejects(
          () => app.clickStep(/Keyboard & Touchpad/i),
          /locked|disabled/i,
          "Expected locked step Keyboard & Touchpad to reject clickStep"
        );

        await navigateToStage(ctx, app, /Display Check/i);
        await app.clickButton(/Pass Display Check/i);
        await app.clickButton(/Next: Stage 07/i);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Touchscreen step must exist right after Display Fullscreen & support 1-click Skip Step
        const hasTouch = await hasTouchscreenStep(app);
        ctx.assert.equal(hasTouch, true, "v2.3.0: Sidebar must include Touchscreen step right after Display Fullscreen");
        const touchText = await app.getBodyText();
        ctx.assert.match(touchText, /Touchscreen|Non-touch/i);
        await app.clickButton(/^Skip Step$/i);
        await waitForBodyMatch(app, /Keyboard & Touchpad/i, 4000);
      });
    },
  },

  {
    id: "T3-17",
    tier: 3,
    feature: "F14",
    title: "F14 × F15: Fullscreen Display portal followed by multi-touch Touchscreen grid verification",
    tags: ["pairwise", "F14", "F15"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await sleep(50);

        const winOpen = await app.getWindowState();
        ctx.assert.equal(winOpen?.fullscreen, true, "Expected windowState.fullscreen === true");
        const portal = await app.evaluate(() => {
          const el = Array.from(document.body.children).find((c) => {
            const cs = getComputedStyle(c);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          if (!el) return null;
          const hud = Array.from(el.querySelectorAll("div")).find((d) =>
            /Click \/ Space: Next/i.test(d.textContent || "")
          );
          return {
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
            hudOpacity: hud ? getComputedStyle(hud).opacity : null,
          };
        });
        ctx.assert.ok(portal && portal.width >= 1300 && portal.height >= 800, "Fullscreen portal must cover viewport");
        ctx.assert.equal(portal.hudOpacity, "0", "Display HUD must start hidden (unobstructed)");

        await app.pressKey("Escape");
        await sleep(50);
        const winClosed = await app.getWindowState();
        ctx.assert.equal(winClosed?.fullscreen, false, "Expected Escape to exit fullscreen");

        await app.clickButton(/Pass Display Check/i);
        await app.clickButton(/Next: Stage 07/i);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Touchscreen stage is active next and accepts multi-touch CDP events
        const hasTouch = await hasTouchscreenStep(app);
        ctx.assert.equal(hasTouch, true, "v2.3.0: Touchscreen step missing after Display Fullscreen");
        await waitForBodyMatch(app, /Touchscreen/i, 4000);
        const matrixRect = await app.evaluate(() => {
          const el = document.querySelector('[data-testid="touchscreen-matrix"]');
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        const baseRect =
          matrixRect && matrixRect.width > 40 && matrixRect.height > 40
            ? matrixRect
            : { left: 320, top: 320, width: 400, height: 200 };
        const y1 = Math.round(baseRect.top + baseRect.height * 0.35);
        const y2 = Math.round(baseRect.top + baseRect.height * 0.65);
        const x1a = Math.round(baseRect.left + baseRect.width * 0.2);
        const x1b = Math.round(baseRect.left + baseRect.width * 0.4);
        const x2a = Math.round(baseRect.left + baseRect.width * 0.6);
        const x2b = Math.round(baseRect.left + baseRect.width * 0.8);
        await app.dispatchMultiTouch([
          { id: 1, points: [{ x: x1a, y: y1 }, { x: x1b, y: y1 }] },
          { id: 2, points: [{ x: x2a, y: y2 }, { x: x2b, y: y2 }] },
        ]);
        await waitForBodyMatch(app, /([2-9]|10)\s*\/\s*10\s*Points/i, 4000);
        const postTouchText = await app.getBodyText();
        ctx.assert.match(
          postTouchText,
          /([1-9]\d*)\s*\/\s*160\s*\(/,
          "Touchscreen grid coverage must increment after multi-touch"
        );
      });
    },
  },

  {
    id: "T3-18",
    tier: 3,
    feature: "F15",
    title: "F15 × F17: Expanded MonitorTest patterns + HUD hover toggle + Swiss palette & attribution",
    tags: ["pairwise", "F15", "F17"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await sleep(40);
        await app.pressKey("ArrowRight");
        await app.pressKey("h");
        let hudVisibleOpacity = null;
        const hudDeadline = Date.now() + 1000;
        while (Date.now() < hudDeadline) {
          hudVisibleOpacity = await app.evaluate(() => {
            const portal = Array.from(document.body.children).find((c) => getComputedStyle(c).zIndex === "999999");
            const hud = portal
              ? Array.from(portal.querySelectorAll("div")).find((d) => /Click \/ Space: Next/i.test(d.textContent || ""))
              : null;
            return hud ? getComputedStyle(hud).opacity : null;
          });
          if (hudVisibleOpacity === "1") break;
          await sleep(30);
        }
        ctx.assert.equal(hudVisibleOpacity, "1", "Pressing 'h' should reveal Display HUD");
        await app.pressKey("Escape");
        await sleep(40);

        ctx.assert.assertSwissPalette(await app.auditSwissPalette({ excludeDisplaySwatches: true }));
        const bodyText = await app.getBodyText();
        ctx.assert.assertAttributionVisible(bodyText);
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Expanded MonitorTest patterns (>19 patterns: Moire / Persistence / Power-Supply Zooming)
        ctx.assert.match(
          bodyText,
          /Moir[eé]|Image Persistence|Power[- ]Supply\s*Zoom|2[0-9]-Pattern/i,
          "v2.3.0: DisplayTestView must include expanded MonitorTest patterns (Moire, Image Persistence, Power-Supply Zooming)"
        );
      });
    },
  },

  {
    id: "T3-19",
    tier: 3,
    feature: "F16",
    title: "F16 × F13: Keyboard/Touchpad/Media expanded scopes & crash-safe save_qc_session persistence",
    tags: ["pairwise", "F16", "F13"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /Keyboard & Touchpad Dead-Zone Audit/i);
        await app.pressKey("a");
        await app.pressKey("Escape");
        await waitForBodyMatch(app, /Keys Tested[\s\r\n]+2\s*\/\s*\d+/i, 4000);

        await app.clickButton(/02\. Touchpad/i);
        await app.clickButton(/Pass Input Audit/i);
        await waitForButtonEnabled(app, /Next: Stage/i, 4000);
        const kbText = await app.getBodyText();

        const invokeLog = await assertCleanRuntime(ctx, app);
        const saved = invokeLog.filter((e) => e.cmd === "save_qc_session");
        ctx.assert.ok(saved.length >= 1, "save_qc_session must be called on input verdict");

        await advanceCurrentStage(app);
        await advanceCurrentStage(app); // Biometrics -> Media (or Biometrics first)
        await navigateToStage(ctx, app, /Camera & Microphone Test/i);
        const mediaText = await app.getBodyText();

        // v2.3.0: Keyboard stuck-key/NKRO/latency & Media SNR readouts
        ctx.assert.match(
          kbText,
          /NKRO|Rollover|Latency|Stuck[- ]Key/i,
          "v2.3.0: KeyboardTestView must expose stuck-key pre-check, NKRO rollover, or key latency"
        );
        ctx.assert.match(
          mediaText,
          /SNR|Signal-to-Noise/i,
          "v2.3.0: MediaTestView must expose microphone SNR metric"
        );
      });
    },
  },

  {
    id: "T3-20",
    tier: 3,
    feature: "F18",
    title: "F18 × F17: PreReportModal validation, Swiss palette, attribution, and v2.3.0 certificate summary",
    tags: ["pairwise", "F18", "F17"],
    async run(ctx) {
      const fixture = enrichV230Fixture(ctx, {
        shopProfile: { shopName: "", technicianName: "" },
      });
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await advanceRemainingToReportModal(app);
        await app.clickButton(/Issue Official QC Certificate/i);
        await waitForBodyMatch(app, /Please enter at least a Shop Name or Technician Username\./i, 4000);

        await app.fillInput(/ProTech Laptop Store/i, "ProTech Precision Lab");
        await app.fillInput(/Hein Htet Zaw/i, "Hein Htet Zaw");
        await app.fillInput(/SKU-2026-041/i, "SKU-T3-20");

        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        const modalText = await app.getBodyText();
        ctx.assert.assertAttributionVisible(modalText);

        await app.clickButton(/Issue Official QC Certificate/i);
        await waitForBodyMatch(app, /Certificate Issued Successfully/i, 5000);
        const postText = await app.getBodyText();
        ctx.assert.match(postText, /Open PDF/i);
        ctx.assert.match(postText, /Open HTML/i);
        ctx.assert.match(postText, /Folder/i);

        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "export_qc_report"), true);

        // v2.3.0: PreReportModal displays UserBenchmark, Battery Discharge Normality, AND Touchscreen summaries
        ctx.assert.match(
          modalText,
          /UserBenchmark|Vehicle Tier/i,
          "v2.3.0: PreReportModal must display UserBenchmark / Vehicle Tier summary"
        );
        ctx.assert.match(
          modalText,
          /Battery.*Discharge/i,
          "v2.3.0: PreReportModal must display Battery Discharge Normality summary"
        );
        ctx.assert.match(
          modalText,
          /Touchscreen/i,
          "v2.3.0: PreReportModal must display Touchscreen summary"
        );
      });
    },
  },

  {
    id: "T3-21",
    tier: 3,
    feature: "F19",
    title: "F19 × F20: Version 2.3.0 alignment across manifests/UI/reports & macOS #[cfg] parity",
    tags: ["pairwise", "F19", "F20"],
    async run(ctx) {
      const releaseYml = ctx.cli.readRepoFile(".github/workflows/release.yml");
      ctx.assert.match(releaseYml, /universal-apple-darwin/);
      ctx.assert.match(releaseYml, /cargo check/);

      const specsRs = ctx.cli.readRepoFile("src-tauri/src/modules/specs.rs");
      ctx.assert.match(specsRs, /#\[cfg\(target_os = "macos"\)\]/);

      // v2.3.0: All 8 manifests/UI/report sources aligned to 2.3.0
      const align = ctx.cli.checkVersionAlignment("2.3.0");
      ctx.assert.equal(
        align.ok,
        true,
        `v2.3.0 version alignment mismatches: ${JSON.stringify(align.findings.filter((f) => !f.ok))}`
      );
    },
  },

  {
    id: "T3-22",
    tier: 3,
    feature: "F5",
    title: "F5 × F18: Low-space SSD guard triggers clean skip path into PreReportModal export",
    tags: ["pairwise", "F5", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.wornNvmeLowSpace());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /SSD SMART Health & Direct-IO Durability Audit/i);
        const storageBtns = await app.queryAll("button");
        const runDirectIoBtn = storageBtns.find(
          (b) => b.rect.width > 0 && b.rect.height > 0 && /Run Direct-IO Audit/i.test(b.text)
        );
        ctx.assert.ok(runDirectIoBtn, "Expected visible Run Direct-IO Audit button");
        ctx.assert.equal(runDirectIoBtn.disabled, true, "Proactive low-space guard must disable Run Direct-IO Audit");

        const storageText = await app.getBodyText();
        ctx.assert.match(storageText, /INSUFFICIENT FREE SPACE/i);
        ctx.assert.match(storageText, /2048\s*MB|2\.0\s*GB/i);
        ctx.assert.match(storageText, /0\.4\s*GB free/i);

        const preSkipLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(
          preSkipLog.some((e) => e.cmd === "run_storage_benchmark"),
          false,
          "Proactive low-space guard must prevent run_storage_benchmark IPC call"
        );

        await app.clickButton(/^Skip Step$/i);
        await advanceRemainingToReportModal(app);

        await app.fillInput(/ProTech Laptop Store/i, "Safe Budget Lab");
        await app.fillInput(/Hein Htet Zaw/i, "Hein Htet Zaw");
        await app.clickButton(/Issue Official QC Certificate/i);
        await waitForBodyMatch(app, /Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report not invoked");
        const payload = exportCall.args?.payload || exportCall.args;
        const storageEntry = payload.tests.find((t) => /SSD SMART|storage/i.test(t.name || t.id || ""));
        ctx.assert.equal(storageEntry?.status, "skipped", "Stage 05 should be recorded as skipped");
        ctx.assert.match(
          storageEntry?.summary || "",
          /104% used|CRITICAL NVMe WEAR/i,
          "Skipped Stage 05 summary must preserve SMART Log 0x02 warning"
        );
        const storageMetricMap = new Map(storageEntry?.metrics || []);
        ctx.assert.equal(storageMetricMap.get("Wear (Log 0x02)"), "104%");
        ctx.assert.equal(storageMetricMap.get("Spare"), "8%");
        ctx.assert.match(
          storageMetricMap.get("Write Budget") || "",
          /128\/256\/512\s*MB/i,
          "Skipped Stage 05 metrics must document SSD Write Budget protection"
        );

        // v2.3.0: report.rs documents safe SSD write-budget guard
        const reportRs = ctx.cli.readRepoFile("src-tauri/src/modules/report.rs");
        const reportProd = reportRs.split("#[cfg(test)]")[0];
        ctx.assert.match(reportProd, /write[- ]budget|128\s*MB/i, "v2.3.0: report.rs must reference SSD write-budget protection");
      });
    },
  },

  {
    id: "T3-23",
    tier: 3,
    feature: "F3",
    title: "F3 × F18: Offline shop QC executes UserBenchmark offline calibration & exports full dossier",
    tags: ["pairwise", "F3", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.offlineShopQc());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(ctx, app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await waitForBodyMatch(app, /104% of shop average/i, 5000);
        const perfText = await app.getBodyText();

        await advanceRemainingToReportModal(app);
        const modalText = await app.getBodyText();
        ctx.assert.match(modalText, /Yangon Refurbished Precision Lab/);
        await app.clickButton(/Issue Official QC Certificate/i);
        await waitForBodyMatch(app, /Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report not invoked");

        // v2.3.0: offline_calibrated UserBenchmark Vehicle Tier visible in PerformanceView & report
        ctx.assert.match(
          perfText,
          /Aircraft Carrier/i,
          "v2.3.0: Offline UserBenchmark Vehicle Tier (Aircraft Carrier) must be displayed in PerformanceView"
        );
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "compare_userbenchmark"),
          true,
          "v2.3.0: compare_userbenchmark must be invoked even when offline"
        );
      });
    },
  },

  {
    id: "T3-24",
    tier: 3,
    feature: "F1",
    title: "F1 × F4: Cargo check + cargo test + IPC command parity across lib.rs and src/types.ts",
    tags: ["pairwise", "F1", "F4"],
    async run(ctx) {
      const checkRes = await ctx.cli.runCargoCheck();
      ctx.assert.equal(
        checkRes.ok,
        true,
        `cargo check failed (exit=${checkRes.exitCode}): ${(checkRes.stderr || checkRes.stdout).slice(0, 400)}`
      );
      const testRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(
        testRes.ok,
        true,
        `cargo test failed (exit=${testRes.exitCode}): ${(testRes.stderr || testRes.stdout).slice(0, 400)}`
      );

      const libRs = ctx.cli.readRepoFile("src-tauri/src/lib.rs");
      ctx.assert.match(libRs, /compare_userbenchmark/);

      // v2.3.0: remaining M2 commands registered in lib.rs and mirrored in src/types.ts
      ctx.assert.match(libRs, /run_battery_discharge_test/, "v2.3.0: lib.rs missing run_battery_discharge_test");
      ctx.assert.match(libRs, /cancel_battery_discharge_test/, "v2.3.0: lib.rs missing cancel_battery_discharge_test");
      ctx.assert.match(libRs, /run_network_diagnostics/, "v2.3.0: lib.rs missing run_network_diagnostics");

      const srcTypes = ctx.cli.readRepoFile("src/types.ts");
      ctx.assert.match(srcTypes, /BatteryDischargeResult/, "v2.3.0: src/types.ts missing BatteryDischargeResult");
      ctx.assert.match(srcTypes, /NetworkDiagnosticsReport/, "v2.3.0: src/types.ts missing NetworkDiagnosticsReport");
    },
  },
];
