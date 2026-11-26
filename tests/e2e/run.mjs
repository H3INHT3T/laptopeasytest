import fs from "node:fs";
import path from "node:path";
import assertStrict from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCliRunner } from "./lib/cli-runner.mjs";
import { createBrowserManager } from "./lib/cdp-browser.mjs";
import * as fixtures from "./lib/fixtures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SUITES_DIR = path.join(__dirname, "suites");

function printHelp() {
  console.log(`LaptopBench QC E2E Runner (Node ${process.version}, zero-dependency ESM)

Usage:
  node tests/e2e/run.mjs [options]

Options:
  --all                   Run all discovered tests across tiers 1..5 (default)
  --tier <1|2|3|4|5>      Filter tests by tier (repeatable or comma-separated)
  --feature <F1..F20>     Filter tests by feature ID (repeatable or comma-separated)
  --list                  List discovered tests without executing
  --json                  Output machine-readable JSON report
  --no-build              Skip pnpm build if dist/index.html already exists
  --harness-smoke         Run built-in E2E-M1 harness smoke verification
  --timeout-ms <ms>       Per-test timeout in milliseconds (default: 30000)
  -h, --help              Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    tiers: new Set(),
    features: new Set(),
    list: false,
    json: false,
    noBuild: false,
    harnessSmoke: false,
    timeoutMs: 30000,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--list") {
      opts.list = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--no-build") {
      opts.noBuild = true;
    } else if (arg === "--harness-smoke") {
      opts.harnessSmoke = true;
    } else if (arg === "--tier" || arg.startsWith("--tier=")) {
      const val = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      if (!val) throw new Error("--tier requires a value (1|2|3|4|5)");
      for (const part of val.split(",")) {
        const n = Number(part.trim());
        if (![1, 2, 3, 4, 5].includes(n)) {
          throw new Error(`Invalid --tier value "${part}". Expected 1, 2, 3, 4, or 5.`);
        }
        opts.tiers.add(n);
      }
    } else if (arg === "--feature" || arg.startsWith("--feature=")) {
      const val = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      if (!val) throw new Error("--feature requires a value (e.g. F1..F20)");
      for (const part of val.split(",")) {
        const norm = part.trim().toUpperCase();
        if (!/^F\d+$/.test(norm)) {
          throw new Error(`Invalid --feature value "${part}". Expected F1..F20.`);
        }
        opts.features.add(norm);
      }
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const val = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --timeout-ms value "${val}". Expected positive number.`);
      }
      opts.timeoutMs = n;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

function collectTestFiles() {
  const files = [];
  for (const tierNum of [1, 2, 3, 4, 5]) {
    const tierDir = path.join(SUITES_DIR, `tier${tierNum}`);
    if (!fs.existsSync(tierDir)) continue;

    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
          files.push(full);
        }
      }
    };
    walk(tierDir);
  }
  return files;
}

async function discoverTests(opts) {
  const files = collectTestFiles();
  const discovered = [];

  for (const filePath of files) {
    const mod = await import(pathToFileURL(filePath).href);
    const list = Array.isArray(mod.tests) ? mod.tests : [];
    const relFile = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
    for (const desc of list) {
      if (!desc || typeof desc.id !== "string" || typeof desc.run !== "function") {
        throw new Error(`Invalid test descriptor in ${relFile}`);
      }
      const tier = Number(desc.tier);
      const feature = String(desc.feature || "").toUpperCase();
      if (opts.tiers.size > 0 && !opts.tiers.has(tier)) continue;
      if (opts.features.size > 0 && !opts.features.has(feature)) continue;
      discovered.push({
        id: desc.id,
        tier,
        feature,
        title: desc.title || desc.id,
        tags: Array.isArray(desc.tags) ? desc.tags : [],
        file: relFile,
        run: desc.run,
      });
    }
  }

  return { filesCount: files.length, tests: discovered };
}

function createHarnessSmokeTests() {
  return [
    {
      id: "SMOKE-01",
      tier: 0,
      feature: "HARNESS",
      title: "cli-runner ensures dist/ build, reads repo manifests, and verifies static invariants",
      tags: ["smoke", "cli"],
      async run(ctx) {
        const buildRes = await ctx.cli.ensureBuild();
        ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr || buildRes.stdout}`);

        const pkg = ctx.cli.readJson("package.json");
        ctx.assert.ok(typeof pkg.version === "string" && pkg.version.length > 0, "package.json missing version");

        const indexHtml = ctx.cli.readRepoFile("index.html");
        ctx.assert.ok(indexHtml.includes("LaptopBench QC"), "index.html missing title");

        const binariesCheck = ctx.cli.checkNoBundledBinaries();
        ctx.assert.equal(binariesCheck.ok, true, `Unexpected binaries: ${JSON.stringify(binariesCheck.found)}`);

        const staticPalette = ctx.cli.checkSwissStaticColors();
        ctx.assert.equal(staticPalette.ok, true, `Static color violations: ${JSON.stringify(staticPalette.violations)}`);
      },
    },
    {
      id: "SMOKE-02",
      tier: 0,
      feature: "HARNESS",
      title: "cdp-browser + tauri-ipc-mock mounts dist/, audits Swiss palette & attribution, exercises IPC/events/fullscreen/inputs",
      tags: ["smoke", "browser", "ipc"],
      async run(ctx) {
        const buildRes = await ctx.cli.ensureBuild();
        ctx.assert.equal(buildRes.ok, true, `ensureBuild failed: ${buildRes.stderr}`);

        const app = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook());
        try {
          await app.waitForText("LaptopBench QC", 8000);
          await app.waitForText("Inspection Manifest", 5000);

          const errors = await app.getPageErrors();
          ctx.assert.equal(errors.length, 0, `Unexpected page/console errors: ${JSON.stringify(errors)}`);

          const bodyText = await app.getBodyText();
          ctx.assert.assertAttributionVisible(bodyText);

          const palette = await app.auditSwissPalette();
          ctx.assert.assertSwissPalette(palette);
          ctx.assert.ok(palette.totalChecked > 20, "Expected auditSwissPalette to inspect > 20 CSS color properties");

          const invokeLog = await app.getInvokeLog();
          const cmds = new Set(invokeLog.map((e) => e.cmd));
          for (const requiredCmd of [
            "load_shop_profile",
            "get_system_specs",
            "run_security_audit",
            "get_battery_health",
            "scan_error_logs",
            "scan_storage_smart",
            "detect_biometrics_hardware",
            "sample_live_telemetry",
          ]) {
            ctx.assert.ok(cmds.has(requiredCmd), `Expected mount invoke for "${requiredCmd}"`);
          }
          const unknownCmds = invokeLog.filter((e) => e.unknownCommand);
          ctx.assert.equal(unknownCmds.length, 0, `Unexpected unknown commands: ${JSON.stringify(unknownCmds)}`);

          await app.emitTauriEvent("perf:progress", {
            phase: "Smoke Event Probe",
            percent: 50,
            elapsedSecs: 1.0,
            cpuUsagePct: 72.0,
            cpuClockMhz: 4100,
            cpuTempC: 66.0,
            raytracePreviewUrl: null,
            telemetry: ctx.fixtures.healthyUltrabook().telemetry,
          });

          // Navigate Stage 01 -> 06 (Display Fullscreen) exercising clickStep, clickButton, fillInput, pressKey, hoverAt
          await app.clickStep("All-Hardware Specs");
          await app.waitForText("ThinkPad X1 Carbon Gen 11", 3000);
          await app.clickButton(/Next: Stage 02/);
          await app.clickButton(/Next: Stage 03/);
          await app.clickButton("Skip Step"); // Battery -> Logs
          await app.clickButton(/Next: Stage 05/); // Logs -> Storage
          await app.clickButton("Skip Step"); // Storage -> Display

          await app.waitForText(/Display Check/, 3000);
          const notesVal = await app.fillInput("Optional panel notes", "Smoke test panel notes");
          ctx.assert.equal(notesVal, "Smoke test panel notes");

          await app.clickButton(/Launch True Fullscreen Test/);
          const winFs = await app.getWindowState();
          ctx.assert.equal(winFs.fullscreen, true, "Expected plugin:window|set_fullscreen(true) to be called");

          await app.pressKey("ArrowRight");
          await app.hoverAt(680, 860);
          await app.pressKey("Escape");

          const winAfterEsc = await app.getWindowState();
          ctx.assert.equal(winAfterEsc.fullscreen, false, "Expected Escape to exit fullscreen");

          const postErrors = await app.getPageErrors();
          ctx.assert.equal(postErrors.length, 0, `Errors after UI navigation: ${JSON.stringify(postErrors)}`);
        } finally {
          await app.close();
        }
      },
    },
    {
      id: "SMOKE-03",
      tier: 0,
      feature: "HARNESS",
      title: "cdp-browser verifies non-touch maxTouchPoints=0 and multi-touch CDP gesture dispatch",
      tags: ["smoke", "touch"],
      async run(ctx) {
        // 1. Non-touch device check
        const nonTouch = await ctx.browser.openApp(ctx.fixtures.nonTouchCorporate(), { maxTouchPoints: 0 });
        try {
          const maxPts = await nonTouch.evaluate(() => navigator.maxTouchPoints);
          ctx.assert.equal(maxPts, 0, `Expected navigator.maxTouchPoints === 0, got ${maxPts}`);
        } finally {
          await nonTouch.close();
        }

        // 2. Touch & multi-touch gesture dispatch check
        const touchApp = await ctx.browser.openApp(ctx.fixtures.healthyUltrabook(), { maxTouchPoints: 10 });
        try {
          const maxPts = await touchApp.evaluate(() => navigator.maxTouchPoints);
          ctx.assert.equal(maxPts, 10, `Expected navigator.maxTouchPoints === 10, got ${maxPts}`);

          await touchApp.evaluate(() => {
            const pad = document.createElement("div");
            pad.id = "__e2e_touch_probe";
            pad.style.cssText =
              "position:fixed;inset:0;z-index:999998;touch-action:none;background:transparent;";
            const state = { pointerDowns: [], pointerUps: [], maxTouches: 0, moves: 0 };
            pad.addEventListener("pointerdown", (e) => state.pointerDowns.push({ id: e.pointerId, type: e.pointerType }));
            pad.addEventListener("pointermove", () => { state.moves += 1; });
            pad.addEventListener("pointerup", (e) => state.pointerUps.push({ id: e.pointerId, type: e.pointerType }));
            pad.addEventListener("touchstart", (e) => {
              state.maxTouches = Math.max(state.maxTouches, e.touches.length);
            });
            pad.addEventListener("touchmove", (e) => {
              state.maxTouches = Math.max(state.maxTouches, e.touches.length);
            });
            window.__e2eTouchState = state;
            document.body.appendChild(pad);
          });

          await touchApp.dispatchTouchGesture([
            { x: 200, y: 200 },
            { x: 260, y: 240 },
            { x: 320, y: 280 },
          ]);
          await touchApp.dispatchMultiTouch([
            { id: 0, points: [{ x: 300, y: 300 }, { x: 350, y: 350 }] },
            { id: 1, points: [{ x: 500, y: 300 }, { x: 550, y: 350 }] },
          ]);

          const touchState = await touchApp.evaluate(() => window.__e2eTouchState);
          ctx.assert.ok(touchState.pointerDowns.length >= 3, `Expected >= 3 pointerdowns, got ${touchState.pointerDowns.length}`);
          ctx.assert.ok(touchState.pointerDowns.every((p) => p.type === "touch"), "Expected pointerType === 'touch'");
          ctx.assert.ok(touchState.pointerUps.length >= 3, `Expected >= 3 pointerups, got ${touchState.pointerUps.length}`);
          ctx.assert.ok(touchState.maxTouches >= 2, `Expected multi-touch maxTouches >= 2, got ${touchState.maxTouches}`);
          ctx.assert.ok(touchState.moves >= 3, `Expected touch move events >= 3, got ${touchState.moves}`);
        } finally {
          await touchApp.close();
        }
      },
    },
  ];
}

async function runSingleTest(test, ctx, timeoutMs) {
  const startedAt = Date.now();
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => test.run(ctx)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Test ${test.id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return {
      id: test.id,
      tier: test.tier,
      feature: test.feature,
      title: test.title,
      status: "PASS",
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    return {
      id: test.id,
      tier: test.tier,
      feature: test.feature,
      title: test.title,
      status: "FAIL",
      durationMs: Date.now() - startedAt,
      error: err?.stack || String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
    await ctx.browser.closeAll().catch(() => {});
  }
}

function summarizeResults(results, totalDurationMs, filesCount) {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const byTier = {};
  const byFeature = {};

  for (const r of results) {
    const tKey = `tier${r.tier}`;
    if (!byTier[tKey]) byTier[tKey] = { total: 0, passed: 0, failed: 0 };
    byTier[tKey].total += 1;
    if (r.status === "PASS") byTier[tKey].passed += 1;
    else byTier[tKey].failed += 1;

    const fKey = r.feature || "UNKNOWN";
    if (!byFeature[fKey]) byFeature[fKey] = { total: 0, passed: 0, failed: 0 };
    byFeature[fKey].total += 1;
    if (r.status === "PASS") byFeature[fKey].passed += 1;
    else byFeature[fKey].failed += 1;
  }

  return {
    filesCount,
    total: results.length,
    passed,
    failed,
    durationMs: totalDurationMs,
    byTier,
    byFeature,
    results,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const cli = createCliRunner({ rootDir: ROOT_DIR, noBuild: opts.noBuild });
  const browser = createBrowserManager({ distDir: path.join(ROOT_DIR, "dist"), rootDir: ROOT_DIR });
  const assert = Object.assign(
    (...args) => assertStrict(...args),
    assertStrict,
    {
      assertSwissPalette: fixtures.assertSwissPalette,
      assertAttributionVisible: fixtures.assertAttributionVisible,
    }
  );
  const ctx = {
    rootDir: ROOT_DIR,
    cli,
    browser,
    fixtures,
    assert,
  };

  let harnessErrors = 0;
  let exitCode = 0;

  try {
    const { filesCount, tests: discoveredTests } = await discoverTests(opts);
    const activeTests = opts.harnessSmoke ? createHarnessSmokeTests() : discoveredTests;

    if (opts.list) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              filesCount,
              total: activeTests.length,
              tests: activeTests.map(({ id, tier, feature, title, tags, file }) => ({
                id,
                tier,
                feature,
                title,
                tags,
                file: file || "harness-smoke",
              })),
            },
            null,
            2
          )
        );
      } else {
        console.log(`Discovered ${activeTests.length} test(s) across ${filesCount} file(s).`);
        for (const t of activeTests) {
          console.log(`  [${t.id}] Tier ${t.tier} | ${t.feature} | ${t.title}`);
        }
      }
      process.exit(0);
    }

    const suiteStart = Date.now();
    const results = [];

    if (!opts.json) {
      const modeLabel = opts.harnessSmoke ? "HARNESS SMOKE" : "E2E SUITE";
      console.log(`=== LaptopBench QC ${modeLabel} (${activeTests.length} test(s), ${filesCount} suite file(s)) ===`);
    }

    for (const test of activeTests) {
      const res = await runSingleTest(test, ctx, opts.timeoutMs);
      results.push(res);
      if (!opts.json) {
        const badge = res.status === "PASS" ? "[PASS]" : "[FAIL]";
        console.log(`${badge} ${res.id} (Tier ${res.tier} | ${res.feature}) ${res.title} (${res.durationMs}ms)`);
        if (res.status === "FAIL" && res.error) {
          console.log(`       ${res.error.split("\n")[0]}`);
        }
      }
    }

    const summary = summarizeResults(results, Date.now() - suiteStart, filesCount);

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`\nSummary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed (${summary.durationMs}ms)`);
      if (Object.keys(summary.byTier).length > 0) {
        console.log("By Tier:");
        for (const [k, v] of Object.entries(summary.byTier)) {
          console.log(`  ${k}: ${v.passed}/${v.total} passed (${v.failed} failed)`);
        }
      }
      if (Object.keys(summary.byFeature).length > 0) {
        console.log("By Feature:");
        for (const [k, v] of Object.entries(summary.byFeature)) {
          console.log(`  ${k}: ${v.passed}/${v.total} passed (${v.failed} failed)`);
        }
      }
    }

    exitCode = summary.failed === 0 && harnessErrors === 0 ? 0 : 1;
  } catch (err) {
    harnessErrors += 1;
    exitCode = 1;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, harnessError: err?.stack || String(err) }, null, 2));
    } else {
      console.error(`[HARNESS ERROR] ${err?.stack || String(err)}`);
    }
  } finally {
    await browser.closeAll().catch(() => {});
  }

  process.exit(exitCode);
}

main();
