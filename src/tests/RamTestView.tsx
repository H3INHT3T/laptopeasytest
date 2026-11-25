import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MemoryStick, Play, Square } from "lucide-react";
import type { RamTestProgress, RamTestResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface RamTestViewProps {
  result: RamTestResult | null;
  status: TestStatus;
  onComplete: (res: RamTestResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext?: () => void;
}

export const RamTestView: React.FC<RamTestViewProps> = ({
  result,
  status,
  onComplete,
  onRunningChange,
  onNext,
}) => {
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [memPct, setMemPct] = useState(55);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RamTestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<RamTestProgress>("ram:progress", (ev) => {
      setProgress(ev.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startTest = async () => {
    setError(null);
    setRunning(true);
    onRunningChange(true);
    setProgress(null);
    try {
      const res = await invoke<RamTestResult>("run_ram_stress", {
        preset,
        memoryPercent: memPct,
      });
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange(false);
    }
  };

  const stopTest = () => {
    invoke("cancel_ram_stress").catch(() => {});
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">RAM Stress Test (TestMem5 Engine)</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Multi-threaded deterministic memory verifier (Checkerboard, Walking Bits, Moving Inversion, SplitMix64 PRNG) for Windows &amp; macOS.
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Test Duration Preset</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
            >
              <option value="quick">Quick QC (~1–2 min / 2 cycles)</option>
              <option value="standard">Standard (~5 min / 6 cycles)</option>
              <option value="burnin">Burn-in (~15 min / 18 cycles)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Safe Free-RAM Allocation: <span className="text-cyan-300 font-mono">{memPct}%</span>
            </label>
            <input
              type="range"
              min={25}
              max={75}
              step={5}
              disabled={running}
              value={memPct}
              onChange={(e) => setMemPct(Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </div>
          <div className="flex justify-end">
            {running ? (
              <button
                onClick={stopTest}
                className="w-full md:w-auto px-5 py-2.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-200 font-bold text-xs flex items-center justify-center gap-2"
              >
                <Square className="w-4 h-4" /> Stop RAM Test
              </button>
            ) : (
              <button
                onClick={startTest}
                className="w-full md:w-auto px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2"
              >
                <Play className="w-4 h-4" /> Start RAM Stress Test
              </button>
            )}
          </div>
        </div>

        {running && progress && (
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-cyan-300 font-bold">
                Cycle {progress.cycle}/{progress.totalCycles} • {progress.patternName}
              </span>
              <span className="text-slate-300">
                {progress.elapsedSecs.toFixed(1)}s • {progress.percent.toFixed(0)}%
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-950 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-violet-500 via-cyan-500 to-emerald-500 transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="grid grid-cols-3 gap-3 font-mono text-xs">
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                <div className="text-slate-400">Tested Block</div>
                <div className="text-lg font-bold text-white">{progress.allocatedMb} MB</div>
              </div>
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                <div className="text-slate-400">Throughput</div>
                <div className="text-lg font-bold text-cyan-300">{progress.bandwidthGbS.toFixed(1)} GB/s</div>
              </div>
              <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                <div className="text-slate-400">Bit Errors Found</div>
                <div className={`text-lg font-bold ${progress.errorsFound > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                  {progress.errorsFound}
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-500/15 border border-rose-500/40 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Completed Result */}
      {result && !running && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <MemoryStick className="w-4 h-4 text-violet-400" />
              Latest RAM Stress Summary
            </div>
            <StatusBadge status={result.status} />
          </div>
          <div className="text-xs text-slate-300">{result.summary}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-slate-400">Memory Verified</div>
              <div className="text-lg font-bold text-white">{result.allocatedMb} MB</div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-slate-400">Errors Detected</div>
              <div className={`text-lg font-bold ${result.errorsFound > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {result.errorsFound}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-slate-400">Peak Bandwidth</div>
              <div className="text-lg font-bold text-cyan-300">{result.peakBandwidthGbS.toFixed(1)} GB/s</div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-slate-400">Cycles / Time</div>
              <div className="text-lg font-bold text-white">
                {result.cyclesCompleted}x / {result.elapsedSecs.toFixed(1)}s
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
