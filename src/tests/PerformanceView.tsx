import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Cpu, Gauge, Play, Square, Thermometer } from "lucide-react";
import type { PerfBenchProgress, PerfBenchResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface PerformanceViewProps {
  result: PerfBenchResult | null;
  status: TestStatus;
  onComplete: (res: PerfBenchResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext?: () => void;
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  result,
  status,
  onComplete,
  onRunningChange,
  onNext,
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
    setProgress({ phase: "Starting CPU & Memory Suite...", percent: 2, cpuUsagePct: 0, cpuTempC: null });
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

  const stopBench = () => {
    invoke("cancel_performance_benchmark").catch(() => {});
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Performance Benchmark (CPU &amp; Memory)</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            PassMark PerformanceTest-inspired single-core, multi-core, SHA-256 crypto, FP64 matrix, and memory bandwidth suite for Office &amp; Pro laptops.
          </p>
        </div>
        {onNext && (
          <button
            onClick={onNext}
            className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold"
          >
            Next Test →
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-slate-300">Workload Preset:</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
            >
              <option value="quick">Quick QC (1 round ~10–25s)</option>
              <option value="standard">Standard (3 rounds ~45–90s)</option>
              <option value="burnin">Sustained Burn-in (6 rounds)</option>
            </select>
          </div>
          {running ? (
            <button
              onClick={stopBench}
              className="px-5 py-2.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-200 font-bold text-xs flex items-center gap-2"
            >
              <Square className="w-4 h-4" /> Cancel Benchmark
            </button>
          ) : (
            <button
              onClick={startBench}
              className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2"
            >
              <Play className="w-4 h-4" /> Run Performance Test
            </button>
          )}
        </div>

        {running && progress && (
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-cyan-300 font-semibold">{progress.phase}</span>
              <span className="text-slate-300 flex items-center gap-3">
                <span>CPU Load: {progress.cpuUsagePct.toFixed(0)}%</span>
                {progress.cpuTempC != null && (
                  <span className="flex items-center gap-1 text-amber-300">
                    <Thermometer className="w-3.5 h-3.5" /> {progress.cpuTempC.toFixed(0)}°C
                  </span>
                )}
                <span>{progress.percent.toFixed(0)}%</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-950 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-500/15 border border-rose-500/40 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && !running && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-slate-900 to-slate-950 p-6 flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-cyan-400 font-semibold flex items-center gap-1.5">
                <Gauge className="w-4 h-4" /> Composite LaptopBench Mark
              </div>
              <div className="text-4xl font-black text-white font-mono mt-1">
                {result.compositeScore.toLocaleString()}
              </div>
              <div className="text-xs text-emerald-300 font-semibold mt-1">
                Performance Tier: {result.tier}
              </div>
            </div>
            <div className="text-right font-mono text-xs text-slate-400 space-y-1">
              <div>Elapsed: {result.elapsedSecs.toFixed(1)}s</div>
              {result.peakCpuTempC != null && (
                <div className="text-amber-300">Peak CPU Temp: {result.peakCpuTempC.toFixed(1)}°C</div>
              )}
              <StatusBadge status={result.status} />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono text-xs">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-slate-400 flex items-center gap-1"><Cpu className="w-3.5 h-3.5" /> Single-Core</div>
              <div className="text-xl font-bold text-white mt-1">{result.singleCoreScore.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-slate-400">Multi-Core</div>
              <div className="text-xl font-bold text-cyan-300 mt-1">{result.multiCoreScore.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-slate-400">SHA-256 Crypto</div>
              <div className="text-xl font-bold text-emerald-300 mt-1">{result.cryptoScore.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-slate-400">FP64 Matrix</div>
              <div className="text-xl font-bold text-violet-300 mt-1">{result.matrixScore.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="text-slate-400">Mem Bandwidth</div>
              <div className="text-xl font-bold text-white mt-1">{result.memoryBandwidthGbS.toFixed(1)} GB/s</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
