// LaptopBench QC v3.5.0 — Native Uncapped DX12/Vulkan/Metal 3D Benchmark Suite
// Scenes:
//   0 = FurMark-Class Volumetric Fur-Torus Thermal Hammer
//   1 = Real-Time Multi-Bounce Path-Traced PBR Studio & Glass Caustics
//   2 = Volumetric Alpine Canyon, 3D Clouds & Reflective Ocean Ray-Marcher

struct Uniforms {
    resolution: vec2<f32>,
    time: f32,
    scene_mode: u32,
    cam_yaw: f32,
    cam_pitch: f32,
    cam_zoom: f32,
    stress_mult: f32,
};

@group(0) @binding(0)
var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
    var p = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 3.0,  1.0)
    );
    var out: VsOut;
    out.pos = vec4<f32>(p[idx], 0.0, 1.0);
    out.uv = p[idx] * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}

fn rot2(a: f32) -> mat2x2<f32> {
    let c = cos(a);
    let s = sin(a);
    return mat2x2<f32>(c, -s, s, c);
}

fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

fn noise3(x: vec3<f32>) -> f32 {
    let i = floor(x);
    let f = fract(x);
    let u2 = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(
            mix(hash31(i + vec3<f32>(0.0, 0.0, 0.0)), hash31(i + vec3<f32>(1.0, 0.0, 0.0)), u2.x),
            mix(hash31(i + vec3<f32>(0.0, 1.0, 0.0)), hash31(i + vec3<f32>(1.0, 1.0, 0.0)), u2.x),
            u2.y
        ),
        mix(
            mix(hash31(i + vec3<f32>(0.0, 0.0, 1.0)), hash31(i + vec3<f32>(1.0, 0.0, 1.0)), u2.x),
            mix(hash31(i + vec3<f32>(0.0, 1.0, 1.0)), hash31(i + vec3<f32>(1.0, 1.0, 1.0)), u2.x),
            u2.y
        ),
        u2.z
    );
}

fn fbm3(p_in: vec3<f32>) -> f32 {
    var p = p_in;
    var val = 0.0;
    var amp = 0.5;
    for (var i = 0; i < 4; i = i + 1) {
        val += amp * noise3(p);
        p = p * 2.03 + vec3<f32>(17.1, 31.7, 11.3);
        amp *= 0.5;
    }
    return val;
}

fn aces_tonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// =========================================================================
// SCENE 0: FurMark-Class Volumetric Fur-Torus Thermal Hammer
// =========================================================================
fn sd_fur_torus(p_in: vec3<f32>, t: f32) -> vec2<f32> {
    var p = p_in;
    let r1 = rot2(t * 0.45);
    let rxz = r1 * p.xz;
    p = vec3<f32>(rxz.x, p.y, rxz.y);
    let r2 = rot2(t * 0.31);
    let rxy = r2 * p.xy;
    p = vec3<f32>(rxy.x, rxy.y, p.z);

    let major = 1.65;
    let minor = 0.62;
    let q = vec2<f32>(length(p.xz) - major, p.y);
    let base_d = length(q) - minor;

    // Braided high-frequency volumetric fur strands
    let ang_major = atan2(p.z, p.x);
    let ang_minor = atan2(q.y, q.x);
    let strand = sin(ang_major * 28.0 + ang_minor * 14.0 + t * 2.2) * 0.045;
    let fur_n = fbm3(p * 4.4 + vec3<f32>(t * 0.6, -t * 0.4, t * 0.35));
    let fur_disp = (fur_n - 0.45) * 0.28 + strand;
    let d_torus = base_d - fur_disp;

    // Pulsing central plasma core
    let d_core = length(p_in) - (0.58 + 0.08 * sin(t * 3.5 + p_in.y * 5.0));
    if (d_core < d_torus) {
        return vec2<f32>(d_core, 2.0);
    }
    return vec2<f32>(d_torus, fur_n);
}

fn render_furmark(uv: vec2<f32>, t: f32) -> vec3<f32> {
    let aspect = u.resolution.x / max(1.0, u.resolution.y);
    let p = vec2<f32>((uv.x - 0.5) * 2.0 * aspect, (0.5 - uv.y) * 2.0);

    let cam_dist = clamp(4.15 / max(0.35, u.cam_zoom), 2.1, 7.5);
    let yaw = u.cam_yaw + sin(t * 0.25) * 0.35;
    let pitch = clamp(u.cam_pitch + cos(t * 0.21) * 0.18, -0.85, 0.85);
    let ro = vec3<f32>(
        sin(yaw) * cos(pitch) * cam_dist,
        sin(pitch) * cam_dist,
        cos(yaw) * cos(pitch) * cam_dist
    );
    let fwd = normalize(-ro);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
    let up = cross(fwd, right);
    let rd = normalize(fwd * 1.55 + right * p.x + up * p.y);

    // Rich dark thermal-chamber tunnel backdrop
    let radial = length(p);
    var col = mix(vec3<f32>(0.11, 0.04, 0.02), vec3<f32>(0.015, 0.02, 0.045), clamp(radial * 0.65, 0.0, 1.0));
    let grid_ring = sin(radial * 24.0 - t * 4.0) * 0.5 + 0.5;
    col += vec3<f32>(0.22, 0.07, 0.02) * pow(grid_ring, 6.0) * exp(-radial * 1.1);

    var dist = 0.0;
    var hit_mat = -1.0;
    var glow = vec3<f32>(0.0);
    let max_steps = i32(clamp(92.0 * u.stress_mult, 72.0, 148.0));

    for (var i = 0; i < 148; i = i + 1) {
        if (i >= max_steps) { break; }
        let pos = ro + rd * dist;
        let res = sd_fur_torus(pos, t);
        let d = res.x;
        // Accumulate volumetric ember glow near surface
        glow += vec3<f32>(1.0, 0.34, 0.06) * (0.0042 / (abs(d) + 0.06));
        if (d < 0.003) {
            hit_mat = res.y;
            break;
        }
        dist += d * 0.58;
        if (dist > 14.0) { break; }
    }

    if (hit_mat >= 0.0) {
        let pos = ro + rd * dist;
        let eps = 0.0035;
        let n = normalize(vec3<f32>(
            sd_fur_torus(pos + vec3<f32>(eps, 0.0, 0.0), t).x - sd_fur_torus(pos - vec3<f32>(eps, 0.0, 0.0), t).x,
            sd_fur_torus(pos + vec3<f32>(0.0, eps, 0.0), t).x - sd_fur_torus(pos - vec3<f32>(0.0, eps, 0.0), t).x,
            sd_fur_torus(pos + vec3<f32>(0.0, 0.0, eps), t).x - sd_fur_torus(pos - vec3<f32>(0.0, 0.0, eps), t).x
        ));
        let l1 = normalize(vec3<f32>(2.8, 3.6, 2.2));
        let l2 = normalize(vec3<f32>(-3.0, -1.5, 2.5));
        let v = -rd;
        let fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.2);

        if (hit_mat > 1.5) {
            // Incandescent cobalt-cyan plasma reactor orb inside torus
            let core_glow = 0.75 + 0.45 * sin(t * 6.0 + pos.y * 8.0);
            col = mix(vec3<f32>(0.08, 0.45, 1.4), vec3<f32>(0.85, 0.96, 1.6), fresnel) * core_glow;
        } else {
            // Golden-crimson fur shading with molten ember core
            let heat = clamp(hit_mat * 1.35, 0.0, 1.0);
            let fur_base = mix(vec3<f32>(0.36, 0.09, 0.03), vec3<f32>(1.15, 0.56, 0.12), heat);
            let diff1 = max(dot(n, l1), 0.0);
            let diff2 = max(dot(n, l2), 0.0);
            let h1 = normalize(l1 + v);
            let spec1 = pow(max(dot(n, h1), 0.0), 48.0);
            let ao = clamp(0.35 + 0.65 * heat, 0.0, 1.0);
            col = fur_base * (0.16 + diff1 * 1.15 + diff2 * 0.45) * ao;
            col += vec3<f32>(1.0, 0.82, 0.52) * spec1 * 0.85;
            col += vec3<f32>(0.25, 0.58, 1.15) * fresnel * 0.65;
        }
    }

    col += glow * 0.38;
    return aces_tonemap(col);
}

// =========================================================================
// SCENE 1: Real-Time Multi-Bounce Path-Traced PBR & Glass Caustics Studio
// =========================================================================
struct RayHit {
    t: f32,
    normal: vec3<f32>,
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    glass: f32,
    emissive: vec3<f32>,
};

fn intersect_sphere(ro: vec3<f32>, rd: vec3<f32>, c: vec3<f32>, r: f32) -> f32 {
    let oc = ro - c;
    let b = dot(oc, rd);
    let c2 = dot(oc, oc) - r * r;
    let h = b * b - c2;
    if (h < 0.0) { return -1.0; }
    let sq = sqrt(h);
    let t1 = -b - sq;
    if (t1 > 0.002) { return t1; }
    let t2 = -b + sq;
    if (t2 > 0.002) { return t2; }
    return -1.0;
}

fn trace_studio(ro: vec3<f32>, rd: vec3<f32>, t: f32) -> RayHit {
    var best: RayHit;
    best.t = 1e9;
    best.normal = vec3<f32>(0.0, 1.0, 0.0);
    best.albedo = vec3<f32>(0.0);
    best.metallic = 0.0;
    best.roughness = 0.5;
    best.glass = 0.0;
    best.emissive = vec3<f32>(0.0);

    // Reflective studio marble floor y = -1.0
    if (abs(rd.y) > 0.0005) {
        let tf = (-1.0 - ro.y) / rd.y;
        if (tf > 0.002 && tf < best.t) {
            let p = ro + rd * tf;
            if (length(p.xz) < 26.0) {
                best.t = tf;
                best.normal = vec3<f32>(0.0, 1.0, 0.0);
                let cx = floor(p.x * 1.25);
                let cz = floor(p.z * 1.25);
                let chk = (i32(cx) + i32(cz)) & 1;
                let vein = sin(p.x * 3.1 + sin(p.z * 2.7)) * 0.05;
                best.albedo = select(vec3<f32>(0.08, 0.09, 0.12) + vein, vec3<f32>(0.88, 0.90, 0.94) - vein, chk == 0);
                best.metallic = 0.22;
                best.roughness = 0.14;
                best.glass = 0.0;
                best.emissive = vec3<f32>(0.0);
            }
        }
    }

    // Center Refractive Glass Orb (with animated float)
    let c_glass = vec3<f32>(0.0, 0.25 + sin(t * 1.4) * 0.18, 0.0);
    let tg = intersect_sphere(ro, rd, c_glass, 1.15);
    if (tg > 0.0 && tg < best.t) {
        best.t = tg;
        best.normal = normalize((ro + rd * tg) - c_glass);
        best.albedo = vec3<f32>(0.94, 0.98, 1.0);
        best.metallic = 0.05;
        best.roughness = 0.02;
        best.glass = 1.0;
        best.emissive = vec3<f32>(0.0);
    }

    // 6 Orbiting Metallic PBR & Emissive Spheres
    for (var i = 0; i < 6; i = i + 1) {
        let fi = f32(i);
        let ang = fi * 1.0471975 + t * 0.55;
        let rad = 2.65 + 0.22 * sin(t * 1.2 + fi * 1.7);
        let sy = -0.25 + 0.45 * abs(sin(t * 1.1 + fi * 1.1));
        let sc = vec3<f32>(cos(ang) * rad, sy, sin(ang) * rad);
        let sr = 0.54 + 0.08 * sin(fi * 2.1);
        let ts = intersect_sphere(ro, rd, sc, sr);
        if (ts > 0.0 && ts < best.t) {
            best.t = ts;
            best.normal = normalize((ro + rd * ts) - sc);
            best.glass = 0.0;
            if (i % 3 == 0) {
                // Mirror Chrome
                best.albedo = vec3<f32>(0.95, 0.97, 1.0);
                best.metallic = 0.96;
                best.roughness = 0.04;
                best.emissive = vec3<f32>(0.0);
            } else if (i % 3 == 1) {
                // Brushed Gold
                best.albedo = vec3<f32>(1.0, 0.78, 0.34);
                best.metallic = 0.92;
                best.roughness = 0.12;
                best.emissive = vec3<f32>(0.0);
            } else {
                // Cobalt Neon Emitter
                best.albedo = vec3<f32>(0.15, 0.52, 1.0);
                best.metallic = 0.35;
                best.roughness = 0.18;
                best.emissive = vec3<f32>(0.35, 0.72, 1.85);
            }
        }
    }

    // Overhead Dual Studio Softbox Emitters (reflected sharply in chrome & glass!)
    let sb1 = intersect_sphere(ro, rd, vec3<f32>(3.6, 5.4, 2.2), 1.05);
    if (sb1 > 0.0 && sb1 < best.t) {
        best.t = sb1;
        best.normal = normalize((ro + rd * sb1) - vec3<f32>(3.6, 5.4, 2.2));
        best.emissive = vec3<f32>(4.2, 3.8, 3.3);
        best.albedo = vec3<f32>(1.0);
        best.metallic = 0.0;
        best.glass = 0.0;
    }
    let sb2 = intersect_sphere(ro, rd, vec3<f32>(-4.2, 4.4, -2.6), 0.95);
    if (sb2 > 0.0 && sb2 < best.t) {
        best.t = sb2;
        best.normal = normalize((ro + rd * sb2) - vec3<f32>(-4.2, 4.4, -2.6));
        best.emissive = vec3<f32>(1.4, 2.6, 4.6);
        best.albedo = vec3<f32>(1.0);
        best.metallic = 0.0;
        best.glass = 0.0;
    }

    return best;
}

fn studio_sky(rd: vec3<f32>) -> vec3<f32> {
    let k = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    let grad = mix(vec3<f32>(0.04, 0.06, 0.11), vec3<f32>(0.14, 0.24, 0.42), pow(k, 0.7));
    let studio_band = exp(-abs(rd.y - 0.18) * 14.0) * vec3<f32>(0.45, 0.58, 0.85);
    return grad + studio_band;
}

fn render_pathtrace(uv: vec2<f32>, t: f32) -> vec3<f32> {
    let aspect = u.resolution.x / max(1.0, u.resolution.y);
    let p = vec2<f32>((uv.x - 0.5) * 2.0 * aspect, (0.5 - uv.y) * 2.0);

    let yaw = u.cam_yaw + t * 0.32;
    let pitch = clamp(0.28 + u.cam_pitch, 0.04, 1.05);
    let dist = clamp(6.6 / max(0.35, u.cam_zoom), 3.0, 11.0);
    let ro0 = vec3<f32>(sin(yaw) * cos(pitch) * dist, sin(pitch) * dist + 0.3, cos(yaw) * cos(pitch) * dist);
    let look_at = vec3<f32>(0.0, 0.15, 0.0);
    let fwd = normalize(look_at - ro0);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
    let up = cross(fwd, right);
    let rd0 = normalize(fwd * 1.7 + right * p.x + up * p.y);

    var ro = ro0;
    var rd = rd0;
    var accum = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);

    let l1_pos = vec3<f32>(3.6, 5.4, 2.2);
    let l2_pos = vec3<f32>(-4.2, 4.4, -2.6);

    // 4-bounce hardware ray tracing loop
    for (var bounce = 0; bounce < 4; bounce = bounce + 1) {
        let hit = trace_studio(ro, rd, t);
        if (hit.t > 1e8) {
            accum += throughput * studio_sky(rd);
            break;
        }
        let hp = ro + rd * hit.t;
        if (length(hit.emissive) > 0.01) {
            accum += throughput * hit.emissive;
            if (hit.metallic < 0.1) { break; }
        }

        // Direct shadow-tested studio lighting + glass caustic projection on floor
        let to1 = l1_pos - hp;
        let d1 = length(to1);
        let ld1 = to1 / d1;
        let sh1 = trace_studio(hp + hit.normal * 0.01, ld1, t);
        var vis1 = select(0.18, 1.0, sh1.t > d1 - 0.1);
        var caustic = vec3<f32>(0.0);
        if (sh1.glass > 0.5) {
            vis1 = 0.85;
            let focus = pow(max(dot(ld1, -sh1.normal), 0.0), 6.0);
            caustic += vec3<f32>(0.95, 1.15, 1.45) * focus * 1.4;
        }

        let to2 = l2_pos - hp;
        let d2 = length(to2);
        let ld2 = to2 / d2;
        let sh2 = trace_studio(hp + hit.normal * 0.01, ld2, t);
        let vis2 = select(0.22, 1.0, sh2.t > d2 - 0.1);

        let diff1 = max(dot(hit.normal, ld1), 0.0) * vis1;
        let diff2 = max(dot(hit.normal, ld2), 0.0) * vis2;
        let h1 = normalize(ld1 - rd);
        let spec1 = pow(max(dot(hit.normal, h1), 0.0), mix(180.0, 24.0, hit.roughness)) * vis1;

        let direct = hit.albedo * (vec3<f32>(0.10, 0.12, 0.16) + vec3<f32>(1.15, 1.05, 0.92) * diff1 + vec3<f32>(0.42, 0.68, 1.15) * diff2)
            + vec3<f32>(1.0) * spec1 * (0.4 + 0.6 * hit.metallic)
            + caustic;

        if (hit.glass > 0.5) {
            // Dielectric Snell refraction + Schlick Fresnel reflection
            let cos_i = clamp(-dot(rd, hit.normal), 0.0, 1.0);
            let f0 = 0.06;
            let fres = f0 + (1.0 - f0) * pow(1.0 - cos_i, 5.0);
            accum += throughput * (vec3<f32>(0.06, 0.11, 0.16) + vec3<f32>(1.0) * spec1 * 1.2) * fres;
            let eta = select(1.48, 1.0 / 1.48, dot(rd, hit.normal) < 0.0);
            let n_eff = select(-hit.normal, hit.normal, dot(rd, hit.normal) < 0.0);
            let refr = refract(rd, n_eff, eta);
            if (length(refr) < 0.01 || fres > 0.65) {
                ro = hp + n_eff * 0.01;
                rd = reflect(rd, n_eff);
                throughput *= vec3<f32>(0.92, 0.96, 1.0);
            } else {
                ro = hp - n_eff * 0.02;
                rd = normalize(refr);
                throughput *= vec3<f32>(0.90, 0.96, 1.0);
            }
        } else {
            let cos_v = clamp(-dot(rd, hit.normal), 0.0, 1.0);
            let refl_w = clamp(hit.metallic * 0.82 + pow(1.0 - cos_v, 4.0) * (1.0 - hit.roughness) * 0.55, 0.05, 0.92);
            accum += throughput * direct * (1.0 - refl_w);
            throughput *= mix(vec3<f32>(1.0), hit.albedo, hit.metallic) * refl_w;
            ro = hp + hit.normal * 0.01;
            rd = reflect(rd, hit.normal);
        }
    }

    return aces_tonemap(accum);
}

// =========================================================================
// SCENE 2: Volumetric Alpine Canyon, 3D Clouds & Reflective Ocean Ray-Marcher
// =========================================================================
fn canyon_height(p: vec2<f32>) -> f32 {
    let river = sin(p.y * 0.08) * 5.5;
    let dx = abs(p.x - river);
    let walls = smoothstep(2.2, 16.0, dx) * 9.5;
    let n1 = sin(p.x * 0.14) * cos(p.y * 0.12) * 2.4;
    let n2 = sin(p.x * 0.37 + 1.4) * sin(p.y * 0.31 - 0.6) * 0.95;
    let n3 = cos((p.x - p.y) * 0.85) * 0.28;
    return walls + (n1 + n2 + n3) * smoothstep(1.5, 9.0, dx) - 0.8;
}

fn render_canyon(uv: vec2<f32>, t: f32) -> vec3<f32> {
    let aspect = u.resolution.x / max(1.0, u.resolution.y);
    let p = vec2<f32>((uv.x - 0.5) * 2.0 * aspect, (0.5 - uv.y) * 2.0);

    let fly_z = t * 7.5;
    let river_x = sin(fly_z * 0.08) * 5.5;
    let ro = vec3<f32>(river_x + sin(t * 0.45) * 1.4, 3.6 + sin(t * 0.32) * 0.7, fly_z);
    let ahead_z = fly_z + 14.0;
    let ahead_x = sin(ahead_z * 0.08) * 5.5;
    var fwd = normalize(vec3<f32>(ahead_x - ro.x, -0.45 + u.cam_pitch * 2.5, 14.0));
    let yaw_r = rot2(u.cam_yaw * 0.65);
    let fxz = yaw_r * fwd.xz;
    fwd = normalize(vec3<f32>(fxz.x, fwd.y, fxz.y));
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
    let up = cross(fwd, right);
    let rd = normalize(fwd * 1.55 + right * p.x + up * p.y);

    let sun_dir = normalize(vec3<f32>(0.45, 0.32 + 0.08 * sin(t * 0.25), 0.84));
    let sun_amt = max(dot(rd, sun_dir), 0.0);
    var sky = mix(vec3<f32>(0.48, 0.68, 0.94), vec3<f32>(0.12, 0.28, 0.64), clamp(rd.y * 1.6, 0.0, 1.0));
    sky += vec3<f32>(1.0, 0.62, 0.28) * pow(sun_amt, 8.0) * 0.75;
    sky += vec3<f32>(1.6, 1.35, 0.95) * pow(sun_amt, 180.0);

    // Volumetric 3D Cloud Layer above y = 13..24
    if (rd.y > 0.02) {
        var cloud_alpha = 0.0;
        var cloud_lit = vec3<f32>(0.0);
        let t_cloud0 = (13.0 - ro.y) / rd.y;
        let t_cloud1 = (24.0 - ro.y) / rd.y;
        let step_c = (t_cloud1 - t_cloud0) / 14.0;
        for (var ci = 0; ci < 14; ci = ci + 1) {
            let tc = t_cloud0 + (f32(ci) + 0.5) * step_c;
            if (tc > 160.0 || cloud_alpha > 0.92) { break; }
            let cp = ro + rd * tc;
            let dens = clamp(fbm3(cp * 0.055 + vec3<f32>(t * 0.08, 0.0, t * 0.04)) - 0.48, 0.0, 1.0) * 1.65;
            if (dens > 0.01) {
                let light_d = clamp(0.42 + 0.58 * (cp.y - 13.0) / 11.0 + pow(sun_amt, 4.0) * 0.4, 0.0, 1.5);
                let c_col = mix(vec3<f32>(0.52, 0.60, 0.74), vec3<f32>(1.08, 0.98, 0.88), clamp(light_d, 0.0, 1.0));
                let a = dens * 0.34;
                cloud_lit += (1.0 - cloud_alpha) * c_col * a;
                cloud_alpha += (1.0 - cloud_alpha) * a;
            }
        }
        sky = sky * (1.0 - cloud_alpha) + cloud_lit;
    }

    // Raymarch Canyon Terrain & River Water (y = 0.0)
    var dist = 0.5;
    var hit_terrain = false;
    let max_m = i32(clamp(96.0 * u.stress_mult, 76.0, 140.0));
    for (var i = 0; i < 140; i = i + 1) {
        if (i >= max_m) { break; }
        let pos = ro + rd * dist;
        let h = canyon_height(pos.xz);
        let d = pos.y - h;
        if (d < 0.03 * dist * 0.08 + 0.015) {
            hit_terrain = true;
            break;
        }
        dist += max(0.18, d * 0.52);
        if (dist > 145.0) { break; }
    }

    let water_t = select(1e9, (0.0 - ro.y) / rd.y, rd.y < -0.001);
    var col = sky;

    if (water_t > 0.0 && water_t < dist && water_t < 145.0) {
        let wp = ro + rd * water_t;
        let w1 = sin(wp.x * 2.4 + t * 2.8) * cos(wp.z * 1.9 - t * 2.1);
        let w2 = cos(wp.x * 5.2 - wp.z * 4.4 + t * 4.0);
        let wn = normalize(vec3<f32>(w1 * 0.06 + w2 * 0.03, 1.0, w2 * 0.05));
        let fres = pow(1.0 - max(dot(-rd, wn), 0.0), 4.0);
        let refl_r = reflect(rd, wn);
        let refl_sky = mix(vec3<f32>(0.22, 0.44, 0.72), vec3<f32>(0.98, 0.84, 0.66), pow(max(dot(refl_r, sun_dir), 0.0), 8.0));
        let spec = pow(max(dot(refl_r, sun_dir), 0.0), 140.0) * 2.2;
        let deep = vec3<f32>(0.02, 0.14, 0.24);
        col = mix(deep, refl_sky, clamp(0.18 + fres * 0.82, 0.0, 1.0)) + vec3<f32>(1.0, 0.92, 0.76) * spec;
        let fog = 1.0 - exp(-water_t * 0.011);
        col = mix(col, sky, clamp(fog, 0.0, 1.0));
    } else if (hit_terrain) {
        let hp = ro + rd * dist;
        let e = 0.12;
        let n = normalize(vec3<f32>(
            canyon_height(hp.xz - vec2<f32>(e, 0.0)) - canyon_height(hp.xz + vec2<f32>(e, 0.0)),
            2.0 * e,
            canyon_height(hp.xz - vec2<f32>(0.0, e)) - canyon_height(hp.xz + vec2<f32>(0.0, e))
        ));
        let slope = 1.0 - n.y;
        // Biome layering: lush pine valley -> stratified granite cliff -> alpine snow caps
        var rock = mix(vec3<f32>(0.22, 0.34, 0.16), vec3<f32>(0.36, 0.31, 0.27), smoothstep(0.18, 0.48, slope));
        let strata = sin(hp.y * 2.8 + fbm3(hp * 0.4) * 3.0) * 0.08;
        rock += vec3<f32>(strata, strata * 0.8, strata * 0.6);
        let snow_mask = smoothstep(5.4, 8.2, hp.y) * smoothstep(0.55, 0.18, slope);
        let albedo = mix(rock, vec3<f32>(0.92, 0.95, 1.0), snow_mask);
        let diff = max(dot(n, sun_dir), 0.0);
        let sky_amb = 0.22 + 0.25 * max(n.y, 0.0);
        col = albedo * (vec3<f32>(0.36, 0.52, 0.82) * sky_amb + vec3<f32>(1.35, 1.12, 0.86) * diff);
        let fog = 1.0 - exp(-dist * 0.0105);
        col = mix(col, sky, clamp(fog, 0.0, 1.0));
    }

    return aces_tonemap(col);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    var col = vec3<f32>(0.0);
    if (u.scene_mode == 0u) {
        col = render_furmark(in.uv, u.time);
    } else if (u.scene_mode == 1u) {
        col = render_pathtrace(in.uv, u.time);
    } else {
        col = render_canyon(in.uv, u.time);
    }
    return vec4<f32>(pow(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), 1.0);
}
