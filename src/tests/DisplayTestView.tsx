import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, Maximize2, Monitor, XCircle } from "lucide-react";
import type { TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface DisplayTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  onVerdict: (status: TestStatus, summary: string, notes: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

interface PatternDef {
  id: string;
  name: string;
  desc: string;
  kind:
    | "solid"
    | "gradient"
    | "contrast"
    | "gamma"
    | "pixelwalk"
    | "readability"
    | "grid"
    | "motion";
  color?: string;
}

// 18 authentic PassMark MonitorTest 4.0-inspired full-screen display patterns
const PATTERNS: PatternDef[] = [
  { id: "black", name: "Pure Black (0,0,0)", desc: "Check bright stuck pixels & edge backlight bleed", kind: "solid", color: "#000000" },
  { id: "white", name: "Pure White (255,255,255)", desc: "Check dark dead pixels, yellowing & pressure spots", kind: "solid", color: "#ffffff" },
  { id: "red", name: "Pure Red (255,0,0)", desc: "Verify red subpixel channel uniformity", kind: "solid", color: "#ff0000" },
  { id: "green", name: "Pure Green (0,255,0)", desc: "Verify green subpixel channel uniformity", kind: "solid", color: "#00ff00" },
  { id: "blue", name: "Pure Blue (0,0,255)", desc: "Verify blue subpixel channel uniformity", kind: "solid", color: "#0000ff" },
  { id: "cyan", name: "Cyan (0,255,255)", desc: "Green + Blue combined subpixel check", kind: "solid", color: "#00ffff" },
  { id: "magenta", name: "Magenta (255,0,255)", desc: "Red + Blue combined subpixel check", kind: "solid", color: "#ff00ff" },
  { id: "yellow", name: "Yellow (255,255,0)", desc: "Red + Green combined subpixel check", kind: "solid", color: "#ffff00" },
  { id: "gray3", name: "Dark Gray 3% (OLED/Bleed)", desc: "Inspect near-black IPS glow & OLED vertical banding", kind: "solid", color: "#080808" },
  { id: "gray10", name: "Dark Gray 10% (Uniformity)", desc: "Inspect clouding & dirty-screen effect", kind: "solid", color: "#1a1a1a" },
  { id: "gray20", name: "Dark Gray 20% (Uniformity)", desc: "Inspect panel gray balance & uniformity", kind: "solid", color: "#333333" },
  { id: "gray50", name: "Mid Gray 50% (Tint/Burn-in)", desc: "Inspect color tinting & image retention", kind: "solid", color: "#808080" },
  { id: "gradient", name: "256-Step RGB & Gray Gradients", desc: "Check color bit-depth banding & smooth transitions", kind: "gradient" },
  { id: "contrast", name: "Contrast & Black-Level Steps", desc: "Verify dark shadow & highlight step separation", kind: "contrast" },
  { id: "gamma", name: "Gamma 1.8 / 2.2 / 2.4 Calibration", desc: "Check panel gamma balance against 50% dither bars", kind: "gamma" },
  { id: "pixelwalk", name: "1px Pixel-Walk / LCD Inversion", desc: "Check for flicker, shimmer, or column inversion noise", kind: "pixelwalk" },
  { id: "readability", name: "Sharpness & Font Matrix (6pt–16pt)", desc: "Verify crisp subpixel text clarity edge-to-edge", kind: "readability" },
  { id: "grid", name: "Geometry, Convergence & Aspect Grid", desc: "Check alignment, aspect circles & corner sharpness", kind: "grid" },
  { id: "motion", name: "Motion Clarity, Ghosting & Live Hz", desc: "Verify refresh rate, frame pacing & overdrive ghosting", kind: "motion" },
];

export const DisplayTestView: React.FC<DisplayTestViewProps> = ({
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const [active, setActive] = useState(false);
  const [idx, setIdx] = useState(0);
  const [viewedSet, setViewedSet] = useState<Set<number>>(new Set());
  const [showHud, setShowHud] = useState(true);
  const [measuredHz, setMeasuredHz] = useState<number>(60);
  const [droppedFrames, setDroppedFrames] = useState<number>(0);
  const [notes, setNotes] = useState(initialNotes);
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const enterFullscreen = async (startIdx = 0) => {
    setIdx(startIdx);
    setViewedSet((prev) => new Set(prev).add(startIdx));
    setActive(true);
    setShowHud(true);
    try {
      const win = getCurrentWindow();
      await win.setDecorations(false);
      await win.setAlwaysOnTop(true);
      await win.setFullscreen(true);
    } catch {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };

  const exitFullscreen = async () => {
    setActive(false);
    try {
      const win = getCurrentWindow();
      await win.setFullscreen(false);
      await win.setAlwaysOnTop(false);
      await win.setDecorations(true);
    } catch {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
  };

  useEffect(() => {
    return () => {
      // Safety restore window chrome if component unmounts while active
      if (active) {
        const win = getCurrentWindow();
        win.setFullscreen(false).catch(() => {});
        win.setAlwaysOnTop(false).catch(() => {});
        win.setDecorations(true).catch(() => {});
      }
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    setViewedSet((prev) => new Set(prev).add(idx));
  }, [active, idx]);

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

  // Motion & live Hz + dropped-frame loop
  useEffect(() => {
    if (!active || PATTERNS[idx].kind !== "motion") return;
    let raf = 0;
    let frames = 0;
    let lastTs = performance.now();
    let prevFrame = lastTs;
    let drops = 0;
    let x = 0;

    const tick = (now: number) => {
      frames++;
      const dt = now - prevFrame;
      prevFrame = now;
      if (dt > 34) drops++;

      if (now - lastTs >= 500) {
        setMeasuredHz(Math.round((frames * 1000) / (now - lastTs)));
        setDroppedFrames(drops);
        frames = 0;
        lastTs = now;
      }

      const canvas = motionCanvasRef.current;
      if (canvas) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, w, h);

          ctx.strokeStyle = "rgba(255,255,255,0.16)";
          for (let gx = 0; gx < w; gx += 80) {
            ctx.beginPath();
            ctx.moveTo(gx, 0);
            ctx.lineTo(gx, h);
            ctx.stroke();
          }

          x = (x + 14) % (w + 180);
          const lanes = [
            { y: h * 0.25, pos: (x * 0.6) % w, color: "#ffffff", label: "480 PX/S" },
            { y: h * 0.5, pos: x % w, color: "#2563eb", label: "960 PX/S" },
            { y: h * 0.75, pos: (x * 1.6) % w, color: "#60a5fa", label: "1536 PX/S" },
          ];
          for (const lane of lanes) {
            ctx.fillStyle = lane.color;
            ctx.fillRect(lane.pos - 50, lane.y - 28, 100, 56);
            ctx.fillStyle = lane.color === "#2563eb" ? "#ffffff" : "#000000";
            ctx.font = "bold 13px monospace";
            ctx.fillText(lane.label, lane.pos - 36, lane.y + 5);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, idx]);

  const pattern = PATTERNS[idx];

  const fullscreenOverlay = active
    ? createPortal(
        <div
          onClick={() => setIdx((i) => (i + 1) % PATTERNS.length)}
          onContextMenu={(e) => {
            e.preventDefault();
            exitFullscreen();
          }}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            margin: 0,
            padding: 0,
            zIndex: 999999,
            backgroundColor: pattern.kind === "solid" ? pattern.color : "#000000",
          }}
          className="cursor-pointer select-none overflow-hidden"
        >
          {pattern.kind === "gradient" && (
            <div className="w-full h-full flex flex-col">
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000000, #ffffff)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000000, #ff0000)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000000, #00ff00)" }} />
              <div className="flex-1" style={{ background: "linear-gradient(90deg, #000000, #0000ff)" }} />
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
                        ? `rgb(0,0,${v})`
                        : `rgb(${v},${v},255)`;
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

          {pattern.kind === "gamma" && (
            <div className="w-full h-full bg-black flex items-center justify-center gap-10 p-10">
              {[
                { label: "Gamma 1.8", gray: 174 },
                { label: "Gamma 2.2 (Target)", gray: 186 },
                { label: "Gamma 2.4", gray: 193 },
              ].map((g) => (
                <div key={g.label} className="flex flex-col items-center gap-3">
                  <div
                    className="w-56 h-72 flex items-center justify-center border border-white/40"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(0deg, #000000 0px, #000000 1px, #ffffff 1px, #ffffff 2px)",
                    }}
                  >
                    <div
                      className="w-28 h-36"
                      style={{ backgroundColor: `rgb(${g.gray},${g.gray},${g.gray})` }}
                    />
                  </div>
                  <div className="text-white font-mono text-xs">{g.label}</div>
                </div>
              ))}
            </div>
          )}

          {pattern.kind === "pixelwalk" && (
            <div
              className="w-full h-full"
              style={{
                backgroundImage:
                  "repeating-conic-gradient(#000000 0% 25%, #ffffff 0% 50%)",
                backgroundSize: "2px 2px",
              }}
            />
          )}

          {pattern.kind === "readability" && (
            <div className="w-full h-full grid grid-cols-2">
              <div className="bg-white text-black p-10 space-y-4 overflow-hidden">
                {[8, 10, 12, 14, 16, 18].map((pt) => (
                  <div key={pt} style={{ fontSize: `${pt}px`, lineHeight: 1.35 }}>
                    <strong>{pt}px:</strong> The quick brown fox jumps over the lazy dog 0123456789 — ABCDEFGHIJKLMNOPQRSTUVWXYZ — Subpixel Clarity Check
                  </div>
                ))}
              </div>
              <div className="bg-black text-white p-10 space-y-4 overflow-hidden">
                {[8, 10, 12, 14, 16, 18].map((pt) => (
                  <div key={pt} style={{ fontSize: `${pt}px`, lineHeight: 1.35 }}>
                    <strong>{pt}px:</strong> The quick brown fox jumps over the lazy dog 0123456789 — ABCDEFGHIJKLMNOPQRSTUVWXYZ — High-Contrast Inverse Check
                  </div>
                ))}
              </div>
            </div>
          )}

          {pattern.kind === "grid" && (
            <div
              className="w-full h-full relative"
              style={{
                backgroundColor: "#000000",
                backgroundImage:
                  "linear-gradient(to right, rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.5) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
            >
              {/* Corner alignment squares */}
              <div className="absolute top-0 left-0 w-24 h-24 border-2 border-blue-500" />
              <div className="absolute top-0 right-0 w-24 h-24 border-2 border-blue-500" />
              <div className="absolute bottom-0 left-0 w-24 h-24 border-2 border-blue-500" />
              <div className="absolute bottom-0 right-0 w-24 h-24 border-2 border-blue-500" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-80 h-80 rounded-full border-2 border-blue-500 flex items-center justify-center">
                  <div className="w-40 h-40 rounded-full border-2 border-white flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {pattern.kind === "motion" && (
            <canvas ref={motionCanvasRef} className="w-full h-full block" />
          )}

          {showHud && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-black/90 border border-white/25 rounded-xl px-5 py-3 text-xs text-white flex items-center gap-4 shadow-2xl"
            >
              <div>
                <div className="font-bold">
                  [{idx + 1}/{PATTERNS.length}] {pattern.name}
                  {pattern.kind === "motion" ? ` • ~${measuredHz} Hz (${droppedFrames} drops)` : ""}
                </div>
                <div className="text-zinc-300 text-[11px]">{pattern.desc}</div>
              </div>
              <div className="text-[11px] text-blue-400 font-mono whitespace-nowrap">
                Click / Space: Next • H: Hide HUD • Esc: Exit
              </div>
              <button
                onClick={exitFullscreen}
                className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold cursor-pointer"
              >
                Exit
              </button>
            </div>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="space-y-5">
      {fullscreenOverlay}

      <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-200">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-black text-white font-mono text-xs font-bold">
              0{stepNumber}
            </span>
            <h1 className="text-xl font-black text-black tracking-tight">
              Display Check (MonitorTest 19-Pattern Suite)
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            True edge-to-edge borderless fullscreen suite: dead/stuck pixels, OLED/IPS uniformity, 256-step gradients, Gamma 2.2, 1px LCD inversion, font sharpness, and motion Hz.
          </p>
        </div>
        <button
          onClick={() => enterFullscreen(0)}
          className="px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-2 cursor-pointer shadow-sm"
        >
          <Maximize2 className="w-4 h-4" />
          Launch True Fullscreen Test ({viewedSet.size}/{PATTERNS.length} Inspected)
        </button>
      </div>

      {/* Pattern Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
        {PATTERNS.map((p, i) => {
          const seen = viewedSet.has(i);
          return (
            <button
              key={p.id}
              onClick={() => enterFullscreen(i)}
              className={`rounded-xl border p-2.5 text-left transition cursor-pointer ${
                seen
                  ? "border-blue-600 bg-blue-50/40"
                  : "border-zinc-200 hover:border-black bg-white"
              }`}
            >
              <div
                className="h-9 rounded-lg border border-zinc-300 mb-2 flex items-center justify-center text-[10px] font-mono font-bold"
                style={{
                  background:
                    p.kind === "solid"
                      ? p.color
                      : p.kind === "gradient"
                      ? "linear-gradient(90deg, #000, #2563eb, #fff)"
                      : "#09090b",
                  color: p.color === "#ffffff" || p.color === "#ffff00" || p.color === "#00ffff" ? "#000" : "#fff",
                }}
              >
                {p.kind !== "solid" && p.kind.toUpperCase()}
              </div>
              <div className="text-[11px] font-bold text-black truncate">{p.name}</div>
              <div className="text-[10px] text-zinc-500 font-mono">
                {seen ? "Inspected" : `Pattern #${i + 1}`}
              </div>
            </button>
          );
        })}
      </div>

      {/* Verdict Panel */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm font-bold text-black">
            <Monitor className="w-4 h-4 text-blue-600" />
            Technician Visual Verdict
          </div>
          <span className="text-xs font-mono text-zinc-600">
            Patterns inspected: <strong className="text-blue-700">{viewedSet.size}</strong> / {PATTERNS.length}
          </span>
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional panel notes (e.g. 0 dead pixels, clean uniformity, 144Hz smooth)"
          className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() =>
              onVerdict(
                "pass",
                `Display verified (${viewedSet.size}/${PATTERNS.length} patterns checked, ~${measuredHz} Hz, 0 dead pixels).`,
                notes
              )
            }
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Display Check
          </button>
          <button
            onClick={() =>
              onVerdict(
                "warn",
                "Minor panel imperfection noted (slight backlight bleed or bright spot).",
                notes
              )
            }
            className="px-4 py-2 rounded-lg border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 font-bold text-xs cursor-pointer"
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
            className="px-4 py-2 rounded-lg bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <XCircle className="w-4 h-4" />
            Fail Display Check
          </button>
        </div>
      </div>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Launch fullscreen patterns and record Pass / Warn / Fail verdict to unlock the next step."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
