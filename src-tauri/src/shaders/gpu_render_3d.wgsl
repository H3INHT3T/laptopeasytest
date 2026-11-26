// LaptopBench QC v3.3.0 — Native Uncapped 1080p 3D Ray-Traced Studio & Terrain Shader
// Runs directly on DX12 / Vulkan / Metal via wgpu with ZERO VSync cap to measure true GPU 3D FPS.

struct RenderUniforms {
    resolution: vec2<f32>,
    time: f32,
    pad: f32,
};

@group(0) @binding(0)
var<uniform> u: RenderUniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var pts = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    );
    var out: VsOut;
    let p = pts[vid];
    out.pos = vec4<f32>(p, 0.0, 1.0);
    out.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}

fn hash21(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u2 = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}

fn fbm(p_in: vec2<f32>) -> f32 {
    var p = p_in;
    var v = 0.0;
    var a = 0.52;
    for (var i = 0; i < 4; i++) {
        v += a * noise2(p);
        p = vec2<f32>(p.x * 1.92 - p.y * 0.62, p.x * 0.62 + p.y * 1.92);
        a *= 0.5;
    }
    return v;
}

fn terrain_h(xz: vec2<f32>) -> f32 {
    let ridge = fbm(xz * 0.24) * 2.4 - 1.15;
    let valley = smoothstep(0.4, 3.2, abs(xz.x - sin(xz.y * 0.28) * 1.4));
    return ridge * valley - 0.55;
}

fn map_scene(p: vec3<f32>, t: f32) -> vec2<f32> {
    // 1. Reflective metallic central orb hovering over canyon water
    let orb_c = vec3<f32>(sin(t * 0.9) * 0.85, 0.55 + sin(t * 1.7) * 0.16, 0.0);
    let d_orb = length(p - orb_c) - 0.68;

    // 2. Orbiting emissive gold satellite
    let sat_c = orb_c + vec3<f32>(cos(t * 2.1) * 1.35, 0.28 * sin(t * 2.6), sin(t * 2.1) * 1.35);
    let d_sat = length(p - sat_c) - 0.24;

    // 3. Procedural canyon terrain & water plane
    let d_terr = p.y - terrain_h(p.xz + vec2<f32>(0.0, t * 1.8));
    let d_water = p.y + 0.42;

    var res = vec2<f32>(d_terr, 1.0);
    if (d_water < res.x) { res = vec2<f32>(d_water, 2.0); }
    if (d_orb < res.x) { res = vec2<f32>(d_orb, 3.0); }
    if (d_sat < res.x) { res = vec2<f32>(d_sat, 4.0); }
    return res;
}

fn calc_normal(p: vec3<f32>, t: f32) -> vec3<f32> {
    let e = vec2<f32>(0.004, 0.0);
    return normalize(vec3<f32>(
        map_scene(p + e.xyy, t).x - map_scene(p - e.xyy, t).x,
        map_scene(p + e.yxy, t).x - map_scene(p - e.yxy, t).x,
        map_scene(p + e.yyx, t).x - map_scene(p - e.yyx, t).x,
    ));
}

fn sky_col(rd: vec3<f32>, sun_dir: vec3<f32>) -> vec3<f32> {
    let horiz = clamp(1.0 - max(rd.y, 0.0), 0.0, 1.0);
    var col = mix(vec3<f32>(0.10, 0.28, 0.62), vec3<f32>(0.68, 0.80, 0.94), pow(horiz, 2.4));
    let sun_dot = max(dot(rd, sun_dir), 0.0);
    col += vec3<f32>(1.0, 0.78, 0.48) * pow(sun_dot, 12.0) * 0.45;
    col += vec3<f32>(1.0, 0.96, 0.88) * pow(sun_dot, 180.0) * 1.4;
    return col;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let asp = u.resolution.x / max(u.resolution.y, 1.0);
    let p = (in.uv * 2.0 - vec2<f32>(1.0, 1.0)) * vec2<f32>(asp, -1.0);
    let t = u.time;

    let ro = vec3<f32>(sin(t * 0.45) * 1.2, 1.15, -3.6);
    let ta = vec3<f32>(0.0, 0.25, 0.4);
    let cw = normalize(ta - ro);
    let cu = normalize(cross(cw, vec3<f32>(0.0, 1.0, 0.0)));
    let cv = cross(cu, cw);
    let rd = normalize(p.x * cu + p.y * cv + 1.55 * cw);
    let sun_dir = normalize(vec3<f32>(0.55, 0.42, 0.72));

    var dist = 0.0;
    var mat = 0.0;
    for (var i = 0; i < 64; i++) {
        let h = map_scene(ro + rd * dist, t);
        if (h.x < 0.0025 || dist > 26.0) {
            mat = h.y;
            break;
        }
        dist += h.x * 0.72;
    }

    var col = sky_col(rd, sun_dir);
    if (dist < 26.0 && mat > 0.5) {
        let pos = ro + rd * dist;
        let n = calc_normal(pos, t);
        let diff = max(dot(n, sun_dir), 0.0);
        let half_v = normalize(sun_dir - rd);
        let spec = pow(max(dot(n, half_v), 0.0), 48.0);
        let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

        if (mat < 1.5) {
            // Alpine rock + snow peaks + valley moss
            let snow = smoothstep(0.32, 0.85, pos.y) * smoothstep(0.35, 0.78, n.y);
            let grass = smoothstep(-0.4, 0.12, pos.y) * smoothstep(0.55, 0.9, n.y);
            var alb = mix(vec3<f32>(0.24, 0.25, 0.28), vec3<f32>(0.18, 0.34, 0.22), grass);
            alb = mix(alb, vec3<f32>(0.92, 0.95, 0.99), snow);
            col = alb * (0.24 + 0.92 * diff) + vec3<f32>(0.9, 0.95, 1.0) * spec * 0.2;
        } else if (mat < 2.5) {
            // Ocean water with Fresnel reflection
            let wn = normalize(n + vec3<f32>(sin(pos.x * 7.0 + t * 3.0) * 0.04, 0.0, cos(pos.z * 6.5 - t * 2.5) * 0.04));
            let refl = sky_col(reflect(rd, wn), sun_dir);
            let deep = vec3<f32>(0.03, 0.16, 0.34);
            col = mix(deep, refl, 0.35 + 0.6 * fres) + vec3<f32>(1.0, 0.95, 0.82) * spec * 0.9;
        } else if (mat < 3.5) {
            // Chrome mirror orb
            let refl = sky_col(reflect(rd, n), sun_dir);
            col = refl * vec3<f32>(0.88, 0.94, 1.0) + vec3<f32>(0.2, 0.5, 1.0) * fres * 0.55 + vec3<f32>(1.0) * spec;
        } else {
            // Golden glowing satellite
            col = vec3<f32>(1.0, 0.72, 0.24) * (0.55 + 0.8 * diff) + vec3<f32>(1.0, 0.92, 0.7) * spec;
        }
        let fog = 1.0 - exp(-0.0045 * dist * dist);
        col = mix(col, sky_col(rd, sun_dir), clamp(fog, 0.0, 1.0));
    }

    // Filmic tone-mapping & gamma
    col = col / (col + vec3<f32>(1.0));
    col = pow(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.4545));
    return vec4<f32>(col, 1.0);
}
