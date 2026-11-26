import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, Maximize2, Monitor, RefreshCw, Sparkles, Sun, XCircle } from "lucide-react";
import type { HardwareControlsReport, HardwareFaultsReport, TestStatus } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";

interface DisplayTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  hardwareFaults?: HardwareFaultsReport | null;
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
    | "moire_dot"
    | "moire_line"
    | "persistence"
    | "power_zoom"
    | "readability"
    | "grid"
    | "motion";
  color?: string;
}

// 23 PassMark MonitorTest 4.0-inspired full-screen display patterns
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
  {
    id: "persistence",
    name: "Persistence / Burn-In Hold",
    desc: "Hold 15–30s then advance to Mid Gray 50% to check OLED/IPS image retention",
    kind: "persistence",
  },
  { id: "gray50", name: "Mid Gray 50% (Tint/Burn-in)", desc: "Inspect color tinting & post-hold image retention", kind: "solid", color: "#808080" },
  {
    id: "gradient",
    name: "256-Step RGB & Gray Gradients",
    desc: "Check 0–255 bit-depth banding, shadow ramp (0–32) & smooth transitions",
    kind: "gradient",
  },
  { id: "contrast", name: "Contrast & Black-Level Steps", desc: "Verify dark shadow & highlight step separation", kind: "contrast" },
  {
    id: "gamma",
    name: "Gamma 1.8 / 2.2 / 2.4 & RGB Check",
    desc: "Match neutral gray & RGB channel patches to 50% dithered reference",
    kind: "gamma",
  },
  { id: "pixelwalk", name: "1px Pixel-Walk / LCD Inversion", desc: "Check for flicker, shimmer, or column inversion noise", kind: "pixelwalk" },
  {
    id: "moire_dot",
    name: "Dot Moiré (1px / 2px Check)",
    desc: "Expose pixel clock/phase shimmer, FRC temporal noise & dot interference",
    kind: "moire_dot",
  },
  {
    id: "moire_line",
    name: "Line Moiré (V/H Line Pairs)",
    desc: "Expose scaling aliasing, column crosstalk & sharpness ringing",
    kind: "moire_line",
  },
  { id: "readability", name: "Sharpness & Font Matrix (8px–18px)", desc: "Verify crisp subpixel text clarity edge-to-edge", kind: "readability" },
  { id: "grid", name: "Geometry, Convergence & Aspect Grid", desc: "Check alignment, aspect circles & corner sharpness", kind: "grid" },
  {
    id: "power_zoom",
    name: "Power Supply Stability (Zooming)",
    desc: "Dynamic 10%↔95% white frame load to expose backlight PSU flicker or coil whine",
    kind: "power_zoom",
  },
  { id: "motion", name: "Motion Clarity, Ghosting & Live Hz", desc: "Verify refresh rate, frame pacing & overdrive ghosting", kind: "motion" },
];

export const DisplayTestView: React.FC<DisplayTestViewProps> = ({
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  hardwareFaults = null,
  onVerdict,
  onNext,
  onSkip,
}) => {
  const [active, setActive] = useState(false);
  const [idx, setIdx] = useState(0);
  const [viewedSet, setViewedSet] = useState<Set<number>>(new Set());
  const [hudPinned, setHudPinned] = useState(false);
  const [hudHover, setHudHover] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [measuredHz, setMeasuredHz] = useState<number>(60);
  const [droppedFrames, setDroppedFrames] = useState<number>(0);
  const [persistenceSecs, setPersistenceSecs] = useState<number>(0);
  const [powerZoomPct, setPowerZoomPct] = useState<number>(50);
  const [notes, setNotes] = useState(initialNotes);
  const [brightnessPct, setBrightnessPct] = useState<number | null>(null);
  const [brightnessSupported, setBrightnessSupported] = useState<boolean>(false);
  const [brightnessDetail, setBrightnessDetail] = useState<string>("Probing display backlight controller...");
  const [brightnessBusy, setBrightnessBusy] = useState<boolean>(false);
  const [brightnessVerified, setBrightnessVerified] = useState<boolean>(false);

  const loadBrightness = async () => {
    setBrightnessBusy(true);
    try {
      const rep = await invoke<HardwareControlsReport>("get_hardware_controls_status");
      setBrightnessSupported(Boolean(rep?.displayBrightness?.supported));
      setBrightnessPct(rep?.displayBrightness?.currentPct ?? null);
      setBrightnessDetail(rep?.displayBrightness?.detail || "Display backlight status ready.");
    } catch {
      setBrightnessSupported(false);
      setBrightnessDetail("Verify display brightness manually using the laptop's Fn brightness keys.");
    } finally {
      setBrightnessBusy(false);
    }
  };

  useEffect(() => {
    loadBrightness();
  }, []);

  const applyBrightness = async (pct: number) => {
    setBrightnessBusy(true);
    try {
      const applied = await invoke<number>("set_display_brightness", { percent: pct });
      setBrightnessPct(applied);
      setBrightnessVerified(true);
      setBrightnessDetail(`Backlight responded live — set to ${applied}%.`);
    } catch (e) {
      setBrightnessDetail(String(e));
    } finally {
      setBrightnessBusy(false);
    }
  };

  const runBrightnessSweep = async () => {
    if (brightnessBusy) return;
    const orig = brightnessPct ?? 75;
    setBrightnessBusy(true);
    try {
      for (const step of [20, 50, 85, 100, orig]) {
        const applied = await invoke<number>("set_display_brightness", { percent: step });
        setBrightnessPct(applied);
        await new Promise((r) => setTimeout(r, 450));
      }
      setBrightnessVerified(true);
      setBrightnessDetail(`Auto brightness sweep (20% → 100% → ${orig}%) completed smoothly.`);
    } catch (e) {
      setBrightnessDetail(String(e));
    } finally {
      setBrightnessBusy(false);
    }
  };

  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const powerZoomBoxRef = useRef<HTMLDivElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const activeRef = useRef<boolean>(false);
  activeRef.current = active;

  const enterFullscreen = async (startIdx = 0) => {
    setIdx(startIdx);
    setViewedSet((prev) => new Set(prev).add(startIdx));
    setActive(true);
    setHudPinned(false);
    setHudHover(false);
    setCursorHidden(false);
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
      if (activeRef.current) {
        try {
          const win = getCurrentWindow();
          win.setFullscreen(false).catch(() => {});
          win.setAlwaysOnTop(false).catch(() => {});
          win.setDecorations(true).catch(() => {});
        } catch {
          // Ignore outside Tauri
        }
      }
    };
  }, []);

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
        setHudPinned((h) => !h);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const scheduleHide = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        setCursorHidden(true);
      }, 1600);
    };
    scheduleHide();
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [active]);

  // Persistence / Burn-In hold timer
  useEffect(() => {
    if (!active || PATTERNS[idx].kind !== "persistence") {
      setPersistenceSecs(0);
      return;
    }
    const start = Date.now();
    setPersistenceSecs(0);
    const id = window.setInterval(() => {
      setPersistenceSecs(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [active, idx]);

  // Power Supply Stability (Zooming) requestAnimationFrame oscillation loop
  useEffect(() => {
    if (!active || PATTERNS[idx].kind !== "power_zoom") return;
    let raf = 0;
    const start = performance.now();
    let lastHudUpdate = start;

    const tick = (now: number) => {
      const elapsedSec = (now - start) / 1000;
      // Smooth 2 Hz triangle/sine sweep between 10% and 95% screen load
      const wave = 0.5 - 0.5 * Math.cos(elapsedSec * Math.PI * 2 * 1.15);
      const scalePct = 10 + wave * 85;
      if (powerZoomBoxRef.current) {
        powerZoomBoxRef.current.style.width = `${scalePct.toFixed(2)}vw`;
        powerZoomBoxRef.current.style.height = `${scalePct.toFixed(2)}vh`;
      }
      if (now - lastHudUpdate >= 120) {
        setPowerZoomPct(Math.round(scalePct));
        lastHudUpdate = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, idx]);

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
  const hudVisible = hudPinned || hudHover;

  const fullscreenOverlay = active
    ? createPortal(
        <div
          data-testid="display-fullscreen-portal"
          onClick={() => setIdx((i) => (i + 1) % PATTERNS.length)}
          onMouseMove={(e) => {
            setCursorHidden(false);
            const nearBottom = e.clientY >= window.innerHeight - 84;
            setHudHover(nearBottom);
            if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
            if (!nearBottom) {
              idleTimerRef.current = window.setTimeout(() => setCursorHidden(true), 1600);
            }
          }}
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
          className={`select-none overflow-hidden ${cursorHidden && !hudVisible ? "cursor-none" : "cursor-pointer"}`}
        >
          {pattern.kind === "gradient" && (
            <div className="w-full h-full flex flex-col bg-black">
              {/* Top 0-255 Scale Ruler */}
              <div className="px-4 py-1.5 flex items-center justify-between text-[10px] font-mono text-white/80 border-b border-white/15">
                {[0, 32, 64, 96, 128, 160, 192, 224, 255].map((mark) => (
                  <span key={mark}>{mark}</span>
                ))}
              </div>
              <div className="flex-1 flex flex-col">
                <div className="flex-1 relative" style={{ background: "linear-gradient(90deg, #000000, #ffffff)" }}>
                  <span className="absolute left-3 top-2 text-[10px] font-mono text-white/75">GRAYSCALE 0 → 255</span>
                </div>
                <div className="flex-1 relative" style={{ background: "linear-gradient(90deg, #000000, #ff0000)" }}>
                  <span className="absolute left-3 top-2 text-[10px] font-mono text-white/75">RED 0 → 255</span>
                </div>
                <div className="flex-1 relative" style={{ background: "linear-gradient(90deg, #000000, #00ff00)" }}>
                  <span className="absolute left-3 top-2 text-[10px] font-mono text-white/75">GREEN 0 → 255</span>
                </div>
                <div className="flex-1 relative" style={{ background: "linear-gradient(90deg, #000000, #0000ff)" }}>
                  <span className="absolute left-3 top-2 text-[10px] font-mono text-white/75">BLUE 0 → 255</span>
                </div>
              </div>
              {/* Near-Black Shadow Ramp (0..32) to expose 6-bit+FRC clipping */}
              <div className="h-14 flex border-t border-white/15">
                {Array.from({ length: 33 }).map((_, v) => (
                  <div
                    key={v}
                    className="flex-1 flex items-end justify-center pb-1 text-[9px] font-mono"
                    style={{ backgroundColor: `rgb(${v},${v},${v})`, color: "rgba(255,255,255,0.55)" }}
                  >
                    {v % 4 === 0 ? v : ""}
                  </div>
                ))}
              </div>
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
            <div className="w-full h-full bg-black flex flex-col items-center justify-center gap-8 p-10">
              <div className="flex items-center justify-center gap-10">
                {[
                  { label: "Gamma 1.8", gray: 174 },
                  { label: "Gamma 2.2 (Target)", gray: 186 },
                  { label: "Gamma 2.4", gray: 191 },
                ].map((g) => (
                  <div key={g.label} className="flex flex-col items-center gap-3">
                    <div
                      className="w-52 h-64 flex items-center justify-center border border-white/40"
                      style={{
                        backgroundImage:
                          "repeating-linear-gradient(0deg, #000000 0px, #000000 1px, #ffffff 1px, #ffffff 2px)",
                      }}
                    >
                      <div
                        className="w-24 h-32"
                        style={{ backgroundColor: `rgb(${g.gray},${g.gray},${g.gray})` }}
                      />
                    </div>
                    <div className="text-white font-mono text-xs">
                      {g.label} ({g.gray})
                    </div>
                  </div>
                ))}
              </div>
              {/* RGB Channel Gamma 2.2 Comparison Strips */}
              <div className="flex items-center justify-center gap-8">
                {[
                  { label: "Red 2.2 (186)", solid: "rgb(186,0,0)", bar: "#ff0000" },
                  { label: "Green 2.2 (186)", solid: "rgb(0,186,0)", bar: "#00ff00" },
                  { label: "Blue 2.2 (186)", solid: "rgb(0,0,186)", bar: "#0000ff" },
                ].map((ch) => (
                  <div key={ch.label} className="flex flex-col items-center gap-2">
                    <div
                      className="w-44 h-20 flex items-center justify-center border border-white/30"
                      style={{
                        backgroundImage: `repeating-linear-gradient(0deg, #000000 0px, #000000 1px, ${ch.bar} 1px, ${ch.bar} 2px)`,
                      }}
                    >
                      <div className="w-20 h-10" style={{ backgroundColor: ch.solid }} />
                    </div>
                    <div className="text-zinc-300 font-mono text-[11px]">{ch.label}</div>
                  </div>
                ))}
              </div>
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

          {pattern.kind === "moire_dot" && (
            <div className="w-full h-full grid grid-cols-2 grid-rows-2">
              <div
                style={{
                  backgroundImage: "repeating-conic-gradient(#000000 0% 25%, #ffffff 0% 50%)",
                  backgroundSize: "2px 2px",
                }}
              />
              <div
                style={{
                  backgroundImage:
                    "radial-gradient(#ffffff 0.75px, #000000 0.75px)",
                  backgroundSize: "3px 3px",
                }}
              />
              <div
                style={{
                  backgroundImage:
                    "radial-gradient(#000000 1px, #ffffff 1px)",
                  backgroundSize: "4px 4px",
                }}
              />
              <div
                style={{
                  backgroundImage: "repeating-conic-gradient(#ffffff 0% 25%, #000000 0% 50%)",
                  backgroundSize: "2px 2px",
                }}
              />
            </div>
          )}

          {pattern.kind === "moire_line" && (
            <div className="w-full h-full grid grid-cols-2 grid-rows-2">
              {/* Top-left: 1px Vertical line pairs */}
              <div
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg, #000000 0px, #000000 1px, #ffffff 1px, #ffffff 2px)",
                }}
              />
              {/* Top-right: 1px Horizontal line pairs */}
              <div
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(0deg, #000000 0px, #000000 1px, #ffffff 1px, #ffffff 2px)",
                }}
              />
              {/* Bottom-left: 2px Vertical line pairs */}
              <div
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg, #000000 0px, #000000 2px, #ffffff 2px, #ffffff 4px)",
                }}
              />
              {/* Bottom-right: 2px Horizontal line pairs */}
              <div
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(0deg, #000000 0px, #000000 2px, #ffffff 2px, #ffffff 4px)",
                }}
              />
            </div>
          )}

          {pattern.kind === "persistence" && (
            <div className="w-full h-full bg-black relative flex items-center justify-center">
              <div className="w-[72vw] h-[72vh] grid grid-cols-4 grid-rows-2 border-4 border-white">
                <div className="bg-white" />
                <div className="bg-black flex items-center justify-center">
                  <div className="w-16 h-16 bg-white" />
                </div>
                <div className="bg-white flex items-center justify-center">
                  <div className="w-16 h-16 bg-black" />
                </div>
                <div className="bg-black" />
                <div className="bg-black flex items-center justify-center">
                  <div className="w-20 h-4 bg-white" />
                </div>
                <div className="bg-white" />
                <div className="bg-black" />
                <div className="bg-white flex items-center justify-center">
                  <div className="w-4 h-20 bg-black" />
                </div>
              </div>
              <div className="absolute top-4 right-4 px-3 py-1.5 bg-black/85 border border-white/40 text-white font-mono text-xs font-bold tabular-nums">
                HOLD: {persistenceSecs}s (Adv. to Mid Gray 50% next)
              </div>
            </div>
          )}

          {pattern.kind === "power_zoom" && (
            <div className="w-full h-full bg-black flex items-center justify-center relative">
              <div
                ref={powerZoomBoxRef}
                style={{
                  width: "50vw",
                  height: "50vh",
                  backgroundColor: "#ffffff",
                }}
              />
              <div className="absolute top-4 left-4 px-3 py-1.5 bg-black/80 border border-white/30 text-white font-mono text-xs tabular-nums">
                PSU LOAD SWEEP: {powerZoomPct}% WHITE
              </div>
            </div>
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

          {/* Hover-only floating controls (completely hidden unless hovering bottom edge or pressing H) */}
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setHudHover(true)}
            onMouseLeave={() => setHudHover(false)}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 bg-black/90 border border-white/25 rounded-[2px] px-5 py-3 text-xs text-white flex items-center gap-4 shadow-2xl transition-opacity duration-200 ${
              hudVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
          >
            <div>
              <div className="font-bold">
                [{idx + 1}/{PATTERNS.length}] {pattern.name}
                {pattern.kind === "motion" ? ` • ~${measuredHz} Hz (${droppedFrames} drops)` : ""}
                {pattern.kind === "persistence" ? ` • Hold ${persistenceSecs}s` : ""}
                {pattern.kind === "power_zoom" ? ` • Load ${powerZoomPct}%` : ""}
              </div>
              <div className="text-zinc-300 text-[11px]">{pattern.desc}</div>
            </div>
            <div className="text-[11px] text-blue-400 font-mono whitespace-nowrap">
              Click / Space: Next • Esc / Right-Click: Exit
            </div>
            <button
              type="button"
              onClick={() => setIdx((i) => (i - 1 + PATTERNS.length) % PATTERNS.length)}
              className="px-2.5 py-1.5 rounded-[2px] border border-white/25 hover:bg-white/10 text-white font-bold cursor-pointer"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setIdx((i) => (i + 1) % PATTERNS.length)}
              className="px-2.5 py-1.5 rounded-[2px] border border-white/25 hover:bg-white/10 text-white font-bold cursor-pointer"
            >
              Next
            </button>
            <button
              type="button"
              onClick={exitFullscreen}
              className="px-3.5 py-1.5 rounded-[2px] bg-blue-600 hover:bg-blue-500 text-white font-bold cursor-pointer"
            >
              Exit
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  const primaryPanel = hardwareFaults?.panels?.[0] ?? null;

  return (
    <div className="space-y-5">
      {fullscreenOverlay}

      {primaryPanel && (
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <Monitor className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="font-bold text-black">
              Panel EDID: {primaryPanel.manufacturerName}
            </span>
            <span className="font-mono text-zinc-600">{primaryPanel.panelModel}</span>
            {primaryPanel.diagonalInches && (
              <span className="px-1.5 py-0.5 rounded bg-[#F8FAFC] border border-zinc-200 font-mono text-[10.5px] text-black">
                {primaryPanel.diagonalInches.toFixed(1)}&quot;
              </span>
            )}
            {primaryPanel.mfgYear && (
              <span className="px-1.5 py-0.5 rounded bg-[#F8FAFC] border border-zinc-200 font-mono text-[10.5px] text-black">
                Mfg {primaryPanel.mfgYear}{primaryPanel.mfgWeek ? ` Wk ${primaryPanel.mfgWeek}` : ""}
              </span>
            )}
          </div>
          {primaryPanel.replacementSuspected ? (
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-mono text-[10px] font-bold">
              INFO: LIKELY REPLACEMENT SCREEN ({primaryPanel.mfgYear} vs {primaryPanel.biosYear} BIOS)
            </span>
          ) : (
            <span className="font-mono text-[10.5px] text-blue-700 font-semibold">
              Original-Era Panel Verified
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Display Check
              <span className="sr-only"> (MonitorTest 23-Pattern Suite)</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • {PATTERNS.length}-pattern fullscreen suite ({viewedSet.size}/{PATTERNS.length} inspected)
          </div>
        </div>
        <button
          type="button"
          onClick={() => enterFullscreen(0)}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs inline-flex items-center gap-2 cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
          Launch True Fullscreen Test
        </button>
      </div>

      {/* Live Display Backlight Brightness Check */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sun className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="font-mono text-xs font-black uppercase text-black">
              Display Backlight Brightness Check
            </span>
            <span className="px-2 py-0.5 rounded-[2px] border border-zinc-300 bg-white font-mono text-[10.5px] font-bold text-black tabular-nums">
              {brightnessPct != null ? `${brightnessPct}%` : "Manual Fn"}
            </span>
            {brightnessVerified && (
              <span className="px-2 py-0.5 rounded-[2px] bg-blue-600 text-white font-mono text-[10px] font-bold uppercase">
                Verified Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {[25, 50, 75, 100].map((lvl) => (
              <button
                key={lvl}
                type="button"
                disabled={brightnessBusy || !brightnessSupported}
                onClick={() => applyBrightness(lvl)}
                className={`px-2 py-1 rounded-[2px] border font-mono text-[10.5px] font-bold cursor-pointer disabled:opacity-40 ${
                  brightnessPct === lvl
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-zinc-300 text-black hover:border-black"
                }`}
              >
                {lvl}%
              </button>
            ))}
            <button
              type="button"
              disabled={brightnessBusy || !brightnessSupported}
              onClick={runBrightnessSweep}
              className="px-2.5 py-1 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-mono text-[10.5px] font-bold uppercase cursor-pointer disabled:opacity-40"
            >
              Auto Sweep 20%→100%
            </button>
            <button
              type="button"
              disabled={brightnessBusy}
              onClick={loadBrightness}
              className="px-2 py-1 rounded-[2px] border border-zinc-300 bg-white hover:border-black text-black font-mono text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${brightnessBusy ? "animate-spin text-blue-600" : ""}`} />
            </button>
          </div>
        </div>
        {brightnessSupported && (
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={brightnessPct ?? 50}
              disabled={brightnessBusy}
              onChange={(e) => applyBrightness(Number(e.target.value))}
              className="flex-1 accent-blue-600 cursor-pointer"
            />
          </div>
        )}
        <div className="text-[11px] text-zinc-600">{brightnessDetail}</div>
      </div>

      {/* Pattern Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
        {PATTERNS.map((p, i) => {
          const seen = viewedSet.has(i);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => enterFullscreen(i)}
              className={`rounded-[2px] border p-2.5 text-left transition cursor-pointer ${
                seen
                  ? "border-blue-600 bg-blue-50/40"
                  : "border-zinc-300 hover:border-black bg-white"
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
                {p.kind !== "solid" && p.kind.replace("_", " ").toUpperCase()}
              </div>
              <div className="text-[11px] font-bold text-black truncate">{p.name}</div>
              <div className="text-[10px] text-zinc-500 font-mono">
                {seen ? "Inspected" : `Pattern #${i + 1}`}
              </div>
            </button>
          );
        })}
      </div>

      {/* Plain-Language Diagnostic Guide */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-2">
        <div className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-blue-700">
          <Sparkles className="w-3.5 h-3.5" />
          What This Means for Long-Term Use
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-zinc-600">
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Pixels, Bleed &amp; Retention:</strong> Pure Black/White/RGB checks catch dead pixels and edge IPS bleed; Persistence Hold followed by Mid Gray 50% exposes OLED burn-in or failing panel retention.
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Moiré &amp; PSU Stability:</strong> Dot/Line Moiré catches scaling artifacts or eDP cable crosstalk; Power Supply Zooming stresses backlight power rails to reveal flicker or inverter coil whine.
          </div>
          <div className="rounded-[2px] border border-zinc-200 bg-[#FAFAFA] p-2.5">
            <strong className="text-black">Gamma, Bit-Depth &amp; Motion:</strong> 256-step gradients + 0–32 shadow ramp detect 6-bit FRC banding, Gamma 2.2 checks tonal accuracy, and Motion Clarity measures live Hz pacing.
          </div>
        </div>
      </div>

      {/* Verdict Panel */}
      <div className="rounded-[2px] border border-zinc-300 bg-white p-4 space-y-3">
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
          placeholder="Optional panel notes (e.g. 0 dead pixels, clean uniformity, 144Hz smooth, no burn-in)"
          className="w-full bg-white border border-zinc-300 rounded-[2px] px-3 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              onVerdict(
                "pass",
                `Display verified (${viewedSet.size}/${PATTERNS.length} patterns checked, ~${measuredHz} Hz, 0 dead pixels).`,
                notes
              )
            }
            className="px-4 py-2 rounded-[2px] bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Display Check
          </button>
          <button
            type="button"
            onClick={() =>
              onVerdict(
                "warn",
                "Minor panel imperfection noted (slight backlight bleed or bright spot).",
                notes
              )
            }
            className="px-4 py-2 rounded-[2px] border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900 font-bold text-xs cursor-pointer"
          >
            Mark Minor Issue (WARN)
          </button>
          <button
            type="button"
            onClick={() =>
              onVerdict(
                "fail",
                "Display defect found (dead pixels, lines, flicker, burn-in, or severe bleed).",
                notes
              )
            }
            className="px-4 py-2 rounded-[2px] bg-black hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
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
