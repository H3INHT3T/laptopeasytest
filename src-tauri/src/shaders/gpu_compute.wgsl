// LaptopBench QC v3.2.0 — Native wgpu Uncapped GPU FP32 Compute Benchmark Shader
// Measures raw shader FMA GFLOPS/TFLOPS independent of display VSync refresh rate
// and verifies deterministic finite outputs (detecting GPU ALU NaN/Inf faults).

struct BenchParams {
    seed: u32,
    iterations: u32,
    thread_count: u32,
    _pad: u32,
};

@group(0) @binding(0)
var<uniform> params: BenchParams;

@group(0) @binding(1)
var<storage, read_write> out_buf: array<f32>;

@compute @workgroup_size(64)
fn cs_fp32_bench(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.thread_count) {
        return;
    }

    let s = f32(((idx ^ params.seed) & 1023u) + 1u) * 0.0009765625;
    var a0: f32 = 0.5 + s;
    var a1: f32 = 0.75 - s * 0.5;
    var a2: f32 = 0.25 + s * 0.25;
    var a3: f32 = 1.0 - s * 0.375;
    var a4: f32 = 0.625 + s * 0.125;
    var a5: f32 = 0.375 + s * 0.5;
    var a6: f32 = 0.875 - s * 0.25;
    var a7: f32 = 0.125 + s * 0.75;

    let k1: f32 = 0.99993896;
    let k2: f32 = 0.00006104;
    let k3: f32 = -0.99987793;
    let k4: f32 = 1.00012207;

    // 16 FMA ops = 32 FP32 FLOPs per iteration per invocation
    for (var i: u32 = 0u; i < params.iterations; i = i + 1u) {
        a0 = fma(a0, k1, a1 * k2 + 0.0001);
        a1 = fma(a1, k1, a2 * k2 + 0.0002);
        a2 = fma(a2, k1, a3 * k2 + 0.0003);
        a3 = fma(a3, k1, a4 * k2 + 0.0004);
        a4 = fma(a4, k1, a5 * k2 + 0.0005);
        a5 = fma(a5, k1, a6 * k2 + 0.0006);
        a6 = fma(a6, k1, a7 * k2 + 0.0007);
        a7 = fma(a7, k1, a0 * k2 + 0.0008);

        a0 = fma(a0, k4, k3 * 0.0001);
        a1 = fma(a1, k4, k3 * 0.0002);
        a2 = fma(a2, k4, k3 * 0.0003);
        a3 = fma(a3, k4, k3 * 0.0004);
        a4 = fma(a4, k4, k3 * 0.0005);
        a5 = fma(a5, k4, k3 * 0.0006);
        a6 = fma(a6, k4, k3 * 0.0007);
        a7 = fma(a7, k4, k3 * 0.0008);
    }

    out_buf[idx] = (a0 + a1 + a2 + a3) - (a4 + a5 + a6 + a7);
}
