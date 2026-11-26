// LaptopBench QC v3.5.0 — AAA Three.js 3D Game & PBR Rendering Engine
// Upgrades in v3.5.0:
//   • Real HDRI Image-Based Lighting via PMREMGenerator + RoomEnvironment
//   • Real AAA Post-Processing: EffectComposer + RenderPass + UnrealBloomPass + OutputPass
//   • High-res Procedural Tangent-Space PBR Normal / Roughness / Emissive texture suites
//   • Genuine @dimforge/rapier3d-compat WASM Rigid-Body Physics in 3D Cannon Fortress Siege
//   • Sculpted multi-part 3D Starfighter & Cyber-Supercar + Ultra 2x SSAA Supersampling

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type RAPIER_TYPE from "@dimforge/rapier3d-compat";
import type { PointerInput } from "./engines2d";
import {
  createCarbonFiberPbr,
  createFortressBlockPbr,
  createOceanNormalMap,
  createSkyscraperFacadePbr,
  createStudioMarblePbr,
  createWetNeonAsphaltPbr,
} from "./pbrTextures";

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

// Lazy singleton Rapier3D WASM loader — dynamically imported ONLY when Scene 6 (3D Cannon) launches!
// Keeps Stage 13 (GpuStressView) and non-physics scenes instantaneous with zero 4.3 MB upfront parse cost.
let rapierMod: typeof RAPIER_TYPE | null = null;
let rapierInitPromise: Promise<typeof RAPIER_TYPE | null> | null = null;
function ensureRapierInit(): Promise<typeof RAPIER_TYPE | null> {
  if (rapierMod) return Promise.resolve(rapierMod);
  if (!rapierInitPromise) {
    rapierInitPromise = import("@dimforge/rapier3d-compat")
      .then(async (m) => {
        const mod = (m.default ?? m) as typeof RAPIER_TYPE;
        await mod.init();
        rapierMod = mod;
        return mod;
      })
      .catch(() => {
        rapierInitPromise = null;
        return null;
      });
  }
  return rapierInitPromise;
}

function terrainHeightFn(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  const islandMask = Math.max(0, 1 - Math.pow(r / 68, 2.2));
  const h1 = Math.sin(x * 0.08) * Math.cos(z * 0.08) * 6.8;
  const h2 = Math.sin(x * 0.19 + 1.3) * Math.sin(z * 0.17 - 0.8) * 3.3;
  const h3 = Math.cos((x + z) * 0.34) * 1.15;
  const peak = Math.exp(-((x * x + z * z) / 500)) * 12.2;
  return (h1 + h2 + h3 + peak + 4.4) * islandMask - 2.6;
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

  let rendererName = "Three.js WebGL2 AAA";
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

  // Detect CPU-emulated software WebGL drivers (SwiftShader / Microsoft Basic Render Driver)
  // so real hardware GPUs run the full AAA Bloom + HDRI + 2x SSAA pipeline while broken/driverless
  // systems stay responsive instead of freezing on multi-pass post-processing.
  const isSoftwareRenderer = /SwiftShader|llvmpipe|Software|Basic Render Driver/i.test(rendererName);

  // Ultra 2x SSAA Supersampling on Ultra tier so high-end RTX dGPUs actually get loaded
  const nativeDpr = window.devicePixelRatio || 1;
  const dpr = isSoftwareRenderer
    ? 0.75
    : loadMult > 1.5
    ? Math.min(2.5, nativeDpr * 1.5)
    : Math.min(nativeDpr, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = !isSoftwareRenderer;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / Math.max(1, height), 0.2, 460);

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(obj: T): T => {
    disposables.push(obj);
    return obj;
  };

  // Real HDRI IBL Environment on hardware GPUs (makes chrome, titanium, gold, glass & wet asphalt gleam!)
  if (!isSoftwareRenderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envRT = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = sceneId === "three_studio" ? 1.35 : 0.85;
    roomEnv.dispose();
    pmrem.dispose();
    track(envRT);
  } else {
    scene.add(new THREE.HemisphereLight("#E2E8F0", "#1E293B", 1.1));
  }

  // Real AAA Post-Processing Pipeline (RenderPass -> UnrealBloomPass -> OutputPass) on hardware GPUs
  const bloomStrength =
    sceneId === "three_megacity"
      ? 0.85
      : sceneId === "three_game_racer" || sceneId === "three_game_fighter"
      ? 0.72
      : sceneId === "three_studio"
      ? 0.52
      : 0.36;
  const realComposer = isSoftwareRenderer ? null : new EffectComposer(renderer);
  const bloomPass = isSoftwareRenderer
    ? { setSize: (_w: number, _h: number) => {}, dispose: () => {} }
    : new UnrealBloomPass(new THREE.Vector2(width, height), bloomStrength, 0.55, 0.72);
  if (realComposer) {
    realComposer.setPixelRatio(dpr);
    realComposer.setSize(width, height);
    realComposer.addPass(new RenderPass(scene, camera));
    realComposer.addPass(bloomPass as UnrealBloomPass);
    realComposer.addPass(new OutputPass());
  }
  const composer = {
    render: () => {
      if (realComposer) realComposer.render();
      else renderer.render(scene, camera);
    },
    setSize: (w: number, h: number) => {
      if (realComposer) realComposer.setSize(w, h);
    },
    dispose: () => {
      if (realComposer) realComposer.dispose();
    },
  };

  let extraCleanup: (() => void) | null = null;
  let stepFn: (
    t: number,
    dt: number,
    prog: number,
    manual: boolean,
    pointer: PointerInput,
    keys: Set<string>
  ) => ThreeFrameMetrics;

  // =========================================================================
  // SCENE 1: 3D SUNLIT ISLAND, TERRAIN & OCEAN NORMAL-MAP SHADOWS
  // =========================================================================
  if (sceneId === "three_island") {
    scene.background = new THREE.Color("#6AAEEB");
    scene.fog = new THREE.FogExp2("#8CC0ED", 0.0076);

    const hemi = new THREE.HemisphereLight("#C6E8FF", "#1E3A5F", 0.9);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight("#FFF4D4", 3.1);
    sun.position.set(44, 48, 28);
    sun.castShadow = true;
    const shadowRes = loadMult > 1.2 ? 2048 : 1024;
    sun.shadow.mapSize.set(shadowRes, shadowRes);
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 175;
    const d = 62;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0004;
    scene.add(sun);

    const sunOrb = new THREE.Mesh(
      track(new THREE.SphereGeometry(4.6, 24, 24)),
      track(new THREE.MeshBasicMaterial({ color: "#FFF8D6" }))
    );
    scene.add(sunOrb);

    const segs = Math.round(112 * Math.min(1.65, Math.max(0.85, loadMult)));
    const terrGeo = track(new THREE.PlaneGeometry(165, 165, segs, segs));
    terrGeo.rotateX(-Math.PI / 2);
    const posAttr = terrGeo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(posAttr.count * 3);
    const colTmp = new THREE.Color();

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const h = terrainHeightFn(x, z);
      posAttr.setY(i, h);
      if (h < 0.25) colTmp.set("#DFC493");
      else if (h < 4.5) colTmp.set("#2E6D3B");
      else if (h < 9.5) colTmp.set("#5B636E");
      else colTmp.set("#F4F8FC");
      colors[i * 3] = colTmp.r;
      colors[i * 3 + 1] = colTmp.g;
      colors[i * 3 + 2] = colTmp.b;
    }
    terrGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    terrGeo.computeVertexNormals();

    const terrMesh = new THREE.Mesh(
      terrGeo,
      track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.05 }))
    );
    terrMesh.receiveShadow = true;
    terrMesh.castShadow = true;
    scene.add(terrMesh);

    // Sparkling PBR Ocean with Tileable Scrolling Tangent-Space Wave Normal Map!
    const oceanNorm = track(createOceanNormalMap(18, 18));
    const oceanGeo = track(new THREE.PlaneGeometry(440, 440, 84, 84));
    oceanGeo.rotateX(-Math.PI / 2);
    const oceanMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#095488",
        roughness: 0.14,
        metalness: 0.28,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        normalMap: oceanNorm,
        normalScale: new THREE.Vector2(0.75, 0.75),
      })
    );
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.position.y = -0.18;
    ocean.receiveShadow = true;
    scene.add(ocean);

    // Instanced Alpine Pines (up to 900 shadow-casting conifers)
    const treeCount = Math.round(480 * Math.max(0.85, loadMult));
    const trunkGeo = track(new THREE.CylinderGeometry(0.16, 0.26, 1.5, 7));
    const foliageGeo = track(new THREE.ConeGeometry(1.18, 3.6, 8));
    const trunks = new THREE.InstancedMesh(
      trunkGeo,
      track(new THREE.MeshStandardMaterial({ color: "#4E3422", roughness: 0.94 })),
      treeCount
    );
    const foliage = new THREE.InstancedMesh(
      foliageGeo,
      track(new THREE.MeshStandardMaterial({ color: "#195232", roughness: 0.82 })),
      treeCount
    );
    trunks.castShadow = true;
    foliage.castShadow = true;
    foliage.receiveShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    for (let i = 0; i < treeCount * 5 && placed < treeCount; i++) {
      const ang = i * 2.39996;
      const rad = 7 + ((i * 37) % 45);
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const h = terrainHeightFn(x, z);
      if (h > 0.6 && h < 7.2) {
        const sc = 0.72 + ((i * 19) % 10) * 0.075;
        dummy.position.set(x, h + 0.65 * sc, z);
        dummy.rotation.set(0, ang, 0);
        dummy.scale.setScalar(sc);
        dummy.updateMatrix();
        trunks.setMatrixAt(placed, dummy.matrix);
        dummy.position.set(x, h + 2.4 * sc, z);
        dummy.updateMatrix();
        foliage.setMatrixAt(placed, dummy.matrix);
        placed++;
      }
    }
    trunks.count = placed;
    foliage.count = placed;
    scene.add(trunks);
    scene.add(foliage);

    // Volumetric High-Altitude Clouds + Coastal Beacon Lighthouse
    const cloudMat = track(
      new THREE.MeshStandardMaterial({ color: "#F8FAFC", roughness: 0.95, transparent: true, opacity: 0.88 })
    );
    const cloudGeo = track(new THREE.DodecahedronGeometry(3.5, 1));
    const clouds: THREE.Group[] = [];
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Group();
      for (let p = 0; p < 3; p++) {
        const m = new THREE.Mesh(cloudGeo, cloudMat);
        m.position.set((p - 1) * 3.1, (p % 2) * 0.7, (p - 1) * 0.9);
        m.scale.set(1.25, 0.56, 0.95);
        g.add(m);
      }
      g.position.set(Math.cos(i * 0.85) * 62, 23 + (i % 4) * 2.8, Math.sin(i * 0.85) * 62);
      scene.add(g);
      clouds.push(g);
    }

    const oceanPos = oceanGeo.attributes.position as THREE.BufferAttribute;

    stepFn = (t, dt, prog, manual, pointer) => {
      const actIdx = prog < 0.34 ? 1 : prog < 0.68 ? 2 : 3;
      const actLabel =
        actIdx === 1
          ? "ACT I • Sunrise Coast Orbit"
          : actIdx === 2
          ? "ACT II • Summit Shadow Pass"
          : "ACT III • Golden-Hour Horizon";

      const sunAng = 0.28 + prog * 1.15;
      sun.position.set(Math.cos(sunAng) * 68, 22 + Math.sin(sunAng) * 44, Math.sin(sunAng) * 52);
      sunOrb.position.copy(sun.position).multiplyScalar(1.9);
      const warmMix = Math.max(0, (prog - 0.52) / 0.48);
      sun.color.setRGB(1.0, 0.96 - warmMix * 0.28, 0.86 - warmMix * 0.45);
      (scene.background as THREE.Color).setRGB(0.42 + warmMix * 0.28, 0.68 - warmMix * 0.24, 0.92 - warmMix * 0.38);
      (scene.fog as THREE.FogExp2).color.copy(scene.background as THREE.Color);

      // Scroll sparkling ocean normal map + gentle vertex swell
      oceanNorm.offset.x += dt * 0.045;
      oceanNorm.offset.y += dt * 0.028;
      for (let i = 0; i < oceanPos.count; i++) {
        const ox = oceanPos.getX(i);
        const oz = oceanPos.getZ(i);
        oceanPos.setY(i, Math.sin(ox * 0.075 + t * 1.65) * 0.36 + Math.cos(oz * 0.085 - t * 1.35) * 0.30);
      }
      oceanPos.needsUpdate = true;

      for (const c of clouds) c.position.x = ((c.position.x + dt * 1.8 + 115) % 230) - 115;

      const orbitAng = manual ? (pointer.x - 0.5) * Math.PI * 2.2 : t * 0.24;
      const alt = manual ? 10 + (1 - pointer.y) * 28 : 13 + Math.sin(t * 0.35) * 5.5 + (actIdx === 2 ? 7 : 0);
      const radius = actIdx === 2 ? 32 : 48;
      camera.position.set(Math.cos(orbitAng) * radius, alt, Math.sin(orbitAng) * radius);
      camera.lookAt(0, 4.5, 0);

      composer.render();
      const tris = renderer.info.render.triangles;
      return {
        metricLabel: "3D HDRI+PBR Tris",
        metricValue: `${(tris / 1000).toFixed(1)}K tris • ${placed} pines • ${shadowRes}px Shadow`,
        actLabel,
        triangles: tris,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.25,
      };
    };
  }

  // =========================================================================
  // SCENE 2: 3D PBR METALLIC, REFRACTIVE GLASS & HDRI BLOOM STUDIO
  // =========================================================================
  else if (sceneId === "three_studio") {
    scene.background = new THREE.Color("#070A12");
    scene.fog = new THREE.FogExp2("#070A12", 0.02);

    const marblePbr = track(createStudioMarblePbr(7, 7));
    const carbonPbr = track(createCarbonFiberPbr(6, 2));

    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(60, 60)),
      track(
        new THREE.MeshStandardMaterial({
          map: marblePbr.map,
          normalMap: marblePbr.normalMap,
          roughnessMap: marblePbr.roughnessMap,
          roughness: 0.26,
          metalness: 0.32,
        })
      )
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Centerpiece Brushed Gold / Carbon Clearcoat Knot
    const knot = new THREE.Mesh(
      track(new THREE.TorusKnotGeometry(2.15, 0.58, 220, 44)),
      track(
        new THREE.MeshPhysicalMaterial({
          color: "#F8C354",
          metalness: 0.96,
          roughness: 0.12,
          clearcoat: 1.0,
          clearcoatRoughness: 0.04,
          normalMap: carbonPbr.normalMap,
          normalScale: new THREE.Vector2(0.18, 0.18),
        })
      )
    );
    knot.position.set(0, 3.6, 0);
    knot.castShadow = true;
    knot.receiveShadow = true;
    scene.add(knot);

    // Inner Transmission Crystal Diamond
    const crystal = new THREE.Mesh(
      track(new THREE.IcosahedronGeometry(1.18, 1)),
      track(
        new THREE.MeshPhysicalMaterial({
          color: "#BAE6FD",
          metalness: 0.05,
          roughness: 0.03,
          transmission: isSoftwareRenderer ? 0 : 0.92,
          transparent: isSoftwareRenderer,
          opacity: isSoftwareRenderer ? 0.65 : 1.0,
          thickness: 1.8,
          ior: 1.52,
          clearcoat: 1.0,
        })
      )
    );
    crystal.position.set(0, 3.6, 0);
    crystal.castShadow = true;
    scene.add(crystal);

    // 12 Orbiting Chrome/Titanium/Copper PBR Spheres
    const orbGeo = track(new THREE.SphereGeometry(0.68, 40, 40));
    const palette = ["#F8FAFC", "#38BDF8", "#F59E0B", "#E11D48", "#10B981", "#A855F7"];
    const orbs: THREE.Mesh[] = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(
        orbGeo,
        track(
          new THREE.MeshPhysicalMaterial({
            color: palette[i % palette.length],
            metalness: 0.94,
            roughness: 0.05 + (i % 4) * 0.07,
            clearcoat: 1.0,
          })
        )
      );
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      orbs.push(m);
    }

    // 4 Dynamic Blooming Studio Point Lights
    const lightSpecs = [
      { col: "#3B82F6", r: 9.2, y: 5.5, spd: 0.9 },
      { col: "#F59E0B", r: 9.8, y: 4.5, spd: -0.75 },
      { col: "#EC4899", r: 8.6, y: 6.4, spd: 1.18 },
      { col: "#38BDF8", r: 10.6, y: 3.4, spd: -1.05 },
    ];
    const dynLights: Array<{ light: THREE.PointLight; bulb: THREE.Mesh; r: number; y: number; spd: number; phase: number }> = [];
    const bulbGeo = track(new THREE.SphereGeometry(0.28, 16, 16));
    lightSpecs.forEach((ls, idx) => {
      const pl = new THREE.PointLight(ls.col, 85, 34, 1.5);
      pl.castShadow = idx < 2;
      if (pl.castShadow) pl.shadow.mapSize.set(1024, 1024);
      const bulb = new THREE.Mesh(bulbGeo, track(new THREE.MeshBasicMaterial({ color: ls.col })));
      scene.add(pl);
      scene.add(bulb);
      dynLights.push({ light: pl, bulb, r: ls.r, y: ls.y, spd: ls.spd, phase: idx * 1.57 });
    });

    stepFn = (t, _dt, prog, manual, pointer) => {
      const actIdx = prog < 0.34 ? 1 : prog < 0.68 ? 2 : 3;
      knot.rotation.set(t * 0.55, t * 0.85, Math.sin(t * 0.4) * 0.35);
      crystal.rotation.set(-t * 0.95, t * 1.25, 0);

      for (let i = 0; i < orbs.length; i++) {
        const ang = (i / orbs.length) * Math.PI * 2 + t * 0.68;
        const rad = 5.2 + Math.sin(t * 1.3 + i) * 0.65;
        orbs[i].position.set(Math.cos(ang) * rad, 1.45 + Math.abs(Math.sin(t * 1.5 + i * 0.8)) * 2.9, Math.sin(ang) * rad);
      }

      for (const dl of dynLights) {
        const a = t * dl.spd + dl.phase;
        dl.light.position.set(Math.cos(a) * dl.r, dl.y + Math.sin(t * 1.7 + dl.phase) * 1.4, Math.sin(a) * dl.r);
        dl.bulb.position.copy(dl.light.position);
      }

      const camAng = manual ? (pointer.x - 0.5) * Math.PI * 2.5 : t * 0.36;
      const camY = manual ? 1.8 + (1 - pointer.y) * 9.5 : 4.2 + Math.sin(t * 0.52) * 2.2;
      const camR = actIdx === 2 ? 7.8 : 11.4;
      camera.position.set(Math.cos(camAng) * camR, camY, Math.sin(camAng) * camR);
      camera.lookAt(0, 3.3, 0);

      composer.render();
      const tris = renderer.info.render.triangles;
      return {
        metricLabel: "HDRI+Bloom PBR",
        metricValue: `${(tris / 1000).toFixed(1)}K tris • IBL + UnrealBloom`,
        actLabel: actIdx === 1 ? "ACT I • HDRI Chrome Studio" : actIdx === 2 ? "ACT II • Refractive Crystal Close-Up" : "ACT III • 4-Light Bloom Sweep",
        triangles: tris,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.32,
      };
    };
  }

  // =========================================================================
  // SCENE 3: 3D INSTANCED NEON CYBERPUNK MEGACITY WITH REAL BLOOM
  // =========================================================================
  else if (sceneId === "three_megacity") {
    scene.background = new THREE.Color("#040712");
    scene.fog = new THREE.FogExp2("#060B1A", 0.0082);

    scene.add(new THREE.HemisphereLight("#38BDF8", "#0F172A", 0.7));
    const dir = new THREE.DirectionalLight("#F472B6", 1.8);
    dir.position.set(45, 75, 25);
    scene.add(dir);

    const facadePbr = track(createSkyscraperFacadePbr());
    const asphaltPbr = track(createWetNeonAsphaltPbr(2, 32));

    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(420, 620)),
      track(
        new THREE.MeshStandardMaterial({
          map: asphaltPbr.map,
          normalMap: asphaltPbr.normalMap,
          roughnessMap: asphaltPbr.roughnessMap,
          emissiveMap: asphaltPbr.emissiveMap,
          emissive: new THREE.Color("#38BDF8"),
          emissiveIntensity: 0.7,
          roughness: 0.22,
          metalness: 0.62,
        })
      )
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const towerCount = Math.min(9000, Math.round(3200 * Math.max(0.85, loadMult * 1.35)));
    const towerGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const towerMat = track(
      new THREE.MeshStandardMaterial({
        map: facadePbr.map,
        normalMap: facadePbr.normalMap,
        roughnessMap: facadePbr.roughnessMap,
        emissiveMap: facadePbr.emissiveMap,
        emissive: new THREE.Color("#FFFFFF"),
        emissiveIntensity: 1.35,
        roughness: 0.3,
        metalness: 0.65,
      })
    );
    const towers = new THREE.InstancedMesh(towerGeo, towerMat, towerCount);

    const dummy = new THREE.Object3D();
    const tCol = new THREE.Color();
    for (let i = 0; i < towerCount; i++) {
      const gx = ((i % 75) - 37) * 5.2;
      const gz = (Math.floor(i / 75) - 60) * 5.6;
      const x = Math.abs(gx) < 9.5 ? (gx < 0 ? gx - 10 : gx + 10) : gx;
      const h = 6 + ((i * 53) % 44) + (Math.abs(x) < 26 ? 18 : 0);
      const w = 2.4 + ((i * 17) % 10) * 0.22;
      dummy.position.set(x, h * 0.5, gz);
      dummy.scale.set(w, h, w);
      dummy.updateMatrix();
      towers.setMatrixAt(i, dummy.matrix);
      tCol.setHSL(0.56 + ((i * 13) % 100) * 0.0028, 0.55, 0.75);
      towers.setColorAt(i, tCol);
    }
    towers.instanceMatrix.needsUpdate = true;
    if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
    scene.add(towers);

    // Blooming Aerial Drone Traffic Streams
    const carCount = 340;
    const carGeo = track(new THREE.BoxGeometry(0.46, 0.22, 1.9));
    const cars = new THREE.InstancedMesh(
      carGeo,
      track(new THREE.MeshBasicMaterial({ color: "#FFFFFF" })),
      carCount
    );
    const carData = Array.from({ length: carCount }, (_, i) => ({
      x: ((i % 7) - 3) * 3.0,
      y: 3.5 + (i % 14) * 2.8,
      z: (i * 4.5) % 340 - 260,
      spd: (i % 2 === 0 ? 1 : -1) * (24 + (i % 6) * 8),
    }));
    const cTmp = new THREE.Color();
    for (let i = 0; i < carCount; i++) {
      cTmp.set(carData[i].spd > 0 ? "#38BDF8" : "#F43F5E");
      cars.setColorAt(i, cTmp);
    }
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    scene.add(cars);

    stepFn = (t, dt, prog, manual, pointer) => {
      const actIdx = prog < 0.34 ? 1 : prog < 0.68 ? 2 : 3;
      const flyZ = 95 - ((t * 28) % 240);
      const camX = manual ? (pointer.x - 0.5) * 14 : Math.sin(t * 0.55) * 3.8;
      const camY = manual ? 5 + (1 - pointer.y) * 30 : actIdx === 1 ? 26 : actIdx === 2 ? 9.5 : 17;
      camera.position.set(camX, camY, flyZ);
      camera.lookAt(camX * 0.35, camY - 2.2, flyZ - 48);
      camera.rotation.z = -camX * 0.025;

      for (let i = 0; i < carCount; i++) {
        const cd = carData[i];
        cd.z += cd.spd * dt;
        if (cd.z > 105) cd.z = -240;
        if (cd.z < -240) cd.z = 105;
        dummy.position.set(cd.x, cd.y, cd.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        cars.setMatrixAt(i, dummy.matrix);
      }
      cars.instanceMatrix.needsUpdate = true;

      composer.render();
      const tris = renderer.info.render.triangles;
      return {
        metricLabel: "Instanced Megacity",
        metricValue: `${towerCount.toLocaleString()} towers • ${(tris / 1000).toFixed(0)}K tris`,
        actLabel: actIdx === 1 ? "ACT I • Neon Skyline Dive" : actIdx === 2 ? "ACT II • Rain Boulevard Sprint" : "ACT III • Bloom Traffic Overdrive",
        triangles: tris,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.38,
      };
    };
  }

  // =========================================================================
  // SCENE 4: PLAYABLE 3D GAME 1 — SCULPTED STARFIGHTER TRENCH COMBAT & BOSS
  // =========================================================================
  else if (sceneId === "three_game_fighter") {
    scene.background = new THREE.Color("#030612");
    scene.fog = new THREE.FogExp2("#04091B", 0.0088);

    scene.add(new THREE.HemisphereLight("#60A5FA", "#0F172A", 0.9));
    const dir = new THREE.DirectionalLight("#F8FAFC", 2.4);
    dir.position.set(14, 24, 16);
    scene.add(dir);

    const carbonPbr = track(createCarbonFiberPbr(4, 4));
    const grid = new THREE.GridHelper(180, 44, "#38BDF8", "#1E293B");
    grid.position.y = -8;
    scene.add(grid);

    const starCount = 1200;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 140;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 90;
      starPositions[i * 3 + 2] = -Math.random() * 160;
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    scene.add(new THREE.Points(starGeo, track(new THREE.PointsMaterial({ color: "#E0F2FE", size: 0.36 }))));

    // Sculpted Multi-Part 3D Twin-Engine Starfighter!
    const ship = new THREE.Group();
    const hullMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#E2E8F0",
        metalness: 0.85,
        roughness: 0.18,
        clearcoat: 1.0,
        normalMap: carbonPbr.normalMap,
        normalScale: new THREE.Vector2(0.25, 0.25),
      })
    );
    const trimMat = track(new THREE.MeshStandardMaterial({ color: "#2563EB", metalness: 0.78, roughness: 0.22 }));
    const canopyMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#0EA5E9",
        metalness: 0.15,
        roughness: 0.05,
        clearcoat: 1.0,
        emissive: "#0284C7",
        emissiveIntensity: 0.35,
      })
    );
    const flameMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));

    const nose = new THREE.Mesh(track(new THREE.ConeGeometry(0.68, 3.6, 8)), hullMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.5;
    ship.add(nose);

    const fuselage = new THREE.Mesh(track(new THREE.CylinderGeometry(0.62, 0.82, 2.4, 8)), hullMat);
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.z = 1.2;
    ship.add(fuselage);

    const canopy = new THREE.Mesh(track(new THREE.SphereGeometry(0.52, 16, 12)), canopyMat);
    canopy.scale.set(0.82, 0.56, 1.9);
    canopy.position.set(0, 0.44, 0.15);
    ship.add(canopy);

    // Swept Delta Main Wings + Twin Tail Stabilizers + Wingtip Laser Barrels
    const wing = new THREE.Mesh(track(new THREE.BoxGeometry(5.6, 0.14, 1.55)), trimMat);
    wing.position.set(0, -0.06, 1.05);
    ship.add(wing);

    for (const sx of [-1, 1]) {
      const fin = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 1.15, 1.2)), hullMat);
      fin.position.set(sx * 1.1, 0.52, 1.85);
      fin.rotation.z = sx * -0.25;
      ship.add(fin);

      const pod = new THREE.Mesh(track(new THREE.CylinderGeometry(0.28, 0.34, 1.5, 10)), hullMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(sx * 0.72, -0.1, 1.8);
      ship.add(pod);

      const flame = new THREE.Mesh(track(new THREE.ConeGeometry(0.28, 1.9, 10)), flameMat);
      flame.rotation.x = Math.PI / 2;
      flame.position.set(sx * 0.72, -0.1, 3.25);
      ship.add(flame);

      const cannon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.08, 0.08, 1.9, 8)), trimMat);
      cannon.rotation.x = Math.PI / 2;
      cannon.position.set(sx * 2.75, -0.06, 0.4);
      ship.add(cannon);
    }
    scene.add(ship);

    // Dreadnought Boss
    const boss = new THREE.Group();
    const bossCore = new THREE.Mesh(
      track(new THREE.OctahedronGeometry(3.4, 2)),
      track(new THREE.MeshStandardMaterial({ color: "#DC2626", metalness: 0.75, roughness: 0.22, emissive: "#EF4444", emissiveIntensity: 0.75 }))
    );
    const bossRing = new THREE.Mesh(
      track(new THREE.TorusGeometry(5.6, 0.45, 16, 48)),
      track(new THREE.MeshStandardMaterial({ color: "#94A3B8", metalness: 0.92, roughness: 0.16 }))
    );
    boss.add(bossCore, bossRing);
    boss.position.set(0, 2, -62);
    boss.visible = false;
    scene.add(boss);

    const laserGeo = track(new THREE.BoxGeometry(0.16, 0.16, 3.6));
    const laserMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));
    const enemyGeo = track(new THREE.OctahedronGeometry(1.15, 0));
    const enemyMat = track(new THREE.MeshStandardMaterial({ color: "#F97316", metalness: 0.72, roughness: 0.25, emissive: "#EA580C", emissiveIntensity: 0.55 }));
    const sparkGeo = track(new THREE.DodecahedronGeometry(0.26, 0));
    const sparkMat = track(new THREE.MeshBasicMaterial({ color: "#FDE047" }));

    const lasers: Array<{ mesh: THREE.Mesh; vz: number }> = [];
    const enemies: Array<{ mesh: THREE.Mesh; vz: number; hp: number }> = [];
    const sparks: Array<{ mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }> = [];

    let shipX = 0;
    let shipY = 0;
    let kills = 0;
    let bossHp = 100;
    let fireCd = 0;
    let spawnCd = 0;

    const spawnBurst = (pos: THREE.Vector3, count: number) => {
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(sparkGeo, sparkMat);
        m.position.copy(pos);
        scene.add(m);
        sparks.push({
          mesh: m,
          vx: (Math.random() - 0.5) * 32,
          vy: (Math.random() - 0.5) * 32,
          vz: (Math.random() - 0.5) * 32,
          life: 0.7 + Math.random() * 0.4,
        });
      }
    };

    stepFn = (t, dt, prog, manual, pointer, keys) => {
      const actIdx = prog < 0.33 ? 1 : prog < 0.66 ? 2 : 3;
      grid.position.z = (t * 32) % 8;

      const sp = starGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < starCount; i++) {
        let sz = sp.getZ(i) + 74 * dt;
        if (sz > 18) sz = -150;
        sp.setZ(i, sz);
      }
      sp.needsUpdate = true;

      const prevX = shipX;
      const prevY = shipY;
      if (manual) {
        const moveSpd = 24 * dt;
        if (keys.has("a") || keys.has("arrowleft")) shipX -= moveSpd;
        if (keys.has("d") || keys.has("arrowright")) shipX += moveSpd;
        if (keys.has("w") || keys.has("arrowup")) shipY += moveSpd;
        if (keys.has("s") || keys.has("arrowdown")) shipY -= moveSpd;
        if (pointer.down || (keys.size === 0 && (pointer.x !== 0.5 || pointer.y !== 0.5))) {
          shipX += ((pointer.x - 0.5) * 26 - shipX) * 0.18;
          shipY += ((0.5 - pointer.y) * 15 - shipY) * 0.18;
        }
      } else {
        const aimX = actIdx === 3 && boss.visible ? boss.position.x + Math.sin(t * 2.6) * 4.5 : Math.sin(t * 1.9) * 9.5;
        const aimY = Math.cos(t * 2.2) * 4.2;
        shipX += (aimX - shipX) * 0.13;
        shipY += (aimY - shipY) * 0.13;
      }
      shipX = Math.max(-13, Math.min(13, shipX));
      shipY = Math.max(-6, Math.min(7.5, shipY));
      ship.position.set(shipX, shipY, 0);
      ship.rotation.z = THREE.MathUtils.clamp(-(shipX - prevX) * 2.6, -0.78, 0.78);
      ship.rotation.x = THREE.MathUtils.clamp((shipY - prevY) * 1.9, -0.45, 0.45);

      camera.position.set(shipX * 0.45, shipY * 0.35 + 3.2, 12.2);
      camera.lookAt(shipX * 0.72, shipY * 0.65, -24);

      fireCd -= dt;
      const overdrive = manual && (pointer.down || keys.has(" "));
      if (fireCd <= 0) {
        fireCd = overdrive ? 0.065 : 0.12;
        for (const sx of [-2.75, 2.75]) {
          const b = new THREE.Mesh(laserGeo, laserMat);
          b.position.set(shipX + sx, shipY - 0.06, -1.6);
          scene.add(b);
          lasers.push({ mesh: b, vz: -125 });
        }
      }

      spawnCd -= dt;
      if (spawnCd <= 0 && enemies.length < 22) {
        spawnCd = actIdx === 1 ? 0.42 : 0.24;
        const em = new THREE.Mesh(enemyGeo, enemyMat);
        em.position.set((Math.random() - 0.5) * 24, (Math.random() - 0.5) * 12, -108);
        scene.add(em);
        enemies.push({ mesh: em, vz: 32 + actIdx * 8, hp: 1 });
      }

      boss.visible = actIdx === 3;
      if (boss.visible) {
        boss.position.set(Math.sin(t * 1.4) * 9, 1.5 + Math.cos(t * 1.9) * 3, -46);
        bossRing.rotation.set(t * 2.1, t * 1.4, 0);
        bossCore.rotation.y = -t * 2.4;
      }

      for (let i = lasers.length - 1; i >= 0; i--) {
        const l = lasers[i];
        l.mesh.position.z += l.vz * dt;
        let hit = false;
        for (let j = enemies.length - 1; j >= 0; j--) {
          if (l.mesh.position.distanceTo(enemies[j].mesh.position) < 2.3) {
            spawnBurst(enemies[j].mesh.position, 10);
            scene.remove(enemies[j].mesh);
            enemies.splice(j, 1);
            kills++;
            hit = true;
            break;
          }
        }
        if (!hit && boss.visible && l.mesh.position.distanceTo(boss.position) < 5.6) {
          bossHp = Math.max(0, bossHp - 2.5);
          spawnBurst(l.mesh.position, 6);
          hit = true;
          if (bossHp <= 0) {
            spawnBurst(boss.position, 28);
            bossHp = 100;
            kills += 15;
          }
        }
        if (hit || l.mesh.position.z < -130) {
          scene.remove(l.mesh);
          lasers.splice(i, 1);
        }
      }

      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        e.mesh.position.z += e.vz * dt;
        e.mesh.rotation.x += dt * 2.8;
        e.mesh.rotation.y += dt * 3.4;
        if (e.mesh.position.z > 14) {
          scene.remove(e.mesh);
          enemies.splice(i, 1);
        }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life -= dt;
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        s.mesh.scale.setScalar(Math.max(0.01, s.life * 1.4));
        if (s.life <= 0) {
          scene.remove(s.mesh);
          sparks.splice(i, 1);
        }
      }

      composer.render();
      return {
        metricLabel: "3D Space Combat",
        metricValue: `${kills} Kills • Boss ${Math.round(bossHp)}% • ${manual ? "MANUAL" : "AUTO-AI"}`,
        actLabel: actIdx === 1 ? "ACT I • Asteroid Trench" : actIdx === 2 ? "ACT II • Interceptor Swarm" : "ACT III • Dreadnought Boss",
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.32,
      };
    };
  }

  // =========================================================================
  // SCENE 5: PLAYABLE 3D GAME 2 — SCULPTED CYBER-SUPERCAR WET NEON HIGHWAY
  // =========================================================================
  else if (sceneId === "three_game_racer") {
    scene.background = new THREE.Color("#050816");
    scene.fog = new THREE.FogExp2("#070D24", 0.0105);

    scene.add(new THREE.HemisphereLight("#38BDF8", "#1E1B4B", 0.95));
    const dir = new THREE.DirectionalLight("#F472B6", 2.0);
    dir.position.set(16, 30, 22);
    scene.add(dir);

    const asphaltPbr = track(createWetNeonAsphaltPbr(1, 18));
    const carbonPbr = track(createCarbonFiberPbr(3, 3));

    const road = new THREE.Mesh(
      track(new THREE.PlaneGeometry(24, 340)),
      track(
        new THREE.MeshStandardMaterial({
          map: asphaltPbr.map,
          normalMap: asphaltPbr.normalMap,
          roughnessMap: asphaltPbr.roughnessMap,
          emissiveMap: asphaltPbr.emissiveMap,
          emissive: new THREE.Color("#38BDF8"),
          emissiveIntensity: 0.85,
          roughness: 0.24,
          metalness: 0.58,
        })
      )
    );
    road.rotation.x = -Math.PI / 2;
    road.position.z = -115;
    scene.add(road);

    const pylonGeo = track(new THREE.BoxGeometry(0.42, 7.6, 0.42));
    const pylonMat = track(new THREE.MeshBasicMaterial({ color: "#38BDF8" }));
    const pylons: THREE.Mesh[] = [];
    for (let i = 0; i < 36; i++) {
      const m = new THREE.Mesh(pylonGeo, pylonMat);
      m.position.set(i % 2 === 0 ? -12.6 : 12.6, 3.8, -i * 7.2);
      scene.add(m);
      pylons.push(m);
    }

    // Sculpted Multi-Part 3D Carbon-Fiber Cyber-Supercar
    const car = new THREE.Group();
    const bodyMat = track(
      new THREE.MeshPhysicalMaterial({
        color: "#2563EB",
        metalness: 0.88,
        roughness: 0.14,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        normalMap: carbonPbr.normalMap,
        normalScale: new THREE.Vector2(0.18, 0.18),
      })
    );
    const carbonMat = track(
      new THREE.MeshStandardMaterial({
        map: carbonPbr.map,
        normalMap: carbonPbr.normalMap,
        roughnessMap: carbonPbr.roughnessMap,
        metalness: 0.5,
        roughness: 0.35,
      })
    );
    const chassis = new THREE.Mesh(track(new THREE.BoxGeometry(2.35, 0.62, 4.9)), bodyMat);
    chassis.position.y = 0.66;
    const cabin = new THREE.Mesh(
      track(new THREE.BoxGeometry(1.75, 0.52, 2.3)),
      track(new THREE.MeshPhysicalMaterial({ color: "#0F172A", metalness: 0.92, roughness: 0.05, clearcoat: 1.0 }))
    );
    cabin.position.set(0, 1.18, -0.15);
    const diffuser = new THREE.Mesh(track(new THREE.BoxGeometry(2.25, 0.32, 0.7)), carbonMat);
    diffuser.position.set(0, 0.45, 2.3);
    const spoiler = new THREE.Mesh(track(new THREE.BoxGeometry(2.45, 0.12, 0.65)), carbonMat);
    spoiler.position.set(0, 1.38, 2.15);
    const tailLight = new THREE.Mesh(
      track(new THREE.BoxGeometry(2.15, 0.18, 0.12)),
      track(new THREE.MeshBasicMaterial({ color: "#FF2A55" }))
    );
    tailLight.position.set(0, 0.78, 2.48);

    // 4 Spinning Alloy Wheels
    const wheelGeo = track(new THREE.CylinderGeometry(0.42, 0.42, 0.34, 16));
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = track(new THREE.MeshStandardMaterial({ color: "#1E293B", metalness: 0.8, roughness: 0.3 }));
    const wheels: THREE.Mesh[] = [];
    for (const [wx, wz] of [
      [-1.18, -1.55],
      [1.18, -1.55],
      [-1.18, 1.55],
      [1.18, 1.55],
    ]) {
      const wm = new THREE.Mesh(wheelGeo, wheelMat);
      wm.position.set(wx, 0.42, wz);
      car.add(wm);
      wheels.push(wm);
    }

    const nitroL = new THREE.Mesh(track(new THREE.ConeGeometry(0.22, 2.2, 10)), track(new THREE.MeshBasicMaterial({ color: "#38BDF8" })));
    nitroL.rotation.x = Math.PI / 2;
    nitroL.position.set(-0.55, 0.55, 3.35);
    const nitroR = nitroL.clone();
    nitroR.position.x = 0.55;
    car.add(chassis, cabin, diffuser, spoiler, tailLight, nitroL, nitroR);
    scene.add(car);

    const trafficGeo = track(new THREE.BoxGeometry(2.15, 1.08, 4.4));
    const trafficColors = ["#F59E0B", "#EC4899", "#10B981", "#F8FAFC", "#A855F7"];
    const lanes = [-7.5, -2.5, 2.5, 7.5];
    const traffic: Array<{ mesh: THREE.Mesh; lane: number; passed: boolean }> = [];
    for (let i = 0; i < 16; i++) {
      const lane = lanes[i % 4];
      const m = new THREE.Mesh(
        trafficGeo,
        track(
          new THREE.MeshStandardMaterial({
            color: trafficColors[i % trafficColors.length],
            metalness: 0.72,
            roughness: 0.22,
            emissive: trafficColors[i % trafficColors.length],
            emissiveIntensity: 0.18,
          })
        )
      );
      m.position.set(lane, 0.66, -32 - i * 19);
      scene.add(m);
      traffic.push({ mesh: m, lane, passed: false });
    }

    let carX = 0;
    let speedKmh = 220;
    let nearMisses = 0;
    let raceScore = 0;

    stepFn = (_t, dt, prog, manual, pointer, keys) => {
      const nitro = manual ? keys.has("w") || keys.has(" ") || pointer.down : prog > 0.52;
      const targetSpd = nitro ? 380 : 225 + prog * 75;
      speedKmh += (targetSpd - speedKmh) * 0.085;
      const worldSpd = speedKmh * 0.30;

      asphaltPbr.map.offset.y += worldSpd * dt * 0.09;
      asphaltPbr.normalMap.offset.y = asphaltPbr.map.offset.y;
      asphaltPbr.roughnessMap.offset.y = asphaltPbr.map.offset.y;
      if (asphaltPbr.emissiveMap) asphaltPbr.emissiveMap.offset.y = asphaltPbr.map.offset.y;

      for (const w of wheels) w.rotation.x -= worldSpd * dt * 0.55;
      for (const py of pylons) {
        py.position.z += worldSpd * dt;
        if (py.position.z > 14) py.position.z -= 259;
      }

      const prevX = carX;
      if (manual) {
        const steer = 20 * dt;
        if (keys.has("a") || keys.has("arrowleft")) carX -= steer;
        if (keys.has("d") || keys.has("arrowright")) carX += steer;
        if (keys.size === 0 && pointer.x !== 0.5) carX += ((pointer.x - 0.5) * 20 - carX) * 0.18;
      } else {
        let bestLane = 0;
        let bestClear = -1;
        for (const l of lanes) {
          let nearest = 999;
          for (const tr of traffic) {
            if (Math.abs(tr.mesh.position.x - l) < 2.2 && tr.mesh.position.z < 5 && tr.mesh.position.z > -65) {
              nearest = Math.min(nearest, Math.abs(tr.mesh.position.z));
            }
          }
          if (nearest > bestClear) {
            bestClear = nearest;
            bestLane = l;
          }
        }
        carX += (bestLane - carX) * 0.11;
      }
      carX = Math.max(-9.4, Math.min(9.4, carX));
      car.position.x = carX;
      car.rotation.y = THREE.MathUtils.clamp(-(carX - prevX) * 0.65, -0.35, 0.35);
      car.rotation.z = THREE.MathUtils.clamp(-(carX - prevX) * 0.35, -0.18, 0.18);
      nitroL.visible = nitro;
      nitroR.visible = nitro;
      if (nitro) {
        const ns = 0.85 + Math.random() * 0.55;
        nitroL.scale.set(1, ns, 1);
        nitroR.scale.set(1, ns, 1);
      }

      const targetFov = nitro ? 82 : 63;
      camera.fov += (targetFov - camera.fov) * 0.1;
      camera.updateProjectionMatrix();
      camera.position.set(carX * 0.68, 3.65, 8.6);
      camera.lookAt(carX * 0.85, 1.2, -32);

      for (const tr of traffic) {
        tr.mesh.position.z += (worldSpd * 0.58) * dt;
        if (!tr.passed && tr.mesh.position.z > 2.2) {
          tr.passed = true;
          raceScore += Math.round(speedKmh * 0.6);
          if (Math.abs(tr.mesh.position.x - carX) < 3.7) nearMisses++;
        }
        if (tr.mesh.position.z > 18) {
          tr.mesh.position.z = -280 - Math.random() * 45;
          tr.lane = lanes[Math.floor(Math.random() * lanes.length)];
          tr.mesh.position.x = tr.lane;
          tr.passed = false;
        }
      }

      composer.render();
      return {
        metricLabel: "3D Nitro Racer",
        metricValue: `${Math.round(speedKmh)} km/h • ${nearMisses} Near-Miss • ${raceScore} pts`,
        actLabel: nitro ? "ACT III • 380 km/h BLOOM NITRO" : prog > 0.33 ? "ACT II • Rain Traffic Weave" : "ACT I • Wet Neon Highway",
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.3,
      };
    };
  }

  // =========================================================================
  // SCENE 6: PLAYABLE 3D GAME 3 — RAPIER3D WASM PHYSICS FORTRESS SIEGE!
  // =========================================================================
  else {
    scene.background = new THREE.Color("#7EC0F2");
    scene.fog = new THREE.FogExp2("#A3D2F6", 0.0068);

    scene.add(new THREE.HemisphereLight("#E0F2FE", "#334155", 0.95));
    const sun = new THREE.DirectionalLight("#FFF8E1", 2.9);
    sun.position.set(28, 44, 26);
    sun.castShadow = true;
    const sRes = loadMult > 1.2 ? 2048 : 1024;
    sun.shadow.mapSize.set(sRes, sRes);
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    scene.add(sun);

    const blockPbr = track(createFortressBlockPbr());

    const arena = new THREE.Mesh(
      track(new THREE.PlaneGeometry(180, 180)),
      track(new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.85, metalness: 0.08 }))
    );
    arena.rotation.x = -Math.PI / 2;
    arena.receiveShadow = true;
    scene.add(arena);

    const blockGeo = track(new THREE.BoxGeometry(1.42, 0.98, 1.42));
    const blockMats = [
      track(new THREE.MeshStandardMaterial({ color: "#2563EB", map: blockPbr.map, normalMap: blockPbr.normalMap, roughnessMap: blockPbr.roughnessMap, roughness: 0.36, metalness: 0.3 })),
      track(new THREE.MeshStandardMaterial({ color: "#F59E0B", map: blockPbr.map, normalMap: blockPbr.normalMap, roughnessMap: blockPbr.roughnessMap, roughness: 0.34, metalness: 0.35 })),
      track(new THREE.MeshStandardMaterial({ color: "#E2E8F0", map: blockPbr.map, normalMap: blockPbr.normalMap, roughnessMap: blockPbr.roughnessMap, roughness: 0.42, metalness: 0.2 })),
      track(new THREE.MeshStandardMaterial({ color: "#0EA5E9", map: blockPbr.map, normalMap: blockPbr.normalMap, roughnessMap: blockPbr.roughnessMap, roughness: 0.32, metalness: 0.42 })),
    ];
    const ballGeo = track(new THREE.SphereGeometry(0.95, 24, 24));
    const ballMat = track(
      new THREE.MeshStandardMaterial({
        color: "#EF4444",
        emissive: "#F97316",
        emissiveIntensity: 1.4,
        metalness: 0.8,
        roughness: 0.18,
      })
    );

    interface PhysicsBlock {
      mesh: THREE.Mesh;
      body: RAPIER_TYPE.RigidBody | null;
      startY: number;
      toppled: boolean;
      vx: number;
      vy: number;
      vz: number;
    }
    interface PhysicsBall {
      mesh: THREE.Mesh;
      body: RAPIER_TYPE.RigidBody | null;
      vx: number;
      vy: number;
      vz: number;
      life: number;
    }

    let world: RAPIER_TYPE.World | null = null;
    let blocks: PhysicsBlock[] = [];
    let balls: PhysicsBall[] = [];
    let towersSmashed = 0;
    let blocksToppled = 0;
    let autoFireCd = 0.7;
    let usingRapier = false;
    let disposedFlag = false;

    const clearBodies = () => {
      for (const b of blocks) scene.remove(b.mesh);
      for (const bl of balls) scene.remove(bl.mesh);
      blocks = [];
      balls = [];
      if (world) {
        world.free();
        world = null;
      }
    };

    const buildFortress = () => {
      clearBodies();
      const RAPIER = rapierMod;
      if (RAPIER) {
        world = new RAPIER.World({ x: 0.0, y: -22.0, z: 0.0 });
        usingRapier = true;
        // Solid ground collider
        const groundDesc = RAPIER.ColliderDesc.cuboid(90.0, 0.5, 90.0).setTranslation(0, -0.5, 0).setFriction(0.75).setRestitution(0.2);
        world.createCollider(groundDesc);
      } else {
        usingRapier = false;
      }

      const stories = Math.min(10, Math.round(7 * Math.max(0.85, loadMult)));
      for (const towerX of [-6.8, 0, 6.8]) {
        const towerH = towerX === 0 ? stories + 2 : stories;
        for (let y = 0; y < towerH; y++) {
          for (let gx = -1; gx <= 1; gx++) {
            for (let gz = -1; gz <= 1; gz++) {
              if (gx === 0 && gz === 0 && y < towerH - 1) continue;
              const mat = blockMats[(y + Math.abs(gx + gz)) % blockMats.length];
              const m = new THREE.Mesh(blockGeo, mat);
              const px = towerX + gx * 1.48;
              const py = 0.5 + y * 1.0;
              const pz = -4 + gz * 1.48;
              m.position.set(px, py, pz);
              m.castShadow = true;
              m.receiveShadow = true;
              scene.add(m);

              let body: RAPIER_TYPE.RigidBody | null = null;
              if (world && RAPIER) {
                const rbDesc = RAPIER.RigidBodyDesc.dynamic()
                  .setTranslation(px, py, pz)
                  .setLinearDamping(0.08)
                  .setAngularDamping(0.12);
                body = world.createRigidBody(rbDesc);
                const colDesc = RAPIER.ColliderDesc.cuboid(0.71, 0.49, 0.71)
                  .setDensity(1.4)
                  .setFriction(0.68)
                  .setRestitution(0.18);
                world.createCollider(colDesc, body);
              }
              blocks.push({ mesh: m, body, startY: py, toppled: false, vx: 0, vy: 0, vz: 0 });
            }
          }
        }
      }
    };

    buildFortress();
    // Lazy-load Rapier3D WASM cleanly when Scene 6 enters, then seamlessly upgrade towers to rigid bodies!
    if (!rapierMod) {
      void ensureRapierInit().then((mod) => {
        if (mod && !disposedFlag && !usingRapier) buildFortress();
      });
    }

    const fireCannon = (targetX: number, targetY: number) => {
      const m = new THREE.Mesh(ballGeo, ballMat);
      m.position.set(0, 6.0, 23);
      m.castShadow = true;
      scene.add(m);
      const dir = new THREE.Vector3(targetX, targetY, -4).sub(m.position).normalize();
      const speed = 56;
      const vx = dir.x * speed;
      const vy = dir.y * speed + 5.2;
      const vz = dir.z * speed;

      let body: RAPIER_TYPE.RigidBody | null = null;
      const RAPIER = rapierMod;
      if (world && RAPIER) {
        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, 6.0, 23)
          .setLinvel(vx, vy, vz)
          .setCcdEnabled(true);
        body = world.createRigidBody(rbDesc);
        const colDesc = RAPIER.ColliderDesc.ball(0.95).setDensity(14.0).setRestitution(0.45);
        world.createCollider(colDesc, body);
      }
      balls.push({ mesh: m, body, vx, vy, vz, life: 5.0 });
    };

    extraCleanup = () => {
      disposedFlag = true;
      clearBodies();
    };

    stepFn = (t, dt, prog, manual, pointer, keys) => {
      if (keys.has("r")) {
        buildFortress();
        keys.delete("r");
      }

      if (manual) {
        if (pointer.clicked || keys.has(" ")) {
          pointer.clicked = false;
          fireCannon((pointer.x - 0.5) * 24, 1.5 + (1 - pointer.y) * 14);
        }
      } else {
        autoFireCd -= dt;
        if (autoFireCd <= 0) {
          autoFireCd = 0.78;
          fireCannon(Math.sin(t * 1.65) * 8.2, 2.2 + (Math.floor(t * 1.8) % 4) * 2.1);
        }
      }

      if (world && usingRapier) {
        world.timestep = Math.min(0.033, Math.max(0.008, dt));
        world.step();

        for (let i = balls.length - 1; i >= 0; i--) {
          const bl = balls[i];
          bl.life -= dt;
          if (bl.body) {
            const p = bl.body.translation();
            const r = bl.body.rotation();
            bl.mesh.position.set(p.x, p.y, p.z);
            bl.mesh.quaternion.set(r.x, r.y, r.z, r.w);
          }
          if (bl.life <= 0) {
            if (bl.body) world.removeRigidBody(bl.body);
            scene.remove(bl.mesh);
            balls.splice(i, 1);
          }
        }

        let toppledNow = 0;
        for (const blk of blocks) {
          if (blk.body) {
            const p = blk.body.translation();
            const r = blk.body.rotation();
            blk.mesh.position.set(p.x, p.y, p.z);
            blk.mesh.quaternion.set(r.x, r.y, r.z, r.w);
            if (!blk.toppled && (Math.abs(p.y - blk.startY) > 1.25 || Math.abs(r.x) > 0.25 || Math.abs(r.z) > 0.25)) {
              blk.toppled = true;
              blocksToppled++;
            }
          }
          if (blk.toppled) toppledNow++;
        }

        if (blocks.length > 0 && toppledNow >= blocks.length * 0.72) {
          towersSmashed++;
          buildFortress();
        }
      } else {
        // Lightweight fallback only for the first 1-2 frames before WASM init resolves
        for (let i = balls.length - 1; i >= 0; i--) {
          const b = balls[i];
          b.vy -= 22 * dt;
          b.mesh.position.x += b.vx * dt;
          b.mesh.position.y = Math.max(0.95, b.mesh.position.y + b.vy * dt);
          b.mesh.position.z += b.vz * dt;
          b.life -= dt;
          if (b.life <= 0) {
            scene.remove(b.mesh);
            balls.splice(i, 1);
          }
        }
      }

      const camAng = manual ? (pointer.x - 0.5) * 0.8 : Math.sin(t * 0.45) * 0.36;
      camera.position.set(Math.sin(camAng) * 29, 10.8, Math.cos(camAng) * 29);
      camera.lookAt(0, 4.4, -4);

      composer.render();
      return {
        metricLabel: usingRapier ? "Rapier3D WASM Physics" : "3D Tower Siege",
        metricValue: `${blocks.length} Bodies • ${blocksToppled} Toppled • ${towersSmashed} Smashed`,
        actLabel: prog > 0.65 ? "ACT III • Rapier3D Demolition" : prog > 0.33 ? "ACT II • Chain-Reaction Collapse" : "ACT I • Fortress Siege",
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        throughputScoreFactor: 1.4,
      };
    };
  }

  return {
    rendererName,
    step: (t, dt, prog, manual, pointer, keys) => stepFn(t, dt, prog, manual, pointer, keys),
    resize: (w: number, h: number) => {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
    },
    dispose: () => {
      if (extraCleanup) extraCleanup();
      composer.dispose();
      bloomPass.dispose();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Ignore
        }
      }
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        // Ignore
      }
    },
  };
}
