// LaptopBench QC v3.5.0 — 500,000-Particle GPU Compute Flocking & Gravity Vortex

struct ParticleUniforms {
    time: f32,
    dt: f32,
    aspect: f32,
    particle_count: u32,
    attractor_x: f32,
    attractor_y: f32,
    zoom: f32,
    _pad: f32,
};

struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> pu: ParticleUniforms;

@group(0) @binding(1)
var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(256)
fn cs_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= pu.particle_count) {
        return;
    }

    var p = particles[idx];
    let t = pu.time;
    let dt = clamp(pu.dt, 0.001, 0.035);

    // Dual orbiting gravity wells + interactive user cursor attractor
    let w1 = vec2<f32>(cos(t * 0.9) * 0.52 + pu.attractor_x * 0.45, sin(t * 1.15) * 0.42 + pu.attractor_y * 0.45);
    let w2 = vec2<f32>(-cos(t * 0.72) * 0.56, -sin(t * 0.88) * 0.46);

    let d1 = w1 - p.pos;
    let r1 = dot(d1, d1) + 0.045;
    let f1 = d1 / (r1 * sqrt(r1)) * 0.34;

    let d2 = w2 - p.pos;
    let r2 = dot(d2, d2) + 0.055;
    let f2 = d2 / (r2 * sqrt(r2)) * 0.28;

    // Tangential vortex curl force
    let swirl = vec2<f32>(-d1.y, d1.x) / (r1 + 0.14) * 0.42 + vec2<f32>(d2.y, -d2.x) / (r2 + 0.18) * 0.32;

    // Subtle per-particle phase turbulence
    let phase = f32(idx & 1023u) * 0.00613;
    let turb = vec2<f32>(sin(p.pos.y * 5.0 + t + phase), cos(p.pos.x * 5.0 - t * 1.2 + phase)) * 0.18;

    p.vel = (p.vel + (f1 + f2 + swirl + turb) * dt) * (1.0 - 0.58 * dt);
    let spd = length(p.vel);
    if (spd > 2.6) {
        p.vel = p.vel * (2.6 / spd);
    }

    p.pos += p.vel * dt;

    if (abs(p.pos.x) > 1.38) {
        p.pos.x = clamp(p.pos.x, -1.38, 1.38);
        p.vel.x = -p.vel.x * 0.7;
    }
    if (abs(p.pos.y) > 1.18) {
        p.pos.y = clamp(p.pos.y, -1.18, 1.18);
        p.vel.y = -p.vel.y * 0.7;
    }

    particles[idx] = p;
}

struct VsParticleOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) color: vec3<f32>,
};

@vertex
fn vs_particle(
    @location(0) pos: vec2<f32>,
    @location(1) vel: vec2<f32>
) -> VsParticleOut {
    let spd = clamp(length(vel) * 0.72, 0.0, 1.0);
    let sc = clamp(pu.zoom, 0.5, 2.2);
    let sx = pos.x * sc / max(0.5, pu.aspect * 0.62);
    let sy = pos.y * sc;
    var out: VsParticleOut;
    out.clip_pos = vec4<f32>(sx, sy, 0.0, 1.0);
    let c_cool = vec3<f32>(0.08, 0.36, 0.98);
    let c_mid  = vec3<f32>(0.18, 0.88, 1.00);
    let c_hot  = vec3<f32>(1.00, 0.58, 0.16);
    let base = select(mix(c_mid, c_hot, (spd - 0.5) * 2.0), mix(c_cool, c_mid, spd * 2.0), spd < 0.5);
    out.color = base * (0.28 + 0.42 * spd);
    return out;
}

@fragment
fn fs_particle(in: VsParticleOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
