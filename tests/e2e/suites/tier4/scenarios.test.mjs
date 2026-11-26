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
  if (fixture.progressEvents && Array.isArray(fixture.progressEvents["battery:discharge"])) {
    fixture.progressEvents["battery:discharge"] = fixture.progressEvents["battery:discharge"].map((evt, idx) => ({
      chargeDropPct: idx === 0 ? 0.2 : 1.0,
      note: evt.phase || "Sampling battery discharge telemetry",
      ...evt,
    }));
  }
  return fixture;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function findButton(app, labelRegex) {
  const btns = await app.queryAll("button");
  return (
    btns.find(
      (b) =>
        b.rect.width > 0 &&
        b.rect.height > 0 &&
        (labelRegex.test(b.text) || labelRegex.test(b.title))
    ) || null
  );
}

async function findEnabledButton(app, labelRegex) {
  const btn = await findButton(app, labelRegex);
  return btn && !btn.disabled ? btn : null;
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
  throw new Error("Failed to reach PreReportModal");
}

export const tests = [
  {
    id: "T4-01",
    tier: 4,
    feature: "F18",
    title: "Scenario 1: Healthy Business Ultrabook Full QC (Pass All + Certificate Export)",
    tags: ["scenario", "F3", "F6", "F8", "F11", "F13", "F14", "F15", "F17", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.healthyUltrabook());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await app.waitForText(/ThinkPad X1 Carbon Gen 11/, 4000);
        await app.clickButton(/Begin Stage 01/i);

        // Stage 01: Specs
        await app.waitForText(/Complete Hardware Specifications/i, 4000);
        const specsText = await app.getBodyText();
        ctx.assert.match(specsText, /10 Cores \/ 12 Threads/i);
        ctx.assert.match(specsText, /Dual-Channel/i);
        ctx.assert.match(specsText, /RSSI 92%/i);
        await waitForButtonEnabled(app, /Next: Stage 02/i, 4000);
        await app.clickButton(/Next: Stage 02/i);

        // Stage 02: Security
        await app.waitForText(/Lock, MDM & License Audit/i, 4000);
        ctx.assert.match(await app.getBodyText(), /No MDM lock/i);
        await waitForButtonEnabled(app, /Next: Stage 03/i, 4000);
        await app.clickButton(/Next: Stage 03/i);

        // Stage 03: Battery
        await app.waitForText(/Battery Health, Discharge Normality/i, 4000);
        const batText = await app.getBodyText();
        ctx.assert.match(batText, /91\.1%/);
        ctx.assert.match(batText, /64/);
        await app.clickButton(/Run 15s Sag Pulse/i);
        await app.waitForText(/Battery sag pulse normal/i, 4000);
        const dischargeBtn = await findEnabledButton(app, /Discharge Normality|Run Discharge Test/i);
        const hasDischargeUi = Boolean(dischargeBtn);
        if (hasDischargeUi) {
          await app.clickButton(/Discharge Normality|Run Discharge Test/i);
          const stopDeadline = Date.now() + 5000;
          while (Date.now() < stopDeadline && (await findButton(app, /^(Cancel|Abort|Stop)/i))) {
            await sleep(30);
          }
          ctx.assert.equal(
            await findButton(app, /^(Cancel|Abort|Stop)/i),
            null,
            "Discharge cancel/abort/stop button must disappear after discharge test completes"
          );
          await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 5000);
          if (await findButton(app, /Confirm PASS/i)) {
            await waitForButtonEnabled(app, /Confirm PASS/i, 5000);
          }
          await app.waitForText(/\bNORMAL\b/, 5000);
          const dischargeBody = await app.getBodyText();
          ctx.assert.ok(
            /\bNORMAL\b/.test(dischargeBody) && !/\bABNORMAL\b/.test(dischargeBody),
            `Expected completed discharge verdict NORMAL without ABNORMAL, got: ${dischargeBody}`
          );
        }
        if (await findEnabledButton(app, /Confirm PASS/i)) {
          await app.clickButton(/Confirm PASS/i);
        }
        await waitForButtonEnabled(app, /Next: Stage 04/i, 4000);
        await app.clickButton(/Next: Stage 04/i);

        // Stage 04: Error Logs
        await app.waitForText(/System Error & Crash Logs/i, 4000);
        ctx.assert.match(await app.getBodyText(), /0 critical crashes/i);
        await waitForButtonEnabled(app, /Next: Stage 05/i, 4000);
        await app.clickButton(/Next: Stage 05/i);

        // Stage 05: Storage
        await app.waitForText(/SSD SMART Health & Direct-IO Durability Audit/i, 4000);
        ctx.assert.match(await app.getBodyText(), /98%/);
        await app.clickButton(/Run Direct-IO Audit/i);
        await app.waitForText(/0 ERR/, 5000);
        await waitForButtonEnabled(app, /Next: Stage 06/i, 4000);
        const storageText = await app.getBodyText();
        ctx.assert.match(storageText, /6120|6,120/);
        ctx.assert.match(storageText, /0 ERR/);
        await app.clickButton(/Next: Stage 06/i);

        // Stage 06: Display Fullscreen
        await app.waitForText(/Display Check/i, 4000);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await sleep(40);
        ctx.assert.equal((await app.getWindowState())?.fullscreen, true, "Display fullscreen must activate");
        await app.pressKey("ArrowRight");
        await app.pressKey("Escape");
        await sleep(40);
        ctx.assert.equal((await app.getWindowState())?.fullscreen, false, "Escape must exit fullscreen");
        await app.clickButton(/Pass Display Check/i);
        await waitForButtonEnabled(app, /Next: Stage 07/i, 4000);
        await app.clickButton(/Next: Stage 07/i);

        // Optional v2.3.0 Touchscreen Stage
        const touchStepPresent = await hasTouchscreenStep(app);
        if (touchStepPresent) {
          await app.waitForText(/Touchscreen & Multi-Touch Digitizer Test/i, 4000);
          await app.evaluate(() => {
            document.querySelector('[data-testid="touchscreen-matrix"]')?.scrollIntoView({ block: "center" });
          });
          await sleep(30);
          const matrixRect = await app.getElementRect('[data-testid="touchscreen-matrix"]');
          ctx.assert.ok(matrixRect && matrixRect.width > 100 && matrixRect.height > 100, "Touchscreen matrix rect missing");
          await app.dispatchMultiTouch([
            {
              id: 1,
              points: [
                { x: matrixRect.left + matrixRect.width * 0.2, y: matrixRect.top + matrixRect.height * 0.3 },
                { x: matrixRect.left + matrixRect.width * 0.45, y: matrixRect.top + matrixRect.height * 0.3 },
              ],
            },
            {
              id: 2,
              points: [
                { x: matrixRect.left + matrixRect.width * 0.55, y: matrixRect.top + matrixRect.height * 0.65 },
                { x: matrixRect.left + matrixRect.width * 0.8, y: matrixRect.top + matrixRect.height * 0.65 },
              ],
            },
          ]);
          await app.waitForText(/([2-9]|10)\s*\/\s*10\s*Points/i, 4000);
          const touchBody = await app.getBodyText();
          const covMatch = touchBody.match(/(\d+)\s*\/\s*160\s*\(/);
          ctx.assert.ok(covMatch && Number(covMatch[1]) >= 1, `Expected coveredCells >= 1, got: ${touchBody.slice(0, 300)}`);
          await waitForButtonEnabled(app, /Pass Touchscreen Test/i, 4000);
          await app.clickButton(/Pass Touchscreen Test/i);
          await waitForButtonEnabled(app, /Next: Stage 08/i, 4000);
          await app.clickButton(/Next: Stage 08/i);
        }

        // Keyboard
        await app.waitForText(/Keyboard & Touchpad Dead-Zone Audit/i, 4000);
        await app.pressKey("a");
        await app.clickButton(/Pass Input Audit/i);
        await advanceCurrentStage(app);

        // Biometrics
        await app.waitForText(/Fingerprint & Face ID Biometrics/i, 4000);
        await app.clickButton(/Approve Hardware OK/i);
        await advanceCurrentStage(app);

        // Media
        await app.waitForText(/Camera & Microphone Test/i, 4000);
        await app.clickButton(/Pass Camera & Mic/i);
        await advanceCurrentStage(app);

        // RAM
        await app.waitForText(/RAM Continuous Durability Audit/i, 4000);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/24\.0 GB/, 5000);
        await advanceCurrentStage(app);

        // Performance
        await app.waitForText(/360° All-Scope Performance/i, 4000);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/16,450/, 6000);
        const perfText = await app.getBodyText();
        ctx.assert.match(perfText, /A\+/);
        await advanceCurrentStage(app);

        // GPU
        await app.waitForText(/GPU Burn-In, Dedicated VRAM Integrity/i, 4000);
        await app.clickButton(/Mark N\/A \(Office iGPU\)/i);
        await advanceCurrentStage(app);

        // Ports & Speakers
        await app.waitForText(/Live USB4\/3\.x Speed Detector/i, 4000);
        await app.clickButton(/Pass Ports & Speakers/i);
        await waitForButtonEnabled(app, /^Issue QC Certificate$/i, 4000);
        await app.clickButton(/^Issue QC Certificate$/i);

        // PreReportModal
        await app.waitForText(/SWISS LAB CALIBRATION CERTIFICATE GENERATOR/i, 4000);
        await app.fillInput(/SKU-2026-041/i, "SKU-X1C-2026-01");
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report was not invoked");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.overallVerdict, "PASSED");
        ctx.assert.equal(payload.durabilityGrade, "A+");
        ctx.assert.equal(payload.specs?.serialNumber, "PF4X9102");
        const touchEntry = payload.tests?.find((t) => t.id === "touchscreen");
        ctx.assert.equal(touchEntry?.status, "pass", "Touchscreen stage must be recorded as pass");
        ctx.assert.equal(payload.touchscreen?.verdict, "PASS", "Touchscreen result verdict must be PASS");

        // v2.3.0 assertions
        ctx.assert.equal(touchStepPresent, true, "v2.3.0: Touchscreen step must be present in sequential pipeline");
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "compare_userbenchmark"),
          true,
          "v2.3.0: compare_userbenchmark must be invoked during full QC"
        );
        ctx.assert.equal(
          hasDischargeUi,
          true,
          "v2.3.0: BatteryView must expose Battery Discharge Normality UI button"
        );
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "run_battery_discharge_test"),
          true,
          "v2.3.0: run_battery_discharge_test must be integrated into Battery stage"
        );
      });
    },
  },

  {
    id: "T4-02",
    tier: 4,
    feature: "F9",
    title: "Scenario 2: Throttling & Worn-Battery Gaming Laptop (Thermal Cutoff + Abnormal Battery + Raft)",
    tags: ["scenario", "F3", "F8", "F9", "F10", "F11", "F17", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.throttlingGamingLaptop());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        const dashText = await app.getBodyText();
        ctx.assert.match(dashText, /dGPU/);
        ctx.assert.match(dashText, /96°C/);

        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        const batText = await app.getBodyText();
        ctx.assert.match(batText, /54\.0%/);
        ctx.assert.match(batText, /Wear:\s*46\.0%/);
        ctx.assert.match(batText, /512/);
        const dischargeBtn = await findEnabledButton(app, /Discharge Normality|Run Discharge Test/i);
        const hasDischargeUi = Boolean(dischargeBtn);
        if (hasDischargeUi) {
          await app.clickButton(/Discharge Normality|Run Discharge Test/i);
          await app.waitForText(/ABNORMAL/i, 5000);
          const postDischargeText = await app.getBodyText();
          ctx.assert.match(postDischargeText, /ABNORMAL/i);
          ctx.assert.match(postDischargeText, /24(?:\.0)?%|CV/i);
          ctx.assert.match(postDischargeText, /4\.5%|cliff/i);
        }
        if (await findEnabledButton(app, /Mark WARN/i)) {
          await app.clickButton(/Mark WARN/i);
        }

        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/31\.5%/, 5000);
        const perfText = await app.getBodyText();
        ctx.assert.match(perfText, /BELOW NORMAL \(THROTTLING\)/);

        await advanceCurrentStage(app);
        await app.waitForText(/GPU Burn-In, Dedicated VRAM Integrity/i, 4000);
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/FAIL \/ THERMAL CUTOFF/i, 5000);
        const gpuText1 = await app.getBodyText();
        ctx.assert.match(gpuText1, /41\.0%/);
        ctx.assert.match(gpuText1, /93/);

        await app.clickButton(/03\. Power & AC Torture/i);
        await app.clickButton(/Launch Combined Torture/i);
        await app.waitForText(/ALERT: BATTERY DRAINING WHILE AC CHARGER PLUGGED IN/i, 5000);
        await app.waitForText(/Durability Grade/i, 5000);
        await waitForButtonEnabled(app, /Next: Stage/i, 5000);
        const gpuText2 = await app.getBodyText();
        ctx.assert.match(gpuText2, /-4\.0%/);

        await advanceRemainingToReportModal(app);
        const modalText = await app.getBodyText();
        ctx.assert.match(modalText, /FAILED/);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(modalText);

        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);
        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.overallVerdict, "FAILED");
        ctx.assert.equal(payload.durabilityGrade, "FAIL");

        // v2.3.0: UserBenchmark Raft/Underperforming & ABNORMAL Battery Discharge UI
        ctx.assert.match(
          `${perfText}\n${gpuText2}`,
          /Raft|Speedboat|Underperforming/i,
          "v2.3.0: Throttling gaming laptop UI must surface UserBenchmark Raft/Speedboat standing"
        );
        ctx.assert.equal(
          hasDischargeUi,
          true,
          "v2.3.0: BatteryView must expose Battery Discharge Normality UI button"
        );
        ctx.assert.equal(
          invokeLog.some((e) => e.cmd === "run_battery_discharge_test"),
          true,
          "v2.3.0: Battery Discharge Normality test must be runnable on BatteryView"
        );
      });
    },
  },

  {
    id: "T4-03",
    tier: 4,
    feature: "F12",
    title: "Scenario 3: Non-Touch Corporate ThinkPad with Locked MDM & BitLocker",
    tags: ["scenario", "F12", "F13", "F14", "F17", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.nonTouchCorporate());
      await withApp(ctx, fixture, { maxTouchPoints: 0 }, async (app) => {
        ctx.assert.equal(await app.evaluate(() => navigator.maxTouchPoints), 0);

        await navigateToStage(app, /Lock, MDM & License Audit/i);
        const secText = await app.getBodyText();
        ctx.assert.match(secText, /CRITICAL: Corporate MDM \/ Autopilot lock active/i);
        ctx.assert.match(secText, /ENROLLED \(Contoso Corp\)/);
        ctx.assert.match(secText, /Encrypted \(Active\)/);

        await navigateToStage(app, /Display Check/i);
        await app.clickButton(/Pass Display Check/i);
        await advanceCurrentStage(app);

        const touchStepPresent = await hasTouchscreenStep(app);
        if (touchStepPresent) {
          await app.waitForText(/Touchscreen & Multi-Touch Digitizer Test/i, 4000);
          await app.waitForText(/No Touchscreen Detected — Click Skip Step/i, 4000);
          await app.clickButton(/^Skip Step$/i);
        }

        await advanceRemainingToReportModal(app);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.overallVerdict, "FAILED");
        const secEntry = payload.tests.find((t) => /Lock, MDM|security/i.test(t.name || t.id || ""));
        ctx.assert.equal(secEntry?.status, "fail");
        const touchEntry = payload.tests.find((t) => t.id === "touchscreen");
        ctx.assert.equal(touchEntry?.status, "skipped", "Non-touch Touchscreen stage must be recorded as skipped");
        ctx.assert.equal(payload.touchscreen?.verdict, "SKIPPED", "Touchscreen payload verdict must be SKIPPED");

        // v2.3.0: Touchscreen step present & recorded as skipped on non-touch corporate ThinkPad
        ctx.assert.equal(touchStepPresent, true, "v2.3.0: Touchscreen step must exist for non-touch Skip Step");
      });
    },
  },

  {
    id: "T4-04",
    tier: 4,
    feature: "F11",
    title: "Scenario 4: Desktop / AC-Only Workstation (No Battery NOT_APPLICABLE, RTX 4080, UFO Tier)",
    tags: ["scenario", "F3", "F7", "F9", "F11", "F13", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.desktopAcOnly());
      await withApp(ctx, fixture, { maxTouchPoints: 0 }, async (app) => {
        await navigateToStage(app, /Complete Hardware Specifications/i);
        const specsText = await app.getBodyText();
        ctx.assert.match(specsText, /24 Cores \/ 32 Threads|24/);
        ctx.assert.match(specsText, /64\.0 GB|64 GB/);
        ctx.assert.match(specsText, /NVIDIA GeForce RTX 4080/);

        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        const batBody = await app.getBodyText();
        ctx.assert.match(batBody, /No Internal Battery Detected/i);
        ctx.assert.match(batBody, /NOT_APPLICABLE/i);
        await waitForButtonEnabled(app, /Next: Stage 04/i, 4000);
        await app.clickButton(/Next: Stage 04/i);

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/24\.0 GB/, 5000);

        await navigateToStage(app, /GPU Burn-In, Dedicated VRAM Integrity/i);
        const gpuBtns = await app.queryAll("button");
        ctx.assert.equal(
          gpuBtns.some((b) => /Mark N\/A \(Office iGPU\)/i.test(b.text)),
          false,
          "Mark N/A (Office iGPU) must NOT appear on discrete RTX 4080 workstation"
        );
        await app.clickButton(/Start GPU Burn-In/i);
        await app.waitForText(/EXCELLENT/, 5000);
        await waitForButtonEnabled(app, /Next: Stage/i, 5000);
        ctx.assert.match(await app.getBodyText(), /52\.4/);
        await app.clickButton(/02\. VRAM Integrity/i);
        await app.clickButton(/Start VRAM Sweep/i);
        await app.waitForText(/6\.0 GB/, 5000);
        await waitForButtonEnabled(app, /Next: Stage/i, 5000);
        await app.clickButton(/03\. Power & AC Torture/i);
        await app.clickButton(/Launch Combined Torture/i);
        await app.waitForText(/Power & thermal torture passed|EXCELLENT/i, 5000);
        await waitForButtonEnabled(app, /Next: Stage/i, 5000);

        await advanceRemainingToReportModal(app);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        const payload = exportCall.args?.payload || exportCall.args;
        const batEntry = payload.tests.find((t) => /Battery/i.test(t.name || t.id || ""));
        ctx.assert.equal(batEntry?.status, "notApplicable");

        // v2.3.0: UFO tier & NOT_APPLICABLE Battery Discharge UI
        const modalText = await app.getBodyText();
        ctx.assert.match(modalText, /UFO/i, "v2.3.0: Workstation must display UFO UserBenchmark tier");
        ctx.assert.equal(
          payload.userBenchmark?.overallVehicleTier,
          "UFO",
          "v2.3.0: export_qc_report payload must carry userBenchmark.overallVehicleTier === 'UFO'"
        );
      });
    },
  },

  {
    id: "T4-05",
    tier: 4,
    feature: "F3",
    title: "Scenario 5: Offline Pawn/Repair Shop QC Workflow (Shop DB + Offline UserBenchmark + Export)",
    tags: ["scenario", "F3", "F12", "F13", "F17", "F18", "F19"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.offlineShopQc());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await app.clickButton(/Shop DB/i);
        await app.waitForText(/Shop Model History Database/i, 4000);
        const shopDbText = await app.getBodyText();
        ctx.assert.match(shopDbText, /LENOVO ThinkPad X1 Carbon Gen 11/);
        ctx.assert.match(shopDbText, /Dell Latitude 7430/);
        ctx.assert.match(shopDbText, /Apple MacBook Pro M2/);
        await app.clickButton(/Export JSON/i);
        await app.waitForText(/Exported 3/i, 4000);
        await app.evaluate(() => {
          const h2 = Array.from(document.querySelectorAll("h2")).find((el) =>
            (el.textContent || "").includes("Shop Model History Database")
          );
          h2?.parentElement?.parentElement?.querySelector("button")?.click();
        });
        await sleep(40);

        await navigateToStage(app, /360° All-Scope Performance/i);
        await app.clickButton(/Run 14-Stage Suite/i);
        await app.waitForText(/104% of shop average/i, 5000);
        const perfText = await app.getBodyText();

        await advanceRemainingToReportModal(app);
        ctx.assert.match(await app.getBodyText(), /Yangon Refurbished Precision Lab/);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);

        const invokeLog = await assertCleanRuntime(ctx, app);
        ctx.assert.equal(invokeLog.some((e) => e.cmd === "export_shop_history"), true);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report was not invoked");
        const payload = exportCall.args?.payload || exportCall.args;

        // v2.3.0: Offline UserBenchmark Aircraft Carrier & offline --self-test check
        ctx.assert.match(perfText, /Aircraft Carrier/i, "v2.3.0: Offline UserBenchmark tier must render in PerformanceView");
        ctx.assert.match(perfText, /Offline Calibrated/i, "v2.3.0: Offline UserBenchmark badge must render 'Offline Calibrated'");
        ctx.assert.equal(payload.userBenchmark?.sourceMode, "offline_calibrated");
        ctx.assert.equal(payload.userBenchmark?.overallVehicleTier, "Aircraft Carrier");
        const selfTest = await ctx.cli.runSelfTest();
        ctx.assert.equal(selfTest.ok, true, "--self-test failed");
        ctx.assert.match(`${selfTest.stdout}\n${selfTest.stderr}`, /UserBenchmark/i, "v2.3.0: --self-test must verify offline UserBenchmark");
      });
    },
  },

  {
    id: "T4-06",
    tier: 4,
    feature: "F6",
    title: "Scenario 6: Worn NVMe & Low-Disk-Space Laptop (SMART Log 0x02 >100% Used + Write Budget Guard)",
    tags: ["scenario", "F5", "F6", "F12", "F17", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.wornNvmeLowSpace());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(app, /Complete Hardware Specifications/i);
        ctx.assert.match(await app.getBodyText(), /0\.4 GB|410/);

        await navigateToStage(app, /SSD SMART Health & Direct-IO Durability Audit/i);
        const smartText = await app.getBodyText();
        ctx.assert.match(smartText, /WDC PC SN530 256GB/);
        ctx.assert.match(smartText, /FAIL/);
        ctx.assert.match(smartText, /0%/);
        ctx.assert.match(smartText, /104%/);
        ctx.assert.match(smartText, /12/);
        ctx.assert.match(smartText, /158\.4 TB/);
        ctx.assert.match(smartText, /8% Available Spare/);
        ctx.assert.match(smartText, /84 Unsafe Shutdowns/);

        const runDirectIoBtn = await findButton(app, /Run Direct-IO Audit/i);
        ctx.assert.ok(runDirectIoBtn, "Run Direct-IO Audit button must be visible on StorageView");
        ctx.assert.equal(
          runDirectIoBtn.disabled,
          true,
          "Run Direct-IO Audit must be proactively disabled when free space < 2048 MB"
        );
        const skipStepBtn = await findEnabledButton(app, /^Skip Step$/i);
        ctx.assert.ok(skipStepBtn, "Skip Step must remain enabled when proactive low-space guard is active");
        const guardText = await app.getBodyText();
        ctx.assert.match(guardText, /INSUFFICIENT FREE SPACE/i);
        ctx.assert.match(guardText, /128 MB/);
        ctx.assert.match(guardText, /2048 MB|2\.0 GB/);
        ctx.assert.match(guardText, /0\.4 GB free/i);
        const preSkipInvokeLog = await app.getInvokeLog();
        ctx.assert.equal(
          preSkipInvokeLog.some((e) => e.cmd === "run_storage_benchmark"),
          false,
          "Proactive low-space guard must prevent run_storage_benchmark IPC call"
        );

        await app.clickButton(/^Skip Step$/i);
        await advanceRemainingToReportModal(app);
        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);
        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report was not invoked");
        const payload = exportCall.args?.payload || exportCall.args;
        const storageEntry = payload.tests?.find((t) => t.id === "storage");
        ctx.assert.equal(storageEntry?.status, "skipped", "Storage stage must be preserved as skipped in report payload");
        const metricMap = Object.fromEntries(storageEntry?.metrics || []);
        ctx.assert.equal(metricMap["Wear (Log 0x02)"], "104%");
        ctx.assert.equal(metricMap["Spare"], "8%");
        ctx.assert.equal(metricMap["Media Err"], "12");
        ctx.assert.equal(metricMap["Unsafe Off"], "84");
        ctx.assert.ok(metricMap["Write Budget"], "Write Budget metric must be preserved in skipped storage report entry");

        // v2.3.0: Storage preset labels reflect safe budget & storage.rs enforces 4x free-space guard
        const storageRs = ctx.cli.readRepoFile("src-tauri/src/modules/storage.rs");
        ctx.assert.match(
          storageRs,
          /SSD_FREE_SPACE_MULTIPLIER|SSD_WRITE_BUDGET_QUICK_MB/,
          "v2.3.0: storage.rs must enforce safe SSD write budget & 4x free-space guard"
        );
        ctx.assert.match(storageRs, /validate_free_space_mb/);
        ctx.assert.match(storageRs, /\.max\(2048\)/);
        ctx.assert.match(storageRs, /TempFileGuard/);
      });
    },
  },

  {
    id: "T4-07",
    tier: 4,
    feature: "F7",
    title: "Scenario 7: Single-Channel RAM & Slow Wi-Fi Refurbished Laptop (Bottleneck + Network Audit)",
    tags: ["scenario", "F3", "F7", "F12", "F16", "F17"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.singleChannelSlowWifi());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(app, /Complete Hardware Specifications/i);
        const specsText = await app.getBodyText();
        ctx.assert.match(specsText, /Single-channel RAM detected/i);
        ctx.assert.match(specsText, /Weak Wi-Fi signal \(-82 dBm \/ 28%\)/i);
        ctx.assert.match(specsText, /RSSI 28% \(-82 dBm\)/);

        const netCallsBefore = (await app.getInvokeLog()).filter((e) => e.cmd === "run_network_diagnostics").length;
        await waitForButtonEnabled(app, /Run Network Check/i, 4000);
        await app.clickButton(/Run Network Check/i);
        await app.waitForText(/68\.5\s*ms/i, 4000);
        const postSpecsText = await app.getBodyText();
        ctx.assert.match(postSpecsText, /6\.0%|6%/);

        await navigateToStage(app, /RAM Continuous Durability Audit/i);
        await app.clickButton(/Start Continuous Test/i);
        await app.waitForText(/16\.8/, 5000);
        const ramText = await app.getBodyText();
        ctx.assert.match(ramText, /BELOW NORMAL/);
        ctx.assert.match(ramText, /56\.0% OF NORMAL/);

        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(ramText);
        const invokeLog = await assertCleanRuntime(ctx, app);

        // v2.3.0: run_network_diagnostics & UserBenchmark Speedboat/upgrade recommendation
        const netCallsAfter = invokeLog.filter((e) => e.cmd === "run_network_diagnostics" && e.ok).length;
        ctx.assert.ok(
          netCallsAfter > netCallsBefore,
          `v2.3.0: clicking Run Network Check must invoke run_network_diagnostics (before=${netCallsBefore}, after=${netCallsAfter})`
        );
        ctx.assert.match(
          `${postSpecsText}\n${ramText}`,
          /Speedboat|Below Expectations|adding a matching 8GB stick/i,
          "v2.3.0: RAM UserBenchmark standing & upgrade recommendation must appear in UI"
        );
      });
    },
  },

  {
    id: "T4-08",
    tier: 4,
    feature: "F13",
    title: "Scenario 8: Low-Battery (12%) & AC-Plugged Technician Recovery Flow",
    tags: ["scenario", "F11", "F13", "F16", "F17"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.lowBattery());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(app, /Battery Health, Discharge Normality/i);
        let text = await app.getBodyText();
        ctx.assert.match(text, /12%/);
        ctx.assert.match(text, /ON BATTERY/i);

        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 4000);
        await app.clickButton(/Discharge Normality|Run Discharge Test/i);
        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 5000);
        await app.waitForText(/Discharge test aborted safely/i, 4000);
        const lowBody = await app.getBodyText();
        ctx.assert.match(lowBody, /ABORTED_LOW_BATTERY/);
        let dischargeCalls = (await assertCleanRuntime(ctx, app)).filter(
          (e) => e.cmd === "run_battery_discharge_test"
        ).length;
        ctx.assert.equal(dischargeCalls, 1, "Expected 1st run_battery_discharge_test call on low battery");

        // Technician plugs in AC -> patch fixture to acPlugged(78%) and Refresh
        const acPatch = enrichScenario(ctx.fixtures.acPlugged());
        await app.evaluate((p) => window.__TAURI_MOCK__.setFixturePatch(p), {
          batteryHealth: acPatch.batteryHealth,
          batteryDischarge: acPatch.batteryDischarge,
          telemetry: acPatch.telemetry,
        });
        await app.clickButton(/Refresh/i);
        await app.waitForText(/78%/, 4000);
        text = await app.getBodyText();
        ctx.assert.match(text, /AC CHARGING/i);

        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 4000);
        await app.clickButton(/Discharge Normality|Run Discharge Test/i);
        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 5000);
        await app.waitForText(/AC power adapter is currently plugged in/i, 4000);
        ctx.assert.match(await app.getBodyText(), /AC_CONNECTED/);
        dischargeCalls = (await assertCleanRuntime(ctx, app)).filter(
          (e) => e.cmd === "run_battery_discharge_test"
        ).length;
        ctx.assert.equal(dischargeCalls, 2, "Expected 2nd run_battery_discharge_test call on AC connected");

        // Technician tests live discharge + charge recovery flow
        const healthyPatch = enrichScenario(ctx.fixtures.healthyUltrabook());
        await app.evaluate((p) => window.__TAURI_MOCK__.setFixturePatch(p), {
          batteryHealth: healthyPatch.batteryHealth,
          batteryDischarge: healthyPatch.batteryDischarge,
          telemetry: healthyPatch.telemetry,
        });
        await app.clickButton(/Refresh/i);
        await app.waitForText(/92%/, 4000);

        await app.clickButton(/Start Live Monitor/i);
        await sleep(40);
        await app.emitTauriEvent("battery:sample", {
          timestampMs: Date.now(),
          chargePercent: 91.5,
          acPlugged: false,
          isCharging: false,
          voltageMv: 15900,
          rateMw: -14000,
          watts: -14.0,
        });
        await app.waitForText(/Verified battery-only discharge\./i, 4000);

        await app.emitTauriEvent("battery:sample", {
          timestampMs: Date.now(),
          chargePercent: 92.0,
          acPlugged: true,
          isCharging: true,
          voltageMv: 16500,
          rateMw: 28000,
          watts: 28.0,
        });
        await app.waitForText(/Verified AC adapter & charging\./i, 4000);
        await app.clickButton(/Confirm PASS/i);
        await waitForButtonEnabled(app, /Next: Stage 04/i, 4000);
        await app.clickButton(/Next: Stage 04/i);
        await app.waitForText(/System Error & Crash Logs/i, 4000);

        ctx.assert.assertSwissPalette(await app.auditSwissPalette());
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Battery Discharge Normality UI must exist on BatteryView
        await app.clickStep(/Battery & Charging/i);
        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 4000);
        await app.clickButton(/Discharge Normality|Run Discharge Test/i);
        await waitForButtonEnabled(app, /Discharge Normality|Run Discharge Test/i, 5000);
        await app.waitForText(/Battery discharges smoothly and predictably/i, 4000);
        const finalBody = await app.getBodyText();
        ctx.assert.ok(/\bNORMAL\b/.test(finalBody) && !/\bABNORMAL\b/.test(finalBody), "Expected NORMAL post-run verdict");
        dischargeCalls = (await assertCleanRuntime(ctx, app)).filter(
          (e) => e.cmd === "run_battery_discharge_test"
        ).length;
        ctx.assert.equal(dischargeCalls, 3, "Expected 3rd run_battery_discharge_test call on healthy battery");
      });
    },
  },

  {
    id: "T4-09",
    tier: 4,
    feature: "F15",
    title: "Scenario 9: Unobstructed Display Inspection + Touchscreen Dead-Zone / Multi-Touch Failure",
    tags: ["scenario", "F13", "F14", "F15", "F16", "F18"],
    async run(ctx) {
      const fixture = enrichScenario(ctx.fixtures.displayTouchscreenFail());
      await withApp(ctx, fixture, { maxTouchPoints: 10 }, async (app) => {
        await navigateToStage(app, /Display Check/i);
        await app.clickButton(/Launch True Fullscreen Test/i);
        await sleep(40);

        const portalGeom = await app.evaluate(() => {
          const portal = Array.from(document.body.children).find((c) => {
            const cs = getComputedStyle(c);
            return cs.position === "fixed" && cs.zIndex === "999999";
          });
          if (!portal) return null;
          const hud = Array.from(portal.querySelectorAll("div")).find((d) =>
            /Click \/ Space: Next/i.test(d.textContent || "")
          );
          const r = portal.getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            hudOpacity: hud ? getComputedStyle(hud).opacity : null,
            hudPointerEvents: hud ? getComputedStyle(hud).pointerEvents : null,
          };
        });
        ctx.assert.ok(portalGeom && portalGeom.width >= 1300 && portalGeom.height >= 800);
        ctx.assert.equal(portalGeom.hudOpacity, "0");
        ctx.assert.equal(portalGeom.hudPointerEvents, "none");

        await app.pressKey("ArrowRight");
        await app.hoverAt(680, 860);
        let hudAfterHover = null;
        const hudDeadline = Date.now() + 1000;
        while (Date.now() < hudDeadline) {
          hudAfterHover = await app.evaluate(() => {
            const portal = Array.from(document.body.children).find((c) => getComputedStyle(c).zIndex === "999999");
            const hud = portal
              ? Array.from(portal.querySelectorAll("div")).find((d) => /Click \/ Space: Next/i.test(d.textContent || ""))
              : null;
            return hud ? getComputedStyle(hud).opacity : null;
          });
          if (hudAfterHover === "1") break;
          await sleep(30);
        }
        ctx.assert.equal(hudAfterHover, "1", "Bottom hover must reveal Display HUD");

        await app.pressKey("Escape");
        await sleep(40);
        ctx.assert.equal((await app.getWindowState())?.fullscreen, false);
        await app.clickButton(/Pass Display Check/i);
        await app.clickButton(/Next: Stage 07/i);

        ctx.assert.assertSwissPalette(await app.auditSwissPalette({ excludeDisplaySwatches: true }));
        ctx.assert.assertAttributionVisible(await app.getBodyText());
        await assertCleanRuntime(ctx, app);

        // v2.3.0: Touchscreen step must exist after Display & report dead-zone / multi-touch failure
        const hasTouch = await hasTouchscreenStep(app);
        ctx.assert.equal(hasTouch, true, "v2.3.0: Touchscreen step missing after Display Fullscreen");
        await app.waitForText(/Touchscreen & Multi-Touch Digitizer Test/i, 4000);
        const passBeforeTouch = await findButton(app, /Pass Touchscreen Test/i);
        ctx.assert.ok(passBeforeTouch && passBeforeTouch.disabled, "Pass Touchscreen Test must start disabled before touch input");
        await app.evaluate(() => {
          document.querySelector('[data-testid="touchscreen-matrix"]')?.scrollIntoView({ block: "center" });
        });
        await sleep(30);
        const matrixRect = await app.getElementRect('[data-testid="touchscreen-matrix"]');
        ctx.assert.ok(matrixRect && matrixRect.width > 100 && matrixRect.height > 100, "Touchscreen matrix rect missing");
        await app.dispatchTouchGesture([
          { x: matrixRect.left + matrixRect.width * 0.25, y: matrixRect.top + matrixRect.height * 0.45 },
          { x: matrixRect.left + matrixRect.width * 0.5, y: matrixRect.top + matrixRect.height * 0.45 },
        ]);
        await app.waitForText(/1\s*\/\s*10\s*Points/i, 4000);
        const touchBody = await app.getBodyText();
        const covMatch = touchBody.match(/(\d+)\s*\/\s*160\s*\(/);
        ctx.assert.ok(covMatch && Number(covMatch[1]) >= 1, `Expected >= 1 / 160 cells hit, got: ${touchBody.slice(0, 300)}`);
        await app.clickButton(/Fail Touchscreen|Mark FAIL/i);
        await advanceRemainingToReportModal(app);
        ctx.assert.match(await app.getBodyText(), /FAILED/);
        await app.clickButton(/Issue Official QC Certificate/i);
        await app.waitForText(/Certificate Issued Successfully/i, 5000);
        const invokeLog = await assertCleanRuntime(ctx, app);
        const exportCall = invokeLog.find((e) => e.cmd === "export_qc_report");
        ctx.assert.ok(exportCall, "export_qc_report was not invoked");
        const payload = exportCall.args?.payload || exportCall.args;
        ctx.assert.equal(payload.overallVerdict, "FAILED");
        ctx.assert.equal(payload.touchscreen?.verdict, "FAIL");
        const touchEntry = payload.tests?.find((t) => t.id === "touchscreen");
        ctx.assert.equal(touchEntry?.status, "fail");
      });
    },
  },

  {
    id: "T4-10",
    tier: 4,
    feature: "F19",
    title: "Scenario 10: Full Shop Certification Validation (build + cargo check/test + --self-test + v2.3.0 consistency)",
    tags: ["scenario", "F1", "F4", "F19", "F20"],
    async run(ctx) {
      const build = await ctx.cli.ensureBuild();
      ctx.assert.equal(build.ok, true, `ensureBuild failed: ${build.stderr || build.stdout}`);
      const indexHtml = ctx.cli.readRepoFile("dist/index.html");
      ctx.assert.match(indexHtml, /LaptopBench QC/);

      const checkRes = await ctx.cli.runCargoCheck();
      ctx.assert.equal(checkRes.ok, true, `cargo check failed: ${(checkRes.stderr || checkRes.stdout).slice(0, 400)}`);

      const testRes = await ctx.cli.runCargoTest();
      ctx.assert.equal(testRes.ok, true, `cargo test failed: ${(testRes.stderr || testRes.stdout).slice(0, 400)}`);

      const selfTest = await ctx.cli.runSelfTest();
      ctx.assert.equal(selfTest.ok, true, `--self-test failed: ${(selfTest.stderr || selfTest.stdout).slice(0, 400)}`);
      const out = `${selfTest.stdout}\n${selfTest.stderr}`;
      ctx.assert.match(out, /\[PASS\]/);
      ctx.assert.equal(/\[FAIL\]/i.test(out), false, `--self-test reported [FAIL]: ${out}`);
      ctx.assert.match(out, /ALL v2\.3\.0 SELF-TESTS PASSED/i);

      const binaries = ctx.cli.checkNoBundledBinaries();
      ctx.assert.equal(binaries.ok, true, `Bundled binaries found: ${JSON.stringify(binaries.found)}`);

      const swissStatic = ctx.cli.checkSwissStaticColors();
      ctx.assert.equal(
        swissStatic.ok,
        true,
        `Static Swiss color violations: ${JSON.stringify(swissStatic.violations.slice(0, 5))}`
      );

      // v2.3.0: All 8 manifests/UI/report sources aligned to 2.3.0
      const align = ctx.cli.checkVersionAlignment("3.0.0");
      ctx.assert.equal(
        align.ok,
        true,
        `v2.3.0 version alignment mismatches: ${JSON.stringify(align.findings.filter((f) => !f.ok))}`
      );
    },
  },
];
