import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  Gamepad2,
  Globe,
  Layers,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Rocket,
  Search,
  Sparkles,
  Square,
  Thermometer,
  Type,
  Zap,
} from "lucide-react";
import type {
  GpuComputeBenchResult,
  GraphicsFpsSceneScore,
  GraphicsFpsSuiteResult,
  LiveTelemetrySnapshot,
  TestStatus,
} from "../types";
import { StatusBadge } from "./StatusBadge";
import { NovabenchScoreBar } from "./NovabenchScoreBar";
import {
  createThreeSceneController,
  type ThreeSceneController,
  type ThreeSceneId,
} from "./graphicsLab/threeEngine";
import {
  createTextBenchState,
  createVectorBenchState,
  createZoomBenchState,
  render2DRichTypographyScroll,
  render2DTextureDeepZoom,
  render2DVectorCeiling,
  type PointerInput,
} from "./graphicsLab/engines2d";

export interface GraphicsFpsLabProps {
  selectedAdapter: number;
  adapterName: string;
  isDiscreteGpu: boolean;
  suiteResult: GraphicsFpsSuiteResult | null;
  computeResult: GpuComputeBenchResult | null;
  onSuiteComplete: (res: GraphicsFpsSuiteResult) => void;
  onComputeComplete: (res: GpuComputeBenchResult) => void;
  onRunningChange: (running: boolean) => void;
}

type LoadTier = "light" | "standard" | "heavy" | "ultra";
type DurationMode = 10 | 15 | 30;
type SceneId = ThreeSceneId | "bench_2d_vectors" | "bench_2d_zoom" | "bench_2d_text";

interface SceneDef {
  id: SceneId;
  shortName: string;
  name: string;
  kind: "3D World" | "3D Game" | "2D Graphics";
  isThree: boolean;
  badge: string;
  playable: boolean;
  controlHint: string;
  description: string;
}

const SCENES: SceneDef[] = [
  {
    id: "three_island",
    shortName: "3D Island",
    name: "3D Sunlit Island, Terrain & Reflective Ocean Shadows",
    kind: "3D World",
    isThree: true,
    badge: "THREE.JS PBR • DYNAMIC SHADOWS",
    playable: true,
    controlHint: "Mouse: Orbit Drone Flight & Altitude around Island",
    description: "Three.js high-poly vertex-biome mountain island, animated ocean waves, shadow-casting pines & 3-act sun.",
  },
  {
    id: "three_studio",
    shortName: "3D Studio",
    name: "3D PBR Metallic, Glass & Dynamic Multi-Light Studio",
    kind: "3D World",
    isThree: true,
    badge: "THREE.JS PHYSICAL • 4 POINT LIGHTS",
    playable: true,
    controlHint: "Mouse: Orbit 360° around PBR Metallic & Crystal Sculpture",
    description: "Clearcoat torus-knot, refractive glass crystal, 10 metallic spheres & 4 dynamic shadow-casting studio lights.",
  },
  {
    id: "three_megacity",
    shortName: "3D Megacity",
    name: "3D Instanced Neon Cyberpunk Megacity Flythrough",
    kind: "3D World",
    isThree: true,
    badge: "THREE.JS INSTANCED • UP TO 7.5K TOWERS",
    playable: true,
    controlHint: "Mouse: Steer Flight Bank & Altitude between Skyscrapers",
    description: "Thousands of lit 3D skyscraper meshes, glowing aerial traffic lanes, wet boulevard & street canyon dive.",
  },
  {
    id: "three_game_fighter",
    shortName: "3D Fighter",
    name: "Playable 3D Game 1: Space Fighter Trench Combat & Boss",
    kind: "3D Game",
    isThree: true,
    badge: "3D GAME • SPACE COMBAT",
    playable: true,
    controlHint: "Mouse / WASD: Fly & Bank 3D Ship • Click / Space: Overdrive Fire",
    description: "Banking 3D Starfighter, 3D starfield trench, enemy waves, laser explosions & 3D Dreadnought Boss.",
  },
  {
    id: "three_game_racer",
    shortName: "3D Racer",
    name: "Playable 3D Game 2: Neon Highway Turbo Racer",
    kind: "3D Game",
    isThree: true,
    badge: "3D GAME • TURBO RACER",
    playable: true,
    controlHint: "A/D / Arrows / Mouse X: Steer Car • W / Space / Click: Nitro Boost",
    description: "3D sports car with chase camera, glowing neon highway, traffic weaving & 360 km/h FOV Nitro Boost.",
  },
  {
    id: "three_game_cannon",
    shortName: "3D Cannon",
    name: "Playable 3D Game 3: Physics Tower Destruction Cannon",
    kind: "3D Game",
    isThree: true,
    badge: "3D GAME • TOWER DESTRUCTION",
    playable: true,
    controlHint: "Aim Mouse + Click / Space: Fire Cannonball • R: Rebuild Mega-Tower",
    description: "Sunlit 3D shadow-casting towers blasted apart by glowing cannonballs with real 3D gravity, bounce & spin.",
  },
  {
    id: "bench_2d_vectors",
    shortName: "2D Vectors",
    name: "2D Escalating Vector Ceiling, PCB & Clockwork Engine",
    kind: "2D Graphics",
    isThree: false,
    badge: "2D PASSMARK • MOTIONMARK",
    playable: false,
    controlHint: "Auto-escalating vector count (750 -> 6,000+) to find true 60 FPS ceiling",
    description: "Full-color PCB schematics, interlocking clockwork gears & prism shards measuring Max Vectors @ 60 FPS.",
  },
  {
    id: "bench_2d_zoom",
    shortName: "2D 64x Zoom",
    name: "2D Satellite Topographic Map & CAD Deep-Zoom (0.35x -> 64x)",
    kind: "2D Graphics",
    isThree: false,
    badge: "2D TEXTURE ZOOM • MP/S",
    playable: true,
    controlHint: "Mouse Wheel: Deep Zoom (0.3x-128x) • Drag: Pan Map",
    description: "High-res shaded-relief satellite bitmap + hairline CAD overlay with multi-layer compositing.",
  },
  {
    id: "bench_2d_text",
    shortName: "2D Text/IDE",
    name: "2D Rich Code IDE, Data Table & Multi-Script Typography",
    kind: "2D Graphics",
    isThree: false,
    badge: "2D TYPOGRAPHY • GLYPHS/S",
    playable: true,
    controlHint: "Wheel / Up-Down: Scroll Velocity • +/-: Live Font Scale",
    description: "Syntax-highlighted code, live telemetry table, Myanmar & CJK scripts with 120Hz+ scroll & zoom.",
  },
];

const LOAD_CONFIG: Record<LoadTier, { label: string; weightMult: number }> = {
  light: { label: "Light (Ultrabook iGPU)", weightMult: 0.78 },
  standard: { label: "Standard (Balanced QC)", weightMult: 1.0 },
  heavy: { label: "Heavy (Creator / dGPU)", weightMult: 1.38 },
  ultra: { label: "Ultra (RTX Extreme)", weightMult: 1.85 },
};

function computeFrameStats(frameDtsMs: number[]): {
  avgFps: number;
  low1pctFps: number;
  low01pctFps: number;
  avgFrameMs: number;
  jitterMs: number;
  stutterFrames: number;
  stutterPct: number;
} {
  if (frameDtsMs.length === 0) {
    return {
      avgFps: 0,
      low1pctFps: 0,
      low01pctFps: 0,
      avgFrameMs: 0,
      jitterMs: 0,
      stutterFrames: 0,
      stutterPct: 0,
    };
  }
  const clean = frameDtsMs.map((d) => Math.max(0.5, Math.min(500, d)));
  const sum = clean.reduce((a, b) => a + b, 0);
  const avgMs = sum / clean.length;
  const variance = clean.reduce((acc, d) => acc + (d - avgMs) * (d - avgMs), 0) / clean.length;
  const jitterMs = Math.sqrt(variance);
  const sorted = [...clean].sort((a, b) => b - a);
  const idx1 = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.01)));
  const idx01 = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.001)));
  const top1Slice = sorted.slice(0, Math.max(1, idx1 + 1));
  const avg1Ms = top1Slice.reduce((a, b) => a + b, 0) / top1Slice.length;
  const top01Ms = sorted[idx01];
  const stutterThreshold = Math.max(33.4, avgMs * 2.15);
  const stutterCount = clean.filter((d) => d > stutterThreshold).length;
  return {
    avgFps: Number((1000 / Math.max(0.5, avgMs)).toFixed(1)),
    low1pctFps: Number((1000 / Math.max(0.5, avg1Ms)).toFixed(1)),
    low01pctFps: Number((1000 / Math.max(0.5, top01Ms)).toFixed(1)),
    avgFrameMs: Number(avgMs.toFixed(2)),
    jitterMs: Number(jitterMs.toFixed(2)),
    stutterFrames: stutterCount,
    stutterPct: Number(((stutterCount / clean.length) * 100).toFixed(1)),
  };
}

function classifySuiteResult(
  scenes: GraphicsFpsSceneScore[],
  loadTier: LoadTier,
  resolution: string,
  webgl2Supported: boolean,
  gpuRendererString: string,
  elapsedSecs: number,
  computeResult: GpuComputeBenchResult | null
): GraphicsFpsSuiteResult {
  const valid = scenes.filter((s) => s.score > 0);
  const compositeScore =
    valid.length > 0
      ? Math.round(valid.reduce((a, b) => a + b.score, 0) / valid.length)
      : 0;
  const meanFps =
    scenes.length > 0 ? scenes.reduce((a, b) => a + b.avgFps, 0) / scenes.length : 0;
  const peakFps = scenes.reduce((m, s) => Math.max(m, s.avgFps), 60);
  const displayHz =
    peakFps >= 200 ? 240 : peakFps >= 155 ? 165 : peakFps >= 130 ? 144 : peakFps >= 100 ? 120 : 60;
  const maxStutter = scenes.reduce((m, s) => Math.max(m, s.stutterFramesPct), 0);
  const core2d = scenes.filter((s) => s.id.startsWith("bench_2d_"));
  const severe2dStall = core2d.some((s) => s.avgFps > 0 && s.avgFps < 10);
  const softwareFallback = /swiftshader|llvmpipe|microsoft basic render/i.test(gpuRendererString);

  let smoothnessTier = "Smooth";
  if (
    (meanFps >= 85 || (computeResult?.uncapped3dFps ?? 0) >= 120) &&
    maxStutter < 8 &&
    webgl2Supported &&
    !softwareFallback
  ) {
    smoothnessTier = "Ultra";
  } else if (meanFps >= 45 && maxStutter < 18 && !softwareFallback) {
    smoothnessTier = "Smooth";
  } else if (meanFps >= 22 && !severe2dStall) {
    smoothnessTier = "Office Ready";
  } else {
    smoothnessTier = "Struggling";
  }

  let status: TestStatus = "pass";
  if (severe2dStall || scenes.some((s) => s.status === "fail")) {
    status = "fail";
  } else if (!webgl2Supported || softwareFallback || maxStutter > 28 || meanFps < 18) {
    status = "warn";
  }

  const nativeBit = computeResult?.uncapped3dFps
    ? ` • Native 1080p Uncapped ${computeResult.uncapped3dFps.toFixed(1)} FPS (${computeResult.fp32Gflops.toFixed(0)} GFLOPS)`
    : "";

  const plainSummary =
    status === "fail"
      ? `Severe graphics stall detected in Three.js 3D & 2D Suite (Composite ${compositeScore}, ${smoothnessTier}). Check GPU drivers and cooling.`
      : status === "warn"
      ? `${smoothnessTier} Three.js 3D/2D performance (Composite ${compositeScore}, Avg ${meanFps.toFixed(
          1
        )} FPS${!webgl2Supported ? ", WebGL2 unavailable" : softwareFallback ? ", software renderer active" : `, peak stutter ${maxStutter.toFixed(1)}%`})${nativeBit}.`
      : `All ${scenes.length} Three.js PBR 3D worlds, playable 3D games & 2D benchmarks verified (${smoothnessTier} • Composite ${compositeScore} • Avg ${meanFps.toFixed(
          1
        )} FPS${nativeBit}).`;

  return {
    status,
    compositeScore,
    smoothnessTier,
    loadPreset: LOAD_CONFIG[loadTier].label,
    displayHz,
    rendererName: gpuRendererString,
    loadTier,
    resolution,
    webgl2Supported,
    gpuRendererString,
    uiReflowOpsPerSec: 0,
    uiReflowP95Ms: 0,
    scenes,
    gpuCompute: computeResult,
    elapsedSecs: Number(elapsedSecs.toFixed(1)),
    summary: `Composite ${compositeScore} (${smoothnessTier}) • Avg ${meanFps.toFixed(1)} FPS${nativeBit}`,
    plainSummary,
  };
}

function fmtClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const GraphicsFpsLab: React.FC<GraphicsFpsLabProps> = ({
  selectedAdapter,
  adapterName,
  isDiscreteGpu,
  suiteResult,
  computeResult,
  onSuiteComplete,
  onComputeComplete,
  onRunningChange,
}) => {
  const [loadTier, setLoadTier] = useState<LoadTier>(isDiscreteGpu ? "heavy" : "standard");
  const [durationSecs, setDurationSecs] = useState<DurationMode>(15);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [suiteMode, setSuiteMode] = useState(false);
  const [activeScene, setActiveScene] = useState<SceneId>("three_island");
  const [manualPlay, setManualPlay] = useState(false);
  const [sceneScores, setSceneScores] = useState<Partial<Record<SceneId, GraphicsFpsSceneScore>>>({});
  const [transitionBanner, setTransitionBanner] = useState<string | null>(null);

  const [computeRunning, setComputeRunning] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [liveHw, setLiveHw] = useState<LiveTelemetrySnapshot | null>(null);

  const [hud, setHud] = useState({
    fps: 0,
    low1: 0,
    low01: 0,
    frameMs: 0,
    elapsed: 0,
    remaining: 15,
    progressPct: 0,
    actLabel: "ACT I • Baseline",
    metricLabel: "Ready",
    metricValue: "—",
    sparkline: [] as number[],
    webglLabel: "Three.js WebGL2",
  });

  // -------------------------------------------------------------------------
  // CRITICAL ZERO-RESET ARCHITECTURE:
  // Store ALL parent callbacks in stable refs so parent telemetry re-renders
  // NEVER restart the fullscreen Three.js / Canvas2D animation useEffect!
  // -------------------------------------------------------------------------
  const onSuiteCompleteRef = useRef(onSuiteComplete);
  onSuiteCompleteRef.current = onSuiteComplete;
  const onComputeCompleteRef = useRef(onComputeComplete);
  onComputeCompleteRef.current = onComputeComplete;
  const onRunningChangeRef = useRef(onRunningChange);
  onRunningChangeRef.current = onRunningChange;

  const canvas2dRef = useRef<HTMLCanvasElement | null>(null);
  const canvasGlRef = useRef<HTMLCanvasElement | null>(null);

  const loadTierRef = useRef<LoadTier>(loadTier);
  loadTierRef.current = loadTier;
  const durationRef = useRef<DurationMode>(durationSecs);
  durationRef.current = durationSecs;
  const manualPlayRef = useRef<boolean>(manualPlay);
  manualPlayRef.current = manualPlay;
  const suiteModeRef = useRef<boolean>(suiteMode);
  suiteModeRef.current = suiteMode;
  const fullscreenOpenRef = useRef<boolean>(fullscreenOpen);
  fullscreenOpenRef.current = fullscreenOpen;
  const computeResultRef = useRef<GpuComputeBenchResult | null>(computeResult);
  computeResultRef.current = computeResult;

  const suiteAccRef = useRef<GraphicsFpsSceneScore[]>([]);
  const suiteStartMsRef = useRef<number>(0);
  const glSupportRef = useRef<{ supported: boolean; renderer: string }>({
    supported: true,
    renderer: adapterName || "Three.js WebGL2",
  });
  // Trigger hook for instant Next/Prev skip inside active scene
  const forceFinishSceneRef = useRef<((direction: 1 | -1) => void) | null>(null);

  const pointerRef = useRef<PointerInput>({
    x: 0.5,
    y: 0.5,
    down: false,
    clicked: false,
    dx: 0,
    dy: 0,
    wheelDelta: 0,
  });
  const keysRef = useRef<Set<string>>(new Set());

  const setNativeFullscreen = useCallback(async (on: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(on);
    } catch {
      // Safe no-op in headless E2E mock
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    setFullscreenOpen(false);
    setSuiteMode(false);
    setManualPlay(false);
    setTransitionBanner(null);
    onRunningChangeRef.current(false);
    setNativeFullscreen(false);
  }, [setNativeFullscreen]);

  const exitFullscreenRef = useRef(exitFullscreen);
  exitFullscreenRef.current = exitFullscreen;

  const runComputeBench = useCallback(async () => {
    setComputeError(null);
    setComputeRunning(true);
    try {
      const res = await invoke<GpuComputeBenchResult>("run_gpu_compute_bench", {
        adapterIndex: selectedAdapter,
      });
      computeResultRef.current = res;
      onComputeCompleteRef.current(res);
      return res;
    } catch (e) {
      setComputeError(String(e));
      return null;
    } finally {
      setComputeRunning(false);
    }
  }, [selectedAdapter]);

  const launchScene = useCallback(
    (sceneId: SceneId, asPlayable: boolean) => {
      setSuiteMode(false);
      setActiveScene(sceneId);
      setManualPlay(asPlayable);
      setTransitionBanner(null);
      setFullscreenOpen(true);
      onRunningChangeRef.current(true);
      setNativeFullscreen(true);
    },
    [setNativeFullscreen]
  );

  const launchFullSuite = useCallback(() => {
    suiteAccRef.current = [];
    suiteStartMsRef.current = performance.now();
    setSceneScores({});
    setManualPlay(false);
    setSuiteMode(true);
    setActiveScene(SCENES[0].id);
    setTransitionBanner(`01 / ${SCENES.length} • ${SCENES[0].name}`);
    setFullscreenOpen(true);
    onRunningChangeRef.current(true);
    setNativeFullscreen(true);
    // Run uncapped native Rust wgpu 1080p 3D + FP32 compute in background if not yet measured
    if (!computeResultRef.current && !computeRunning) {
      runComputeBench().catch(() => {});
    }
  }, [computeRunning, runComputeBench, setNativeFullscreen]);

  const jumpScene = useCallback((delta: 1 | -1) => {
    if (forceFinishSceneRef.current) {
      forceFinishSceneRef.current(delta);
    } else {
      setActiveScene((cur) => {
        const idx = SCENES.findIndex((s) => s.id === cur);
        const nextIdx = (idx + delta + SCENES.length) % SCENES.length;
        return SCENES[nextIdx].id;
      });
    }
  }, []);

  // Auto-hide 1.1s clean transition banner
  useEffect(() => {
    if (!transitionBanner) return;
    const t = window.setTimeout(() => setTransitionBanner(null), 1150);
    return () => window.clearTimeout(t);
  }, [transitionBanner]);

  // Restore native window chrome cleanly on unmount
  useEffect(() => {
    return () => {
      if (fullscreenOpenRef.current) {
        getCurrentWindow().setFullscreen(false).catch(() => {});
      }
    };
  }, []);

  // Poll live hardware telemetry inside fullscreen HUD (does NOT restart scene loop!)
  useEffect(() => {
    if (!fullscreenOpen) return;
    let alive = true;
    const poll = () => {
      invoke<LiveTelemetrySnapshot>("sample_live_telemetry")
        .then((snap) => {
          if (alive) setLiveHw(snap);
        })
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 1400);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [fullscreenOpen]);

  // Keyboard shortcuts while fullscreen is open (Esc = Exit, N = Next, P = Prev)
  useEffect(() => {
    if (!fullscreenOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitFullscreenRef.current();
        return;
      }
      if (!manualPlayRef.current && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        jumpScene(1);
        return;
      }
      if (!manualPlayRef.current && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        jumpScene(-1);
        return;
      }
      keysRef.current.add(e.key.toLowerCase());
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      keysRef.current.clear();
    };
  }, [fullscreenOpen, jumpScene]);

  // =========================================================================
  // MAIN FULLSCREEN 9-SCENE RENDER LOOP (THREE.JS 3D ENGINE + 2D ENGINES)
  // Dependency array contains ONLY [fullscreenOpen, activeScene, loadTier, durationSecs]!
  // Guaranteed ZERO unwanted 2-3s restarts!
  // =========================================================================
  useEffect(() => {
    if (!fullscreenOpen) return;

    const sceneDef = SCENES.find((s) => s.id === activeScene) ?? SCENES[0];
    const cfg = LOAD_CONFIG[loadTier];
    const sceneDuration = durationSecs;

    let rafId = 0;
    let cancelled = false;
    let finished = false;
    let lastFrameAt = performance.now();
    let lastHudAt = lastFrameAt;
    let animElapsed = 0; // Continuous simulation time (never resets!)
    let suiteElapsed = 0; // Countdown progress (pauses cleanly when manualPlay is ON!)
    let playedManuallyInScene = manualPlayRef.current;

    const frameDts: number[] = [];
    const sparkBuf: number[] = [];

    const width = Math.max(640, window.innerWidth);
    const height = Math.max(400, window.innerHeight);

    // Setup Three.js 3D Engine OR 2D Canvas Engine
    let threeCtrl: ThreeSceneController | null = null;
    let ctx2d: CanvasRenderingContext2D | null = null;

    if (sceneDef.isThree && canvasGlRef.current) {
      threeCtrl = createThreeSceneController(
        canvasGlRef.current,
        sceneDef.id as ThreeSceneId,
        width,
        height,
        cfg.weightMult
      );
      if (threeCtrl) {
        glSupportRef.current.supported = true;
        glSupportRef.current.renderer = threeCtrl.rendererName;
      } else {
        glSupportRef.current.supported = false;
      }
    }

    if ((!sceneDef.isThree || !threeCtrl) && canvas2dRef.current) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas2dRef.current.width = Math.round(width * dpr);
      canvas2dRef.current.height = Math.round(height * dpr);
      ctx2d = canvas2dRef.current.getContext("2d", { alpha: false });
      if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const onResize = () => {
      const w = Math.max(640, window.innerWidth);
      const h = Math.max(400, window.innerHeight);
      if (threeCtrl) {
        threeCtrl.resize(w, h);
      } else if (canvas2dRef.current) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas2dRef.current.width = Math.round(w * dpr);
        canvas2dRef.current.height = Math.round(h * dpr);
        const c = canvas2dRef.current.getContext("2d", { alpha: false });
        if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx2d = c;
      }
    };
    window.addEventListener("resize", onResize);

    // 2D Engine States
    const vecState = createVectorBenchState();
    const zoomState = createZoomBenchState();
    const textState = createTextBenchState();

    let primaryLabel = sceneDef.shortName;
    let primaryValue = "—";
    let actLabel = "ACT I • Baseline";
    let throughputFactor = 1.0;

    const finalizeAndMove = (direction: 1 | -1) => {
      if (finished || cancelled) return;
      finished = true;

      const stats = computeFrameStats(frameDts);
      const score = Math.max(
        100,
        Math.round((stats.avgFps * 68 + stats.low1pctFps * 32) * cfg.weightMult * throughputFactor)
      );
      const sceneStatus: TestStatus =
        stats.avgFps > 0 && stats.avgFps < 10
          ? "fail"
          : stats.stutterPct > 28 || (sceneDef.isThree && !threeCtrl)
          ? "warn"
          : "pass";

      const sceneScore: GraphicsFpsSceneScore = {
        id: sceneDef.id,
        name: sceneDef.name,
        category: sceneDef.kind,
        avgFps: stats.avgFps,
        low1pctFps: stats.low1pctFps,
        low01pctFps: stats.low01pctFps,
        avgFrameMs: stats.avgFrameMs,
        jitterMs: stats.jitterMs,
        stutterFrames: stats.stutterFrames,
        throughputLabel: `${primaryLabel}: ${primaryValue}`,
        stutterFramesPct: stats.stutterPct,
        score,
        primaryMetricLabel: primaryLabel,
        primaryMetricValue: primaryValue,
        status: sceneStatus,
        interactivePlayed: playedManuallyInScene,
      };

      setSceneScores((prev) => ({ ...prev, [sceneDef.id]: sceneScore }));

      const curIdx = SCENES.findIndex((s) => s.id === sceneDef.id);
      if (suiteModeRef.current) {
        suiteAccRef.current = [
          ...suiteAccRef.current.filter((s) => s.id !== sceneDef.id),
          sceneScore,
        ];
        const nextIdx = curIdx + direction;
        if (nextIdx >= 0 && nextIdx < SCENES.length) {
          const nextScene = SCENES[nextIdx];
          setManualPlay(false);
          setTransitionBanner(`${String(nextIdx + 1).padStart(2, "0")} / ${SCENES.length} • ${nextScene.name}`);
          setActiveScene(nextScene.id);
        } else if (direction === 1) {
          const totalSecs = (performance.now() - suiteStartMsRef.current) / 1000;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const finalSuite = classifySuiteResult(
            suiteAccRef.current,
            loadTierRef.current,
            `${Math.round(window.innerWidth * dpr)}x${Math.round(window.innerHeight * dpr)}`,
            glSupportRef.current.supported,
            glSupportRef.current.renderer,
            totalSecs,
            computeResultRef.current
          );
          onSuiteCompleteRef.current(finalSuite);
          exitFullscreenRef.current();
        }
      } else {
        const nextIdx = (curIdx + direction + SCENES.length) % SCENES.length;
        const nextScene = SCENES[nextIdx];
        setTransitionBanner(`${String(nextIdx + 1).padStart(2, "0")} / ${SCENES.length} • ${nextScene.name}`);
        setActiveScene(nextScene.id);
      }
    };

    forceFinishSceneRef.current = finalizeAndMove;

    const tick = (now: number) => {
      if (cancelled || finished) return;
      const dtMs = Math.max(0.5, Math.min(250, now - lastFrameAt));
      lastFrameAt = now;
      const realDt = dtMs / 1000; // True wall-clock elapsed (10s scene = 10 real seconds even on slow iGPUs)
      const simDt = Math.min(0.05, realDt); // Clamped physics step to keep 3D physics rock-solid
      animElapsed += realDt;

      // Countdown timer pauses smoothly whenever user activates Play Mode!
      if (suiteModeRef.current && !manualPlayRef.current) {
        suiteElapsed += realDt;
      }
      if (manualPlayRef.current) {
        playedManuallyInScene = true;
      }

      frameDts.push(dtMs);
      sparkBuf.push(dtMs);
      if (sparkBuf.length > 72) sparkBuf.shift();

      const prog = suiteModeRef.current
        ? Math.min(1, suiteElapsed / sceneDuration)
        : (animElapsed % (sceneDuration * 2)) / (sceneDuration * 2);

      if (sceneDef.isThree && threeCtrl) {
        const out = threeCtrl.step(
          animElapsed,
          simDt,
          prog,
          manualPlayRef.current,
          pointerRef.current,
          keysRef.current
        );
        primaryLabel = out.metricLabel;
        primaryValue = out.metricValue;
        actLabel = out.actLabel;
        throughputFactor = out.throughputScoreFactor;
      } else if (ctx2d) {
        const w = Math.max(640, window.innerWidth);
        const h = Math.max(400, window.innerHeight);
        if (sceneDef.isThree && !threeCtrl) {
          ctx2d.fillStyle = "#09090B";
          ctx2d.fillRect(0, 0, w, h);
          ctx2d.fillStyle = "#F8FAFC";
          ctx2d.font = "700 16px Consolas, monospace";
          ctx2d.fillText("WebGL2 / Three.js context unavailable on this driver — Fallback active.", 48, h * 0.5);
          primaryLabel = "WebGL2";
          primaryValue = "Unavailable (Fallback)";
        } else if (activeScene === "bench_2d_vectors") {
          const out = render2DVectorCeiling(ctx2d, w, h, animElapsed, prog, dtMs, cfg.weightMult, vecState);
          primaryLabel = out.metricLabel;
          primaryValue = out.metricValue;
          actLabel = out.actLabel;
          throughputFactor = out.throughputScoreFactor;
        } else if (activeScene === "bench_2d_zoom") {
          const out = render2DTextureDeepZoom(
            ctx2d,
            w,
            h,
            animElapsed,
            prog,
            manualPlayRef.current,
            pointerRef.current,
            cfg.weightMult,
            zoomState
          );
          primaryLabel = out.metricLabel;
          primaryValue = out.metricValue;
          actLabel = out.actLabel;
          throughputFactor = out.throughputScoreFactor;
        } else {
          const out = render2DRichTypographyScroll(
            ctx2d,
            w,
            h,
            animElapsed,
            prog,
            simDt,
            manualPlayRef.current,
            pointerRef.current,
            keysRef.current,
            textState
          );
          primaryLabel = out.metricLabel;
          primaryValue = out.metricValue;
          actLabel = out.actLabel;
          throughputFactor = out.throughputScoreFactor;
        }
      }

      if (now - lastHudAt >= 110) {
        lastHudAt = now;
        const recent = computeFrameStats(frameDts.slice(-140));
        setHud({
          fps: recent.avgFps,
          low1: recent.low1pctFps,
          low01: recent.low01pctFps,
          frameMs: recent.avgFrameMs,
          elapsed: animElapsed,
          remaining: Math.max(0, sceneDuration - suiteElapsed),
          progressPct: Math.min(100, Math.round((suiteElapsed / sceneDuration) * 100)),
          actLabel,
          metricLabel: primaryLabel,
          metricValue: primaryValue,
          sparkline: [...sparkBuf],
          webglLabel: glSupportRef.current.supported ? "Three.js WebGL2" : "Fallback",
        });
      }

      if (suiteModeRef.current && !manualPlayRef.current && suiteElapsed >= sceneDuration) {
        finalizeAndMove(1);
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      forceFinishSceneRef.current = null;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      if (threeCtrl) threeCtrl.dispose();
    };
  }, [fullscreenOpen, activeScene, loadTier, durationSecs]);

  const activeDef = SCENES.find((s) => s.id === activeScene) ?? SCENES[0];
  const activeSceneIdx = SCENES.findIndex((s) => s.id === activeScene);
  const totalSuiteSecs = SCENES.length * durationSecs;

  const sparkPath =
    hud.sparkline.length > 1
      ? hud.sparkline
          .map((ms, idx) => {
            const x = (idx / Math.max(1, hud.sparkline.length - 1)) * 124;
            const norm = Math.min(1, ms / 45);
            const y = 26 - norm * 24;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "0,24 124,24";

  return (
    <div className="space-y-4">
      {/* Top Hero Card */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Globe className="w-4 h-4 text-blue-600" />
              <h2 className="text-base font-bold text-black tracking-tight">
                Three.js 3D Game Engine &amp; 2D Graphics Benchmark Suite (v3.4.0)
              </h2>
              {suiteResult && <StatusBadge status={suiteResult.status} compact />}
            </div>
            <p className="text-xs text-zinc-500 max-w-2xl">
              Powered by real <strong>Three.js</strong> PBR shadows &amp; InstancedMesh: 3 full-color 3D Worlds (Sunlit Island, PBR Metallic Studio, Cyberpunk Megacity), 3 Playable 3D Games (Space Fighter Boss, Neon Highway Racer, Physics Tower Cannon) &amp; 3 PassMark-2D engines — with Play-Mode timer pause and uncapped native Rust <code className="font-mono text-black">wgpu</code> 1080p 3D FPS.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={durationSecs}
              disabled={fullscreenOpen}
              onChange={(e) => setDurationSecs(Number(e.target.value) as DurationMode)}
              aria-label="Scene Duration Mode"
              className="bg-[#F8FAFC] border border-zinc-200 rounded-lg px-2.5 py-2 font-mono text-xs font-semibold text-black"
            >
              <option value={10}>Quick: 10s / scene (~1.5m)</option>
              <option value={15}>Standard: 15s / scene (~2.2m)</option>
              <option value={30}>Extended: 30s / scene (~4.5m)</option>
            </select>
            <select
              value={loadTier}
              disabled={fullscreenOpen}
              onChange={(e) => setLoadTier(e.target.value as LoadTier)}
              aria-label="Graphics Lab Load Tier"
              className="bg-[#F8FAFC] border border-zinc-200 rounded-lg px-2.5 py-2 font-mono text-xs font-semibold text-black"
            >
              {(Object.keys(LOAD_CONFIG) as LoadTier[]).map((k) => (
                <option key={k} value={k}>
                  {LOAD_CONFIG[k].label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={launchFullSuite}
              disabled={fullscreenOpen}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              Launch Three.js 3D+2D Suite ({fmtClock(totalSuiteSecs)})
            </button>
          </div>
        </div>

        {/* Native Rust wgpu Uncapped 1080p 3D Render FPS + FP32 Compute Card */}
        <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3.5 flex-1 min-w-[260px]">
            {computeResult?.previewDataUrl && (
              <img
                src={computeResult.previewDataUrl}
                alt="Native wgpu 1080p 3D Render Preview"
                className="w-28 h-16 rounded-lg object-cover border border-zinc-300 shrink-0 bg-black"
              />
            )}
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Cpu className="w-3.5 h-3.5 text-blue-600" />
                <span className="font-mono text-[11px] font-bold uppercase text-black">
                  Native Rust wgpu Uncapped 1080p 3D FPS &amp; FP32 Compute ({adapterName || "Primary GPU"})
                </span>
                {computeResult && <StatusBadge status={computeResult.status} compact />}
              </div>
              <div className="text-xs text-zinc-700">
                {computeResult ? (
                  <>
                    {computeResult.uncapped3dFps ? (
                      <strong className="font-mono text-blue-700">
                        Uncapped 1080p 3D: {computeResult.uncapped3dFps.toFixed(1)} FPS (1% Low{" "}
                        {(computeResult.uncapped3dLow1Fps ?? computeResult.uncapped3dFps).toFixed(1)}) •{" "}
                      </strong>
                    ) : null}
                    <strong className="font-mono text-black">
                      {computeResult.fp32Gflops.toFixed(1)} GFLOPS ({computeResult.fp32Tflops.toFixed(2)} TFLOPS)
                    </strong>{" "}
                    • {computeResult.tier} • Compile {computeResult.pipelineCompileMs.toFixed(1)} ms
                  </>
                ) : (
                  "Breaks 60Hz WebView VSync cap: renders photorealistic 1080p 3D terrain + chrome orb directly on DX12/Vulkan/Metal alongside verified FP32 GFLOPS."
                )}
              </div>
              {computeError && (
                <div className="text-xs font-mono text-black bg-white border border-black px-2 py-1 rounded-lg">
                  {computeError}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={computeRunning || fullscreenOpen}
            onClick={() => runComputeBench()}
            className="px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:border-blue-600 text-xs font-semibold text-black flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
          >
            <Zap className="w-3.5 h-3.5 text-blue-600" />
            {computeRunning ? "Rendering Native 1080p 3D..." : "Run Uncapped Native 3D + FP32"}
          </button>
        </div>
      </div>

      {/* Composite Score Plate */}
      {suiteResult && (
        <NovabenchScoreBar
          scoreLabel="3D+2D MARK"
          scoreValue={suiteResult.compositeScore.toLocaleString()}
          title={`Three.js 3D & 2D Graphics Suite — ${suiteResult.smoothnessTier} (${suiteResult.resolution})`}
          takeaway={suiteResult.plainSummary}
          percent={Math.min(100, Math.max(15, Math.round(suiteResult.compositeScore / 110)))}
          medianLabel={
            computeResult?.uncapped3dFps
              ? `Native Uncapped 1080p: ${computeResult.uncapped3dFps.toFixed(1)} FPS • ${computeResult.fp32Gflops.toFixed(0)} GFLOPS`
              : `${suiteResult.scenes.length} Scenes • ${suiteResult.elapsedSecs.toFixed(0)}s`
          }
          medianPercent={70}
          badge={`${suiteResult.smoothnessTier} • ${suiteResult.loadTier.toUpperCase()}`}
          monochrome={suiteResult.status !== "pass"}
        />
      )}

      {/* 9-Scene Gallery */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {SCENES.map((sc, idx) => {
          const score =
            suiteResult?.scenes.find((s) => s.id === sc.id) ?? sceneScores[sc.id] ?? null;
          const Icon =
            sc.id === "three_island"
              ? Globe
              : sc.id === "three_studio"
              ? Sparkles
              : sc.id === "three_megacity"
              ? Layers
              : sc.id === "three_game_fighter"
              ? Rocket
              : sc.id === "three_game_racer"
              ? Zap
              : sc.id === "three_game_cannon"
              ? Gamepad2
              : sc.id === "bench_2d_zoom"
              ? Search
              : sc.id === "bench_2d_text"
              ? Type
              : Activity;
          return (
            <div
              key={sc.id}
              className="rounded-xl border border-zinc-200 bg-white p-4 flex flex-col justify-between gap-3 hover:border-blue-600 transition"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-bold uppercase text-blue-700 flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 text-blue-600" />
                    {String(idx + 1).padStart(2, "0")}. {sc.kind}
                  </span>
                  {score ? (
                    <StatusBadge status={score.status} compact />
                  ) : (
                    <span className="px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 font-mono text-[9px] font-bold">
                      {sc.kind === "3D Game" ? "PLAYABLE 3D" : sc.isThree ? "THREE.JS 3D" : "2D ENGINE"}
                    </span>
                  )}
                </div>
                <div className="text-xs font-bold text-black leading-snug">{sc.name}</div>
                <div className="text-[11px] text-zinc-500 leading-relaxed">{sc.description}</div>
              </div>

              {score && (
                <div className="rounded-lg border border-zinc-200 bg-[#F8FAFC] px-2.5 py-2 font-mono tabular-nums text-[10.5px] space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Avg / 1% Low</span>
                    <strong className="text-black">
                      {score.avgFps.toFixed(1)} / {score.low1pctFps.toFixed(1)} FPS
                    </strong>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-500 shrink-0">{score.primaryMetricLabel}</span>
                    <strong className="text-blue-700 truncate">{score.primaryMetricValue}</strong>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={fullscreenOpen}
                  onClick={() => launchScene(sc.id, false)}
                  className="flex-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-[#F8FAFC] hover:border-black text-[11px] font-semibold text-black flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Play className="w-3 h-3 text-blue-600" /> Benchmark
                </button>
                {sc.playable && (
                  <button
                    type="button"
                    disabled={fullscreenOpen}
                    onClick={() => launchScene(sc.id, true)}
                    className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Gamepad2 className="w-3 h-3" /> Play 3D
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* True Borderless Fullscreen Portal */}
      {fullscreenOpen &&
        createPortal(
          <div
            data-testid="graphics-fullscreen-portal"
            className="fixed inset-0 z-[99999] bg-[#09090B] text-white select-none overflow-hidden"
            onPointerMove={(e) => {
              const nx = e.clientX / Math.max(1, window.innerWidth);
              const ny = e.clientY / Math.max(1, window.innerHeight);
              pointerRef.current.dx += e.movementX || 0;
              pointerRef.current.dy += e.movementY || 0;
              pointerRef.current.x = nx;
              pointerRef.current.y = ny;
            }}
            onPointerDown={() => {
              pointerRef.current.down = true;
              pointerRef.current.clicked = true;
            }}
            onPointerUp={() => {
              pointerRef.current.down = false;
            }}
            onWheel={(e) => {
              pointerRef.current.wheelDelta += e.deltaY;
            }}
          >
            <canvas
              key={`2d-${activeScene}`}
              ref={canvas2dRef}
              className={`absolute inset-0 w-full h-full ${
                activeDef.isThree && glSupportRef.current.supported ? "hidden" : "block"
              }`}
            />
            <canvas
              key={`3d-${activeScene}`}
              ref={canvasGlRef}
              className={`absolute inset-0 w-full h-full ${
                activeDef.isThree && glSupportRef.current.supported ? "block" : "hidden"
              }`}
            />

            {/* Clean 1s Scene Transition Banner */}
            {transitionBanner && (
              <div className="fixed inset-x-0 top-20 z-50 flex justify-center pointer-events-none">
                <div className="px-5 py-2.5 rounded-xl bg-black/85 backdrop-blur-md border border-blue-500/60 shadow-2xl font-mono text-xs font-bold text-white tracking-wide flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  <span>{transitionBanner}</span>
                </div>
              </div>
            )}

            {/* Top Floating Translucent Swiss-Lab Telemetry HUD */}
            <div className="fixed top-3 left-3 right-3 z-50 flex items-center justify-between gap-2 flex-wrap pointer-events-auto">
              <div className="px-3.5 py-2 rounded-xl bg-black/80 backdrop-blur-md border border-white/15 flex items-center gap-3.5 flex-wrap font-mono tabular-nums text-xs">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold">
                    {String(activeSceneIdx + 1).padStart(2, "0")}/{SCENES.length}
                  </span>
                  <span className="font-bold text-white">{activeDef.shortName}</span>
                  <span className="text-[10px] text-blue-400 font-bold hidden sm:inline">
                    {hud.actLabel}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-[11px]">
                  <span>
                    <strong className="text-blue-400 text-sm">{hud.fps.toFixed(1)}</strong> FPS
                  </span>
                  <span className="text-zinc-300">
                    1%L <strong className="text-white">{hud.low1.toFixed(1)}</strong>
                  </span>
                  <span className="text-zinc-300">
                    0.1%L <strong className="text-white">{hud.low01.toFixed(1)}</strong>
                  </span>
                  <span className="text-zinc-300">
                    <strong className="text-white">{hud.frameMs.toFixed(1)}</strong>ms
                  </span>
                  <span data-testid="graphics-elapsed-clock" className="text-zinc-400 hidden md:inline">
                    {hud.elapsed.toFixed(1)}s
                  </span>
                  {suiteMode && (
                    <span className="text-blue-300 flex items-center gap-1 font-bold">
                      {manualPlay ? (
                        <>
                          <Pause className="w-3 h-3" /> PAUSED (PLAY)
                        </>
                      ) : (
                        <>
                          <Clock className="w-3 h-3" /> {fmtClock(hud.remaining)}
                        </>
                      )}
                    </span>
                  )}
                </div>

                {liveHw && (
                  <div className="hidden lg:flex items-center gap-2.5 text-[10.5px] border-l border-white/15 pl-3 text-zinc-300">
                    <Thermometer className="w-3.5 h-3.5 text-blue-400" />
                    <span>
                      CPU <strong className="text-white">{liveHw.cpuUsagePct.toFixed(0)}%</strong>
                    </span>
                    {liveHw.gpuTempC != null && (
                      <span>
                        GPU <strong className="text-white">{liveHw.gpuTempC.toFixed(0)}°C</strong>
                      </span>
                    )}
                    {liveHw.gpuLoadPct != null && (
                      <span>
                        Load <strong className="text-blue-400">{liveHw.gpuLoadPct.toFixed(0)}%</strong>
                      </span>
                    )}
                    {liveHw.gpuClockMhz != null && (
                      <span>
                        <strong className="text-white">{liveHw.gpuClockMhz}</strong>MHz
                      </span>
                    )}
                  </div>
                )}

                <svg
                  width="124"
                  height="28"
                  viewBox="0 0 124 28"
                  className="hidden xl:block bg-white/5 rounded border border-white/10"
                >
                  <polyline fill="none" stroke="#60A5FA" strokeWidth="1.6" points={sparkPath} />
                </svg>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Prev / Next Scene Skip Buttons */}
                <button
                  type="button"
                  onClick={() => jumpScene(-1)}
                  title="Previous Scene (P)"
                  className="px-2.5 py-1.5 rounded-xl bg-black/80 hover:bg-zinc-800 border border-white/20 text-white font-mono text-xs font-bold flex items-center gap-1 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </button>
                <button
                  type="button"
                  onClick={() => jumpScene(1)}
                  title="Next Scene (N)"
                  className="px-2.5 py-1.5 rounded-xl bg-black/80 hover:bg-zinc-800 border border-white/20 text-white font-mono text-xs font-bold flex items-center gap-1 cursor-pointer"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>

                {activeDef.playable && (
                  <button
                    type="button"
                    onClick={() => setManualPlay((p) => !p)}
                    className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold flex items-center gap-1.5 border cursor-pointer transition ${
                      manualPlay
                        ? "bg-blue-600 border-blue-400 text-white"
                        : "bg-black/80 border-white/20 text-zinc-200 hover:border-blue-400"
                    }`}
                  >
                    <Gamepad2 className="w-3.5 h-3.5" />
                    {manualPlay
                      ? suiteMode
                        ? "Resume Suite"
                        : "Manual Play ON"
                      : "Take Control (Play)"}
                  </button>
                )}

                {!suiteMode && (
                  <select
                    value={loadTier}
                    onChange={(e) => setLoadTier(e.target.value as LoadTier)}
                    className="px-2.5 py-1.5 rounded-xl bg-black/80 border border-white/20 text-white font-mono text-xs cursor-pointer"
                  >
                    {(Object.keys(LOAD_CONFIG) as LoadTier[]).map((k) => (
                      <option key={k} value={k} className="bg-black text-white">
                        {LOAD_CONFIG[k].label}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={exitFullscreen}
                  className="px-3.5 py-1.5 rounded-xl bg-white text-black hover:bg-zinc-200 font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  {suiteMode ? <Square className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
                  Exit (Esc)
                </button>
              </div>
            </div>

            {/* Bottom Throughput Pill + Suite Progress / Scene Switcher */}
            <div className="fixed bottom-3 left-3 right-3 z-50 flex flex-col items-center gap-2 pointer-events-auto">
              <div className="px-3.5 py-1.5 rounded-xl bg-black/80 backdrop-blur-md border border-white/15 font-mono text-[11px] flex items-center gap-3 flex-wrap justify-center">
                <span className="text-blue-400 font-bold">
                  {hud.metricLabel}: <span className="text-white">{hud.metricValue}</span>
                </span>
                <span className="text-zinc-400 hidden md:inline">•</span>
                <span className="text-zinc-300 hidden md:inline">
                  {manualPlay ? `PLAY MODE (TIMER PAUSED): ${activeDef.controlHint}` : activeDef.badge}
                </span>
                <span className="text-zinc-500">• {hud.webglLabel}</span>
              </div>

              {suiteMode ? (
                <div className="w-full max-w-2xl space-y-1">
                  <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-150"
                      style={{ width: `${hud.progressPct}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap justify-center bg-black/80 backdrop-blur-md border border-white/15 px-2.5 py-1.5 rounded-xl">
                  {SCENES.map((s, idx) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setTransitionBanner(`${String(idx + 1).padStart(2, "0")} / ${SCENES.length} • ${s.name}`);
                        setActiveScene(s.id);
                      }}
                      className={`px-2.5 py-1 rounded-lg font-mono text-[10.5px] font-bold transition cursor-pointer ${
                        activeScene === s.id
                          ? "bg-blue-600 text-white"
                          : "bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white"
                      }`}
                    >
                      {idx + 1}. {s.shortName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
