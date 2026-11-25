// LaptopBench QC — Native wgpu Procedural Raymarched Furry-Torus GPU Stress Shader
// Inspired by FurMark: pushes ALU, trigonometric, noise, and shading pipelines hard on DX12/Vulkan/Metal.

struct Uniforms {
    resolution: vec2<f32>,
    time: f32,
    stress_iters: f32,
};

@group(0) @binding(0)
var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // Fullscreen triangle
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 3.0,  1.0)
    );
    var out: VsOut;
    let p = positions[vid];
    out.pos = vec4<f32>(p, 0.0, 1.0);
    out.uv = p * 0.5 + 0.5;
    return out;
}

fn rot2d(a: f32) -> mat2x2<f32> {
    let c = cos(a);
    let s = sin(a);
    return mat2x2<f32>(c, -s, s, c);
}

fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

fn value_noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    let n000 = hash31(i + vec3<f32>(0.0, 0.0, 0.0));
    let n100 = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
    let n010 = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
    let n110 = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
    let n001 = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
    let n101 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
    let n011 = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
    let n111 = hash31(i + vec3<f32>(1.0, 1.0, 1.0));

    let nx00 = mix(n000, n100, u.x);
    let nx10 = mix(n010, n110, u.x);
    let nx01 = mix(n001, n101, u.x);
    let nx11 = mix(n011, n111, u.x);

    let nxy0 = mix(nx00, nx10, u.y);
    let nxy1 = mix(nx01, nx11, u.y);
    return mix(nxy0, nxy1, u.z);
}

fn fbm_fur(p: vec3<f32>) -> f32 {
    var val = 0.0;
    var amp = 0.52;
    var freq = 1.0;
    for (var i: i32 = 0; i < 4; i++) {
        val += amp * value_noise(p * freq);
        freq *= 2.15;
        amp *= 0.48;
    }
    return val;
}

fn sd_furry_torus(p_in: vec3<f32>) -> vec2<f32> {
    var p = p_in;
    let xz = rot2d(u.time * 0.72) * p.xz;
    p.x = xz.x;
    p.z = xz.y;
    let xy = rot2d(u.time * 0.45) * p.xy;
    p.x = xy.x;
    p.y = xy.y;

    let major_r = 1.12;
    let minor_r = 0.44;

    let q = vec2<f32>(length(p.xz) - major_r, p.y);
    let base_d = length(q) - minor_r;

    // Fur strand displacement along torus angular coordinates
    let theta = atan2(p.z, p.x);
    let phi = atan2(q.y, q.x);
    let strand_coord = vec3<f32>(theta * 14.0, phi * 12.0, u.time * 0.35);
    let fur = fbm_fur(strand_coord + p * 3.8);
    let spikes = sin(theta * 28.0 + fur * 6.2831) * cos(phi * 24.0 - fur * 5.0);
    let disp = (fur * 0.14 + spikes * 0.025);

    return vec2<f32>(base_d - disp, fur);
}

fn calc_normal(p: vec3<f32>) -> vec3<f32> {
    let e = 0.0025;
    let d = sd_furry_torus(p).x;
    let nx = sd_furry_torus(p + vec3<f32>(e, 0.0, 0.0)).x - d;
    let ny = sd_furry_torus(p + vec3<f32>(0.0, e, 0.0)).x - d;
    let nz = sd_furry_torus(p + vec3<f32>(0.0, 0.0, e)).x - d;
    return normalize(vec3<f32>(nx, ny, nz));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let frag = in.uv * 2.0 - 1.0;
    let aspect = u.resolution.x / max(u.resolution.y, 1.0);
    let p = vec2<f32>(frag.x * aspect, frag.y);

    // Camera setup
    let ro = vec3<f32>(0.0, 0.0, 3.15);
    let rd = normalize(vec3<f32>(p, -1.65));

    // Raymarch loop with configurable GPU stress depth
    let max_steps = i32(clamp(u.stress_iters, 32.0, 128.0));
    var t = 0.0;
    var hit = false;
    var fur_val = 0.0;
    var glow = 0.0;

    for (var i: i32 = 0; i < max_steps; i++) {
        let pos = ro + rd * t;
        let res = sd_furry_torus(pos);
        let d = res.x;
        glow += exp(-abs(d) * 5.5) * 0.018;
        if (d < 0.0025) {
            hit = true;
            fur_val = res.y;
            break;
        }
        t += max(d * 0.65, 0.012);
        if (t > 7.0) {
            break;
        }
    }

    // Dynamic thermal/plasma background vortex
    let bg_angle = atan2(p.y, p.x) + u.time * 0.5;
    let bg_r = length(p);
    let bg_wave = 0.5 + 0.5 * sin(bg_r * 12.0 - u.time * 3.0 + sin(bg_angle * 6.0));
    var col = mix(
        vec3<f32>(0.03, 0.05, 0.09),
        vec3<f32>(0.16, 0.07, 0.03),
        bg_wave * exp(-bg_r * 0.65)
    );

    if (hit) {
        let pos = ro + rd * t;
        let n = calc_normal(pos);
        let light1 = normalize(vec3<f32>(0.8, 0.9, 0.6));
        let light2 = normalize(vec3<f32>(-0.7, -0.5, 0.8));

        let diff1 = max(dot(n, light1), 0.0);
        let diff2 = max(dot(n, light2), 0.0);
        let fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

        let fur_base = mix(
            vec3<f32>(0.85, 0.32, 0.04),
            vec3<f32>(1.00, 0.78, 0.18),
            clamp(fur_val * 1.4, 0.0, 1.0)
        );
        let rim = vec3<f32>(0.15, 0.85, 1.0) * fresnel * 0.85;
        let spec = pow(max(dot(reflect(-light1, n), -rd), 0.0), 24.0);

        col = fur_base * (0.22 + diff1 * 0.95 + diff2 * 0.35) + rim + vec3<f32>(1.0, 0.95, 0.85) * spec * 0.65;
    }

    // Add fiery corona glow
    col += vec3<f32>(1.0, 0.42, 0.08) * glow;

    // Extra ALU stress pass (deterministic, zero visual artifact)
    var acc = 0.0;
    for (var k: i32 = 0; k < 16; k++) {
        let kf = f32(k);
        acc += sin(col.r * (kf + 1.0) + u.time) * cos(col.g * (kf + 2.0) - u.time);
    }
    col = clamp(col + vec3<f32>(acc * 0.0001), vec3<f32>(0.0), vec3<f32>(1.0));

    // Gamma encode
    col = pow(col, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(col, 1.0);
}
