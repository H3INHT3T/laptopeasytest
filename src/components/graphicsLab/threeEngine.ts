// LaptopBench QC v3.4.0 — Real Three.js 3D Game & PBR Rendering Engine
// Powers 6 real Three.js WebGL2 3D scenes with dynamic shadows, PBR materials, InstancedMesh, and real 3D game controls:
//   1. three_island       — 3D Sunlit Island, Terrain & Ocean Shadows
//   2. three_studio       — 3D PBR Metallic, Glass & Dynamic Multi-Light Studio
//   3. three_megacity     — 3D Instanced Neon Cyberpunk Megacity Flythrough
//   4. three_game_fighter — Playable 3D Game 1: 3D Space Fighter Trench Combat & Boss
//   5. three_game_racer   — Playable 3D Game 2: 3D Neon Highway Turbo Racer
//   6. three_game_cannon  — Playable 3D Game 3: 3D Physics Tower Destruction Cannon

import * as THREE from "three";
import type { PointerInput } from "./engines2d";

export type ThreeSceneId =
  | "three_island"
  | "three_studio"
  | "three_megacity"
  | "three_game_fighter"
  | "three_game_racer"
  | "three_game_cannon";

export interface ThreeFrameMetrics {
  metricLabel: string;
  metricValue: string;
  actLabel: string;
  triangles: number;
  drawCalls: number;
  throughputScoreFactor: number;
}

export interface ThreeSceneController {
  rendererName: string;
  step: (
    t: number,
    dt: number,
    prog: number,
    manual: boolean,
    pointer: PointerInput,
    keys: Set<string>
  ) => ThreeFrameMetrics;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

// ---------- Procedural PBR Canvas Textures ----------
function createMarbleFloorTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const tile = 64;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const dark = (x + y) % 2 === 0;
      ctx.fillStyle = dark ? "#111827" : "#E2E8F0";
      ctx.fillRect(x * tile, y * tile, tile, tile);
      // Subtle marble veins
      ctx.strokeStyle = dark ? "rgba(148,163,184,0.14)" : "rgba(71,85,105,0.15)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x * tile, y * tile + ((x * 17) % tile));
      ctx.quadraticCurveTo(
        x * tile + tile * 0.5,
        y * tile + tile * 0.4,
        x * tile + tile,
        y * tile + tile * 0.85
      );
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSkyscraperWindowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0B1120";
  ctx.fillRect(0, 0, 256, 512);
  const cols = 8;
  const rows = 24;
  const cw = 256 / cols;
  const rh = 512 / rows;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const h = Math.sin(r * 19.3 + col * 71.7) * 43758.5453;
      const frac = h - Math.floor(h);
      if (frac > 0.48) {
        ctx.fillStyle =
          frac > 0.86
            ? "#38BDF8"
            : frac > 0.72
            ? "#FBBF24"
            : frac > 0.62
            ? "#F8FAFC"
            : "#60A5FA";
        ctx.fillRect(col * cw + 5, r * rh + 4, cw - 10, rh - 8);
      } else {
        ctx.fillStyle = "#1E293B";
        ctx.fillRect(col * cw + 5, r * rh + 4, cw - 10, rh - 8);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createHighwayTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0F172A";
  ctx.fillRect(0, 0, 512, 512);
  // Subtle asphalt grain
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let i = 0; i < 600; i++) {
    ctx.fillRect((i * 73) % 512, (i * 131) % 512, 2, 6);
  }
  // Neon cyan highway edge rails
  ctx.fillStyle = "#38BDF8";
  ctx.fillRect(14, 0, 10, 512);
  ctx.fillRect(488, 0, 10, 512);
  // 3 Dashed lane dividers
  ctx.fillStyle = "#F8FAFC";
  for (const x of [136, 256, 376]) {
    for (let y = 0; y < 512; y += 64) {
      ctx.fillRect(x - 3, y + 10, 6, 34);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function terrainHeightFn(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  const islandMask = Math.max(0, 1 - Math.pow(r / 68, 2.2));
  const h1 = Math.sin(x * 0.08) * Math.cos(z * 0.08) * 6.5;
  const h2 = Math.sin(x * 0.19 + 1.3) * Math.sin(z * 0.17 - 0.8) * 3.1;
  const h3 = Math.cos((x + z) * 0.34) * 1.1;
  const peak = Math.exp(-((x * x + z * z) / 520)) * 11.5;
  return (h1 + h2 + h3 + peak + 4.2) * islandMask - 2.6;
}

export function createThreeSceneController(
  canvas: HTMLCanvasElement,
  sceneId: ThreeSceneId,
  width: number,
  height: number,
  loadMult: number // 0.78 | 1.0 | 1.38 | 1.85
): ThreeSceneController | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, loadMult > 1.5 ? 2 : 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Read unmasked GPU renderer name if exposed
  let rendererName = "Three.js WebGL2 Hardware";
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      const r = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (typeof r === "string" && r.trim()) rendererName = r.trim();
    }
  } catch {
    // Ignore
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / Math.max(1, height), 0.2, 420);
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(obj: T): T => {
    disposables.push(obj);
    return obj;
  };

  let stepFn: (
    t: number,
    dt: number,
    prog: number,
    manual: boolean,
    pointer: PointerInput,
    keys: Set<string>
  ) => ThreeFrameMetrics;

  // =========================================================================
  // SCENE 1: 3D SUNLIT ISLAND, TERRAIN & OCEAN SHADOWS
  // =========================================================================
  if (sceneId === "three_island") {
    scene.background = new THREE.Color("#7BB4EB");
    scene.fog = new THREE.FogExp2("#8FC1EE", 0.0082);

    const hemi = new THREE.HemisphereLight("#BAE6FD", "#1E3A5F", 0.8);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight("#FFF5DC", 2.6);
    sun.position.set(42, 46, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(loadMult > 1.2 ? 2048 : 1024, loadMult > 1.2 ? 2048 : 1024);
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 160;
    const d = 58;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    // Glowing Sun disc in sky
    const sunOrb = new THREE.Mesh(
      track(new THREE.SphereGeometry(4.2, 24, 24)),
      track(new THREE.MeshBasicMaterial({ color: "#FFF4C2" }))
    );
    scene.add(sunOrb);

    // High-Poly Displaced Vertex-Biome Island Terrain
    const segs = Math.round(96 * Math.min(1.6, Math.max(0.8, loadMult)));
    const terrGeo = track(new THREE.PlaneGeometry(160, 160, segs, segs));
    terrGeo.rotateX(-Math.PI / 2);
    const posAttr = terrGeo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(posAttr.count * 3);
    const colTmp = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const y = terrainHeightFn(x, z);
      posAttr.setY(i, y);
      if (y < 0.2) colTmp.set("#D8C39E"); // Coastal sand
      else if (y < 4.5) colTmp.set("#2D6A4F"); // Lush forest
      else if (y < 9.2) colTmp.set("#525866"); // Alpine granite
      else colTmp.set("#F1F5F9"); // Snow cap
      colors[i * 3] = colTmp.r;
      colors[i * 3 + 1] = colTmp.g;
      colors[i * 3 + 2] = colTmp.b;
    }
    terrGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    terrGeo.computeVertexNormals();
    const terrMat = track(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.04,
      })
    );
    const terrain = new THREE.Mesh(terrGeo, terrMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    scene.add(terrain);

    // Animated Reflective Ocean Water Plane
    const waterGeo = track(new THREE.PlaneGeometry(280, 280, 64, 64));
    waterGeo.rotateX(-Math.PI / 2);
    const waterBaseY = new Float32Array(waterGeo.attributes.position.count);
    const waterMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#0C4A6E",
        roughness: 0.14,
        metalness: 0.28,
        clearcoat: 0.9,
        clearcoatRoughness: 0.12,
        transparent: true,
        opacity: 0.9,
      })
    );
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = -0.15;
    water.receiveShadow = true;
    scene.add(water);

    // Instanced 3D Pine Trees casting real shadows across the island
    const treeCount = Math.round(280 * loadMult);
    const treeGeo = track(new THREE.ConeGeometry(0.95, 3.6, 7));
    const treeMat = track(new THREE.MeshStandardMaterial({ color: "#1B4332", roughness: 0.8 }));
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, treeCount);
    trees.castShadow = true;
    trees.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let placed = 0;
    for (let i = 0; i < treeCount * 4 && placed < treeCount; i++) {
      const a = i * 2.39996;
      const rad = 8 + ((i * 19.7) % 46);
      const tx = Math.cos(a) * rad;
      const tz = Math.sin(a) * rad;
      const ty = terrainHeightFn(tx, tz);
      if (ty > 0.6 && ty < 6.4) {
        const s = 0.75 + ((i * 13) % 7) * 0.14;
        dummy.position.set(tx, ty + 1.6 * s, tz);
        dummy.scale.set(s, s, s);
        dummy.rotation.set(0, a, 0);
        dummy.updateMatrix();
        trees.setMatrixAt(placed++, dummy.matrix);
      }
    }
    trees.count = placed;
    trees.instanceMatrix.needsUpdate = true;
    scene.add(trees);

    // Glowing Summit Beacon Monolith
    const monolith = new THREE.Mesh(
      track(new THREE.OctahedronGeometry(1.8, 0)),
      track(
        new THREE.MeshPhysicalMaterial({
          color: "#38BDF8",
          emissive: "#1D4ED8",
          emissiveIntensity: 0.7,
          roughness: 0.1,
          metalness: 0.85,
          clearcoat: 1.0,
        })
      )
    );
    monolith.position.set(0, terrainHeightFn(0, 0) + 3.4, 0);
    monolith.castShadow = true;
    scene.add(monolith);

    stepFn = (t, _dt, prog, manual, pointer) => {
      // Animate rolling ocean waves
      const wPos = waterGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < wPos.count; i++) {
        const wx = wPos.getX(i);
        const wz = wPos.getZ(i);
        const wy =
          waterBaseY[i] +
          Math.sin(wx * 0.14 + t * 2.1) * 0.24 +
          Math.cos(wz * 0.12 - t * 1.7) * 0.2;
        wPos.setY(i, wy);
      }
      wPos.needsUpdate = true;

      // Dynamic 3-Act sun & sky shift: Daylight -> Golden Sunset -> Alpine Dusk
      const sunAng = 0.45 + prog * 1.15;
      const sunElev = Math.max(0.16, Math.sin(Math.PI * (0.2 + prog * 0.65)));
      sun.position.set(Math.cos(sunAng) * 65, sunElev * 58, Math.sin(sunAng) * 65);
      sunOrb.position.copy(sun.position).multiplyScalar(1.9);

      const sunsetK = Math.max(0, Math.min(1, (prog - 0.25) * 1.6));
      const skyCol = new THREE.Color("#7BB4EB").lerp(new THREE.Color("#F59E6C"), sunsetK * 0.72);
      if (prog > 0.72) skyCol.lerp(new THREE.Color("#1E293B"), (prog - 0.72) * 2.4);
      scene.background = skyCol;
      (scene.fog as THREE.FogExp2).color.copy(skyCol);
      sun.color.set("#FFF5DC").lerp(new THREE.Color("#FB923C"), sunsetK * 0.75);

      monolith.rotation.y = t * 0.9;
      monolith.position.y = terrainHeightFn(0, 0) + 3.4 + Math.sin(t * 2.1) * 0.55;

      // Smooth 3-Act drone flight (or manual Mouse Orbit/Altitude)
      const orbitAng = t * 0.22 + (manual ? (pointer.x - 0.5) * 4.5 : 0);
      const radius = manual ? 38 : 48 - prog * 16;
      const alt = manual
        ? 10 + (1 - pointer.y) * 28
        : 14 + Math.sin(prog * Math.PI) * 14 + Math.cos(t * 0.6) * 2.5;
      camera.position.set(Math.cos(orbitAng) * radius, alt, Math.sin(orbitAng) * radius);
      camera.lookAt(0, 4.5, 0);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D Island PBR",
        metricValue: `${(tris / 1000).toFixed(1)}k tris • ${placed} shadow trees • ${calls} calls`,
        actLabel:
          prog < 0.33
            ? "ACT I • Daylight Coastal Flight"
            : prog < 0.66
            ? "ACT II • Golden Hour Shadows"
            : "ACT III • Summit Beacon Dusk Dive",
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: Math.max(0.85, tris / 45000),
      };
    };
  }

  // =========================================================================
  // SCENE 2: 3D PBR METALLIC, GLASS & DYNAMIC MULTI-LIGHT STUDIO
  // =========================================================================
  else if (sceneId === "three_studio") {
    scene.background = new THREE.Color("#0B0F1A");
    scene.fog = new THREE.FogExp2("#0B0F1A", 0.018);
    scene.add(new THREE.AmbientLight("#64748B", 0.45));

    const marbleTex = track(createMarbleFloorTexture());
    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(70, 70)),
      track(
        new THREE.MeshStandardMaterial({
          map: marbleTex,
          roughness: 0.16,
          metalness: 0.25,
        })
      )
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.6;
    floor.receiveShadow = true;
    scene.add(floor);

    // Hero High-Poly Torus Knot PBR Sculpture
    const knotDetail = Math.round(180 * Math.min(1.6, loadMult));
    const knot = new THREE.Mesh(
      track(new THREE.TorusKnotGeometry(2.15, 0.56, knotDetail, 44)),
      track(
        new THREE.MeshPhysicalMaterial({
          color: "#3B82F6",
          metalness: 0.92,
          roughness: 0.1,
          clearcoat: 1.0,
          clearcoatRoughness: 0.06,
        })
      )
    );
    knot.position.y = 1.2;
    knot.castShadow = true;
    knot.receiveShadow = true;
    scene.add(knot);

    // Floating Inner Crystal Prism
    const crystal = new THREE.Mesh(
      track(new THREE.IcosahedronGeometry(1.15, 1)),
      track(
        new THREE.MeshPhysicalMaterial({
          color: "#E0F2FE",
          metalness: 0.1,
          roughness: 0.05,
          transmission: 0.85,
          ior: 1.52,
          thickness: 1.4,
          clearcoat: 1.0,
        })
      )
    );
    crystal.position.y = 1.2;
    crystal.castShadow = true;
    scene.add(crystal);

    // 10 Orbiting Metallic PBR Sculptures (Gold / Chrome / Copper / Cobalt)
    const palette = ["#FBBF24", "#F8FAFC", "#EA580C", "#38BDF8", "#94A3B8"];
    const orbitSpheres: Array<{ mesh: THREE.Mesh; rad: number; spd: number; phase: number; yBase: number }> = [];
    const sphereGeo = track(new THREE.SphereGeometry(0.62, 32, 32));
    for (let i = 0; i < 10; i++) {
      const mat = track(
        new THREE.MeshPhysicalMaterial({
          color: palette[i % palette.length],
          metalness: 0.94,
          roughness: 0.08 + (i % 3) * 0.05,
          clearcoat: 1.0,
        })
      );
      const m = new THREE.Mesh(sphereGeo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      orbitSpheres.push({
        mesh: m,
        rad: 4.5 + (i % 3) * 1.4,
        spd: 0.55 + (i % 4) * 0.22,
        phase: (i / 10) * Math.PI * 2,
        yBase: -0.6 + (i % 4) * 0.95,
      });
    }

    // 12 Architectural Studio Columns around perimeter
    const colGeo = track(new THREE.CylinderGeometry(0.55, 0.65, 11, 20));
    const colMat = track(new THREE.MeshStandardMaterial({ color: "#1E293B", roughness: 0.35, metalness: 0.65 }));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const col = new THREE.Mesh(colGeo, colMat);
      col.position.set(Math.cos(a) * 14, 2.9, Math.sin(a) * 14);
      col.castShadow = true;
      col.receiveShadow = true;
      scene.add(col);
    }

    // 4 Dynamic Colored Shadow-Casting Point Lights
    const lightDefs = [
      { col: "#FBBF24", rad: 7.2, y: 4.8, spd: 0.9, ph: 0 },
      { col: "#38BDF8", rad: 7.5, y: 4.2, spd: -0.75, ph: 1.6 },
      { col: "#F8FAFC", rad: 8.5, y: 6.4, spd: 0.55, ph: 3.1 },
      { col: "#2563EB", rad: 6.5, y: 2.2, spd: 1.15, ph: 4.7 },
    ];
    const orbGeo = track(new THREE.SphereGeometry(0.24, 16, 16));
    const lights = lightDefs.map((ld, idx) => {
      const pl = new THREE.PointLight(ld.col, 52, 34, 1.4);
      if (idx < 2) {
        pl.castShadow = true;
        pl.shadow.mapSize.set(1024, 1024);
      }
      const bulb = new THREE.Mesh(orbGeo, track(new THREE.MeshBasicMaterial({ color: ld.col })));
      pl.add(bulb);
      scene.add(pl);
      return { pl, ...ld };
    });

    stepFn = (t, _dt, prog, manual, pointer) => {
      knot.rotation.x = t * 0.48;
      knot.rotation.y = t * 0.65;
      crystal.rotation.y = -t * 0.8;
      crystal.rotation.z = t * 0.5;

      for (const s of orbitSpheres) {
        const a = t * s.spd + s.phase;
        s.mesh.position.set(
          Math.cos(a) * s.rad,
          s.yBase + Math.sin(t * 1.5 + s.phase) * 0.7,
          Math.sin(a) * s.rad
        );
      }
      for (const l of lights) {
        const a = t * l.spd + l.ph;
        l.pl.position.set(Math.cos(a) * l.rad, l.y + Math.sin(t * 1.2 + l.ph) * 1.1, Math.sin(a) * l.rad);
      }

      const yaw = t * 0.34 + (manual ? (pointer.x - 0.5) * 4.5 : 0);
      const rad = manual ? 10.5 : 13.5 - prog * 4.2;
      const camY = manual
        ? 0.2 + (1 - pointer.y) * 8.5
        : prog < 0.33
        ? 4.6
        : prog < 0.66
        ? 0.6 + Math.sin(t) * 0.4
        : 3.4;
      camera.position.set(Math.cos(yaw) * rad, camY, Math.sin(yaw) * rad);
      camera.lookAt(0, 1.1, 0);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D PBR Studio",
        metricValue: `${(tris / 1000).toFixed(1)}k tris • 4 dynamic lights • ${calls} calls`,
        actLabel:
          prog < 0.33
            ? "ACT I • Metallic Clearcoat Showcase"
            : prog < 0.66
            ? "ACT II • Low Marble Shadow Glide"
            : "ACT III • Close Crystal Refraction Hero",
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: Math.max(0.85, tris / 40000),
      };
    };
  }

  // =========================================================================
  // SCENE 3: 3D INSTANCED NEON CYBERPUNK MEGACITY FLYTHROUGH
  // =========================================================================
  else if (sceneId === "three_megacity") {
    scene.background = new THREE.Color("#070B18");
    scene.fog = new THREE.FogExp2("#0A1228", 0.0085);
    scene.add(new THREE.HemisphereLight("#38BDF8", "#0F172A", 0.9));

    const moon = new THREE.DirectionalLight("#93C5FD", 1.8);
    moon.position.set(35, 60, -25);
    scene.add(moon);

    // Wet Reflective Central Avenue Ground
    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(360, 360)),
      track(new THREE.MeshStandardMaterial({ color: "#090F1E", roughness: 0.18, metalness: 0.72 }))
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Instanced 3D Skyscrapers with Illuminated Window Texture
    const bldgCount = Math.round(2200 * loadMult);
    const winTex = track(createSkyscraperWindowTexture());
    const bldgGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const bldgMat = track(
      new THREE.MeshStandardMaterial({
        map: winTex,
        emissiveMap: winTex,
        emissive: new THREE.Color("#93C5FD"),
        emissiveIntensity: 0.85,
        roughness: 0.25,
        metalness: 0.65,
      })
    );
    const buildings = new THREE.InstancedMesh(bldgGeo, bldgMat, bldgCount);
    const bData: Array<{ x: number; z: number; w: number; d: number; h: number }> = [];
    const dummy = new THREE.Object3D();
    const spanZ = 240;

    for (let i = 0; i < bldgCount; i++) {
      const r1 = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const f1 = r1 < 0 ? r1 + 1 : r1;
      const r2 = (Math.sin(i * 78.233 + 1.3) * 28461.123) % 1;
      const f2 = r2 < 0 ? r2 + 1 : r2;
      const r3 = (Math.sin(i * 39.425 + 4.7) * 19384.77) % 1;
      const f3 = r3 < 0 ? r3 + 1 : r3;

      const side = i % 2 === 0 ? 1 : -1;
      const x = side * (9.5 + Math.pow(f1, 0.85) * 105);
      const z = (i / bldgCount) * spanZ - 40;
      const w = 2.6 + f1 * 4.2;
      const d = 2.6 + f2 * 4.2;
      const h = 7 + Math.pow(f3, 1.5) * 48 + (Math.abs(x) < 26 ? 10 : 0);
      bData.push({ x, z, w, d, h });
    }
    scene.add(buildings);

    // Instanced Glowing Aerial Flying Traffic Cruisers
    const trafCount = Math.round(320 * loadMult);
    const trafGeo = track(new THREE.BoxGeometry(0.55, 0.24, 2.8));
    const trafMat = track(new THREE.MeshBasicMaterial({ color: "#FFFFFF" }));
    const traffic = new THREE.InstancedMesh(trafGeo, trafMat, trafCount);
    const cTmp = new THREE.Color();
    for (let i = 0; i < trafCount; i++) {
      cTmp.set(i % 2 === 0 ? "#38BDF8" : "#F59E0B");
      traffic.setColorAt(i, cTmp);
    }
    if (traffic.instanceColor) traffic.instanceColor.needsUpdate = true;
    scene.add(traffic);

    // Glowing Overhead Neon Sky-Arches down the boulevard
    const archGeo = track(new THREE.TorusGeometry(10.5, 0.18, 8, 32, Math.PI));
    const archMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));
    const arches: THREE.Mesh[] = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(archGeo, archMat);
      m.position.set(0, 0, i * 24 - 20);
      scene.add(m);
      arches.push(m);
    }

    stepFn = (t, _dt, prog, manual, pointer) => {
      const speed = 22;
      const camZ = t * speed;
      const activeCount = Math.max(800, Math.round(bldgCount * (prog < 0.33 ? 0.5 : prog < 0.66 ? 0.78 : 1.0)));
      buildings.count = activeCount;
      for (let i = 0; i < activeCount; i++) {
        const b = bData[i];
        const wz = (((b.z - camZ) % spanZ) + spanZ) % spanZ - 40;
        dummy.position.set(b.x, b.h * 0.5, -wz);
        dummy.scale.set(b.w, b.h, b.d);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        buildings.setMatrixAt(i, dummy.matrix);
      }
      buildings.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < trafCount; i++) {
        const lane = ((i % 7) - 3) * 2.5;
        const alt = 4.5 + (i % 9) * 3.8;
        const dir = i % 2 === 0 ? 1 : -1;
        const tz = (((i * 17.3 + t * (28 + (i % 5) * 6) * dir) % spanZ) + spanZ) % spanZ - 35;
        dummy.position.set(lane, alt, -tz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        traffic.setMatrixAt(i, dummy.matrix);
      }
      traffic.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < arches.length; i++) {
        const az = (((i * 24 - camZ) % 240) + 240) % 240 - 30;
        arches[i].position.z = -az;
      }

      const act2 = Math.max(0, Math.min(1, (prog - 0.25) * 4));
      const act3 = Math.max(0, Math.min(1, (prog - 0.65) * 4));
      const camX = manual ? (pointer.x - 0.5) * 24 : Math.sin(t * 0.45) * (5.5 - act2 * 3.0);
      const camY = manual ? 5 + (1 - pointer.y) * 32 : 26 - act2 * 17 + act3 * 22;
      camera.position.set(camX, camY, 16);
      camera.lookAt(camX * 0.4, Math.max(3, camY - 3.5), -65);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D Megacity",
        metricValue: `${activeCount.toLocaleString()} towers • ${(tris / 1000).toFixed(1)}k tris • ${calls} calls`,
        actLabel:
          prog < 0.33
            ? "ACT I • Skyline Approach"
            : prog < 0.66
            ? "ACT II • Street-Level Canyon Dive"
            : "ACT III • Full Megacity Stress",
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: Math.max(0.85, activeCount / 2200),
      };
    };
  }

  // =========================================================================
  // SCENE 4: PLAYABLE 3D GAME 1 — 3D SPACE FIGHTER TRENCH COMBAT & BOSS
  // =========================================================================
  else if (sceneId === "three_game_fighter") {
    scene.background = new THREE.Color("#040712");
    scene.fog = new THREE.FogExp2("#040712", 0.011);
    scene.add(new THREE.HemisphereLight("#60A5FA", "#0F172A", 0.9));
    const dirLight = new THREE.DirectionalLight("#FFFFFF", 2.0);
    dirLight.position.set(12, 22, 18);
    scene.add(dirLight);

    // 3D Starfield Points
    const starCount = 1200;
    const starPts = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPts[i * 3] = (Math.random() - 0.5) * 140;
      starPts[i * 3 + 1] = (Math.random() - 0.5) * 90;
      starPts[i * 3 + 2] = -Math.random() * 160;
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPts, 3));
    const stars = new THREE.Points(
      starGeo,
      track(new THREE.PointsMaterial({ color: "#E0F2FE", size: 0.45 }))
    );
    scene.add(stars);

    // 3D Glowing Trench Floor Grid
    const grid = new THREE.GridHelper(180, 45, "#2563EB", "#1E293B");
    grid.position.y = -11;
    scene.add(grid);

    // Player 3D Starfighter Model
    const player = new THREE.Group();
    const hullMat = track(new THREE.MeshStandardMaterial({ color: "#2563EB", metalness: 0.72, roughness: 0.22 }));
    const wingMat = track(new THREE.MeshStandardMaterial({ color: "#E2E8F0", metalness: 0.65, roughness: 0.28 }));
    const fuse = new THREE.Mesh(track(new THREE.ConeGeometry(0.62, 3.4, 8)), hullMat);
    fuse.rotation.x = -Math.PI / 2;
    player.add(fuse);
    const wings = new THREE.Mesh(track(new THREE.BoxGeometry(4.4, 0.14, 1.35)), wingMat);
    wings.position.set(0, -0.08, 0.45);
    player.add(wings);
    const cockpit = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.42, 16, 16)),
      track(new THREE.MeshPhysicalMaterial({ color: "#38BDF8", metalness: 0.3, roughness: 0.08, clearcoat: 1 }))
    );
    cockpit.scale.set(0.85, 0.6, 1.5);
    cockpit.position.set(0, 0.34, -0.15);
    player.add(cockpit);
    const thruster = new THREE.Mesh(
      track(new THREE.ConeGeometry(0.38, 1.4, 10)),
      track(new THREE.MeshBasicMaterial({ color: "#F59E0B" }))
    );
    thruster.rotation.x = Math.PI / 2;
    thruster.position.set(0, 0, 2.2);
    player.add(thruster);
    const shipLight = new THREE.PointLight("#38BDF8", 16, 14);
    shipLight.position.set(0, 0.4, 1.8);
    player.add(shipLight);
    scene.add(player);

    // 3D Dreadnought Boss (enters in Act III!)
    const boss = new THREE.Group();
    const bossHull = new THREE.Mesh(
      track(new THREE.BoxGeometry(11, 2.4, 5.2)),
      track(new THREE.MeshStandardMaterial({ color: "#1E293B", metalness: 0.8, roughness: 0.28 }))
    );
    boss.add(bossHull);
    const bossCore = new THREE.Mesh(
      track(new THREE.SphereGeometry(1.45, 24, 24)),
      track(new THREE.MeshBasicMaterial({ color: "#F97316" }))
    );
    bossCore.position.set(0, 0, 2.5);
    boss.add(bossCore);
    boss.position.set(0, 2.5, -55);
    boss.visible = false;
    scene.add(boss);

    // Dynamic 3D Laser Bolts, Enemies & Explosions
    const laserGeo = track(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 6));
    laserGeo.rotateX(Math.PI / 2);
    const friendlyLaserMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));
    const enemyLaserMat = track(new THREE.MeshBasicMaterial({ color: "#F97316" }));
    const enemyGeo = track(new THREE.OctahedronGeometry(1.1, 0));
    const enemyMat = track(new THREE.MeshStandardMaterial({ color: "#EA580C", metalness: 0.7, roughness: 0.25 }));
    const sparkGeo = track(new THREE.BoxGeometry(0.28, 0.28, 0.28));
    const sparkMat = track(new THREE.MeshBasicMaterial({ color: "#FBBF24" }));

    const lasers: Array<{ mesh: THREE.Mesh; vx: number; vy: number; vz: number; friendly: boolean }> = [];
    const enemies: Array<{ mesh: THREE.Mesh; vx: number; vy: number; vz: number; hp: number }> = [];
    const sparks: Array<{ mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }> = [];

    let shipX = 0;
    let shipY = 0;
    let fireCd = 0;
    let kills = 0;
    let score = 0;
    let bossHp = 45;

    const spawnExplosion = (pos: THREE.Vector3, count: number) => {
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(sparkGeo, sparkMat);
        m.position.copy(pos);
        scene.add(m);
        sparks.push({
          mesh: m,
          vx: (Math.random() - 0.5) * 26,
          vy: (Math.random() - 0.5) * 26,
          vz: (Math.random() - 0.5) * 26,
          life: 0.75 + Math.random() * 0.4,
        });
      }
    };

    stepFn = (t, dt, prog, manual, pointer, keys) => {
      const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;
      grid.position.z = (t * 28) % 8;

      // Stream starfield toward camera
      const sp = starGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < starCount; i++) {
        let sz = sp.getZ(i) + 62 * dt;
        if (sz > 18) sz = -145;
        sp.setZ(i, sz);
      }
      sp.needsUpdate = true;

      // Player 3D flight controls vs Auto-AI Ace Pilot
      const prevX = shipX;
      const prevY = shipY;
      if (manual) {
        const moveSpd = 22 * dt;
        if (keys.has("a") || keys.has("arrowleft")) shipX -= moveSpd;
        if (keys.has("d") || keys.has("arrowright")) shipX += moveSpd;
        if (keys.has("w") || keys.has("arrowup")) shipY += moveSpd;
        if (keys.has("s") || keys.has("arrowdown")) shipY -= moveSpd;
        if (pointer.down || (keys.size === 0 && (pointer.x !== 0.5 || pointer.y !== 0.5))) {
          shipX += ((pointer.x - 0.5) * 24 - shipX) * 0.18;
          shipY += ((0.5 - pointer.y) * 14 - shipY) * 0.18;
        }
      } else {
        const aimX =
          actIdx === 3 && boss.visible
            ? boss.position.x + Math.sin(t * 2.4) * 4.5
            : Math.sin(t * 1.8) * 9.5;
        const aimY = Math.cos(t * 2.1) * 4.2;
        shipX += (aimX - shipX) * 0.12;
        shipY += (aimY - shipY) * 0.12;
      }
      shipX = Math.max(-13, Math.min(13, shipX));
      shipY = Math.max(-6.5, Math.min(7.5, shipY));

      player.position.set(shipX, shipY, 0);
      player.rotation.z = THREE.MathUtils.clamp(-(shipX - prevX) * 2.6, -0.75, 0.75);
      player.rotation.x = THREE.MathUtils.clamp((shipY - prevY) * 1.8, -0.45, 0.45);
      thruster.scale.set(1, 0.8 + Math.random() * 0.55, 1);

      // Fire Twin / Triple 3D Laser Cannons
      fireCd -= dt;
      const overdrive = manual && (pointer.clicked || keys.has(" "));
      if (fireCd <= 0 || overdrive) {
        if (overdrive) pointer.clicked = false;
        fireCd = overdrive ? 0.08 : 0.1;
        const offsets = overdrive || actIdx >= 2 ? [-1.45, 0, 1.45] : [-1.45, 1.45];
        for (const ox of offsets) {
          const m = new THREE.Mesh(laserGeo, friendlyLaserMat);
          m.position.set(shipX + ox, shipY - 0.1, -1.6);
          scene.add(m);
          lasers.push({ mesh: m, vx: ox * 1.4, vy: 0, vz: -95, friendly: true });
        }
      }

      // Boss in Act III
      boss.visible = actIdx === 3;
      if (boss.visible) {
        boss.position.x = Math.sin(t * 1.1) * 9.5;
        boss.position.z += (-34 - boss.position.z) * 0.06;
        bossCore.scale.setScalar(1 + Math.sin(t * 9) * 0.12);
        if (Math.random() < 0.12 && lasers.length < 180) {
          const m = new THREE.Mesh(laserGeo, enemyLaserMat);
          m.position.copy(boss.position).add(new THREE.Vector3((Math.random() - 0.5) * 8, 0, 3));
          scene.add(m);
          lasers.push({ mesh: m, vx: (shipX - m.position.x) * 0.7, vy: (shipY - m.position.y) * 0.7, vz: 44, friendly: false });
        }
      }

      // Spawn 3D Enemy Squadrons
      const maxEn = Math.round((actIdx === 1 ? 8 : 14) * loadMult);
      if (enemies.length < maxEn && Math.random() < 0.18) {
        const m = new THREE.Mesh(enemyGeo, enemyMat);
        m.position.set((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 12, -95);
        scene.add(m);
        enemies.push({ mesh: m, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 3, vz: 28 + Math.random() * 14, hp: 2 });
      }

      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        e.mesh.position.x += e.vx * dt;
        e.mesh.position.y += e.vy * dt;
        e.mesh.position.z += e.vz * dt;
        e.mesh.rotation.y += 2.2 * dt;
        if (e.mesh.position.z > 14) {
          scene.remove(e.mesh);
          enemies.splice(i, 1);
        }
      }

      for (let i = lasers.length - 1; i >= 0; i--) {
        const l = lasers[i];
        l.mesh.position.x += l.vx * dt;
        l.mesh.position.y += l.vy * dt;
        l.mesh.position.z += l.vz * dt;
        let hit = false;
        if (l.friendly) {
          if (boss.visible && l.mesh.position.distanceTo(boss.position) < 6.2) {
            hit = true;
            bossHp -= 1;
            score += 75;
            spawnExplosion(l.mesh.position, 4);
            if (bossHp <= 0) {
              kills += 1;
              score += 5000;
              spawnExplosion(boss.position, 32);
              bossHp = 55;
            }
          }
          if (!hit) {
            for (let j = enemies.length - 1; j >= 0; j--) {
              if (l.mesh.position.distanceTo(enemies[j].mesh.position) < 2.2) {
                hit = true;
                enemies[j].hp -= 1;
                if (enemies[j].hp <= 0) {
                  kills += 1;
                  score += 250;
                  spawnExplosion(enemies[j].mesh.position, 10);
                  scene.remove(enemies[j].mesh);
                  enemies.splice(j, 1);
                }
                break;
              }
            }
          }
        }
        if (hit || l.mesh.position.z < -125 || l.mesh.position.z > 20) {
          scene.remove(l.mesh);
          lasers.splice(i, 1);
        }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        s.life -= dt;
        s.mesh.scale.setScalar(Math.max(0.01, s.life));
        if (s.life <= 0) {
          scene.remove(s.mesh);
          sparks.splice(i, 1);
        }
      }

      camera.position.set(shipX * 0.42, shipY * 0.38 + 3.4, 11.5);
      camera.lookAt(shipX * 0.7, shipY * 0.6, -24);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D Space Fighter",
        metricValue: `${score.toLocaleString()} pts • ${kills} kills • ${(tris / 1000).toFixed(1)}k tris`,
        actLabel:
          actIdx === 1
            ? "ACT I • Trench Scout Squadron"
            : actIdx === 2
            ? "ACT II • Heavy Interceptor Wave"
            : `ACT III • 3D Dreadnought Boss (HP ${bossHp})`,
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: 1.05,
      };
    };
  }

  // =========================================================================
  // SCENE 5: PLAYABLE 3D GAME 2 — 3D NEON HIGHWAY TURBO RACER
  // =========================================================================
  else if (sceneId === "three_game_racer") {
    scene.background = new THREE.Color("#070A18");
    scene.fog = new THREE.FogExp2("#0B132B", 0.0082);
    scene.add(new THREE.HemisphereLight("#60A5FA", "#1E293B", 1.1));
    const sunL = new THREE.DirectionalLight("#FBBF24", 1.6);
    sunL.position.set(0, 22, -80);
    scene.add(sunL);

    // Synthwave Horizon Sun Orb
    const horizonSun = new THREE.Mesh(
      track(new THREE.SphereGeometry(18, 28, 28)),
      track(new THREE.MeshBasicMaterial({ color: "#F59E0B" }))
    );
    horizonSun.position.set(0, 18, -190);
    scene.add(horizonSun);

    // Scrolling Illuminated Neon Highway
    const roadTex = track(createHighwayTexture());
    const road = new THREE.Mesh(
      track(new THREE.PlaneGeometry(18, 260)),
      track(new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.25, metalness: 0.4 }))
    );
    road.rotation.x = -Math.PI / 2;
    road.position.z = -95;
    scene.add(road);

    // Roadside Neon Light Pylons
    const pylonGeo = track(new THREE.BoxGeometry(0.35, 6.5, 0.35));
    const pylonMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));
    const pylons: THREE.Mesh[] = [];
    for (let i = 0; i < 28; i++) {
      const side = i % 2 === 0 ? -10.2 : 10.2;
      const m = new THREE.Mesh(pylonGeo, pylonMat);
      m.position.set(side, 3.25, -Math.floor(i / 2) * 18);
      scene.add(m);
      pylons.push(m);
    }

    // Player 3D Futuristic Sports Car
    const car = new THREE.Group();
    const body = new THREE.Mesh(
      track(new THREE.BoxGeometry(2.1, 0.65, 4.4)),
      track(new THREE.MeshPhysicalMaterial({ color: "#2563EB", metalness: 0.85, roughness: 0.14, clearcoat: 1.0 }))
    );
    body.position.y = 0.58;
    car.add(body);
    const cabin = new THREE.Mesh(
      track(new THREE.BoxGeometry(1.65, 0.52, 2.0)),
      track(new THREE.MeshPhysicalMaterial({ color: "#0F172A", metalness: 0.4, roughness: 0.08, clearcoat: 1 }))
    );
    cabin.position.set(0, 1.05, 0.15);
    car.add(cabin);
    const tail = new THREE.Mesh(
      track(new THREE.BoxGeometry(1.9, 0.16, 0.1)),
      track(new THREE.MeshBasicMaterial({ color: "#F97316" }))
    );
    tail.position.set(0, 0.72, 2.22);
    car.add(tail);
    const nitroJet = new THREE.Mesh(
      track(new THREE.ConeGeometry(0.42, 2.2, 10)),
      track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }))
    );
    nitroJet.rotation.x = Math.PI / 2;
    nitroJet.position.set(0, 0.48, 3.2);
    car.add(nitroJet);
    const underglow = new THREE.PointLight("#38BDF8", 18, 12);
    underglow.position.set(0, 0.4, 0.4);
    car.add(underglow);
    scene.add(car);

    // 3D Traffic Cars & Cyan Boost Pads
    const trafGeo = track(new THREE.BoxGeometry(2.0, 0.95, 4.1));
    const trafMats = [
      track(new THREE.MeshStandardMaterial({ color: "#F59E0B", metalness: 0.7, roughness: 0.25 })),
      track(new THREE.MeshStandardMaterial({ color: "#E2E8F0", metalness: 0.75, roughness: 0.2 })),
      track(new THREE.MeshStandardMaterial({ color: "#10B981", metalness: 0.7, roughness: 0.25 })),
    ];
    const trafficCars: Array<{ mesh: THREE.Mesh; laneX: number; speed: number; passed: boolean }> = [];
    const lanes = [-6.2, -2.1, 2.1, 6.2];
    const trafNum = Math.round(10 * loadMult);
    for (let i = 0; i < trafNum; i++) {
      const lx = lanes[i % lanes.length];
      const m = new THREE.Mesh(trafGeo, trafMats[i % trafMats.length]);
      m.position.set(lx, 0.52, -32 - i * 22);
      scene.add(m);
      trafficCars.push({ mesh: m, laneX: lx, speed: 24 + (i % 4) * 5, passed: false });
    }

    let carX = 0;
    let speedKmh = 210;
    let nearMisses = 0;
    let raceScore = 0;

    stepFn = (_t, dt, prog, manual, pointer, keys) => {
      const nitro = manual ? keys.has("w") || keys.has(" ") || pointer.down : prog > 0.55;
      const targetSpd = nitro ? 360 : 215 + prog * 70;
      speedKmh += (targetSpd - speedKmh) * 0.08;
      const worldSpd = speedKmh * 0.28;

      roadTex.offset.y += worldSpd * dt * 0.085;
      for (const py of pylons) {
        py.position.z += worldSpd * dt;
        if (py.position.z > 14) py.position.z -= 252;
      }

      const prevX = carX;
      if (manual) {
        const steer = 16 * dt;
        if (keys.has("a") || keys.has("arrowleft")) carX -= steer;
        if (keys.has("d") || keys.has("arrowright")) carX += steer;
        if (keys.size === 0 && pointer.x !== 0.5) {
          carX += ((pointer.x - 0.5) * 15.5 - carX) * 0.16;
        }
      } else {
        // Smart Auto-AI lane weaving around nearest traffic car
        let safestLane = 0;
        let bestClear = -1;
        for (const lx of lanes) {
          let minD = 999;
          for (const tc of trafficCars) {
            if (Math.abs(tc.mesh.position.x - lx) < 2.2 && tc.mesh.position.z < 5 && tc.mesh.position.z > -65) {
              minD = Math.min(minD, Math.abs(tc.mesh.position.z));
            }
          }
          if (minD > bestClear) {
            bestClear = minD;
            safestLane = lx;
          }
        }
        carX += (safestLane - carX) * 0.11;
      }
      carX = Math.max(-7.3, Math.min(7.3, carX));
      car.position.set(carX, 0, 0);
      car.rotation.z = THREE.MathUtils.clamp(-(carX - prevX) * 1.4, -0.25, 0.25);
      car.rotation.y = THREE.MathUtils.clamp(-(carX - prevX) * 0.7, -0.2, 0.2);
      nitroJet.visible = nitro;
      nitroJet.scale.set(1, 0.8 + Math.random() * 0.6, 1);

      for (const tc of trafficCars) {
        tc.mesh.position.z += (worldSpd - tc.speed) * dt;
        if (!tc.passed && tc.mesh.position.z > 2.5) {
          tc.passed = true;
          nearMisses += 1;
          raceScore += nitro ? 350 : 180;
        }
        if (tc.mesh.position.z > 20) {
          tc.mesh.position.z = -180 - Math.random() * 60;
          tc.mesh.position.x = lanes[Math.floor(Math.random() * lanes.length)];
          tc.passed = false;
        }
      }
      raceScore += Math.round(speedKmh * dt * 0.6);

      // Dynamic FOV speed kick during Nitro Boost!
      const targetFov = nitro ? 76 : 60;
      camera.fov += (targetFov - camera.fov) * 0.08;
      camera.updateProjectionMatrix();
      camera.position.set(carX * 0.62, 3.55, 8.8);
      camera.lookAt(carX * 0.85, 1.1, -34);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D Turbo Racer",
        metricValue: `${Math.round(speedKmh)} km/h • ${nearMisses} passes • ${raceScore.toLocaleString()} pts`,
        actLabel: nitro
          ? "NITRO OVERDRIVE • 360 KM/H TURBO"
          : prog < 0.5
          ? "ACT I • Neon Highway Warmup"
          : "ACT II • High-Speed Traffic Weave",
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: 1.05,
      };
    };
  }

  // =========================================================================
  // SCENE 6: PLAYABLE 3D GAME 3 — 3D PHYSICS TOWER DESTRUCTION CANNON
  // =========================================================================
  else {
    scene.background = new THREE.Color("#9CC8F0");
    scene.fog = new THREE.FogExp2("#A6CEF0", 0.0065);
    scene.add(new THREE.HemisphereLight("#E0F2FE", "#334155", 0.9));

    const sun = new THREE.DirectionalLight("#FFF8E7", 2.5);
    sun.position.set(24, 38, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 34;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    scene.add(sun);

    const floorTex = track(createMarbleFloorTexture());
    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(140, 140)),
      track(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.72, metalness: 0.1 }))
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const blockGeo = track(new THREE.BoxGeometry(1.4, 1.0, 1.4));
    const blockMats = [
      track(new THREE.MeshStandardMaterial({ color: "#E2E8F0", roughness: 0.45, metalness: 0.15 })),
      track(new THREE.MeshStandardMaterial({ color: "#2563EB", roughness: 0.3, metalness: 0.55 })),
      track(new THREE.MeshStandardMaterial({ color: "#F59E0B", roughness: 0.35, metalness: 0.4 })),
      track(new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.55, metalness: 0.3 })),
    ];
    const ballGeo = track(new THREE.SphereGeometry(0.92, 20, 20));
    const ballMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#F97316",
        emissive: "#EA580C",
        emissiveIntensity: 0.65,
        metalness: 0.85,
        roughness: 0.15,
      })
    );

    interface RigidBlock {
      mesh: THREE.Mesh;
      vx: number;
      vy: number;
      vz: number;
      rx: number;
      ry: number;
      rz: number;
      awake: boolean;
      toppled: boolean;
    }

    const blocks: RigidBlock[] = [];
    const balls: Array<{ mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }> = [];
    let towersSmashed = 0;
    let blocksToppled = 0;
    let autoFireCd = 0.65;

    const buildMegaTower = () => {
      for (const b of blocks) scene.remove(b.mesh);
      blocks.length = 0;
      const stories = Math.min(11, Math.round(7 * Math.max(0.85, loadMult)));
      // Build 3 dramatic multi-story sunlit towers side by side!
      for (const towerX of [-6.5, 0, 6.5]) {
        const towerH = towerX === 0 ? stories + 2 : stories;
        for (let y = 0; y < towerH; y++) {
          for (let gx = -1; gx <= 1; gx++) {
            for (let gz = -1; gz <= 1; gz++) {
              if (gx === 0 && gz === 0 && y < towerH - 1) continue; // Hollow architectural interior
              const mat = blockMats[(y + Math.abs(gx + gz)) % blockMats.length];
              const m = new THREE.Mesh(blockGeo, mat);
              m.position.set(towerX + gx * 1.48, 0.5 + y * 1.02, -4 + gz * 1.48);
              m.castShadow = true;
              m.receiveShadow = true;
              scene.add(m);
              blocks.push({ mesh: m, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, awake: false, toppled: false });
            }
          }
        }
      }
    };
    buildMegaTower();

    const fireCannon = (targetX: number, targetY: number) => {
      const m = new THREE.Mesh(ballGeo, ballMat);
      m.position.set(0, 5.5, 22);
      m.castShadow = true;
      scene.add(m);
      const dir = new THREE.Vector3(targetX, targetY, -4).sub(m.position).normalize();
      balls.push({ mesh: m, vx: dir.x * 58, vy: dir.y * 58 + 4.5, vz: dir.z * 58, life: 4.5 });
    };

    stepFn = (t, dt, prog, manual, pointer, keys) => {
      if (keys.has("r")) {
        buildMegaTower();
        keys.delete("r");
      }

      // Auto-Cannon Siege vs Manual Mouse Aim + Click Fire
      if (manual) {
        if (pointer.clicked || keys.has(" ")) {
          pointer.clicked = false;
          fireCannon((pointer.x - 0.5) * 24, 1.5 + (1 - pointer.y) * 14);
        }
      } else {
        autoFireCd -= dt;
        if (autoFireCd <= 0) {
          autoFireCd = 0.72;
          fireCannon(Math.sin(t * 1.7) * 8.5, 2.5 + ((Math.floor(t * 2) % 4) * 2.1));
        }
      }

      // Update flying cannonballs & explosive block blasts
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];
        b.vy -= 26 * dt;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;
        if (b.mesh.position.y < 0.92) {
          b.mesh.position.y = 0.92;
          b.vy = Math.abs(b.vy) * 0.55;
          b.vx *= 0.85;
          b.vz *= 0.85;
        }
        for (const blk of blocks) {
          const dist = blk.mesh.position.distanceTo(b.mesh.position);
          if (dist < 4.6) {
            const push = blk.mesh.position.clone().sub(b.mesh.position).normalize();
            const strength = (4.6 - dist) * 6.4;
            blk.vx += push.x * strength + b.vx * 0.22;
            blk.vy += Math.abs(push.y) * strength + 4.2;
            blk.vz += push.z * strength + b.vz * 0.22;
            blk.rx += (Math.random() - 0.5) * 7;
            blk.ry += (Math.random() - 0.5) * 7;
            blk.rz += (Math.random() - 0.5) * 7;
            blk.awake = true;
          }
        }
        b.life -= dt;
        if (b.life <= 0) {
          scene.remove(b.mesh);
          balls.splice(i, 1);
        }
      }

      // Update rigid blocks with 3D gravity, bounce & topple chain reaction
      let activeAwake = 0;
      for (const blk of blocks) {
        if (!blk.awake) continue;
        activeAwake++;
        blk.vy -= 28 * dt;
        blk.mesh.position.x += blk.vx * dt;
        blk.mesh.position.y += blk.vy * dt;
        blk.mesh.position.z += blk.vz * dt;
        blk.mesh.rotation.x += blk.rx * dt;
        blk.mesh.rotation.y += blk.ry * dt;
        blk.mesh.rotation.z += blk.rz * dt;
        if (blk.mesh.position.y < 0.5) {
          blk.mesh.position.y = 0.5;
          blk.vy = Math.abs(blk.vy) * 0.36;
          blk.vx *= 0.84;
          blk.vz *= 0.84;
          blk.rx *= 0.8;
          blk.ry *= 0.8;
          blk.rz *= 0.8;
        }
        if (!blk.toppled && (Math.abs(blk.mesh.rotation.x) > 0.4 || blk.mesh.position.y < 1.2)) {
          blk.toppled = true;
          blocksToppled += 1;
        }
      }

      // Auto-rebuild fresh mega-towers once >72% smashed!
      if (blocks.length > 0 && activeAwake > blocks.length * 0.72 && Math.sin(t * 0.9) > 0.92) {
        towersSmashed += 1;
        buildMegaTower();
      }

      const camAng = manual ? (pointer.x - 0.5) * 0.55 : Math.sin(t * 0.32) * 0.42;
      camera.position.set(Math.sin(camAng) * 26, 10.5, Math.cos(camAng) * 26);
      camera.lookAt(0, 5.2, -4);

      renderer.render(scene, camera);
      const tris = renderer.info.render.triangles;
      const calls = renderer.info.render.calls;
      return {
        metricLabel: "3D Physics Cannon",
        metricValue: `${blocksToppled} blocks smashed • ${blocks.length} rigid bodies • ${calls} calls`,
        actLabel:
          prog < 0.33
            ? "ACT I • Tower Bombardment"
            : prog < 0.66
            ? "ACT II • Chain-Reaction Collapse"
            : `ACT III • Full Siege (${towersSmashed + 1} towers)`,
        triangles: tris,
        drawCalls: calls,
        throughputScoreFactor: Math.max(0.9, blocks.length / 180),
      };
    };
  }

  return {
    rendererName,
    step: stepFn,
    resize: (w: number, h: number) => {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    },
    dispose: () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Safe cleanup
        }
      }
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        // Safe cleanup on mock/headless GL
      }
    },
  };
}
