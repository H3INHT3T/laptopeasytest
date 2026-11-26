// LaptopBench QC v3.5.0 — Native GPU Top HUD Overlay Pass

@group(0) @binding(0)
var hud_tex: texture_2d<f32>;

@group(0) @binding(1)
var hud_samp: sampler;

struct HudVsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_hud(@builtin(vertex_index) idx: u32) -> HudVsOut {
    var verts = array<vec4<f32>, 6>(
        vec4<f32>(-1.0,  1.00, 0.0, 0.0),
        vec4<f32>(-1.0,  0.86, 0.0, 1.0),
        vec4<f32>( 1.0,  0.86, 1.0, 1.0),
        vec4<f32>(-1.0,  1.00, 0.0, 0.0),
        vec4<f32>( 1.0,  0.86, 1.0, 1.0),
        vec4<f32>( 1.0,  1.00, 1.0, 0.0)
    );
    let v = verts[idx];
    var out: HudVsOut;
    out.pos = vec4<f32>(v.x, v.y, 0.0, 1.0);
    out.uv = vec2<f32>(v.z, v.w);
    return out;
}

@fragment
fn fs_hud(in: HudVsOut) -> @location(0) vec4<f32> {
    return textureSample(hud_tex, hud_samp, in.uv);
}
