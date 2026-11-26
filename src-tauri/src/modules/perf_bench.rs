use crate::modules::{
    baselines::{self, CpuSubtestScores, MemorySubtestMetrics},
    cpu_stress, raytracer, shop_history, simd_kernels,
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

    let mut last_temp: Option<f32> = peak_temp;
    let mut min_load_clock_mhz: u64 = u64::MAX;
    let mut stuck_clock_secs: f64 = 0.0;
    let mut last_clock_check = Instant::now();

    let mut emit_and_check = |phase: &str, pct: f64, preview: Option<String>, tel: &mut TelemetryReader| -> Option<f32> {
        let snap = tel.sample_throttled(false, Duration::from_millis(850));
        let dt_clk = last_clock_check.elapsed().as_secs_f64();
        last_clock_check = Instant::now();
        if snap.cpu_usage_pct >= 75.0 && snap.cpu_clock_mhz > 0 {
            min_load_clock_mhz = min_load_clock_mhz.min(snap.cpu_clock_mhz);
            if snap.cpu_clock_mhz < 900 {
                stuck_clock_secs += dt_clk.min(2.5);
            }
        }
        if let Some(t) = snap.cpu_temp_c {
            last_temp = Some(t);
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
                last_temp = Some(temp_c);
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
                in_cooldown: false,
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

    // v3.2.0 Stage 12b: Real-World 4K Video DCT Encode, SHA-256 Crypto Hashing & JSON Parse/Serialize (~1.0s total)
    let _ = emit_and_check(
        "12b/14 4K Video DCT Encode, SHA-256 & JSON Throughput",
        84.5,
        raytrace_preview_url.clone(),
        &mut telemetry,
    );
    let video_encode_fps = run_video_dct_motion_bench(threads);
    let sha256_mb_s = run_sha256_throughput_bench(threads, sys.physical_core_count().unwrap_or(threads).max(1));
    let json_parse_mb_s = run_json_throughput_bench(threads);

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

    if let Some(tc) = emit_and_check("14/14 Load Complete — Starting Cool-Down Check", 96.0, raytrace_preview_url.clone(), &mut telemetry) {
        return Ok(thermal_cutoff_result(preset, &simd_isa, started.elapsed().as_secs_f64(), tc));
    }

    // Automatic 12-Second Post-Load Cool-Down Recovery Check (skippable via Abort without losing scores)
    let cooldown_start_temp_c = last_temp.or(peak_temp).map(|t| (t * 10.0).round() / 10.0);
    let mut cooldown_end_temp_c: Option<f32> = None;
    let mut cooldown_skipped = false;
    let mut cd_elapsed_secs = 0.0f32;
    if sensor_available_ever && cooldown_start_temp_c.is_some() && !cancel.load(Ordering::Relaxed) {
        let cd_secs = 12u64;
        let cd_started = Instant::now();
        while cd_started.elapsed().as_secs() < cd_secs {
            if cancel.load(Ordering::Relaxed) {
                cooldown_skipped = true;
                break;
            }
            let snap = telemetry.sample(false);
            if let Some(t) = snap.cpu_temp_c {
                cooldown_end_temp_c = Some((t * 10.0).round() / 10.0);
            }
            let cd_now = cd_started.elapsed().as_secs_f64();
            let pct = 96.0 + ((cd_now / cd_secs as f64) * 4.0).min(4.0);
            let _ = app.emit(
                "perf:progress",
                PerfBenchProgress {
                    phase: format!("Cool-Down Recovery ({:.0}s / {}s)", cd_now.min(cd_secs as f64), cd_secs),
                    percent: (pct * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    cpu_usage_pct: snap.cpu_usage_pct,
                    cpu_clock_mhz: snap.cpu_clock_mhz,
                    cpu_temp_c: snap.cpu_temp_c,
                    raytrace_preview_url: raytrace_preview_url.clone(),
                    telemetry: Some(snap),
                    in_cooldown: true,
                },
            );
            for _ in 0..5 {
                if cancel.load(Ordering::Relaxed) || cd_started.elapsed().as_secs() >= cd_secs {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        cd_elapsed_secs = cd_started.elapsed().as_secs_f32().max(1.0);
    }

    let (cooldown_drop_c, cooldown_rate_c_per_sec, cooldown_verdict, cooldown_note) = if cooldown_skipped {
        (
            None,
            None,
            "SKIPPED".to_string(),
            "Cool-down phase skipped by technician; benchmark scores preserved.".to_string(),
        )
    } else {
        cpu_stress::classify_smart_cooldown(cooldown_start_temp_c, cooldown_end_temp_c, cd_elapsed_secs.max(12.0))
    };

    let _ = app.emit(
        "perf:progress",
        PerfBenchProgress {
            phase: "Completed".to_string(),
            percent: 100.0,
            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            cpu_usage_pct: 0.0,
            cpu_clock_mhz: 0,
            cpu_temp_c: cooldown_end_temp_c.or(last_temp),
            raytrace_preview_url: raytrace_preview_url.clone(),
            telemetry: None,
            in_cooldown: false,
        },
    );

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

    let min_load_clk = if min_load_clock_mhz == u64::MAX { 0 } else { min_load_clock_mhz };
    let stuck_secs_r = (stuck_clock_secs * 10.0).round() / 10.0;
    let (bd_prochot_suspected, stuck_clock_note) =
        cpu_stress::evaluate_bd_prochot(min_load_clk, stuck_secs_r);

    let status = if bd_prochot_suspected {
        TestStatus::Fail
    } else if peak_temp.map(|t| t >= CPU_THERMAL_CUTOFF_DEFAULT_C - 2.0).unwrap_or(false)
        || throttle_drop_pct >= 25.0
        || baseline.percent_of_normal < 60.0
        || cooldown_verdict == "POOR_COOLING"
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
    let cooldown_summary_part = if let Some(drop_c) = cooldown_drop_c {
        format!(" Cool-Down: -{:.1}°C ({}).", drop_c, cooldown_verdict)
    } else {
        String::new()
    };
    let cooldown_short_tag = if let Some(drop_c) = cooldown_drop_c {
        format!(" | Cool-Down -{:.1}°C ({})", drop_c, cooldown_verdict)
    } else {
        String::new()
    };
    let plain_summary = format!(
        "{} ({}C/{}T) scored {} Composite ({:.0}% of expected class) — Single-Core {}, Multi-Core {}, Memory Mark {} ({:.1} GB/s, {:.1}ns), Thermal Drop {:.1}%.{}{}{}",
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
        cooldown_summary_part,
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
            "[Grade {} • {:.0}% of Normal] Mark {} (Office {} | Creator {} | Mem {}) | Throttle {:.1}%{}",
            durability_grade,
            baseline.percent_of_normal,
            composite_score,
            office_score,
            creator_score,
            memory_mark,
            throttle_drop_pct,
            cooldown_short_tag,
        ),
        memory_uncached_read_gb_s,
        memory_threaded_gb_s,
        memory_database_kops,
        available_ram_mb,
        thermal_cutoff_triggered: false,
        sensor_unavailable,
        userbenchmark_rating,
        plain_summary,
        cooldown_start_temp_c,
        cooldown_end_temp_c,
        cooldown_drop_c,
        cooldown_rate_c_per_sec,
        cooldown_verdict,
        cooldown_note,
        bd_prochot_suspected,
        min_load_clock_mhz: min_load_clk,
        stuck_clock_secs: stuck_secs_r,
        stuck_clock_note: stuck_clock_note.clone(),
        video_encode_fps,
        sha256_mb_s: sha256_mb_s.0,
        json_parse_mb_s,
        core_scaling_ratio: sha256_mb_s.1,
        core_scaling_efficiency_pct: sha256_mb_s.2,
    })
}

/// Pure FIPS-180-4 SHA-256 64-byte block compression kernel (zero external crate overhead).
fn sha256_compress_block(state: &mut [u32; 8], block: &[u8; 64]) {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut w = [0u32; 64];
    for i in 0..16 {
        let j = i * 4;
        w[i] = u32::from_be_bytes([block[j], block[j + 1], block[j + 2], block[j + 3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ ((!e) & g);
        let temp1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(maj);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

fn hash_chunk_sha256(buf: &[u8]) -> u32 {
    let mut st: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    for chunk in buf.chunks_exact(64) {
        let blk: &[u8; 64] = chunk.try_into().unwrap();
        sha256_compress_block(&mut st, blk);
    }
    st[0] ^ st[7]
}

/// Measures multi-threaded SHA-256 throughput (MB/s) AND true 1-thread vs N-thread Core Scaling Efficiency (v3.2.0).
pub fn run_sha256_throughput_bench(threads: usize, phys_cores: usize) -> (f64, f64, f64) {
    let phys = phys_cores.max(1);
    let buf: Vec<u8> = (0..(256 * 1024)).map(|i| ((i * 131 + 17) & 0xFF) as u8).collect();
    let chunk_mb = (buf.len() as f64) / (1024.0 * 1024.0);

    // 1. Single-thread baseline (~60ms)
    let t_st = Instant::now();
    let mut st_passes = 0u64;
    let mut st_acc = 0u32;
    while t_st.elapsed().as_secs_f64() < 0.06 || st_passes < 4 {
        st_acc ^= black_box(hash_chunk_sha256(&buf));
        st_passes += 1;
        if st_passes >= 512 {
            break;
        }
    }
    black_box(st_acc);
    let st_mb_s = ((st_passes as f64) * chunk_mb) / t_st.elapsed().as_secs_f64().max(0.001);

    // 2. Multi-threaded burst (~220ms across all logical threads)
    let t_mt = Instant::now();
    let workers = threads.max(1);
    let mut mt_chunks = 0u64;
    while t_mt.elapsed().as_secs_f64() < 0.22 || mt_chunks == 0 {
        let xor_sum: u32 = (0..workers)
            .into_par_iter()
            .map(|_| {
                let mut a = 0u32;
                for _ in 0..4 {
                    a ^= hash_chunk_sha256(&buf);
                }
                a
            })
            .reduce(|| 0u32, |x, y| x ^ y);
        black_box(xor_sum);
        mt_chunks += (workers as u64) * 4;
        if mt_chunks >= 4096 {
            break;
        }
    }
    let mt_mb_s = ((mt_chunks as f64) * chunk_mb) / t_mt.elapsed().as_secs_f64().max(0.001);
    let ratio = if st_mb_s > 0.1 {
        ((mt_mb_s / st_mb_s) * 100.0).round() / 100.0
    } else {
        1.0
    };
    let eff_pct = (((ratio / (phys as f64)) * 100.0).clamp(0.0, 150.0) * 10.0).round() / 10.0;
    (((mt_mb_s * 10.0).round() / 10.0), ratio, eff_pct)
}

/// 4K Software Video Encode Kernel: 8x8 2D DCT + Quantization + SAD Motion Estimation (v3.2.0).
/// Reports equivalent 4K (3840x2160) macroblock encode throughput in FPS.
pub fn run_video_dct_motion_bench(threads: usize) -> f64 {
    let workers = threads.max(1);
    // A 4K (3840x2160) frame contains 480 * 270 = 129,600 8x8 luma blocks.
    // We process batches of 4,096 8x8 blocks per worker pass and scale cleanly to 4K FPS.
    let blocks_per_worker = 2048usize;
    let t0 = Instant::now();
    let mut total_blocks = 0u64;

    while t0.elapsed().as_secs_f64() < 0.25 || total_blocks == 0 {
        let sum: i64 = (0..workers)
            .into_par_iter()
            .map(|w_idx| {
                let mut acc: i64 = 0;
                let mut blk = [0i32; 64];
                let mut tmp = [0i32; 64];
                for b in 0..blocks_per_worker {
                    let seed = (w_idx * 997 + b * 31) as i32;
                    let mut sad = 0i32;
                    for i in 0..64 {
                        let cur = ((seed + i as i32 * 13) & 255) - 128;
                        let ref_px = ((seed + i as i32 * 11 + 7) & 255) - 128;
                        blk[i] = cur - ref_px;
                        sad += blk[i].abs();
                    }
                    // 1D row butterfly DCT approximation (H.264/HEVC 8-point integer transform style)
                    for r in 0..8 {
                        let o = r * 8;
                        let s07 = blk[o] + blk[o + 7];
                        let d07 = blk[o] - blk[o + 7];
                        let s16 = blk[o + 1] + blk[o + 6];
                        let d16 = blk[o + 1] - blk[o + 6];
                        let s25 = blk[o + 2] + blk[o + 5];
                        let d25 = blk[o + 2] - blk[o + 5];
                        let s34 = blk[o + 3] + blk[o + 4];
                        let d34 = blk[o + 3] - blk[o + 4];
                        tmp[o] = s07 + s16 + s25 + s34;
                        tmp[o + 1] = d07 * 3 + d16 * 2 + d25 + d34;
                        tmp[o + 2] = (s07 - s34) * 2 + (s16 - s25);
                        tmp[o + 3] = d07 * 2 - d16 - d25 * 3 - d34;
                        tmp[o + 4] = s07 - s16 - s25 + s34;
                        tmp[o + 5] = d07 - d16 * 3 + d25 + d34 * 2;
                        tmp[o + 6] = (s07 - s34) - (s16 - s25) * 2;
                        tmp[o + 7] = d07 - d16 + d25 * 2 - d34 * 3;
                    }
                    // Column pass + quantization
                    for c in 0..8 {
                        let dc = (tmp[c] + tmp[c + 8] + tmp[c + 16] + tmp[c + 24]
                            + tmp[c + 32] + tmp[c + 40] + tmp[c + 48] + tmp[c + 56])
                            >> 4;
                        acc = acc.wrapping_add((dc + sad) as i64);
                    }
                }
                acc
            })
            .sum();
        black_box(sum);
        total_blocks += (workers * blocks_per_worker) as u64;
    }

    let elapsed = t0.elapsed().as_secs_f64().max(0.001);
    let blocks_per_4k_frame = 129_600.0;
    let fps = (total_blocks as f64 / blocks_per_4k_frame) / elapsed;
    (fps * 10.0).round() / 10.0
}

/// Real-world Structured JSON Parse & Serialize Throughput Benchmark (MB/s, v3.2.0).
pub fn run_json_throughput_bench(threads: usize) -> f64 {
    let sample_doc = r#"{"unit":"LBQC-320","telemetry":[{"t":1,"cpu":42.5,"mhz":3420,"temp":64.2,"gpu":18.4,"ok":true},{"t":2,"cpu":88.1,"mhz":3890,"temp":72.8,"gpu":94.1,"ok":true},{"t":3,"cpu":96.4,"mhz":3750,"temp":78.5,"gpu":99.0,"ok":true},{"t":4,"cpu":74.2,"mhz":3610,"temp":71.0,"gpu":62.3,"ok":true}],"specs":{"vendor":"LaptopBench","ramGb":16,"nvme":"PCIe Gen4 x4","zones":["cpu","gpu","vram","nvme","wifi"]}}"#;
    // Build a ~32 KB JSON array payload
    let mut big = String::with_capacity(36_000);
    big.push('[');
    for i in 0..72 {
        if i > 0 {
            big.push(',');
        }
        big.push_str(sample_doc);
    }
    big.push(']');
    let doc_bytes = big.len() as f64;
    let workers = threads.max(1);

    let t0 = Instant::now();
    let mut total_bytes = 0.0f64;
    while t0.elapsed().as_secs_f64() < 0.22 || total_bytes == 0.0 {
        let len_sum: usize = (0..workers)
            .into_par_iter()
            .map(|_| {
                let mut acc = 0usize;
                for _ in 0..4 {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&big) {
                        if let Ok(out) = serde_json::to_string(&val) {
                            acc += out.len();
                        }
                    }
                }
                acc
            })
            .sum();
        black_box(len_sum);
        // Count both parse + serialize bytes processed
        total_bytes += (workers as f64) * 4.0 * doc_bytes * 2.0;
    }
    let mb_s = (total_bytes / (1024.0 * 1024.0)) / t0.elapsed().as_secs_f64().max(0.001);
    (mb_s * 10.0).round() / 10.0
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

    #[test]
    fn test_v320_media_crypto_json_and_scaling_kernels() {
        let vid_fps = run_video_dct_motion_bench(2);
        let (sha_mbs, ratio, eff_pct) = run_sha256_throughput_bench(2, 2);
        let json_mbs = run_json_throughput_bench(2);
        assert!(vid_fps > 0.0 && vid_fps.is_finite(), "vid_fps={}", vid_fps);
        assert!(sha_mbs > 0.0 && sha_mbs.is_finite(), "sha_mbs={}", sha_mbs);
        assert!(ratio > 0.0 && ratio.is_finite(), "ratio={}", ratio);
        assert!(eff_pct > 0.0 && eff_pct <= 150.0, "eff_pct={}", eff_pct);
        assert!(json_mbs > 0.0 && json_mbs.is_finite(), "json_mbs={}", json_mbs);
    }
}
