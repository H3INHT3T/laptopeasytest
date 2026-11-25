use crate::types::{PerfBenchProgress, PerfBenchResult, TestStatus};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::hint::black_box;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use sysinfo::{Components, System};
use tauri::{AppHandle, Emitter};

fn read_cpu_telemetry(sys: &mut System, components: &mut Components) -> (f32, Option<f32>) {
    sys.refresh_cpu_usage();
    components.refresh(true);
    let usage = sys.global_cpu_usage();
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
    (usage, best_temp)
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
    // Simple LZ-style dictionary hash compression pass over realistic semi-structured data
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

fn measure_memory_latency_ns() -> f64 {
    // 32 MB shuffled pointer-chase ring (exceeds typical laptop L3 cache to measure true DRAM latency)
    let count: usize = 4 * 1024 * 1024; // 4M * 8 bytes = 32 MB
    let mut next = vec![0usize; count];
    // Sattolo cycle guarantees a single cycle visiting all indices randomly
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

    let hops: usize = 1_500_000;
    let mut cur = 0usize;
    let t0 = Instant::now();
    for _ in 0..hops {
        cur = unsafe { *next.get_unchecked(cur) };
    }
    black_box(cur);
    let ns = t0.elapsed().as_nanos() as f64 / hops as f64;
    (ns * 10.0).round() / 10.0
}

pub fn run_performance_benchmark(
    app: &AppHandle,
    preset: &str,
    cancel: Arc<AtomicBool>,
) -> Result<PerfBenchResult, String> {
    let rounds: usize = match preset {
        "standard" => 3,
        "burnin" => 6,
        _ => 1,
    };

    let mut sys = System::new_all();
    let mut components = Components::new_with_refreshed_list();
    let mut peak_temp: Option<f32> = None;
    let started = Instant::now();
    let threads = rayon::current_num_threads().max(1);

    let mut emit_progress = |phase: &str, pct: f64, sys: &mut System, comps: &mut Components| {
        let (usage, temp) = read_cpu_telemetry(sys, comps);
        if let Some(t) = temp {
            peak_temp = Some(peak_temp.map_or(t, |p| p.max(t)));
        }
        let _ = app.emit(
            "perf:progress",
            PerfBenchProgress {
                phase: phase.to_string(),
                percent: pct,
                cpu_usage_pct: (usage * 10.0).round() / 10.0,
                cpu_temp_c: temp.map(|t| (t * 10.0).round() / 10.0),
            },
        );
    };

    // 1. CPU Single-Threaded
    emit_progress("1/10 Single-Threaded Integer & Prime", 8.0, &mut sys, &mut components);
    let t_sc = Instant::now();
    for r in 0..rounds {
        if cancel.load(Ordering::Relaxed) {
            return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
        }
        black_box(count_primes_up_to(1_200_000 + r * 7));
        black_box(integer_math_workload(8_000_000, r as u64));
    }
    let single_core_score = ((rounds as f64 / t_sc.elapsed().as_secs_f64().max(0.001)) * 2200.0).round() as u64;

    // 2. Integer Math (Multi-Core)
    emit_progress("2/10 Integer Math (Multi-Core)", 18.0, &mut sys, &mut components);
    let int_jobs = threads * 4 * rounds;
    let t_int = Instant::now();
    let _: u64 = (0..int_jobs)
        .into_par_iter()
        .map(|i| if cancel.load(Ordering::Relaxed) { 0 } else { integer_math_workload(12_000_000, i as u64) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let integer_math_score = ((int_jobs as f64 / t_int.elapsed().as_secs_f64().max(0.001)) * 450.0).round() as u64;

    // 3. Floating-Point Math (FP64 FMA Matrix)
    emit_progress("3/10 Floating-Point Math (FP64 Matrix)", 28.0, &mut sys, &mut components);
    let fp_jobs = threads * 2 * rounds;
    let t_fp = Instant::now();
    let _: f64 = (0..fp_jobs)
        .into_par_iter()
        .map(|_| if cancel.load(Ordering::Relaxed) { 0.0 } else { float_fma_workload(200) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let float_math_score = ((fp_jobs as f64 / t_fp.elapsed().as_secs_f64().max(0.001)) * 880.0).round() as u64;

    // 4. Prime Numbers (Multi-Core)
    emit_progress("4/10 Prime Numbers Sieve", 38.0, &mut sys, &mut components);
    let pr_jobs = threads * 3 * rounds;
    let t_pr = Instant::now();
    let _: usize = (0..pr_jobs)
        .into_par_iter()
        .map(|i| if cancel.load(Ordering::Relaxed) { 0 } else { count_primes_up_to(650_000 + (i % 13)) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let prime_score = ((pr_jobs as f64 / t_pr.elapsed().as_secs_f64().max(0.001)) * 600.0).round() as u64;

    // 5. Extended Instructions / Vector FMA
    emit_progress("5/10 Extended Vector / SIMD Math", 48.0, &mut sys, &mut components);
    let vec_jobs = threads * 4 * rounds;
    let t_vec = Instant::now();
    let _: f32 = (0..vec_jobs)
        .into_par_iter()
        .map(|_| if cancel.load(Ordering::Relaxed) { 0.0 } else { vector_extended_workload(65536, 40) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let vector_score = ((vec_jobs as f64 / t_vec.elapsed().as_secs_f64().max(0.001)) * 520.0).round() as u64;

    // 6. Compression (LZ Dictionary)
    emit_progress("6/10 Data Compression", 58.0, &mut sys, &mut components);
    let cmp_jobs = threads * 3 * rounds;
    let t_cmp = Instant::now();
    let _: usize = (0..cmp_jobs)
        .into_par_iter()
        .map(|_| if cancel.load(Ordering::Relaxed) { 0 } else { compression_workload(512 * 1024) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let compression_score = ((cmp_jobs as f64 / t_cmp.elapsed().as_secs_f64().max(0.001)) * 650.0).round() as u64;

    // 7. Encryption (SHA-256)
    emit_progress("7/10 SHA-256 Encryption", 68.0, &mut sys, &mut components);
    let cr_jobs = threads * 5 * rounds;
    let t_cr = Instant::now();
    let _: usize = (0..cr_jobs)
        .into_par_iter()
        .map(|idx| {
            if cancel.load(Ordering::Relaxed) {
                return 0;
            }
            let mut buf = vec![(idx & 0xFF) as u8; 65536];
            let mut hasher = Sha256::new();
            for iter in 0..64u8 {
                buf[0] = iter;
                hasher.update(&buf);
                let out = hasher.finalize_reset();
                buf[1..33].copy_from_slice(&out);
            }
            buf[1] as usize
        })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let encryption_score = ((cr_jobs as f64 / t_cr.elapsed().as_secs_f64().max(0.001)) * 490.0).round() as u64;

    // 8. Physics (3D N-Body Simulation)
    emit_progress("8/10 Physics Simulation (3D N-Body)", 78.0, &mut sys, &mut components);
    let phy_jobs = threads * 2 * rounds;
    let t_phy = Instant::now();
    let _: f64 = (0..phy_jobs)
        .into_par_iter()
        .map(|_| if cancel.load(Ordering::Relaxed) { 0.0 } else { physics_nbody_workload(180, 12) })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let physics_score = ((phy_jobs as f64 / t_phy.elapsed().as_secs_f64().max(0.001)) * 820.0).round() as u64;

    // 9. Sorting
    emit_progress("9/10 Parallel Sorting", 86.0, &mut sys, &mut components);
    let sort_jobs = threads * 2 * rounds;
    let t_sort = Instant::now();
    let _: u64 = (0..sort_jobs)
        .into_par_iter()
        .map(|s| {
            if cancel.load(Ordering::Relaxed) {
                return 0;
            }
            let mut arr: Vec<u64> = (0..180_000u64)
                .map(|i| i.wrapping_mul(6364136223846793005).wrapping_add(s as u64))
                .collect();
            arr.sort_unstable();
            arr[0]
        })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let sorting_score = ((sort_jobs as f64 / t_sort.elapsed().as_secs_f64().max(0.001)) * 760.0).round() as u64;

    // 10. Memory Bandwidth + Real DRAM Latency (ns)
    emit_progress("10/10 Memory Bandwidth & DRAM Latency", 94.0, &mut sys, &mut components);
    let bytes_len = 64 * 1024 * 1024;
    let src = vec![0x5Au8; bytes_len];
    let mut dst = vec![0u8; bytes_len];
    let mem_passes = 6 * rounds;
    let t_mem = Instant::now();
    for _ in 0..mem_passes {
        if cancel.load(Ordering::Relaxed) {
            return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
        }
        dst.par_chunks_mut(1024 * 1024)
            .zip(src.par_chunks(1024 * 1024))
            .for_each(|(d, s)| d.copy_from_slice(s));
    }
    let total_gb = (mem_passes as f64 * (bytes_len as f64 * 2.0)) / (1024.0 * 1024.0 * 1024.0);
    let memory_bandwidth_gb_s = ((total_gb / t_mem.elapsed().as_secs_f64().max(0.001)) * 10.0).round() / 10.0;
    let memory_latency_ns = measure_memory_latency_ns();
    let memory_mark = (memory_bandwidth_gb_s * 95.0 + (12000.0 / memory_latency_ns.max(12.0))).round() as u64;

    emit_progress("Completed", 100.0, &mut sys, &mut components);

    let multi_core_score = ((integer_math_score
        + float_math_score
        + prime_score
        + vector_score
        + compression_score
        + encryption_score
        + physics_score
        + sorting_score) as f64
        / 8.0)
        .round() as u64;

    let composite_score = (single_core_score as f64 * 0.20
        + multi_core_score as f64 * 0.60
        + memory_mark as f64 * 0.20)
        .round() as u64;

    let tier = if composite_score >= 16000 {
        "High-Performance / Gaming"
    } else if composite_score >= 9500 {
        "Workstation / Pro Notebook"
    } else if composite_score >= 4500 {
        "Office / Productivity"
    } else {
        "Entry / Light Use"
    }
    .to_string();

    let status = if peak_temp.map(|t| t >= 100.0).unwrap_or(false) {
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
        single_core_score,
        multi_core_score,
        memory_bandwidth_gb_s,
        memory_latency_ns,
        memory_mark,
        composite_score,
        tier: tier.clone(),
        peak_cpu_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        elapsed_secs: elapsed,
        cancelled: false,
        summary: format!(
            "Mark {} ({}) — CPU MC: {} | SC: {} | Mem: {:.1} GB/s ({:.1} ns)",
            composite_score, tier, multi_core_score, single_core_score, memory_bandwidth_gb_s, memory_latency_ns
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
        single_core_score: 0,
        multi_core_score: 0,
        memory_bandwidth_gb_s: 0.0,
        memory_latency_ns: 0.0,
        memory_mark: 0,
        composite_score: 0,
        tier: "Cancelled".to_string(),
        peak_cpu_temp_c: None,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled: true,
        summary: "Performance benchmark was cancelled.".to_string(),
    }
}
