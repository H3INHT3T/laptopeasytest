// LaptopBench QC v3.5.0 — High-Resolution Procedural PBR Texture Suite (Albedo + Normal + Roughness + Emissive)
// Generates genuine tangent-space Sobel normal maps and physically-based roughness maps 100% offline.

import * as THREE from "three";

export interface PbrTextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  emissiveMap?: THREE.CanvasTexture;
  dispose: () => void;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

function finalizeTex(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  isColor: boolean
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function heightToNormalCanvas(heights: Uint8Array, w: number, h: number, strength: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const at = (x: number, y: number) => heights[((y + h) % h) * w + ((x + w) % w)] / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      const dz = 1.0;
      const inv = 1.0 / Math.sqrt(dx * dx + dy * dy + dz * dz);

      const idx = (y * w + x) * 4;
      out[idx] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[idx + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out[idx + 2] = Math.round((dz * inv * 0.5 + 0.5) * 255);
      out[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** 1. Woven Carbon-Fiber PBR Suite (for Supercar & Starfighter Chassis) */
export function createCarbonFiberPbr(repeatX = 4, repeatY = 4): PbrTextureSet {
  const size = 256;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const heights = new Uint8Array(size * size);

  const aImg = aCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);
  const cell = 16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const lx = (x % cell) / cell;
      const ly = (y % cell) / cell;
      const diag = (gx + gy) % 2 === 0;
      const wave = diag ? Math.sin(lx * Math.PI) * 0.85 + 0.15 : Math.sin(ly * Math.PI) * 0.85 + 0.15;
      const groove = lx < 0.08 || ly < 0.08 ? 0.45 : 1.0;
      heights[y * size + x] = Math.max(0, Math.min(255, Math.round(wave * groove * 235)));

      const idx = (y * size + x) * 4;
      const shade = Math.round(22 + wave * 34 * groove);
      aImg.data[idx] = shade;
      aImg.data[idx + 1] = shade + 3;
      aImg.data[idx + 2] = shade + 8;
      aImg.data[idx + 3] = 255;

      const rVal = Math.round(52 + (1 - wave * groove) * 110);
      rImg.data[idx] = rVal;
      rImg.data[idx + 1] = rVal;
      rImg.data[idx + 2] = rVal;
      rImg.data[idx + 3] = 255;
    }
  }
  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const normC = heightToNormalCanvas(heights, size, size, 2.4);
  const map = finalizeTex(albedoC, repeatX, repeatY, true);
  const normalMap = finalizeTex(normC, repeatX, repeatY, false);
  const roughnessMap = finalizeTex(roughC, repeatX, repeatY, false);
  return {
    map,
    normalMap,
    roughnessMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/** 2. Wet Rain-Puddle Neon Highway Asphalt PBR Suite */
export function createWetNeonAsphaltPbr(repeatX = 1, repeatY = 18): PbrTextureSet {
  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const [emissiveC, eCtx] = makeCanvas(size, size);
  const heights = new Uint8Array(size * size);

  aCtx.fillStyle = "#0F172A";
  aCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = "#B8B8B8";
  rCtx.fillRect(0, 0, size, size);
  eCtx.fillStyle = "#000000";
  eCtx.fillRect(0, 0, size, size);

  const aImg = aCtx.getImageData(0, 0, size, size);
  const rImg = rCtx.getImageData(0, 0, size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = hash2(x, y);
      const puddleWave =
        Math.sin(x * 0.025 + Math.cos(y * 0.018) * 2.1) * Math.cos(y * 0.022 - x * 0.011);
      const isPuddle = puddleWave > 0.36;
      heights[y * size + x] = isPuddle ? 128 : Math.round(100 + n * 75);

      const idx = (y * size + x) * 4;
      const base = isPuddle ? 10 : Math.round(18 + n * 16);
      aImg.data[idx] = base;
      aImg.data[idx + 1] = base + 4;
      aImg.data[idx + 2] = base + 12;
      aImg.data[idx + 3] = 255;

      const rVal = isPuddle ? 20 : Math.round(165 + n * 55);
      rImg.data[idx] = rVal;
      rImg.data[idx + 1] = rVal;
      rImg.data[idx + 2] = rVal;
      rImg.data[idx + 3] = 255;
    }
  }
  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  aCtx.fillStyle = "#38BDF8";
  aCtx.fillRect(14, 0, 12, size);
  aCtx.fillRect(size - 26, 0, 12, size);
  eCtx.fillStyle = "#38BDF8";
  eCtx.fillRect(14, 0, 12, size);
  eCtx.fillRect(size - 26, 0, 12, size);

  aCtx.fillStyle = "#F8FAFC";
  eCtx.fillStyle = "#60A5FA";
  for (const lx of [136, 256, 376]) {
    for (let y = 0; y < size; y += 64) {
      aCtx.fillRect(lx - 3, y + 10, 6, 34);
      eCtx.fillRect(lx - 2, y + 12, 4, 30);
    }
  }

  const normC = heightToNormalCanvas(heights, size, size, 1.8);
  const map = finalizeTex(albedoC, repeatX, repeatY, true);
  const normalMap = finalizeTex(normC, repeatX, repeatY, false);
  const roughnessMap = finalizeTex(roughC, repeatX, repeatY, false);
  const emissiveMap = finalizeTex(emissiveC, repeatX, repeatY, true);
  return {
    map,
    normalMap,
    roughnessMap,
    emissiveMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
      emissiveMap.dispose();
    },
  };
}

/** 3. Studio Veined Marble Tile PBR Suite */
export function createStudioMarblePbr(repeatX = 7, repeatY = 7): PbrTextureSet {
  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const heights = new Uint8Array(size * size);
  const tile = 64;

  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const dark = (tx + ty) % 2 === 0;
      aCtx.fillStyle = dark ? "#111827" : "#E5EAF2";
      aCtx.fillRect(tx * tile, ty * tile, tile, tile);
      rCtx.fillStyle = dark ? "#242424" : "#3E3E3E";
      rCtx.fillRect(tx * tile, ty * tile, tile, tile);

      aCtx.strokeStyle = dark ? "rgba(148,163,184,0.22)" : "rgba(51,65,85,0.18)";
      aCtx.lineWidth = 1.6;
      aCtx.beginPath();
      aCtx.moveTo(tx * tile, ty * tile + ((tx * 23 + ty * 11) % tile));
      aCtx.quadraticCurveTo(
        tx * tile + tile * 0.45,
        ty * tile + tile * 0.35,
        tx * tile + tile,
        ty * tile + ((tx * 13 + ty * 29) % tile)
      );
      aCtx.stroke();

      aCtx.strokeStyle = "#09090B";
      aCtx.lineWidth = 2;
      aCtx.strokeRect(tx * tile, ty * tile, tile, tile);
      rCtx.strokeStyle = "#E0E0E0";
      rCtx.lineWidth = 2;
      rCtx.strokeRect(tx * tile, ty * tile, tile, tile);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const seam = x % tile < 2 || y % tile < 2;
      heights[y * size + x] = seam ? 60 : 210;
    }
  }

  const normC = heightToNormalCanvas(heights, size, size, 1.5);
  const map = finalizeTex(albedoC, repeatX, repeatY, true);
  const normalMap = finalizeTex(normC, repeatX, repeatY, false);
  const roughnessMap = finalizeTex(roughC, repeatX, repeatY, false);
  return {
    map,
    normalMap,
    roughnessMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/** 4. Cyberpunk Glass-Curtain Skyscraper Facade PBR + Emissive Windows */
export function createSkyscraperFacadePbr(): PbrTextureSet {
  const w = 256;
  const h = 512;
  const [albedoC, aCtx] = makeCanvas(w, h);
  const [roughC, rCtx] = makeCanvas(w, h);
  const [emissiveC, eCtx] = makeCanvas(w, h);
  const heights = new Uint8Array(w * h);

  aCtx.fillStyle = "#0B1120";
  aCtx.fillRect(0, 0, w, h);
  rCtx.fillStyle = "#909090";
  rCtx.fillRect(0, 0, w, h);
  eCtx.fillStyle = "#000000";
  eCtx.fillRect(0, 0, w, h);
  heights.fill(210);

  const cols = 8;
  const rows = 24;
  const cw = w / cols;
  const rh = h / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = hash2(c * 7.3 + 1, r * 13.7 + 3);
      const x0 = Math.round(c * cw + 4);
      const y0 = Math.round(r * rh + 3);
      const ww = Math.round(cw - 8);
      const wh = Math.round(rh - 6);

      for (let py = y0; py < y0 + wh; py++) {
        for (let px = x0; px < x0 + ww; px++) {
          heights[py * w + px] = 110;
        }
      }
      rCtx.fillStyle = "#181818";
      rCtx.fillRect(x0, y0, ww, wh);

      if (k > 0.44) {
        const col =
          k > 0.88
            ? "#38BDF8"
            : k > 0.76
            ? "#F59E0B"
            : k > 0.65
            ? "#E879F9"
            : "#E2E8F0";
        aCtx.fillStyle = col;
        aCtx.fillRect(x0, y0, ww, wh);
        eCtx.fillStyle = col;
        eCtx.fillRect(x0, y0, ww, wh);
      } else {
        aCtx.fillStyle = "#1E293B";
        aCtx.fillRect(x0, y0, ww, wh);
      }
    }
  }

  const normC = heightToNormalCanvas(heights, w, h, 2.2);
  const map = finalizeTex(albedoC, 1, 1, true);
  const normalMap = finalizeTex(normC, 1, 1, false);
  const roughnessMap = finalizeTex(roughC, 1, 1, false);
  const emissiveMap = finalizeTex(emissiveC, 1, 1, true);
  return {
    map,
    normalMap,
    roughnessMap,
    emissiveMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
      emissiveMap.dispose();
    },
  };
}

/** 5. Beveled Architectural Fortress Block PBR Suite (for Rapier3D Cannon Siege) */
export function createFortressBlockPbr(): PbrTextureSet {
  const size = 256;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const heights = new Uint8Array(size * size);

  aCtx.fillStyle = "#CBD5E1";
  aCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = "#8A8A8A";
  rCtx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const bevel = Math.min(1, edge / 14);
      const grain = (hash2(x * 0.5, y * 0.5) - 0.5) * 18;
      heights[y * size + x] = Math.max(0, Math.min(255, Math.round(90 + bevel * 140 + grain)));
    }
  }

  aCtx.strokeStyle = "rgba(15,23,42,0.35)";
  aCtx.lineWidth = 4;
  aCtx.strokeRect(4, 4, size - 8, size - 8);
  aCtx.fillStyle = "rgba(15,23,42,0.45)";
  for (const [rx, ry] of [
    [22, 22],
    [size - 22, 22],
    [22, size - 22],
    [size - 22, size - 22],
  ]) {
    aCtx.beginPath();
    aCtx.arc(rx, ry, 6, 0, Math.PI * 2);
    aCtx.fill();
  }

  const normC = heightToNormalCanvas(heights, size, size, 2.6);
  const map = finalizeTex(albedoC, 1, 1, true);
  const normalMap = finalizeTex(normC, 1, 1, false);
  const roughnessMap = finalizeTex(roughC, 1, 1, false);
  return {
    map,
    normalMap,
    roughnessMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/** 6. Tileable Ocean Wave Normal Map */
export function createOceanNormalMap(repeatX = 14, repeatY = 14): THREE.CanvasTexture {
  const size = 256;
  const heights = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      const w1 = Math.sin(u * 2 + v) * 0.4;
      const w2 = Math.cos(u * 3 - v * 2) * 0.3;
      const w3 = Math.sin(u * 5 + v * 4) * 0.18;
      const w4 = Math.cos(u * 8 - v * 7) * 0.12;
      heights[y * size + x] = Math.max(0, Math.min(255, Math.round((w1 + w2 + w3 + w4 + 1.0) * 127)));
    }
  }
  const normC = heightToNormalCanvas(heights, size, size, 2.2);
  return finalizeTex(normC, repeatX, repeatY, false);
}
