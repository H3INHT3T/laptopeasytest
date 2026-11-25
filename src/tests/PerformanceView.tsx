import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Cpu,
  Database,
  Download,
  Flame,
  Gauge,
  Play,
  Sparkles,
  Square,
  Thermometer,
  Upload,
} from "lucide-react";
import type { PerfBenchProgress, PerfBenchResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";

interface PerformanceViewProps {
  manufacturer?: string;
  model?: string;
  result: PerfBenchResult | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onComplete: (res: PerfBenchResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  manufacturer,
  model,
  result,
  status,
  stepNumber,
  totalSteps,
  onComplete,
  onRunningChange,
  onNext,
  onSkip,
}) => {
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PerfBenchProgress | null>(null);
  const [cpuLoadHistory, setCpuLoadHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      setProgress(ev.payload);
      setCpuLoadHistory((prev) => [...prev.slice(-79), ev.payload.cpuUsagePct]);
      if (ev.payload.cpuTempC != null) {
        setTempHistory((prev) => [...prev.slice(-79), ev.payload.cpuTempC as number]);
      }
      if (ev.payload.raytracePreviewUrl) {
        setLivePreview(ev.payload.raytracePreviewUrl);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startBench = async () => {
    setError(null);
    setHistoryNotice(null);
    setRunning(true);
    onRunningChange(true);
    setCpuLoadHistory([]);
    setTempHistory([]);
    setLivePreview(null);
    setProgress({
      phase: "Initializing 14-Stage All-Scope Performance Suite (PassMark + Office + Creator + AI)...",
      percent: 1,
      elapsedSecs: 0,
      cpuUsagePct: 0,
      cpuClockMhz: 0,
      cpuTempC: null,
      raytracePreviewUrl: null,
      telemetry: null,
    });
    try {
      const res = await invoke<PerfBenchResult>("run_performance_benchmark", {
        preset,
        manufacturer: manufacturer ?? null,
        model: model ?? null,
      });
      if (res.raytracePreviewUrl) setLivePreview(res.raytracePreviewUrl);
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange(false);
    }
  };

  const handleExportHistory = async () => {
    try {
      const path = await saveDialog({
        title: "Export Shop Model History JSON",
        defaultPath: "shop_model_history.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        const count = await invoke<number>("export_shop_history", { targetPath: path });
        setHistoryNotice(`Exported ${count} laptop model baseline(s) to ${path}`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleImportHistory = async () => {
    try {
      const path = await openDialog({
        title: "Import Shop Model History JSON",
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (typeof path === "string") {
        const count = await invoke<number>("import_shop_history", { sourcePath: path });
        setHistoryNotice(`Merged ${count} laptop model baseline(s) into local shop database.`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const subtests = result
    ? [
        { label: "CPU Single-Threaded", val: result.singleCoreScore },
        { label: "Integer Math (All Cores)", val: result.integerMathScore },
        { label: "Floating-Point FP64 Matrix", val: result.floatMathScore },
        { label: "Prime Numbers Sieve", val: result.primeScore },
        { label: "Extended Vector Math", val: result.vectorScore },
        { label: "Office: LZ Compression", val: result.compressionScore },
        { label: "Office: SHA-256 Encryption", val: result.encryptionScore },
        { label: "3D N-Body Physics", val: result.physicsScore },
        { label: "Office: Parallel Sorting", val: result.sortingScore },
        { label: "Office: Database Operations", val: result.databaseScore },
        { label: `Creator: AI Matrix GEMM (${result.simdIsa})`, val: result.creatorAiGemmScore },
        { label: `Creator: 3D Path-Tracer (${result.creatorMegaRaysS.toFixed(1)} MRays/s)`, val: result.creatorRaytraceScore },
        { label: "Creator: 1080p Image Filter", val: result.creatorImageScore },
        { label: "Memory Mark (BW + Latency)", val: result.memoryMark },
      ]
    : [];
  const maxSub = Math.max(...subtests.map((s) => s.val), 1);

  const previewImg = running ? livePreview : result?.raytracePreviewUrl ?? livePreview;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              360° All-Scope Performance &amp; Thermal Suite (v2.0)
            </h1>
            <StatusBadge status={status} />
            {result?.simdIsa && (
              <span className="px-2 py-0.5 rounded bg-blue-50 border border-blue-600 text-blue-700 font-mono text-[10px] font-bold">
                {result.simdIsa}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            14 sustained stages: PassMark 11 CPU/Memory, Office Productivity, Bare-Metal SIMD AI GEMM (AVX2+FMA / ARM64 NEON), Cinebench-Style 3D Path-Tracing Renderer, Hot-CPU Throttle Check, Factory Normal &amp; Shop Model History rating.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-bold text-black">Sustained Duration:</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Shop QC — 14-Stage Sustained (~50–60 seconds)</option>
              <option value="standard">Standard Durability — 14-Stage (~2.2 minutes)</option>
              <option value="burnin">Thermal Burn-In — 14-Stage (~4.5 minutes)</option>
            </select>
          </div>
          {running ? (
            <button
              onClick={() => invoke("cancel_performance_benchmark").catch(() => {})}
              className="px-5 py-2.5 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-2 cursor-pointer"
            >
              <Square className="w-4 h-4" /> Cancel Benchmark
            </button>
          ) : (
            <button
              onClick={startBench}
              className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-2 cursor-pointer"
            >
              <Play className="w-4 h-4" /> Run 14-Stage All-Scope Suite
            </button>
          )}
        </div>

        {(running || cpuLoadHistory.length > 0 || previewImg) && (
          <div className="space-y-3 pt-3 border-t border-zinc-200">
            {running && progress && (
              <>
                <div className="flex items-center justify-between text-xs font-mono flex-wrap gap-2">
                  <span className="text-blue-700 font-bold">{progress.phase}</span>
                  <span className="text-black flex items-center gap-3 font-bold">
                    <span>{progress.elapsedSecs.toFixed(0)}s</span>
                    <span>CPU: {progress.cpuUsagePct.toFixed(0)}%</span>
                    {progress.cpuClockMhz > 0 && <span>{progress.cpuClockMhz} MHz</span>}
                    {progress.cpuTempC != null && (
                      <span className="flex items-center gap-1 text-blue-700">
                        <Thermometer className="w-3.5 h-3.5" /> {progress.cpuTempC.toFixed(0)}°C
                      </span>
                    )}
                    {progress.telemetry?.sensorSource && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 border border-zinc-300 text-zinc-700">
                        {progress.telemetry.sensorSource}
                      </span>
                    )}
                    <span>{progress.percent.toFixed(0)}%</span>
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Live Cinebench-Style 3D Path-Tracing Viewport */}
              <div className="rounded-xl border border-zinc-300 bg-black overflow-hidden flex flex-col justify-between">
                <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center justify-between text-[10px] font-mono text-zinc-300">
                  <span className="font-bold text-blue-400 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> 3D PATH-TRACER (ALL CORES)
                  </span>
                  {result && !running && (
                    <span>{result.creatorMegaRaysS.toFixed(2)} MRays/s</span>
                  )}
                </div>
                <div className="aspect-video bg-black flex items-center justify-center">
                  {previewImg ? (
                    <img src={previewImg} alt="3D Path-Tracing Tile Render" className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-center p-4 text-[11px] text-zinc-400">
                      <Cpu className="w-6 h-6 text-blue-500 mx-auto mb-1.5" />
                      Live Cinebench-style 32×32 tile render appears during Stage 12
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                <LiveChart title="Real-Time CPU Load" unit="%" data={cpuLoadHistory} maxSuggested={100} />
                {tempHistory.length > 0 ? (
                  <LiveChart title="Real-Time CPU Temperature" unit="°C" data={tempHistory} maxSuggested={100} />
                ) : (
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 flex flex-col justify-center text-xs text-zinc-600">
                    <div className="font-bold text-black mb-1">Zero-Driver Telemetry Active</div>
                    <p className="text-[11px]">
                      Reading OS native CPU clocks &amp; usage. Run LibreHardwareMonitor or HWiNFO in background on Windows for direct motherboard core temperature &amp; fan RPM auto-linking.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {error && <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>}
        {historyNotice && (
          <div className="rounded-lg bg-blue-50 border border-blue-600 text-blue-900 px-3 py-2 text-xs font-semibold">
            {historyNotice}
          </div>
        )}
      </div>

      {/* Results */}
      {result && !running && (
        <div className="space-y-4">
          <BaselineCard baseline={result.baseline} />

          {/* Hero Score + A+ to FAIL Durability Grade + Office/Creator/Memory Split */}
          <div className="rounded-2xl border border-black bg-black text-white p-6 space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-blue-600 text-white flex flex-col items-center justify-center shrink-0 border border-blue-400">
                  <span className="text-[9px] uppercase font-bold tracking-wider text-blue-100">Grade</span>
                  <span className="text-2xl font-black font-mono leading-none mt-0.5">
                    {result.durabilityGrade}
                  </span>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-blue-400 font-bold flex items-center gap-1.5">
                    <Gauge className="w-4 h-4" /> LaptopBench v2.0 All-Scope Mark
                  </div>
                  <div className="text-4xl font-black text-white font-mono mt-0.5">
                    {result.compositeScore.toLocaleString()}
                  </div>
                  <div className="text-xs text-blue-300 font-semibold mt-0.5">
                    {result.tier} • SIMD: {result.simdIsa} • Throttle Drop: {result.throttleDropPct.toFixed(1)}%
                  </div>
                </div>
              </div>
              <div className="text-right font-mono text-xs text-zinc-300 space-y-1.5">
                <div>
                  Mem Cached / Copy / Write:{" "}
                  <strong className="text-white">
                    {result.memoryCachedGbS.toFixed(0)} / {result.memoryBandwidthGbS.toFixed(1)} / {result.memoryWriteGbS.toFixed(1)} GB/s
                  </strong>
                </div>
                <div>
                  DRAM Latency: <strong className="text-blue-400">{result.memoryLatencyNs.toFixed(1)} ns</strong> • Duration: {result.elapsedSecs.toFixed(1)}s
                </div>
                <div className="flex items-center justify-end gap-2">
                  {result.throttleDropPct >= 15 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] font-bold">
                      <Flame className="w-3 h-3" /> THROTTLE -{result.throttleDropPct.toFixed(0)}%
                    </span>
                  )}
                  <StatusBadge status={result.status} darkSurface />
                </div>
              </div>
            </div>

            {/* 4-Scope Category Score Strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4 border-t border-zinc-800">
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold">Office Scope</div>
                <div className="text-xl font-black font-mono text-white mt-0.5">
                  {result.officeScore.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-400 mt-0.5">Single-Core, DB, LZ, Crypto</div>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-blue-600 p-3">
                <div className="text-[10px] uppercase tracking-wider text-blue-400 font-bold">Creator &amp; AI Scope</div>
                <div className="text-xl font-black font-mono text-white mt-0.5">
                  {result.creatorScore.toLocaleString()}
                </div>
                <div className="text-[10px] text-blue-300 mt-0.5">
                  3D {result.creatorMegaRaysS.toFixed(1)} MRays/s • AI GEMM
                </div>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold">CPU Multi-Core</div>
                <div className="text-xl font-black font-mono text-white mt-0.5">
                  {result.multiCoreScore.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-400 mt-0.5">9 Sustained PassMark Engines</div>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold">Memory Mark</div>
                <div className="text-xl font-black font-mono text-white mt-0.5">
                  {result.memoryMark.toLocaleString()}
                </div>
                <div className="text-[10px] text-zinc-400 mt-0.5">
                  {result.memoryBandwidthGbS.toFixed(1)} GB/s • {result.memoryLatencyNs.toFixed(1)} ns
                </div>
              </div>
            </div>
          </div>

          {/* Auto-Learning Shop Model History Comparison Card */}
          {result.shopComparison && (
            <div className="rounded-xl border border-zinc-300 bg-white p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-black text-black flex items-center gap-1.5">
                  <Database className="w-4 h-4 text-blue-600" />
                  Auto-Learning Shop Model History ({manufacturer ?? "Laptop"} {model ?? ""})
                </div>
                <div className="text-xs text-zinc-600">
                  {result.shopComparison.found ? (
                    <>
                      Compared against <strong className="text-black">{result.shopComparison.unitsTested}</strong> previously tested unit(s) in your shop — Shop Avg Mark:{" "}
                      <strong className="font-mono text-blue-700">
                        {result.shopComparison.shopAvgComposite?.toFixed(0) ?? "—"}
                      </strong>
                      {result.shopComparison.percentVsShop != null && (
                        <>
                          {" "}
                          (This unit is{" "}
                          <strong className="font-mono text-black">
                            {result.shopComparison.percentVsShop.toFixed(0)}%
                          </strong>{" "}
                          of your shop's average for this exact model)
                        </>
                      )}
                    </>
                  ) : (
                    "First unit of this exact model saved! Future units of this laptop model will automatically compare against this baseline."
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleExportHistory}
                  className="px-3 py-1.5 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 text-[11px] font-bold text-black flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-blue-600" /> Export DB
                </button>
                <button
                  onClick={handleImportHistory}
                  className="px-3 py-1.5 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 text-[11px] font-bold text-black flex items-center gap-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-blue-600" /> Import DB
                </button>
              </div>
            </div>
          )}

          {/* 14-Subtest Breakdown */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-2.5">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
              14-Category All-Scope Subtest Breakdown
            </div>
            {subtests.map((s) => (
              <div key={s.label} className="grid grid-cols-12 items-center gap-3 text-xs">
                <div className="col-span-5 font-semibold text-black truncate">{s.label}</div>
                <div className="col-span-5 h-2.5 rounded-full bg-zinc-100 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full"
                    style={{ width: `${Math.max(4, Math.round((s.val / maxSub) * 100))}%` }}
                  />
                </div>
                <div className="col-span-2 text-right font-mono font-bold text-black">
                  {s.val.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(result && !running)}
        requirementHint="Run the 14-Stage All-Scope Performance Suite to unlock Step 12 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
