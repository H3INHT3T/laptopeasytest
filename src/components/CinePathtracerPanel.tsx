import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Cpu, Play, Sparkles, Square, Thermometer } from "lucide-react";
import type { CinePathtracerResult, CinePathtracerTileEvent } from "../types";
import { StatusBadge } from "./StatusBadge";

interface CinePathtracerPanelProps {
  result: CinePathtracerResult | null;
  disabled?: boolean;
  onComplete: (res: CinePathtracerResult) => void;
  onRunningChange?: (running: boolean) => void;
}

export const CinePathtracerPanel: React.FC<CinePathtracerPanelProps> = ({
  result,
  disabled = false,
  onComplete,
  onRunningChange,
}) => {
  const [mode, setMode] = useState<"both" | "multi" | "single">("both");
  const [quality, setQuality] = useState<"quick" | "standard" | "ultra">("standard");
  const [running, setRunning] = useState(false);
  const [tileState, setTileState] = useState<CinePathtracerTileEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dimsRef = useRef<{ w: number; h: number }>({ w: 960, h: 540 });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<CinePathtracerTileEvent>("pathtracer:tile", (ev) => {
      const p = ev.payload;
      setTileState(p);

      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!baseImgCanvasRef.current) {
        baseImgCanvasRef.current = document.createElement("canvas");
      }
      const off = baseImgCanvasRef.current;

      if (dimsRef.current.w !== p.imageW || dimsRef.current.h !== p.imageH) {
        dimsRef.current = { w: p.imageW, h: p.imageH };
        canvas.width = p.imageW;
        canvas.height = p.imageH;
        off.width = p.imageW;
        off.height = p.imageH;
        const octx = off.getContext("2d");
        if (octx) {
          octx.fillStyle = "#09090B";
          octx.fillRect(0, 0, p.imageW, p.imageH);
        }
      }

      const drawOverlay = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(off, 0, 0);
        // Cinebench-style glowing blue borders around currently active CPU core tiles!
        if (Array.isArray(p.activeTiles) && p.activeTiles.length > 0) {
          ctx.strokeStyle = "#3B82F6";
          ctx.lineWidth = 2;
          for (const [ax, ay] of p.activeTiles) {
            ctx.strokeRect(ax + 1, ay + 1, Math.min(64, p.imageW - ax) - 2, Math.min(64, p.imageH - ay) - 2);
          }
        }
      };

      if (p.tilePngBase64) {
        const img = new Image();
        img.onload = () => {
          const octx = off.getContext("2d");
          if (octx) {
            octx.drawImage(img, p.tileX, p.tileY, p.tileW, p.tileH);
          }
          drawOverlay();
        };
        img.src = `data:image/png;base64,${p.tilePngBase64}`;
      } else {
        drawOverlay();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const startPathtracer = async () => {
    setError(null);
    setRunning(true);
    setTileState(null);
    onRunningChange?.(true);
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
    if (baseImgCanvasRef.current) {
      const octx = baseImgCanvasRef.current.getContext("2d");
      if (octx) {
        octx.fillStyle = "#09090B";
        octx.fillRect(0, 0, baseImgCanvasRef.current.width, baseImgCanvasRef.current.height);
      }
    }
    try {
      const res = await invoke<CinePathtracerResult>("run_cine_pathtracer", {
        mode,
        quality,
      });
      onComplete(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onRunningChange?.(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <h2 className="text-xs font-black uppercase tracking-wider text-black">
              Cinebench-Class Multi-Core &amp; Single-Core Live Tile Path-Tracer (v3.5.0)
            </h2>
            {result && !running && <StatusBadge status={result.status} compact />}
          </div>
          <p className="text-[11px] text-zinc-600 max-w-2xl">
            Real Rust + Rayon 5-bounce Monte-Carlo PBR Path-Tracer (Snell glass refraction, mirror chrome, brushed gold, emissive softboxes &amp; global illumination). Watch every CPU core carve through 64×64 spiral tiles live.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={mode}
            disabled={running || disabled}
            onChange={(e) => setMode(e.target.value as "both" | "multi" | "single")}
            aria-label="Path-Tracer Pass Mode"
            className="bg-[#F8FAFC] border border-zinc-200 rounded-lg px-2.5 py-1.5 font-mono text-xs text-black font-semibold"
          >
            <option value="both">Multi-Core + Single-Core (MP Ratio)</option>
            <option value="multi">Multi-Core All Threads Only</option>
            <option value="single">Single-Core (1 Thread) Only</option>
          </select>
          <select
            value={quality}
            disabled={running || disabled}
            onChange={(e) => setQuality(e.target.value as "quick" | "standard" | "ultra")}
            aria-label="Path-Tracer Render Quality"
            className="bg-[#F8FAFC] border border-zinc-200 rounded-lg px-2.5 py-1.5 font-mono text-xs text-black font-semibold"
          >
            <option value="quick">Quick QC (768×448 • 16 spp)</option>
            <option value="standard">Standard (960×540 • 24 spp)</option>
            <option value="ultra">Ultra Heavy (1280×720 • 32 spp)</option>
          </select>
          {running ? (
            <button
              type="button"
              onClick={() => invoke("cancel_cine_pathtracer").catch(() => {})}
              className="px-3.5 py-1.5 rounded-lg bg-black hover:bg-zinc-800 text-white font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" /> Stop Render
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={startPathtracer}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" /> Run Cine Path-Tracer
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-black text-white px-3 py-2 font-mono text-xs">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border border-zinc-200 bg-black overflow-hidden relative aspect-video flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            className={`w-full h-full object-contain ${running || (!result?.imageDataUrl && tileState) ? "block" : "hidden"}`}
          />
          {!running && result?.imageDataUrl && (
            <img
              src={result.imageDataUrl}
              alt="Cinebench-Class Path-Traced Render"
              className="w-full h-full object-contain"
            />
          )}
          {!running && !result?.imageDataUrl && !tileState && (
            <div className="text-center p-6 font-mono space-y-1.5">
              <Cpu className="w-7 h-7 text-blue-500 mx-auto" />
              <div className="text-xs font-bold text-white uppercase">
                Live 64×64 Spiral Tile Path-Tracing Viewport
              </div>
              <div className="text-[11px] text-zinc-400 max-w-md">
                Click Run Cine Path-Tracer to benchmark true all-core CPU rendering, single-core IPC, MP scaling ratio &amp; thermal clock stability.
              </div>
            </div>
          )}

          {running && tileState && (
            <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 flex-wrap font-mono text-[11px]">
              <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-blue-400 font-bold">
                {tileState.passMode === "single" ? "SINGLE-CORE PASS" : "MULTI-CORE PASS"} •{" "}
                {tileState.tilesDone}/{tileState.tilesTotal} tiles ({tileState.percent.toFixed(0)}%)
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-white font-bold">
                {tileState.mraysPerSec.toFixed(2)} MRays/s
                {tileState.cpuTempC != null ? ` • ${tileState.cpuTempC.toFixed(0)}°C` : ""}
                {tileState.cpuClockMhz > 0 ? ` • ${tileState.cpuClockMhz} MHz` : ""}
              </span>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] divide-y divide-zinc-200 flex flex-col justify-between font-mono tabular-nums text-xs">
          <div className="px-3.5 py-2 bg-white text-[10px] font-bold uppercase tracking-wider text-zinc-600 rounded-t-xl">
            Cine Path-Tracer Telemetry
          </div>
          <div className="p-3.5">
            <div className="text-[9.5px] uppercase text-zinc-500">Multi-Core Score</div>
            <div className="text-2xl font-black text-blue-700 mt-0.5">
              {result ? `${result.multiCorePts.toLocaleString()} pts` : "—"}
            </div>
            {result && <div className="text-[10px] text-zinc-600 mt-0.5">{result.tier}</div>}
          </div>
          <div className="p-3.5 grid grid-cols-2 gap-2">
            <div>
              <div className="text-[9.5px] uppercase text-zinc-500">Single-Core</div>
              <div className="text-base font-black text-black mt-0.5">
                {result?.singleCorePts != null ? `${result.singleCorePts.toLocaleString()} pts` : "—"}
              </div>
            </div>
            <div>
              <div className="text-[9.5px] uppercase text-zinc-500">MP Ratio</div>
              <div className="text-base font-black text-blue-700 mt-0.5">
                {result?.mpRatio != null ? `${result.mpRatio.toFixed(2)}×` : "—"}
              </div>
            </div>
          </div>
          <div className="p-3.5 flex items-center justify-between">
            <div>
              <div className="text-[9.5px] uppercase text-zinc-500">Throughput / Thermal</div>
              <div className="text-xs font-bold text-black mt-0.5">
                {result
                  ? `${result.mraysPerSec.toFixed(2)} MRays/s • ${result.threadsUsed}T`
                  : tileState
                  ? `${tileState.mraysPerSec.toFixed(2)} MRays/s`
                  : "Ready"}
              </div>
              {result && (
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  {result.peakTempC != null ? `Peak ${result.peakTempC.toFixed(0)}°C • ` : ""}
                  {result.avgClockMhz > 0 ? `${result.avgClockMhz} MHz • ` : ""}
                  Throttle -{result.throttleDropPct.toFixed(1)}%
                </div>
              )}
            </div>
            <Thermometer className="w-4 h-4 text-blue-600 shrink-0" />
          </div>
        </div>
      </div>
    </div>
  );
};
