import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock, MemoryStick, Play, Square } from "lucide-react";
import type { LiveTelemetrySnapshot, RamTestProgress, RamTestResult, StressPreset, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";
import { EnvironmentGuard } from "../components/EnvironmentGuard";
import { EngineeringConsole, ThresholdAuditTable, type ThresholdAuditRow } from "../components/EngineeringConsole";

interface RamTestViewProps {
  telemetry: LiveTelemetrySnapshot | null;
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
  "T0: RefreshStable",
  "T1: SimpleTest (0x4535)",
  "T2: MirrorMove (64b)",
  "T3: PRNG Hash",
  "T4: MirrorMove128",
  "T5: RefreshInv",
];

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const RamTestView: React.FC<RamTestViewProps> = ({
  telemetry,
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
  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const lastLogRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<RamTestProgress>("ram:progress", (ev) => {
      const p = ev.payload;
      setProgress(p);
      setBwHistory((prev) => [...prev.slice(-79), p.bandwidthGbS]);
      const sig = `${p.cycle}-${p.testIndex}`;
      if (sig !== lastLogRef.current) {
        lastLogRef.current = sig;
        setConsoleLog((prev) => [
          ...prev.slice(-80),
          `[${fmtTime(p.elapsedSecs)}] Cycle #${p.cycle} | ${p.patternName} | ${p.bandwidthGbS.toFixed(1)} GB/s | Verified=${p.totalGbVerified.toFixed(1)} GB | Errors=${p.errorsFound}`,
        ]);
      }
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
    lastLogRef.current = "";
    setConsoleLog([
      `[00:00] Allocating ${memPct}% safe free-RAM window (type=${memoryTypeHint}, preset=${preset})`,
    ]);
    try {
      const res = await invoke<RamTestResult>("run_ram_stress", {
        preset,
        memoryPercent: memPct,
        customDurationSecs: null,
        memoryTypeHint,
      });
      setConsoleLog((prev) => [
        ...prev,
        `[${fmtTime(res.elapsedSecs)}] COMPLETE: ${res.totalGbVerified.toFixed(1)} GB verified across ${res.cyclesCompleted} cycles | Peak=${res.peakBandwidthGbS.toFixed(1)} GB/s | Bit Errors=${res.errorsFound}`,
      ]);
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
  const isDdr5 = memoryTypeHint.toLowerCase().includes("ddr5") || memoryTypeHint.toLowerCase().includes("unified");

  const auditRows: ThresholdAuditRow[] = result
    ? [
        {
          parameter: "Memory Bit-Flip Integrity",
          measured: `${result.errorsFound} bit errors (${result.totalGbVerified.toFixed(1)} GB swept)`,
          limit: "0 errors required",
          verdict: result.errorsFound === 0 ? "PASS" : "FAIL",
        },
        {
          parameter: "Sustained TM5 Verification Cycles",
          measured: `${result.cyclesCompleted} full cycles (${fmtTime(result.elapsedSecs)})`,
          limit: ">= 1 full cycle",
          verdict: result.cyclesCompleted >= 1 && !result.cancelled ? "PASS" : "WARN",
        },
        {
          parameter: "Effective Memory Throughput vs. Normal",
          measured: `${result.peakBandwidthGbS.toFixed(1)} GB/s (${result.baseline.percentOfNormal.toFixed(0)}%)`,
          limit: ">= 85% of DRAM Class",
          verdict: result.baseline.percentOfNormal >= 85 ? "PASS" : "WARN",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              RAM Continuous Durability Audit (TestMem5 Engine)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Sustained time-enforced TestMem5 profiles (Default @ serj, Absolut @ anta777, Extreme @ anta777) continuously cycling 6 retention &amp; bus-stress kernels.
          </p>
        </div>
      </div>

      <EnvironmentGuard telemetry={telemetry} requireAc={false} />

      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">
              TestMem5 Profile
            </label>
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black font-medium"
            >
              <option value="quick">Default @ serj — Shop QC (2 Full Minutes)</option>
              <option value="standard">Absolut @ anta777 — Durability (5 Full Minutes)</option>
              <option value="burnin">Extreme @ anta777 — Burn-In (15 Full Minutes)</option>
            </select>
          </div>
          <div>
            <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">
              Free-RAM Allocation Window: <span className="text-blue-700">{memPct}%</span>
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
                className="w-full md:w-auto px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" /> Abort RAM Test
              </button>
            ) : (
              <button
                onClick={startTest}
                className="w-full md:w-auto px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Start Continuous Test
              </button>
            )}
          </div>
        </div>

        {/* 6-Stage Hairline Pattern Matrix */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 border border-zinc-300 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums">
          {TM5_STAGES.map((stage, i) => {
            const isCurrent = running && progress?.testIndex === i;
            const passes = livePasses[i] ?? 0;
            const errs = liveErrors[i] ?? 0;
            return (
              <div
                key={stage}
                className={`px-2.5 py-2 text-[10px] ${
                  errs > 0
                    ? "bg-black text-white"
                    : isCurrent
                    ? "bg-blue-600 text-white"
                    : passes > 0
                    ? "bg-blue-50/50 text-black"
                    : "bg-[#F8FAFC] text-zinc-600"
                }`}
              >
                <div className="font-bold truncate">{stage}</div>
                <div className="mt-0.5 opacity-85">
                  P:<strong>{passes}</strong> E:<strong>{errs}</strong>
                </div>
              </div>
            );
          })}
        </div>

        {(running || bwHistory.length > 0) && (
          <div className="space-y-3 pt-2">
            {running && progress && (
              <>
                <div className="flex items-center justify-between text-xs font-mono tabular-nums flex-wrap gap-2">
                  <span className="text-blue-700 font-bold">
                    {progress.profileName} • CYCLE #{progress.cycle} • {progress.patternName}
                  </span>
                  <span className="text-black font-black flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-blue-600" />
                    {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({progress.percent.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </>
            )}
            <LiveChart
              title="Real-Time DRAM Verification Bandwidth"
              unit="GB/s"
              data={bwHistory}
              baselineValue={isDdr5 ? 36 : 22}
              baselineLabel={isDdr5 ? "DDR5 NORMAL 36 GB/s" : "DDR4 NORMAL 22 GB/s"}
            />
          </div>
        )}

        {error && <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs">{error}</div>}
      </div>

      {result && !running && (
        <div className="space-y-3">
          <BaselineCard baseline={result.baseline} />
          <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between">
              <span className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-black flex items-center gap-1.5">
                <MemoryStick className="w-3.5 h-3.5 text-blue-600" />
                {result.profileName} — Verified Metrics
              </span>
              <StatusBadge status={result.status} compact />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums text-xs">
              <div className="p-3">
                <div className="text-[9.5px] uppercase text-zinc-500">Total Verified</div>
                <div className="text-base font-black text-blue-700">{result.totalGbVerified.toFixed(1)} GB</div>
              </div>
              <div className="p-3">
                <div className="text-[9.5px] uppercase text-zinc-500">Bit Errors</div>
                <div className={`text-base font-black ${result.errorsFound > 0 ? "text-black underline" : "text-blue-700"}`}>
                  {result.errorsFound}
                </div>
              </div>
              <div className="p-3">
                <div className="text-[9.5px] uppercase text-zinc-500">Peak / Avg BW</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {result.peakBandwidthGbS.toFixed(1)} / {result.avgBandwidthGbS.toFixed(1)} GB/s
                </div>
              </div>
              <div className="p-3">
                <div className="text-[9.5px] uppercase text-zinc-500">Window</div>
                <div className="text-base font-black text-black">{result.allocatedMb} MB</div>
              </div>
              <div className="p-3">
                <div className="text-[9.5px] uppercase text-zinc-500">Cycles / Time</div>
                <div className="text-base font-black text-black">
                  {result.cyclesCompleted}x / {fmtTime(result.elapsedSecs)}
                </div>
              </div>
            </div>
          </div>
          <ThresholdAuditTable rows={auditRows} />
        </div>
      )}

      <EngineeringConsole lines={consoleLog} />

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(result && !running)}
        requirementHint="Run the continuous TestMem5 RAM durability test to unlock Stage 11 (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
