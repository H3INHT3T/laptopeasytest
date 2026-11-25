import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MemoryStick, Play, Square } from "lucide-react";
import type { RamTestProgress, RamTestResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface RamTestViewProps {
  result: RamTestResult | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onComplete: (res: RamTestResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

const TM5_STAGES = [
  "Test0: RefreshStable",
  "Test1: SimpleTest (0x45357354)",
  "Test2: MirrorMove (64-bit)",
  "Test3: SimpleTest PRNG",
  "Test4: MirrorMove128",
  "Test5: RefreshStable Inv",
];

export const RamTestView: React.FC<RamTestViewProps> = ({
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
  const [memPct, setMemPct] = useState(60);
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              RAM Deep Stress Test (TestMem5 Engine)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Native Rust implementation of TestMem5 profiles (Default @ serj, Absolut @ anta777, Extreme @ anta777) running RefreshStable, SimpleTest, MirrorMove &amp; MirrorMove128.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-bold text-black mb-1.5">TestMem5 Profile Preset</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Default @ serj — Quick QC (3 cycles / ~90s)</option>
              <option value="standard">Absolut @ anta777 — Standard (6 cycles / ~5m)</option>
              <option value="burnin">Extreme @ anta777 — Burn-in (15 cycles / ~15m)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-black mb-1.5">
              Safe Free-RAM Window: <span className="text-blue-600 font-mono">{memPct}%</span>
            </label>
            <input
              type="range"
              min={25}
              max={75}
              step={5}
              disabled={running}
              value={memPct}
              onChange={(e) => setMemPct(Number(e.target.value))}
              className="w-full accent-blue-600"
            />
          </div>
          <div className="flex justify-end">
            {running ? (
              <button
                onClick={() => invoke("cancel_ram_stress").catch(() => {})}
                className="w-full md:w-auto px-5 py-2.5 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
              >
                <Square className="w-4 h-4" /> Stop RAM Test
              </button>
            ) : (
              <button
                onClick={startTest}
                className="w-full md:w-auto px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
              >
                <Play className="w-4 h-4" /> Start TestMem5 Stress
              </button>
            )}
          </div>
        </div>

        {/* TM5 Test Sequence Matrix */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 pt-2 border-t border-zinc-100">
          {TM5_STAGES.map((stage, i) => {
            const isCurrent = running && progress?.testIndex === i;
            const isDone = result && !running && !result.cancelled;
            return (
              <div
                key={stage}
                className={`rounded-lg border px-2.5 py-2 text-[10px] font-mono font-bold ${
                  isCurrent
                    ? "bg-blue-600 text-white border-blue-600 animate-pulse"
                    : isDone
                    ? "bg-blue-50 text-blue-800 border-blue-300"
                    : "bg-zinc-50 text-zinc-600 border-zinc-200"
                }`}
              >
                {stage}
              </div>
            );
          })}
        </div>

        {running && progress && (
          <div className="space-y-3 pt-3 border-t border-zinc-200">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-blue-700 font-bold">
                {progress.profileName} • Cycle {progress.cycle}/{progress.totalCycles} • {progress.patternName}
              </span>
              <span className="text-black font-bold">
                {progress.elapsedSecs.toFixed(1)}s • {progress.percent.toFixed(0)}%
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-3 font-mono text-xs">
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Memory Window</div>
                <div className="text-lg font-black text-black">{progress.allocatedMb} MB</div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Throughput</div>
                <div className="text-lg font-black text-blue-600">{progress.bandwidthGbS.toFixed(1)} GB/s</div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Bit Errors Found</div>
                <div className={`text-lg font-black ${progress.errorsFound > 0 ? "text-black underline" : "text-blue-600"}`}>
                  {progress.errorsFound}
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>
        )}
      </div>

      {result && !running && (
        <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-black">
              <MemoryStick className="w-4 h-4 text-blue-600" />
              {result.profileName} — Verification Result
            </div>
            <StatusBadge status={result.status} />
          </div>
          <div className="text-xs text-zinc-700 font-medium">{result.summary}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-zinc-500">Window Verified</div>
              <div className="text-lg font-black text-black">{result.allocatedMb} MB</div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-zinc-500">Bit Errors</div>
              <div className={`text-lg font-black ${result.errorsFound > 0 ? "text-black underline" : "text-blue-600"}`}>
                {result.errorsFound}
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-zinc-500">Peak Bandwidth</div>
              <div className="text-lg font-black text-blue-600">{result.peakBandwidthGbS.toFixed(1)} GB/s</div>
            </div>
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
              <div className="text-zinc-500">Cycles / Time</div>
              <div className="text-lg font-black text-black">
                {result.cyclesCompleted}x / {result.elapsedSecs.toFixed(1)}s
              </div>
            </div>
          </div>
        </div>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(result && !running)}
        requirementHint="Run the TestMem5 RAM stress test to unlock Step 11 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
