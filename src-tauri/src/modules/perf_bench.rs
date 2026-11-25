use crate::modules::baselines;
use crate::types::{BaselineRating, PerfBenchProgress, PerfBenchResult, TestStatus};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::hint::black_box;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use sysinfo::{Components, System};
use tauri::{AppHandle, Emitter};

fn read_cpu_telemetry(sys: &mut System, components: &mut Components) -> (f32, u64, Option<f32>) {
    sys.refresh_cpu_usage();
    sys.refresh_cpu_frequency();
    components.refresh(true);
    let usage = sys.global_cpu_usage();
    let clock_mhz = sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);
    let mut best_temp: Option<f32> = None;
    for comp in components.list() {
        let label = comp.label().to_lowercase();
        if label.contains("cpu")
            || label.contains("core")
            || label.contains("package")
            || label.contains("tdie")
            || label.contains("soc")
        {
            if let Some(t) = comp.temperature() {
                if t > 10.0 && t < 125.0 {
                    best_temp = Some(best_temp.map_or(t, |prev| prev.max(t)));
                }
            }
        }
    }
    (usage, clock_mhz, best_temp)
}

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

fn vector_extended_workload(len: usize, loops: usize) -> f32 {
    let mut x = vec![1.001f32; len];
    let y = vec![0.9993f32; len];
    let z = vec![0.0007f32; len];
    for _ in 0..loops {
        for i in 0..len {
            x[i] = x[i].mul_add(y[i], z[i]);
        }
    }
    black_box(x.iter().sum())
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

fn measure_memory_latency_ns() -> f64 {
    let count: usize = 4 * 1024 * 1024; // 32 MB exceeds laptop L3 cache
    let mut next = vec![0usize; count];
    let mut perm: Vec<usize> = (0..count).collect();
    let mut rng: u64 = 0x1234_5678_9ABC_DEF0;
    for i in (1..count).rev() {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let j = (rng as usize) % i;
        perm.swap(i, j);
    }
    for i in 0..count {
        next[perm[i]] = perm[(i + 1) % count];
    }
    drop(perm);

    let hops: usize = 2_000_000;
    let mut cur = 0usize;
    let t0 = Instant::now();
    for _ in 0..hops {
        cur = unsafe { *next.get_unchecked(cur) };
    }
    black_box(cur);
    let ns = t0.elapsed().as_nanos() as f64 / hops as f64;
    (ns * 10.0).round() / 10.0
}

/// Runs a calibrated workload repeatedly until `stage_secs` elapses so thermal/turbo behavior is truly measured!
fn run_timed_stage<F>(
    stage_secs: f64,
    cancel: &Arc<AtomicBool>,
    mut on_tick: impl FnMut(f64),
    mut unit_work: F,
) -> Option<f64>
where
    F: FnMut(u64),
{
    let t0 = Instant::now();
    let mut last_tick = Instant::now();
    let mut units: u64 = 0;
    while t0.elapsed().as_secs_f64() < stage_secs {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        unit_work(units);
        units += 1;
        if last_tick.elapsed().as_millis() >= 350 {
            on_tick((t0.elapsed().as_secs_f64() / stage_secs).min(1.0));
            last_tick = Instant::now();
        }
    }
    let elapsed = t0.elapsed().as_secs_f64().max(0.001);
    Some(units as f64 / elapsed)
}

pub fn run_performance_benchmark(
    app: &AppHandle,
    preset: &str,
    cancel: Arc<AtomicBool>,
) -> Result<PerfBenchResult, String> {
    // Sustained time-calibrated stages so the CPU truly warms up and exposes thermal throttling!
    // Quick Shop QC: ~3.5s x 12 stages ≈ 45-50s
    // Standard Durability: ~10s x 12 stages ≈ 2 min
    // Thermal Burn-in: ~20s x 12 stages ≈ 4 min
    let stage_secs: f64 = match preset {
        "standard" => 10.0,
        "burnin" => 20.0,
        _ => 3.5,
    };

    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let phys_cores = sys.physical_core_count().unwrap_or_else(|| sys.cpus().len());
    let log_cores = sys.cpus().len();

    let mut components = Components::new_with_refreshed_list();
    let mut peak_temp: Option<f32> = None;
    let started = Instant::now();
    let threads = rayon::current_num_threads().max(1);

    let mut emit = |phase: &str, pct: f64, sys: &mut System, comps: &mut Components| {
        let (usage, clock_mhz, temp) = read_cpu_telemetry(sys, comps);
        if let Some(t) = temp {
            peak_temp = Some(peak_temp.map_or(t, |p| p.max(t)));
        }
        let _ = app.emit(
            "perf:progress",
            PerfBenchProgress {
                phase: phase.to_string(),
                percent: (pct * 10.0).round() / 10.0,
                elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                cpu_usage_pct: (usage * 10.0).round() / 10.0,
                cpu_clock_mhz: clock_mhz,
                cpu_temp_c: temp.map(|t| (t * 10.0).round() / 10.0),
            },
        );
    };

    // Stage 1: Single-Core Sustained
    let sc_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("1/12 CPU Single-Threaded (Primes + ALU)", f * 8.0, &mut sys, &mut components),
        |u| {
            black_box(count_primes_up_to(500_000 + (u as usize % 17)));
            black_box(integer_math_workload(4_000_000, u));
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let single_core_score = (sc_rate * 850.0).round() as u64;

    // Stage 2: Integer Math Multi-Core (ALSO captures early-thermal reference throughput!)
    let mut early_int_rate = 0.0f64;
    let int_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("2/12 CPU Integer Math (All Cores)", 8.0 + f * 8.0, &mut sys, &mut components),
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
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let integer_math_score = (int_rate * 2600.0).round() as u64;

    // Stage 3: Floating Point FP64 Matrix
    let fp_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("3/12 CPU Floating-Point FP64 Matrix", 16.0 + f * 8.0, &mut sys, &mut components),
        |_| {
            let _: f64 = (0..threads)
                .into_par_iter()
                .map(|_| float_fma_workload(176))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let float_math_score = (fp_rate * 1900.0).round() as u64;

    // Stage 4: Prime Numbers Multi-Core
    let pr_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("4/12 CPU Prime Numbers Sieve", 24.0 + f * 8.0, &mut sys, &mut components),
        |u| {
            let _: usize = (0..threads * 2)
                .into_par_iter()
                .map(|i| count_primes_up_to(450_000 + ((i + u as usize) % 19)))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let prime_score = (pr_rate * 2200.0).round() as u64;

    // Stage 5: Extended Instructions / Vector Math
    let vec_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("5/12 CPU Extended Vector / SIMD", 32.0 + f * 8.0, &mut sys, &mut components),
        |_| {
            let _: f32 = (0..threads * 2)
                .into_par_iter()
                .map(|_| vector_extended_workload(65536, 30))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let vector_score = (vec_rate * 1800.0).round() as u64;

    // Stage 6: Data Compression (LZ)
    let cmp_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("6/12 CPU Data Compression (LZ)", 40.0 + f * 8.0, &mut sys, &mut components),
        |_| {
            let _: usize = (0..threads * 2)
                .into_par_iter()
                .map(|_| compression_workload(384 * 1024))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let compression_score = (cmp_rate * 2100.0).round() as u64;

    // Stage 7: SHA-256 Encryption
    let enc_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("7/12 CPU SHA-256 Encryption", 48.0 + f * 8.0, &mut sys, &mut components),
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
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let encryption_score = (enc_rate * 2000.0).round() as u64;

    // Stage 8: 3D N-Body Physics Simulation
    let phy_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("8/12 CPU 3D Physics Simulation", 56.0 + f * 8.0, &mut sys, &mut components),
        |_| {
            let _: f64 = (0..threads)
                .into_par_iter()
                .map(|_| physics_nbody_workload(160, 10))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let physics_score = (phy_rate * 2300.0).round() as u64;

    // Stage 9: Parallel Sorting
    let sort_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("9/12 CPU Parallel Sorting", 64.0 + f * 8.0, &mut sys, &mut components),
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
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let sorting_score = (sort_rate * 1950.0).round() as u64;

    // Stage 10: Database Operations (PassMark Memory/CPU Mixed HashMap Workload)
    let db_rate = match run_timed_stage(
        stage_secs,
        &cancel,
        |f| emit("10/12 Database Operations (Insert/Query)", 72.0 + f * 8.0, &mut sys, &mut components),
        |u| {
            let _: u64 = (0..threads)
                .into_par_iter()
                .map(|s| database_ops_workload(u.wrapping_add(s as u64)))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };
    let database_score = (db_rate * 1450.0).round() as u64;

    // Stage 11: Memory Suite — Cached Read, Uncached Read/Copy, Write & DRAM Pointer-Chase Latency
    emit("11/12 Memory Cached / Uncached / Write / Latency", 82.0, &mut sys, &mut components);
    // Cached (256 KB stays inside L2/L3 cache)
    let cache_buf = vec![0xA5u64; 32768]; // 256 KB
    let t_c = Instant::now();
    let mut c_sum = 0u64;
    let c_iters = 4000usize;
    for _ in 0..c_iters {
        for &x in &cache_buf {
            c_sum = c_sum.wrapping_add(x);
        }
    }
    black_box(c_sum);
    let memory_cached_gb_s = (((c_iters as f64 * 256.0 * 1024.0) / (1024.0 * 1024.0 * 1024.0))
        / t_c.elapsed().as_secs_f64().max(0.0001)
        * 10.0)
        .round()
        / 10.0;

    // Uncached Threaded Read/Copy & Write (64 MB > L3 cache)
    let bytes_len = 64 * 1024 * 1024;
    let src = vec![0x5Au8; bytes_len];
    let mut dst = vec![0u8; bytes_len];
    let mut mem_passes = 0u64;
    let t_mw = Instant::now();
    while t_mw.elapsed().as_secs_f64() < (stage_secs * 0.45).max(1.2) {
        if cancel.load(Ordering::Relaxed) {
            return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
        }
        dst.par_chunks_mut(1024 * 1024).for_each(|d| d.fill(0x3C));
        mem_passes += 1;
    }
    let memory_write_gb_s = (((mem_passes as f64 * bytes_len as f64) / (1024.0 * 1024.0 * 1024.0))
        / t_mw.elapsed().as_secs_f64().max(0.001)
        * 10.0)
        .round()
        / 10.0;

    let mut copy_passes = 0u64;
    let t_mc = Instant::now();
    while t_mc.elapsed().as_secs_f64() < (stage_secs * 0.55).max(1.5) {
        if cancel.load(Ordering::Relaxed) {
            return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
        }
        dst.par_chunks_mut(1024 * 1024)
            .zip(src.par_chunks(1024 * 1024))
            .for_each(|(d, s)| d.copy_from_slice(s));
        copy_passes += 1;
    }
    let memory_bandwidth_gb_s = (((copy_passes as f64 * (bytes_len as f64 * 2.0))
        / (1024.0 * 1024.0 * 1024.0))
        / t_mc.elapsed().as_secs_f64().max(0.001)
        * 10.0)
        .round()
        / 10.0;

    let memory_latency_ns = measure_memory_latency_ns();
    let memory_mark = (memory_bandwidth_gb_s * 90.0
        + memory_write_gb_s * 35.0
        + (14000.0 / memory_latency_ns.max(12.0)))
        .round() as u64;

    // Stage 12: Sustained Thermal Throttle Check (re-runs Stage 2 ALU workload while CPU is hot!)
    let late_int_rate = match run_timed_stage(
        (stage_secs * 0.9).max(2.5),
        &cancel,
        |f| emit("12/12 Thermal Throttle Verification (Hot CPU)", 90.0 + f * 9.0, &mut sys, &mut components),
        |u| {
            let _: u64 = (0..threads * 2)
                .into_par_iter()
                .map(|i| integer_math_workload(8_000_000, u.wrapping_add(i as u64)))
                .sum();
        },
    ) {
        Some(r) => r,
        None => return Ok(cancelled_result(preset, started.elapsed().as_secs_f64())),
    };

    let ref_rate = early_int_rate.max(int_rate).max(0.001);
    let throttle_drop_pct = (((ref_rate - late_int_rate) / ref_rate) * 100.0).clamp(0.0, 99.0);
    let throttle_drop_pct = (throttle_drop_pct * 10.0).round() / 10.0;

    emit("Completed", 100.0, &mut sys, &mut components);

    let multi_core_score = ((integer_math_score
        + float_math_score
        + prime_score
        + vector_score
        + compression_score
        + encryption_score
        + physics_score
        + sorting_score
        + database_score) as f64
        / 9.0)
        .round() as u64;

    let composite_score = (single_core_score as f64 * 0.22
        + multi_core_score as f64 * 0.58
        + memory_mark as f64 * 0.20)
        .round() as u64;

    let baseline = baselines::rate_cpu_performance(
        &cpu_brand,
        phys_cores,
        log_cores,
        composite_score,
        throttle_drop_pct,
    );

    let tier = if composite_score >= 16000 {
        "High-Performance / Gaming"
    } else if composite_score >= 9500 {
        "Workstation / Pro Notebook"
    } else if composite_score >= 5200 {
        "Office / Productivity"
    } else {
        "Entry / Light Use"
    }
    .to_string();

    let status = if peak_temp.map(|t| t >= 100.0).unwrap_or(false)
        || throttle_drop_pct >= 25.0
        || baseline.percent_of_normal < 60.0
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    Ok(PerfBenchResult {
        status,
        preset: preset.to_string(),
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
        memory_cached_gb_s,
        memory_bandwidth_gb_s,
        memory_write_gb_s,
        memory_latency_ns,
        memory_mark,
        composite_score,
        throttle_drop_pct,
        tier: tier.clone(),
        peak_cpu_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        elapsed_secs: elapsed,
        cancelled: false,
        baseline: baseline.clone(),
        summary: format!(
            "[{} — {:.0}% of Normal] Mark {} ({}) | Throttle Drop: {:.1}% | Mem {:.1} GB/s ({:.1} ns)",
            baseline.grade,
            baseline.percent_of_normal,
            composite_score,
            tier,
            throttle_drop_pct,
            memory_bandwidth_gb_s,
            memory_latency_ns
        ),
    })
}

fn cancelled_result(preset: &str, elapsed: f64) -> PerfBenchResult {
    PerfBenchResult {
        status: TestStatus::Warn,
        preset: preset.to_string(),
        integer_math_score: 0,
        float_math_score: 0,
        prime_score: 0,
        vector_score: 0,
        compression_score: 0,
        encryption_score: 0,
        physics_score: 0,
        sorting_score: 0,
        database_score: 0,
        single_core_score: 0,
        multi_core_score: 0,
        memory_cached_gb_s: 0.0,
        memory_bandwidth_gb_s: 0.0,
        memory_write_gb_s: 0.0,
        memory_latency_ns: 0.0,
        memory_mark: 0,
        composite_score: 0,
        throttle_drop_pct: 0.0,
        tier: "Cancelled".to_string(),
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
        summary: "Performance benchmark was cancelled.".to_string(),
    }
}
