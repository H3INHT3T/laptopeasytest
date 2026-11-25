import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Flame, Play, Square, Thermometer, Zap } from "lucide-react";
import type {
  GpuAdapterInfo,
  GpuStressProgress,
  GpuStressResult,
  TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { LiveChart } from "../components/LiveChart";
import { BaselineCard } from "../components/BaselineCard";

interface GpuStressViewProps {
  isGamingCapable: boolean;
  result: GpuStressResult | null;
  status: TestStatus;
  stepNumber: number;
  totalSteps: number;
  onComplete: (res: GpuStressResult) => void;
  onMarkNA: () => void;
  onRunningChange: (running: boolean) => void;
  onNext: () => void;
  onSkip: () => void;
}

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const GpuStressView: React.FC<GpuStressViewProps> = ({
  isGamingCapable,
  result,
  status,
  stepNumber,
  totalSteps,
  onComplete,
  onMarkNA,
  onRunningChange,
  onNext,
  onSkip,
}) => {
  const [adapters, setAdapters] = useState<GpuAdapterInfo[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState<number>(0);
  const [preset, setPreset] = useState<"quick" | "standard" | "burnin" | "extended">("quick");
  const [resolution, setResolution] = useState<"720p" | "1080p" | "1440p" | "4k">("720p");
  const [extremeMode, setExtremeMode] = useState(false);
  const [cutoffC, setCutoffC] = useState(95);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GpuStressProgress | null>(null);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [tempHistory, setTempHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<GpuAdapterInfo[]>("list_gpu_adapters")
      .then((list) => {
        setAdapters(list);
        const discrete = list.find((a) => a.isDiscrete);
        if (discrete) setSelectedAdapter(discrete.index);
      })
      .catch((e) => setError(String(e)));

    let unlisten: (() => void) | null = null;
    listen<GpuStressProgress>("gpu:progress", (ev) => {
      setProgress(ev.payload);
      setFpsHistory((prev) => [...prev.slice(-79), ev.payload.fps]);
      if (ev.payload.gpuTempC != null) {
        setTempHistory((prev) => [...prev.slice(-79), ev.payload.gpuTempC as number]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startStress = async () => {
    setError(null);
    setRunning(true);
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
      setRunning(false);
      onRunningChange(false);
    }
  };

  const pct = progress
    ? Math.min(100, Math.round((progress.elapsedSecs / Math.max(progress.durationSecs, 1)) * 100))
    : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              {stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Gaming GPU Durability Burn-In (FurMark 2 wgpu Engine)
            </h1>
            <StatusBadge status={status} />
            {isGamingCapable && (
              <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] font-bold">
                dGPU DETECTED
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Sustained native wgpu shader burn-in with live FPS &amp; Temperature graphs, 1% Low stability, thermal throttle drop %, and GPU-class normal baseline rating.
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

      {/* Controls */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-zinc-600 mb-1">Target GPU Adapter</label>
            <select
              value={selectedAdapter}
              disabled={running}
              onChange={(e) => setSelectedAdapter(Number(e.target.value))}
              className="w-full bg-white border border-zinc-300 rounded-lg px-2.5 py-2 text-xs text-black font-medium"
            >
              {adapters.map((a) => (
                <option key={a.index} value={a.index}>
                  {a.name} ({a.deviceType} • {a.backend})
                </option>
              ))}
            </select>
          </div>
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
            <label className="block text-[11px] font-bold text-zinc-600 mb-1">Duration / Cutoff ({cutoffC}°C)</label>
            <div className="flex gap-1.5">
              <select
                value={preset}
                disabled={running}
                onChange={(e) => setPreset(e.target.value as "quick" | "standard" | "burnin" | "extended")}
                className="flex-1 bg-white border border-zinc-300 rounded-lg px-2 py-2 text-xs text-black font-medium"
              >
                <option value="quick">Shop QC (2m)</option>
                <option value="standard">Durability (5m)</option>
                <option value="burnin">Burn-In (15m)</option>
                <option value="extended">Extended (30m)</option>
              </select>
              <input
                type="number"
                min={75}
                max={105}
                disabled={running}
                value={cutoffC}
                onChange={(e) => setCutoffC(Number(e.target.value))}
                className="w-16 bg-white border border-zinc-300 rounded-lg px-2 py-2 text-xs font-mono font-bold text-blue-700"
              />
            </div>
          </div>
          <div>
            {running ? (
              <button
                onClick={() => invoke("cancel_gpu_stress").catch(() => {})}
                className="w-full py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Square className="w-4 h-4" /> Stop Stress
              </button>
            ) : (
              <button
                onClick={startStress}
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

      {error && <div className="rounded-xl bg-black text-white px-4 py-2.5 text-xs">{error}</div>}

      {/* Viewport & Telemetry */}
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

          {running && progress && (
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-xs font-mono">
              <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-blue-400 font-bold">
                {progress.fps.toFixed(1)} FPS • 1% Low {progress.low1pctFps.toFixed(1)} • {progress.frameTimeMs.toFixed(1)} ms
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-white font-bold">
                {fmtTime(progress.elapsedSecs)} / {fmtTime(progress.durationSecs)} ({pct}%)
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

      {/* Live FPS & Temp Sparkline Charts */}
      {fpsHistory.length > 0 && (
        <div className={`grid grid-cols-1 ${tempHistory.length > 0 ? "md:grid-cols-2" : ""} gap-3`}>
          <LiveChart title="Real-Time GPU FPS Stability" unit="FPS" data={fpsHistory} />
          {tempHistory.length > 0 && (
            <LiveChart title="Real-Time GPU Temperature" unit="°C" data={tempHistory} maxSuggested={100} />
          )}
        </div>
      )}

      {result && !running && <BaselineCard baseline={result.baseline} />}

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={Boolean(result && !running) || status === "notApplicable"}
        requirementHint="Run the FurMark 2 GPU Durability Test or mark N/A for office laptops (or click Skip Step)."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
