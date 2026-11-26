import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Clock,
  Cpu,
  Gamepad2,
  Globe,
  Layers,
  Maximize2,
  Minimize2,
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
  buildBoxGeometry,
  buildMegacityInstances,
  FULLSCREEN_QUAD_VS,
  linkGlProgram,
  MEGACITY_3D_FS,
  MEGACITY_3D_VS,
  RAYTRACE_STUDIO_FS,
  TERRAIN_OCEAN_FS,
  VOLUMETRIC_REACTOR_FS,
} from "./graphicsLab/shaders3d";
import {
  createPhysicsSimState,
  createStarfighterState,
  createTextBenchState,
  createVectorBenchState,
  createZoomBenchState,
  render2DRichTypographyScroll,
  render2DTextureDeepZoom,
  render2DVectorCeiling,
  renderPhysicsSandbox,
  renderStarfighterArena,
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
type SceneId =
  | "world_terrain"
  | "world_raytrace"
  | "world_megacity"
  | "world_reactor"
  | "bench_2d_vectors"
  | "bench_2d_zoom"
  | "bench_2d_text"
  | "game_starfighter"
  | "game_physics_sim";

interface SceneDef {
  id: SceneId;
  shortName: string;
  name: string;
  kind: "3D World" | "2D Graphics" | "Mini-Game";
  badge: string;
  playable: boolean;
  controlHint: string;
  description: string;
}

const SCENES: SceneDef[] = [
  {
    id: "world_terrain",
    shortName: "3D Terrain",
    name: "3D Alpine Terrain, Ocean Water & Volumetric Sun Flythrough",
    kind: "3D World",
    badge: "3D WORLD • UNIGINE STYLE",
    playable: true,
    controlHint: "Mouse: Steer Flight Pitch & Yaw through Mountain Canyon",
    description: "Full-color 3D snow peaks, dynamic sun shadows, reflective Fresnel ocean waves & 3-act canyon flight.",
  },
  {
    id: "world_raytrace",
    shortName: "3D Raytrace",
    name: "3D Real-Time Ray-Traced Chrome, Glass & Soft Shadows",
    kind: "3D World",
    badge: "3D RAYTRACING • 2→6 BOUNCES",
    playable: true,
    controlHint: "Mouse: Orbit 3D Ray-Traced Studio Camera",
    description: "True multi-bounce GLSL ray tracer with gold/chrome spheres, Snell glass refraction & soft shadows.",
  },
  {
    id: "world_megacity",
    shortName: "3D Megacity",
    name: "3D PBR Cyberpunk Megacity Flythrough (Instanced Geometry)",
    kind: "3D World",
    badge: "3D GEOMETRY • UP TO 7.5K MESHES",
    playable: true,
    controlHint: "Mouse: Steer Flight Bank & Altitude Between Skyscrapers",
    description: "Thousands of lit 3D skyscraper meshes, glowing window facades, aerial traffic & street canyon dive.",
  },
  {
    id: "world_reactor",
    shortName: "3D Reactor",
    name: "3D Volumetric Plasma Nebula & Fusion Reactor Torture",
    kind: "3D World",
    badge: "3D VOLUMETRIC • 32→112 STEPS",
    playable: true,
    controlHint: "Mouse: Orbit Crystalline Containment Rings",
    description: "Heavy 3D volumetric plasma raymarch pushing GPU shader ALUs, fillrate, and memory bandwidth.",
  },
  {
    id: "bench_2d_vectors",
    shortName: "2D Vectors",
    name: "2D Escalating Vector Ceiling, PCB & Clockwork Engine",
    kind: "2D Graphics",
    badge: "2D PASSMARK • MOTIONMARK",
    playable: false,
    controlHint: "Auto-escalating vector count (750 -> 6,000+) to find true 60 FPS ceiling",
    description: "Full-color PCB schematics, interlocking gears & prism shards measuring Max Vectors @ 60 FPS.",
  },
  {
    id: "bench_2d_zoom",
    shortName: "2D 64x Zoom",
    name: "2D Satellite Topographic Map & CAD Deep-Zoom (0.35x -> 64x)",
    kind: "2D Graphics",
    badge: "2D TEXTURE ZOOM • MP/S",
    playable: true,
    controlHint: "Mouse Wheel: Deep Zoom (0.3x-128x) • Drag: Pan Map",
    description: "Real high-res shaded relief satellite bitmap + hairline CAD overlay with multi-layer compositing.",
  },
  {
    id: "bench_2d_text",
    shortName: "2D Text/IDE",
    name: "2D Rich Code IDE, Data Table & Multi-Script Typography",
    kind: "2D Graphics",
    badge: "2D TYPOGRAPHY • GLYPHS/S",
    playable: true,
    controlHint: "Wheel / Up-Down: Scroll Velocity • +/-: Live Font Scale",
    description: "Syntax-highlighted code, live telemetry table, Myanmar & CJK scripts with 120Hz+ scroll & zoom.",
  },
  {
    id: "game_starfighter",
    shortName: "Starfighter",
    name: "Mini-Game 1: 3-Act Starfighter Wave & Dreadnought Boss",
    kind: "Mini-Game",
    badge: "PLAYABLE • BOSS ARENA",
    playable: true,
    controlHint: "Mouse / WASD: Fly Starfighter • Click / Space: Nova Pulse",
    description: "Escalating scout squadrons, heavy cruiser bullet curtains & Dreadnought Boss with explosions.",
  },
  {
    id: "game_physics_sim",
    shortName: "3000-Body Sim",
    name: "Mini-Game 2: 3-Act Rigid-Body Demolition & Gravity Sandbox",
    kind: "Mini-Game",
    badge: "PLAYABLE • PHYSICS WALL",
    playable: true,
    controlHint: "Click / Drag: Detonate Kinetic Shockwave Blast",
    description: "Destructible tower collapse -> gravity vortex -> 3,500 spatial-hash colliding velocity-lit bodies.",
  },
];

const LOAD_CONFIG: Record<
  LoadTier,
  {
    label: string;
    quality3d: number;
    cityInstances: number;
    physicsMaxBodies: number;
    weightMult: number;
  }
> = {
  light: {
    label: "Light (Ultrabook iGPU)",
    quality3d: 1,
    cityInstances: 1400,
    physicsMaxBodies: 1100,
    weightMult: 0.78,
  },
  standard: {
    label: "Standard (Balanced QC)",
    quality3d: 2,
    cityInstances: 3200,
    physicsMaxBodies: 2000,
    weightMult: 1.0,
  },
  heavy: {
    label: "Heavy (Creator / dGPU)",
    quality3d: 3,
    cityInstances: 5400,
    physicsMaxBodies: 2800,
    weightMult: 1.38,
  },
  ultra: {
    label: "Ultra (RTX Extreme)",
    quality3d: 4,
    cityInstances: 7800,
    physicsMaxBodies: 3500,
    weightMult: 1.85,
  },
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
      ? `Severe graphics stall detected in Real 2D & 3D Suite (Composite ${compositeScore}, ${smoothnessTier}). Check GPU driver acceleration and thermal clocks.`
      : status === "warn"
      ? `${smoothnessTier} 2D/3D benchmark performance (Composite ${compositeScore}, Avg ${meanFps.toFixed(
          1
        )} FPS${!webgl2Supported ? ", WebGL2 unavailable" : softwareFallback ? ", software renderer active" : `, peak stutter ${maxStutter.toFixed(1)}%`})${nativeBit}.`
      : `All ${scenes.length} real 3D worlds, 2D graphics & wave mini-game benchmarks verified (${smoothnessTier} • Composite ${compositeScore} • Avg ${meanFps.toFixed(
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
  const [activeScene, setActiveScene] = useState<SceneId>("world_terrain");
  const [manualPlay, setManualPlay] = useState(false);
  const [sceneScores, setSceneScores] = useState<Partial<Record<SceneId, GraphicsFpsSceneScore>>>({});

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
    webglLabel: "WebGL2",
  });

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
    renderer: adapterName || "GPU WebGL2",
  });

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

  const runComputeBench = useCallback(async () => {
    setComputeError(null);
    setComputeRunning(true);
    try {
      const res = await invoke<GpuComputeBenchResult>("run_gpu_compute_bench", {
        adapterIndex: selectedAdapter,
      });
      computeResultRef.current = res;
      onComputeComplete(res);
      return res;
    } catch (e) {
      setComputeError(String(e));
      return null;
    } finally {
      setComputeRunning(false);
    }
  }, [selectedAdapter, onComputeComplete]);

  const exitFullscreen = useCallback(() => {
    setFullscreenOpen(false);
    setSuiteMode(false);
    setManualPlay(false);
    onRunningChange(false);
    setNativeFullscreen(false);
  }, [onRunningChange, setNativeFullscreen]);

  const launchScene = useCallback(
    (sceneId: SceneId, asPlayable: boolean) => {
      setSuiteMode(false);
      setActiveScene(sceneId);
      setManualPlay(asPlayable);
      setFullscreenOpen(true);
      onRunningChange(true);
      setNativeFullscreen(true);
    },
    [onRunningChange, setNativeFullscreen]
  );

  const launchFullSuite = useCallback(() => {
    suiteAccRef.current = [];
    suiteStartMsRef.current = performance.now();
    setSceneScores({});
    setManualPlay(false);
    setSuiteMode(true);
    setActiveScene(SCENES[0].id);
    setFullscreenOpen(true);
    onRunningChange(true);
    setNativeFullscreen(true);
    if (!computeResultRef.current && !computeRunning) {
      runComputeBench().catch(() => {});
    }
  }, [computeRunning, onRunningChange, runComputeBench, setNativeFullscreen]);

  useEffect(() => {
    return () => {
      if (fullscreenOpenRef.current) {
        getCurrentWindow().setFullscreen(false).catch(() => {});
      }
    };
  }, []);

  // Poll REAL live hardware telemetry (GPU Temp / Clock / Load / CPU %) while fullscreen is open!
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
    const id = window.setInterval(poll, 1300);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [fullscreenOpen]);

  // Global keyboard controls in fullscreen
  useEffect(() => {
    if (!fullscreenOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitFullscreen();
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
  }, [fullscreenOpen, exitFullscreen]);

  // Main Fullscreen 9-Scene Real 3D & 2D Benchmark Loop
  useEffect(() => {
    if (!fullscreenOpen) return;

    const sceneDef = SCENES.find((s) => s.id === activeScene) ?? SCENES[0];
    const cfg = LOAD_CONFIG[loadTier];
    const sceneDuration = durationRef.current;
    const is3dGlScene = sceneDef.kind === "3D World";

    let rafId = 0;
    let cancelled = false;
    const sceneStartedAt = performance.now();
    let lastFrameAt = sceneStartedAt;
    let lastHudAt = sceneStartedAt;
    let playedManuallyInScene = manualPlayRef.current;

    const frameDts: number[] = [];
    const sparkBuf: number[] = [];

    // Real physical pixel backing buffer (capped cleanly at 1.5x DPR for heavy raymarching or 2x for 2D)
    const dpr = is3dGlScene
      ? Math.min(window.devicePixelRatio || 1, loadTier === "ultra" ? 1.5 : 1.25)
      : Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(640, window.innerWidth);
    const height = Math.max(400, window.innerHeight);

    const c2d = canvas2dRef.current;
    let ctx: CanvasRenderingContext2D | null = null;
    if (c2d) {
      c2d.width = Math.round(width * dpr);
      c2d.height = Math.round(height * dpr);
      ctx = c2d.getContext("2d", { alpha: false });
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const cgl = canvasGlRef.current;
    let gl: WebGL2RenderingContext | null = null;
    let glProg: WebGLProgram | null = null;
    let glVao: WebGLVertexArrayObject | null = null;
    const glBufs: WebGLBuffer[] = [];

    if (is3dGlScene && cgl) {
      cgl.width = Math.round(width * dpr);
      cgl.height = Math.round(height * dpr);
      gl = cgl.getContext("webgl2", { antialias: true, powerPreference: "high-performance" });
      if (gl) {
        glSupportRef.current.supported = true;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          const r = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (typeof r === "string" && r.trim()) {
            glSupportRef.current.renderer = r.trim();
          }
        }
        gl.viewport(0, 0, cgl.width, cgl.height);

        if (activeScene === "world_terrain") {
          glProg = linkGlProgram(gl, FULLSCREEN_QUAD_VS, TERRAIN_OCEAN_FS);
          glVao = gl.createVertexArray();
        } else if (activeScene === "world_raytrace") {
          glProg = linkGlProgram(gl, FULLSCREEN_QUAD_VS, RAYTRACE_STUDIO_FS);
          glVao = gl.createVertexArray();
        } else if (activeScene === "world_reactor") {
          glProg = linkGlProgram(gl, FULLSCREEN_QUAD_VS, VOLUMETRIC_REACTOR_FS);
          glVao = gl.createVertexArray();
        } else if (activeScene === "world_megacity") {
          glProg = linkGlProgram(gl, MEGACITY_3D_VS, MEGACITY_3D_FS);
          if (glProg) {
            glVao = gl.createVertexArray();
            gl.bindVertexArray(glVao);
            const box = buildBoxGeometry();
            const vbo = gl.createBuffer();
            if (vbo) {
              glBufs.push(vbo);
              gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
              gl.bufferData(gl.ARRAY_BUFFER, box, gl.STATIC_DRAW);
              gl.enableVertexAttribArray(0);
              gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
              gl.enableVertexAttribArray(1);
              gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
            }
            const city = buildMegacityInstances(cfg.cityInstances);
            const ibo1 = gl.createBuffer();
            if (ibo1) {
              glBufs.push(ibo1);
              gl.bindBuffer(gl.ARRAY_BUFFER, ibo1);
              gl.bufferData(gl.ARRAY_BUFFER, city.originHeight, gl.STATIC_DRAW);
              gl.enableVertexAttribArray(2);
              gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
              gl.vertexAttribDivisor(2, 1);
            }
            const ibo2 = gl.createBuffer();
            if (ibo2) {
              glBufs.push(ibo2);
              gl.bindBuffer(gl.ARRAY_BUFFER, ibo2);
              gl.bufferData(gl.ARRAY_BUFFER, city.footprintSeed, gl.STATIC_DRAW);
              gl.enableVertexAttribArray(3);
              gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 16, 0);
              gl.vertexAttribDivisor(3, 1);
            }
            gl.enable(gl.DEPTH_TEST);
          }
        }
      } else {
        glSupportRef.current.supported = false;
      }
    }

    // Initialize 2D / Mini-Game states
    const vecState = createVectorBenchState();
    const zoomState = createZoomBenchState();
    const textState = createTextBenchState();
    const shooterState = createStarfighterState(width, height);
    const physicsState = createPhysicsSimState(width, height, cfg.physicsMaxBodies);

    let primaryLabel = sceneDef.shortName;
    let primaryValue = "—";
    let actLabel = "ACT I • Baseline";
    let throughputFactor = 1.0;

    const finalizeScene = (nowMs: number) => {
      const stats = computeFrameStats(frameDts);
      const score = Math.max(
        100,
        Math.round((stats.avgFps * 68 + stats.low1pctFps * 32) * cfg.weightMult * throughputFactor)
      );
      const sceneStatus: TestStatus =
        stats.avgFps < 10
          ? "fail"
          : stats.stutterPct > 28 || (is3dGlScene && !gl)
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

      if (suiteModeRef.current) {
        suiteAccRef.current = [
          ...suiteAccRef.current.filter((s) => s.id !== sceneDef.id),
          sceneScore,
        ];
        const curIdx = SCENES.findIndex((s) => s.id === sceneDef.id);
        if (curIdx >= 0 && curIdx + 1 < SCENES.length) {
          setActiveScene(SCENES[curIdx + 1].id);
        } else {
          const totalSecs = (nowMs - suiteStartMsRef.current) / 1000;
          const finalSuite = classifySuiteResult(
            suiteAccRef.current,
            loadTierRef.current,
            `${Math.round(width * dpr)}x${Math.round(height * dpr)}`,
            glSupportRef.current.supported,
            glSupportRef.current.renderer,
            totalSecs,
            computeResultRef.current
          );
          onSuiteComplete(finalSuite);
          exitFullscreen();
        }
      }
    };

    const tick = (now: number) => {
      if (cancelled) return;
      const dtMs = Math.max(0.5, Math.min(250, now - lastFrameAt));
      lastFrameAt = now;
      frameDts.push(dtMs);
      sparkBuf.push(dtMs);
      if (sparkBuf.length > 72) sparkBuf.shift();

      const t = (now - sceneStartedAt) / 1000;
      const dt = Math.min(0.05, dtMs / 1000);
      // In solo explore mode, smoothly progress across 3 acts over sceneDuration and keep evolving smoothly
      const prog = suiteModeRef.current
        ? Math.min(1, t / sceneDuration)
        : (t % (sceneDuration * 1.5)) / (sceneDuration * 1.5);
      if (manualPlayRef.current) playedManuallyInScene = true;

      if (is3dGlScene) {
        const pxCount = (cgl?.width ?? width) * (cgl?.height ?? height);
        const curFpsEst = 1000 / Math.max(1, dtMs);
        if (gl && glProg && glVao) {
          gl.useProgram(glProg);
          gl.bindVertexArray(glVao);
          gl.uniform1f(gl.getUniformLocation(glProg, "uTime"), t);
          gl.uniform1f(gl.getUniformLocation(glProg, "uProgress"), prog);
          gl.uniform2f(
            gl.getUniformLocation(glProg, "uPointer"),
            pointerRef.current.x,
            pointerRef.current.y
          );
          gl.uniform1f(
            gl.getUniformLocation(glProg, "uManual"),
            manualPlayRef.current ? 1.0 : 0.0
          );

          if (activeScene === "world_megacity") {
            gl.clearColor(0.04, 0.07, 0.16, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.uniform1f(gl.getUniformLocation(glProg, "uAspect"), width / Math.max(1, height));
            // Progressive Act I -> II -> III active building count escalation!
            const activeInst = Math.max(
              600,
              Math.round(cfg.cityInstances * (prog < 0.33 ? 0.45 : prog < 0.66 ? 0.75 : 1.0))
            );
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, activeInst);
            const mTriPerSec = (activeInst * 12 * curFpsEst) / 1_000_000;
            primaryLabel = "3D Geometry";
            primaryValue = `${activeInst.toLocaleString()} meshes • ${mTriPerSec.toFixed(1)} MTri/s`;
            actLabel =
              prog < 0.33
                ? "ACT I • Skyline Approach"
                : prog < 0.66
                ? "ACT II • Downtown Street Canyon Dive"
                : "ACT III • Full Megacity Orbital Stress";
            throughputFactor = Math.max(0.7, activeInst / 3200);
          } else {
            gl.uniform2f(gl.getUniformLocation(glProg, "uRes"), cgl!.width, cgl!.height);
            gl.uniform1i(gl.getUniformLocation(glProg, "uQuality"), cfg.quality3d);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            if (activeScene === "world_terrain") {
              const mpSec = (pxCount * curFpsEst) / 1_000_000;
              primaryLabel = "3D Terrain";
              primaryValue = `${mpSec.toFixed(0)} MP/s • ${4 + cfg.quality3d + (prog > 0.66 ? 2 : 0)} FBM octaves`;
              actLabel =
                prog < 0.33
                  ? "ACT I • Coastal Ocean Skim"
                  : prog < 0.66
                  ? "ACT II • Alpine Ridge & Sunset"
                  : "ACT III • Ultra-Octave Canyon Dive";
              throughputFactor = Math.max(0.8, cfg.quality3d * 0.55);
            } else if (activeScene === "world_raytrace") {
              const bounces = Math.min(6, 1 + cfg.quality3d + (prog > 0.66 ? 2 : 0));
              const mRays = (pxCount * bounces * curFpsEst) / 1_000_000;
              primaryLabel = "Ray Tracing";
              primaryValue = `${mRays.toFixed(0)} MRays/s • ${bounces} bounces`;
              actLabel =
                prog < 0.33
                  ? "ACT I • Metallic Reflections"
                  : prog < 0.66
                  ? "ACT II • Floor Glaze & Soft Shadows"
                  : "ACT III • 6-Bounce Glass Refraction Stress";
              throughputFactor = Math.max(0.8, bounces / 3.5);
            } else {
              const steps = Math.min(116, 28 + cfg.quality3d * 18 + Math.floor(prog * 28));
              const gSteps = (pxCount * steps * curFpsEst) / 1_000_000_000;
              primaryLabel = "Volumetric 3D";
              primaryValue = `${gSteps.toFixed(1)} GSteps/s • ${steps} steps/px`;
              actLabel =
                prog < 0.33
                  ? "ACT I • Containment Core Ignition"
                  : prog < 0.66
                  ? "ACT II • Volumetric Nebula Density Ramp"
                  : "ACT III • Peak 112-Step Fillrate Torture";
              throughputFactor = Math.max(0.8, steps / 64);
            }
          }
        } else if (ctx) {
          ctx.fillStyle = "#09090B";
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = "#F8FAFC";
          ctx.font = "700 16px Consolas, monospace";
          ctx.fillText("WebGL2 context unavailable on this GPU driver — Software Fallback Flagged.", 48, height * 0.5);
          primaryLabel = "WebGL2";
          primaryValue = "Unavailable (Fallback)";
        }
      } else if (ctx) {
        let out;
        if (activeScene === "bench_2d_vectors") {
          out = render2DVectorCeiling(ctx, width, height, t, prog, dtMs, cfg.weightMult, vecState);
        } else if (activeScene === "bench_2d_zoom") {
          out = render2DTextureDeepZoom(
            ctx,
            width,
            height,
            t,
            prog,
            manualPlayRef.current,
            pointerRef.current,
            cfg.weightMult,
            zoomState
          );
        } else if (activeScene === "bench_2d_text") {
          out = render2DRichTypographyScroll(
            ctx,
            width,
            height,
            t,
            prog,
            dt,
            manualPlayRef.current,
            pointerRef.current,
            keysRef.current,
            textState
          );
        } else if (activeScene === "game_starfighter") {
          out = renderStarfighterArena(
            ctx,
            width,
            height,
            t,
            prog,
            dt,
            manualPlayRef.current,
            pointerRef.current,
            keysRef.current,
            cfg.weightMult,
            shooterState
          );
        } else {
          out = renderPhysicsSandbox(
            ctx,
            width,
            height,
            t,
            prog,
            dt,
            manualPlayRef.current,
            pointerRef.current,
            physicsState
          );
        }
        primaryLabel = out.metricLabel;
        primaryValue = out.metricValue;
        actLabel = out.actLabel;
        throughputFactor = out.throughputScoreFactor;
      }

      if (now - lastHudAt >= 120) {
        lastHudAt = now;
        const recent = computeFrameStats(frameDts.slice(-140));
        setHud({
          fps: recent.avgFps,
          low1: recent.low1pctFps,
          low01: recent.low01pctFps,
          frameMs: recent.avgFrameMs,
          elapsed: t,
          remaining: Math.max(0, sceneDuration - t),
          progressPct: Math.min(100, Math.round(prog * 100)),
          actLabel,
          metricLabel: primaryLabel,
          metricValue: primaryValue,
          sparkline: [...sparkBuf],
          webglLabel: glSupportRef.current.supported ? "WebGL2 HW" : "Fallback",
        });
      }

      if (suiteModeRef.current && t >= sceneDuration) {
        finalizeScene(now);
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (gl) {
        glBufs.forEach((b) => gl?.deleteBuffer(b));
        if (glVao) gl.deleteVertexArray(glVao);
        if (glProg) gl.deleteProgram(glProg);
      }
    };
  }, [fullscreenOpen, activeScene, loadTier, durationSecs, exitFullscreen, onSuiteComplete]);

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
                Real 2D &amp; 3D Fullscreen Graphics Benchmark Suite (v3.3.0)
              </h2>
              {suiteResult && <StatusBadge status={suiteResult.status} compact />}
            </div>
            <p className="text-xs text-zinc-500 max-w-2xl">
              Full-color 3DMark/Unigine-class 3D worlds (Alpine Terrain &amp; Ocean, Multi-Bounce Ray Tracing, 7,500-Mesh Cyberpunk Megacity, Volumetric Reactor) + PassMark-2D Vector Ceiling, 64x Satellite Map Zoom, Rich IDE Typography &amp; 3-Act Boss/Physics Games — plus native uncapped Rust <code className="font-mono text-black">wgpu</code> 1080p 3D FPS.
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
              Launch Real 2D+3D Suite ({fmtClock(totalSuiteSecs)})
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
                  "Breaks 60Hz WebView VSync cap: renders photorealistic 1080p 3D terrain + chrome orb directly on DX12/Vulkan/Metal alongside verified FP32 shader GFLOPS."
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
          scoreLabel="2D+3D MARK"
          scoreValue={suiteResult.compositeScore.toLocaleString()}
          title={`Real 2D & 3D Graphics Suite — ${suiteResult.smoothnessTier} (${suiteResult.resolution})`}
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

      {/* 9-Scene Gallery (Grouped Visually with Clear 3D World / 2D Graphics / Mini-Game Badges) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {SCENES.map((sc, idx) => {
          const score =
            suiteResult?.scenes.find((s) => s.id === sc.id) ?? sceneScores[sc.id] ?? null;
          const Icon =
            sc.id === "world_terrain"
              ? Globe
              : sc.id === "world_raytrace"
              ? Sparkles
              : sc.id === "world_megacity"
              ? Layers
              : sc.id === "world_reactor"
              ? Zap
              : sc.id === "bench_2d_zoom"
              ? Search
              : sc.id === "bench_2d_text"
              ? Type
              : sc.id === "game_starfighter"
              ? Rocket
              : sc.id === "game_physics_sim"
              ? Gamepad2
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
                      {sc.playable ? "3-ACT • PLAYABLE" : "3-ACT RAMP"}
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
                  <Play className="w-3 h-3 text-blue-600" /> Run ({durationSecs}s)
                </button>
                {sc.playable && (
                  <button
                    type="button"
                    disabled={fullscreenOpen}
                    onClick={() => launchScene(sc.id, true)}
                    className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Gamepad2 className="w-3 h-3" /> Play
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
              ref={canvas2dRef}
              className={`absolute inset-0 w-full h-full ${
                activeDef.kind === "3D World" && glSupportRef.current.supported ? "hidden" : "block"
              }`}
            />
            <canvas
              ref={canvasGlRef}
              className={`absolute inset-0 w-full h-full ${
                activeDef.kind === "3D World" && glSupportRef.current.supported ? "block" : "hidden"
              }`}
            />

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
                  {suiteMode && (
                    <span className="text-blue-300 flex items-center gap-1 font-bold">
                      <Clock className="w-3 h-3" /> {fmtClock(hud.remaining)}
                    </span>
                  )}
                </div>

                {/* Live Hardware GPU / CPU Telemetry */}
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

              <div className="flex items-center gap-2 flex-wrap">
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
                    {manualPlay ? "Manual Play ON" : "Take Control (Play)"}
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

            {/* Bottom Throughput Pill + Progress Bar + Scene Switcher */}
            <div className="fixed bottom-3 left-3 right-3 z-50 flex flex-col items-center gap-2 pointer-events-auto">
              <div className="px-3.5 py-1.5 rounded-xl bg-black/80 backdrop-blur-md border border-white/15 font-mono text-[11px] flex items-center gap-3 flex-wrap justify-center">
                <span className="text-blue-400 font-bold">
                  {hud.metricLabel}: <span className="text-white">{hud.metricValue}</span>
                </span>
                <span className="text-zinc-400 hidden md:inline">•</span>
                <span className="text-zinc-300 hidden md:inline">
                  {manualPlay ? `MANUAL: ${activeDef.controlHint}` : activeDef.badge}
                </span>
                <span className="text-zinc-500">• {hud.webglLabel}</span>
              </div>

              {suiteMode ? (
                <div className="w-full max-w-2xl h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-150"
                    style={{ width: `${hud.progressPct}%` }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap justify-center bg-black/80 backdrop-blur-md border border-white/15 px-2.5 py-1.5 rounded-xl">
                  {SCENES.map((s, idx) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setActiveScene(s.id)}
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
