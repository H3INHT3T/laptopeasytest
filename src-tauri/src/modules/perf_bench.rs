use crate::modules::{
    baselines::{self, CpuSubtestScores, MemorySubtestMetrics},
    raytracer, shop_history, simd_kernels,
    telemetry::{TelemetryReader, ThermalSafetyCheck},
    userbenchmark,
};
use crate::types::{
    BaselineRating, PerfBenchProgress, PerfBenchResult, ShopRecordSample, TestStatus,
    UserBenchmarkInput, CPU_THERMAL_CUTOFF_DEFAULT_C,
};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::hint::black_box;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::{AppHandle, Emitter};

fn count_primes_up_to(limit: usize) -> usize {
    let mut is_prime = vec![true; limit + 1];
    if limit >= 1 {
        is_prime[0] = false;
        is_prime[1] = false;
    }
    let mut p = 2;
    while p * p <= limit {
        if is_prime[p] {
            let mut m = p * p;
            while m <= limit {
                is_prime[m] = false;
                m += p;
            }
        }
        p += 1;
    }
    is_prime.into_iter().filter(|&b| b).count()
}

fn integer_math_workload(iters: u64, seed: u64) -> u64 {
    let mut a = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut b = seed ^ 0xBF58_476D_1CE4_E5B9;
    let mut c = 0x94D0_49BB_1331_11EBu64;
    for i in 0..iters {
        a = a.wrapping_mul(6364136223846793005).wrapping_add(b ^ i);
        b = (b.rotate_left(13)).wrapping_add(a ^ c);
        c = c.wrapping_mul(2862933555777941757).wrapping_add(b >> 7);
    }
    black_box(a ^ b ^ c)
}

fn float_fma_workload(n: usize) -> f64 {
    let mut a = vec![0.0f64; n * n];
    let mut b = vec![0.0f64; n * n];
    let mut c = vec![0.0f64; n * n];
    for i in 0..(n * n) {
        a[i] = ((i % 97) as f64) * 0.013 + 1.0;
        b[i] = ((i % 89) as f64) * 0.017 + 0.5;
    }
    for i in 0..n {
        for k in 0..n {
            let aik = a[i * n + k];
            let b_row = &b[k * n..(k + 1) * n];
            let c_row = &mut c[i * n..(i + 1) * n];
            for j in 0..n {
                c_row[j] = aik.mul_add(b_row[j], c_row[j]);
            }
        }
    }
    black_box(c.iter().sum())
}

#[allow(dead_code)]
fn vector_extended_scalar(x: &mut [f32], y: &[f32], z: &[f32], loops: usize) {
    let len = x.len();
    for _ in 0..loops {
        for i in 0..len {
            x[i] = x[i].mul_add(y[i], z[i]);
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn vector_extended_avx2(x: &mut [f32], y: &[f32], z: &[f32], loops: usize) {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    let len = x.len();
    for _ in 0..loops {
        let mut i = 0usize;
        while i + 8 <= len {
            let vx = _mm256_loadu_ps(x.as_ptr().add(i));
            let vy = _mm256_loadu_ps(y.as_ptr().add(i));
            let vz = _mm256_loadu_ps(z.as_ptr().add(i));
            let res = _mm256_fmadd_ps(vx, vy, vz);
            _mm256_storeu_ps(x.as_mut_ptr().add(i), res);
            i += 8;
        }
        while i < len {
            x[i] = x[i].mul_add(y[i], z[i]);
            i += 1;
        }
    }
}

#[cfg(target_arch = "aarch64")]
unsafe fn vector_extended_neon(x: &mut [f32], y: &[f32], z: &[f32], loops: usize) {
    use std::arch::aarch64::*;
    let len = x.len();
    for _ in 0..loops {
        let mut i = 0usize;
        while i + 4 <= len {
            let vx = vld1q_f32(x.as_ptr().add(i));
            let vy = vld1q_f32(y.as_ptr().add(i));
            let vz = vld1q_f32(z.as_ptr().add(i));
            let res = vfmaq_f32(vz, vx, vy);
            vst1q_f32(x.as_mut_ptr().add(i), res);
            i += 4;
        }
        while i < len {
            x[i] = x[i].mul_add(y[i], z[i]);
            i += 1;
        }
    }
}

fn vector_extended_workload(len: usize, loops: usize) -> f32 {
    let mut x = vec![1.001f32; len];
    let y = vec![0.9993f32; len];
    let z = vec![0.0007f32; len];

    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            unsafe { vector_extended_avx2(&mut x, &y, &z, loops) };
            return black_box(x.iter().sum());
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        unsafe { vector_extended_neon(&mut x, &y, &z, loops) };
        return black_box(x.iter().sum());
    }

    #[allow(unreachable_code)]
    {
        vector_extended_scalar(&mut x, &y, &z, loops);
        black_box(x.iter().sum())
    }
}

fn physics_nbody_workload(bodies: usize, steps: usize) -> f64 {
    let mut px = vec![0.0f64; bodies];
    let mut py = vec![0.0f64; bodies];
    let mut pz = vec![0.0f64; bodies];
    let mut vx = vec![0.0f64; bodies];
    let mut vy = vec![0.0f64; bodies];
    let mut vz = vec![0.0f64; bodies];
    for i in 0..bodies {
        let fi = i as f64;
        px[i] = (fi * 0.37).sin() * 10.0;
        py[i] = (fi * 0.53).cos() * 10.0;
        pz[i] = (fi * 0.19).sin() * 5.0;
    }
    for _ in 0..steps {
        for i in 0..bodies {
            let (mut fx, mut fy, mut fz) = (0.0, 0.0, 0.0);
            for j in 0..bodies {
                let dx = px[j] - px[i];
                let dy = py[j] - py[i];
                let dz = pz[j] - pz[i];
                let dist_sq = dx * dx + dy * dy + dz * dz + 0.01;
                let inv = 1.0 / (dist_sq * dist_sq.sqrt());
                fx += dx * inv;
                fy += dy * inv;
                fz += dz * inv;
            }
            vx[i] += fx * 0.01;
            vy[i] += fy * 0.01;
            vz[i] += fz * 0.01;
        }
        for i in 0..bodies {
            px[i] += vx[i] * 0.01;
            py[i] += vy[i] * 0.01;
            pz[i] += vz[i] * 0.01;
        }
    }
    black_box(px.iter().sum::<f64>() + py.iter().sum::<f64>())
}

fn compression_workload(size: usize) -> usize {
    let mut input = vec![0u8; size];
    for (i, b) in input.iter_mut().enumerate() {
        *b = ((i * 7 + (i >> 4) * 13) & 0x3F) as u8;
    }
    let mut dict = [0usize; 4096];
    let mut out_tokens = 0usize;
    let mut i = 0;
    while i + 4 < size {
        let h = (((input[i] as usize) << 8) ^ ((input[i + 1] as usize) << 4) ^ (input[i + 2] as usize)) & 4095;
        let prev = dict[h];
        dict[h] = i;
        if prev > 0 && i - prev < 4096 && input[prev..prev + 3] == input[i..i + 3] {
            out_tokens += 1;
            i += 3;
        } else {
            out_tokens += 1;
            i += 1;
        }
    }
    black_box(out_tokens)
}

fn database_ops_workload(seed: u64) -> u64 {
    let mut map: HashMap<u64, u64> = HashMap::with_capacity(32768);
    let mut rng = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    for i in 0..24_000u64 {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        map.insert(rng & 0xFFFF, i ^ rng);
    }
    let mut hits = 0u64;
    for _ in 0..48_000u64 {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        if let Some(v) = map.get(&(rng & 0xFFFF)) {
            hits = hits.wrapping_add(*v);
        }
    }
    black_box(hits)
}

fn measure_memory_latency_ns_cancellable(count: usize, cancel: &Arc<AtomicBool>) -> Option<f64> {
    let count = count.max(1024 * 1024);
    let mut next = vec![0u32; count];
    let mut perm: Vec<u32> = (0..count as u32).collect();
    let mut rng: u64 = 0x1234_5678_9ABC_DEF0;
    for i in (1..count).rev() {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let j = (rng as usize) % i;
        perm.swap(i, j);
    }
    for i in 0..count {
        next[perm[i] as usize] = perm[(i + 1) % count];
    }
    drop(perm);

    let hops: usize = 2_000_000;
    let mut cur = 0u32;
    let t0 = Instant::now();
    for h in 0..hops {
        if (h & 0x3FFFF) == 0 && cancel.load(Ordering::Relaxed) {
            return None;
        }
        cur = unsafe { *next.get_unchecked(cur as usize) };
    }
    black_box(cur);
    let ns = t0.elapsed().as_nanos() as f64 / hops as f64;
    Some((ns * 10.0).round() / 10.0)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum StageOutcome {
    Completed(f64),
    Cancelled,
    ThermalCutoff(f32),
}

pub(crate) fn run_timed_stage_with_probe<F, P>(
    stage_secs: f64,
    cancel: &Arc<AtomicBool>,
    mut probe_tick: P,
    mut unit_work: F,
) -> StageOutcome
where
    F: FnMut(u64),
    P: FnMut(f64) -> Option<f32>,
{
    let t0 = Instant::now();
    let mut last_tick = Instant::now() - Duration::from_millis(950);
    let mut overhead = Duration::ZERO;
    let mut units: u64 = 0;
    while t0.elapsed().saturating_sub(overhead).as_secs_f64() < stage_secs {
        if cancel.load(Ordering::Relaxed) {
            return StageOutcome::Cancelled;
        }
        unit_work(units);
        units += 1;
        if last_tick.elapsed().as_millis() >= 900 {
            let tick_t0 = Instant::now();
            let frac = (t0.elapsed().saturating_sub(overhead).as_secs_f64() / stage_secs).min(1.0);
            if let Some(cutoff_temp) = probe_tick(frac) {
                return StageOutcome::ThermalCutoff(cutoff_temp);
            }
            overhead += tick_t0.elapsed();
            last_tick = Instant::now();
        }
    }
    let work_secs = t0.elapsed().saturating_sub(overhead).as_secs_f64().max(0.001);
    StageOutcome::Completed(units as f64 / work_secs)
}

pub(crate) fn run_stage13_bw_phase<F, P>(
    stage_secs: f64,
    bytes_per_pass: f64,
    cancel: &Arc<AtomicBool>,
    probe_tick: P,
    pass_work: F,
) -> Result<f64, StageOutcome>
where
    F: FnMut(u64),
    P: FnMut(f64) -> Option<f32>,
{
    match run_timed_stage_with_probe(stage_secs, cancel, probe_tick, pass_work) {
        StageOutcome::Completed(passes_per_sec) => {
            let gb_s = (passes_per_sec * bytes_per_pass) / (1024.0 * 1024.0 * 1024.0);
            Ok((gb_s * 10.0).round() / 10.0)
        }
        other => Err(other),
    }
}

pub(crate) fn compute_calibrated_marks(
    cpu_subtests: &CpuSubtestScores,
    database_score: f64,
    creator_raytrace_score: f64,
    creator_ai_gemm_score: f64,
    creator_image_score: f64,
    mem_metrics: &MemorySubtestMetrics,
) -> (u64, u64, u64, u64, u64) {
    let multi_core_score = baselines::compute_cpu_mark_harmonic(cpu_subtests);
    let office_score = baselines::compute_office_mark_harmonic(
        cpu_subtests.single_core,
        cpu_subtests.compression,
        cpu_subtests.encryption,
        cpu_subtests.sorting,
        database_score,
    );
    let creator_score = baselines::compute_creator_mark_harmonic(
        creator_raytrace_score,
        creator_ai_gemm_score,
        creator_image_score,
    );
    let memory_mark = baselines::compute_memory_mark_harmonic(mem_metrics);
    let composite_score = baselines::compute_composite_mark_harmonic(
        cpu_subtests.single_core,
        multi_core_score as f64,
        creator_score as f64,
        ((memory_mark as f64) * 3.5).max(1.0),
    );
    (multi_core_score, office_score, creator_score, memory_mark, composite_score)
}

/// LaptopBench QC v2.0 Full 360° All-Scope Performance Suite:
/// 14 sustained stages covering PassMark 11 CPU/Memory, Office Productivity, Bare-Metal SIMD AI GEMM
/// (AVX2+FMA / ARM64 NEON), Cinebench-Style 3D Path-Tracing Renderer with live tile preview,
/// Creator 1080p Image Convolution, Hot-CPU Thermal Throttle Check, Factory Normal Rating,
/// and Auto-Learning Shop Model History comparison.
pub fn run_performance_benchmark(
    app: &AppHandle,
    preset: &str,
    manufacturer: Option<String>,
    model: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<PerfBenchResult, String> {
    let base_stage_secs: f64 = match preset {
        "standard" => 9.0, // ~2.2 minutes
        "burnin" => 18.0,  // ~4.5 minutes
        _ => 3.2,          // ~50-60 seconds Shop QC
    };

    let simd_isa = simd_kernels::detected_simd_isa().to_string();
    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let phys_cores = sys.physical_core_count().unwrap_or_else(|| sys.cpus().len());
    let log_cores = sys.cpus().len();

    let mut telemetry = TelemetryReader::new();
    let init_snap = telemetry.sample_throttled(false, Duration::from_millis(900));
    let mut peak_temp: Option<f32> = init_snap.cpu_temp_c;
    let mut sensor_available_ever = init_snap.cpu_temp_available;
    let mut sensor_unavailable = !sensor_available_ever;
    let started = Instant::now();
    let threads = rayon::current_num_threads().max(1);

    if let ThermalSafetyCheck::CutoffTriggered { temp_c, .. } =
        TelemetryReader::is_thermal_safe(&init_snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY)
    {
        return Ok(thermal_cutoff_result(
            preset,
            &simd_isa,
            started.elapsed().as_secs_f64(),
            temp_c,
        ));
    }

    let effective_stage_secs = if sensor_unavailable {
        base_stage_secs.min(6.0)
    } else {
        base_stage_secs
    };

    let mut emit_and_check = |phase: &str, pct: f64, preview: Option<String>, tel: &mut TelemetryReader| -> Option<f32> {
        let snap = tel.sample_throttled(false, Duration::from_millis(850));
        if let Some(t) = snap.cpu_temp_c {
            peak_temp = Some(peak_temp.map_or(t, |p| p.max(t)));
        }
        if snap.cpu_temp_available {
            sensor_available_ever = true;
            sensor_unavailable = false;
        } else if !sensor_available_ever {
            sensor_unavailable = true;
        }
        let cutoff = match TelemetryReader::is_thermal_safe(&snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY) {
            ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => {
                peak_temp = Some(peak_temp.map_or(temp_c, |p| p.max(temp_c)));
                Some(temp_c)
            }
            _ => None,
        };
        let _ = app.emit(
            "perf:progress",
            PerfBenchProgress {
                phase: phase.to_string(),
                percent: (pct * 10.0).round() / 10.0,
                elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                cpu_usage_pct: snap.cpu_usage_pct,
                cpu_clock_mhz: snap.cpu_clock_mhz,
                cpu_temp_c: snap.cpu_temp_c,
                raytrace_preview_url: preview,
                telemetry: Some(snap),
            },
        );
        cutoff
    };

    // Stage 1: Single-Core Sustained
    let sc_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("1/14 CPU Single-Threaded (Primes + ALU)", f * 6.5, None, &mut telemetry),
        |u| {
            black_box(count_primes_up_to(500_000 + (u as usize % 17)));
            black_box(integer_math_workload(4_000_000, u));
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let single_core_score = (sc_rate * 850.0).round() as u64;

    // Stage 2: Integer Math Multi-Core (captures early-thermal reference!)
    let mut early_int_rate = 0.0f64;
    let int_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("2/14 CPU Integer Math (All Cores)", 6.5 + f * 6.5, None, &mut telemetry),
        |u| {
            let t_u = Instant::now();
            let _: u64 = (0..threads * 2)
                .into_par_iter()
                .map(|i| integer_math_workload(8_000_000, u.wrapping_add(i as u64)))
                .sum();
            if u == 0 {
                early_int_rate = 1.0 / t_u.elapsed().as_secs_f64().max(0.001);
            }
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let integer_math_score = (int_rate * 2600.0).round() as u64;

    // Stage 3: Floating Point FP64 Matrix
    let fp_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("3/14 CPU Floating-Point FP64 Matrix", 13.0 + f * 6.5, None, &mut telemetry),
        |_| {
            let _: f64 = (0..threads).into_par_iter().map(|_| float_fma_workload(176)).sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let float_math_score = (fp_rate * 1900.0).round() as u64;

    // Stage 4: Prime Numbers Multi-Core
    let pr_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("4/14 CPU Prime Numbers Sieve", 19.5 + f * 6.5, None, &mut telemetry),
        |u| {
            let _: usize = (0..threads * 2)
                .into_par_iter()
                .map(|i| count_primes_up_to(450_000 + ((i + u as usize) % 19)))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let prime_score = (pr_rate * 2200.0).round() as u64;

    // Stage 5: Extended Vector Math (AVX2+FMA / ARM64 NEON intrinsics)
    let vec_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("5/14 CPU Extended Vector Math", 26.0 + f * 6.5, None, &mut telemetry),
        |_| {
            let _: f32 = (0..threads * 2)
                .into_par_iter()
                .map(|_| vector_extended_workload(65536, 30))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let vector_score = (vec_rate * 1800.0).round() as u64;

    // Stage 6: Office — LZ Data Compression
    let cmp_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("6/14 Office: Data Compression (LZ)", 32.5 + f * 6.5, None, &mut telemetry),
        |_| {
            let _: usize = (0..threads * 2)
                .into_par_iter()
                .map(|_| compression_workload(384 * 1024))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let compression_score = (cmp_rate * 2100.0).round() as u64;

    // Stage 7: Office — SHA-256 Encryption
    let enc_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("7/14 Office: SHA-256 Encryption", 39.0 + f * 6.5, None, &mut telemetry),
        |u| {
            let _: usize = (0..threads * 2)
                .into_par_iter()
                .map(|idx| {
                    let mut buf = vec![((idx + u as usize) & 0xFF) as u8; 65536];
                    let mut hasher = Sha256::new();
                    for iter in 0..40u8 {
                        buf[0] = iter;
                        hasher.update(&buf);
                        let out = hasher.finalize_reset();
                        buf[1..33].copy_from_slice(&out);
                    }
                    buf[1] as usize
                })
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let encryption_score = (enc_rate * 2000.0).round() as u64;

    // Stage 8: 3D N-Body Physics Simulation
    let phy_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("8/14 CPU 3D Physics Simulation", 45.5 + f * 6.5, None, &mut telemetry),
        |_| {
            let _: f64 = (0..threads).into_par_iter().map(|_| physics_nbody_workload(160, 10)).sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let physics_score = (phy_rate * 2300.0).round() as u64;

    // Stage 9: Office — Parallel Sorting
    let sort_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("9/14 Office: Parallel Dataset Sorting", 52.0 + f * 6.5, None, &mut telemetry),
        |u| {
            let _: u64 = (0..threads * 2)
                .into_par_iter()
                .map(|s| {
                    let mut arr: Vec<u64> = (0..120_000u64)
                        .map(|i| i.wrapping_mul(6364136223846793005).wrapping_add(u + s as u64))
                        .collect();
                    arr.sort_unstable();
                    arr[0]
                })
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let sorting_score = (sort_rate * 1950.0).round() as u64;

    // Stage 10: Office — Database Insert/Query Operations (also feeds Memory Mark DB Ops kOps/s!)
    let db_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check("10/14 Office: Database Query Operations", 58.5 + f * 6.5, None, &mut telemetry),
        |u| {
            let _: u64 = (0..threads)
                .into_par_iter()
                .map(|s| database_ops_workload(u.wrapping_add(s as u64)))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let database_score = (db_rate * 1450.0).round() as u64;
    let memory_database_kops = ((db_rate * threads as f64 * 72.0) * 10.0).round() / 10.0;

    // Stage 11: Creator / AI — Bare-Metal SIMD GEMM (AVX2+FMA / ARM64 NEON)
    let ai_label = format!("11/14 Creator AI Matrix GEMM ({})", simd_isa);
    let ai_rate = match run_timed_stage_with_probe(
        effective_stage_secs,
        &cancel,
        |f| emit_and_check(&ai_label, 65.0 + f * 7.0, None, &mut telemetry),
        |u| {
            let _: f32 = (0..threads)
                .into_par_iter()
                .map(|t| simd_kernels::simd_ai_gemm_step(160, (u as f32) + (t as f32) * 0.1))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let creator_ai_gemm_score = (ai_rate * 1150.0).round() as u64;

    // Stage 12: Creator — Cinebench-Style 3D Path-Tracing Renderer + Image Convolution
    let (rt_w, rt_h, rt_spp) = match preset {
        "burnin" => (640, 360, 8),
        "standard" => (512, 288, 6),
        _ => (448, 252, 4),
    };
    let rt_stage_cancel = Arc::new(AtomicBool::new(false));
    let mut rt_cutoff_temp: Option<f32> = None;
    let rt_out = raytracer::run_creator_raytrace_bench(
        rt_w,
        rt_h,
        rt_spp,
        (effective_stage_secs * 1.35).max(3.5),
        &rt_stage_cancel,
        |frac, preview| {
            if cancel.load(Ordering::Relaxed) {
                rt_stage_cancel.store(true, Ordering::Relaxed);
                return;
            }
            if let Some(tc) = emit_and_check(
                "12/14 Creator 3D Path-Tracing Renderer (Cinebench-Style)",
                72.0 + frac * 10.0,
                preview,
                &mut telemetry,
            ) {
                rt_cutoff_temp = Some(tc);
                rt_stage_cancel.store(true, Ordering::Relaxed);
            }
        },
    );
    if let Some(tc) = rt_cutoff_temp {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }
    let (creator_raytrace_score, creator_mega_rays_s, raytrace_preview_url) = match rt_out {
        Some(v) => v,
        None => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
    };

    // Quick Creator 1080p Image Sharpen Filter pass inside Stage 12
    let img_rate = match run_timed_stage_with_probe(
        (effective_stage_secs * 0.6).max(1.8),
        &cancel,
        |f| {
            emit_and_check(
                "12/14 Creator 1080p Image Convolution Filter",
                82.0 + f * 3.0,
                raytrace_preview_url.clone(),
                &mut telemetry,
            )
        },
        |_| {
            let _: u64 = (0..threads.min(4))
                .into_par_iter()
                .map(|_| simd_kernels::creator_image_filter_pass(960, 540))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };
    let creator_image_score = (img_rate * 1650.0).round() as u64;

    // Stage 13: Memory Suite — 7 PassMark Memory Subtests (DB Ops, Cached, Uncached >LLC, Write, Avail RAM, Latency >LLC, Threaded)
    if let Some(tc) = emit_and_check(
        "13/14 Memory Cached / Uncached / Write / Latency",
        85.5,
        raytrace_preview_url.clone(),
        &mut telemetry,
    ) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    sys.refresh_memory();
    let available_ram_mb = sys.available_memory() / (1024 * 1024);

    // 13a. Read Cached <=256 KB (8-way independent accumulators to measure true L1/L2 cache read throughput)
    let cache_buf = vec![0xA5A5_5A5A_1234_5678u64; 32768]; // 256 KB
    let t_c = Instant::now();
    let (mut s0, mut s1, mut s2, mut s3, mut s4, mut s5, mut s6, mut s7) =
        (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let c_iters = 12_000usize;
    for _ in 0..c_iters {
        for chunk in cache_buf.chunks_exact(8) {
            s0 = s0.wrapping_add(chunk[0]);
            s1 = s1.wrapping_add(chunk[1]);
            s2 = s2.wrapping_add(chunk[2]);
            s3 = s3.wrapping_add(chunk[3]);
            s4 = s4.wrapping_add(chunk[4]);
            s5 = s5.wrapping_add(chunk[5]);
            s6 = s6.wrapping_add(chunk[6]);
            s7 = s7.wrapping_add(chunk[7]);
        }
    }
    black_box(s0 ^ s1 ^ s2 ^ s3 ^ s4 ^ s5 ^ s6 ^ s7);
    let memory_cached_gb_s = (((c_iters as f64 * 256.0 * 1024.0) / (1024.0 * 1024.0 * 1024.0))
        / t_c.elapsed().as_secs_f64().max(0.0001)
        * 10.0)
        .round()
        / 10.0;

    // 13b. Write (>LLC buffer)
    let uncached_mb: usize = if available_ram_mb >= 2048 {
        128
    } else if available_ram_mb >= 1024 {
        64
    } else {
        32
    };
    let bytes_len = uncached_mb * 1024 * 1024;
    let src = vec![0x5Au8; bytes_len];
    let mut dst = vec![0u8; bytes_len];
    let memory_write_gb_s = match run_stage13_bw_phase(
        (effective_stage_secs * 0.4).max(1.0),
        bytes_len as f64,
        &cancel,
        |f| {
            emit_and_check(
                "13/14 Memory Write (>LLC)",
                85.5 + f * 1.5,
                raytrace_preview_url.clone(),
                &mut telemetry,
            )
        },
        |_| {
            dst.par_chunks_mut(1024 * 1024).for_each(|d| d.fill(0x3C));
        },
    ) {
        Ok(gb_s) => gb_s,
        Err(StageOutcome::Cancelled) => {
            return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64()))
        }
        Err(StageOutcome::ThermalCutoff(tc)) => {
            return Ok(thermal_cutoff_result(
                preset,
                &simd_isa,
                started.elapsed().as_secs_f64(),
                tc,
            ))
        }
        Err(StageOutcome::Completed(_)) => unreachable!(),
    };

    if let Some(tc) = emit_and_check(
        "13/14 Memory Uncached Read (>LLC)",
        87.0,
        raytrace_preview_url.clone(),
        &mut telemetry,
    ) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    // 13c. Read Uncached (>LLC single-stream read)
    let u64_len = bytes_len / std::mem::size_of::<u64>();
    let uncached_src_u64 = vec![0x5A5A_3C3C_1234_5678u64; u64_len];
    let mut ur_acc = 0u64;
    let memory_uncached_read_gb_s = match run_stage13_bw_phase(
        (effective_stage_secs * 0.35).max(0.9),
        bytes_len as f64,
        &cancel,
        |f| {
            emit_and_check(
                "13/14 Memory Uncached Read (>LLC)",
                87.0 + f * 1.2,
                raytrace_preview_url.clone(),
                &mut telemetry,
            )
        },
        |_| {
            let (mut r0, mut r1, mut r2, mut r3, mut r4, mut r5, mut r6, mut r7) =
                (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
            for c in uncached_src_u64.chunks_exact(8) {
                r0 = r0.wrapping_add(c[0]);
                r1 = r1.wrapping_add(c[1]);
                r2 = r2.wrapping_add(c[2]);
                r3 = r3.wrapping_add(c[3]);
                r4 = r4.wrapping_add(c[4]);
                r5 = r5.wrapping_add(c[5]);
                r6 = r6.wrapping_add(c[6]);
                r7 = r7.wrapping_add(c[7]);
            }
            ur_acc ^= r0 ^ r1 ^ r2 ^ r3 ^ r4 ^ r5 ^ r6 ^ r7;
        },
    ) {
        Ok(gb_s) => gb_s,
        Err(StageOutcome::Cancelled) => {
            return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64()))
        }
        Err(StageOutcome::ThermalCutoff(tc)) => {
            return Ok(thermal_cutoff_result(
                preset,
                &simd_isa,
                started.elapsed().as_secs_f64(),
                tc,
            ))
        }
        Err(StageOutcome::Completed(_)) => unreachable!(),
    };
    black_box(ur_acc);
    drop(uncached_src_u64);

    if let Some(tc) = emit_and_check(
        "13/14 Memory Threaded Copy (>LLC)",
        88.2,
        raytrace_preview_url.clone(),
        &mut telemetry,
    ) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    // 13d. Memory Threaded (all-core read+write copy)
    let memory_threaded_gb_s = match run_stage13_bw_phase(
        (effective_stage_secs * 0.45).max(1.1),
        bytes_len as f64 * 2.0,
        &cancel,
        |f| {
            emit_and_check(
                "13/14 Memory Threaded Copy (>LLC)",
                88.2 + f * 1.3,
                raytrace_preview_url.clone(),
                &mut telemetry,
            )
        },
        |_| {
            dst.par_chunks_mut(1024 * 1024)
                .zip(src.par_chunks(1024 * 1024))
                .for_each(|(d, s)| d.copy_from_slice(s));
        },
    ) {
        Ok(gb_s) => gb_s,
        Err(StageOutcome::Cancelled) => {
            return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64()))
        }
        Err(StageOutcome::ThermalCutoff(tc)) => {
            return Ok(thermal_cutoff_result(
                preset,
                &simd_isa,
                started.elapsed().as_secs_f64(),
                tc,
            ))
        }
        Err(StageOutcome::Completed(_)) => unreachable!(),
    };
    let memory_bandwidth_gb_s = memory_threaded_gb_s;
    drop(src);
    drop(dst);

    if let Some(tc) = emit_and_check(
        "13/14 Memory Pointer-Chase DRAM Latency (>LLC)",
        89.5,
        raytrace_preview_url.clone(),
        &mut telemetry,
    ) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    // 13e. Latency (>LLC: 64-128 MB working set)
    let latency_elems = if available_ram_mb >= 1536 {
        32 * 1024 * 1024 // 128 MB (u32)
    } else if available_ram_mb >= 768 {
        16 * 1024 * 1024 // 64 MB (u32)
    } else {
        8 * 1024 * 1024 // 32 MB fallback on tight RAM
    };
    let memory_latency_ns = match measure_memory_latency_ns_cancellable(latency_elems, &cancel) {
        Some(ns) => ns,
        None => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
    };

    // Stage 14: Sustained Hot-CPU Thermal Throttle Check
    let late_int_rate = match run_timed_stage_with_probe(
        (effective_stage_secs * 0.9).max(2.5),
        &cancel,
        |f| {
            emit_and_check(
                "14/14 Thermal Throttle Verification (Hot CPU)",
                91.0 + f * 8.0,
                raytrace_preview_url.clone(),
                &mut telemetry,
            )
        },
        |u| {
            let _: u64 = (0..threads * 2)
                .into_par_iter()
                .map(|i| integer_math_workload(8_000_000, u.wrapping_add(i as u64)))
                .sum();
        },
    ) {
        StageOutcome::Completed(r) => r,
        StageOutcome::Cancelled => return Ok(cancelled_result(preset, &simd_isa, started.elapsed().as_secs_f64())),
        StageOutcome::ThermalCutoff(tc) => return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc)),
    };

    let ref_rate = early_int_rate.max(int_rate).max(0.001);
    let throttle_drop_pct = (((ref_rate - late_int_rate) / ref_rate) * 100.0).clamp(0.0, 99.0);
    let throttle_drop_pct = (throttle_drop_pct * 10.0).round() / 10.0;

    if let Some(tc) = emit_and_check("Completed", 100.0, raytrace_preview_url.clone(), &mut telemetry) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    let cpu_subtests = CpuSubtestScores {
        single_core: single_core_score.max(1) as f64,
        integer_math: integer_math_score.max(1) as f64,
        float_math: float_math_score.max(1) as f64,
        prime: prime_score.max(1) as f64,
        vector_ext: vector_score.max(1) as f64,
        encryption: encryption_score.max(1) as f64,
        compression: compression_score.max(1) as f64,
        sorting: sorting_score.max(1) as f64,
        physics: physics_score.max(1) as f64,
    };
    let mem_metrics = MemorySubtestMetrics {
        database_kops: memory_database_kops.max(1.0),
        read_cached_mb_s: (memory_cached_gb_s * 1024.0).max(1.0),
        read_uncached_mb_s: (memory_uncached_read_gb_s * 1024.0).max(1.0),
        write_mb_s: (memory_write_gb_s * 1024.0).max(1.0),
        available_ram_mb: (available_ram_mb as f64).max(64.0),
        latency_ns: memory_latency_ns.max(1.0),
        threaded_mb_s: (memory_threaded_gb_s * 1024.0).max(1.0),
    };

    let (multi_core_score, office_score, creator_score, memory_mark, composite_score) =
        compute_calibrated_marks(
            &cpu_subtests,
            database_score.max(1) as f64,
            creator_raytrace_score.max(1) as f64,
            creator_ai_gemm_score.max(1) as f64,
            creator_image_score.max(1) as f64,
            &mem_metrics,
        );

    let baseline = baselines::rate_cpu_performance(
        &cpu_brand,
        phys_cores,
        log_cores,
        composite_score,
        throttle_drop_pct,
    );

    let durability_grade = baselines::compute_durability_grade(
        baseline.percent_of_normal,
        throttle_drop_pct,
        0,
        peak_temp.map(|t| t >= CPU_THERMAL_CUTOFF_DEFAULT_C).unwrap_or(false),
        false,
    );

    let ub_cmp = userbenchmark::compare_userbenchmark(&UserBenchmarkInput {
        cpu_brand: cpu_brand.clone(),
        cpu_physical_cores: Some(phys_cores),
        cpu_logical_cores: Some(log_cores),
        cpu_single_core: Some(single_core_score),
        cpu_multi_core: Some(multi_core_score),
        cpu_composite: Some(composite_score),
        ram_bandwidth_gb_s: Some(memory_bandwidth_gb_s),
        ram_latency_ns: Some(memory_latency_ns),
        allow_live_lookup: false,
        ..Default::default()
    });
    let userbenchmark_rating = ub_cmp.cpu;

    // Compare against prior shop history BEFORE recording this unit, then save!
    let mfr = manufacturer.unwrap_or_else(|| "Generic".into());
    let mdl = model.unwrap_or_else(|| cpu_brand.clone());
    let prior_comparison = shop_history::compare_against_shop(
        app,
        &mfr,
        &mdl,
        &cpu_brand,
        Some(composite_score as f64),
    );
    let _ = shop_history::record_sample(
        app,
        ShopRecordSample {
            manufacturer: mfr.clone(),
            model: mdl.clone(),
            cpu_brand: cpu_brand.clone(),
            composite_score: Some(composite_score as f64),
            office_score: Some(office_score as f64),
            creator_score: Some(creator_score as f64),
            memory_mark: Some(memory_mark as f64),
            gpu_fps: None,
            ssd_read_mb_s: None,
        },
    );
    let shop_comparison = if prior_comparison.found {
        Some(prior_comparison)
    } else {
        Some(shop_history::compare_against_shop(
            app,
            &mfr,
            &mdl,
            &cpu_brand,
            Some(composite_score as f64),
        ))
    };

    let tier = if composite_score >= 16500 {
        "Flagship Workstation / Gaming"
    } else if composite_score >= 10000 {
        "Creator / Pro Notebook"
    } else if composite_score >= 5600 {
        "Office / Productivity"
    } else {
        "Entry / Light Use"
    }
    .to_string();

    let status = if peak_temp.map(|t| t >= CPU_THERMAL_CUTOFF_DEFAULT_C - 2.0).unwrap_or(false)
        || throttle_drop_pct >= 25.0
        || baseline.percent_of_normal < 60.0
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let ub_summary_part = userbenchmark_rating
        .as_ref()
        .map(|u| format!(" UserBenchmark: {} ({:.0}% — {}).", u.vehicle_tier, u.effective_speed_pct, u.standing_label))
        .unwrap_or_default();
    let sensor_note = if sensor_unavailable {
        " CPU thermal sensor unavailable — stage durations safely bounded."
    } else {
        ""
    };
    let plain_summary = format!(
        "{} ({}C/{}T) scored {} Composite ({:.0}% of expected class) — Single-Core {}, Multi-Core {}, Memory Mark {} ({:.1} GB/s, {:.1}ns), Thermal Drop {:.1}%.{}{}",
        cpu_brand,
        phys_cores,
        log_cores,
        composite_score,
        baseline.percent_of_normal,
        single_core_score,
        multi_core_score,
        memory_mark,
        memory_bandwidth_gb_s,
        memory_latency_ns,
        throttle_drop_pct,
        ub_summary_part,
        sensor_note
    );

    Ok(PerfBenchResult {
        status,
        preset: preset.to_string(),
        simd_isa,
        integer_math_score,
        float_math_score,
        prime_score,
        vector_score,
        compression_score,
        encryption_score,
        physics_score,
        sorting_score,
        database_score,
        single_core_score,
        multi_core_score,
        office_score,
        creator_score,
        creator_raytrace_score,
        creator_mega_rays_s,
        creator_ai_gemm_score,
        creator_image_score,
        raytrace_preview_url,
        memory_cached_gb_s,
        memory_bandwidth_gb_s,
        memory_write_gb_s,
        memory_latency_ns,
        memory_mark,
        composite_score,
        throttle_drop_pct,
        tier: tier.clone(),
        durability_grade: durability_grade.clone(),
        peak_cpu_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        elapsed_secs: elapsed,
        cancelled: false,
        baseline: baseline.clone(),
        shop_comparison,
        summary: format!(
            "[Grade {} • {:.0}% of Normal] Mark {} (Office {} | Creator {} | Mem {}) | Throttle {:.1}%",
            durability_grade,
            baseline.percent_of_normal,
            composite_score,
            office_score,
            creator_score,
            memory_mark,
            throttle_drop_pct,
        ),
        memory_uncached_read_gb_s,
        memory_threaded_gb_s,
        memory_database_kops,
        available_ram_mb,
        thermal_cutoff_triggered: false,
        sensor_unavailable,
        userbenchmark_rating,
        plain_summary,
    })
}

fn thermal_cutoff_result(
    preset: &str,
    simd_isa: &str,
    elapsed: f64,
    temp_c: f32,
) -> PerfBenchResult {
    let rounded_t = (temp_c * 10.0).round() / 10.0;
    PerfBenchResult {
        status: TestStatus::Fail,
        preset: preset.to_string(),
        simd_isa: simd_isa.to_string(),
        tier: "Thermal Cutoff".to_string(),
        durability_grade: "FAIL".to_string(),
        peak_cpu_temp_c: Some(rounded_t),
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled: false,
        baseline: BaselineRating {
            detected_class: "Thermal Cutoff".into(),
            expected_normal: format!("< {:.0}°C", CPU_THERMAL_CUTOFF_DEFAULT_C),
            percent_of_normal: 0.0,
            grade: "FAIL".into(),
            verdict_note: format!(
                "Aborted mid-benchmark: CPU reached {:.1}°C (cutoff {:.0}°C).",
                rounded_t, CPU_THERMAL_CUTOFF_DEFAULT_C
            ),
        },
        shop_comparison: None,
        summary: format!(
            "CPU THERMAL CUTOFF at {:.1}°C (>= {:.0}°C) — benchmark halted safely.",
            rounded_t, CPU_THERMAL_CUTOFF_DEFAULT_C
        ),
        thermal_cutoff_triggered: true,
        plain_summary: format!(
            "CPU overheated to {:.1}°C (safety limit {:.0}°C) and halted mid-benchmark. Inspect cooling fan, heatsink, and thermal paste.",
            rounded_t, CPU_THERMAL_CUTOFF_DEFAULT_C
        ),
        ..Default::default()
    }
}

fn cancelled_result(preset: &str, simd_isa: &str, elapsed: f64) -> PerfBenchResult {
    PerfBenchResult {
        status: TestStatus::Warn,
        preset: preset.to_string(),
        simd_isa: simd_isa.to_string(),
        tier: "Cancelled".to_string(),
        durability_grade: "CANCELLED".to_string(),
        peak_cpu_temp_c: None,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled: true,
        baseline: BaselineRating {
            detected_class: "Cancelled".into(),
            expected_normal: "—".into(),
            percent_of_normal: 0.0,
            grade: "CANCELLED".into(),
            verdict_note: "Benchmark was stopped early by technician.".into(),
        },
        shop_comparison: None,
        summary: "Performance benchmark was cancelled.".to_string(),
        plain_summary: "Performance benchmark was stopped early by technician.".to_string(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::LiveTelemetrySnapshot;

    #[test]
    fn test_perf_bench_harmonic_scoring_and_calibration() {
        let balanced_cpu = CpuSubtestScores {
            single_core: 14000.0,
            integer_math: 14000.0,
            float_math: 14000.0,
            prime: 14000.0,
            vector_ext: 14000.0,
            encryption: 14000.0,
            compression: 14000.0,
            sorting: 14000.0,
            physics: 14000.0,
        };
        let healthy_mem = MemorySubtestMetrics {
            database_kops: 120.0,
            read_cached_mb_s: 36000.0,
            read_uncached_mb_s: 26000.0,
            write_mb_s: 24000.0,
            available_ram_mb: 16384.0,
            latency_ns: 65.0,
            threaded_mb_s: 42000.0,
        };
        let (mc, off, cr, mem, comp) = compute_calibrated_marks(
            &balanced_cpu,
            14000.0,
            14000.0,
            14000.0,
            14000.0,
            &healthy_mem,
        );
        assert_eq!(mc, 14000);
        assert_eq!(off, 14000);
        assert_eq!(cr, 14000);
        assert!(mem > 2000 && mem < 6000, "unexpected memory_mark {}", mem);
        // Normalized memory_mark * 3.5 keeps composite calibrated in expected laptop CPU range
        assert!(comp > 10500 && comp < 15000, "unexpected composite {}", comp);

        // Single-subtest bottleneck must pull harmonic score sharply down vs arithmetic mean
        let bottleneck_cpu = CpuSubtestScores {
            compression: 1500.0,
            ..balanced_cpu
        };
        let (mc_b, _, _, _, _) = compute_calibrated_marks(
            &bottleneck_cpu,
            14000.0,
            14000.0,
            14000.0,
            14000.0,
            &healthy_mem,
        );
        assert!(mc_b < 8000, "harmonic bottleneck failed: mc_b={}", mc_b);
    }

    #[test]
    fn test_timing_overhead_subtraction_and_thermal_cutoff() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut ticks = 0u32;
        let out = run_timed_stage_with_probe(
            0.08,
            &cancel,
            |_| {
                ticks += 1;
                std::thread::sleep(Duration::from_millis(25));
                None
            },
            |_| {
                std::thread::sleep(Duration::from_millis(5));
            },
        );
        match out {
            StageOutcome::Completed(rate) => {
                assert!(rate > 0.0);
                assert!(ticks >= 1);
            }
            other => panic!("expected Completed, got {:?}", other),
        }

        // Verify thermal cutoff aborts stage immediately
        let out_hot = run_timed_stage_with_probe(
            2.0,
            &cancel,
            |_| {
                let hot_snap = LiveTelemetrySnapshot {
                    cpu_temp_c: Some(93.5),
                    cpu_temp_available: true,
                    ..Default::default()
                };
                match TelemetryReader::is_thermal_safe(
                    &hot_snap,
                    CPU_THERMAL_CUTOFF_DEFAULT_C,
                    f32::INFINITY,
                ) {
                    ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => Some(temp_c),
                    _ => None,
                }
            },
            |_| {
                std::thread::sleep(Duration::from_millis(10));
            },
        );
        assert_eq!(out_hot, StageOutcome::ThermalCutoff(93.5));
    }

    #[test]
    fn test_vector_extended_workload_runs_cleanly() {
        let sum = vector_extended_workload(1024, 4);
        assert!(sum.is_finite() && sum > 1024.0);
    }

    #[test]
    fn test_stage13_mid_loop_thermal_cadence_and_cutoff() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut tick_times: Vec<Instant> = Vec::new();
        let res = run_stage13_bw_phase(
            1.05,
            128.0 * 1024.0 * 1024.0,
            &cancel,
            |_| {
                tick_times.push(Instant::now());
                std::thread::sleep(Duration::from_millis(15));
                None
            },
            |_| {
                std::thread::sleep(Duration::from_millis(10));
            },
        );
        let gb_s = res.expect("Stage 13 helper should complete without cutoff");
        assert!(gb_s > 0.0 && gb_s.is_finite(), "invalid gb_s: {}", gb_s);
        assert!(tick_times.len() >= 2, "expected >= 2 mid-loop polls over 1.05s, got {}", tick_times.len());
        for pair in tick_times.windows(2) {
            let gap_ms = pair[1].duration_since(pair[0]).as_millis();
            assert!(gap_ms <= 1000, "Stage 13 poll gap exceeded 1.0s: {} ms", gap_ms);
        }

        // Immediate ThermalCutoff mid-loop on a long (10s) stage
        let mut cutoff_ticks = 0u32;
        let t_start = Instant::now();
        let cutoff_res = run_stage13_bw_phase(
            10.0,
            128.0 * 1024.0 * 1024.0,
            &cancel,
            |_| {
                cutoff_ticks += 1;
                if cutoff_ticks >= 1 {
                    let hot_snap = LiveTelemetrySnapshot {
                        cpu_temp_c: Some(94.2),
                        cpu_temp_available: true,
                        ..Default::default()
                    };
                    if let ThermalSafetyCheck::CutoffTriggered { temp_c, .. } =
                        TelemetryReader::is_thermal_safe(
                            &hot_snap,
                            CPU_THERMAL_CUTOFF_DEFAULT_C,
                            f32::INFINITY,
                        )
                    {
                        return Some(temp_c);
                    }
                }
                None
            },
            |_| {
                std::thread::sleep(Duration::from_millis(10));
            },
        );
        assert_eq!(cutoff_res, Err(StageOutcome::ThermalCutoff(94.2)));
        assert!(
            t_start.elapsed() < Duration::from_secs(1),
            "Stage 13 thermal cutoff did not abort immediately"
        );

        // Immediate Cancel mid-loop
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel_flag.clone();
        let mut passes = 0u32;
        let cancel_res = run_stage13_bw_phase(
            10.0,
            128.0 * 1024.0 * 1024.0,
            &cancel_flag,
            |_| None,
            |_| {
                passes += 1;
                if passes >= 3 {
                    cancel_clone.store(true, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(5));
            },
        );
        assert_eq!(cancel_res, Err(StageOutcome::Cancelled));
    }
}
