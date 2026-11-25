import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Flame, Play, Square, Thermometer, Zap } from "lucide-react";
import type {
  GpuAdapterInfo,
  GpuStressProgress,
  GpuStressResult,
  StressPreset,
  TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface GpuStressViewProps {
  isGamingCapable: boolean;
  result: GpuStressResult | null;
  status: TestStatus;
  onComplete: (res: GpuStressResult) => void;
  onMarkNA: () => void;
  onRunningChange: (running: boolean) => void;
  onFinish?: () => void;
}

export const GpuStressView: React.FC<GpuStressViewProps> = ({
  isGamingCapable,
  result,
  status,
  onComplete,
  onMarkNA,
  onRunningChange,
  onFinish,
}) => {
  const [adapters, setAdapters] = useState<GpuAdapterInfo[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState<number>(0);
  const [preset, setPreset] = useState<StressPreset>("quick");
  const [resolution, setResolution] = useState<"720p" | "1080p" | "1440p">("720p");
  const [cutoffC, setCutoffC] = useState(95);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GpuStressProgress | null>(null);
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
    try {
      const res = await invoke<GpuStressResult>("run_gpu_stress", {
        adapterIndex: selectedAdapter,
        preset,
        resolution,
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

  const stopStress = () => {
    invoke("cancel_gpu_stress").catch(() => {});
  };

  const pct = progress
    ? Math.min(100, Math.round((progress.elapsedSecs / Math.max(progress.durationSecs, 1)) * 100))
    : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Gaming GPU Stress (FurMark wgpu Engine)</h1>
            <StatusBadge status={status} />
            {isGamingCapable && (
              <span className="px-2 py-0.5 rounded-full bg-orange-500/20 border border-orange-500/40 text-orange-300 text-[10px] font-bold">
                DISCRETE / PRO GPU DETECTED
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Native Rust wgpu (DX12 / Vulkan / Metal) procedural raymarched furry-torus thermal stress test with adapter selector &amp; auto thermal cutoff.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isGamingCapable && !running && (
            <button
              onClick={onMarkNA}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300"
            >
              Skip (Office Laptop — N/A)
            </button>
          )}
          {onFinish && (
            <button
              onClick={onFinish}
              className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold"
            >
              Finish &amp; Report →
            </button>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <div className="md:col-span-2">
          <label className="block text-[11px] text-slate-400 mb-1">Target GPU Adapter</label>
          <select
            value={selectedAdapter}
            disabled={running}
            onChange={(e) => setSelectedAdapter(Number(e.target.value))}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
          >
            {adapters.map((a) => (
              <option key={a.index} value={a.index}>
                {a.name} ({a.deviceType} • {a.backend})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Resolution</label>
          <select
            value={resolution}
            disabled={running}
            onChange={(e) => setResolution(e.target.value as "720p" | "1080p" | "1440p")}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
          >
            <option value="720p">1280×720 (Balanced)</option>
            <option value="1080p">1920×1080 (Heavy)</option>
            <option value="1440p">2560×1440 (Extreme)</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Duration / Cutoff ({cutoffC}°C)</label>
          <div className="flex gap-1.5">
            <select
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as StressPreset)}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-200"
            >
              <option value="quick">Quick (90s)</option>
              <option value="standard">Std (5m)</option>
              <option value="burnin">Burn (15m)</option>
            </select>
            <input
              type="number"
              min={75}
              max={105}
              disabled={running}
              value={cutoffC}
              onChange={(e) => setCutoffC(Number(e.target.value))}
              className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs font-mono text-amber-300"
              title="Safety Thermal Cutoff (°C)"
            />
          </div>
        </div>
        <div>
          {running ? (
            <button
              onClick={stopStress}
              className="w-full py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-200 font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <Square className="w-4 h-4" /> Stop Stress
            </button>
          ) : (
            <button
              onClick={startStress}
              className="w-full py-2 rounded-lg bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-400 hover:to-rose-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <Play className="w-4 h-4" /> Start GPU Stress
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-rose-500/15 border border-rose-500/40 px-4 py-2.5 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Live Furry Torus Render Viewport + Telemetry */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-950 overflow-hidden relative aspect-video flex items-center justify-center">
          {progress?.previewDataUrl ? (
            <img
              src={progress.previewDataUrl}
              alt="Live wgpu FurMark Stress Render"
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="text-center space-y-2 p-6">
              <Flame className="w-10 h-10 text-orange-500/50 mx-auto" />
              <div className="text-sm font-semibold text-slate-300">
                Native wgpu Furry-Torus GPU Thermal Stress
              </div>
              <div className="text-xs text-slate-500 max-w-md">
                Executes uncapped raymarched shader frames directly on the selected DX12 / Vulkan / Metal GPU adapter.
              </div>
            </div>
          )}

          {running && progress && (
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-xs font-mono">
              <span className="px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-700 text-orange-300 font-bold">
                {progress.fps.toFixed(1)} FPS • {progress.frameTimeMs.toFixed(1)} ms
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-700 text-slate-200">
                {progress.elapsedSecs.toFixed(0)}s / {progress.durationSecs}s ({pct}%)
              </span>
            </div>
          )}

          {progress?.thermalWarning && (
            <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-rose-600/90 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              High GPU Temperature Approaching Safety Cutoff ({cutoffC}°C)!
            </div>
          )}
        </div>

        {/* Side Telemetry */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 flex flex-col justify-between space-y-3 font-mono text-xs">
          <div className="space-y-2.5">
            <div className="text-slate-400 font-sans font-bold text-xs uppercase tracking-wider">
              Live GPU Telemetry
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
              <div className="text-[10px] text-slate-400">Average / Min FPS</div>
              <div className="text-xl font-bold text-orange-400 mt-0.5">
                {(progress?.avgFps ?? result?.avgFps ?? 0).toFixed(1)}{" "}
                <span className="text-xs text-slate-400">
                  / min {(progress?.minFps ?? result?.minFps ?? 0).toFixed(1)}
                </span>
              </div>
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 flex items-center justify-between">
              <div>
                <div className="text-[10px] text-slate-400">GPU Temperature</div>
                <div className="text-xl font-bold text-amber-300 mt-0.5">
                  {(progress?.gpuTempC ?? result?.peakTempC) != null
                    ? `${(progress?.gpuTempC ?? result?.peakTempC)?.toFixed(0)}°C`
                    : "N/A"}
                </div>
              </div>
              <Thermometer className="w-5 h-5 text-amber-400/70" />
            </div>
            <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 flex items-center justify-between">
              <div>
                <div className="text-[10px] text-slate-400">GPU Power / Load</div>
                <div className="text-base font-bold text-cyan-300 mt-0.5">
                  {(progress?.gpuPowerW ?? result?.peakPowerW) != null
                    ? `${(progress?.gpuPowerW ?? result?.peakPowerW)?.toFixed(1)} W`
                    : "N/A"}
                  {progress?.gpuLoadPct != null ? ` • ${progress.gpuLoadPct.toFixed(0)}%` : ""}
                </div>
              </div>
              <Zap className="w-5 h-5 text-cyan-400/70" />
            </div>
          </div>

          {result && !running && (
            <div className="rounded-lg bg-slate-950/90 border border-slate-800 p-3 font-sans text-xs text-slate-300">
              {result.summary}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
