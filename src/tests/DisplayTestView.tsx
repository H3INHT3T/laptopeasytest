import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Maximize2,
  Monitor,
  Play,
  RefreshCw,
  Square,
  Sun,
  XCircle,
} from "lucide-react";
import type {
  DisplayCapabilitiesReport,
  DisplayProResult,
  EdpHingeFlexProgress,
  EdpHingeFlexResult,
  HardwareControlsReport,
  HardwareFaultsReport,
  TestStatus,
} from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { StepActionBar } from "../components/StepActionBar";
import { TechnicalDetailsDrawer } from "../components/TechnicalDetailsDrawer";

interface DisplayTestViewProps {
  status: TestStatus;
  notes: string;
  stepNumber: number;
  totalSteps: number;
  hardwareFaults?: HardwareFaultsReport | null;
  displayProResult?: DisplayProResult | null;
  onDisplayProUpdate?: (res: DisplayProResult) => void;
  onVerdict: (status: TestStatus, summary: string, notes: string, pro?: DisplayProResult) => void;
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
    | "motion"
    | "frameskip";
  color?: string;
}

// 24 PassMark MonitorTest + BlurBusters Pro full-screen display patterns
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
  { id: "motion", name: "UFO Motion Clarity, Live Hz & Jitter", desc: "Delta-time UFO pursuit lanes with panel-Hz-aware frame-drop & jitter audit", kind: "motion" },
  { id: "frameskip", name: "Frame-Skip Camera Grid (120–240Hz)", desc: "Sequential 1-square-per-VSync grid — snap a 1/10s phone photo to prove zero skipped frames", kind: "frameskip" },
];

export const DisplayTestView: React.FC<DisplayTestViewProps> = ({
  status,
  notes: initialNotes,
  stepNumber,
  totalSteps,
  hardwareFaults = null,
  displayProResult = null,
  onDisplayProUpdate,
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
  const [measuredHz, setMeasuredHz] = useState<number>(displayProResult?.measuredHz ?? 60);
  const [avgFrameMs, setAvgFrameMs] = useState<number>(displayProResult?.avgFrameTimeMs ?? 16.7);
  const [frameJitterMs, setFrameJitterMs] = useState<number>(displayProResult?.frameJitterMs ?? 0);
  const [droppedFrames, setDroppedFrames] = useState<number>(displayProResult?.droppedFrames ?? 0);
  const [persistenceSecs, setPersistenceSecs] = useState<number>(0);
  const [powerZoomPct, setPowerZoomPct] = useState<number>(50);
  const [notes, setNotes] = useState(initialNotes);
  const [brightnessPct, setBrightnessPct] = useState<number | null>(null);
  const [brightnessSupported, setBrightnessSupported] = useState<boolean>(false);
  const [brightnessDetail, setBrightnessDetail] = useState<string>("Probing display backlight controller...");
  const [brightnessBusy, setBrightnessBusy] = useState<boolean>(false);
  const [brightnessVerified, setBrightnessVerified] = useState<boolean>(false);

  // Display Pro capabilities, eDP Hinge-Flex monitor & structured defect state (v2.11.0)
  const [displayCaps, setDisplayCaps] = useState<DisplayCapabilitiesReport | null>(null);
  const [hingeRunning, setHingeRunning] = useState<boolean>(false);
  const [hingeProg, setHingeProg] = useState<EdpHingeFlexProgress | null>(null);
  const [hingeResult, setHingeResult] = useState<EdpHingeFlexResult | null>(displayProResult?.hingeFlex ?? null);
  const [hingeError, setHingeError] = useState<string | null>(null);
  const [deadPixels, setDeadPixels] = useState<number>(displayProResult?.deadPixels ?? 0);
  const [stuckPixels, setStuckPixels] = useState<number>(displayProResult?.stuckPixels ?? 0);
  const [bleedSeverity, setBleedSeverity] = useState<"none" | "minor" | "severe">(displayProResult?.bleedSeverity ?? "none");
  const [bleedCorners, setBleedCorners] = useState<string[]>(displayProResult?.bleedCorners ?? []);
  const [pressureSpots, setPressureSpots] = useState<boolean>(displayProResult?.pressureSpots ?? false);
  const [flickerOrGhosting, setFlickerOrGhosting] = useState<boolean>(displayProResult?.flickerOrGhosting ?? false);

  const loadCapabilities = async () => {
    try {
      const caps = await invoke<DisplayCapabilitiesReport>("probe_display_capabilities");
      setDisplayCaps(caps);
      if (caps.activeHz > 0 && !displayProResult) {
        setMeasuredHz(caps.activeHz);
        setAvgFrameMs(Number((1000 / caps.activeHz).toFixed(2)));
      }
    } catch {
      // Ignore outside Tauri
    }
  };

  useEffect(() => {
    loadCapabilities();
    let unlistenHinge: (() => void) | null = null;
    listen<EdpHingeFlexProgress>("display:hinge", (ev) => {
      setHingeProg(ev.payload);
    }).then((fn) => {
      unlistenHinge = fn;
    });
    return () => {
      if (unlistenHinge) unlistenHinge();
    };
  }, []);

  const startHingeFlexTest = async () => {
    setHingeError(null);
    setHingeRunning(true);
    setHingeProg(null);
    try {
      const res = await invoke<EdpHingeFlexResult>("run_edp_hinge_flex_test", { durationSecs: 15 });
      setHingeResult(res);
    } catch (e) {
      setHingeError(String(e));
    } finally {
      setHingeRunning(false);
    }
  };

  const toggleBleedCorner = (corner: string) => {
    setBleedCorners((prev) =>
      prev.includes(corner) ? prev.filter((c) => c !== corner) : [...prev, corner]
    );
  };

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
  const frameSkipCanvasRef = useRef<HTMLCanvasElement | null>(null);
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

  // Delta-time UFO Motion Clarity + Panel-Hz-Aware Frame-Drop & Jitter loop (v2.11.0)
  useEffect(() => {
    const kind = PATTERNS[idx]?.kind;
    if (!active || (kind !== "motion" && kind !== "frameskip")) return;
    let raf = 0;
    let frames = 0;
    let totalFrameIdx = 0;
    let lastTs = performance.now();
    let prevFrame = lastTs;
    let drops = 0;
    const dtSamples: number[] = [];
    const expectedMsRef = { val: displayCaps?.activeHz && displayCaps.activeHz >= 30 ? 1000 / displayCaps.activeHz : 16.67 };
    const lanePos = [0, 0, 0];

    const tick = (now: number) => {
      frames++;
      totalFrameIdx++;
      const dt = Math.min(250, Math.max(0.5, now - prevFrame));
      prevFrame = now;

      if (totalFrameIdx > 5) {
        dtSamples.push(dt);
        if (dtSamples.length > 180) dtSamples.shift();
        const dropThreshold = Math.max(10.5, expectedMsRef.val * 1.65);
        if (dt > dropThreshold) drops++;
      }

      if (now - lastTs >= 500) {
        const hz = Math.round((frames * 1000) / (now - lastTs));
        if (hz >= 24 && hz <= 480) {
          expectedMsRef.val = 1000 / hz;
          setMeasuredHz(hz);
        }
        if (dtSamples.length >= 4) {
          const avg = dtSamples.reduce((a, b) => a + b, 0) / dtSamples.length;
          const variance =
            dtSamples.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / dtSamples.length;
          setAvgFrameMs(Number(avg.toFixed(2)));
          setFrameJitterMs(Number(Math.sqrt(variance).toFixed(2)));
        }
        setDroppedFrames(drops);
        frames = 0;
        lastTs = now;
      }

      if (kind === "motion") {
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
            const bandH = h / 3;
            // 3 contrast backgrounds (Dark, Mid-Gray, Light) to catch dark-smear VA & IPS overdrive ghosting
            const bands = [
              { bg: "#09090b", speed: 480, color: "#ffffff", label: "480 PX/S (DARK)", textCol: "#09090b" },
              { bg: "#27272a", speed: 960, color: "#2563eb", label: "960 PX/S (MID)", textCol: "#ffffff" },
              { bg: "#e4e4e7", speed: 1440, color: "#09090b", label: "1440 PX/S (LIGHT)", textCol: "#ffffff" },
            ];
            for (let i = 0; i < bands.length; i++) {
              const b = bands[i];
              const y0 = i * bandH;
              ctx.fillStyle = b.bg;
              ctx.fillRect(0, y0, w, bandH);

              // Subtle vertical reference ruler lines
              ctx.strokeStyle = i === 2 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.12)";
              for (let gx = 0; gx < w; gx += 80) {
                ctx.beginPath();
                ctx.moveTo(gx, y0);
                ctx.lineTo(gx, y0 + bandH);
                ctx.stroke();
              }

              lanePos[i] = (lanePos[i] + b.speed * (dt / 1000)) % (w + 160);
              const px = lanePos[i] - 80;
              const cy = y0 + bandH * 0.5;

              // Draw crisp UFO saucer + alignment bars (BlurBusters pursuit style)
              ctx.fillStyle = b.color;
              ctx.fillRect(px - 60, cy - 26, 120, 52);
              ctx.fillStyle = i === 1 ? "#93c5fd" : "#2563eb";
              ctx.fillRect(px - 44, cy - 16, 14, 32);
              ctx.fillRect(px + 30, cy - 16, 14, 32);
              ctx.fillStyle = b.textCol;
              ctx.font = "bold 11px monospace";
              ctx.fillText(b.label, px - 24, cy + 4);
            }

            // Live Hz / Frame-time readout badge (top-left, unobtrusive)
            ctx.fillStyle = "rgba(9,9,11,0.85)";
            ctx.fillRect(16, 16, 390, 34);
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 12px monospace";
            ctx.fillText(
              `LIVE ${Math.round(1000 / expectedMsRef.val)} Hz | ${expectedMsRef.val.toFixed(1)} ms | Drops: ${drops}`,
              28,
              37
            );
          }
        }
      } else if (kind === "frameskip") {
        const canvas = frameSkipCanvasRef.current;
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

            const cols = 8;
            const rows = 4;
            const totalCells = cols * rows;
            const activeCell = totalFrameIdx % totalCells;
            const padX = Math.max(40, w * 0.1);
            const padY = Math.max(70, h * 0.16);
            const cellW = (w - padX * 2) / cols;
            const cellH = (h - padY * 2) / rows;

            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 14px monospace";
            ctx.fillText(
              `FRAME-SKIP TEST GRID (1 SQUARE PER VSYNC) • ~${Math.round(1000 / expectedMsRef.val)} Hz • TAKE 1/10s PHOTO: ALL LIT SQUARES MUST BE CONTIGUOUS`,
              padX,
              padY - 22
            );

            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const cellNum = r * cols + c;
                const x0 = padX + c * cellW;
                const y0 = padY + r * cellH;
                const isLit = cellNum === activeCell;
                ctx.fillStyle = isLit ? "#ffffff" : "#09090b";
                ctx.fillRect(x0 + 4, y0 + 4, cellW - 8, cellH - 8);
                ctx.strokeStyle = isLit ? "#2563eb" : "rgba(255,255,255,0.22)";
                ctx.lineWidth = isLit ? 3 : 1;
                ctx.strokeRect(x0 + 4, y0 + 4, cellW - 8, cellH - 8);
                ctx.fillStyle = isLit ? "#000000" : "rgba(255,255,255,0.35)";
                ctx.font = "bold 18px monospace";
                ctx.fillText(String(cellNum + 1).padStart(2, "0"), x0 + cellW * 0.5 - 12, y0 + cellH * 0.5 + 6);
              }
            }
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, idx, displayCaps?.activeHz]);

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

          {pattern.kind === "frameskip" && (
            <canvas ref={frameSkipCanvasRef} className="w-full h-full block" />
          )}

          {/* Hover-only floating controls (completely hidden unless hovering bottom edge or pressing H) */}
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setHudHover(true)}
            onMouseLeave={() => setHudHover(false)}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 bg-black/90 border border-white/25 rounded-lg px-5 py-3 text-xs text-white flex items-center gap-4 shadow-2xl transition-opacity duration-200 ${
              hudVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            }`}
          >
            <div>
              <div className="font-bold">
                [{idx + 1}/{PATTERNS.length}] {pattern.name}
                {pattern.kind === "motion" || pattern.kind === "frameskip"
                  ? ` • ~${measuredHz} Hz (${avgFrameMs.toFixed(1)}ms, ±${frameJitterMs.toFixed(1)}ms, ${droppedFrames} drops)`
                  : ""}
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
              className="px-2.5 py-1.5 rounded-lg border border-white/25 hover:bg-white/10 text-white font-bold cursor-pointer"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setIdx((i) => (i + 1) % PATTERNS.length)}
              className="px-2.5 py-1.5 rounded-lg border border-white/25 hover:bg-white/10 text-white font-bold cursor-pointer"
            >
              Next
            </button>
            <button
              type="button"
              onClick={exitFullscreen}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold cursor-pointer"
            >
              Exit
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  const primaryPanel = hardwareFaults?.panels?.[0] ?? null;

  // Smart Shop Standard Auto-Suggested Verdict (always overridable by technician)
  const totalPixelDefects = deadPixels + stuckPixels;
  const edpDropDetected = hingeResult?.verdict === "EDP_DROP_DETECTED";
  const maxHzMismatch = Boolean(displayCaps?.maxHzMismatch);

  const suggestedVerdict: { status: TestStatus; reason: string } = (() => {
    if (edpDropDetected || totalPixelDefects >= 3 || bleedSeverity === "severe" || flickerOrGhosting) {
      const reasons: string[] = [];
      if (edpDropDetected) reasons.push("eDP hinge cable drop detected");
      if (totalPixelDefects >= 3) reasons.push(`${totalPixelDefects} dead/stuck pixels`);
      if (bleedSeverity === "severe") reasons.push("severe backlight bleed");
      if (flickerOrGhosting) reasons.push("flicker or severe ghosting");
      return { status: "fail", reason: `Suggested FAIL: ${reasons.join(", ")}.` };
    }
    if (totalPixelDefects > 0 || bleedSeverity === "minor" || pressureSpots || maxHzMismatch) {
      const reasons: string[] = [];
      if (totalPixelDefects > 0) reasons.push(`${totalPixelDefects} minor pixel defect(s)`);
      if (bleedSeverity === "minor") {
        reasons.push(`minor backlight bleed${bleedCorners.length ? ` (${bleedCorners.join("/")})` : ""}`);
      }
      if (pressureSpots) reasons.push("white pressure spot");
      if (maxHzMismatch && displayCaps) {
        reasons.push(`running at ${displayCaps.activeHz}Hz vs ${displayCaps.nativeMaxHz}Hz native max`);
      }
      return { status: "warn", reason: `Suggested WARN: ${reasons.join(", ")}.` };
    }
    return {
      status: "pass",
      reason: `Suggested PASS: 0 pixel defects, uniform backlight, ${displayCaps?.activeHz || measuredHz}Hz verified.`,
    };
  })();

  const buildDisplayProPayload = (chosenStatus: TestStatus): { pro: DisplayProResult; summary: string } => {
    const activeHz = displayCaps?.activeHz ?? measuredHz;
    const maxHz = displayCaps?.nativeMaxHz ?? measuredHz;
    const hingeTxt = hingeResult ? `, eDP Hinge ${hingeResult.verdict}` : "";
    const pxTxt = totalPixelDefects === 0 ? "0 dead pixels" : `${deadPixels} dead / ${stuckPixels} stuck px`;
    const bleedTxt =
      bleedSeverity === "none"
        ? "no bleed"
        : `${bleedSeverity} bleed${bleedCorners.length ? ` (${bleedCorners.join("/")})` : ""}`;
    const summary =
      chosenStatus === "pass"
        ? `Display Pro verified (${viewedSet.size}/${PATTERNS.length} patterns, ${activeHz}Hz / ${maxHz}Hz max, ±${frameJitterMs.toFixed(1)}ms jitter, ${pxTxt}, ${bleedTxt}${hingeTxt}).`
        : chosenStatus === "warn"
        ? `Display advisory: ${pxTxt}, ${bleedTxt}${pressureSpots ? ", pressure spot" : ""}${maxHzMismatch ? `, stuck at ${activeHz}Hz/${maxHz}Hz max` : ""}${hingeTxt}.`
        : `Display defect: ${edpDropDetected ? "eDP hinge drop, " : ""}${pxTxt}, ${bleedTxt}${flickerOrGhosting ? ", flicker/ghosting" : ""}${hingeTxt}.`;
    const pro: DisplayProResult = {
      measuredHz,
      activeHz,
      nativeMaxHz: maxHz,
      maxHzMismatch,
      avgFrameTimeMs: avgFrameMs,
      frameJitterMs,
      droppedFrames,
      deadPixels,
      stuckPixels,
      bleedSeverity,
      bleedCorners,
      pressureSpots,
      flickerOrGhosting,
      hingeFlex: hingeResult,
      patternsViewed: viewedSet.size,
      totalPatterns: PATTERNS.length,
      plainSummary: summary,
    };
    return { pro, summary };
  };

  const commitVerdict = (chosenStatus: TestStatus) => {
    const { pro, summary } = buildDisplayProPayload(chosenStatus);
    onDisplayProUpdate?.(pro);
    onVerdict(chosenStatus, summary, notes, pro);
  };

  return (
    <div className="space-y-5">
      {fullscreenOverlay}

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold text-black tracking-tight">
              Display Check
              <span className="sr-only"> (MonitorTest 23-Pattern Suite — Display Pro 24-Pattern Suite)</span>
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-zinc-500">
            Step {stepNumber} of {totalSteps} • {PATTERNS.length}-pattern Pro suite ({viewedSet.size}/{PATTERNS.length} inspected)
            {primaryPanel ? ` • ${primaryPanel.manufacturerName} ${primaryPanel.panelModel}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => enterFullscreen(PATTERNS.findIndex((p) => p.id === "frameskip"))}
            className="px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:border-black text-black font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Activity className="w-3.5 h-3.5 text-blue-600" />
            Frame-Skip Grid
          </button>
          <button
            type="button"
            onClick={() => enterFullscreen(0)}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs inline-flex items-center gap-2 cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
            Launch True Fullscreen Test
          </button>
        </div>
      </div>

      {/* Block 1: Live Refresh-Rate / Max-Hz Audit + Panel EDID + Backlight Strip */}
      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-zinc-200 font-mono tabular-nums">
          <div className="p-3.5">
            <div className="text-[10px] uppercase text-zinc-500 font-semibold">Active / Native Max Hz</div>
            <div className={`text-xl font-bold mt-0.5 ${maxHzMismatch ? "text-black" : "text-blue-700"}`}>
              {displayCaps?.activeHz ? `${displayCaps.activeHz} Hz` : `${measuredHz} Hz`}
              <span className="text-xs font-normal text-zinc-500">
                {" "}/ {displayCaps?.nativeMaxHz || measuredHz} Hz
              </span>
            </div>
            <div className="text-[11px] text-zinc-500">
              {displayCaps?.activeWidth
                ? `${displayCaps.activeWidth}×${displayCaps.activeHeight}${displayCaps.colorDepthBpp ? ` • ${displayCaps.colorDepthBpp}-bit` : ""}`
                : "OS mode probe"}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[10px] uppercase text-zinc-500 font-semibold">VSync Jitter / Drops</div>
            <div className="text-xl font-bold mt-0.5 text-black">
              ±{frameJitterMs.toFixed(1)} ms
            </div>
            <div className="text-[11px] text-zinc-500">
              {avgFrameMs.toFixed(1)} ms avg • {droppedFrames} drop(s)
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[10px] uppercase text-zinc-500 font-semibold">Panel EDID Identity</div>
            <div className="text-sm font-bold mt-1 text-black truncate">
              {primaryPanel ? `${primaryPanel.manufacturerName} (${primaryPanel.panelModel})` : "Standard Panel"}
            </div>
            <div className="text-[11px] text-zinc-500 truncate">
              {primaryPanel?.replacementSuspected
                ? `INFO: Replacement (${primaryPanel.mfgYear} vs ${primaryPanel.biosYear})`
                : primaryPanel?.mfgYear
                ? `Original-Era (${primaryPanel.mfgYear}${primaryPanel.mfgWeek ? ` Wk ${primaryPanel.mfgWeek}` : ""})`
                : "EDID OK"}
            </div>
          </div>

          <div className="p-3.5">
            <div className="text-[10px] uppercase text-zinc-500 font-semibold">eDP Hinge-Flex Cable</div>
            <div className="text-sm font-bold mt-1 text-black">
              {hingeResult ? hingeResult.verdict.replace(/_/g, " ") : "Not Tested Yet"}
            </div>
            <div className="text-[11px] text-zinc-500">
              {hingeResult
                ? `${hingeResult.disconnectEvents + hingeResult.modeGlitchEvents + hingeResult.driverResetEvents} drop(s) in ${hingeResult.durationSecs.toFixed(0)}s`
                : "Run 15s tilt check below"}
            </div>
          </div>
        </div>

        {maxHzMismatch && displayCaps && (
          <div className="border-t border-zinc-200 bg-black text-white px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0" />
              <span>
                <strong>Max-Hz Mismatch:</strong> {displayCaps.plainSummary}
              </span>
            </div>
            <button
              type="button"
              onClick={loadCapabilities}
              className="px-2.5 py-1 rounded-lg bg-white text-black font-semibold text-[11px] cursor-pointer"
            >
              Re-check Hz
            </button>
          </div>
        )}
      </div>

      {/* Block 2: 15-Second eDP Hinge-Flex Drop Monitor + Live Backlight Control */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-black flex items-center gap-1.5">
              <Monitor className="w-4 h-4 text-blue-600" />
              15-Second eDP Hinge-Flex Drop Monitor
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Start the monitor and smoothly tilt the screen lid between 30° and 135° three times to catch worn eDP ribbon cables or display drops.
            </p>
          </div>
          {hingeRunning ? (
            <button
              type="button"
              onClick={() => invoke("cancel_edp_hinge_flex_test").catch(() => {})}
              className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" /> Stop Monitor
            </button>
          ) : (
            <button
              type="button"
              onClick={startHingeFlexTest}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" /> Start 15s Hinge-Flex Check
            </button>
          )}
        </div>

        {hingeError && (
          <div className="rounded-xl bg-black text-white px-3.5 py-2 font-mono text-xs">{hingeError}</div>
        )}

        {hingeRunning && hingeProg && (
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5 space-y-2 font-mono text-xs tabular-nums">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="font-bold text-blue-700">
                Flexing eDP Ribbon ({hingeProg.elapsedSecs.toFixed(0)}s / {hingeProg.durationSecs}s)
              </span>
              <span className="text-black font-bold">
                Polls: {hingeProg.samplesTaken} • Drops: {hingeProg.disconnectEvents} • Glitches: {hingeProg.modeGlitchEvents} • TDR: {hingeProg.driverResetEvents}
              </span>
            </div>
            <div className="h-1.5 bg-zinc-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${Math.min(100, (hingeProg.elapsedSecs / Math.max(hingeProg.durationSecs, 1)) * 100)}%` }}
              />
            </div>
            <div className="font-sans text-xs text-zinc-700">{hingeProg.note}</div>
          </div>
        )}

        {hingeResult && !hingeRunning && (
          <div
            className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 flex-wrap text-xs ${
              hingeResult.status === "fail"
                ? "border-black bg-black text-white"
                : hingeResult.status === "pass"
                ? "border-blue-600 bg-[#F8FAFC] text-black"
                : "border-zinc-300 bg-[#F8FAFC] text-black"
            }`}
          >
            <span>{hingeResult.plainSummary}</span>
            <StatusBadge status={hingeResult.status} darkSurface={hingeResult.status === "fail"} compact />
          </div>
        )}

        {/* Compact Live Backlight Brightness Control */}
        <div className="pt-3 border-t border-zinc-200 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-xs">
            <Sun className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="font-semibold text-black">Backlight:</span>
            <span className="font-mono font-bold text-black">
              {brightnessPct != null ? `${brightnessPct}%` : "Manual Fn"}
            </span>
            {brightnessVerified && (
              <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white font-mono text-[10px] font-semibold">
                Verified
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
                className={`px-2.5 py-1 rounded-lg border font-mono text-xs font-semibold cursor-pointer disabled:opacity-40 ${
                  brightnessPct === lvl
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-zinc-200 text-black hover:border-black"
                }`}
              >
                {lvl}%
              </button>
            ))}
            <button
              type="button"
              disabled={brightnessBusy || !brightnessSupported}
              onClick={runBrightnessSweep}
              className="px-3 py-1 rounded-lg bg-black hover:bg-zinc-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-40"
            >
              Sweep 20%→100%
            </button>
            <button
              type="button"
              disabled={brightnessBusy}
              onClick={loadBrightness}
              aria-label="Refresh backlight status"
              className="px-2 py-1 rounded-lg border border-zinc-200 bg-white hover:border-black text-black cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${brightnessBusy ? "animate-spin text-blue-600" : ""}`} />
            </button>
          </div>
        </div>
        {brightnessSupported && (
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={brightnessPct ?? 50}
            disabled={brightnessBusy}
            onChange={(e) => applyBrightness(Number(e.target.value))}
            aria-label="Display brightness slider"
            className="w-full accent-blue-600 cursor-pointer"
          />
        )}
        <div className="text-[11px] text-zinc-500">{brightnessDetail}</div>
      </div>

      {/* Block 3: Structured Display Defect Recorder & Smart Shop Verdict */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm font-bold text-black">Display Defect Log &amp; Verdict</div>
          <span
            className={`px-2.5 py-1 rounded-lg font-mono text-[11px] font-semibold ${
              suggestedVerdict.status === "fail"
                ? "bg-black text-white"
                : suggestedVerdict.status === "warn"
                ? "border border-blue-600 bg-blue-50 text-blue-900"
                : "bg-blue-600 text-white"
            }`}
          >
            {suggestedVerdict.reason}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {/* Dead & Stuck Pixel Counters */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 space-y-2">
            <div className="font-semibold text-black">Pixel Defects</div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-600">Dead (dark)</span>
              <div className="flex items-center gap-1.5 font-mono">
                <button
                  type="button"
                  onClick={() => setDeadPixels((v) => Math.max(0, v - 1))}
                  className="w-6 h-6 rounded-md border border-zinc-300 bg-white hover:border-black font-bold cursor-pointer"
                >
                  -
                </button>
                <span className="w-6 text-center font-bold text-black">{deadPixels}</span>
                <button
                  type="button"
                  onClick={() => setDeadPixels((v) => v + 1)}
                  className="w-6 h-6 rounded-md border border-zinc-300 bg-white hover:border-black font-bold cursor-pointer"
                >
                  +
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-600">Stuck (bright)</span>
              <div className="flex items-center gap-1.5 font-mono">
                <button
                  type="button"
                  onClick={() => setStuckPixels((v) => Math.max(0, v - 1))}
                  className="w-6 h-6 rounded-md border border-zinc-300 bg-white hover:border-black font-bold cursor-pointer"
                >
                  -
                </button>
                <span className="w-6 text-center font-bold text-black">{stuckPixels}</span>
                <button
                  type="button"
                  onClick={() => setStuckPixels((v) => v + 1)}
                  className="w-6 h-6 rounded-md border border-zinc-300 bg-white hover:border-black font-bold cursor-pointer"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* Backlight Bleed Severity & Corners */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 space-y-2">
            <div className="font-semibold text-black">Backlight Bleed / IPS Glow</div>
            <div className="flex gap-1.5">
              {(["none", "minor", "severe"] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => {
                    setBleedSeverity(lvl);
                    if (lvl === "none") setBleedCorners([]);
                  }}
                  className={`flex-1 py-1 rounded-lg border text-[11px] font-semibold capitalize cursor-pointer ${
                    bleedSeverity === lvl
                      ? lvl === "severe"
                        ? "bg-black border-black text-white"
                        : "bg-blue-600 border-blue-600 text-white"
                      : "bg-white border-zinc-200 text-zinc-700 hover:border-black"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
            {bleedSeverity !== "none" && (
              <div className="flex items-center gap-1 pt-0.5">
                <span className="text-[10.5px] text-zinc-500 mr-1">Corners:</span>
                {["TL", "TR", "BL", "BR"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleBleedCorner(c)}
                    className={`px-2 py-0.5 rounded-md border font-mono text-[10.5px] font-bold cursor-pointer ${
                      bleedCorners.includes(c)
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-white border-zinc-300 text-zinc-700"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Other Visual Fault Toggles */}
          <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3 space-y-2">
            <div className="font-semibold text-black">Uniformity &amp; Motion</div>
            <label className="flex items-center gap-2 cursor-pointer text-zinc-700">
              <input
                type="checkbox"
                checked={pressureSpots}
                onChange={(e) => setPressureSpots(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
              White pressure spot / yellowing
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-zinc-700">
              <input
                type="checkbox"
                checked={flickerOrGhosting}
                onChange={(e) => setFlickerOrGhosting(e.target.checked)}
                className="accent-blue-600 w-3.5 h-3.5"
              />
              Panel flicker / lines / severe ghosting
            </label>
          </div>
        </div>

        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional panel notes (e.g. 0 dead pixels, clean uniformity, 144Hz smooth, no burn-in)"
          className="w-full bg-white border border-zinc-200 rounded-xl px-3.5 py-2 text-xs text-black focus:outline-none focus:border-blue-600"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => commitVerdict("pass")}
            className={`px-4 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer ${
              suggestedVerdict.status === "pass"
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "border border-zinc-200 bg-white hover:border-black text-black"
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            Pass Display Check
          </button>
          <button
            type="button"
            onClick={() => commitVerdict("warn")}
            className={`px-4 py-2 rounded-xl font-semibold text-xs cursor-pointer ${
              suggestedVerdict.status === "warn"
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "border border-blue-600 bg-blue-50 hover:bg-blue-100 text-blue-900"
            }`}
          >
            Mark Minor Issue (WARN)
          </button>
          <button
            type="button"
            onClick={() => commitVerdict("fail")}
            className={`px-4 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer ${
              suggestedVerdict.status === "fail"
                ? "bg-black hover:bg-zinc-800 text-white ring-2 ring-blue-600"
                : "bg-black hover:bg-zinc-800 text-white"
            }`}
          >
            <XCircle className="w-4 h-4" />
            Fail Display Check
          </button>
        </div>
      </div>

      {/* Collapsed Details: All 24 Fullscreen Pattern Tiles */}
      <TechnicalDetailsDrawer
        title="Jump to Specific Fullscreen Pattern (24 Patterns)"
        summary={`${viewedSet.size}/${PATTERNS.length} inspected • Dead pixels, OLED bleed, Gamma 2.2, UFO Motion & Frame-Skip Grid`}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
          {PATTERNS.map((p, i) => {
            const seen = viewedSet.has(i);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => enterFullscreen(i)}
                className={`rounded-xl border p-2.5 text-left transition cursor-pointer ${
                  seen
                    ? "border-blue-600 bg-blue-50/40"
                    : "border-zinc-200 hover:border-black bg-white"
                }`}
              >
                <div
                  className="h-8 rounded-lg border border-zinc-200 mb-1.5 flex items-center justify-center text-[9.5px] font-mono font-bold"
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
                <div className="text-[11px] font-semibold text-black truncate">{p.name}</div>
                <div className="text-[10px] text-zinc-500 font-mono">
                  {seen ? "Inspected" : `#${i + 1}`}
                </div>
              </button>
            );
          })}
        </div>
      </TechnicalDetailsDrawer>

      <StepActionBar
        stepNumber={stepNumber}
        totalSteps={totalSteps}
        status={status}
        canProceed={false}
        requirementHint="Launch fullscreen patterns or run the hinge-flex check, then record Pass / Warn / Fail to unlock the next step."
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>
  );
};
