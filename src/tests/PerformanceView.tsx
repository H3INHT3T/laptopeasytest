import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Flame, Gauge, Play, Square, Thermometer } from "lucide-react";
import type { PerfBenchProgress, PerfBenchResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";

interface PerformanceViewProps {
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      setProgress(ev.payload);
      setCpuLoadHistory((prev) => [...prev.slice(-79), ev.payload.cpuUsagePct]);
      if (ev.payload.cpuTempC != null) {
        setTempHistory((prev) => [...prev.slice(-79), ev.payload.cpuTempC as number]);
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
    setRunning(true);
    onRunningChange(true);
    setCpuLoadHistory([]);
    setTempHistory([]);
    setProgress({
      phase: "Initializing 12-Stage Sustained PassMark 11 Suite...",
      percent: 1,
      elapsedSecs: 0,
      cpuUsagePct: 0,
      cpuClockMhz: 0,
      cpuTempC: null,
    });
    try {
      const res = await invoke<PerfBenchResult>("run_performance_benchmark", { preset });
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange(false);
    }
  };

  const subtests = result
    ? [
        { label: "CPU Single-Threaded", val: result.singleCoreScore },
        { label: "Integer Math (All Cores)", val: result.integerMathScore },
        { label: "Floating-Point FP64 Matrix", val: result.floatMathScore },
        { label: "Prime Numbers Sieve", val: result.primeScore },
        { label: "Extended Vector / SIMD", val: result.vectorScore },
        { label: "Data Compression (LZ)", val: result.compressionScore },
        { label: "SHA-256 Encryption", val: result.encryptionScore },
        { label: "3D N-Body Physics", val: result.physicsScore },
        { label: "Parallel Sorting", val: result.sortingScore },
        { label: "Database Operations", val: result.databaseScore },
        { label: "Memory Mark", val: result.memoryMark },
      ]
    : [];
  const maxSub = Math.max(...subtests.map((s) => s.val), 1);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Sustained Performance &amp; Thermal Throttle Test (PassMark 11 Engine)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            12-stage time-calibrated sustained CPU &amp; Memory benchmark (including Database Ops, Cached/Uncached/Write/Latency, Hot-CPU Throttle Drop %) rated against normal baseline for your laptop's CPU class.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-bold text-black">Sustained Test Duration:</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Shop QC — Sustained (~45–55 seconds)</option>
              <option value="standard">Standard Durability — Sustained (~2 minutes)</option>
              <option value="burnin">Thermal Burn-In — Sustained (~4 minutes)</option>
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
              <Play className="w-4 h-4" /> Run 12-Stage Sustained Test
            </button>
          )}
        </div>

        {(running || cpuLoadHistory.length > 0) && (
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
                    <span>{progress.percent.toFixed(0)}%</span>
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </>
            )}
            <div className={`grid grid-cols-1 ${tempHistory.length > 0 ? "md:grid-cols-2" : ""} gap-3`}>
              <LiveChart title="Real-Time CPU Load" unit="%" data={cpuLoadHistory} maxSuggested={100} />
              {tempHistory.length > 0 && (
                <LiveChart title="Real-Time CPU Temperature" unit="°C" data={tempHistory} maxSuggested={100} />
              )}
            </div>
          </div>
        )}

        {error && <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>}
      </div>

      {/* Results */}
      {result && !running && (
        <div className="space-y-4">
          <BaselineCard baseline={result.baseline} />

          <div className="rounded-2xl border border-black bg-black text-white p-6 flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-blue-400 font-bold flex items-center gap-1.5">
                <Gauge className="w-4 h-4" /> LaptopBench Sustained Mark
              </div>
              <div className="text-4xl font-black text-white font-mono mt-1">
                {result.compositeScore.toLocaleString()}
              </div>
              <div className="text-xs text-blue-300 font-semibold mt-1">
                Tier: {result.tier} • Throttle Drop: {result.throttleDropPct.toFixed(1)}%
              </div>
            </div>
            <div className="text-right font-mono text-xs text-zinc-300 space-y-1.5">
              <div>CPU Multi-Core: <strong className="text-white">{result.multiCoreScore.toLocaleString()}</strong></div>
              <div>
                Mem Cached / Copy / Write:{" "}
                <strong className="text-white">
                  {result.memoryCachedGbS.toFixed(0)} / {result.memoryBandwidthGbS.toFixed(1)} / {result.memoryWriteGbS.toFixed(1)} GB/s
                </strong>
              </div>
              <div>DRAM Latency: <strong className="text-blue-400">{result.memoryLatencyNs.toFixed(1)} ns</strong> • Duration: {result.elapsedSecs.toFixed(1)}s</div>
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

          <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-2.5">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
              11-Category Subtest Breakdown
            </div>
            {subtests.map((s) => (
              <div key={s.label} className="grid grid-cols-12 items-center gap-3 text-xs">
                <div className="col-span-4 font-semibold text-black">{s.label}</div>
                <div className="col-span-6 h-2.5 rounded-full bg-zinc-100 overflow-hidden">
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
        requirementHint="Run the 12-stage Sustained Performance & Throttle Benchmark to unlock Step 12 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
