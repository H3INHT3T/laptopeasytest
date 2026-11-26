import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Award,
  Cpu,
  Database,
  Download,
  Flame,
  Gauge,
  Mic,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Thermometer,
  Upload,
} from "lucide-react";
import {
  CPU_THERMAL_CUTOFF_DEFAULT_C,
  CPU_THERMAL_CUTOFF_MAX_C,
  type CinePathtracerResult,
  type LiveTelemetrySnapshot,
  type PerfBenchProgress,
  type PerfBenchResult,
  type StressPreset,
  type SystemSpecs,
  type TestStatus,
  type UserBenchmarkComparison,
  type UserBenchmarkComponentRating,
  type UserBenchmarkInput,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { NovabenchScoreBar } from "../components/NovabenchScoreBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";
import { EnvironmentGuard } from "../components/EnvironmentGuard";
import { EngineeringConsole, ThresholdAuditTable, type ThresholdAuditRow } from "../components/EngineeringConsole";
import { CinePathtracerPanel } from "../components/CinePathtracerPanel";

interface PerformanceViewProps {
  telemetry: LiveTelemetrySnapshot | null;
  specs?: SystemSpecs | null;
  manufacturer?: string;
  model?: string;
  result: PerfBenchResult | null;
  cinePathtracerResult?: CinePathtracerResult | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onUserbenchmarkUpdate?: (comp: UserBenchmarkComparison) => void;
  onComplete: (res: PerfBenchResult) => void;
  onCinePathtracerComplete?: (res: CinePathtracerResult) => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  telemetry,
  specs,
  manufacturer,
  model,
  result,
  cinePathtracerResult = null,
  userbenchmarkComparison,
  status,
  stepNumber,
  totalSteps,
  onUserbenchmarkUpdate,
  onComplete,
  onCinePathtracerComplete,
  onRunningChange,
  onNext,
  onSkip,
}) => {
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [allowLiveLookup, setAllowLiveLookup] = useState(false);
  const [localUbComparison, setLocalUbComparison] = useState<UserBenchmarkComparison | null>(null);
  const liveLookupCmpRef = useRef<UserBenchmarkComparison | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PerfBenchProgress | null>(null);
  const [cpuLoadHistory, setCpuLoadHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const lastPhaseRef = useRef<string>("");
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Optional 6s Mic-Verified Fan Acoustic & Bearing-Grind Check (v3.0.0)
  const [fanAcousticRunning, setFanAcousticRunning] = useState(false);
  const [fanAcousticResult, setFanAcousticResult] = useState<{
    status: TestStatus;
    verdict: string;
    rmsDb: number;
    tonalPeakRatio: number;
    rattleClicks: number;
    summary: string;
  } | null>(null);
  const [fanAcousticError, setFanAcousticError] = useState<string | null>(null);

  const runFanAcousticCheck = async () => {
    setFanAcousticError(null);
    setFanAcousticResult(null);
    setFanAcousticRunning(true);
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);

      const timeData = new Float32Array(analyser.fftSize);
      const freqData = new Float32Array(analyser.frequencyBinCount);
      const binHz = ctx.sampleRate / analyser.fftSize;

      const rmsSamples: number[] = [];
      const tonalRatios: number[] = [];
      let rattleClicks = 0;

      const started = performance.now();
      while (performance.now() - started < 6000) {
        analyser.getFloatTimeDomainData(timeData);
        analyser.getFloatFrequencyData(freqData);

        let sumSq = 0;
        let peakAbs = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = timeData[i];
          sumSq += v * v;
          if (Math.abs(v) > peakAbs) peakAbs = Math.abs(v);
        }
        const rms = Math.sqrt(sumSq / timeData.length);
        const rmsDb = 20 * Math.log10(Math.max(rms, 1e-6));
        rmsSamples.push(rmsDb);

        // Crest-factor impulsive spike check (bearing click/rattle)
        if (rms > 0.004 && peakAbs / Math.max(rms, 1e-6) > 7.5) {
          rattleClicks += 1;
        }

        // High-frequency narrowband tonal whine ratio (1.5 kHz - 6.0 kHz vs broadband floor)
        const loBin = Math.max(1, Math.floor(1500 / binHz));
        const hiBin = Math.min(freqData.length - 1, Math.ceil(6000 / binHz));
        let sumDb = 0;
        let maxDb = -140;
        let count = 0;
        for (let b = loBin; b <= hiBin; b++) {
          const v = freqData[b];
          if (Number.isFinite(v)) {
            sumDb += v;
            if (v > maxDb) maxDb = v;
            count++;
          }
        }
        if (count > 0) {
          const avgDb = sumDb / count;
          tonalRatios.push(Math.max(0, maxDb - avgDb));
        }

        await new Promise((r) => setTimeout(r, 150));
      }

      const avgRmsDb = Number(
        (rmsSamples.reduce((a, b) => a + b, 0) / Math.max(1, rmsSamples.length)).toFixed(1)
      );
      const peakTonal = Number(
        (tonalRatios.reduce((a, b) => Math.max(a, b), 0)).toFixed(1)
      );

      let st: TestStatus = "pass";
      let verdict = "QUIET_NORMAL";
      let summary = `Fan acoustics normal (${avgRmsDb} dBFS, tonal prominence +${peakTonal} dB, ${rattleClicks} impulse click(s)) — smooth airflow with no bearing grind.`;
      if (rattleClicks >= 4 || (peakTonal >= 26 && avgRmsDb > -48)) {
        st = "warn";
        verdict = "BEARING_GRIND_SUSPECTED";
        summary = `WARN: Possible fan bearing grind / tonal whine detected (${avgRmsDb} dBFS, +${peakTonal} dB narrowband spike, ${rattleClicks} impulse clicks) — physically inspect cooling fan.`;
      } else if (avgRmsDb > -26) {
        st = "warn";
        verdict = "LOUD_AIRFLOW";
        summary = `WARN: Elevated fan/chassis noise (${avgRmsDb} dBFS) — verify vents are dust-free and fan curve is normal.`;
      }

      setFanAcousticResult({
        status: st,
        verdict,
        rmsDb: avgRmsDb,
        tonalPeakRatio: peakTonal,
        rattleClicks,
        summary,
      });
    } catch (e) {
      setFanAcousticError(`Microphone unavailable for fan acoustic check (${String(e)}).`);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      setFanAcousticRunning(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<PerfBenchProgress>("perf:progress", (ev) => {
      const p = ev.payload;
      setProgress(p);
      setCpuLoadHistory((prev) => [...prev.slice(-79), p.cpuUsagePct]);
      if (p.cpuTempC != null) {
        setTempHistory((prev) => [...prev.slice(-79), p.cpuTempC as number]);
      }
      if (p.raytracePreviewUrl) {
        setLivePreview(p.raytracePreviewUrl);
      }
      if (p.phase !== lastPhaseRef.current) {
        lastPhaseRef.current = p.phase;
        setConsoleLog((prev) => [
          ...prev.slice(-80),
          `[${p.elapsedSecs.toFixed(1)}s] ${p.phase} | CPU=${p.cpuUsagePct.toFixed(0)}% @ ${p.cpuClockMhz}MHz${p.cpuTempC != null ? ` | Temp=${p.cpuTempC.toFixed(0)}°C` : ""}`,
        ]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const liveCmp = liveLookupCmpRef.current;
    if (
      liveCmp &&
      liveCmp.sourceMode === "live_verified" &&
      userbenchmarkComparison &&
      userbenchmarkComparison.sourceMode === "offline_calibrated"
    ) {
      liveLookupCmpRef.current = null;
      onUserbenchmarkUpdate?.(liveCmp);
    }
  }, [userbenchmarkComparison, onUserbenchmarkUpdate]);

  const startBench = async () => {
    setError(null);
    setHistoryNotice(null);
    liveLookupCmpRef.current = null;
    setRunning(true);
    onRunningChange(true);
    setCpuLoadHistory([]);
    setTempHistory([]);
    setLivePreview(null);
    lastPhaseRef.current = "";
    setConsoleLog([
      `[0.0s] Starting 14-stage 360° All-Scope Performance Suite (preset=${preset}, DUT=${manufacturer ?? specs?.manufacturer ?? "Laptop"} ${model ?? specs?.model ?? ""})`,
    ]);
    setProgress({
      phase: "Initializing 14-Stage All-Scope Performance Suite...",
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
        manufacturer: manufacturer ?? specs?.manufacturer ?? null,
        model: model ?? specs?.model ?? null,
      });
      if (res.raytracePreviewUrl) setLivePreview(res.raytracePreviewUrl);
      setConsoleLog((prev) => [
        ...prev,
        `[${res.elapsedSecs.toFixed(1)}s] COMPLETE: Grade=${res.durabilityGrade} | Mark=${res.compositeScore} | Office=${res.officeScore} | Creator=${res.creatorScore} (${res.creatorMegaRaysS.toFixed(2)} MRays/s) | Mem=${res.memoryMark} | Throttle=-${res.throttleDropPct.toFixed(1)}%`,
      ]);

      try {
        const ubInput: UserBenchmarkInput = {
          cpuBrand: specs?.cpuBrand,
          cpuPhysicalCores: specs?.cpuPhysicalCores ?? null,
          cpuLogicalCores: specs?.cpuLogicalCores ?? null,
          cpuSingleCore: res.singleCoreScore,
          cpuMultiCore: res.multiCoreScore,
          cpuComposite: res.compositeScore,
          ramType: specs?.ramModules[0]?.memoryType ?? null,
          ramBandwidthGbS: res.memoryBandwidthGbS,
          ramLatencyNs: res.memoryLatencyNs,
          ramChannelMode: specs?.ramChannelMode ?? null,
          allowLiveLookup,
          specs: specs ?? null,
          perf: res,
        };
        const cmp = await invoke<UserBenchmarkComparison>("compare_userbenchmark", {
          input: ubInput,
        });
        if (cmp && typeof cmp === "object") {
          setLocalUbComparison(cmp);
          liveLookupCmpRef.current = allowLiveLookup ? cmp : null;
          onUserbenchmarkUpdate?.(cmp);
        }
      } catch {
        // Offline / non-blocking fallback if compare_userbenchmark is unavailable
      }

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

  const effectiveUb =
    allowLiveLookup && localUbComparison
      ? localUbComparison
      : userbenchmarkComparison ?? localUbComparison;
  const cpuUbRating: UserBenchmarkComponentRating | null =
    effectiveUb?.cpu ?? result?.userbenchmarkRating ?? null;

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

  const auditRows: ThresholdAuditRow[] = result
    ? [
        {
          parameter: "Sustained Hot-CPU Thermal Throttle Drop",
          measured: `${result.throttleDropPct.toFixed(1)}% slowdown`,
          limit: "<= 15.0% ideal (<= 25% max)",
          verdict: result.throttleDropPct <= 15 ? "PASS" : result.throttleDropPct <= 25 ? "WARN" : "FAIL",
          meaning: "Measures how much speed the CPU loses once heatsink heat builds up during sustained loads.",
        },
        {
          parameter: "CPU Thermal Safety Cutoff Guard",
          measured: result.thermalCutoffTriggered
            ? `CUTOFF TRIGGERED (${result.peakCpuTempC != null ? `${result.peakCpuTempC.toFixed(1)}°C` : `>= ${CPU_THERMAL_CUTOFF_DEFAULT_C}°C`})`
            : result.peakCpuTempC != null
            ? `${result.peakCpuTempC.toFixed(1)}°C peak`
            : "Sensor unavailable (<= 6s/stage cap)",
          limit: `<= ${CPU_THERMAL_CUTOFF_DEFAULT_C}°C safe (${CPU_THERMAL_CUTOFF_MAX_C}°C hard max)`,
          verdict: result.thermalCutoffTriggered
            ? "FAIL"
            : result.peakCpuTempC != null && result.peakCpuTempC >= CPU_THERMAL_CUTOFF_DEFAULT_C
            ? "WARN"
            : "PASS",
          meaning: "Automatically aborts mid-stage if CPU core temperatures reach unsafe silicon limits.",
        },
        {
          parameter: "Composite Score vs. CPU Class Normal",
          measured: `${result.compositeScore.toLocaleString()} (${result.baseline.percentOfNormal.toFixed(1)}%)`,
          limit: ">= 85.0% of Factory Normal",
          verdict:
            result.baseline.percentOfNormal >= 85
              ? "PASS"
              : result.baseline.percentOfNormal >= 65
              ? "WARN"
              : "FAIL",
          meaning: "Weighted Harmonic Mean mark compared against healthy laptops with the same CPU tier.",
        },
        {
          parameter: "DRAM Pointer-Chase Latency & Bandwidth",
          measured: `${result.memoryLatencyNs.toFixed(1)} ns (${result.memoryBandwidthGbS.toFixed(1)} GB/s copy)`,
          limit: "<= 110.0 ns",
          verdict: result.memoryLatencyNs <= 110 ? "PASS" : "WARN",
          meaning: "Verifies responsiveness across L1/L2/L3 cache and main DRAM (catches single-channel bottlenecks).",
        },
        ...(result.bdProchotSuspected
          ? [
              {
                parameter: "BD PROCHOT / Stuck-Clock Fault Guard",
                measured: `LOCKED @ ${result.minLoadClockMhz ?? 0} MHz (${(result.stuckClockSecs ?? 0).toFixed(1)}s under load)`,
                limit: ">= 900 MHz under 100% multi-core load",
                verdict: "FAIL" as const,
                meaning:
                  result.stuckClockNote ||
                  "CPU remained stuck below 900 MHz under load — inspect charger ID pin, DC-IN jack, or motherboard VR sensor.",
              },
            ]
          : []),
        ...(result.cooldownVerdict && result.cooldownVerdict !== "UNAVAILABLE"
          ? [
              {
                parameter: "12s Post-Load Heatsink Cool-Down",
                measured:
                  result.cooldownDropC != null
                    ? `-${result.cooldownDropC.toFixed(1)}°C (${result.cooldownStartTempC?.toFixed(0) ?? "—"}°C -> ${result.cooldownEndTempC?.toFixed(0) ?? "—"}°C)`
                    : result.cooldownVerdict,
                limit: ">= 8.0°C drop & <= 78°C after >= 80°C load",
                verdict: (result.cooldownVerdict === "POOR_COOLING" ? "WARN" : "PASS") as "PASS" | "WARN",
                meaning:
                  result.cooldownNote ||
                  "Checks whether cooling fans and thermal paste pull CPU temperatures down quickly right after full load.",
              },
            ]
          : []),
        ...(result.shopComparison?.found && result.shopComparison.percentVsShop != null
          ? [
              {
                parameter: `Shop Model Parity (${result.shopComparison.unitsTested} units)`,
                measured: `${result.shopComparison.percentVsShop.toFixed(1)}% of shop avg`,
                limit: ">= 90.0% of identical shop units",
                verdict: (result.shopComparison.percentVsShop >= 90 ? "PASS" : "WARN") as "PASS" | "WARN",
                meaning: "Compares this unit against identical laptop models previously benchmarked in your shop.",
              },
            ]
          : []),
      ]
    : [];

  const nextStageNum = String(Math.min(stepNumber + 1, totalSteps)).padStart(2, "0");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              360° Performance &amp; Creator Benchmark
              <span className="sr-only"> — 360° All-Scope Performance, Creator &amp; Thermal Audit</span>
            </h1>
            <StatusBadge status={status} />
            {result?.simdIsa && (
              <span className="px-2 py-0.5 rounded-full bg-white border border-zinc-200 text-blue-700 font-mono text-[11px] font-semibold">
                {result.simdIsa}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • CPU, Office, AI GEMM, 3D Ray-Tracing &amp; Memory • Guard &le; {CPU_THERMAL_CUTOFF_MAX_C}°C
          </div>
        </div>
      </div>

      <EnvironmentGuard telemetry={telemetry} requireAc={true} />

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="font-mono text-[11px] font-bold uppercase text-zinc-600">Protocol:</label>
              <select
                value={preset}
                disabled={running}
                onChange={(e) => setPreset(e.target.value as StressPreset)}
                className="bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5 font-mono text-xs text-black font-medium"
              >
                <option value="quick">Shop QC — 14-Stage Sustained (~50–60s)</option>
                <option value="standard">Standard Durability — 14-Stage (~2.2m)</option>
                <option value="burnin">Thermal Burn-In — 14-Stage (~4.5m)</option>
              </select>
            </div>
            <label
              className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-700 cursor-pointer"
              title="Optional non-blocking live lookup (<= 800ms) with automatic offline fallback"
            >
              <input
                type="checkbox"
                disabled={running}
                checked={allowLiveLookup}
                onChange={(e) => setAllowLiveLookup(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
              Allow Live Lookup (&le;800ms)
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={runFanAcousticCheck}
              disabled={fanAcousticRunning}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:border-black disabled:opacity-50 text-black text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              title="Optional 6-second microphone FFT scan for fan bearing grind or tonal whine"
            >
              <Mic className="w-3.5 h-3.5 text-blue-600" />
              {fanAcousticRunning ? "Listening to Fan (6s)..." : "Check Fan Acoustics (6s)"}
            </button>
            {running ? (
              <button
                onClick={() => invoke("cancel_performance_benchmark").catch(() => {})}
                className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" /> {progress?.inCooldown ? "Skip Cool-Down" : "Abort Suite"}
              </button>
            ) : (
              <button
                onClick={startBench}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Run 14-Stage Suite
              </button>
            )}
          </div>
        </div>

        {(running || cpuLoadHistory.length > 0 || previewImg) && (
          <div className="space-y-3 pt-3 border-t border-zinc-200">
            {running && progress && (
              <>
                <div className="flex items-center justify-between text-xs font-mono tabular-nums flex-wrap gap-2">
                  <span className="text-blue-700 font-bold">{progress.phase}</span>
                  <span className="text-black flex items-center gap-3 font-bold">
                    <span>{progress.elapsedSecs.toFixed(0)}s</span>
                    <span>CPU {progress.cpuUsagePct.toFixed(0)}%</span>
                    {progress.cpuClockMhz > 0 && <span>{progress.cpuClockMhz}MHz</span>}
                    {progress.cpuTempC != null && (
                      <span className="flex items-center gap-1 text-blue-700">
                        <Thermometer className="w-3.5 h-3.5" /> {progress.cpuTempC.toFixed(0)}°C
                      </span>
                    )}
                    <span>{progress.percent.toFixed(0)}%</span>
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-200 overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Live 3D Path-Tracer Viewport */}
              <div className="rounded-lg border border-zinc-300 bg-black overflow-hidden flex flex-col justify-between">
                <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center justify-between text-[10px] font-mono text-zinc-300">
                  <span className="font-bold text-blue-400 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> 3D PATH-TRACER
                  </span>
                  {result && !running && <span>{result.creatorMegaRaysS.toFixed(2)} MRays/s</span>}
                </div>
                <div className="aspect-video bg-black flex items-center justify-center">
                  {previewImg ? (
                    <img src={previewImg} alt="3D Path-Tracing Tile Render" className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-center p-4 font-mono text-[10.5px] text-zinc-400">
                      <Cpu className="w-5 h-5 text-blue-500 mx-auto mb-1.5" />
                      32×32 progressive tile render streams in Stage {String(stepNumber).padStart(2, "0")}
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                <LiveChart
                  title="CPU Utilization Oscilloscope"
                  unit="%"
                  data={cpuLoadHistory}
                  maxSuggested={100}
                  baselineValue={95}
                  baselineLabel="FULL LOAD 95%"
                  plainHint="Sustained 90–100% indicates full multi-core utilization without OS stalls."
                />
                {tempHistory.length > 0 ? (
                  <LiveChart
                    title="CPU Thermal Curve"
                    unit="°C"
                    data={tempHistory}
                    maxSuggested={100}
                    baselineValue={CPU_THERMAL_CUTOFF_DEFAULT_C}
                    baselineLabel={`CUTOFF ${CPU_THERMAL_CUTOFF_DEFAULT_C}°C`}
                    higherIsBetter={false}
                    plainHint="Automatic thermal cutoff stops the suite safely before silicon limits."
                  />
                ) : (
                  <div className="rounded-lg border border-zinc-300 bg-[#F8FAFC] p-4 flex flex-col justify-center text-xs text-zinc-600">
                    <div className="font-mono text-[10px] font-bold uppercase text-black mb-1">
                      BOUNDED SAFE TELEMETRY BRIDGE
                    </div>
                    <p className="text-[11px]">
                      Reading OS native CPU clocks &amp; load. When direct core temperature sensors are unavailable, stage duration is automatically capped (&le;6s/stage) for thermal safety.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {fanAcousticError && (
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] px-3.5 py-2 text-xs text-black">
            {fanAcousticError}
          </div>
        )}
        {fanAcousticResult && (
          <div
            className={`rounded-xl border px-3.5 py-2.5 flex items-center justify-between gap-3 flex-wrap text-xs ${
              fanAcousticResult.status === "warn"
                ? "border-black bg-black text-white"
                : "border-blue-600 bg-[#F8FAFC] text-black"
            }`}
          >
            <span>
              <strong>Fan Acoustic Audit ({fanAcousticResult.verdict.replace(/_/g, " ")}):</strong>{" "}
              {fanAcousticResult.summary}
            </span>
            <StatusBadge status={fanAcousticResult.status} darkSurface={fanAcousticResult.status === "warn"} compact />
          </div>
        )}
        {error && <div className="rounded-lg bg-black text-white px-3 py-2 font-mono text-xs">{error}</div>}
        {historyNotice && (
          <div className="rounded-lg bg-blue-50 border border-blue-600 text-blue-900 px-3 py-2 font-mono text-xs font-semibold">
            {historyNotice}
          </div>
        )}
      </div>

      {/* Results */}
      {result && !running && (
        <div className="space-y-3">
          {result.thermalCutoffTriggered && (
            <div className="rounded-lg border-2 border-black bg-black text-white p-3.5 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div className="text-xs space-y-0.5">
                <div className="font-mono font-black uppercase tracking-wider text-blue-400">
                  CPU THERMAL SAFETY CUTOFF TRIGGERED ({result.peakCpuTempC != null ? `${result.peakCpuTempC.toFixed(1)}°C` : `<= ${CPU_THERMAL_CUTOFF_MAX_C}°C`})
                </div>
                <p className="text-zinc-200">
                  The benchmark stopped mid-stage to protect the processor from overheating. Clean dust from cooling fins, verify fan spin, or replace dried thermal paste before sale.
                </p>
              </div>
            </div>
          )}

          {result.bdProchotSuspected && (
            <div className="rounded-xl border-2 border-black bg-black text-white p-3.5 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div className="text-xs space-y-0.5">
                <div className="font-mono font-bold text-blue-400">
                  BD PROCHOT / STUCK-CLOCK FAULT ({result.minLoadClockMhz ?? 0} MHz locked for {(result.stuckClockSecs ?? 0).toFixed(1)}s)
                </div>
                <p className="text-zinc-200">{result.stuckClockNote}</p>
              </div>
            </div>
          )}

          {result.cooldownVerdict === "POOR_COOLING" && (
            <div className="rounded-xl border-2 border-black bg-black text-white p-3.5 flex items-start gap-3">
              <Thermometer className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div className="text-xs space-y-0.5">
                <div className="font-mono font-bold text-blue-400">
                  Poor Heatsink Cool-Down Recovery ({result.cooldownStartTempC?.toFixed(0)}°C -&gt; {result.cooldownEndTempC?.toFixed(0)}°C in 12s)
                </div>
                <p className="text-zinc-200">{result.cooldownNote}</p>
              </div>
            </div>
          )}

          {result.sensorUnavailable && (
            <div className="rounded-lg border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2.5 flex items-center gap-2.5 text-xs text-black">
              <AlertTriangle className="w-4 h-4 text-blue-600 shrink-0" />
              <span>
                <strong>Temperature Sensor Unavailable:</strong> CPU core sensor was not exposed by firmware; bounded safe stage durations (&le;6.0s per stage) were enforced automatically.
              </span>
            </div>
          )}

          <BaselineCard
            baseline={result.baseline}
            plainSummary={result.plainSummary}
            userbenchmarkRating={cpuUbRating}
            title="CPU & SYSTEM CALIBRATION"
          />

          {/* UserBenchmark Comparison & Vehicle Tiers Panel */}
          {(effectiveUb || cpuUbRating) && (
            <div className="rounded-lg border border-zinc-300 bg-white p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-zinc-200">
                <div className="flex items-center gap-2 flex-wrap">
                  <Award className="w-4 h-4 text-blue-600" />
                  <span className="font-mono text-[11px] font-black uppercase tracking-wider text-black">
                    UserBenchmark Comparison &amp; Vehicle Tiers
                  </span>
                  <span className="px-2 py-0.5 rounded-lg bg-blue-600 text-white font-mono text-[11px] font-black uppercase">
                    {effectiveUb?.overallVehicleTier ?? cpuUbRating?.vehicleTier}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-lg border border-zinc-300 bg-[#F8FAFC] font-mono text-[10px] font-bold text-zinc-700">
                    {(effectiveUb?.sourceMode ?? cpuUbRating?.sourceMode) === "live_verified"
                      ? "Live Verified"
                      : "Offline Calibrated"}
                  </span>
                </div>
                {cpuUbRating && (
                  <span
                    className={`px-2 py-0.5 rounded-lg border font-mono text-[10.5px] font-bold ${
                      cpuUbRating.standingLabel === "Underperforming"
                        ? "bg-black text-white border-black"
                        : cpuUbRating.standingLabel === "Below Expectations"
                        ? "bg-white text-black border-black"
                        : "bg-blue-50/40 text-blue-700 border-blue-600"
                    }`}
                  >
                    {cpuUbRating.standingLabel}
                  </span>
                )}
              </div>

              {effectiveUb && (
                <div className="grid grid-cols-1 md:grid-cols-3 border border-zinc-300 divide-y md:divide-y-0 md:divide-x divide-zinc-200 bg-[#F8FAFC] font-mono tabular-nums">
                  <div className="p-3">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Gaming Profile</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {effectiveUb.gamingPct.toFixed(1)}%
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Desktop Profile</div>
                    <div className="text-xl font-black text-blue-700 mt-0.5">
                      {effectiveUb.desktopPct.toFixed(1)}%
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Workstation Profile</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {effectiveUb.workstationPct.toFixed(1)}%
                    </div>
                  </div>
                </div>
              )}

              {effectiveUb && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {[effectiveUb.cpu, effectiveUb.gpu, effectiveUb.ssd, effectiveUb.ram]
                    .filter((c): c is UserBenchmarkComponentRating => Boolean(c))
                    .map((comp) => (
                      <div
                        key={comp.component}
                        className="rounded-lg border border-zinc-200 bg-[#F8FAFC] p-2.5 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                          <strong className="text-black uppercase">
                            {comp.component}: {comp.detectedModel}
                          </strong>
                          <span className="px-1.5 py-0.5 rounded-lg bg-blue-600 text-white font-bold text-[9.5px]">
                            {comp.vehicleTier}
                          </span>
                        </div>
                        <div className="flex items-center justify-between font-mono text-[10px] text-zinc-600 tabular-nums">
                          <span>
                            Effective <strong className="text-blue-700">{comp.effectiveSpeedPct.toFixed(1)}%</strong> vs Class{" "}
                            <strong className="text-black">{comp.expectedClassPct.toFixed(1)}%</strong> ({comp.relativeStandingPct.toFixed(0)}%)
                          </span>
                          <span className="font-bold text-black">{comp.standingLabel}</span>
                        </div>
                        {comp.bottleneckFlag && (
                          <div className="font-mono text-[10px] bg-black text-white px-2 py-0.5 rounded-lg">
                            BOTTLENECK: {comp.bottleneckFlag}
                          </div>
                        )}
                        <div className="text-[11px] text-zinc-700">{comp.plainSummary}</div>
                      </div>
                    ))}
                </div>
              )}

              {effectiveUb?.headlineSummary && (
                <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-black">
                  <strong className="font-mono text-[10px] uppercase text-blue-700 mr-1.5">
                    Summary:
                  </strong>
                  {effectiveUb.headlineSummary}
                </div>
              )}

              {effectiveUb && effectiveUb.recommendations.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-zinc-700 space-y-0.5">
                  {effectiveUb.recommendations.map((rec, idx) => (
                    <li key={idx}>{rec}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Architectural Score Plate */}
          <div className="rounded-lg border border-black bg-white overflow-hidden">
            <div className="px-5 py-4 bg-black text-white flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-lg bg-blue-600 text-white flex flex-col items-center justify-center shrink-0">
                  <span className="font-mono text-[8.5px] uppercase font-bold tracking-widest text-blue-100">GRADE</span>
                  <span className="text-2xl font-black font-mono leading-none mt-0.5">{result.durabilityGrade}</span>
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-blue-400 font-bold flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5" /> PASSMARK WEIGHTED HARMONIC COMPOSITE MARK
                  </div>
                  <div className="text-3xl font-black text-white font-mono tabular-nums mt-0.5">
                    {result.compositeScore.toLocaleString()}
                  </div>
                  <div className="font-mono text-[11px] text-zinc-300 mt-0.5">
                    {result.tier} • {result.simdIsa} • Throttle Drop: {result.throttleDropPct.toFixed(1)}%
                    {result.peakCpuTempC != null ? ` • Peak ${result.peakCpuTempC.toFixed(1)}°C` : ""}
                    {result.cooldownDropC != null
                      ? ` • Cool-Down -${result.cooldownDropC.toFixed(1)}°C (${result.cooldownVerdict})`
                      : ""}
                  </div>
                </div>
              </div>
              <div className="text-right font-mono tabular-nums text-[11px] text-zinc-300 space-y-1">
                <div>
                  MEM CACHED/COPY/WRITE:{" "}
                  <strong className="text-white">
                    {result.memoryCachedGbS.toFixed(0)} / {result.memoryBandwidthGbS.toFixed(1)} / {result.memoryWriteGbS.toFixed(1)} GB/s
                  </strong>
                </div>
                <div>
                  DRAM LATENCY: <strong className="text-blue-400">{result.memoryLatencyNs.toFixed(1)} ns</strong> • {result.elapsedSecs.toFixed(1)}s
                </div>
                <div className="flex items-center justify-end gap-2">
                  {result.throttleDropPct >= 15 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-blue-600 text-white text-[9.5px] font-bold">
                      <Flame className="w-3 h-3" /> THROTTLE -{result.throttleDropPct.toFixed(0)}%
                    </span>
                  )}
                  <StatusBadge status={result.status} darkSurface compact />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums">
              <div className="p-3.5">
                <div className="text-[9.5px] uppercase tracking-wider text-zinc-500 font-bold">Office Scope</div>
                <div className="text-xl font-black text-black mt-0.5">{result.officeScore.toLocaleString()}</div>
                <div className="text-[10px] text-zinc-500">Single-Core, DB, LZ, Crypto</div>
              </div>
              <div className="p-3.5 bg-blue-50/30">
                <div className="text-[9.5px] uppercase tracking-wider text-blue-700 font-bold">Creator &amp; AI</div>
                <div className="text-xl font-black text-blue-700 mt-0.5">{result.creatorScore.toLocaleString()}</div>
                <div className="text-[10px] text-zinc-600">
                  3D {result.creatorMegaRaysS.toFixed(1)} MRays/s • AI GEMM
                </div>
              </div>
              <div className="p-3.5">
                <div className="text-[9.5px] uppercase tracking-wider text-zinc-500 font-bold">CPU Multi-Core</div>
                <div className="text-xl font-black text-black mt-0.5">{result.multiCoreScore.toLocaleString()}</div>
                <div className="text-[10px] text-zinc-500">9 Weighted Harmonic Subtests</div>
              </div>
              <div className="p-3.5">
                <div className="text-[9.5px] uppercase tracking-wider text-zinc-500 font-bold">Memory Mark</div>
                <div className="text-xl font-black text-black mt-0.5">{result.memoryMark.toLocaleString()}</div>
                <div className="text-[10px] text-zinc-500">
                  {result.memoryBandwidthGbS.toFixed(1)} GB/s • {result.memoryLatencyNs.toFixed(1)} ns
                </div>
              </div>
            </div>

            {/* PassMark 11 Memory Mark 7-Subtest Strip */}
            <div className="border-t border-zinc-200 bg-[#F8FAFC] px-4 py-2.5">
              <div className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-zinc-600 mb-1.5">
                PassMark 11 Memory Mark (7 Subtests)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 font-mono tabular-nums text-[10.5px]">
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Cached Read</div>
                  <div className="font-bold text-black">{result.memoryCachedGbS.toFixed(1)} GB/s</div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Uncached &gt;LLC</div>
                  <div className="font-bold text-black">
                    {(result.memoryUncachedReadGbS ?? result.memoryBandwidthGbS).toFixed(1)} GB/s
                  </div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Threaded Copy</div>
                  <div className="font-bold text-black">
                    {(result.memoryThreadedGbS ?? result.memoryBandwidthGbS).toFixed(1)} GB/s
                  </div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Write Speed</div>
                  <div className="font-bold text-black">{result.memoryWriteGbS.toFixed(1)} GB/s</div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">DRAM Latency</div>
                  <div className="font-bold text-blue-700">{result.memoryLatencyNs.toFixed(1)} ns</div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Database Ops</div>
                  <div className="font-bold text-black">
                    {result.memoryDatabaseKops != null
                      ? `${result.memoryDatabaseKops.toFixed(0)} kOps/s`
                      : `${result.databaseScore.toLocaleString()}`}
                  </div>
                </div>
                <div className="bg-white border border-zinc-200 px-2 py-1.5 rounded-lg">
                  <div className="text-[8.5px] text-zinc-500 uppercase">Available RAM</div>
                  <div className="font-bold text-black">
                    {result.availableRamMb != null
                      ? `${(result.availableRamMb / 1024).toFixed(1)} GB`
                      : specs
                      ? `${specs.totalRamGb.toFixed(0)} GB`
                      : "—"}
                  </div>
                </div>
              </div>
            </div>

            {/* v3.2.0 Real-World Media, Crypto, JSON & Multi-Core Scaling Strip */}
            {(result.videoEncodeFps || result.sha256MbS || result.jsonParseMbS || result.coreScalingRatio) && (
              <div className="border-t border-zinc-200 bg-white px-4 py-2.5">
                <div className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-blue-700 mb-1.5">
                  Real-World Media, Crypto, Dev &amp; Multi-Core Scaling (v3.2.0)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono tabular-nums text-[10.5px]">
                  <div className="bg-[#F8FAFC] border border-zinc-200 px-2.5 py-1.5 rounded-lg">
                    <div className="text-[8.5px] text-zinc-500 uppercase">4K Video DCT Encode</div>
                    <div className="font-bold text-black">
                      {(result.videoEncodeFps ?? 0).toFixed(1)} FPS
                    </div>
                  </div>
                  <div className="bg-[#F8FAFC] border border-zinc-200 px-2.5 py-1.5 rounded-lg">
                    <div className="text-[8.5px] text-zinc-500 uppercase">SHA-256 Crypto</div>
                    <div className="font-bold text-black">
                      {(result.sha256MbS ?? 0).toFixed(1)} MB/s
                    </div>
                  </div>
                  <div className="bg-[#F8FAFC] border border-zinc-200 px-2.5 py-1.5 rounded-lg">
                    <div className="text-[8.5px] text-zinc-500 uppercase">JSON Parse &amp; Serialize</div>
                    <div className="font-bold text-black">
                      {(result.jsonParseMbS ?? 0).toFixed(1)} MB/s
                    </div>
                  </div>
                  <div className="bg-[#F8FAFC] border border-zinc-200 px-2.5 py-1.5 rounded-lg">
                    <div className="text-[8.5px] text-zinc-500 uppercase">Multi-Core Scaling</div>
                    <div className="font-bold text-blue-700">
                      {(result.coreScalingRatio ?? 0).toFixed(2)}x ({(result.coreScalingEfficiencyPct ?? 0).toFixed(0)}% eff)
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <NovabenchScoreBar
            scoreLabel="COMPOSITE"
            scoreValue={result.compositeScore.toLocaleString()}
            title={`${specs?.cpuBrand || "Processor"} — ${result.tier}`}
            takeaway={result.plainSummary || result.summary}
            percent={result.baseline.percentOfNormal}
            medianLabel={result.baseline.expectedNormal}
            medianPercent={85}
            badge={`Grade ${result.durabilityGrade} • Throttle ${result.throttleDropPct.toFixed(1)}%`}
            monochrome={result.status !== "pass"}
          />

          <TechnicalDetailsDrawer
            title="Technical Details — Threshold Audit & Shop History"
            subtitle={`Throttle ${result.throttleDropPct.toFixed(1)}% • Latency ${result.memoryLatencyNs.toFixed(1)} ns`}
          >
          <ThresholdAuditTable
            rows={auditRows}
            plainSummary="Verifies thermal safety, sustained cooling headroom, DRAM responsiveness, and factory parity."
          />

          {/* Shop Model History Comparison Strip */}
          {result.shopComparison && (
            <div className="rounded-lg border border-zinc-300 bg-[#F8FAFC] px-4 py-3 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-black flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-blue-600" />
                  Shop Model History Calibration ({manufacturer ?? specs?.manufacturer ?? "Laptop"} {model ?? specs?.model ?? ""})
                </div>
                <div className="text-xs text-zinc-700">
                  {result.shopComparison.found ? (
                    <>
                      Compared against <strong className="font-mono text-black">{result.shopComparison.unitsTested}</strong> unit(s) in your shop — Shop Avg:{" "}
                      <strong className="font-mono text-blue-700">
                        {result.shopComparison.shopAvgComposite?.toFixed(0) ?? "—"}
                      </strong>
                      {result.shopComparison.percentVsShop != null && (
                        <>
                          {" "}
                          (<strong className="font-mono text-black">{result.shopComparison.percentVsShop.toFixed(0)}%</strong> of shop average)
                        </>
                      )}
                    </>
                  ) : (
                    "First benchmark saved for this exact laptop model — future units will compare automatically."
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleExportHistory}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-300 bg-white hover:border-black font-mono text-[10px] font-bold uppercase text-black flex items-center gap-1 cursor-pointer"
                >
                  <Download className="w-3 h-3 text-blue-600" /> Export DB
                </button>
                <button
                  onClick={handleImportHistory}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-300 bg-white hover:border-black font-mono text-[10px] font-bold uppercase text-black flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3 h-3 text-blue-600" /> Import DB
                </button>
              </div>
            </div>
          )}
          </TechnicalDetailsDrawer>

          {/* 14-Subtest Architectural Bar Ledger */}
          <div className="rounded-lg border border-zinc-300 bg-white p-4 space-y-2">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500 pb-1 border-b border-zinc-200">
              14-Category Subtest Breakdown
            </div>
            {subtests.map((s) => (
              <div key={s.label} className="grid grid-cols-12 items-center gap-3 text-xs">
                <div className="col-span-5 font-medium text-black truncate">{s.label}</div>
                <div className="col-span-5 h-2 bg-zinc-100 overflow-hidden">
                  <div
                    className="h-full bg-blue-600"
                    style={{ width: `${Math.max(3, Math.round((s.val / maxSub) * 100))}%` }}
                  />
                </div>
                <div className="col-span-2 text-right font-mono tabular-nums font-bold text-black">
                  {s.val.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Engine 3: Cinebench-Class Live Tile Monte-Carlo PBR Path-Tracer (v3.5.0) */}
      <CinePathtracerPanel
        result={cinePathtracerResult}
        disabled={running}
        onComplete={(res) => onCinePathtracerComplete?.(res)}
        onRunningChange={onRunningChange}
      />

      <EngineeringConsole lines={consoleLog} />

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean((result || cinePathtracerResult) && !running)}
        requirementHint={`Run the 14-Stage All-Scope Performance Audit to unlock Stage ${nextStageNum} (or click Skip Step).`}
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
