import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, Maximize2, Monitor, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";

interface DisplayTestViewProps {
  status: TestStatus;
  notes: string;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext?: () => void;
}

interface PatternDef {
  id: string;
  name: string;
  desc: string;
  kind: "solid" | "gradient" | "contrast" | "grid" | "motion";
  color?: string;
}

const PATTERNS: PatternDef[] = [
  { id: "black", name: "Pure Black (0,0,0)", desc: "Check bright stuck subpixels & backlight bleed", kind: "solid", color: "#000000" },
  { id: "white", name: "Pure White (255,255,255)", desc: "Check dark dead pixels, yellowing & dust spots", kind: "solid", color: "#ffffff" },
  { id: "red", name: "Pure Red (255,0,0)", desc: "Verify red subpixel uniformity", kind: "solid", color: "#ff0000" },
  { id: "green", name: "Pure Green (0,255,0)", desc: "Verify green subpixel uniformity", kind: "solid", color: "#00ff00" },
  { id: "blue", name: "Pure Blue (0,0,255)", desc: "Verify blue subpixel uniformity", kind: "solid", color: "#0000ff" },
  { id: "cyan", name: "Cyan", desc: "Green + Blue combined check", kind: "solid", color: "#00ffff" },
  { id: "magenta", name: "Magenta", desc: "Red + Blue combined check", kind: "solid", color: "#ff00ff" },
  { id: "yellow", name: "Yellow", desc: "Red + Green combined check", kind: "solid", color: "#ffff00" },
  { id: "gray5", name: "Dark Gray 5% (Uniformity)", desc: "Check IPS glow, clouding & OLED banding", kind: "solid", color: "#0d0d0d" },
  { id: "gray15", name: "Dark Gray 15% (Uniformity)", desc: "Check panel dirty-screen effect", kind: "solid", color: "#262626" },
  { id: "gray50", name: "Mid Gray 50%", desc: "Check color tinting & screen burn-in", kind: "solid", color: "#808080" },
  { id: "gradient", name: "RGB + Grayscale Gradients", desc: "Check smooth bit-depth transitions without banding", kind: "gradient" },
  { id: "contrast", name: "Contrast & Gamma Steps", desc: "Verify dark & highlight separation steps", kind: "contrast" },
  { id: "grid", name: "Geometry & Sharpness Grid", desc: "Verify crisp pixel alignment & scaling", kind: "grid" },
  { id: "motion", name: "Motion Clarity & Refresh Rate", desc: "Check ghosting, smearing & live measured Hz", kind: "motion" },
];

export const DisplayTestView: React.FC<DisplayTestViewProps> = ({
  status,
  notes: initialNotes,
  onVerdict,
  onNext,
}) => {
  const [active, setActive] = useState(false);
  const [idx, setIdx] = useState(0);
  const [showHud, setShowHud] = useState(true);
  const [measuredHz, setMeasuredHz] = useState<number>(60);
  const [notes, setNotes] = useState(initialNotes);
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const enterFullscreen = async (startIdx = 0) => {
    setIdx(startIdx);
    setActive(true);
    setShowHud(true);
    try {
      await getCurrentWindow().setFullscreen(true);
    } catch {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };

  const exitFullscreen = async () => {
    setActive(false);
    try {
      await getCurrentWindow().setFullscreen(false);
    } catch {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitFullscreen();
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setIdx((i) => (i + 1) % PATTERNS.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx((i) => (i - 1 + PATTERNS.length) % PATTERNS.length);
      } else if (e.key.toLowerCase() === "h") {
        setShowHud((h) => !h);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Motion & live Hz animation loop
  useEffect(() => {
    if (!active || PATTERNS[idx].kind !== "motion") return;
    let raf = 0;
    let frames = 0;
    let lastTs = performance.now();
    let x = 0;

    const tick = (now: number) => {
      frames++;
      if (now - lastTs >= 500) {
        setMeasuredHz(Math.round((frames * 1000) / (now - lastTs)));
        frames = 0;
        lastTs = now;
      }
      const canvas = motionCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.fillStyle = "#0b1120";
          ctx.fillRect(0, 0, w, h);

          // Reference vertical lines
          ctx.strokeStyle = "rgba(148,163,184,0.18)";
          for (let gx = 0; gx < w; gx += 80) {
            ctx.beginPath();
            ctx.moveTo(gx, 0);
            ctx.lineTo(gx, h);
            ctx.stroke();
          }

          x = (x + 12) % (w + 180);
          // 3 speed lanes (slow, medium, fast)
          const lanes = [
            { y: h * 0.25, pos: (x * 0.6) % w, color: "#38bdf8", label: "SLOW" },
            { y: h * 0.5, pos: x % w, color: "#34d399", label: "MEDIUM" },
            { y: h * 0.75, pos: (x * 1.6) % w, color: "#fb923c", label: "FAST" },
          ];
          for (const lane of lanes) {
            ctx.fillStyle = lane.color;
            ctx.fillRect(lane.pos - 40, lane.y - 26, 80, 52);
            ctx.fillStyle = "#020617";
            ctx.font = "bold 14px monospace";
            ctx.fillText(lane.label, lane.pos - 26, lane.y + 5);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, idx]);

  const pattern = PATTERNS[idx];

  return (
    <div className="space-y-5">
      {/* Fullscreen Overlay */}
      {active && (
        <div
          onClick={() => setIdx((i) => (i + 1) % PATTERNS.length)}
          onContextMenu={(e) => {
            e.preventDefault();
            exitFullscreen();
          }}
          className="fixed inset-0 z-[100] cursor-pointer select-none"
          style={{
            backgroundColor: pattern.kind === "solid" ? pattern.color : "#000000",
          }}
        >
          {pattern.kind === "gradient" && (
            <div className="w-full h-full flex flex-col">
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000, #fff)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000, #ff0000)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000, #00ff00)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000, #0000ff)" }} />
            </div>
          )}

          {pattern.kind === "contrast" && (
            <div className="w-full h-full flex flex-col bg-black p-8 gap-4">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex-1 flex">
                  {Array.from({ length: 16 }).map((_, step) => {
                    const v = Math.round((step / 15) * 255);
                    const bg =
                      row === 0
                        ? `rgb(${v},${v},${v})`
                        : row === 1
                        ? `rgb(${v},0,0)`
                        : `rgb(0,${v},${v})`;
                    return (
                      <div
                        key={step}
                        className="flex-1 flex items-end justify-center pb-2 text-[10px] font-mono"
                        style={{ backgroundColor: bg, color: v > 128 ? "#000" : "#fff" }}
                      >
                        {Math.round((step / 15) * 100)}%
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {pattern.kind === "grid" && (
            <div
              className="w-full h-full relative"
              style={{
                backgroundColor: "#000",
                backgroundImage:
                  "linear-gradient(to right, rgba(255,255,255,0.45) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.45) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-72 h-72 rounded-full border-2 border-cyan-400 flex items-center justify-center">
                  <div className="w-36 h-36 rounded-full border border-emerald-400" />
                </div>
              </div>
            </div>
          )}

          {pattern.kind === "motion" && (
            <canvas
              ref={motionCanvasRef}
              width={window.innerWidth}
              height={window.innerHeight}
              className="w-full h-full block"
            />
          )}

          {showHud && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-950/85 border border-slate-700 backdrop-blur-md rounded-xl px-5 py-3 text-xs text-white flex items-center gap-4 shadow-2xl"
            >
              <div>
                <div className="font-bold">
                  [{idx + 1}/{PATTERNS.length}] {pattern.name}
                  {pattern.kind === "motion" ? ` • ~${measuredHz} Hz` : ""}
                </div>
                <div className="text-slate-400 text-[11px]">{pattern.desc}</div>
              </div>
              <div className="text-[11px] text-cyan-300 font-mono whitespace-nowrap">
                Click / Space: Next • H: Hide HUD • Esc: Exit
              </div>
              <button
                onClick={exitFullscreen}
                className="px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-white font-bold"
              >
                Exit
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main View */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white">Display Check (MonitorTest Suite)</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Fullscreen dead/stuck pixel, backlight bleed, gradient banding, contrast/gamma, sharpness grid, and refresh-rate ghosting suite.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => enterFullscreen(0)}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5"
          >
            <Maximize2 className="w-4 h-4" />
            Launch Fullscreen Display Test
          </button>
          {onNext && (
            <button
              onClick={onNext}
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold"
            >
              Next Test →
            </button>
          )}
        </div>
      </div>

      {/* Pattern Quick-Launch Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
        {PATTERNS.map((p, i) => (
          <button
            key={p.id}
            onClick={() => enterFullscreen(i)}
            className="rounded-xl border border-slate-800 hover:border-cyan-500/60 bg-slate-900/70 p-3 text-left transition group"
          >
            <div
              className="h-10 rounded-lg border border-slate-700 mb-2 flex items-center justify-center text-[10px] font-mono text-slate-300"
              style={{
                background:
                  p.kind === "solid"
                    ? p.color
                    : p.kind === "gradient"
                    ? "linear-gradient(90deg, #000, #f00, #0f0, #00f, #fff)"
                    : "linear-gradient(135deg, #0f172a, #1e293b)",
              }}
            >
              {p.kind !== "solid" && p.kind.toUpperCase()}
            </div>
            <div className="text-xs font-semibold text-white group-hover:text-cyan-300 truncate">
              {p.name}
            </div>
          </button>
        ))}
      </div>

      {/* Verdict Panel */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <Monitor className="w-4 h-4 text-cyan-400" />
          Technician Visual Verdict
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional panel observations (e.g. 0 dead pixels, clean uniformity, 144Hz smooth)"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict(
                "pass",
                `Display clean — 0 dead pixels, uniformity & motion (${measuredHz} Hz) verified.`,
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Display Check
          </button>
          <button
            onClick={() =>
              onVerdict(
                "warn",
                "Minor panel imperfection noted (slight backlight bleed / bright spot).",
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-bold text-xs"
          >
            Mark Minor Issue (WARN)
          </button>
          <button
            onClick={() =>
              onVerdict(
                "fail",
                "Display defect found (dead pixels, lines, flicker, or severe bleed).",
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center gap-1.5"
          >
            <XCircle className="w-4 h-4" />
            Fail Display Check
          </button>
        </div>
      </div>
    </div>
  );
};
