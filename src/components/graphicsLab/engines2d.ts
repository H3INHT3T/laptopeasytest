// LaptopBench QC v3.3.0 — Real Full-Color PassMark-2D / MotionMark & Escalating Mini-Game Engines
// 5 real non-looping progressive 2D & interactive benchmark scenes:
//   5. 2D Escalating Vector Ceiling & Compositing (Gears, PCB Schematics, Frosted Glass & Ribbons)
//   6. 2D 2048px Satellite Topographic Map & CAD Blueprint Deep-Zoom (0.35x -> 64x + Multi-Layer Compositing)
//   7. 2D Rich IDE Code, Telemetry Data Table & Multi-Script Typography Smooth Scroll (Myanmar/CJK/Latin)
//   8. Mini-Game 1: 3-Act Starfighter Trench Run & Dreadnought Boss Encounter
//   9. Mini-Game 2: 3-Act Rigid-Body Physics Demolition & 3,000-Body Gravity Sandbox

export interface PointerInput {
  x: number;
  y: number;
  down: boolean;
  clicked: boolean;
  dx: number;
  dy: number;
  wheelDelta: number;
}

export interface Frame2DOutcome {
  metricLabel: string;
  metricValue: string;
  actLabel: string;
  throughputScoreFactor: number;
}

// ---------- High-Resolution Procedural 2048x2048 Topographic Satellite Map Generator ----------
let cachedSatelliteCanvas: HTMLCanvasElement | null = null;

export function getOrCreateSatelliteTexture(): HTMLCanvasElement {
  if (cachedSatelliteCanvas) return cachedSatelliteCanvas;
  const size = 1024;
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const c = off.getContext("2d");
  if (!c) return off;

  const img = c.createImageData(size, size);
  const d = img.data;

  // Deterministic multi-octave island/continent elevation map with bathymetry & shaded relief
  const hash = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c1 = hash(ix, iy + 1);
    const d1 = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c1 - a) * uy + (a - b - c1 + d1) * ux * uy;
  };
  const fbm = (x: number, y: number) => {
    let val = 0;
    let amp = 0.52;
    let freq = 1;
    for (let o = 0; o < 5; o++) {
      val += amp * vnoise(x * freq, y * freq);
      freq *= 2.04;
      amp *= 0.48;
    }
    return val;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const ny = y / size;
      const e = fbm(nx * 5.2, ny * 5.2);
      const eDx = fbm((nx + 0.004) * 5.2, ny * 5.2) - e;
      const eDy = fbm(nx * 5.2, (ny + 0.004) * 5.2) - e;
      const hillShade = Math.max(0.42, Math.min(1.38, 0.92 + (eDx * 9 + eDy * 7)));

      // Topographic contour lines every 0.05 elevation step
      const contour = Math.abs((e * 22) % 1 - 0.5) < 0.045 ? 0.82 : 1.0;

      let r = 0;
      let g = 0;
      let b = 0;
      if (e < 0.44) {
        // Deep to shallow turquoise ocean bathymetry
        const k = e / 0.44;
        r = 12 + k * 24;
        g = 42 + k * 96;
        b = 98 + k * 84;
      } else if (e < 0.49) {
        // Coastal golden beach
        r = 212;
        g = 192;
        b = 142;
      } else if (e < 0.68) {
        // Lush green lowlands & pine highlands
        const k = (e - 0.49) / 0.19;
        r = 42 + k * 34;
        g = 118 - k * 24;
        b = 58 - k * 12;
      } else if (e < 0.80) {
        // Alpine granite ridge
        const k = (e - 0.68) / 0.12;
        r = 112 + k * 48;
        g = 104 + k * 46;
        b = 98 + k * 48;
      } else {
        // Snow peak
        r = 236;
        g = 244;
        b = 252;
      }

      const idx = (y * size + x) * 4;
      d[idx] = Math.min(255, r * hillShade * contour);
      d[idx + 1] = Math.min(255, g * hillShade * contour);
      d[idx + 2] = Math.min(255, b * hillShade * contour);
      d[idx + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  // Overlay crisp architectural highway / sector coordinate grid & micro-labels onto the bitmap
  c.strokeStyle = "rgba(255,255,255,0.28)";
  c.lineWidth = 1;
  for (let i = 0; i <= size; i += 64) {
    c.beginPath();
    c.moveTo(i, 0);
    c.lineTo(i, size);
    c.moveTo(0, i);
    c.lineTo(size, i);
    c.stroke();
  }
  c.strokeStyle = "rgba(251, 191, 36, 0.72)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(90, 820);
  c.bezierCurveTo(280, 620, 420, 480, 740, 310);
  c.bezierCurveTo(840, 260, 910, 190, 960, 120);
  c.stroke();

  c.font = "700 13px Consolas, monospace";
  c.fillStyle = "rgba(255,255,255,0.88)";
  const sectors = ["SECTOR A-01", "ALPINE RIDGE 2840M", "PORT BAY", "METRO GRID B-04", "CAD DATUM 00"];
  sectors.forEach((lbl, idx) => {
    const sx = 120 + idx * 175;
    const sy = 160 + ((idx * 190) % 700);
    c.fillStyle = "rgba(9,9,11,0.68)";
    c.fillRect(sx - 4, sy - 13, lbl.length * 8.2 + 8, 18);
    c.fillStyle = "#F8FAFC";
    c.fillText(lbl, sx, sy);
  });

  cachedSatelliteCanvas = off;
  return off;
}

// ============================================================================
// 2D SCENE 05: ESCALATING 2D VECTOR CEILING & COMPOSITING (PassMark / MotionMark)
// Escalates real rendered vector objects from 600 -> 2,400 -> 6,000+ across Acts I-III!
// ============================================================================
export interface VectorBenchState {
  maxVectorsAt60Fps: number;
  currentVectors: number;
  totalVectorsDrawn: number;
}

export function createVectorBenchState(): VectorBenchState {
  return { maxVectorsAt60Fps: 600, currentVectors: 600, totalVectorsDrawn: 0 };
}

export function render2DVectorCeiling(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  prog: number,
  dtMs: number,
  weightMult: number,
  state: VectorBenchState
): Frame2DOutcome {
  // Progressive 3-Act ramp + adaptive ceiling probe
  const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;
  const targetVectors = Math.round(
    (actIdx === 1 ? 750 : actIdx === 2 ? 2200 : 4800) * weightMult * (0.75 + prog * 0.75)
  );
  state.currentVectors += (targetVectors - state.currentVectors) * 0.08;
  const n = Math.max(300, Math.round(state.currentVectors));
  if (dtMs <= 18.5 && n > state.maxVectorsAt60Fps) {
    state.maxVectorsAt60Fps = n;
  }
  state.totalVectorsDrawn += n;

  // Deep engineering slate background
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#0B1120");
  bg.addColorStop(0.5, "#111827");
  bg.addColorStop(1, "#090D16");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Layer 1: Detailed PCB Motherboard Schematic Traces & Gold Vias
  const pcbCount = Math.floor(n * 0.42);
  ctx.lineWidth = 1.25;
  for (let i = 0; i < pcbCount; i++) {
    const lane = i % 48;
    const y0 = 70 + (lane / 48) * (h - 140);
    const x0 = ((i * 53 + t * 85) % (w + 180)) - 90;
    const len = 36 + (i % 7) * 18;
    ctx.strokeStyle =
      i % 5 === 0
        ? "rgba(245, 158, 11, 0.55)" // Gold copper trace
        : i % 3 === 0
        ? "rgba(16, 185, 129, 0.48)" // PCB emerald trace
        : "rgba(56, 189, 248, 0.42)"; // High-speed data bus
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + len * 0.6, y0);
    ctx.lineTo(x0 + len * 0.8, y0 + (i % 2 === 0 ? 12 : -12));
    ctx.lineTo(x0 + len, y0 + (i % 2 === 0 ? 12 : -12));
    ctx.stroke();
    if (i % 4 === 0) {
      ctx.fillStyle = "#FBBF24";
      ctx.fillRect(x0 + len - 2, y0 + (i % 2 === 0 ? 10 : -14), 4, 4);
    }
  }

  // Layer 2: Interlocking Precision Mechanical Clockwork Gears (Multi-Teeth Vector Paths)
  const gearCount = Math.min(28, 8 + actIdx * 6);
  for (let g = 0; g < gearCount; g++) {
    const gx = ((g * 197.3 + 110) % (w - 160)) + 80;
    const gy = ((g * 131.7 + 120) % (h - 200)) + 100;
    const rad = 28 + (g % 5) * 16;
    const teeth = 10 + (g % 6) * 2;
    const dir = g % 2 === 0 ? 1 : -1;
    const ang0 = t * (0.9 + (g % 4) * 0.35) * dir;

    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(ang0);
    ctx.beginPath();
    for (let k = 0; k < teeth * 2; k++) {
      const a = (k / (teeth * 2)) * Math.PI * 2;
      const r = k % 2 === 0 ? rad : rad * 0.82;
      if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = g % 3 === 0 ? "rgba(217, 119, 6, 0.28)" : "rgba(59, 130, 246, 0.24)";
    ctx.strokeStyle = g % 3 === 0 ? "#F59E0B" : g % 3 === 1 ? "#38BDF8" : "#E2E8F0";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rad * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Layer 3: Translucent Alpha-Blended Bezier Ribbons & Prism Vector Shards
  const shardCount = n - pcbCount;
  for (let i = 0; i < shardCount; i++) {
    const a = t * 0.7 + i * 0.19;
    const cx = w * 0.5 + Math.cos(a * 0.7 + i * 0.03) * (w * 0.42);
    const cy = h * 0.5 + Math.sin(a * 0.9 + i * 0.05) * (h * 0.38);
    const sz = 7 + (i % 9) * 2.2;
    ctx.fillStyle =
      i % 4 === 0
        ? "rgba(59, 130, 246, 0.34)"
        : i % 4 === 1
        ? "rgba(16, 185, 129, 0.28)"
        : i % 4 === 2
        ? "rgba(245, 158, 11, 0.26)"
        : "rgba(248, 250, 252, 0.22)";
    ctx.beginPath();
    ctx.moveTo(cx, cy - sz);
    ctx.lineTo(cx + sz * 0.9, cy + sz * 0.6);
    ctx.lineTo(cx - sz * 0.9, cy + sz * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  const vps = (state.totalVectorsDrawn / Math.max(0.1, t) / 1000).toFixed(1);
  return {
    metricLabel: "2D Vector Ceiling",
    metricValue: `${n.toLocaleString()}/f • Max@60: ${state.maxVectorsAt60Fps.toLocaleString()} (${vps}k/s)`,
    actLabel:
      actIdx === 1
        ? "ACT I • PCB & Clockwork Baseline"
        : actIdx === 2
        ? "ACT II • High-Density Vector Ramp"
        : "ACT III • Maximum Vector Saturation",
    throughputScoreFactor: Math.max(0.5, state.maxVectorsAt60Fps / 1500),
  };
}

// ============================================================================
// 2D SCENE 06: HIGH-RES SATELLITE MAP & CAD BLUEPRINT DEEP-ZOOM (0.35x -> 64x)
// ============================================================================
export interface ZoomBenchState {
  zoom: number;
  panX: number;
  panY: number;
  peakZoom: number;
  megapixelsComposited: number;
}

export function createZoomBenchState(): ZoomBenchState {
  return { zoom: 0.85, panX: 0, panY: 0, peakZoom: 1.0, megapixelsComposited: 0 };
}

export function render2DTextureDeepZoom(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  prog: number,
  manual: boolean,
  pointer: PointerInput,
  weightMult: number,
  state: ZoomBenchState
): Frame2DOutcome {
  const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;
  const satTex = getOrCreateSatelliteTexture();

  if (manual) {
    if (pointer.wheelDelta !== 0) {
      state.zoom = Math.max(0.3, Math.min(128, state.zoom * (pointer.wheelDelta < 0 ? 1.18 : 0.85)));
      pointer.wheelDelta = 0;
    }
    if (pointer.down) {
      state.panX += pointer.dx / state.zoom;
      state.panY += pointer.dy / state.zoom;
      pointer.dx = 0;
      pointer.dy = 0;
    }
  } else {
    // Smooth 3-Act journey: Wide Satellite Survey -> Deep 32x-64x Urban/CAD Zoom -> Multi-Layer Rotation Pullback
    if (prog < 0.33) {
      const k = prog / 0.33;
      state.zoom = 0.75 + k * 4.5;
      state.panX = Math.sin(t * 0.6) * 140;
      state.panY = Math.cos(t * 0.5) * 90;
    } else if (prog < 0.75) {
      const k = (prog - 0.33) / 0.42;
      state.zoom = 5.25 * Math.pow(12.2, k); // climbs up to ~64x!
      state.panX = 120 * Math.cos(t * 0.45);
      state.panY = 80 * Math.sin(t * 0.4);
    } else {
      const k = (prog - 0.75) / 0.25;
      state.zoom = 64 * Math.pow(1 / 48, k);
      state.panX *= 0.96;
      state.panY *= 0.96;
    }
  }
  if (state.zoom > state.peakZoom) state.peakZoom = state.zoom;

  ctx.fillStyle = "#08101E";
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.5;
  const rot = manual ? 0 : Math.sin(t * 0.35) * (actIdx === 3 ? 0.28 : 0.08);

  // Multi-layer hardware-accelerated texture scaling + alpha/screen compositing passes
  const layers = Math.max(2, Math.round((actIdx + 1) * weightMult));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  for (let l = 0; l < layers; l++) {
    const sc = state.zoom * (1 + l * 0.08);
    ctx.globalAlpha = l === 0 ? 1.0 : 0.22 / l;
    if (l > 0) ctx.globalCompositeOperation = l % 2 === 1 ? "screen" : "lighter";
    const drawW = satTex.width * sc;
    const drawH = satTex.height * sc;
    ctx.drawImage(
      satTex,
      -drawW * 0.5 + state.panX * sc,
      -drawH * 0.5 + state.panY * sc,
      drawW,
      drawH
    );
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1.0;
  ctx.restore();

  // Precision Hairline Multi-Octave Architectural CAD Vector Overlay (auto-subdivides as zoom deepens!)
  const octave = Math.floor(Math.log2(Math.max(0.5, state.zoom)));
  for (let lv = Math.max(-1, octave - 1); lv <= octave + 2; lv++) {
    const worldStep = 140 / Math.pow(2, lv);
    const screenStep = worldStep * state.zoom;
    if (screenStep < 16 || screenStep > w * 1.2) continue;
    const alpha = Math.max(0.1, Math.min(0.42, (screenStep - 14) / 140));
    ctx.strokeStyle = lv === octave ? `rgba(56, 189, 248, ${alpha})` : `rgba(255, 255, 255, ${alpha * 0.55})`;
    ctx.lineWidth = lv === octave ? 1.15 : 0.65;
    const offX = ((cx + state.panX * state.zoom) % screenStep + screenStep) % screenStep;
    const offY = ((cy + state.panY * state.zoom) % screenStep + screenStep) % screenStep;
    ctx.beginPath();
    for (let x = offX; x < w; x += screenStep) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = offY; y < h; y += screenStep) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  // Live Optical Zoom Reticle & Scale Bar
  ctx.strokeStyle = "rgba(251, 191, 36, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - 56, cy - 36, 112, 72);
  ctx.beginPath();
  ctx.moveTo(cx - 18, cy);
  ctx.lineTo(cx + 18, cy);
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx, cy + 18);
  ctx.stroke();

  state.megapixelsComposited += (w * h * layers) / 1_000_000;
  const mpPerSec = state.megapixelsComposited / Math.max(0.1, t);

  return {
    metricLabel: "Texture Zoom",
    metricValue: `${state.zoom.toFixed(1)}x (Peak ${state.peakZoom.toFixed(0)}x) • ${mpPerSec.toFixed(0)} MP/s`,
    actLabel:
      actIdx === 1
        ? "ACT I • Satellite Topography Survey"
        : actIdx === 2
        ? "ACT II • 64x Deep-Zoom & Sub-Pixel CAD"
        : "ACT III • Multi-Layer Filtered Rotation",
    throughputScoreFactor: Math.max(0.6, mpPerSec / 180),
  };
}

// ============================================================================
// 2D SCENE 07: RICH IDE CODE, TELEMETRY TABLE & MULTI-SCRIPT TYPOGRAPHY SCROLL
// ============================================================================
export interface TextBenchState {
  scrollY: number;
  fontScale: number;
  totalGlyphs: number;
}

export function createTextBenchState(): TextBenchState {
  return { scrollY: 0, fontScale: 1.0, totalGlyphs: 0 };
}

const CODE_SNIPPETS: Array<{ kw: string; fn: string; body: string; note: string }> = [
  { kw: "pub async fn", fn: "run_gpu_3d_bench", body: "(adapter: usize, width: 1920, height: 1080) -> Result<FpsReport>", note: "// DX12 / Vulkan / Metal uncapped" },
  { kw: "struct", fn: "PbrMaterial", body: "{ albedo: vec3<f32>, metallic: f32, roughness: f32, fresnel: f32 }", note: "// Physical specular response" },
  { kw: "const", fn: "MYANMAR_QC", body: "\"မင်္ဂလာပါ — လက်တော့ပ် ဟာ့ဒ်ဝဲ စွမ်းဆောင်ရည် စစ်ဆေးမှု ၁၂၃၄၅၆၇၈၉၀\"", note: "// Unicode Complex Shaping" },
  { kw: "const", fn: "CJK_GLYPHS", body: "\"高性能グラフィックス検証 • 硬件诊断测试系统 • 다국어 텍스트 렌더링\"", note: "// Wide CJK + Hangul Atlas" },
  { kw: "const", fn: "MATH_SIGMA", body: "\"∑(i=1..N) Δt_i ≤ 6.94ms | √(σ² + μ²) ≈ 144.00 Hz | π·r² ≠ ∞\"", note: "// Sub-pixel kerning & hinting" },
  { kw: "let", fn: "telemetry_row", body: "CPU 4120 MHz | DDR5-5600 68.4 GB/s | NVMe Gen4 6450 MB/s | 62°C", note: "// Tabular numeral alignment" },
];

export function render2DRichTypographyScroll(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  prog: number,
  dt: number,
  manual: boolean,
  pointer: PointerInput,
  keys: Set<string>,
  state: TextBenchState
): Frame2DOutcome {
  const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;

  if (manual) {
    const dir = keys.has("arrowup") ? -620 : keys.has("arrowdown") ? 620 : 180 + pointer.wheelDelta * 3.5;
    pointer.wheelDelta *= 0.85;
    state.scrollY += dir * dt;
    if (keys.has("+") || keys.has("=")) state.fontScale = Math.min(1.65, state.fontScale + 0.6 * dt);
    if (keys.has("-")) state.fontScale = Math.max(0.75, state.fontScale - 0.6 * dt);
  } else {
    // 3-Act typography stress: Crisp reading scroll -> Rapid high-Hz momentum scroll -> Dynamic zoom reflow
    const vel = actIdx === 1 ? 220 : actIdx === 2 ? 740 : 480 + Math.sin(t * 3.2) * 260;
    state.scrollY += vel * dt;
    state.fontScale = actIdx === 3 ? 1.0 + Math.sin(t * 2.2) * 0.28 : 1.0;
  }

  // Crisp dark-mode IDE / publication canvas
  ctx.fillStyle = "#0F172A";
  ctx.fillRect(0, 0, w, h);

  // Split 2-column layout: Left = Syntax-Highlighted Code & Multi-Script Doc | Right = Live Data Table + Sparklines
  const splitX = Math.round(w * 0.64);
  ctx.fillStyle = "#111827";
  ctx.fillRect(20, 68, splitX - 30, h - 136);
  ctx.fillRect(splitX + 6, 68, w - splitX - 26, h - 136);
  ctx.strokeStyle = "#1E293B";
  ctx.lineWidth = 1;
  ctx.strokeRect(20, 68, splitX - 30, h - 136);
  ctx.strokeRect(splitX + 6, 68, w - splitX - 26, h - 136);

  const rowH = Math.round(28 * state.fontScale);
  const startRow = Math.floor(state.scrollY / rowH);
  const offsetY = -(state.scrollY % rowH);
  const visibleRows = Math.ceil((h - 140) / rowH) + 2;
  let frameGlyphs = 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(22, 70, w - 44, h - 140);
  ctx.clip();

  const fontPx = Math.round(13 * state.fontScale);
  ctx.font = `500 ${fontPx}px Consolas, "Segoe UI", ui-monospace, monospace`;

  for (let r = 0; r < visibleRows; r++) {
    const rowNum = Math.abs(startRow + r);
    const y = 88 + offsetY + r * rowH;
    const snip = CODE_SNIPPETS[rowNum % CODE_SNIPPETS.length];

    // Alternating subtle row band
    if (rowNum % 2 === 0) {
      ctx.fillStyle = "rgba(30, 41, 59, 0.35)";
      ctx.fillRect(22, y - fontPx - 2, splitX - 34, rowH);
    }

    // Line number
    const ln = String(rowNum + 1).padStart(4, "0");
    ctx.fillStyle = "#64748B";
    ctx.fillText(ln, 32, y);

    // Syntax-highlighted tokens
    let x = 32 + 46 * state.fontScale;
    ctx.fillStyle = "#38BDF8";
    ctx.fillText(snip.kw, x, y);
    x += (snip.kw.length + 1) * fontPx * 0.62;

    ctx.fillStyle = "#FBBF24";
    ctx.fillText(snip.fn, x, y);
    x += (snip.fn.length + 1) * fontPx * 0.62;

    ctx.fillStyle = "#E2E8F0";
    ctx.fillText(snip.body, x, y);
    x += (snip.body.length + 1) * fontPx * 0.62;

    if (x < splitX - 110) {
      ctx.fillStyle = "#34D399";
      ctx.fillText(snip.note, x, y);
    }
    frameGlyphs += ln.length + snip.kw.length + snip.fn.length + snip.body.length + snip.note.length;

    // Right column: High-density numeric telemetry table + mini vector bar
    const rx = splitX + 18;
    const mhz = 2800 + ((rowNum * 137) % 2100);
    const load = 20 + ((rowNum * 29 + Math.floor(t * 20)) % 80);
    const tblTxt = `NODE-${String(rowNum % 999).padStart(3, "0")}  ${mhz} MHz  ${load}%  ${(
      6.1 + (rowNum % 14) * 0.35
    ).toFixed(2)}ms`;
    ctx.fillStyle = rowNum % 4 === 0 ? "#60A5FA" : "#CBD5E1";
    ctx.fillText(tblTxt, rx, y);
    frameGlyphs += tblTxt.length;

    const barX = w - 110;
    ctx.fillStyle = "#1E293B";
    ctx.fillRect(barX, y - 9, 76, 7);
    ctx.fillStyle = load > 80 ? "#F59E0B" : "#3B82F6";
    ctx.fillRect(barX, y - 9, Math.round((load / 100) * 76), 7);
  }
  ctx.restore();

  state.totalGlyphs += frameGlyphs;
  const gps = state.totalGlyphs / Math.max(0.1, t);

  return {
    metricLabel: "Glyph Throughput",
    metricValue: `${(gps / 1000).toFixed(1)}k glyphs/s • Scale ${state.fontScale.toFixed(2)}x`,
    actLabel:
      actIdx === 1
        ? "ACT I • Crisp Multi-Script Document"
        : actIdx === 2
        ? "ACT II • High-Velocity 120Hz+ Scroll"
        : "ACT III • Live Dynamic Font-Scale Reflow",
    throughputScoreFactor: Math.max(0.6, gps / 140_000),
  };
}

// ============================================================================
// MINI-GAME 08: 3-ACT STARFIGHTER TRENCH RUN & DREADNOUGHT BOSS BATTLE
// ============================================================================
export interface StarfighterState {
  shipX: number;
  shipY: number;
  shield: number;
  score: number;
  combo: number;
  kills: number;
  fireCd: number;
  shake: number;
  bossHp: number;
  bossMaxHp: number;
  bossX: number;
  bossVx: number;
  bullets: Array<{ x: number; y: number; vx: number; vy: number; friendly: boolean; col: string }>;
  enemies: Array<{ x: number; y: number; vx: number; vy: number; hp: number; r: number; kind: number }>;
  sparks: Array<{ x: number; y: number; vx: number; vy: number; life: number; col: string }>;
  waves: Array<{ x: number; y: number; r: number; maxR: number; col: string }>;
}

export function createStarfighterState(w: number, h: number): StarfighterState {
  return {
    shipX: w * 0.5,
    shipY: h * 0.8,
    shield: 100,
    score: 0,
    combo: 1,
    kills: 0,
    fireCd: 0,
    shake: 0,
    bossHp: 120,
    bossMaxHp: 120,
    bossX: w * 0.5,
    bossVx: 140,
    bullets: [],
    enemies: [],
    sparks: [],
    waves: [],
  };
}

export function renderStarfighterArena(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  prog: number,
  dt: number,
  manual: boolean,
  pointer: PointerInput,
  keys: Set<string>,
  weightMult: number,
  st: StarfighterState
): Frame2DOutcome {
  const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;

  ctx.save();
  if (st.shake > 0.2) {
    ctx.translate((Math.random() - 0.5) * st.shake, (Math.random() - 0.5) * st.shake);
    st.shake *= 0.88;
  }

  // Deep nebula space background
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.3, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
  bg.addColorStop(0, actIdx === 3 ? "#1E1B4B" : "#0F172A");
  bg.addColorStop(1, "#05070D");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 3-layer parallax starfield
  for (let i = 0; i < 160; i++) {
    const layer = (i % 3) + 1;
    const sx = (i * 197.3) % w;
    const sy = (i * 113.7 + t * layer * 95) % h;
    ctx.fillStyle = layer === 3 ? "#FFFFFF" : layer === 2 ? "#93C5FD" : "#475569";
    ctx.fillRect(sx, sy, layer * 0.9, layer * 1.4);
  }

  // Player movement vs Auto-AI Ace Pilot
  if (manual) {
    const spd = 560 * dt;
    if (keys.has("a") || keys.has("arrowleft")) st.shipX -= spd;
    if (keys.has("d") || keys.has("arrowright")) st.shipX += spd;
    if (keys.has("w") || keys.has("arrowup")) st.shipY -= spd;
    if (keys.has("s") || keys.has("arrowdown")) st.shipY += spd;
    if (pointer.down || (pointer.x !== 0.5 && keys.size === 0)) {
      st.shipX += (pointer.x * w - st.shipX) * 0.24;
      st.shipY += (Math.max(0.28, pointer.y) * h - st.shipY) * 0.24;
    }
    if (pointer.clicked || keys.has(" ")) {
      st.waves.push({ x: st.shipX, y: st.shipY, r: 12, maxR: 320, col: "#38BDF8" });
      st.shake = 7;
      pointer.clicked = false;
    }
  } else {
    const aimX =
      actIdx === 3 && st.bossHp > 0
        ? st.bossX + Math.sin(t * 3.1) * 140
        : w * 0.5 + Math.sin(t * 2.1) * w * 0.35;
    const aimY = h * 0.78 + Math.cos(t * 2.5) * 48;
    st.shipX += (aimX - st.shipX) * 0.14;
    st.shipY += (aimY - st.shipY) * 0.14;
  }
  st.shipX = Math.max(38, Math.min(w - 38, st.shipX));
  st.shipY = Math.max(120, Math.min(h - 90, st.shipY));

  // Spawn escalating waves
  const maxEnemies = Math.round((actIdx === 1 ? 10 : actIdx === 2 ? 18 : 12) * weightMult);
  if (st.enemies.length < maxEnemies && Math.random() < (actIdx === 2 ? 0.26 : 0.16)) {
    const kind = actIdx === 1 ? 0 : Math.random() < 0.45 ? 1 : 0;
    st.enemies.push({
      x: 70 + Math.random() * (w - 140),
      y: 72,
      vx: (Math.random() - 0.5) * (kind === 1 ? 90 : 180),
      vy: kind === 1 ? 58 : 115,
      hp: kind === 1 ? 5 : 2,
      r: kind === 1 ? 21 : 14,
      kind,
    });
  }

  // Rapid twin/triple plasma cannon fire
  st.fireCd -= dt;
  if (st.fireCd <= 0) {
    st.fireCd = actIdx >= 2 ? 0.055 : 0.072;
    st.bullets.push({ x: st.shipX - 13, y: st.shipY - 14, vx: -15, vy: -820, friendly: true, col: "#38BDF8" });
    st.bullets.push({ x: st.shipX + 13, y: st.shipY - 14, vx: 15, vy: -820, friendly: true, col: "#38BDF8" });
    if (actIdx >= 2) {
      st.bullets.push({ x: st.shipX, y: st.shipY - 22, vx: 0, vy: -900, friendly: true, col: "#FBBF24" });
    }
  }

  // Act III Dreadnought Boss logic
  if (actIdx === 3 && st.bossHp > 0) {
    st.bossX += st.bossVx * dt;
    if (st.bossX < 170 || st.bossX > w - 170) st.bossVx *= -1;
    const bossY = 165;
    // Boss radial bullet curtains
    if (Math.random() < 0.14 && st.bullets.length < 480) {
      const petals = 12;
      for (let k = 0; k < petals; k++) {
        const a = (k / petals) * Math.PI * 2 + t * 1.4;
        st.bullets.push({
          x: st.bossX,
          y: bossY + 18,
          vx: Math.cos(a) * 240,
          vy: Math.sin(a) * 240 + 60,
          friendly: false,
          col: "#F97316",
        });
      }
    }
    // Render Dreadnought Boss
    ctx.fillStyle = "#1E293B";
    ctx.strokeStyle = "#F59E0B";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(st.bossX, bossY + 42);
    ctx.lineTo(st.bossX - 110, bossY + 10);
    ctx.lineTo(st.bossX - 85, bossY - 34);
    ctx.lineTo(st.bossX + 85, bossY - 34);
    ctx.lineTo(st.bossX + 110, bossY + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Glowing reactor core + Boss HP bar
    ctx.fillStyle = "#F97316";
    ctx.beginPath();
    ctx.arc(st.bossX, bossY, 16 + Math.sin(t * 10) * 2.5, 0, Math.PI * 2);
    ctx.fill();
    const hpPct = Math.max(0, st.bossHp / st.bossMaxHp);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(st.bossX - 90, bossY - 52, 180, 8);
    ctx.fillStyle = "#F59E0B";
    ctx.fillRect(st.bossX - 90, bossY - 52, 180 * hpPct, 8);
  }

  // Update enemies
  for (let i = st.enemies.length - 1; i >= 0; i--) {
    const e = st.enemies[i];
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.x < 34 || e.x > w - 34) e.vx *= -1;
    if (Math.random() < (e.kind === 1 ? 0.05 : 0.02) && st.bullets.length < 480) {
      const ang = Math.atan2(st.shipY - e.y, st.shipX - e.x);
      st.bullets.push({
        x: e.x,
        y: e.y + 10,
        vx: Math.cos(ang) * 270,
        vy: Math.sin(ang) * 270,
        friendly: false,
        col: e.kind === 1 ? "#FB7185" : "#F59E0B",
      });
    }
    if (e.y > h + 30) st.enemies.splice(i, 1);
  }

  // Update bullets & collisions
  for (let i = st.bullets.length - 1; i >= 0; i--) {
    const b = st.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < -30 || b.x > w + 30 || b.y < -30 || b.y > h + 30) {
      st.bullets.splice(i, 1);
      continue;
    }
    if (b.friendly) {
      // Check Boss hit
      if (actIdx === 3 && st.bossHp > 0 && Math.abs(b.x - st.bossX) < 92 && Math.abs(b.y - 165) < 38) {
        st.bossHp -= 1;
        st.score += 40;
        st.sparks.push({ x: b.x, y: b.y, vx: (Math.random() - 0.5) * 220, vy: 80 + Math.random() * 140, life: 0.7, col: "#FBBF24" });
        st.bullets.splice(i, 1);
        if (st.bossHp <= 0) {
          st.score += 5000;
          st.kills += 1;
          st.shake = 16;
          st.waves.push({ x: st.bossX, y: 165, r: 16, maxR: 420, col: "#FBBF24" });
          for (let k = 0; k < 140; k++) {
            const a = (k / 140) * Math.PI * 2;
            const s = 90 + Math.random() * 380;
            st.sparks.push({ x: st.bossX, y: 165, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.4, col: k % 2 === 0 ? "#FBBF24" : "#38BDF8" });
          }
          // Respawn stronger boss if playing solo
          st.bossMaxHp += 60;
          st.bossHp = st.bossMaxHp;
        }
        continue;
      }
      // Check Enemy hit
      for (let j = st.enemies.length - 1; j >= 0; j--) {
        const e = st.enemies[j];
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        if (dx * dx + dy * dy < (e.r + 7) * (e.r + 7)) {
          e.hp -= 1;
          st.bullets.splice(i, 1);
          if (e.hp <= 0) {
            st.kills += 1;
            st.combo = Math.min(12, st.combo + 1);
            st.score += (e.kind === 1 ? 300 : 120) * st.combo;
            st.shake = Math.max(st.shake, e.kind === 1 ? 8 : 3.5);
            st.waves.push({ x: e.x, y: e.y, r: 8, maxR: e.kind === 1 ? 115 : 68, col: e.kind === 1 ? "#F97316" : "#38BDF8" });
            for (let k = 0; k < 22; k++) {
              const a = (k / 22) * Math.PI * 2;
              const s = 80 + Math.random() * 240;
              st.sparks.push({ x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.0, col: k % 2 === 0 ? "#FBBF24" : "#FFFFFF" });
            }
            st.enemies.splice(j, 1);
          }
          break;
        }
      }
    }
  }

  // Render shockwaves, sparks, enemies, bullets, ship
  ctx.lineWidth = 2.2;
  for (let i = st.waves.length - 1; i >= 0; i--) {
    const wv = st.waves[i];
    wv.r += 390 * dt;
    const alpha = Math.max(0, 1 - wv.r / wv.maxR);
    ctx.strokeStyle = wv.col;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(wv.x, wv.y, wv.r, 0, Math.PI * 2);
    ctx.stroke();
    if (wv.r >= wv.maxR) st.waves.splice(i, 1);
  }
  ctx.globalAlpha = 1;

  for (let i = st.sparks.length - 1; i >= 0; i--) {
    const sp = st.sparks[i];
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    sp.life -= dt * 1.9;
    if (sp.life <= 0) {
      st.sparks.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = Math.min(1, sp.life);
    ctx.fillStyle = sp.col;
    ctx.fillRect(sp.x, sp.y, 3, 3);
  }
  ctx.globalAlpha = 1;

  for (const e of st.enemies) {
    ctx.fillStyle = e.kind === 1 ? "#7C2D12" : "#1E3A8A";
    ctx.strokeStyle = e.kind === 1 ? "#F97316" : "#38BDF8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y + e.r);
    ctx.lineTo(e.x - e.r, e.y - e.r * 0.65);
    ctx.lineTo(e.x, e.y - e.r * 0.25);
    ctx.lineTo(e.x + e.r, e.y - e.r * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  for (const b of st.bullets) {
    ctx.fillStyle = b.col;
    ctx.fillRect(b.x - 2, b.y - 7, 4, b.friendly ? 14 : 7);
  }

  // Player Starfighter with thruster glow
  ctx.fillStyle = "#F59E0B";
  ctx.beginPath();
  ctx.moveTo(st.shipX - 6, st.shipY + 12);
  ctx.lineTo(st.shipX + 6, st.shipY + 12);
  ctx.lineTo(st.shipX, st.shipY + 26 + Math.random() * 10);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#2563EB";
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(st.shipX, st.shipY - 24);
  ctx.lineTo(st.shipX - 22, st.shipY + 15);
  ctx.lineTo(st.shipX, st.shipY + 8);
  ctx.lineTo(st.shipX + 22, st.shipY + 15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();

  return {
    metricLabel: "Starfighter",
    metricValue: `${st.score.toLocaleString()} pts • ${st.kills} kills • x${st.combo}`,
    actLabel:
      actIdx === 1
        ? "ACT I • Scout Squadrons"
        : actIdx === 2
        ? "ACT II • Heavy Cruiser Bullet Curtain"
        : "ACT III • Dreadnought Boss Encounter",
    throughputScoreFactor: 1.0 + Math.min(0.6, st.bullets.length / 400),
  };
}

// ============================================================================
// MINI-GAME 09: 3-ACT RIGID-BODY PHYSICS DEMOLITION & 3,000-BODY SANDBOX
// ============================================================================
export interface PhysicsSimState {
  maxBodies: number;
  activeBodies: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  r: number;
  collisions: number;
}

export function createPhysicsSimState(w: number, h: number, maxBodies: number): PhysicsSimState {
  const x = new Float32Array(maxBodies);
  const y = new Float32Array(maxBodies);
  const vx = new Float32Array(maxBodies);
  const vy = new Float32Array(maxBodies);
  // Seed initial structured tower columns for Act I demolition!
  for (let i = 0; i < maxBodies; i++) {
    const col = i % 24;
    const row = Math.floor(i / 24);
    x[i] = w * 0.2 + (col / 24) * (w * 0.6) + (row % 2) * 4;
    y[i] = h - 90 - (row % 36) * 10;
    vx[i] = (((i * 17) % 9) - 4) * 0.45;
    vy[i] = -(((i * 13) % 7) * 0.4);
  }
  return {
    maxBodies,
    activeBodies: Math.min(maxBodies, 450),
    x,
    y,
    vx,
    vy,
    r: maxBodies > 2000 ? 3.2 : 4.1,
    collisions: 0,
  };
}

export function renderPhysicsSandbox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  prog: number,
  dt: number,
  manual: boolean,
  pointer: PointerInput,
  st: PhysicsSimState
): Frame2DOutcome {
  const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;
  // Escalate active colliding bodies smoothly across Acts I -> II -> III!
  const targetActive = Math.round(
    st.maxBodies * (actIdx === 1 ? 0.35 : actIdx === 2 ? 0.68 : 1.0)
  );
  if (st.activeBodies < targetActive) {
    st.activeBodies = Math.min(st.maxBodies, st.activeBodies + 14);
  }

  ctx.fillStyle = "rgba(8, 12, 22, 0.38)";
  ctx.fillRect(0, 0, w, h);

  // Act I: Gravity drop + periodic wrecking shockwave | Act II: Dual Centrifuge Vortex | Act III: Rotating Gravity + Full Swarm
  const gravAngle = actIdx === 1 ? Math.PI * 0.5 : Math.floor(t / 2.2) * (Math.PI * 0.5) + Math.PI * 0.5;
  const gx = Math.cos(gravAngle) * 210;
  const gy = Math.sin(gravAngle) * 210;

  const autoBlast = !manual && Math.sin(t * 2.4) > 0.92;
  const blastOn = (manual && pointer.down) || autoBlast;
  const blastX = manual ? pointer.x * w : w * 0.5 + Math.cos(t * 1.3) * w * 0.25;
  const blastY = manual ? pointer.y * h : h * 0.55 + Math.sin(t * 1.7) * h * 0.18;

  const cellSz = st.r * 2.6;
  const cols = Math.max(1, Math.ceil(w / cellSz));
  const grid = new Map<number, number[]>();
  const n = st.activeBodies;

  for (let i = 0; i < n; i++) {
    st.vx[i] += gx * dt;
    st.vy[i] += gy * dt;

    if (actIdx === 2) {
      // Swirling vortex force
      const dx = w * 0.5 - st.x[i];
      const dy = h * 0.5 - st.y[i];
      const d = Math.sqrt(dx * dx + dy * dy) + 35;
      st.vx[i] += (dx / d * 120 - dy / d * 190) * dt;
      st.vy[i] += (dy / d * 120 + dx / d * 190) * dt;
    }

    if (blastOn) {
      const dx = st.x[i] - blastX;
      const dy = st.y[i] - blastY;
      const d2 = dx * dx + dy * dy + 80;
      if (d2 < 48000) {
        const f = 14000 / d2;
        st.vx[i] += dx * f * dt;
        st.vy[i] += dy * f * dt;
      }
    }

    st.x[i] += st.vx[i] * dt * 58;
    st.y[i] += st.vy[i] * dt * 58;
    st.vx[i] *= 0.994;
    st.vy[i] *= 0.994;

    if (st.x[i] < st.r) {
      st.x[i] = st.r;
      st.vx[i] = Math.abs(st.vx[i]) * 0.86;
    } else if (st.x[i] > w - st.r) {
      st.x[i] = w - st.r;
      st.vx[i] = -Math.abs(st.vx[i]) * 0.86;
    }
    if (st.y[i] < 68 + st.r) {
      st.y[i] = 68 + st.r;
      st.vy[i] = Math.abs(st.vy[i]) * 0.86;
    } else if (st.y[i] > h - 68 - st.r) {
      st.y[i] = h - 68 - st.r;
      st.vy[i] = -Math.abs(st.vy[i]) * 0.86;
    }

    const key = Math.floor(st.y[i] / cellSz) * cols + Math.floor(st.x[i] / cellSz);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  const minDist = st.r * 2;
  const minDistSq = minDist * minDist;
  grid.forEach((bucket) => {
    const len = Math.min(bucket.length, 12);
    for (let a = 0; a < len; a++) {
      const i = bucket[a];
      for (let b = a + 1; b < len; b++) {
        const j = bucket[b];
        const dx = st.x[j] - st.x[i];
        const dy = st.y[j] - st.y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < minDistSq) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const ov = (minDist - d) * 0.5;
          st.x[i] -= nx * ov;
          st.y[i] -= ny * ov;
          st.x[j] += nx * ov;
          st.y[j] += ny * ov;
          const sep = (st.vx[j] - st.vx[i]) * nx + (st.vy[j] - st.vy[i]) * ny;
          if (sep < 0) {
            const imp = -sep * 0.92;
            st.vx[i] -= nx * imp;
            st.vy[i] -= ny * imp;
            st.vx[j] += nx * imp;
            st.vy[j] += ny * imp;
            st.collisions += 1;
          }
        }
      }
    }
  });

  // Velocity-heat-mapped kinetic coloring (deep cobalt -> electric cyan -> amber -> white-hot!)
  const sz = st.r * 1.55;
  for (let i = 0; i < n; i++) {
    const spd = Math.abs(st.vx[i]) + Math.abs(st.vy[i]);
    ctx.fillStyle =
      spd > 9.5 ? "#FFFFFF" : spd > 6.0 ? "#F59E0B" : spd > 3.2 ? "#38BDF8" : "#2563EB";
    ctx.fillRect(st.x[i] - sz * 0.5, st.y[i] - sz * 0.5, sz, sz);
  }

  if (blastOn) {
    ctx.strokeStyle = "#FBBF24";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(blastX, blastY, 48 + ((t * 140) % 72), 0, Math.PI * 2);
    ctx.stroke();
  }

  const colPerSec = (st.collisions / Math.max(0.1, t) / 1000).toFixed(1);
  return {
    metricLabel: "Rigid-Body Sim",
    metricValue: `${n.toLocaleString()} bodies • ${colPerSec}k col/s`,
    actLabel:
      actIdx === 1
        ? "ACT I • Tower Collapse & Shockwaves"
        : actIdx === 2
        ? "ACT II • Kinetic Centrifuge Vortex"
        : "ACT III • Maximum Swarm Saturation",
    throughputScoreFactor: Math.max(0.6, n / 1200),
  };
}
