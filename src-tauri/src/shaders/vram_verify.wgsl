// LaptopBench QC v2.0 — Native wgpu Compute Shader for Dedicated GPU VRAM Integrity Testing
// Writes & verifies deterministic bit patterns directly inside GPU VRAM at full GDDR/Unified bandwidth.

struct Params {
    seed: u32,
    pattern_mode: u32,
    word_count: u32,
    _pad: u32,
};

@group(0) @binding(0)
var<uniform> params: Params;

@group(0) @binding(1)
var<storage, read_write> vram_buf: array<u32>;

@group(0) @binding(2)
var<storage, read_write> error_counter: array<atomic<u32>>;

fn hash_u32(x_in: u32) -> u32 {
    var x = x_in;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

fn expected_word(idx: u32) -> u32 {
    if (params.pattern_mode == 0u) {
        // Alternating checkerboard 0xAAAA5555 ^ seed
        return select(0x5555AAAAu, 0xAAAA5555u, (idx & 1u) == 0u) ^ params.seed;
    } else if (params.pattern_mode == 1u) {
        // Walking 1-bit across 32-bit VRAM bus lines
        return (1u << ((idx + params.seed) & 31u)) ^ (idx * 0x9E3779B9u);
    } else if (params.pattern_mode == 2u) {
        // Inverted walking 0-bit
        return ~((1u << ((idx + params.seed) & 31u)) ^ params.seed);
    } else {
        // High-entropy PRNG hash per address
        return hash_u32(idx ^ params.seed) ^ (params.seed * 0x27d4eb2du);
    }
}

@compute @workgroup_size(256)
fn cs_write(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.word_count) {
        return;
    }
    vram_buf[idx] = expected_word(idx);
}

@compute @workgroup_size(256)
fn cs_verify(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.word_count) {
        return;
    }
    let got = vram_buf[idx];
    let exp = expected_word(idx);
    if (got != exp) {
        atomicAdd(&error_counter[0], 1u);
    }
}
