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
import type {
  GpuAdapterInfo,
  GpuStressProgress,
  GpuStressResult,
  PowerTortureProgress,
  PowerTortureResult,
  TestStatus,
  VramTestProgress,
  VramTestResult,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";

interface GpuStressViewProps {
  isGamingCapable: boolean;
  result: GpuStressResult | null;
  vramResult: VramTestResult | null;
  tortureResult: PowerTortureResult | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
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

export const GpuStressView: React.FC<GpuStressViewProps> = ({
  isGamingCapable,
  result,
  vramResult,
  tortureResult,
  status,
  stepNumber,
  totalSteps,
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

  // FurMark state
  const [preset, setPreset] = useState<"quick" | "standard" | "burnin" | "extended">("quick");
  const [resolution, setResolution] = useState<"720p" | "1080p" | "1440p" | "4k">("720p");
  const [extremeMode, setExtremeMode] = useState(false);
  const [cutoffC, setCutoffC] = useState(95);
  const [runningMode, setRunningMode] = useState<GpuTab | null>(null);
  const [progress, setProgress] = useState<GpuStressProgress | null>(null);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);

  // VRAM Integrity state
  const [vramMb, setVramMb] = useState<number>(isGamingCapable ? 1024 : 384);
  const [vramDur, setVramDur] = useState<number>(60);
  const [vramProg, setVramProg] = useState<VramTestProgress | null>(null);
  const [vramBwHistory, setVramBwHistory] = useState<number[]>([]);

  // Combined Power Torture state
  const [tortureDur, setTortureDur] = useState<number>(120);
  const [tortureProg, setTortureProg] = useState<PowerTortureProgress | null>(null);
  const [tortureFpsHistory, setTortureFpsHistory] = useState<number[]>([]);

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
      setVramProg(ev.payload);
      setVramBwHistory((prev) => [...prev.slice(-79), ev.payload.bandwidthGbS]);
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

  const startFurmark = async () => {
    setError(null);
    setRunningMode("furmark");
    onRunningChange(true);
    setProgress(null);
    setFpsHistory([]);
    setTempHistory([]);
    try {
      const res = await invoke<GpuStressResult>("run_gpu_stress", {
        adapterIndex: selectedAdapter,
        preset,
        resolution,
        extremeMode,
        thermalCutoffC: cutoffC,
      });
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
    try {
      const res = await invoke<VramTestResult>("run_vram_test", {
        adapterIndex: selectedAdapter,
        targetVramMb: vramMb,
        durationSecs: vramDur,
      });
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
    try {
      const res = await invoke<PowerTortureResult>("run_power_torture", {
        adapterIndex: selectedAdapter,
        durationSecs: tortureDur,
        thermalCutoffC: cutoffC,
      });
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              GPU Burn-In, VRAM Integrity &amp; Combined Power Torture (v2.0)
            </h1>
            <StatusBadge status={status} />
            {isGamingCapable && (
              <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] font-bold">
                dGPU DETECTED
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Three native wgpu stress engines: 3D FurMark Burn-In, Dedicated GPU VRAM Compute Integrity (0-error check), and Simultaneous CPU+GPU+RAM Power &amp; AC Charger Torture.
          </p>
        </div>
        {!isGamingCapable && !running && (
          <button
            onClick={onMarkNA}
            className="px-3.5 py-2 rounded-lg border border-black bg-white hover:bg-zinc-100 text-xs font-bold text-black cursor-pointer"
          >
            Mark N/A (Integrated Office GPU)
          </button>
        )}
      </div>

      {/* 3-Tab Mode Selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <button
          disabled={running}
          onClick={() => setTab("furmark")}
          className={`p-3 rounded-xl border text-left transition cursor-pointer ${
            tab === "furmark"
              ? "bg-black text-white border-black"
              : "bg-white text-black border-zinc-200 hover:border-blue-600"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black flex items-center gap-1.5">
              <Flame className={`w-4 h-4 ${tab === "furmark" ? "text-blue-400" : "text-blue-600"}`} />
              1. 3D Shader Burn-In
            </span>
            {result && <StatusBadge status={result.status} darkSurface={tab === "furmark"} />}
          </div>
          <div className={`text-[11px] mt-1 ${tab === "furmark" ? "text-zinc-300" : "text-zinc-600"}`}>
            FurMark 2 wgpu raymarch • FPS, 1% Low &amp; Throttle Drop
          </div>
        </button>

        <button
          disabled={running}
          onClick={() => setTab("vram")}
          className={`p-3 rounded-xl border text-left transition cursor-pointer ${
            tab === "vram"
              ? "bg-black text-white border-black"
              : "bg-white text-black border-zinc-200 hover:border-blue-600"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black flex items-center gap-1.5">
              <HardDrive className={`w-4 h-4 ${tab === "vram" ? "text-blue-400" : "text-blue-600"}`} />
              2. Dedicated VRAM Integrity
            </span>
            {vramResult && <StatusBadge status={vramResult.status} darkSurface={tab === "vram"} />}
          </div>
          <div className={`text-[11px] mt-1 ${tab === "vram" ? "text-zinc-300" : "text-zinc-600"}`}>
            OCCT-style wgpu compute • Catches bad GDDR chips &amp; artifacts
          </div>
        </button>

        <button
          disabled={running}
          onClick={() => setTab("torture")}
          className={`p-3 rounded-xl border text-left transition cursor-pointer ${
            tab === "torture"
              ? "bg-black text-white border-black"
              : "bg-white text-black border-zinc-200 hover:border-blue-600"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black flex items-center gap-1.5">
              <Zap className={`w-4 h-4 ${tab === "torture" ? "text-blue-400" : "text-blue-600"}`} />
              3. CPU+GPU+RAM Power Torture
            </span>
            {tortureResult && <StatusBadge status={tortureResult.status} darkSurface={tab === "torture"} />}
          </div>
          <div className={`text-[11px] mt-1 ${tab === "torture" ? "text-zinc-300" : "text-zinc-600"}`}>
            100% Full-Chassis Load • Detects AC Charger Drain &amp; VRM Cutoff
          </div>
        </button>
      </div>

      {/* Shared GPU Adapter Picker */}
      <div className="rounded-xl border border-zinc-200 bg-white p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-[260px]">
          <label className="text-xs font-bold text-black shrink-0">Target GPU:</label>
          <select
            value={selectedAdapter}
            disabled={running}
            onChange={(e) => setSelectedAdapter(Number(e.target.value))}
            className="flex-1 bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5 text-xs text-black font-medium"
          >
            {adapters.map((a) => (
              <option key={a.index} value={a.index}>
                {a.name} ({a.deviceType} • {a.backend})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-zinc-600">Thermal Cutoff:</span>
          <input
            type="number"
            min={75}
            max={105}
            disabled={running}
            value={cutoffC}
            onChange={(e) => setCutoffC(Number(e.target.value))}
            className="w-16 bg-white border border-zinc-300 rounded-lg px-2 py-1.5 text-xs font-mono font-bold text-blue-700"
          />
          <span className="font-mono font-bold text-black">°C</span>
        </div>
      </div>

      {error && <div className="rounded-xl bg-black text-white px-4 py-2.5 text-xs">{error}</div>}

      {/* ===================== TAB 1: FURMARK 3D SHADER ===================== */}
      {tab === "furmark" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">Resolution</label>
                <select
                  value={resolution}
                  disabled={running}
                  onChange={(e) => setResolution(e.target.value as "720p" | "1080p" | "1440p" | "4k")}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
                >
                  <option value="720p">1280×720 (Balanced)</option>
                  <option value="1080p">1920×1080 (FHD Heavy)</option>
                  <option value="1440p">2560×1440 (QHD Extreme)</option>
                  <option value="4k">3840×2160 (4K Ultra)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">Burn-In Duration</label>
                <select
                  value={preset}
                  disabled={running}
                  onChange={(e) => setPreset(e.target.value as "quick" | "standard" | "burnin" | "extended")}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
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
                    className="w-full py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-4 h-4" /> Stop Stress
                  </button>
                ) : (
                  <button
                    disabled={running}
                    onClick={startFurmark}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-4 h-4" /> Start GPU Burn-In
                  </button>
                )}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-semibold text-black cursor-pointer">
              <input
                type="checkbox"
                disabled={running}
                checked={extremeMode}
                onChange={(e) => setExtremeMode(e.target.checked)}
                className="accent-blue-600 w-4 h-4"
              />
              Extreme Burn-In Shader Mode (128-Step Heavy Raymarch — Maximum Thermal &amp; Power Load)
            </label>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-zinc-300 bg-black overflow-hidden relative aspect-video flex items-center justify-center">
              {progress?.previewDataUrl ? (
                <img src={progress.previewDataUrl} alt="Live wgpu Stress Render" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center space-y-2 p-6">
                  <Flame className="w-10 h-10 text-blue-500 mx-auto" />
                  <div className="text-sm font-bold text-white">Native wgpu FurMark-Style 3D Shader Burn-In</div>
                  <div className="text-xs text-zinc-400 max-w-md">
                    Executes uncapped raymarched frames directly on the selected DX12 / Vulkan / Metal adapter for the full timer duration.
                  </div>
                </div>
              )}
              {runningMode === "furmark" && progress && (
                <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-xs font-mono">
                  <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-blue-400 font-bold">
                    {progress.fps.toFixed(1)} FPS • 1% Low {progress.low1pctFps.toFixed(1)} • {progress.frameTimeMs.toFixed(1)} ms
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-white font-bold">
                    {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({pctFur}%)
                  </span>
                </div>
              )}
              {progress?.thermalWarning && (
                <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-blue-600 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  High GPU Temperature Approaching Safety Cutoff ({cutoffC}°C)!
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white p-4 flex flex-col justify-between space-y-3 font-mono text-xs">
              <div className="space-y-2.5">
                <div className="text-zinc-500 font-sans font-bold text-xs uppercase tracking-wider">
                  Live GPU Durability Telemetry
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
                  <div className="text-[10px] text-zinc-500">Avg / 1% Low / Min FPS</div>
                  <div className="text-lg font-black text-blue-600 mt-0.5">
                    {(progress?.avgFps ?? result?.avgFps ?? 0).toFixed(1)}{" "}
                    <span className="text-xs text-black">
                      / {(progress?.low1pctFps ?? result?.low1pctFps ?? 0).toFixed(1)} / {(progress?.minFps ?? result?.minFps ?? 0).toFixed(1)}
                    </span>
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-zinc-500">GPU Temperature</div>
                    <div className="text-xl font-black text-black mt-0.5">
                      {(progress?.gpuTempC ?? result?.peakTempC) != null
                        ? `${(progress?.gpuTempC ?? result?.peakTempC)?.toFixed(0)}°C`
                        : "N/A"}
                    </div>
                  </div>
                  <Thermometer className="w-5 h-5 text-blue-600" />
                </div>
                <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-zinc-500">Power / Thermal Throttle Drop</div>
                    <div className="text-sm font-black text-black mt-0.5">
                      {(progress?.gpuPowerW ?? result?.peakPowerW) != null
                        ? `${(progress?.gpuPowerW ?? result?.peakPowerW)?.toFixed(1)} W`
                        : "N/A"}
                      {result ? ` • Drop: ${result.fpsDropPct.toFixed(1)}%` : ""}
                    </div>
                  </div>
                  <Zap className="w-5 h-5 text-blue-600" />
                </div>
              </div>
              <div className="text-[11px] font-sans text-zinc-500">
                Frames Rendered: <strong className="font-mono text-black">{(progress?.framesRendered ?? result?.framesRendered ?? 0).toLocaleString()}</strong>
              </div>
            </div>
          </div>

          {fpsHistory.length > 0 && (
            <div className={`grid grid-cols-1 ${tempHistory.length > 0 ? "md:grid-cols-2" : ""} gap-3`}>
              <LiveChart title="Real-Time GPU FPS Stability" unit="FPS" data={fpsHistory} />
              {tempHistory.length > 0 && (
                <LiveChart title="Real-Time GPU Temperature" unit="°C" data={tempHistory} maxSuggested={100} />
              )}
            </div>
          )}

          {result && runningMode !== "furmark" && <BaselineCard baseline={result.baseline} />}
        </div>
      )}

      {/* ===================== TAB 2: DEDICATED VRAM INTEGRITY ===================== */}
      {tab === "vram" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">VRAM Test Pool Size</label>
                <select
                  value={vramMb}
                  disabled={running}
                  onChange={(e) => setVramMb(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
                >
                  <option value={256}>256 MB (Integrated / Quick)</option>
                  <option value={512}>512 MB (Integrated / Entry dGPU)</option>
                  <option value={1024}>1,024 MB / 1 GB (Standard dGPU)</option>
                  <option value={2048}>2,048 MB / 2 GB (Gaming 4–6GB VRAM)</option>
                  <option value={4096}>4,096 MB / 4 GB (High-End 8GB+ VRAM)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-600 mb-1">Verification Duration</label>
                <select
                  value={vramDur}
                  disabled={running}
                  onChange={(e) => setVramDur(Number(e.target.value))}
                  className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
                >
                  <option value={45}>Shop QC (45 seconds)</option>
                  <option value={90}>Standard Sweep (90 seconds)</option>
                  <option value={180}>Deep VRAM Burn (3 minutes)</option>
                  <option value={300}>Extended VRAM Audit (5 minutes)</option>
                </select>
              </div>
              <div>
                {runningMode === "vram" ? (
                  <button
                    onClick={() => invoke("cancel_vram_test").catch(() => {})}
                    className="w-full py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-4 h-4" /> Stop VRAM Test
                  </button>
                ) : (
                  <button
                    disabled={running}
                    onClick={startVram}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-4 h-4" /> Start VRAM Integrity Sweep
                  </button>
                )}
              </div>
            </div>

            {(runningMode === "vram" || vramProg || vramResult) && (
              <div className="space-y-3 pt-3 border-t border-zinc-200">
                {runningMode === "vram" && vramProg && (
                  <>
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-blue-700 font-bold">
                        Pass #{vramProg.passNumber} — {vramProg.patternName}
                      </span>
                      <span className="text-black font-bold">
                        {fmtTime(vramProg.elapsedSecs)} / {fmtTime(vramProg.durationSecs)} ({vramProg.percent.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden">
                      <div className="h-full bg-blue-600 transition-all" style={{ width: `${vramProg.percent}%` }} />
                    </div>
                  </>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
                  <div className={`rounded-xl p-3 border ${(vramProg?.errorsFound ?? vramResult?.errorsFound ?? 0) > 0 ? "bg-black text-white border-black" : "bg-blue-50 border-blue-600 text-blue-900"}`}>
                    <div className="text-[10px] font-sans font-bold uppercase">VRAM Bit Errors</div>
                    <div className="text-2xl font-black mt-0.5">
                      {vramProg?.errorsFound ?? vramResult?.errorsFound ?? 0}
                    </div>
                  </div>
                  <div className="rounded-xl p-3 border border-zinc-200 bg-zinc-50">
                    <div className="text-[10px] font-sans font-bold text-zinc-500 uppercase">Allocated Pool</div>
                    <div className="text-2xl font-black text-black mt-0.5">
                      {vramProg?.allocatedVramMb ?? vramResult?.allocatedVramMb ?? vramMb} MB
                    </div>
                  </div>
                  <div className="rounded-xl p-3 border border-zinc-200 bg-zinc-50">
                    <div className="text-[10px] font-sans font-bold text-zinc-500 uppercase">Total Verified</div>
                    <div className="text-2xl font-black text-blue-600 mt-0.5">
                      {(vramProg?.totalGbVerified ?? vramResult?.totalGbVerified ?? 0).toFixed(1)} GB
                    </div>
                  </div>
                  <div className="rounded-xl p-3 border border-zinc-200 bg-zinc-50">
                    <div className="text-[10px] font-sans font-bold text-zinc-500 uppercase">Effective Compute BW</div>
                    <div className="text-2xl font-black text-black mt-0.5">
                      {(vramProg?.bandwidthGbS ?? vramResult?.avgBandwidthGbS ?? 0).toFixed(1)} GB/s
                    </div>
                  </div>
                </div>

                {vramBwHistory.length > 0 && (
                  <LiveChart title="Real-Time VRAM Compute Sweep Bandwidth" unit="GB/s" data={vramBwHistory} />
                )}
              </div>
            )}
          </div>

          {vramResult && runningMode !== "vram" && <BaselineCard baseline={vramResult.baseline} />}
        </div>
      )}

      {/* ===================== TAB 3: COMBINED CPU+GPU+RAM POWER TORTURE ===================== */}
      {tab === "torture" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <label className="text-xs font-bold text-black">Torture Duration:</label>
                <select
                  value={tortureDur}
                  disabled={running}
                  onChange={(e) => setTortureDur(Number(e.target.value))}
                  className="bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black font-medium"
                >
                  <option value={60}>Quick Power Check (1 minute)</option>
                  <option value={120}>Shop QC Power &amp; Charger Torture (2 minutes)</option>
                  <option value={300}>Heavy VRM &amp; Shared Heatpipe Torture (5 minutes)</option>
                  <option value={600}>Extended 10-Minute Chassis Torture</option>
                </select>
              </div>
              {runningMode === "torture" ? (
                <button
                  onClick={() => invoke("cancel_power_torture").catch(() => {})}
                  className="px-5 py-2.5 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-2 cursor-pointer"
                >
                  <Square className="w-4 h-4" /> Stop Power Torture
                </button>
              ) : (
                <button
                  disabled={running}
                  onClick={startTorture}
                  className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-2 cursor-pointer"
                >
                  <Play className="w-4 h-4" /> Launch Combined CPU+GPU+RAM Torture
                </button>
              )}
            </div>
            <div className="text-[11px] text-zinc-600">
              Plug in the AC charger before starting — this test pushes CPU (AVX2/NEON), GPU (wgpu 3D), and RAM to simultaneous 100% load and flags if the battery drains while plugged in!
            </div>
          </div>

          {(tortureProg?.batteryDrainWhilePlugged || tortureResult?.batteryDrainWhilePlugged) && (
            <div className="rounded-xl border-2 border-black bg-black text-white p-4 flex items-center gap-3">
              <ShieldAlert className="w-6 h-6 text-blue-400 shrink-0" />
              <div className="text-xs">
                <div className="font-black uppercase tracking-wider text-blue-400">
                  ALERT: Battery Draining While AC Charger Plugged In!
                </div>
                <p className="text-zinc-300 mt-0.5">
                  The AC power adapter cannot sustain combined CPU + GPU wattage (delta{" "}
                  {(tortureProg?.batteryDeltaPct ?? tortureResult?.batteryDeltaPct ?? 0).toFixed(1)}%). Verify the adapter is original/correct wattage or inspect DC-in charging circuit!
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-zinc-300 bg-black overflow-hidden relative aspect-video flex items-center justify-center">
              {tortureProg?.previewDataUrl ? (
                <img src={tortureProg.previewDataUrl} alt="Combined Torture Render" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center space-y-2 p-6">
                  <Zap className="w-10 h-10 text-blue-500 mx-auto" />
                  <div className="text-sm font-bold text-white">Simultaneous CPU + GPU + RAM Chassis Torture</div>
                  <div className="text-xs text-zinc-400 max-w-md">
                    Tests shared heatpipes, motherboard VRM stability, and real-time AC adapter wattage headroom.
                  </div>
                </div>
              )}
              {runningMode === "torture" && tortureProg && (
                <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-xs font-mono">
                  <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-blue-400 font-bold">
                    CPU {tortureProg.telemetry.cpuUsagePct.toFixed(0)}% ({tortureProg.simdIsa}) • GPU {tortureProg.gpuFps.toFixed(1)} FPS
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-white font-bold">
                    {fmtTime(tortureProg.elapsedSecs)} / {fmtTime(tortureProg.durationSecs)} ({tortureProg.percent.toFixed(0)}%)
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white p-4 flex flex-col justify-between space-y-2.5 font-mono text-xs">
              <div className="text-zinc-500 font-sans font-bold text-xs uppercase tracking-wider">
                Full-Chassis Power Telemetry
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-zinc-500">CPU Load / Clock</div>
                  <div className="text-base font-black text-black">
                    {tortureProg ? `${tortureProg.telemetry.cpuUsagePct.toFixed(0)}% @ ${tortureProg.telemetry.cpuClockMhz} MHz` : "Ready"}
                  </div>
                </div>
                <Cpu className="w-5 h-5 text-blue-600" />
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-zinc-500">AC / Battery Delta</div>
                  <div className="text-base font-black text-blue-700">
                    {tortureProg?.telemetry.acPlugged === true ? "AC ON" : tortureProg?.telemetry.acPlugged === false ? "BATTERY" : "—"}
                    {tortureProg?.telemetry.batteryPercent != null ? ` • ${tortureProg.telemetry.batteryPercent.toFixed(0)}%` : ""}
                    {tortureProg?.batteryDeltaPct != null ? ` (${tortureProg.batteryDeltaPct >= 0 ? "+" : ""}${tortureProg.batteryDeltaPct.toFixed(1)}%)` : ""}
                  </div>
                  {tortureProg?.telemetry.batteryWatts != null && (
                    <div className="text-[10px] text-zinc-600">
                      Battery Net: {tortureProg.telemetry.batteryWatts.toFixed(1)} W
                    </div>
                  )}
                </div>
                <BatteryCharging className="w-5 h-5 text-blue-600" />
              </div>
              <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-zinc-500">Peak CPU / GPU Temp</div>
                  <div className="text-base font-black text-black">
                    {(tortureProg?.telemetry.cpuTempC ?? tortureResult?.peakCpuTempC)?.toFixed(0) ?? "N/A"}°C /{" "}
                    {(tortureProg?.telemetry.gpuTempC ?? tortureResult?.peakGpuTempC)?.toFixed(0) ?? "N/A"}°C
                  </div>
                </div>
                <Thermometer className="w-5 h-5 text-blue-600" />
              </div>
              {tortureResult && (
                <div className="rounded-lg bg-black text-white p-3 flex items-center justify-between">
                  <span className="text-[10px] uppercase font-sans font-bold text-blue-400">Durability Grade</span>
                  <span className="text-lg font-black">{tortureResult.durabilityGrade}</span>
                </div>
              )}
            </div>
          </div>

          {tortureFpsHistory.length > 0 && (
            <LiveChart title="Combined Torture GPU FPS Stability" unit="FPS" data={tortureFpsHistory} />
          )}

          {tortureResult && runningMode !== "torture" && <BaselineCard baseline={tortureResult.baseline} />}
        </div>
      )}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(hasAnyResult && !running) || status === "notApplicable"}
        requirementHint="Run at least one GPU / VRAM / Power Torture test or mark N/A for office laptops (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
