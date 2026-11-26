import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  BatteryCharging,
  Cpu,
  Flame,
  HardDrive,
  Play,
  ShieldAlert,
  Square,
  Thermometer,
  Zap,
} from "lucide-react";
import {
  GPU_THERMAL_CUTOFF_DEFAULT_C,
  GPU_THERMAL_CUTOFF_MAX_C,
  GPU_THERMAL_CUTOFF_MIN_C,
  type GpuAdapterInfo,
  type GpuStressProgress,
  type GpuStressResult,
  type LiveTelemetrySnapshot,
  type PowerTortureProgress,
  type PowerTortureResult,
  type SystemSpecs,
  type TestStatus,
  type UserBenchmarkComparison,
  type UserBenchmarkInput,
  type VramTestProgress,
  type VramTestResult,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";
import { EnvironmentGuard } from "../components/EnvironmentGuard";
import { EngineeringConsole, ThresholdAuditTable, type ThresholdAuditRow } from "../components/EngineeringConsole";

interface GpuStressViewProps {
  telemetry: LiveTelemetrySnapshot | null;
  specs?: SystemSpecs | null;
  isGamingCapable: boolean;
  result: GpuStressResult | null;
  vramResult: VramTestResult | null;
  tortureResult: PowerTortureResult | null;
  userbenchmarkComparison?: UserBenchmarkComparison | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onUserbenchmarkUpdate?: (comp: UserBenchmarkComparison) => void;
  onComplete: (res: GpuStressResult) => void;
  onVramComplete: (res: VramTestResult) => void;
  onTortureComplete: (res: PowerTortureResult) => void;
  onMarkNA: () => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

type GpuTab = "furmark" | "vram" | "torture";

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function clampGpuCutoff(val: number): number {
  if (!Number.isFinite(val)) return GPU_THERMAL_CUTOFF_DEFAULT_C;
  return Math.max(GPU_THERMAL_CUTOFF_MIN_C, Math.min(GPU_THERMAL_CUTOFF_MAX_C, Math.round(val)));
}

export const GpuStressView: React.FC<GpuStressViewProps> = ({
  telemetry,
  specs,
  isGamingCapable,
  result,
  vramResult,
  tortureResult,
  userbenchmarkComparison,
  status,
  stepNumber,
  totalSteps,
  onUserbenchmarkUpdate,
  onComplete,
  onVramComplete,
  onTortureComplete,
  onMarkNA,
  onRunningChange,
  onNext,
  onSkip,
}) => {
  const [tab, setTab] = useState<GpuTab>("furmark");
  const [adapters, setAdapters] = useState<GpuAdapterInfo[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState<number>(0);

  const [preset, setPreset] = useState<"quick" | "standard" | "burnin" | "extended">("quick");
  const [resolution, setResolution] = useState<"720p" | "1080p" | "1440p" | "4k">("720p");
  const [extremeMode, setExtremeMode] = useState(false);
  const [cutoffC, setCutoffC] = useState<number>(GPU_THERMAL_CUTOFF_DEFAULT_C);
  const [cutoffInput, setCutoffInput] = useState<string>(String(GPU_THERMAL_CUTOFF_DEFAULT_C));
  const [localUbComparison, setLocalUbComparison] = useState<UserBenchmarkComparison | null>(null);
  const [runningMode, setRunningMode] = useState<GpuTab | null>(null);
  const [progress, setProgress] = useState<GpuStressProgress | null>(null);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);

  const [vramMb, setVramMb] = useState<number>(isGamingCapable ? 1024 : 384);
  const [vramDur, setVramDur] = useState<number>(60);
  const [vramProg, setVramProg] = useState<VramTestProgress | null>(null);
  const [vramBwHistory, setVramBwHistory] = useState<number[]>([]);

  const [tortureDur, setTortureDur] = useState<number>(120);
  const [tortureProg, setTortureProg] = useState<PowerTortureProgress | null>(null);
  const [tortureFpsHistory, setTortureFpsHistory] = useState<number[]>([]);

  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<GpuAdapterInfo[]>("list_gpu_adapters")
      .then((list) => {
        setAdapters(list);
        const discrete = list.find((a) => a.isDiscrete);
        if (discrete) {
          setSelectedAdapter(discrete.index);
          setVramMb(1024);
        }
      })
      .catch((e) => setError(String(e)));

    const unlisteners: Array<() => void> = [];
    listen<GpuStressProgress>("gpu:progress", (ev) => {
      setProgress(ev.payload);
      setFpsHistory((prev) => [...prev.slice(-79), ev.payload.fps]);
      if (ev.payload.gpuTempC != null) {
        setTempHistory((prev) => [...prev.slice(-79), ev.payload.gpuTempC as number]);
      }
    }).then((fn) => unlisteners.push(fn));

    listen<VramTestProgress>("vram:progress", (ev) => {
      const p = ev.payload;
      setVramProg(p);
      setVramBwHistory((prev) => [...prev.slice(-79), p.bandwidthGbS]);
      setConsoleLog((prev) => [
        ...prev.slice(-80),
        `[${fmtTime(p.elapsedSecs)}] VRAM Pass #${p.passNumber} (${p.patternName}) | ${p.bandwidthGbS.toFixed(1)} GB/s | Total=${p.totalGbVerified.toFixed(1)} GB | Errors=${p.errorsFound}`,
      ]);
    }).then((fn) => unlisteners.push(fn));

    listen<PowerTortureProgress>("torture:progress", (ev) => {
      setTortureProg(ev.payload);
      setTortureFpsHistory((prev) => [...prev.slice(-79), ev.payload.gpuFps]);
    }).then((fn) => unlisteners.push(fn));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const running = runningMode !== null;
  const activeAdapter = adapters.find((a) => a.index === selectedAdapter);
  const effectiveUb = userbenchmarkComparison ?? localUbComparison;
  const gpuUbRating = effectiveUb?.gpu ?? result?.userbenchmarkRating ?? null;

  const syncAndClampCutoff = (): number => {
    const safe = clampGpuCutoff(cutoffInput.trim() === "" ? cutoffC : Number(cutoffInput));
    setCutoffC(safe);
    setCutoffInput(String(safe));
    return safe;
  };

  const startFurmark = async () => {
    setError(null);
    setRunningMode("furmark");
    onRunningChange(true);
    setProgress(null);
    setFpsHistory([]);
    setTempHistory([]);
    const safeCutoff = syncAndClampCutoff();
    setConsoleLog((prev) => [
      ...prev.slice(-40),
      `[00:00] FurMark-2 wgpu Burn-In started on ${activeAdapter?.name ?? "GPU"} @ ${resolution} (cutoff=${safeCutoff}°C, extreme=${extremeMode})`,
    ]);
    try {
      const res = await invoke<GpuStressResult>("run_gpu_stress", {
        adapterIndex: selectedAdapter,
        preset,
        resolution,
        extremeMode,
        thermalCutoffC: safeCutoff,
      });
      setConsoleLog((prev) => [
        ...prev,
        `[${fmtTime(res.elapsedSecs)}] FurMark DONE: Avg=${res.avgFps.toFixed(1)} FPS | 1%Low=${res.low1pctFps.toFixed(1)} | Drop=${res.fpsDropPct.toFixed(1)}% | Artifacts=${res.artifactErrors ?? 0} | Throttle=${res.throttleReason ?? "None"} | Cutoff=${res.thermalCutoffTriggered}`,
      ]);
      try {
        const ubInput: UserBenchmarkInput = {
          gpuName: res.adapterName,
          gpuResolution: res.resolution,
          gpuAvgFps: res.avgFps,
          gpuFpsDropPct: res.fpsDropPct,
          gpuThermalCutoff: res.thermalCutoffTriggered,
          specs: specs ?? null,
          gpu: res,
        };
        const cmp = await invoke<UserBenchmarkComparison>("compare_userbenchmark", {
          input: ubInput,
        });
        if (cmp && typeof cmp === "object") {
          setLocalUbComparison(cmp);
          onUserbenchmarkUpdate?.(cmp);
        }
      } catch {
        // Non-blocking fallback
      }
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningMode(null);
      onRunningChange(false);
    }
  };

  const startVram = async () => {
    setError(null);
    setRunningMode("vram");
    onRunningChange(true);
    setVramProg(null);
    setVramBwHistory([]);
    const safeCutoff = syncAndClampCutoff();
    setConsoleLog((prev) => [
      ...prev.slice(-40),
      `[00:00] Dedicated VRAM Compute Sweep started (${vramMb} MB pool, ${vramDur}s, cutoff=${safeCutoff}°C on ${activeAdapter?.name ?? "GPU"})`,
    ]);
    try {
      const res = await invoke<VramTestResult>("run_vram_test", {
        adapterIndex: selectedAdapter,
        targetVramMb: vramMb,
        durationSecs: vramDur,
        thermalCutoffC: safeCutoff,
      });
      setConsoleLog((prev) => [
        ...prev,
        `[${fmtTime(res.elapsedSecs)}] VRAM DONE: ${res.totalGbVerified.toFixed(1)} GB verified in ${res.passesCompleted} passes | AvgBW=${res.avgBandwidthGbS.toFixed(1)} GB/s | Bit Errors=${res.errorsFound} | Cutoff=${res.thermalCutoffTriggered ?? false}`,
      ]);
      onVramComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningMode(null);
      onRunningChange(false);
    }
  };

  const startTorture = async () => {
    setError(null);
    setRunningMode("torture");
    onRunningChange(true);
    setTortureProg(null);
    setTortureFpsHistory([]);
    const safeCutoff = syncAndClampCutoff();
    setConsoleLog((prev) => [
      ...prev.slice(-40),
      `[00:00] Combined CPU+GPU+RAM Power & Charger Torture started (${tortureDur}s, cutoff=${safeCutoff}°C)`,
    ]);
    try {
      const res = await invoke<PowerTortureResult>("run_power_torture", {
        adapterIndex: selectedAdapter,
        durationSecs: tortureDur,
        thermalCutoffC: safeCutoff,
      });
      setConsoleLog((prev) => [
        ...prev,
        `[${fmtTime(res.elapsedSecs)}] TORTURE DONE: Grade=${res.durabilityGrade} | FPS Drop=${res.fpsDropPct.toFixed(1)}% | Artifacts=${res.artifactErrors ?? 0} | Throttle=${res.throttleReason ?? "None"} | BatDelta=${res.batteryDeltaPct ?? 0}% | DrainOnAC=${res.batteryDrainWhilePlugged}`,
      ]);
      onTortureComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningMode(null);
      onRunningChange(false);
    }
  };

  const pctFur = progress
    ? Math.min(100, Math.round((progress.elapsedSecs / Math.max(progress.durationSecs, 1)) * 100))
    : 0;
  const hasAnyResult = Boolean(result || vramResult || tortureResult);

  const furmarkThrottleLabel = result
    ? result.throttleReason ||
      (result.thermalCutoffTriggered
        ? "Thermal Cutoff"
        : result.thermalThrottlingDetected
        ? "Thermal Throttling"
        : result.powerLimitThrottling
        ? "Power-Limit Throttling"
        : "None (Steady)")
    : null;

  const tortureThrottleLabel = tortureResult
    ? tortureResult.throttleReason ||
      (tortureResult.thermalCutoffTriggered
        ? "Thermal Cutoff"
        : tortureResult.thermalThrottlingDetected
        ? "Thermal Throttling"
        : tortureResult.powerLimitThrottling
        ? "Power-Limit Throttling"
        : "None (Steady)")
    : null;

  const activeAuditRows: ThresholdAuditRow[] =
    tab === "furmark" && result
      ? [
          {
            parameter: "Thermal Safety Cutoff",
            measured: result.thermalCutoffTriggered
              ? `TRIGGERED (${result.peakTempC != null ? `${result.peakTempC.toFixed(0)}°C` : `>= ${result.effectiveCutoffC ?? cutoffC}°C`})`
              : result.peakTempC != null
              ? `Within Limit (${result.peakTempC.toFixed(0)}°C peak)`
              : "Sensor unavailable (Bounded Safe Run)",
            limit: `< ${result.effectiveCutoffC ?? cutoffC}°C continuous (<= ${GPU_THERMAL_CUTOFF_MAX_C}°C max)`,
            verdict: result.thermalCutoffTriggered ? "FAIL" : "PASS",
            meaning: "Automatically aborts the render test before GPU silicon approaches damaging temperatures.",
          },
          {
            parameter: "FurMark-2 Artifact & Shader Integrity Scan",
            measured: `${result.artifactErrors ?? 0} artifact(s) detected`,
            limit: "0 compute/render artifacts",
            verdict: (result.artifactErrors ?? 0) === 0 ? "PASS" : "FAIL",
            meaning: "Catches GPU core instability, shader corruption, or dying BGA solder joints.",
          },
          {
            parameter: "Thermal vs Power-Limit Throttling Diagnosis",
            measured: `${furmarkThrottleLabel} (-${result.fpsDropPct.toFixed(1)}% FPS)`,
            limit: "<= 15.0% drop, no thermal throttling",
            verdict:
              result.thermalThrottlingDetected || result.fpsDropPct > 20
                ? "FAIL"
                : result.powerLimitThrottling || result.fpsDropPct > 15
                ? "WARN"
                : "PASS",
            meaning: "Distinguishes cooling failure (thermal throttle) from normal chassis wattage limits.",
          },
          {
            parameter: "Frame Pacing (1% Low / Avg)",
            measured: `${result.low1pctFps.toFixed(1)} / ${result.avgFps.toFixed(1)} FPS`,
            limit: "Smooth sustained frame delivery",
            verdict: result.low1pctFps >= result.avgFps * 0.65 ? "PASS" : "WARN",
            meaning: "Measures micro-stutter and frame consistency under sustained 3D load.",
          },
        ]
      : tab === "vram" && vramResult
      ? [
          {
            parameter: "GPU VRAM Bit-Flip Errors",
            measured: `${vramResult.errorsFound} errors (${vramResult.totalGbVerified.toFixed(1)} GB swept)`,
            limit: "0 errors required",
            verdict: vramResult.errorsFound === 0 ? "PASS" : "FAIL",
            meaning: "Verifies every swept GDDR/unified memory address stores and returns exact test patterns.",
          },
          {
            parameter: "VRAM Thermal Cutoff Guard",
            measured: vramResult.thermalCutoffTriggered
              ? `TRIGGERED (${vramResult.peakTempC != null ? `${vramResult.peakTempC.toFixed(0)}°C` : "cutoff"})`
              : vramResult.peakTempC != null
              ? `${vramResult.peakTempC.toFixed(0)}°C peak`
              : "Sensor unavailable (Bounded Safe Run)",
            limit: `<= ${vramResult.effectiveCutoffC ?? cutoffC}°C`,
            verdict: vramResult.thermalCutoffTriggered ? "FAIL" : "PASS",
            meaning: "Halts heavy VRAM compute passes immediately if GPU junction temperature hits cutoff.",
          },
          {
            parameter: "Effective VRAM Compute Bandwidth",
            measured: `${vramResult.avgBandwidthGbS.toFixed(1)} GB/s (${vramResult.allocatedVramMb} MB pool)`,
            limit: vramResult.baseline.expectedNormal,
            verdict: vramResult.baseline.percentOfNormal >= 75 ? "PASS" : "WARN",
            meaning: "Checks sustained memory controller throughput across the allocated VRAM pool.",
          },
        ]
      : tab === "torture" && tortureResult
      ? [
          {
            parameter: "AC Adapter Headroom (Drain Check)",
            measured: tortureResult.batteryDrainWhilePlugged
              ? `DRAINING ON AC (${(tortureResult.batteryDeltaPct ?? 0).toFixed(1)}%)`
              : `STABLE (${tortureResult.batteryDeltaPct != null ? `${tortureResult.batteryDeltaPct >= 0 ? "+" : ""}${tortureResult.batteryDeltaPct.toFixed(1)}%` : "AC OK"})`,
            limit: "0% drain while plugged into AC",
            verdict: tortureResult.batteryDrainWhilePlugged ? "WARN" : "PASS",
            meaning: "Ensures the included AC brick can power CPU + GPU + RAM simultaneously without draining the battery.",
          },
          {
            parameter: "Combined Chassis Thermal Cutoff",
            measured: tortureResult.thermalCutoffTriggered ? "CUTOFF TRIGGERED" : "Stable",
            limit: `< ${tortureResult.effectiveGpuCutoffC ?? cutoffC}°C GPU / <= ${tortureResult.effectiveCpuCutoffC ?? 95}°C CPU`,
            verdict: tortureResult.thermalCutoffTriggered ? "FAIL" : "PASS",
            meaning: "Protects shared heatpipes and VRMs when CPU and GPU run at 100% simultaneously.",
          },
          {
            parameter: "Combined Render/Compute Artifacts",
            measured: `${tortureResult.artifactErrors ?? 0} artifact(s)`,
            limit: "0 artifacts",
            verdict: (tortureResult.artifactErrors ?? 0) === 0 ? "PASS" : "FAIL",
            meaning: "Verifies shader output stays bit-accurate even under maximum chassis VRM load.",
          },
          {
            parameter: "Combined Load Throttle & FPS Drop",
            measured: `${tortureThrottleLabel} (-${tortureResult.fpsDropPct.toFixed(1)}%)`,
            limit: "<= 20.0% under simultaneous load",
            verdict: tortureResult.thermalThrottlingDetected || tortureResult.fpsDropPct > 20 ? "WARN" : "PASS",
            meaning: "Reveals whether CPU+GPU shared cooling causes severe clock drops.",
          },
        ]
      : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-300">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-[2px] bg-black text-white font-mono text-[10px] font-bold">
              STAGE {String(stepNumber).padStart(2, "0")}
            </span>
            <h1 className="text-lg font-black text-black tracking-tight">
              GPU Burn-In, Dedicated VRAM Integrity &amp; Combined Power Torture
            </h1>
            <StatusBadge status={status} />
            {isGamingCapable && (
              <span className="px-1.5 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-[9.5px] font-bold">
                dGPU
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded-[2px] border border-zinc-300 bg-[#F8FAFC] text-zinc-700 font-mono text-[10px] font-bold">
              GPU CUTOFF &le; {GPU_THERMAL_CUTOFF_MAX_C}°C
            </span>
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">
            Native wgpu DX12 / Vulkan / Metal diagnostic bench: FurMark-2 Artifact Scan &amp; Throttle Diagnosis, Dedicated VRAM Integrity, Combined CPU+GPU+RAM Charger Torture, and UserBenchmark GPU Calibration.
          </p>
        </div>
        {!isGamingCapable && !running && (
          <button
            onClick={onMarkNA}
            className="px-3 py-1.5 rounded-[2px] border border-black bg-white hover:bg-zinc-100 font-mono text-[11px] font-bold uppercase text-black cursor-pointer"
          >
            Mark N/A (Office iGPU)
          </button>
        )}
      </div>

      <EnvironmentGuard telemetry={telemetry} requireAc={true} />

      {/* 3-Tab Architectural Mode Switcher */}
      <div className="grid grid-cols-1 md:grid-cols-3 border border-zinc-300 divide-y md:divide-y-0 md:divide-x divide-zinc-300 rounded-[2px] overflow-hidden">
        <button
          disabled={running}
          onClick={() => setTab("furmark")}
          className={`p-3 text-left transition cursor-pointer border-b-2 ${
            tab === "furmark"
              ? "bg-white border-b-blue-600 text-black"
              : "bg-[#F8FAFC] border-b-transparent text-zinc-600 hover:bg-white"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold uppercase flex items-center gap-1.5 text-black">
              <Flame className="w-3.5 h-3.5 text-blue-600" /> 01. 3D Shader Burn-In
            </span>
            {result && <StatusBadge status={result.status} compact />}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">FurMark-2 wgpu • Artifacts &amp; Throttle</div>
        </button>

        <button
          disabled={running}
          onClick={() => setTab("vram")}
          className={`p-3 text-left transition cursor-pointer border-b-2 ${
            tab === "vram"
              ? "bg-white border-b-blue-600 text-black"
              : "bg-[#F8FAFC] border-b-transparent text-zinc-600 hover:bg-white"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold uppercase flex items-center gap-1.5 text-black">
              <HardDrive className="w-3.5 h-3.5 text-blue-600" /> 02. VRAM Integrity
            </span>
            {vramResult && <StatusBadge status={vramResult.status} compact />}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">wgpu compute • 0-error GDDR verification</div>
        </button>

        <button
          disabled={running}
          onClick={() => setTab("torture")}
          className={`p-3 text-left transition cursor-pointer border-b-2 ${
            tab === "torture"
              ? "bg-white border-b-blue-600 text-black"
              : "bg-[#F8FAFC] border-b-transparent text-zinc-600 hover:bg-white"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold uppercase flex items-center gap-1.5 text-black">
              <Zap className="w-3.5 h-3.5 text-blue-600" /> 03. Power &amp; AC Torture
            </span>
            {tortureResult && <StatusBadge status={tortureResult.status} compact />}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">100% CPU+GPU+RAM • AC Charger Drain check</div>
        </button>
      </div>

      {/* Shared GPU Adapter & Safety Cutoff Bar */}
      <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-[260px]">
          <label className="font-mono text-[10.5px] font-bold uppercase text-zinc-600 shrink-0">Adapter:</label>
          <select
            value={selectedAdapter}
            disabled={running}
            onChange={(e) => setSelectedAdapter(Number(e.target.value))}
            className="flex-1 bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
          >
            {adapters.map((a) => (
              <option key={a.index} value={a.index}>
                {a.name} ({a.deviceType} • {a.backend})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2.5 font-mono text-xs">
          <span className="text-[10.5px] font-bold uppercase text-zinc-600">
            Cutoff ({GPU_THERMAL_CUTOFF_MIN_C}–{GPU_THERMAL_CUTOFF_MAX_C}°C):
          </span>
          <input
            type="range"
            min={GPU_THERMAL_CUTOFF_MIN_C}
            max={GPU_THERMAL_CUTOFF_MAX_C}
            disabled={running}
            value={cutoffC}
            onChange={(e) => {
              const clamped = clampGpuCutoff(Number(e.target.value));
              setCutoffC(clamped);
              setCutoffInput(String(clamped));
            }}
            aria-label="GPU Thermal Cutoff Slider"
            className="w-24 accent-blue-600 cursor-pointer"
          />
          <input
            type="number"
            min={GPU_THERMAL_CUTOFF_MIN_C}
            max={GPU_THERMAL_CUTOFF_MAX_C}
            disabled={running}
            value={cutoffInput}
            onChange={(e) => {
              const raw = e.target.value;
              setCutoffInput(raw);
              if (raw.trim() !== "") {
                const n = Number(raw);
                if (
                  Number.isFinite(n) &&
                  n >= GPU_THERMAL_CUTOFF_MIN_C &&
                  n <= GPU_THERMAL_CUTOFF_MAX_C
                ) {
                  setCutoffC(Math.round(n));
                }
              }
            }}
            onBlur={() => {
              const clamped = clampGpuCutoff(
                cutoffInput.trim() === "" ? cutoffC : Number(cutoffInput)
              );
              setCutoffC(clamped);
              setCutoffInput(String(clamped));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const clamped = clampGpuCutoff(
                  cutoffInput.trim() === "" ? cutoffC : Number(cutoffInput)
                );
                setCutoffC(clamped);
                setCutoffInput(String(clamped));
              }
            }}
            aria-label="GPU Thermal Cutoff °C"
            className="w-16 bg-white border border-zinc-300 rounded-[2px] px-2 py-1 text-xs font-bold text-blue-700"
          />
          <span className="font-bold text-black">°C</span>
        </div>
      </div>

      {error && <div className="rounded-[2px] bg-black text-white px-3.5 py-2 font-mono text-xs">{error}</div>}

      {/* ===================== TAB 1: FURMARK 3D SHADER ===================== */}
      {tab === "furmark" && (
        <div className="space-y-4">
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">Resolution</label>
                <select
                  value={resolution}
                  disabled={running}
                  onChange={(e) => setResolution(e.target.value as "720p" | "1080p" | "1440p" | "4k")}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value="720p">1280×720 (Balanced)</option>
                  <option value="1080p">1920×1080 (FHD Heavy)</option>
                  <option value="1440p">2560×1440 (QHD Extreme)</option>
                  <option value="4k">3840×2160 (4K Ultra)</option>
                </select>
              </div>
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">Duration</label>
                <select
                  value={preset}
                  disabled={running}
                  onChange={(e) => setPreset(e.target.value as "quick" | "standard" | "burnin" | "extended")}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value="quick">Shop QC (2 minutes)</option>
                  <option value="standard">Durability (5 minutes)</option>
                  <option value="burnin">Gaming Burn-In (15 minutes)</option>
                  <option value="extended">Extended Stress (30 minutes)</option>
                </select>
              </div>
              <div>
                {runningMode === "furmark" ? (
                  <button
                    onClick={() => invoke("cancel_gpu_stress").catch(() => {})}
                    className="w-full py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Abort Stress
                  </button>
                ) : (
                  <button
                    disabled={running}
                    onClick={startFurmark}
                    className="w-full py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Start GPU Burn-In
                  </button>
                )}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-black cursor-pointer">
              <input
                type="checkbox"
                disabled={running}
                checked={extremeMode}
                onChange={(e) => setExtremeMode(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
              Extreme Burn-In Shader Mode (128-Step Raymarch — Maximum Thermal &amp; Power Load)
            </label>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-[2px] border border-zinc-300 bg-black overflow-hidden relative aspect-video flex items-center justify-center">
              {progress?.previewDataUrl ? (
                <img src={progress.previewDataUrl} alt="Live wgpu Stress Render" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center space-y-1.5 p-6 font-mono">
                  <Flame className="w-8 h-8 text-blue-500 mx-auto" />
                  <div className="text-xs font-bold text-white uppercase">Native wgpu 3D Shader Viewport</div>
                  <div className="text-[11px] text-zinc-400 max-w-md">
                    Executes uncapped raymarched frames with FurMark-2 compute/frame artifact scanning on DX12 / Vulkan / Metal.
                  </div>
                </div>
              )}
              {runningMode === "furmark" && progress && (
                <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between text-[11px] font-mono tabular-nums gap-2 flex-wrap">
                  <span className="px-2 py-1 rounded-[2px] bg-black/85 border border-white/20 text-blue-400 font-bold">
                    {progress.fps.toFixed(1)} FPS • 1% LOW {progress.low1pctFps.toFixed(1)} • {progress.frameTimeMs.toFixed(1)}ms
                  </span>
                  <span className="px-2 py-1 rounded-[2px] bg-black/85 border border-white/20 text-white font-bold">
                    ART: {progress.artifactErrors ?? 0} • {progress.throttleState ?? "Steady"} • {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({pctFur}%)
                  </span>
                </div>
              )}
              {progress?.thermalWarning && (
                <div className="absolute bottom-2.5 left-2.5 right-2.5 rounded-[2px] bg-blue-600 text-white px-3 py-1.5 font-mono text-xs font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  HIGH GPU TEMPERATURE APPROACHING CUTOFF ({cutoffC}°C)
                </div>
              )}
            </div>

            <div className="rounded-[2px] border border-zinc-300 bg-white divide-y divide-zinc-200 flex flex-col justify-between font-mono tabular-nums text-xs">
              <div className="px-3.5 py-2 bg-[#F8FAFC] text-[10px] font-bold uppercase tracking-wider text-zinc-600">
                Live GPU &amp; FurMark-2 Telemetry
              </div>
              <div className="p-3.5">
                <div className="text-[9.5px] uppercase text-zinc-500">Avg / 1% Low / Min FPS</div>
                <div className="text-lg font-black text-blue-700 mt-0.5">
                  {(progress?.avgFps ?? result?.avgFps ?? 0).toFixed(1)}{" "}
                  <span className="text-xs text-black">
                    / {(progress?.low1pctFps ?? result?.low1pctFps ?? 0).toFixed(1)} / {(progress?.minFps ?? result?.minFps ?? 0).toFixed(1)}
                  </span>
                </div>
              </div>
              <div className="p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-[9.5px] uppercase text-zinc-500">GPU Temperature / Cutoff</div>
                  <div className="text-lg font-black text-black mt-0.5">
                    {(progress?.gpuTempC ?? result?.peakTempC) != null
                      ? `${(progress?.gpuTempC ?? result?.peakTempC)?.toFixed(0)}°C`
                      : progress?.gpuTempAvailable === false || result?.sensorAvailable === false
                      ? "Sensor unavailable"
                      : "N/A"}
                    <span className="text-[11px] font-normal text-zinc-500 ml-1.5">
                      / {result?.effectiveCutoffC ?? cutoffC}°C
                    </span>
                  </div>
                </div>
                <Thermometer className="w-4 h-4 text-blue-600" />
              </div>
              <div className="p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-[9.5px] uppercase text-zinc-500">Power / Throttle / Artifacts</div>
                  <div className="text-xs font-black text-black mt-0.5">
                    {(progress?.gpuPowerW ?? result?.avgPowerW ?? result?.peakPowerW) != null
                      ? `${(progress?.gpuPowerW ?? result?.avgPowerW ?? result?.peakPowerW)?.toFixed(1)} W`
                      : "N/A"}
                    {result ? ` • -${result.fpsDropPct.toFixed(1)}%` : ""}
                    {` • ${(progress?.artifactErrors ?? result?.artifactErrors ?? 0)} art`}
                  </div>
                  {(progress?.throttleState || furmarkThrottleLabel) && (
                    <div className="text-[10px] text-blue-700 font-bold mt-0.5">
                      Throttle: {progress?.throttleState ?? furmarkThrottleLabel}
                    </div>
                  )}
                </div>
                <Zap className="w-4 h-4 text-blue-600" />
              </div>
              <div className="px-3.5 py-2 bg-[#F8FAFC] text-[10.5px] text-zinc-600 flex items-center justify-between">
                <span>
                  FRAMES: <strong className="text-black">{(progress?.framesRendered ?? result?.framesRendered ?? 0).toLocaleString()}</strong>
                </span>
                {result?.avgLoadPct != null && (
                  <span>
                    LOAD: <strong className="text-black">{result.avgLoadPct.toFixed(0)}%</strong>
                  </span>
                )}
              </div>
            </div>
          </div>

          {result?.sensorAvailable === false && runningMode !== "furmark" && (
            <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2 text-xs text-black flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-blue-600 shrink-0" />
              <span>
                <strong>GPU Thermal Sensor Unavailable:</strong> Bounded safe duration was enforced automatically to prevent unmonitored overheating.
              </span>
            </div>
          )}

          {fpsHistory.length > 0 && (
            <div className={`grid grid-cols-1 ${tempHistory.length > 0 ? "md:grid-cols-2" : ""} gap-3`}>
              <LiveChart
                title="GPU Frame Rate Oscilloscope"
                unit="FPS"
                data={fpsHistory}
                plainHint="Flat trace indicates consistent cooling and stable GPU clocks."
              />
              {tempHistory.length > 0 && (
                <LiveChart
                  title="GPU Thermal Curve"
                  unit="°C"
                  data={tempHistory}
                  maxSuggested={100}
                  baselineValue={cutoffC}
                  baselineLabel={`CUTOFF ${cutoffC}°C`}
                  higherIsBetter={false}
                  plainHint="Test aborts automatically if GPU temp reaches the safety cutoff."
                />
              )}
            </div>
          )}

          {result && runningMode !== "furmark" && (
            <BaselineCard
              baseline={result.baseline}
              plainSummary={result.plainSummary}
              userbenchmarkRating={gpuUbRating}
              title="GPU 3D & THERMAL CALIBRATION"
            />
          )}
        </div>
      )}

      {/* ===================== TAB 2: DEDICATED VRAM INTEGRITY ===================== */}
      {tab === "vram" && (
        <div className="space-y-4">
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">VRAM Pool Size</label>
                <select
                  value={vramMb}
                  disabled={running}
                  onChange={(e) => setVramMb(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value={256}>256 MB (Integrated / Quick)</option>
                  <option value={512}>512 MB (Integrated / Entry dGPU)</option>
                  <option value={1024}>1,024 MB / 1 GB (Standard dGPU)</option>
                  <option value={2048}>2,048 MB / 2 GB (Gaming 4–6GB)</option>
                  <option value={4096}>4,096 MB / 4 GB (High-End 8GB+)</option>
                </select>
              </div>
              <div>
                <label className="block font-mono text-[10px] font-bold uppercase text-zinc-600 mb-1">Sweep Duration</label>
                <select
                  value={vramDur}
                  disabled={running}
                  onChange={(e) => setVramDur(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value={45}>Shop QC (45 seconds)</option>
                  <option value={90}>Standard Sweep (90 seconds)</option>
                  <option value={180}>Deep VRAM Burn (3 minutes)</option>
                  <option value={300}>Extended Audit (5 minutes)</option>
                </select>
              </div>
              <div>
                {runningMode === "vram" ? (
                  <button
                    onClick={() => invoke("cancel_vram_test").catch(() => {})}
                    className="w-full py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Abort VRAM
                  </button>
                ) : (
                  <button
                    disabled={running}
                    onClick={startVram}
                    className="w-full py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" /> Start VRAM Sweep
                  </button>
                )}
              </div>
            </div>

            {vramProg?.thermalWarning && (
              <div className="rounded-[2px] bg-black text-white px-3 py-2 font-mono text-xs font-bold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
                VRAM TEST APPROACHING GPU THERMAL CUTOFF ({cutoffC}°C)
              </div>
            )}

            {(runningMode === "vram" || vramProg || vramResult) && (
              <div className="space-y-3 pt-3 border-t border-zinc-200">
                {runningMode === "vram" && vramProg && (
                  <>
                    <div className="flex items-center justify-between text-xs font-mono tabular-nums flex-wrap gap-2">
                      <span className="text-blue-700 font-bold">
                        PASS #{vramProg.passNumber} — {vramProg.patternName}
                      </span>
                      <span className="text-black font-bold">
                        {vramProg.gpuTempC != null ? `${vramProg.gpuTempC.toFixed(0)}°C • ` : ""}
                        {fmtTime(vramProg.elapsedSecs)} / {fmtTime(vramProg.durationSecs)} ({vramProg.percent.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-1.5 bg-zinc-200 overflow-hidden">
                      <div className="h-full bg-blue-600 transition-all" style={{ width: `${vramProg.percent}%` }} />
                    </div>
                  </>
                )}

                <div className="grid grid-cols-2 md:grid-cols-5 border border-zinc-300 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums">
                  <div className={`p-3 ${(vramProg?.errorsFound ?? vramResult?.errorsFound ?? 0) > 0 ? "bg-black text-white" : "bg-blue-50/40 text-blue-900"}`}>
                    <div className="text-[9.5px] uppercase font-bold">VRAM Bit Errors</div>
                    <div className="text-xl font-black mt-0.5">{vramProg?.errorsFound ?? vramResult?.errorsFound ?? 0}</div>
                  </div>
                  <div className="p-3 bg-white">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Allocated Pool</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {vramProg?.allocatedVramMb ?? vramResult?.allocatedVramMb ?? vramMb} MB
                    </div>
                  </div>
                  <div className="p-3 bg-white">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Total Verified</div>
                    <div className="text-xl font-black text-blue-700 mt-0.5">
                      {(vramProg?.totalGbVerified ?? vramResult?.totalGbVerified ?? 0).toFixed(1)} GB
                    </div>
                  </div>
                  <div className="p-3 bg-white">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">Compute Sweep BW</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {(vramProg?.bandwidthGbS ?? vramResult?.avgBandwidthGbS ?? 0).toFixed(1)} GB/s
                    </div>
                  </div>
                  <div className="p-3 bg-white">
                    <div className="text-[9.5px] uppercase text-zinc-500 font-bold">GPU Temp / Cutoff</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {(vramProg?.gpuTempC ?? vramResult?.peakTempC) != null
                        ? `${(vramProg?.gpuTempC ?? vramResult?.peakTempC)?.toFixed(0)}°C`
                        : "Sensor N/A"}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Limit: {vramResult?.effectiveCutoffC ?? cutoffC}°C
                      {vramResult?.thermalCutoffTriggered ? " • CUTOFF" : ""}
                    </div>
                  </div>
                </div>

                {vramResult?.sensorAvailable === false && runningMode !== "vram" && (
                  <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3 py-2 text-xs text-black">
                    <strong>Sensor Unavailable:</strong> GPU thermal sensor was unavailable during VRAM verification; bounded safe duration was enforced.
                  </div>
                )}

                {vramBwHistory.length > 0 && (
                  <LiveChart title="VRAM Compute Bandwidth Oscilloscope" unit="GB/s" data={vramBwHistory} />
                )}
              </div>
            )}
          </div>

          {vramResult && runningMode !== "vram" && (
            <BaselineCard
              baseline={vramResult.baseline}
              plainSummary={vramResult.plainSummary}
              title="VRAM INTEGRITY CALIBRATION"
            />
          )}
        </div>
      )}

      {/* ===================== TAB 3: COMBINED CPU+GPU+RAM POWER TORTURE ===================== */}
      {tab === "torture" && (
        <div className="space-y-4">
          <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2.5">
                <label className="font-mono text-[10.5px] font-bold uppercase text-zinc-600">Duration:</label>
                <select
                  value={tortureDur}
                  disabled={running}
                  onChange={(e) => setTortureDur(Number(e.target.value))}
                  className="bg-white border border-zinc-300 rounded-[2px] px-2.5 py-1.5 font-mono text-xs text-black"
                >
                  <option value={60}>Quick Power Check (1 minute)</option>
                  <option value={120}>Shop QC Power &amp; Charger Torture (2 minutes)</option>
                  <option value={300}>Heavy VRM &amp; Shared Heatpipe (5 minutes)</option>
                  <option value={600}>Extended 10-Minute Chassis Torture</option>
                </select>
              </div>
              {runningMode === "torture" ? (
                <button
                  onClick={() => invoke("cancel_power_torture").catch(() => {})}
                  className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" /> Abort Torture
                </button>
              ) : (
                <button
                  disabled={running}
                  onClick={startTorture}
                  className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" /> Launch Combined Torture
                </button>
              )}
            </div>
            <div className="text-[11px] text-zinc-600">
              Ensure the AC charger is plugged in — pushes CPU (AVX2/NEON), GPU (wgpu), and RAM to simultaneous 100% load and detects battery discharge on AC, render artifacts, and thermal vs power throttling.
            </div>
          </div>

          {(tortureProg?.batteryDrainWhilePlugged || tortureResult?.batteryDrainWhilePlugged) && (
            <div className="rounded-[2px] border-2 border-black bg-black text-white p-4 flex items-center gap-3">
              <ShieldAlert className="w-5 h-5 text-blue-400 shrink-0" />
              <div className="text-xs">
                <div className="font-mono font-black uppercase tracking-wider text-blue-400">
                  ALERT: BATTERY DRAINING WHILE AC CHARGER PLUGGED IN
                </div>
                <p className="text-zinc-300 mt-0.5">
                  AC adapter cannot sustain simultaneous CPU+GPU wattage (delta{" "}
                  {(tortureProg?.batteryDeltaPct ?? tortureResult?.batteryDeltaPct ?? 0).toFixed(1)}%). Inspect adapter wattage rating or motherboard DC-in MOSFET.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-[2px] border border-zinc-300 bg-black overflow-hidden relative aspect-video flex items-center justify-center">
              {tortureProg?.previewDataUrl ? (
                <img src={tortureProg.previewDataUrl} alt="Combined Torture Render" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center space-y-1.5 p-6 font-mono">
                  <Zap className="w-8 h-8 text-blue-500 mx-auto" />
                  <div className="text-xs font-bold text-white uppercase">Simultaneous CPU + GPU + RAM Load</div>
                  <div className="text-[11px] text-zinc-400 max-w-md">
                    Validates shared heatpipes, VRM power stability, shader artifact freedom, and AC charger wattage headroom.
                  </div>
                </div>
              )}
              {runningMode === "torture" && tortureProg && (
                <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between text-[11px] font-mono tabular-nums gap-2 flex-wrap">
                  <span className="px-2 py-1 rounded-[2px] bg-black/85 border border-white/20 text-blue-400 font-bold">
                    CPU {tortureProg.telemetry.cpuUsagePct.toFixed(0)}% ({tortureProg.simdIsa}) • GPU {tortureProg.gpuFps.toFixed(1)} FPS
                  </span>
                  <span className="px-2 py-1 rounded-[2px] bg-black/85 border border-white/20 text-white font-bold">
                    ART: {tortureProg.artifactErrors ?? 0} • {tortureProg.throttleState ?? "Steady"} • {fmtTime(tortureProg.elapsedSecs)} / {fmtTime(tortureProg.durationSecs)}
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-[2px] border border-zinc-300 bg-white divide-y divide-zinc-200 flex flex-col justify-between font-mono tabular-nums text-xs">
              <div className="px-3.5 py-2 bg-[#F8FAFC] text-[10px] font-bold uppercase tracking-wider text-zinc-600">
                Full-Chassis Power Telemetry
              </div>
              <div className="p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-[9.5px] uppercase text-zinc-500">CPU Load / Power</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {tortureProg
                      ? `${tortureProg.telemetry.cpuUsagePct.toFixed(0)}% @ ${tortureProg.telemetry.cpuClockMhz}MHz`
                      : tortureResult?.peakCpuPowerW != null
                      ? `Peak CPU ${tortureResult.peakCpuPowerW.toFixed(1)} W`
                      : "READY"}
                  </div>
                </div>
                <Cpu className="w-4 h-4 text-blue-600" />
              </div>
              <div className="p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-[9.5px] uppercase text-zinc-500">AC / Battery Delta</div>
                  <div className="text-sm font-black text-blue-700 mt-0.5">
                    {tortureProg?.telemetry.acPlugged === true ? "AC ON" : tortureProg?.telemetry.acPlugged === false ? "BATTERY" : "—"}
                    {tortureProg?.telemetry.batteryPercent != null ? ` • ${tortureProg.telemetry.batteryPercent.toFixed(0)}%` : ""}
                    {tortureProg?.batteryDeltaPct != null ? ` (${tortureProg.batteryDeltaPct >= 0 ? "+" : ""}${tortureProg.batteryDeltaPct.toFixed(1)}%)` : ""}
                  </div>
                </div>
                <BatteryCharging className="w-4 h-4 text-blue-600" />
              </div>
              <div className="p-3.5 flex items-center justify-between">
                <div>
                  <div className="text-[9.5px] uppercase text-zinc-500">Peak CPU / GPU Temp &amp; Artifacts</div>
                  <div className="text-sm font-black text-black mt-0.5">
                    {(() => {
                      const cpuT =
                        runningMode === "torture" && tortureProg
                          ? tortureProg.telemetry.cpuTempAvailable !== false
                            ? tortureProg.telemetry.cpuTempC
                            : null
                          : tortureResult?.sensorAvailable === false
                          ? null
                          : tortureResult?.peakCpuTempC ??
                            (tortureProg?.telemetry.cpuTempAvailable !== false
                              ? tortureProg?.telemetry.cpuTempC
                              : null) ??
                            null;
                      const gpuT =
                        runningMode === "torture" && tortureProg
                          ? tortureProg.telemetry.gpuTempAvailable !== false
                            ? tortureProg.telemetry.gpuTempC
                            : null
                          : tortureResult?.sensorAvailable === false
                          ? null
                          : tortureResult?.peakGpuTempC ??
                            (tortureProg?.telemetry.gpuTempAvailable !== false
                              ? tortureProg?.telemetry.gpuTempC
                              : null) ??
                            null;
                      const art = tortureProg?.artifactErrors ?? tortureResult?.artifactErrors ?? 0;
                      if (cpuT == null && gpuT == null) {
                        return (
                          <>
                            {tortureProg || tortureResult || telemetry?.cpuTempAvailable === false || telemetry?.gpuTempAvailable === false
                              ? "Sensor unavailable"
                              : "N/A"}
                            {` • ${art} art`}
                          </>
                        );
                      }
                      return (
                        <>
                          {cpuT != null ? `${cpuT.toFixed(0)}°C` : "Sensor unavailable"} /{" "}
                          {gpuT != null ? `${gpuT.toFixed(0)}°C` : "Sensor unavailable"}
                          {` • ${art} art`}
                        </>
                      );
                    })()}
                  </div>
                  {(tortureProg?.throttleState || tortureThrottleLabel) && (
                    <div className="text-[10px] text-blue-700 font-bold mt-0.5">
                      {tortureProg?.throttleState ?? tortureThrottleLabel}
                    </div>
                  )}
                </div>
                <Thermometer className="w-4 h-4 text-blue-600" />
              </div>
              {tortureResult && (
                <div className="px-3.5 py-2.5 bg-black text-white flex items-center justify-between">
                  <span className="text-[9.5px] uppercase text-blue-400 font-bold">Durability Grade</span>
                  <span className="text-base font-black">{tortureResult.durabilityGrade}</span>
                </div>
              )}
            </div>
          </div>

          {tortureResult?.sensorAvailable === false && runningMode !== "torture" && (
            <div className="rounded-[2px] border border-zinc-300 bg-[#F8FAFC] px-3.5 py-2 text-xs text-black">
              <strong>Sensor Unavailable:</strong> Temperature telemetry was unavailable; bounded safe duration was enforced automatically.
            </div>
          )}

          {tortureFpsHistory.length > 0 && (
            <LiveChart title="Combined Load GPU FPS Oscilloscope" unit="FPS" data={tortureFpsHistory} />
          )}

          {tortureResult && runningMode !== "torture" && (
            <BaselineCard
              baseline={tortureResult.baseline}
              plainSummary={tortureResult.plainSummary}
              title="COMBINED POWER & CHASSIS CALIBRATION"
            />
          )}
        </div>
      )}

      <ThresholdAuditTable
        rows={activeAuditRows}
        plainSummary="Verifies GPU thermal cutoffs, shader/VRAM bit accuracy, throttling behavior, and AC adapter power delivery."
      />
      <EngineeringConsole lines={consoleLog} />

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(hasAnyResult && !running) || status === "notApplicable"}
        requirementHint="Run at least one GPU / VRAM / Power Torture audit or mark N/A for office laptops (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
