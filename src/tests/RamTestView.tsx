import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Award, CheckSquare, Clock, MemoryStick, Play, ShieldCheck, Square, Thermometer } from "lucide-react";
import {
  DEFAULT_HARDWARE_SAFETY_BOUNDS,
  RAM_OS_RESERVE_16GB_CAP_MB,
  type LiveTelemetrySnapshot,
  type RamTestProgress,
  type RamTestResult,
  type StressPreset,
  type SystemSpecs,
  type TestStatus,
  type UserBenchmarkComparison,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";
import { EnvironmentGuard } from "../components/EnvironmentGuard";
import { EngineeringConsole, ThresholdAuditTable, type ThresholdAuditRow } from "../components/EngineeringConsole";

interface RamTestViewProps {
  telemetry: LiveTelemetrySnapshot | null;
  specs?: SystemSpecs | null;
  memoryTypeHint: string;
  result: RamTestResult | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onComplete: (res: RamTestResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

const MT0_BASE_KERNELS = [
  "Test0: RefreshStable (Retention)",
  "Test1: SimpleTest Mode 0 Constant",
  "Test2: SimpleTest Mode 1 (1MB L3 Edge)",
  "Test3: SimpleTest Mode 1 (256 Bank Stride)",
  "Test4: MirrorMove (64-bit Bus)",
  "Test5: SimpleTest Mode 2 PRNG (Prime 257)",
  "Test6: MirrorMove128 (128-bit SIMD)",
  "Test7: BlockMove (64B Cache-Line)",
];

const MT0_STANDARD_EXTRA = [
  "Test8: SimpleTest Mode 1 (4MB Block)",
  "Test9: SimpleTest Mode 2 (Prime 359, 16MB)",
  "Test10: SimpleTest Mode 2 (64MB Full Rank)",
  "Test11: RefreshStable Inverted",
];

const MT0_BURNIN_EXTRA = [
  "Test12: SimpleTest Mode 0 (2MB Block)",
  "Test13: SimpleTest Mode 2 (Prime 479, 32MB)",
  "Test14: BlockMove High-Entropy",
  "Test15: MirrorMove128 Sustained",
];

const MT0_KERNELS_BY_PRESET: Record<StressPreset, string[]> = {
  quick: MT0_BASE_KERNELS,
  standard: [...MT0_BASE_KERNELS, ...MT0_STANDARD_EXTRA],
  burnin: [...MT0_BASE_KERNELS, ...MT0_STANDARD_EXTRA, ...MT0_BURNIN_EXTRA],
};

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const RamTestView: React.FC<RamTestViewProps> = ({
  telemetry,
  specs = null,
  memoryTypeHint,
  result,
  userbenchmarkComparison = null,
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

  const activeKernelList =
    result && !running && result.patternsTested.length > 0
      ? result.patternsTested
      : MT0_KERNELS_BY_PRESET[preset];

  const livePasses =
    progress?.perTestPasses ??
    result?.perTestPasses ??
    Array.from({ length: activeKernelList.length }, () => 0);
  const liveErrors =
    progress?.perTestErrors ??
    result?.perTestErrors ??
    Array.from({ length: activeKernelList.length }, () => 0);

  const isDdr5 = memoryTypeHint.toLowerCase().includes("ddr5") || memoryTypeHint.toLowerCase().includes("unified");

  const totalMbEst = specs?.totalRamGb ? Math.round(specs.totalRamGb * 1024) : 0;
  const expectedReserveMb =
    totalMbEst > 0
      ? Math.min(
          RAM_OS_RESERVE_16GB_CAP_MB,
          Math.max(
            DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReserveFloorMb,
            Math.floor((totalMbEst * DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReservePct) / 100)
          )
        )
      : null;

  const ramUbRating = userbenchmarkComparison?.ram ?? result?.userbenchmarkRating ?? null;
  const specChannelWarn = specs?.ramConfigWarning;
  const ubBottleneckFlag = ramUbRating?.bottleneckFlag;
  const isSingleChannel = Boolean(
    specs?.ramChannelMode?.toLowerCase().includes("single") ||
      specChannelWarn?.toLowerCase().includes("single-channel") ||
      ubBottleneckFlag?.toLowerCase().includes("single-channel")
  );
  const hasChannelBottleneck = Boolean(isSingleChannel || specChannelWarn || ubBottleneckFlag);

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
          measured: `${result.cyclesCompleted} full cycles (${fmtTime(result.elapsedSecs)}) across ${activeKernelList.length} MT0 kernels`,
          limit: ">= 1 full cycle",
          verdict: result.cyclesCompleted >= 1 && !result.cancelled ? "PASS" : "WARN",
        },
        {
          parameter: "OS RAM Reserve Headroom",
          measured: `${result.osReserveMb ?? expectedReserveMb ?? "—"} MB preserved (${result.allocatedMb} / ${result.totalRamMb} MB)`,
          limit: `>= max(${DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReserveFloorMb} MB, ${DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReservePct}% RAM)`,
          verdict:
            (result.osReserveMb ?? expectedReserveMb ?? DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReserveFloorMb) >=
            DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReserveFloorMb
              ? "PASS"
              : "WARN",
        },
        {
          parameter: "CPU Thermal Cutoff",
          measured: result.thermalCutoffTriggered
            ? `TRIGGERED at ${result.peakCpuTempC?.toFixed(0) ?? "—"}°C`
            : result.peakCpuTempC != null
            ? `Peak ${result.peakCpuTempC.toFixed(0)}°C (Safe)`
            : result.sensorUnavailable
            ? "Sensor N/A (<=300s bounded)"
            : "OK",
          limit: `<= ${DEFAULT_HARDWARE_SAFETY_BOUNDS.cpuThermalCutoffC}°C cutoff`,
          verdict: result.thermalCutoffTriggered ? "FAIL" : "PASS",
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
            Sustained time-enforced TestMem5 profiles (Default @ serj, Absolut @ anta777, Extreme @ anta777) cycling {activeKernelList.length} MT0.dll retention, prime/256-stride &amp; SIMD kernels.
          </p>
        </div>
      </div>

      <EnvironmentGuard telemetry={telemetry} requireAc={false} />

      {/* Channel Configuration / Single-Channel Bottleneck Banner */}
      {hasChannelBottleneck ? (
        <div className="rounded-[2px] border-2 border-black bg-[#F8FAFC] p-3.5 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold uppercase flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-blue-400" />
              {isSingleChannel ? "SINGLE-CHANNEL BOTTLENECK" : "RAM CONFIG WARNING"}
            </span>
            {specs?.ramChannelMode && (
              <span className="font-mono text-[11px] font-bold text-black">{specs.ramChannelMode}</span>
            )}
          </div>
          <div className="text-xs font-semibold text-black">
            {specChannelWarn || ubBottleneckFlag}
          </div>
          <div className="text-[11px] text-zinc-700">
            Plain-language impact: A single DIMM in a multi-slot laptop cuts effective memory bandwidth by ~30–45%, lowering integrated GPU frame rates and multitasking snappiness. Installing a matched second stick unlocks full dual-channel speed.
          </div>
        </div>
      ) : (
        specs?.ramChannelMode && (
          <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2 flex items-center justify-between flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span className="font-mono text-[11px] font-bold text-black uppercase">
                Channel Topology: {specs.ramChannelMode}
              </span>
            </div>
            {specs.ramReliabilityNote && (
              <span className="text-[11px] text-zinc-600">{specs.ramReliabilityNote}</span>
            )}
          </div>
        )
      )}

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
              <option value="quick">Default @ serj — Shop QC (8 Kernels • 2 Min)</option>
              <option value="standard">Absolut @ anta777 — Durability (12 Kernels • 5 Min)</option>
              <option value="burnin">Extreme @ anta777 — Burn-In (16 Kernels • 15 Min)</option>
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

        {/* OS RAM Reserve Headroom Strip */}
        <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-zinc-700">
          <div className="flex items-center gap-2 font-bold text-black">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <span>
              OS Reserve Headroom:{" "}
              <strong className="text-blue-700">
                {result?.osReserveMb != null
                  ? `${result.osReserveMb} MB`
                  : expectedReserveMb != null
                  ? `${expectedReserveMb} MB`
                  : `${DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReservePct}% (${DEFAULT_HARDWARE_SAFETY_BOUNDS.ramOsReserveFloorMb}–${RAM_OS_RESERVE_16GB_CAP_MB} MB)`}
              </strong>{" "}
              protected for OS &amp; WebView2
            </span>
          </div>
          <div>
            Thermal Guard: &le; {DEFAULT_HARDWARE_SAFETY_BOUNDS.cpuThermalCutoffC}°C CPU cutoff
          </div>
        </div>

        {/* Dynamic MT0.dll Kernel Pattern Matrix (8 / 12 / 16 Kernels) */}
        <div>
          <div className="flex items-center justify-between mb-1.5 font-mono text-[10px] uppercase text-zinc-500">
            <span>TestMem5 (MT0.dll) Kernel Matrix — {activeKernelList.length} Active Kernels</span>
            <span>RefreshStable • SimpleTest (1MB–64MB, Prime 257/359/479, 256 Stride) • MirrorMove128 • BlockMove</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 border border-zinc-300 divide-x divide-y divide-zinc-200 font-mono tabular-nums">
            {activeKernelList.map((stage, i) => {
              const isCurrent = running && progress?.testIndex === i;
              const passes = livePasses[i] ?? 0;
              const errs = liveErrors[i] ?? 0;
              return (
                <div
                  key={`${i}-${stage}`}
                  title={stage}
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
        </div>

        {(running || bwHistory.length > 0) && (
          <div className="space-y-3 pt-2">
            {running && progress && (
              <>
                <div className="flex items-center justify-between text-xs font-mono tabular-nums flex-wrap gap-2">
                  <span className="text-blue-700 font-bold">
                    {progress.profileName} • CYCLE #{progress.cycle} • {progress.patternName}
                  </span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {progress.cpuTempC != null && (
                      <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-black flex items-center gap-1 text-[10.5px] font-bold">
                        <Thermometer className="w-3 h-3 text-blue-600" />
                        CPU: {progress.cpuTempC.toFixed(0)}°C
                      </span>
                    )}
                    {progress.thermalWarning && (
                      <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white text-[10px] font-bold">
                        THERMAL WARN
                      </span>
                    )}
                    <span className="text-black font-black flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-blue-600" />
                      {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({progress.percent.toFixed(0)}%)
                    </span>
                  </div>
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
          {result.thermalCutoffTriggered && (
            <div className="rounded-[2px] bg-black text-white px-4 py-2.5 text-xs font-mono flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
              <span>
                CPU THERMAL CUTOFF TRIGGERED ({result.peakCpuTempC?.toFixed(0) ?? ">=92"}°C limit reached — TestMem5 halted safely).
              </span>
            </div>
          )}

          <BaselineCard baseline={result.baseline} />

          {ramUbRating && (
            <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-500 flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5 text-blue-600" />
                    UserBenchmark RAM Calibration // {ramUbRating.detectedModel}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-xs font-black uppercase">
                      {ramUbRating.vehicleTier}
                    </span>
                    <span className="font-mono text-sm font-black text-black tabular-nums">
                      {ramUbRating.effectiveSpeedPct.toFixed(1)}% Effective Speed
                    </span>
                    <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10.5px] font-bold text-black">
                      {ramUbRating.standingLabel} ({ramUbRating.relativeStandingPct.toFixed(1)}% vs {ramUbRating.expectedClassPct.toFixed(0)}% class)
                    </span>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] font-mono text-[10px] text-zinc-600 uppercase">
                  {ramUbRating.sourceMode}
                </span>
              </div>

              {ramUbRating.bottleneckFlag && (
                <div className="rounded-[2px] bg-black text-white px-3 py-1.5 font-mono text-[11px] font-bold flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span>{ramUbRating.bottleneckFlag}</span>
                </div>
              )}

              {ramUbRating.subMetrics && ramUbRating.subMetrics.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ramUbRating.subMetrics.map(([k, v]) => (
                    <span
                      key={k}
                      className="px-2 py-0.5 rounded-[2px] border border-zinc-200 bg-[#F8FAFC] font-mono text-[10.5px] text-black tabular-nums"
                    >
                      <span className="text-zinc-500 mr-1">{k}:</span>
                      <strong>{v}</strong>
                    </span>
                  ))}
                </div>
              )}

              <div className="text-xs text-zinc-700">{ramUbRating.plainSummary}</div>
            </div>
          )}

          <div className="rounded-[2px] border border-zinc-300 bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-200 bg-[#F8FAFC] flex items-center justify-between flex-wrap gap-2">
              <span className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-black flex items-center gap-1.5">
                <MemoryStick className="w-3.5 h-3.5 text-blue-600" />
                {result.profileName} — Verified Metrics
              </span>
              <div className="flex items-center gap-2">
                {result.peakCpuTempC != null ? (
                  <span className="font-mono text-[10.5px] text-zinc-600">
                    Peak CPU: <strong className="text-black">{result.peakCpuTempC.toFixed(0)}°C</strong>
                  </span>
                ) : result.sensorUnavailable ? (
                  <span className="font-mono text-[10.5px] text-zinc-500">
                    Temp Sensor N/A (&le;300s bounded)
                  </span>
                ) : null}
                <StatusBadge status={result.status} compact />
              </div>
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
                <div className="text-[9.5px] uppercase text-zinc-500">Window &amp; Reserve</div>
                <div className="text-sm font-black text-black mt-0.5">
                  {result.allocatedMb} / {result.totalRamMb} MB
                </div>
                <div className="text-[10px] text-zinc-500">
                  OS Reserve: {result.osReserveMb ?? expectedReserveMb ?? "—"} MB
                </div>
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

          <div className="rounded-[2px] border border-zinc-300 border-l-[3px] border-l-blue-600 bg-white p-4 space-y-2.5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">
              What This Means for Long-Term Use
            </div>
            {result.plainSummary && (
              <div className="text-xs text-black font-medium">{result.plainSummary}</div>
            )}
            {specs?.ramReliabilityNote && (
              <div className="text-xs text-zinc-700">{specs.ramReliabilityNote}</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1 text-[11px]">
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">Bit-Flip Stability</div>
                <div className="text-zinc-600 mt-0.5">
                  {result.errorsFound === 0
                    ? "0 memory bit flips across all MT0.dll stride, retention, and SIMD tests — prevents random BSODs and file corruption."
                    : `${result.errorsFound} memory errors detected — defective DRAM cells or unstable timings will cause crashes and data corruption.`}
                </div>
              </div>
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">Channel &amp; Upgradeability</div>
                <div className="text-zinc-600 mt-0.5">
                  {hasChannelBottleneck
                    ? "Running in single-channel mode reduces bandwidth by ~30–45%. Upgrading with a second matched stick improves speed noticeably."
                    : `Running in ${specs?.ramChannelMode ?? "matched"} configuration for full expected DRAM throughput.`}
                </div>
              </div>
              <div className="rounded-[2px] border border-zinc-200 bg-[#F8FAFC] p-2.5">
                <div className="font-mono text-[10px] font-bold uppercase text-black">Thermal &amp; OS Safety</div>
                <div className="text-zinc-600 mt-0.5">
                  {result.osReserveMb ?? expectedReserveMb ?? "Protected"} MB remained reserved for the OS while CPU stayed{" "}
                  {result.thermalCutoffTriggered ? "at thermal cutoff" : "within safe thermal bounds"}.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <EngineeringConsole lines={consoleLog} />

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(result && !running)}
        requirementHint={`Run the continuous TestMem5 RAM durability test to unlock Stage ${String(Math.min(stepNumber + 1, totalSteps)).padStart(2, "0")} (or click Skip Step).`}
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
