import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Cpu,
  Gamepad2,
  Layers,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Play,
  Rocket,
  Search,
  Sparkles,
  Square,
  Type,
  Zap,
} from "lucide-react";
import type {
  GpuComputeBenchResult,
  GraphicsFpsSceneScore,
  GraphicsFpsSuiteResult,
  TestStatus,
} from "../types";
import { StatusBadge } from "./StatusBadge";
import { NovabenchScoreBar } from "./NovabenchScoreBar";

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
type SceneId =
  | "graphics_2d"
  | "zoom_cad"
  | "text_render"
  | "webgl_3d"
  | "shader_overdraw"
  | "game_shooter"
  | "game_physics"
  | "game_tunnel"
  | "ui_reflow";

interface SceneDef {
  id: SceneId;
  shortName: string;
  name: string;
  category: "2D Graphics" | "Zooming" | "Text" | "3D WebGL2" | "Shader" | "Mini-Game" | "UI Reflow";
  durationSecs: number;
  playable: boolean;
  controlHint: string;
  description: string;
}

const SCENES: SceneDef[] = [
  {
    id: "graphics_2d",
    shortName: "2D Vectors",
    name: "Graphic Rendering (2D Vectors & Particle Storm)",
    category: "2D Graphics",
    durationSecs: 5,
    playable: false,
    controlHint: "Procedural Bezier ribbons, radial light pulses & scaling kinetic particles",
    description: "Tests 2D vector rasterization, alpha blending, and particle throughput.",
  },
  {
    id: "zoom_cad",
    shortName: "1x-128x Zoom",
    name: "Graphic Zooming (1x -> 128x CAD Blueprint & Fractal)",
    category: "Zooming",
    durationSecs: 5,
    playable: true,
    controlHint: "Mouse Wheel: Deep Zoom (0.5x-512x) • Drag: Pan Blueprint",
    description: "Continuous deep zoom-in/out & pan across an architectural CAD schematic & fractal.",
  },
  {
    id: "text_render",
    shortName: "Text & Scroll",
    name: "Text & Typography Rendering & Smooth Scroll",
    category: "Text",
    durationSecs: 5,
    playable: true,
    controlHint: "Mouse Wheel or Up/Down Arrows: Control Scroll Velocity",
    description: "Multi-size Unicode, Myanmar, CJK & code glyph rasterizer measuring Glyphs/sec.",
  },
  {
    id: "webgl_3d",
    shortName: "3D WebGL2",
    name: "3D WebGL2 Instanced Lighting Arena",
    category: "3D WebGL2",
    durationSecs: 5,
    playable: true,
    controlHint: "Move Mouse: Orbit 3D Camera & Specular Spotlight",
    description: "Custom GLSL lit metallic 3D polyhedra arena with orbiting lights & reflections.",
  },
  {
    id: "shader_overdraw",
    shortName: "Shader Fill",
    name: "GPU Shader Overdraw & Fillrate Stress",
    category: "Shader",
    durationSecs: 5,
    playable: true,
    controlHint: "Move Mouse: Shift Volumetric Ray Origin",
    description: "Multi-layer WebGL2 volumetric ray/noise overdraw exposing bandwidth & micro-stutters.",
  },
  {
    id: "game_shooter",
    shortName: "Starfighter",
    name: "Mini-Game 1: Starfighter Bullet-Hell Arena",
    category: "Mini-Game",
    durationSecs: 5,
    playable: true,
    controlHint: "Mouse / WASD: Fly Starfighter • Click / Space: Overdrive Nova",
    description: "Incoming enemy waves, twin lasers, shockwaves & particle explosions (Auto-AI or Play).",
  },
  {
    id: "game_physics",
    shortName: "2000-Ball Sim",
    name: "Mini-Game 2: 2,000-Ball Physics & Gravity Sandbox",
    category: "Mini-Game",
    durationSecs: 5,
    playable: true,
    controlHint: "Click / Drag: Gravity Shockwave Blast & Kinetic Spawn",
    description: "Real-time spatial-hash rigid-body collisions with velocity trails & gravity flips.",
  },
  {
    id: "game_tunnel",
    shortName: "Hyper-Tunnel",
    name: "Mini-Game 3: 3D Hyper-Tunnel Reflex Runner",
    category: "Mini-Game",
    durationSecs: 5,
    playable: true,
    controlHint: "Left/Right Arrows or Mouse X: Steer Gate Lane • Space: Boost",
    description: "High-speed 3D perspective gate runner testing 60/120/144/240Hz pacing & reflex ms.",
  },
  {
    id: "ui_reflow",
    shortName: "UI Reflow",
    name: "Web / Office UI Reflow & Layout Latency",
    category: "UI Reflow",
    durationSecs: 4,
    playable: false,
    controlHint: "Live main-thread DOM layout, sort & style-recalc burst (Speedometer-style)",
    description: "Measures real browser/WebView DOM reflow throughput (UI Ops/sec) & P95 latency.",
  },
];

const LOAD_CONFIG: Record<
  LoadTier,
  {
    label: string;
    particles: number;
    instances3d: number;
    shaderLayers: number;
    physicsBalls: number;
    weightMult: number;
  }
> = {
  light: {
    label: "Light (Ultrabook)",
    particles: 1500,
    instances3d: 220,
    shaderLayers: 14,
    physicsBalls: 400,
    weightMult: 0.75,
  },
  standard: {
    label: "Standard (QC Default)",
    particles: 3500,
    instances3d: 520,
    shaderLayers: 24,
    physicsBalls: 900,
    weightMult: 1.0,
  },
  heavy: {
    label: "Heavy (Creator / dGPU)",
    particles: 7000,
    instances3d: 1100,
    shaderLayers: 36,
    physicsBalls: 1500,
    weightMult: 1.35,
  },
  ultra: {
    label: "Ultra (Gaming Extreme)",
    particles: 12000,
    instances3d: 2200,
    shaderLayers: 48,
    physicsBalls: 2000,
    weightMult: 1.75,
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
    return { avgFps: 0, low1pctFps: 0, low01pctFps: 0, avgFrameMs: 0, jitterMs: 0, stutterFrames: 0, stutterPct: 0 };
  }
  const clean = frameDtsMs.map((d) => Math.max(0.5, Math.min(500, d)));
  const sum = clean.reduce((a, b) => a + b, 0);
  const avgMs = sum / clean.length;
  const variance = clean.reduce((acc, d) => acc + (d - avgMs) * (d - avgMs), 0) / clean.length;
  const jitterMs = Math.sqrt(variance);
  const sorted = [...clean].sort((a, b) => b - a); // slowest frames first
  const idx1 = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.01)));
  const idx01 = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.001)));
  const top1Slice = sorted.slice(0, Math.max(1, idx1 + 1));
  const avg1Ms = top1Slice.reduce((a, b) => a + b, 0) / top1Slice.length;
  const top01Ms = sorted[idx01];
  const stutterThreshold = Math.max(33.4, avgMs * 2.1);
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
  uiReflowOpsPerSec: number,
  uiReflowP95Ms: number,
  elapsedSecs: number
): GraphicsFpsSuiteResult {
  const valid = scenes.filter((s) => s.score > 0);
  const compositeScore =
    valid.length > 0
      ? Math.round(valid.reduce((a, b) => a + b.score, 0) / valid.length)
      : 0;
  const meanFps =
    scenes.length > 0
      ? scenes.reduce((a, b) => a + b.avgFps, 0) / scenes.length
      : 0;
  const peakFps = scenes.reduce((m, s) => Math.max(m, s.avgFps), 60);
  const displayHz = peakFps >= 200 ? 240 : peakFps >= 155 ? 165 : peakFps >= 130 ? 144 : peakFps >= 100 ? 120 : 60;
  const maxStutter = scenes.reduce((m, s) => Math.max(m, s.stutterFramesPct), 0);
  const core2d = scenes.filter((s) =>
    ["graphics_2d", "zoom_cad", "text_render"].includes(s.id)
  );
  const severe2dStall = core2d.some((s) => s.avgFps > 0 && s.avgFps < 10);
  const softwareFallback =
    /swiftshader|llvmpipe|microsoft basic render/i.test(gpuRendererString);

  let smoothnessTier = "Smooth";
  if (meanFps >= 95 && maxStutter < 6 && webgl2Supported && !softwareFallback) {
    smoothnessTier = "Ultra";
  } else if (meanFps >= 52 && maxStutter < 15 && !softwareFallback) {
    smoothnessTier = "Smooth";
  } else if (meanFps >= 28 && !severe2dStall) {
    smoothnessTier = "Office Ready";
  } else {
    smoothnessTier = "Struggling";
  }

  let status: TestStatus = "pass";
  if (severe2dStall || scenes.some((s) => s.status === "fail")) {
    status = "fail";
  } else if (!webgl2Supported || softwareFallback || maxStutter > 25 || meanFps < 24) {
    status = "warn";
  }

  const plainSummary =
    status === "fail"
      ? `Severe rendering stall detected across fullscreen graphics lab (Composite ${compositeScore}, ${smoothnessTier}). Check GPU driver acceleration and thermal clocks.`
      : status === "warn"
      ? `${smoothnessTier} fullscreen graphics performance (Composite ${compositeScore}, Avg ${meanFps.toFixed(
          1
        )} FPS${!webgl2Supported ? ", WebGL2 unavailable" : softwareFallback ? ", software renderer active" : `, peak stutter ${maxStutter.toFixed(1)}%`}).`
      : `All ${scenes.length} fullscreen graphics, zooming, text, 3D & mini-game scenes verified smoothly (${smoothnessTier} • Composite ${compositeScore} • Avg ${meanFps.toFixed(
          1
        )} FPS • UI Reflow ${uiReflowOpsPerSec.toFixed(0)} ops/s).`;

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
    uiReflowOpsPerSec: Number(uiReflowOpsPerSec.toFixed(1)),
    uiReflowP95Ms: Number(uiReflowP95Ms.toFixed(2)),
    scenes,
    gpuCompute: null,
    elapsedSecs: Number(elapsedSecs.toFixed(1)),
    summary: `Composite ${compositeScore} (${smoothnessTier}) • Avg ${meanFps.toFixed(1)} FPS • ${scenes.length} scenes`,
    plainSummary,
  };
}

// ---------- WebGL2 Helpers (Strict Cobalt Blue / Obsidian / White Palette) ----------
function compileGlShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function linkGlProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram | null {
  const vs = compileGlShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileGlShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

const ARENA_3D_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec4 aInstPosScale;
uniform float uTime;
uniform float uAspect;
uniform vec2 uCamOffset;
out vec3 vNormal;
out vec3 vWorldPos;
out float vDepth;
out float vAccent;

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c); }

void main() {
  float idx = float(gl_InstanceID);
  float spin = uTime * (0.7 + mod(idx, 7.0) * 0.14) + idx * 0.37;
  mat3 m = rotY(spin) * rotX(spin * 0.65);
  vec3 lp = m * (aPos * aInstPosScale.w);
  vec3 wp = lp + aInstPosScale.xyz;
  wp.y += sin(uTime * 1.8 + idx * 0.25) * 0.35;

  // Camera orbit
  float yaw = uTime * 0.32 + uCamOffset.x * 1.4;
  float pitch = 0.28 + uCamOffset.y * 0.7;
  mat3 camR = rotX(pitch) * rotY(yaw);
  vec3 camPos = camR * wp;
  camPos.z -= 16.5;

  vNormal = normalize(camR * (m * aNorm));
  vWorldPos = wp;
  vDepth = clamp(-camPos.z / 32.0, 0.0, 1.0);
  vAccent = mod(idx, 5.0) < 1.0 ? 1.0 : 0.0;

  float fov = 1.65;
  float near = 0.2;
  float far = 80.0;
  float z = max(-camPos.z, 0.25);
  gl_Position = vec4(
    (camPos.x * fov / uAspect) / z,
    (camPos.y * fov) / z,
    ((z - near) / (far - near)) * 2.0 - 1.0,
    1.0
  );
}
`;

const ARENA_3D_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorldPos;
in float vDepth;
in float vAccent;
uniform float uTime;
out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 light1 = normalize(vec3(cos(uTime * 1.3) * 8.0, 6.5, sin(uTime * 1.3) * 8.0) - vWorldPos);
  vec3 light2 = normalize(vec3(-6.0, -4.0, 7.0));
  vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));

  float diff1 = max(dot(n, light1), 0.0);
  float diff2 = max(dot(n, light2), 0.0) * 0.45;
  vec3 halfV = normalize(light1 + viewDir);
  float spec = pow(max(dot(n, halfV), 0.0), 36.0);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);

  vec3 baseObsidian = vec3(0.06, 0.08, 0.14);
  vec3 cobalt = vec3(0.145, 0.388, 0.922);
  vec3 cobaltBright = vec3(0.376, 0.647, 0.980);
  vec3 crispWhite = vec3(0.97, 0.98, 1.0);

  vec3 col = baseObsidian + mix(cobalt, cobaltBright, vAccent) * (diff1 * 0.95 + diff2 * 0.5);
  col += crispWhite * (spec * 0.85 + fres * 0.35);
  col = mix(col, vec3(0.035, 0.035, 0.043), vDepth * 0.62);
  fragColor = vec4(col, 1.0);
}
`;

const OVERDRAW_VS = `#version 300 es
precision highp float;
const vec2 POS[6] = vec2[](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const OVERDRAW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform int uLayers;
out vec4 fragColor;

void main() {
  vec2 p = (vUv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0) * 2.4;
  vec2 origin = (uPointer - 0.5) * 0.9;
  float accum = 0.0;
  float spec = 0.0;

  for (int i = 0; i < 64; i++) {
    if (i >= uLayers) break;
    float fi = float(i) + 1.0;
    float ang = uTime * (0.28 + 0.015 * fi) + fi * 0.42;
    mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 q = rot * (p - origin * (0.35 + fi * 0.02));
    float r = length(q);
    float ring = abs(sin(r * (4.5 + fi * 0.35) - uTime * 2.2) * cos(q.x * 3.1 + q.y * 2.7 + fi));
    float glow = 0.024 / (ring + 0.045);
    accum += glow / float(uLayers);
    spec += exp(-r * (1.8 + fi * 0.08)) * abs(sin(atan(q.y, q.x) * 6.0 + uTime * 1.7 + fi));
  }

  vec3 bg = vec3(0.035, 0.035, 0.043);
  vec3 cobalt = vec3(0.145, 0.388, 0.922);
  vec3 ice = vec3(0.576, 0.773, 0.992);
  vec3 white = vec3(0.98, 0.99, 1.0);

  vec3 col = bg + cobalt * clamp(accum * 1.55, 0.0, 1.2) + ice * clamp(spec * 0.08, 0.0, 0.75);
  col += white * pow(clamp(accum * 0.9, 0.0, 1.0), 3.0) * 0.7;
  fragColor = vec4(col, 1.0);
}
`;

// Unit cube vertices (36 verts, pos + normal)
function buildCubeGeometry(): Float32Array {
  const faces: Array<[number[], number[][]]> = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, -1, -1], [-1, 1, 1], [-1, 1, -1]]],
  ];
  const out: number[] = [];
  for (const [n, verts] of faces) {
    for (const v of verts) {
      out.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5, n[0], n[1], n[2]);
    }
  }
  return new Float32Array(out);
}

const TEXT_LINES = [
  "LAPTOPBENCH QC v3.2.0 // SWISS HARDWARE TELEMETRY & GLYPH RASTERIZER",
  "fn run_gpu_compute_bench(adapter: Option<usize>) -> Result<GpuComputeBenchResult, String>",
  "Myanmar Unicode: မင်္ဂလာပါ — လက်တော့ပ် ဟာ့ဒ်ဝဲ စမ်းသပ်မှု စွမ်းဆောင်ရည် စစ်ဆေးခြင်း ၁၂၃၄၅၆၇၈၉၀",
  "CJK Glyphs: 高性能グラフィックス検証・テキスト描画ベンチマーク・硬件诊断测试系统 2026",
  "Math & Precision: ∑(i=1..n) Δt_i ≤ 8.33ms | √(σ² + μ²) ≈ 144.00 Hz | π·r² ≠ ∞ | ±0.01%",
  "Telemetry Stream: CPU 3890 MHz | DDR5-5600 Dual-Channel 64.2 GB/s | NVMe PCIe Gen4 x4",
  "Kerning & Hinting: AVATAR WaVe ToYoTa fi fl ffl 0123456789 O0 Il1 | Monospace 100% Tabular",
  "Frame Pacing Target: 60Hz (16.67ms) • 120Hz (8.33ms) • 144Hz (6.94ms) • 240Hz (4.17ms)",
];

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
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [suiteMode, setSuiteMode] = useState(false);
  const [activeScene, setActiveScene] = useState<SceneId>("graphics_2d");
  const [manualPlay, setManualPlay] = useState(false);
  const [sceneScores, setSceneScores] = useState<Partial<Record<SceneId, GraphicsFpsSceneScore>>>({});

  const [computeRunning, setComputeRunning] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);

  // Live HUD state updated at ~12Hz to avoid React reconciliation overhead during 240Hz loops
  const [hud, setHud] = useState({
    fps: 0,
    low1: 0,
    low01: 0,
    frameMs: 0,
    progressPct: 0,
    metricLabel: "Ready",
    metricValue: "—",
    sparkline: [] as number[],
    webglLabel: "WebGL2",
  });

  // DOM container for Scene 9 (UI Reflow Latency)
  const reflowHostRef = useRef<HTMLDivElement | null>(null);
  const canvas2dRef = useRef<HTMLCanvasElement | null>(null);
  const canvasGlRef = useRef<HTMLCanvasElement | null>(null);

  // Mutable live refs for zero-overhead animation loop access
  const activeSceneRef = useRef<SceneId>(activeScene);
  activeSceneRef.current = activeScene;
  const loadTierRef = useRef<LoadTier>(loadTier);
  loadTierRef.current = loadTier;
  const manualPlayRef = useRef<boolean>(manualPlay);
  manualPlayRef.current = manualPlay;
  const suiteModeRef = useRef<boolean>(suiteMode);
  suiteModeRef.current = suiteMode;
  const fullscreenOpenRef = useRef<boolean>(fullscreenOpen);
  fullscreenOpenRef.current = fullscreenOpen;

  const suiteAccRef = useRef<GraphicsFpsSceneScore[]>([]);
  const suiteStartMsRef = useRef<number>(0);
  const glSupportRef = useRef<{ supported: boolean; renderer: string }>({
    supported: true,
    renderer: adapterName || "GPU WebGL2",
  });
  const uiReflowMetricsRef = useRef<{ opsPerSec: number; p95Ms: number }>({
    opsPerSec: 0,
    p95Ms: 0,
  });

  // Interactive pointer / keyboard refs shared with playable scenes
  const pointerRef = useRef({
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
      // Safe no-op in E2E headless browser mock
    }
  }, []);

  const runComputeBench = useCallback(async () => {
    setComputeError(null);
    setComputeRunning(true);
    try {
      const res = await invoke<GpuComputeBenchResult>("run_gpu_compute_bench", {
        adapterIndex: selectedAdapter,
      });
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
    uiReflowMetricsRef.current = { opsPerSec: 0, p95Ms: 0 };
    setSceneScores({});
    setManualPlay(false);
    setSuiteMode(true);
    setActiveScene(SCENES[0].id);
    setFullscreenOpen(true);
    onRunningChange(true);
    setNativeFullscreen(true);
    // Run uncapped native Rust wgpu FP32 compute in background if not yet measured
    if (!computeResult && !computeRunning) {
      runComputeBench().catch(() => {});
    }
  }, [computeResult, computeRunning, onRunningChange, runComputeBench, setNativeFullscreen]);

  // Restore native window chrome cleanly on unmount
  useEffect(() => {
    return () => {
      if (fullscreenOpenRef.current) {
        getCurrentWindow().setFullscreen(false).catch(() => {});
      }
    };
  }, []);

  // Global keyboard handler while fullscreen is open
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

  // Main Fullscreen 9-Scene Rendering & Benchmarking Engine
  useEffect(() => {
    if (!fullscreenOpen) return;

    const sceneDef = SCENES.find((s) => s.id === activeScene) ?? SCENES[0];
    const cfg = LOAD_CONFIG[loadTier];
    const isGlScene = activeScene === "webgl_3d" || activeScene === "shader_overdraw";
    const isDomScene = activeScene === "ui_reflow";

    let rafId = 0;
    let cancelled = false;
    let sceneStartedAt = performance.now();
    let lastFrameAt = sceneStartedAt;
    let lastHudAt = sceneStartedAt;
    let playedManuallyInScene = manualPlayRef.current;

    const frameDts: number[] = [];
    const sparkBuf: number[] = [];

    // Resize active canvas to exact physical backing resolution (capped at 2x DPR for crispness)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(640, window.innerWidth);
    const height = Math.max(400, window.innerHeight);

    const c2d = canvas2dRef.current;
    let ctx: CanvasRenderingContext2D | null = null;
    if (c2d && !isDomScene) {
      c2d.width = Math.round(width * dpr);
      c2d.height = Math.round(height * dpr);
      ctx = c2d.getContext("2d", { alpha: false });
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    // Optional WebGL2 setup for 3D Arena & Shader Overdraw
    const cgl = canvasGlRef.current;
    let gl: WebGL2RenderingContext | null = null;
    let glProg: WebGLProgram | null = null;
    let glVao: WebGLVertexArrayObject | null = null;
    let glBufs: WebGLBuffer[] = [];
    let glInstanceCount = cfg.instances3d;

    if (isGlScene && cgl) {
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

        if (activeScene === "webgl_3d") {
          glProg = linkGlProgram(gl, ARENA_3D_VS, ARENA_3D_FS);
          if (glProg) {
            glVao = gl.createVertexArray();
            gl.bindVertexArray(glVao);
            const cubeData = buildCubeGeometry();
            const vbo = gl.createBuffer();
            if (vbo) {
              glBufs.push(vbo);
              gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
              gl.bufferData(gl.ARRAY_BUFFER, cubeData, gl.STATIC_DRAW);
              gl.enableVertexAttribArray(0);
              gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
              gl.enableVertexAttribArray(1);
              gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
            }
            const instArr = new Float32Array(glInstanceCount * 4);
            for (let i = 0; i < glInstanceCount; i++) {
              const ring = Math.floor(i / 28) + 1;
              const ang = (i % 28) * ((Math.PI * 2) / 28) + ring * 0.27;
              const radius = 2.6 + ring * 1.15;
              const y = ((i % 9) - 4) * 1.35;
              instArr[i * 4 + 0] = Math.cos(ang) * radius;
              instArr[i * 4 + 1] = y;
              instArr[i * 4 + 2] = Math.sin(ang) * radius;
              instArr[i * 4 + 3] = 0.34 + ((i * 19) % 10) * 0.045;
            }
            const ibo = gl.createBuffer();
            if (ibo) {
              glBufs.push(ibo);
              gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
              gl.bufferData(gl.ARRAY_BUFFER, instArr, gl.STATIC_DRAW);
              gl.enableVertexAttribArray(2);
              gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
              gl.vertexAttribDivisor(2, 1);
            }
            gl.enable(gl.DEPTH_TEST);
          }
        } else if (activeScene === "shader_overdraw") {
          glProg = linkGlProgram(gl, OVERDRAW_VS, OVERDRAW_FS);
          glVao = gl.createVertexArray();
        }
      } else {
        glSupportRef.current.supported = false;
      }
    }

    // ---------- Per-Scene Mutable Simulation State ----------
    // Scene 1: 2D Particles
    const pCount = cfg.particles;
    const pX = new Float32Array(pCount);
    const pY = new Float32Array(pCount);
    const pVx = new Float32Array(pCount);
    const pVy = new Float32Array(pCount);
    if (activeScene === "graphics_2d") {
      for (let i = 0; i < pCount; i++) {
        const a = (i * 2.39996) % (Math.PI * 2);
        const r = 30 + ((i * 17) % Math.min(width, height) * 0.45);
        pX[i] = width * 0.5 + Math.cos(a) * r;
        pY[i] = height * 0.5 + Math.sin(a) * r;
        pVx[i] = -Math.sin(a) * (1.2 + (i % 7) * 0.45);
        pVy[i] = Math.cos(a) * (1.2 + (i % 7) * 0.45);
      }
    }

    // Scene 2: Deep Zoom CAD state
    let zoomLevel = 1.0;
    let panX = 0;
    let panY = 0;
    let maxZoomHit = 1.0;

    // Scene 3: Text Scroll state
    let scrollY = 0;
    let totalGlyphs = 0;

    // Scene 6: Starfighter Mini-Game state
    let shipX = width * 0.5;
    let shipY = height * 0.8;
    let fireCooldown = 0;
    let arcadeScore = 0;
    let enemiesDestroyed = 0;
    const bullets: Array<{ x: number; y: number; vx: number; vy: number; friendly: boolean }> = [];
    const enemies: Array<{ x: number; y: number; vx: number; vy: number; hp: number; r: number }> = [];
    const sparks: Array<{ x: number; y: number; vx: number; vy: number; life: number }> = [];
    const waves: Array<{ x: number; y: number; r: number; maxR: number }> = [];

    // Scene 7: 2,000-Ball Spatial-Hash Physics Sandbox state
    const bCount = cfg.physicsBalls;
    const bx = new Float32Array(bCount);
    const by = new Float32Array(bCount);
    const bvx = new Float32Array(bCount);
    const bvy = new Float32Array(bCount);
    const ballR = bCount > 1200 ? 3.2 : 4.2;
    let totalCollisions = 0;
    if (activeScene === "game_physics") {
      for (let i = 0; i < bCount; i++) {
        bx[i] = 40 + ((i * 73.13) % (width - 80));
        by[i] = 90 + ((i * 41.77) % (height - 180));
        bvx[i] = (((i * 19) % 11) - 5) * 0.9;
        bvy[i] = (((i * 23) % 11) - 5) * 0.9;
      }
    }

    // Scene 8: 3D Hyper-Tunnel Reflex Runner state
    let runnerLane = 0.0; // -1..1
    let gatesCleared = 0;
    let reactionSumMs = 0;
    let reactionCount = 0;
    const gates: Array<{ z: number; gapAngle: number; passed: boolean; spawnAt: number }> = [];
    if (activeScene === "game_tunnel") {
      for (let i = 0; i < 8; i++) {
        gates.push({
          z: 0.2 + i * 0.14,
          gapAngle: ((i * 1.15) % 1.6) - 0.8,
          passed: false,
          spawnAt: performance.now(),
        });
      }
    }

    // Scene 9: UI Reflow DOM state
    let reflowOps = 0;
    const reflowLatencies: number[] = [];
    let reflowRowsData: Array<{ id: number; name: string; load: number; temp: number; clock: number }> = [];
    if (isDomScene && reflowHostRef.current) {
      reflowRowsData = Array.from({ length: 96 }, (_, i) => ({
        id: i + 1,
        name: `Subsystem Node #${String(i + 1).padStart(3, "0")}`,
        load: (i * 17) % 100,
        temp: 42 + ((i * 13) % 45),
        clock: 2400 + ((i * 137) % 2400),
      }));
    }

    let primaryLabel = sceneDef.shortName;
    let primaryValue = "—";

    const finalizeCurrentScene = (nowMs: number) => {
      const elapsed = Math.max(0.2, (nowMs - sceneStartedAt) / 1000);
      const stats = computeFrameStats(frameDts);

      // Hardware-class normalized scene score
      let score = Math.round(
        (stats.avgFps * 68 + stats.low1pctFps * 32) * cfg.weightMult
      );
      if (activeScene === "ui_reflow") {
        const opsPerSec = reflowOps / elapsed;
        const sortedLat = [...reflowLatencies].sort((a, b) => a - b);
        const p95 = sortedLat.length
          ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))]
          : 0;
        uiReflowMetricsRef.current = { opsPerSec, p95Ms: p95 };
        score = Math.round(opsPerSec * 14);
        primaryLabel = "DOM Reflow";
        primaryValue = `${opsPerSec.toFixed(0)} ops/s • P95 ${p95.toFixed(1)}ms`;
      }

      const sceneStatus: TestStatus =
        activeScene === "ui_reflow"
          ? uiReflowMetricsRef.current.opsPerSec >= 35
            ? "pass"
            : "warn"
          : stats.avgFps < 10
          ? "fail"
          : stats.stutterPct > 25 || (isGlScene && !gl)
          ? "warn"
          : "pass";

      const sceneScore: GraphicsFpsSceneScore = {
        id: sceneDef.id,
        name: sceneDef.name,
        category: sceneDef.category,
        avgFps: stats.avgFps,
        low1pctFps: stats.low1pctFps,
        low01pctFps: stats.low01pctFps,
        avgFrameMs: stats.avgFrameMs,
        jitterMs: stats.jitterMs,
        stutterFrames: stats.stutterFrames,
        throughputLabel: `${primaryLabel}: ${primaryValue}`,
        stutterFramesPct: stats.stutterPct,
        score: Math.max(100, score),
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
            uiReflowMetricsRef.current.opsPerSec,
            uiReflowMetricsRef.current.p95Ms,
            totalSecs
          );
          onSuiteComplete(finalSuite);
          exitFullscreen();
        }
      }
    };

    const tick = (now: number) => {
      if (cancelled) return;
      const dtMs = Math.max(0.5, Math.min(200, now - lastFrameAt));
      lastFrameAt = now;
      frameDts.push(dtMs);
      sparkBuf.push(dtMs);
      if (sparkBuf.length > 64) sparkBuf.shift();

      const t = (now - sceneStartedAt) / 1000;
      const dt = Math.min(0.05, dtMs / 1000);
      if (manualPlayRef.current) playedManuallyInScene = true;

      // ---------- SCENE DISPATCH ----------
      if (activeScene === "graphics_2d" && ctx) {
        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        // Radial cobalt light field
        const rad = ctx.createRadialGradient(cx, cy, 12, cx, cy, Math.min(width, height) * 0.52);
        rad.addColorStop(0, "rgba(37, 99, 235, 0.35)");
        rad.addColorStop(0.5, "rgba(29, 78, 216, 0.12)");
        rad.addColorStop(1, "rgba(9, 9, 11, 0)");
        ctx.fillStyle = rad;
        ctx.fillRect(0, 0, width, height);

        // 14 Procedural Bezier Ribbons
        ctx.lineWidth = 1.6;
        for (let r = 0; r < 14; r++) {
          const ph = t * (0.9 + r * 0.08) + r * 0.45;
          ctx.strokeStyle = r % 3 === 0 ? "rgba(255,255,255,0.45)" : "rgba(59,130,246,0.55)";
          ctx.beginPath();
          ctx.moveTo(0, cy + Math.sin(ph) * height * 0.32);
          ctx.bezierCurveTo(
            width * 0.32,
            cy + Math.cos(ph * 1.3) * height * 0.42,
            width * 0.68,
            cy - Math.sin(ph * 1.1) * height * 0.42,
            width,
            cy + Math.cos(ph * 0.9) * height * 0.3
          );
          ctx.stroke();
        }

        // Particle storm physics
        for (let i = 0; i < pCount; i++) {
          const dx = cx - pX[i];
          const dy = cy - pY[i];
          const dist = Math.sqrt(dx * dx + dy * dy) + 18;
          pVx[i] += (dx / dist) * 0.24 - (dy / dist) * 0.08;
          pVy[i] += (dy / dist) * 0.24 + (dx / dist) * 0.08;
          pVx[i] *= 0.992;
          pVy[i] *= 0.992;
          pX[i] += pVx[i];
          pY[i] += pVy[i];
          if (pX[i] < 0 || pX[i] > width) pVx[i] *= -1;
          if (pY[i] < 0 || pY[i] > height) pVy[i] *= -1;
          ctx.fillStyle = i % 7 === 0 ? "#FFFFFF" : i % 2 === 0 ? "#60A5FA" : "#2563EB";
          ctx.fillRect(pX[i], pY[i], 2.1, 2.1);
        }
        primaryLabel = "2D Load";
        primaryValue = `${pCount.toLocaleString()} particles + 14 ribbons`;
      } else if (activeScene === "zoom_cad" && ctx) {
        if (manualPlayRef.current) {
          if (pointerRef.current.wheelDelta !== 0) {
            const factor = pointerRef.current.wheelDelta < 0 ? 1.18 : 0.85;
            zoomLevel = Math.max(0.5, Math.min(512, zoomLevel * factor));
            pointerRef.current.wheelDelta = 0;
          }
          if (pointerRef.current.down) {
            panX += pointerRef.current.dx / zoomLevel;
            panY += pointerRef.current.dy / zoomLevel;
            pointerRef.current.dx = 0;
            pointerRef.current.dy = 0;
          }
        } else {
          // Smooth exponential 1x -> 128x -> 1x cycle over 5 seconds
          const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 0.4);
          zoomLevel = Math.pow(128, wave);
          panX = Math.sin(t * 0.9) * 85;
          panY = Math.cos(t * 0.7) * 55;
        }
        if (zoomLevel > maxZoomHit) maxZoomHit = zoomLevel;

        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        // Multi-scale hierarchical CAD grid (auto-subdivides across zoom octaves)
        const octave = Math.floor(Math.log2(Math.max(1, zoomLevel)));
        for (let lv = Math.max(0, octave - 1); lv <= octave + 2; lv++) {
          const worldStep = 160 / Math.pow(2, lv);
          const screenStep = worldStep * zoomLevel;
          if (screenStep < 14 || screenStep > width * 1.4) continue;
          const alpha = Math.max(0.08, Math.min(0.42, (screenStep - 12) / 140));
          ctx.strokeStyle = lv % 2 === 0 ? `rgba(37,99,235,${alpha})` : `rgba(255,255,255,${alpha * 0.5})`;
          ctx.lineWidth = lv === octave ? 1.1 : 0.6;
          const offX = ((cx + panX * zoomLevel) % screenStep + screenStep) % screenStep;
          const offY = ((cy + panY * zoomLevel) % screenStep + screenStep) % screenStep;
          ctx.beginPath();
          for (let x = offX; x < width; x += screenStep) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
          }
          for (let y = offY; y < height; y += screenStep) {
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
          }
          ctx.stroke();
        }

        // Architectural PCB / Fractal CAD Blueprint nested across zoom scales
        ctx.save();
        ctx.translate(cx, cy);
        for (let ring = 0; ring < 9; ring++) {
          const baseR = 420 / Math.pow(2.05, ring);
          const r = baseR * zoomLevel;
          if (r < 6 || r > Math.max(width, height) * 2.2) continue;
          const sx = panX * zoomLevel;
          const sy = panY * zoomLevel;
          ctx.strokeStyle = ring % 2 === 0 ? "#3B82F6" : "#FFFFFF";
          ctx.lineWidth = Math.max(0.8, 2.2 - ring * 0.14);
          ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.72, 0, Math.PI * 2);
          ctx.stroke();
          // Radial caliper ticks & IC pin traces
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2 + t * 0.12 * (ring % 2 === 0 ? 1 : -1);
            ctx.beginPath();
            ctx.moveTo(sx + Math.cos(a) * r * 0.72, sy + Math.sin(a) * r * 0.72);
            ctx.lineTo(sx + Math.cos(a) * r * 0.96, sy + Math.sin(a) * r * 0.96);
            ctx.stroke();
          }
        }
        ctx.restore();

        // Crosshair HUD marker
        ctx.strokeStyle = "rgba(96,165,250,0.85)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - 28, cy);
        ctx.lineTo(cx + 28, cy);
        ctx.moveTo(cx, cy - 28);
        ctx.lineTo(cx, cy + 28);
        ctx.stroke();

        primaryLabel = "Deep Zoom";
        primaryValue = `${zoomLevel.toFixed(1)}x (Peak ${maxZoomHit.toFixed(0)}x)`;
      } else if (activeScene === "text_render" && ctx) {
        const scrollSpeed = manualPlayRef.current
          ? keysRef.current.has("arrowup")
            ? -520
            : keysRef.current.has("arrowdown")
            ? 520
            : 260 + pointerRef.current.wheelDelta * 3
          : 340 + Math.sin(t * 2.4) * 140;
        pointerRef.current.wheelDelta *= 0.85;
        scrollY += scrollSpeed * dt;

        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, width, height);

        const sizes = [12, 15, 19, 24, 30];
        let y = 78 - (((scrollY % 420) + 420) % 420);
        let rowIdx = 0;
        let frameGlyphs = 0;
        while (y < height + 40) {
          const sz = sizes[rowIdx % sizes.length];
          const isMono = rowIdx % 2 === 0;
          ctx.font = `${rowIdx % 3 === 0 ? "700" : "400"} ${sz}px ${
            isMono ? "Consolas, ui-monospace, monospace" : "Segoe UI, Inter, sans-serif"
          }`;
          ctx.fillStyle =
            rowIdx % 5 === 0
              ? "#60A5FA"
              : rowIdx % 4 === 0
              ? "#FFFFFF"
              : "#D4D4D8";
          const line = `[${String(rowIdx + 1).padStart(3, "0")}] ${TEXT_LINES[rowIdx % TEXT_LINES.length]}  //  ${(
            t * 1000
          ).toFixed(1)}ms`;
          ctx.fillText(line, 36 + ((rowIdx * 11) % 32), y);
          frameGlyphs += line.length;
          y += sz + 11;
          rowIdx++;
        }
        totalGlyphs += frameGlyphs;
        const gps = totalGlyphs / Math.max(0.1, t);
        primaryLabel = "Glyph Rate";
        primaryValue = `${(gps / 1000).toFixed(1)}k glyphs/s`;
      } else if (activeScene === "webgl_3d") {
        if (gl && glProg && glVao) {
          gl.clearColor(0.035, 0.035, 0.043, 1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.useProgram(glProg);
          gl.bindVertexArray(glVao);
          gl.uniform1f(gl.getUniformLocation(glProg, "uTime"), t);
          gl.uniform1f(gl.getUniformLocation(glProg, "uAspect"), width / Math.max(1, height));
          gl.uniform2f(
            gl.getUniformLocation(glProg, "uCamOffset"),
            manualPlayRef.current ? pointerRef.current.x - 0.5 : 0,
            manualPlayRef.current ? pointerRef.current.y - 0.5 : 0
          );
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, glInstanceCount);
          primaryLabel = "WebGL2 3D";
          primaryValue = `${glInstanceCount.toLocaleString()} lit instances`;
        } else if (ctx) {
          // Software-safe Canvas2D 3D projection fallback
          ctx.fillStyle = "#09090B";
          ctx.fillRect(0, 0, width, height);
          const cx = width * 0.5;
          const cy = height * 0.5;
          ctx.strokeStyle = "#3B82F6";
          ctx.lineWidth = 1.2;
          for (let i = 0; i < 160; i++) {
            const a = t * 0.8 + i * 0.35;
            const z = 4 + ((i * 0.4 + t * 2) % 10);
            const sx = cx + (Math.cos(a) * 320) / (z * 0.35);
            const sy = cy + (Math.sin(a * 1.3) * 220) / (z * 0.35);
            const s = 44 / z;
            ctx.strokeRect(sx - s, sy - s, s * 2, s * 2);
          }
          primaryLabel = "3D Fallback";
          primaryValue = "Canvas2D (No WebGL2)";
        }
      } else if (activeScene === "shader_overdraw") {
        if (gl && glProg && glVao) {
          gl.useProgram(glProg);
          gl.bindVertexArray(glVao);
          gl.uniform1f(gl.getUniformLocation(glProg, "uTime"), t);
          gl.uniform2f(gl.getUniformLocation(glProg, "uRes"), cgl!.width, cgl!.height);
          gl.uniform2f(
            gl.getUniformLocation(glProg, "uPointer"),
            manualPlayRef.current ? pointerRef.current.x : 0.5 + Math.cos(t * 0.9) * 0.2,
            manualPlayRef.current ? 1.0 - pointerRef.current.y : 0.5 + Math.sin(t * 0.7) * 0.2
          );
          gl.uniform1i(gl.getUniformLocation(glProg, "uLayers"), cfg.shaderLayers);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          primaryLabel = "Overdraw";
          primaryValue = `${cfg.shaderLayers} shader layers/px`;
        } else if (ctx) {
          ctx.fillStyle = "#09090B";
          ctx.fillRect(0, 0, width, height);
          for (let l = 0; l < cfg.shaderLayers; l++) {
            ctx.fillStyle = "rgba(37,99,235,0.06)";
            ctx.beginPath();
            ctx.arc(
              width * 0.5 + Math.cos(t + l) * 180,
              height * 0.5 + Math.sin(t * 1.2 + l) * 120,
              180 + (l % 6) * 45,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
          primaryLabel = "Fill Fallback";
          primaryValue = `${cfg.shaderLayers} passes (2D)`;
        }
      } else if (activeScene === "game_shooter" && ctx) {
        // Mini-Game 1: Starfighter Bullet-Hell Arena
        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, width, height);

        // Starfield parallax
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        for (let i = 0; i < 110; i++) {
          const sx = (i * 193.7) % width;
          const sy = ((i * 97.3 + t * (90 + (i % 5) * 45)) % height);
          ctx.fillRect(sx, sy, 1.8, 1.8);
        }

        // Player control vs Auto-AI Pilot
        if (manualPlayRef.current) {
          const speed = 520 * dt;
          if (keysRef.current.has("a") || keysRef.current.has("arrowleft")) shipX -= speed;
          if (keysRef.current.has("d") || keysRef.current.has("arrowright")) shipX += speed;
          if (keysRef.current.has("w") || keysRef.current.has("arrowup")) shipY -= speed;
          if (keysRef.current.has("s") || keysRef.current.has("arrowdown")) shipY += speed;
          if (pointerRef.current.down || (pointerRef.current.x !== 0.5 && !keysRef.current.size)) {
            shipX += (pointerRef.current.x * width - shipX) * 0.22;
            shipY += (Math.max(0.25, pointerRef.current.y) * height - shipY) * 0.22;
          }
          if (pointerRef.current.clicked || keysRef.current.has(" ")) {
            waves.push({ x: shipX, y: shipY, r: 10, maxR: 280 });
            pointerRef.current.clicked = false;
          }
        } else {
          const targetX = width * 0.5 + Math.sin(t * 2.1) * width * 0.34;
          const targetY = height * 0.78 + Math.cos(t * 2.7) * 50;
          shipX += (targetX - shipX) * 0.14;
          shipY += (targetY - shipY) * 0.14;
        }
        shipX = Math.max(36, Math.min(width - 36, shipX));
        shipY = Math.max(96, Math.min(height - 96, shipY));

        // Spawn enemy waves
        if (enemies.length < Math.round(14 * cfg.weightMult) && Math.random() < 0.22) {
          enemies.push({
            x: 60 + Math.random() * (width - 120),
            y: 72,
            vx: (Math.random() - 0.5) * 140,
            vy: 65 + Math.random() * 85,
            hp: 2,
            r: 14,
          });
        }

        // Auto rapid twin lasers
        fireCooldown -= dt;
        if (fireCooldown <= 0) {
          fireCooldown = 0.065;
          bullets.push({ x: shipX - 11, y: shipY - 14, vx: -18, vy: -760, friendly: true });
          bullets.push({ x: shipX + 11, y: shipY - 14, vx: 18, vy: -760, friendly: true });
        }

        // Update enemies & enemy radial bullets
        for (let i = enemies.length - 1; i >= 0; i--) {
          const e = enemies[i];
          e.x += e.vx * dt;
          e.y += e.vy * dt;
          if (e.x < 30 || e.x > width - 30) e.vx *= -1;
          if (Math.random() < 0.025 && bullets.length < 360) {
            const ang = Math.atan2(shipY - e.y, shipX - e.x);
            bullets.push({
              x: e.x,
              y: e.y,
              vx: Math.cos(ang) * 260,
              vy: Math.sin(ang) * 260,
              friendly: false,
            });
          }
          if (e.y > height + 30) enemies.splice(i, 1);
        }

        // Update bullets & hits
        for (let i = bullets.length - 1; i >= 0; i--) {
          const b = bullets[i];
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          if (b.x < -20 || b.x > width + 20 || b.y < -20 || b.y > height + 20) {
            bullets.splice(i, 1);
            continue;
          }
          if (b.friendly) {
            for (let j = enemies.length - 1; j >= 0; j--) {
              const e = enemies[j];
              const dx = b.x - e.x;
              const dy = b.y - e.y;
              if (dx * dx + dy * dy < (e.r + 6) * (e.r + 6)) {
                e.hp -= 1;
                bullets.splice(i, 1);
                if (e.hp <= 0) {
                  enemiesDestroyed += 1;
                  arcadeScore += 125;
                  waves.push({ x: e.x, y: e.y, r: 6, maxR: 72 });
                  for (let k = 0; k < 18; k++) {
                    const a = (k / 18) * Math.PI * 2;
                    const sp = 70 + Math.random() * 210;
                    sparks.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1 });
                  }
                  enemies.splice(j, 1);
                }
                break;
              }
            }
          }
        }

        // Render shockwaves
        ctx.lineWidth = 2;
        for (let i = waves.length - 1; i >= 0; i--) {
          const w = waves[i];
          w.r += 340 * dt;
          const alpha = Math.max(0, 1 - w.r / w.maxR);
          ctx.strokeStyle = `rgba(96,165,250,${alpha})`;
          ctx.beginPath();
          ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
          ctx.stroke();
          if (w.r >= w.maxR) waves.splice(i, 1);
        }

        // Render sparks
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i];
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.life -= dt * 2.2;
          if (s.life <= 0) {
            sparks.splice(i, 1);
            continue;
          }
          ctx.fillStyle = s.life > 0.5 ? "#FFFFFF" : `rgba(59,130,246,${s.life})`;
          ctx.fillRect(s.x, s.y, 2.6, 2.6);
        }

        // Render enemies
        for (const e of enemies) {
          ctx.strokeStyle = "#60A5FA";
          ctx.fillStyle = "#1E3A8A";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(e.x, e.y + e.r);
          ctx.lineTo(e.x - e.r, e.y - e.r * 0.6);
          ctx.lineTo(e.x + e.r, e.y - e.r * 0.6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }

        // Render bullets
        for (const b of bullets) {
          ctx.fillStyle = b.friendly ? "#FFFFFF" : "#3B82F6";
          ctx.fillRect(b.x - 2, b.y - 6, 4, b.friendly ? 12 : 6);
        }

        // Render Starfighter ship
        ctx.fillStyle = "#2563EB";
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(shipX, shipY - 22);
        ctx.lineTo(shipX - 18, shipY + 14);
        ctx.lineTo(shipX, shipY + 7);
        ctx.lineTo(shipX + 18, shipY + 14);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        primaryLabel = "Starfighter";
        primaryValue = `${arcadeScore.toLocaleString()} pts • ${enemiesDestroyed} hits`;
      } else if (activeScene === "game_physics" && ctx) {
        // Mini-Game 2: 2,000-Ball Spatial-Hash Rigid-Body Sandbox
        ctx.fillStyle = "rgba(9, 9, 11, 0.36)";
        ctx.fillRect(0, 0, width, height);

        const gravAngle = Math.floor(t / 1.8) * (Math.PI * 0.5) + Math.PI * 0.5;
        const gx = Math.cos(gravAngle) * 180;
        const gy = Math.sin(gravAngle) * 180;

        const blastActive = manualPlayRef.current && pointerRef.current.down;
        const blastX = pointerRef.current.x * width;
        const blastY = pointerRef.current.y * height;

        // Spatial hash grid for fast O(N) elastic collisions
        const cellSz = ballR * 2.5;
        const cols = Math.max(1, Math.ceil(width / cellSz));
        const grid = new Map<number, number[]>();

        for (let i = 0; i < bCount; i++) {
          bvx[i] += gx * dt;
          bvy[i] += gy * dt;
          if (blastActive) {
            const dx = bx[i] - blastX;
            const dy = by[i] - blastY;
            const d2 = dx * dx + dy * dy + 60;
            if (d2 < 36000) {
              const f = 9000 / d2;
              bvx[i] += dx * f * dt;
              bvy[i] += dy * f * dt;
            }
          }
          bx[i] += bvx[i] * dt * 60;
          by[i] += bvy[i] * dt * 60;
          bvx[i] *= 0.994;
          bvy[i] *= 0.994;

          if (bx[i] < ballR) {
            bx[i] = ballR;
            bvx[i] = Math.abs(bvx[i]) * 0.88;
          } else if (bx[i] > width - ballR) {
            bx[i] = width - ballR;
            bvx[i] = -Math.abs(bvx[i]) * 0.88;
          }
          if (by[i] < 64 + ballR) {
            by[i] = 64 + ballR;
            bvy[i] = Math.abs(bvy[i]) * 0.88;
          } else if (by[i] > height - 64 - ballR) {
            by[i] = height - 64 - ballR;
            bvy[i] = -Math.abs(bvy[i]) * 0.88;
          }

          const cxCell = Math.floor(bx[i] / cellSz);
          const cyCell = Math.floor(by[i] / cellSz);
          const key = cyCell * cols + cxCell;
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(i);
        }

        const minDist = ballR * 2;
        const minDistSq = minDist * minDist;
        grid.forEach((bucket) => {
          const len = Math.min(bucket.length, 10);
          for (let a = 0; a < len; a++) {
            const i = bucket[a];
            for (let b = a + 1; b < len; b++) {
              const j = bucket[b];
              const dx = bx[j] - bx[i];
              const dy = by[j] - by[i];
              const d2 = dx * dx + dy * dy;
              if (d2 > 0.01 && d2 < minDistSq) {
                const d = Math.sqrt(d2);
                const nx = dx / d;
                const ny = dy / d;
                const overlap = (minDist - d) * 0.5;
                bx[i] -= nx * overlap;
                by[i] -= ny * overlap;
                bx[j] += nx * overlap;
                by[j] += ny * overlap;
                const rvx = bvx[j] - bvx[i];
                const rvy = bvy[j] - bvy[i];
                const sep = rvx * nx + rvy * ny;
                if (sep < 0) {
                  const imp = -sep * 0.92;
                  bvx[i] -= nx * imp;
                  bvy[i] -= ny * imp;
                  bvx[j] += nx * imp;
                  bvy[j] += ny * imp;
                  totalCollisions += 1;
                }
              }
            }
          }
        });

        for (let i = 0; i < bCount; i++) {
          const spd = Math.abs(bvx[i]) + Math.abs(bvy[i]);
          ctx.fillStyle = spd > 7.5 ? "#FFFFFF" : spd > 3.5 ? "#60A5FA" : "#2563EB";
          ctx.fillRect(bx[i] - ballR * 0.7, by[i] - ballR * 0.7, ballR * 1.4, ballR * 1.4);
        }
        if (blastActive) {
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(blastX, blastY, 44 + (t * 80) % 40, 0, Math.PI * 2);
          ctx.stroke();
        }
        primaryLabel = "Physics";
        primaryValue = `${bCount.toLocaleString()} balls • ${(totalCollisions / Math.max(0.1, t) / 1000).toFixed(1)}k col/s`;
      } else if (activeScene === "game_tunnel" && ctx) {
        // Mini-Game 3: 3D Hyper-Tunnel Reflex Runner
        ctx.fillStyle = "#09090B";
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const boost = manualPlayRef.current && keysRef.current.has(" ") ? 1.55 : 1.0;

        // Nearest upcoming gate
        let nearest = gates[0];
        for (const g of gates) {
          if (g.z < nearest.z) nearest = g;
        }

        if (manualPlayRef.current) {
          if (keysRef.current.has("arrowleft") || keysRef.current.has("a")) runnerLane -= 2.2 * dt;
          if (keysRef.current.has("arrowright") || keysRef.current.has("d")) runnerLane += 2.2 * dt;
          if (pointerRef.current.down) {
            runnerLane = (pointerRef.current.x - 0.5) * 1.9;
          }
        } else if (nearest) {
          runnerLane += (nearest.gapAngle - runnerLane) * 0.14;
        }
        runnerLane = Math.max(-0.92, Math.min(0.92, runnerLane));

        // Tunnel octagonal perspective rings
        const ringCount = 24;
        for (let r = ringCount; r >= 1; r--) {
          const z = ((r / ringCount) - ((t * 0.85 * boost) % (1 / ringCount)));
          if (z <= 0.02) continue;
          const scale = 1 / z;
          const rad = Math.min(width, height) * 0.14 * scale;
          const alpha = Math.max(0.06, Math.min(0.85, (1.1 - z) * 0.8));
          ctx.strokeStyle = r % 3 === 0 ? `rgba(255,255,255,${alpha * 0.5})` : `rgba(37,99,235,${alpha})`;
          ctx.lineWidth = Math.max(1, 2.4 * (1 - z));
          ctx.beginPath();
          for (let v = 0; v <= 8; v++) {
            const a = (v / 8) * Math.PI * 2 + Math.PI / 8;
            const px = cx + Math.cos(a) * rad * 1.35 - runnerLane * 110 * (1 - z);
            const py = cy + Math.sin(a) * rad * 0.9;
            if (v === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }

        // Oncoming reflex gates
        for (const g of gates) {
          g.z -= 0.42 * boost * dt;
          if (g.z <= 0.06) {
            const aligned = Math.abs(runnerLane - g.gapAngle) < 0.38;
            if (aligned) {
              gatesCleared += 1;
              reactionSumMs += Math.min(350, Math.max(4, dtMs * 1.4));
              reactionCount += 1;
            }
            g.z = 1.12;
            g.gapAngle = ((gatesCleared * 0.73 + Math.sin(t * 3.1)) % 1.4) - 0.7;
            g.spawnAt = now;
          }
          const scale = 1 / Math.max(0.08, g.z);
          const rad = Math.min(width, height) * 0.14 * scale;
          const gxCenter = cx + g.gapAngle * rad * 0.95 - runnerLane * 110 * (1 - g.z);
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = Math.max(1.5, 4.5 * (1 - g.z));
          ctx.strokeRect(gxCenter - rad * 0.32, cy - rad * 0.28, rad * 0.64, rad * 0.56);
        }

        // Runner reticle HUD
        const rx = cx + runnerLane * 160;
        const ry = height * 0.76;
        ctx.fillStyle = "#2563EB";
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rx, ry - 16);
        ctx.lineTo(rx - 22, ry + 12);
        ctx.lineTo(rx + 22, ry + 12);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        const avgReact = reactionCount > 0 ? reactionSumMs / reactionCount : dtMs;
        primaryLabel = "Hyper-Tunnel";
        primaryValue = `${gatesCleared} gates • ${avgReact.toFixed(1)}ms pace`;
      } else if (isDomScene && reflowHostRef.current) {
        // Scene 9: Real Main-Thread DOM Reflow & Layout Latency Burst
        const tBatch0 = performance.now();
        const host = reflowHostRef.current;
        for (let step = 0; step < 3; step++) {
          const reverse = (reflowOps + step) % 2 === 1;
          reflowRowsData.sort((a, b) => (reverse ? b.clock - a.clock : a.clock - b.clock));
          let html = "";
          for (let i = 0; i < reflowRowsData.length; i++) {
            const row = reflowRowsData[i];
            row.load = (row.load + 7 + i) % 100;
            row.clock = 2400 + ((row.clock + 97) % 2600);
            html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 10px;border-bottom:1px solid #27272A;font-size:11px"><span>${row.name}</span><span style="width:${Math.max(
              16,
              row.load
            )}px;height:6px;background:${i % 4 === 0 ? "#FFFFFF" : "#2563EB"};display:inline-block"></span><span>${row.clock} MHz • ${row.load}%</span></div>`;
          }
          host.innerHTML = html;
          // Force synchronous browser layout/reflow calculation
          void host.offsetHeight;
          reflowOps += 1;
        }
        const batchMs = performance.now() - tBatch0;
        reflowLatencies.push(batchMs);
        const opsPerSec = reflowOps / Math.max(0.1, t);
        primaryLabel = "UI Reflow";
        primaryValue = `${opsPerSec.toFixed(0)} ops/s • ${batchMs.toFixed(1)}ms`;
      }

      // Throttled HUD update (~10Hz)
      if (now - lastHudAt >= 100) {
        lastHudAt = now;
        const recent = computeFrameStats(frameDts.slice(-120));
        setHud({
          fps: recent.avgFps,
          low1: recent.low1pctFps,
          low01: recent.low01pctFps,
          frameMs: recent.avgFrameMs,
          progressPct: suiteModeRef.current
            ? Math.min(100, Math.round((t / sceneDef.durationSecs) * 100))
            : 100,
          metricLabel: primaryLabel,
          metricValue: primaryValue,
          sparkline: [...sparkBuf],
          webglLabel: glSupportRef.current.supported ? "WebGL2 OK" : "2D Fallback",
        });
      }

      // Auto-advance when running Fullscreen Automated Suite
      if (suiteModeRef.current && t >= sceneDef.durationSecs) {
        finalizeCurrentScene(now);
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
  }, [fullscreenOpen, activeScene, loadTier, exitFullscreen, onSuiteComplete]);

  // Save solo-scene measurement when exiting or switching manually
  const activeDef = SCENES.find((s) => s.id === activeScene) ?? SCENES[0];
  const activeSceneIdx = SCENES.findIndex((s) => s.id === activeScene);

  // Build SVG polyline path for frametime sparkline
  const sparkPath =
    hud.sparkline.length > 1
      ? hud.sparkline
          .map((ms, idx) => {
            const x = (idx / Math.max(1, hud.sparkline.length - 1)) * 120;
            const norm = Math.min(1, ms / 40);
            const y = 26 - norm * 24;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "0,24 120,24";

  return (
    <div className="space-y-4">
      {/* Top Hero Card — Launch Fullscreen 9-Scene Suite + Native Rust wgpu FP32 Compute */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Gamepad2 className="w-4 h-4 text-blue-600" />
              <h2 className="text-base font-bold text-black tracking-tight">
                Fullscreen Custom Graphics, Zooming, Text &amp; Playable Mini-Game FPS Lab
              </h2>
              {suiteResult && <StatusBadge status={suiteResult.status} compact />}
            </div>
            <p className="text-xs text-zinc-500">
              9 fullscreen visual &amp; interactive stress tests (2D Vectors, 1x→128x CAD Zoom, Unicode/Myanmar Text Scroll, 3D WebGL2 Arena, Shader Overdraw, 3 Playable Mini-Games &amp; UI Reflow) plus native Rust <code className="font-mono text-black">wgpu</code> uncapped FP32 compute.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
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
              Launch Fullscreen Suite (~45s)
            </button>
          </div>
        </div>

        {/* Native Rust wgpu Uncapped GPU FP32 Compute Bar */}
        <div className="rounded-xl border border-zinc-200 bg-[#F8FAFC] p-3.5 flex items-center justify-between flex-wrap gap-3">
          <div className="space-y-0.5 min-w-[240px]">
            <div className="flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-blue-600" />
              <span className="font-mono text-[11px] font-bold uppercase text-black">
                Native Rust wgpu Uncapped GPU FP32 Compute ({adapterName || "Primary GPU"})
              </span>
              {computeResult && <StatusBadge status={computeResult.status} compact />}
            </div>
            <div className="text-xs text-zinc-600">
              {computeResult
                ? `${computeResult.fp32Gflops.toFixed(1)} GFLOPS (${computeResult.fp32Tflops.toFixed(
                    2
                  )} TFLOPS) • ${computeResult.tier} • Shader Compile ${computeResult.pipelineCompileMs.toFixed(
                    1
                  )} ms • ${computeResult.verifiedOk ? "Output Verified" : "Mismatch"}`
                : "Runs verified FMA shader dispatches directly on DX12/Vulkan/Metal — independent of 60Hz VSync."}
            </div>
            {computeError && (
              <div className="text-xs font-mono text-black bg-white border border-black px-2 py-1 rounded-lg mt-1">
                {computeError}
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={computeRunning || fullscreenOpen}
            onClick={() => runComputeBench()}
            className="px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:border-blue-600 text-xs font-semibold text-black flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5 text-blue-600" />
            {computeRunning ? "Running FP32 Shader..." : "Run Native FP32 Compute"}
          </button>
        </div>
      </div>

      {/* Suite Summary Score Banner */}
      {suiteResult && (
        <NovabenchScoreBar
          scoreLabel="GRAPHICS"
          scoreValue={suiteResult.compositeScore.toLocaleString()}
          title={`Fullscreen Graphics & Mini-Game Lab — ${suiteResult.smoothnessTier} (${suiteResult.resolution})`}
          takeaway={suiteResult.plainSummary}
          percent={Math.min(100, Math.max(15, Math.round(suiteResult.compositeScore / 100)))}
          medianLabel={`UI Reflow ${suiteResult.uiReflowOpsPerSec.toFixed(0)} ops/s • P95 ${suiteResult.uiReflowP95Ms.toFixed(1)}ms`}
          medianPercent={70}
          badge={
            computeResult
              ? `${computeResult.fp32Gflops.toFixed(0)} GFLOPS • ${suiteResult.scenes.length} Scenes`
              : `${suiteResult.scenes.length} Scenes • ${suiteResult.loadTier.toUpperCase()}`
          }
          monochrome={suiteResult.status !== "pass"}
        />
      )}

      {/* 9-Scene Interactive Gallery Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {SCENES.map((sc, idx) => {
          const score =
            suiteResult?.scenes.find((s) => s.id === sc.id) ?? sceneScores[sc.id] ?? null;
          const Icon =
            sc.id === "zoom_cad"
              ? Search
              : sc.id === "text_render"
              ? Type
              : sc.id === "webgl_3d"
              ? Layers
              : sc.id === "shader_overdraw"
              ? Sparkles
              : sc.id === "game_shooter"
              ? Rocket
              : sc.id === "game_physics" || sc.id === "game_tunnel"
              ? Gamepad2
              : sc.id === "ui_reflow"
              ? LayoutGrid
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
                    {String(idx + 1).padStart(2, "0")}. {sc.category}
                  </span>
                  {score ? (
                    <StatusBadge status={score.status} compact />
                  ) : sc.playable ? (
                    <span className="px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 font-mono text-[9.5px] font-bold">
                      PLAYABLE
                    </span>
                  ) : null}
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
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">{score.primaryMetricLabel}</span>
                    <strong className="text-blue-700">{score.primaryMetricValue}</strong>
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
                  <Play className="w-3 h-3 text-blue-600" /> Run Fullscreen
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
            {/* Primary 2D Canvas */}
            <canvas
              ref={canvas2dRef}
              className={`absolute inset-0 w-full h-full ${
                activeScene === "webgl_3d" ||
                activeScene === "shader_overdraw" ||
                activeScene === "ui_reflow"
                  ? glSupportRef.current.supported || activeScene === "ui_reflow"
                    ? "hidden"
                    : "block"
                  : "block"
              }`}
            />

            {/* Dedicated WebGL2 Canvas */}
            <canvas
              ref={canvasGlRef}
              className={`absolute inset-0 w-full h-full ${
                (activeScene === "webgl_3d" || activeScene === "shader_overdraw") &&
                glSupportRef.current.supported
                  ? "block"
                  : "hidden"
              }`}
            />

            {/* Scene 9: Live DOM Reflow Stage */}
            {activeScene === "ui_reflow" && (
              <div className="absolute inset-0 pt-20 pb-20 px-8 flex flex-col items-center justify-center bg-[#09090B]">
                <div className="w-full max-w-4xl h-full rounded-xl border border-zinc-800 bg-[#18181B] overflow-hidden flex flex-col">
                  <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between font-mono text-xs">
                    <span className="text-blue-400 font-bold">
                      SCENE 09 // REAL MAIN-THREAD DOM LAYOUT &amp; REFLOW BURST
                    </span>
                    <span className="text-zinc-300">{hud.metricValue}</span>
                  </div>
                  <div
                    ref={reflowHostRef}
                    className="flex-1 overflow-hidden font-mono text-zinc-200"
                  />
                </div>
              </div>
            )}

            {/* Top Floating Translucent Telemetry HUD */}
            <div className="fixed top-3 left-3 right-3 z-50 flex items-center justify-between gap-2 flex-wrap pointer-events-auto">
              <div className="px-3.5 py-2 rounded-xl bg-black/80 backdrop-blur-md border border-white/15 flex items-center gap-4 flex-wrap font-mono tabular-nums text-xs">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold">
                    {String(activeSceneIdx + 1).padStart(2, "0")}/{SCENES.length}
                  </span>
                  <span className="font-bold text-white">{activeDef.shortName}</span>
                  {suiteMode && (
                    <span className="text-[10px] text-blue-400 font-bold">
                      AUTO SUITE • {hud.progressPct}%
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-[11px]">
                  <span>
                    <strong className="text-blue-400 text-sm">{hud.fps.toFixed(1)}</strong> FPS
                  </span>
                  <span className="text-zinc-300">
                    1% Low: <strong className="text-white">{hud.low1.toFixed(1)}</strong>
                  </span>
                  <span className="text-zinc-300">
                    0.1% Low: <strong className="text-white">{hud.low01.toFixed(1)}</strong>
                  </span>
                  <span className="text-zinc-300">
                    Frame: <strong className="text-white">{hud.frameMs.toFixed(2)} ms</strong>
                  </span>
                  <span className="text-blue-300 hidden xl:inline">
                    {hud.metricLabel}: <strong>{hud.metricValue}</strong>
                  </span>
                </div>

                {/* Live Frametime Sparkline */}
                <svg
                  width="120"
                  height="28"
                  viewBox="0 0 120 28"
                  className="hidden md:block bg-white/5 rounded border border-white/10"
                >
                  <polyline
                    fill="none"
                    stroke="#60A5FA"
                    strokeWidth="1.6"
                    points={sparkPath}
                  />
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
                  Exit Fullscreen (Esc)
                </button>
              </div>
            </div>

            {/* Bottom Floating Controls Hint + Quick Scene Switcher */}
            <div className="fixed bottom-3 left-3 right-3 z-50 flex flex-col items-center gap-2 pointer-events-auto">
              <div className="px-3 py-1 rounded-lg bg-black/75 border border-white/10 font-mono text-[10.5px] text-zinc-300">
                {manualPlay ? `PLAY MODE: ${activeDef.controlHint}` : `AUTO-AI PILOT • ${activeDef.controlHint}`} • {hud.webglLabel}
              </div>
              {!suiteMode && (
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
