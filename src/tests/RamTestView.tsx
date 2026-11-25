import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock, MemoryStick, Play, Square } from "lucide-react";
import type { RamTestProgress, RamTestResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";

interface RamTestViewProps {
  memoryTypeHint: string;
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

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const RamTestView: React.FC<RamTestViewProps> = ({
  memoryTypeHint,
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
  const [memPct, setMemPct] = useState(65);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RamTestProgress | null>(null);
  const [bwHistory, setBwHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<RamTestProgress>("ram:progress", (ev) => {
      setProgress(ev.payload);
      setBwHistory((prev) => [...prev.slice(-79), ev.payload.bandwidthGbS]);
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
    setBwHistory([]);
    try {
      const res = await invoke<RamTestResult>("run_ram_stress", {
        preset,
        memoryPercent: memPct,
        customDurationSecs: null,
        memoryTypeHint,
      });
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange(false);
    }
  };

  const livePasses = progress?.perTestPasses ?? result?.perTestPasses ?? [0, 0, 0, 0, 0, 0];
  const liveErrors = progress?.perTestErrors ?? result?.perTestErrors ?? [0, 0, 0, 0, 0, 0];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              RAM Continuous Durability Test (TestMem5 Engine)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Sustained time-enforced TestMem5 profiles (Default @ serj, Absolut @ anta777, Extreme @ anta777) continuously cycling RefreshStable, SimpleTest, MirrorMove &amp; MirrorMove128.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-bold text-black mb-1.5">TestMem5 Durability Profile</label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
            >
              <option value="quick">Default @ serj — Shop QC (2 Full Minutes)</option>
              <option value="standard">Absolut @ anta777 — Durability (5 Full Minutes)</option>
              <option value="burnin">Extreme @ anta777 — Deep Burn-In (15 Full Minutes)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-black mb-1.5">
              Safe Free-RAM Window: <span className="text-blue-600 font-mono">{memPct}%</span>
            </label>
            <input
              type="range"
              min={30}
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
                <Play className="w-4 h-4" /> Start Continuous RAM Test
              </button>
            )}
          </div>
        </div>

        {/* Live TM5 6-Stage Pass & Error Matrix */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 pt-2 border-t border-zinc-100">
          {TM5_STAGES.map((stage, i) => {
            const isCurrent = running && progress?.testIndex === i;
            const passes = livePasses[i] ?? 0;
            const errs = liveErrors[i] ?? 0;
            return (
              <div
                key={stage}
                className={`rounded-lg border px-2.5 py-2 text-[10px] font-mono ${
                  errs > 0
                    ? "bg-black text-white border-black"
                    : isCurrent
                    ? "bg-blue-600 text-white border-blue-600 animate-pulse"
                    : passes > 0
                    ? "bg-blue-50 text-blue-900 border-blue-300"
                    : "bg-zinc-50 text-zinc-600 border-zinc-200"
                }`}
              >
                <div className="font-bold truncate">{stage}</div>
                <div className="mt-1 opacity-85">
                  Pass: <strong>{passes}</strong> • Err: <strong>{errs}</strong>
                </div>
              </div>
            );
          })}
        </div>

        {(running || bwHistory.length > 0) && (
          <div className="space-y-3 pt-3 border-t border-zinc-200">
            {running && progress && (
              <>
                <div className="flex items-center justify-between text-xs font-mono flex-wrap gap-2">
                  <span className="text-blue-700 font-bold">
                    {progress.profileName} • Cycle #{progress.cycle} • {progress.patternName}
                  </span>
                  <span className="text-black font-black flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-blue-600" />
                    {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({progress.percent.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                    <div className="text-zinc-500">Active Window</div>
                    <div className="text-lg font-black text-black">{progress.allocatedMb} MB</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                    <div className="text-zinc-500">Total Data Verified</div>
                    <div className="text-lg font-black text-blue-600">{progress.totalGbVerified.toFixed(1)} GB</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                    <div className="text-zinc-500">Live Bandwidth</div>
                    <div className="text-lg font-black text-black">{progress.bandwidthGbS.toFixed(1)} GB/s</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                    <div className="text-zinc-500">Bit Errors</div>
                    <div className={`text-lg font-black ${progress.errorsFound > 0 ? "text-black underline" : "text-blue-600"}`}>
                      {progress.errorsFound}
                    </div>
                  </div>
                </div>
              </>
            )}
            <LiveChart title="Real-Time RAM Verification Throughput" unit="GB/s" data={bwHistory} />
          </div>
        )}

        {error && <div className="rounded-lg bg-black text-white px-3 py-2 text-xs">{error}</div>}
      </div>

      {result && !running && (
        <div className="space-y-4">
          <BaselineCard baseline={result.baseline} />
          <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-bold text-black">
                <MemoryStick className="w-4 h-4 text-blue-600" />
                {result.profileName} — Durability Summary
              </div>
              <StatusBadge status={result.status} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono text-xs">
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Total Verified</div>
                <div className="text-lg font-black text-blue-600">{result.totalGbVerified.toFixed(1)} GB</div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Bit Errors</div>
                <div className={`text-lg font-black ${result.errorsFound > 0 ? "text-black underline" : "text-blue-600"}`}>
                  {result.errorsFound}
                </div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Peak / Avg BW</div>
                <div className="text-sm font-black text-black mt-1">
                  {result.peakBandwidthGbS.toFixed(1)} / {result.avgBandwidthGbS.toFixed(1)} GB/s
                </div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Window</div>
                <div className="text-lg font-black text-black">{result.allocatedMb} MB</div>
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                <div className="text-zinc-500">Cycles / Time</div>
                <div className="text-lg font-black text-black">
                  {result.cyclesCompleted}x / {fmtTime(result.elapsedSecs)}
                </div>
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
        requirementHint="Run the continuous TestMem5 RAM durability test to unlock Step 11 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
