import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Gauge, Play, Square, Thermometer } from "lucide-react";
import type { PerfBenchProgress, PerfBenchResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      setProgress(ev.payload);
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
    setProgress({ phase: "Starting 10-Stage PerformanceTest Suite...", percent: 2, cpuUsagePct: 0, cpuTempC: null });
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
        { label: "Integer Math (MC)", val: result.integerMathScore },
        { label: "Floating-Point FP64", val: result.floatMathScore },
        { label: "Prime Numbers Sieve", val: result.primeScore },
        { label: "Extended Vector / SIMD", val: result.vectorScore },
        { label: "Data Compression (LZ)", val: result.compressionScore },
        { label: "SHA-256 Encryption", val: result.encryptionScore },
        { label: "Physics (3D N-Body)", val: result.physicsScore },
        { label: "Parallel Sorting", val: result.sortingScore },
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
              Performance Benchmark (PassMark 11 Engine)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            10-stage CPU &amp; Memory benchmark: Integer, FP64, Primes, Vector, Compression, Encryption, 3D Physics, Sorting, Single-Core, Bandwidth &amp; DRAM Latency (ns).
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-bold text-black">Benchmark Depth:</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Quick QC (1 round ~15–30s)</option>
              <option value="standard">Standard (3 rounds ~60–90s)</option>
              <option value="burnin">Sustained Thermal Load (6 rounds)</option>
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
              <Play className="w-4 h-4" /> Run 10-Stage Benchmark
            </button>
          )}
        </div>

        {running && progress && (
          <div className="space-y-3 pt-3 border-t border-zinc-200">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-blue-700 font-bold">{progress.phase}</span>
              <span className="text-black flex items-center gap-3 font-bold">
                <span>CPU: {progress.cpuUsagePct.toFixed(0)}%</span>
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
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>
        )}
      </div>

      {/* Results */}
      {result && !running && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-black bg-black text-white p-6 flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-blue-400 font-bold flex items-center gap-1.5">
                <Gauge className="w-4 h-4" /> LaptopBench Performance Mark
              </div>
              <div className="text-4xl font-black text-white font-mono mt-1">
                {result.compositeScore.toLocaleString()}
              </div>
              <div className="text-xs text-blue-300 font-semibold mt-1">
                Classification: {result.tier} • Memory: {result.memoryBandwidthGbS.toFixed(1)} GB/s • Latency: {result.memoryLatencyNs.toFixed(1)} ns
              </div>
            </div>
            <div className="text-right font-mono text-xs text-zinc-300 space-y-1.5">
              <div>CPU Multi-Core: <strong className="text-white">{result.multiCoreScore.toLocaleString()}</strong></div>
              <div>Elapsed: {result.elapsedSecs.toFixed(1)}s</div>
              {result.peakCpuTempC != null && (
                <div className="text-blue-400">Peak CPU Temp: {result.peakCpuTempC.toFixed(1)}°C</div>
              )}
              <StatusBadge status={result.status} darkSurface />
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-2.5">
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
              Subtest Score Breakdown
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
        requirementHint="Run the 10-stage CPU & Memory Performance Benchmark to unlock Step 12 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
