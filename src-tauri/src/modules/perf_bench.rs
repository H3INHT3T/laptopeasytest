use crate::types::{PerfBenchProgress, PerfBenchResult, TestStatus};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
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

fn run_matrix_workload(n: usize) -> f64 {
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
                c_row[j] += aik * b_row[j];
            }
        }
    }
    c.iter().sum()
}

pub fn run_performance_benchmark(
    app: &AppHandle,
    preset: &str,
    cancel: Arc<AtomicBool>,
) -> Result<PerfBenchResult, String> {
    let rounds: usize = match preset {
        "standard" => 3,
        "burnin" => 6,
        _ => 1, // quick
    };

    let mut sys = System::new_all();
    let mut components = Components::new_with_refreshed_list();
    let mut peak_temp: Option<f32> = None;
    let started = Instant::now();

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

    // 1. Single-Core Prime & Math Benchmark
    emit_progress("Single-Core Integer & Prime Sieve", 10.0, &mut sys, &mut components);
    let t_sc = Instant::now();
    let mut sc_ops = 0u64;
    for r in 0..rounds {
        if cancel.load(Ordering::Relaxed) {
            return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
        }
        let cnt = count_primes_up_to(1_500_000 + r * 10);
        sc_ops += cnt as u64;
    }
    let sc_secs = t_sc.elapsed().as_secs_f64().max(0.001);
    let single_core_score = ((rounds as f64 / sc_secs) * 2800.0).round() as u64;
    let _ = sc_ops;

    // 2. Multi-Core Parallel Prime Sieve Benchmark
    emit_progress("Multi-Core Compute Benchmark", 32.0, &mut sys, &mut components);
    let threads = rayon::current_num_threads().max(1);
    let jobs = threads * 3 * rounds;
    let t_mc = Instant::now();
    let mc_sum: usize = (0..jobs)
        .into_par_iter()
        .map(|i| {
            if cancel.load(Ordering::Relaxed) {
                return 0;
            }
            count_primes_up_to(700_000 + (i % 13))
        })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let mc_secs = t_mc.elapsed().as_secs_f64().max(0.001);
    let multi_core_score = ((jobs as f64 / mc_secs) * 620.0).round() as u64;
    let _ = mc_sum;

    // 3. Multi-Core SHA-256 Cryptography Benchmark
    emit_progress("Multi-Core SHA-256 Cryptography", 56.0, &mut sys, &mut components);
    let crypto_jobs = threads * 6 * rounds;
    let t_cr = Instant::now();
    let cr_done: usize = (0..crypto_jobs)
        .into_par_iter()
        .map(|idx| {
            if cancel.load(Ordering::Relaxed) {
                return 0;
            }
            let mut buf = vec![(idx & 0xFF) as u8; 65536];
            let mut hasher = Sha256::new();
            for iter in 0..80u8 {
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
    let cr_secs = t_cr.elapsed().as_secs_f64().max(0.001);
    let crypto_score = ((crypto_jobs as f64 / cr_secs) * 480.0).round() as u64;
    let _ = cr_done;

    // 4. Floating-Point Matrix Multiply (FP64)
    emit_progress("Floating-Point Matrix Multiply (FP64)", 78.0, &mut sys, &mut components);
    let mat_jobs = threads * 2 * rounds;
    let t_mat = Instant::now();
    let mat_sum: f64 = (0..mat_jobs)
        .into_par_iter()
        .map(|_| {
            if cancel.load(Ordering::Relaxed) {
                return 0.0;
            }
            run_matrix_workload(224)
        })
        .sum();
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_result(preset, started.elapsed().as_secs_f64()));
    }
    let mat_secs = t_mat.elapsed().as_secs_f64().max(0.001);
    let matrix_score = ((mat_jobs as f64 / mat_secs) * 950.0).round() as u64;
    let _ = mat_sum;

    // 5. Memory Bandwidth Benchmark (parallel copy of 128 MB)
    emit_progress("Memory Bandwidth Throughput", 92.0, &mut sys, &mut components);
    let bytes_len = 64 * 1024 * 1024; // 64 MB src -> 64 MB dst = 128 MB moved per pass
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
    let mem_secs = t_mem.elapsed().as_secs_f64().max(0.001);
    let total_gb = (mem_passes as f64 * (bytes_len as f64 * 2.0)) / (1024.0 * 1024.0 * 1024.0);
    let memory_bandwidth_gb_s = ((total_gb / mem_secs) * 10.0).round() / 10.0;

    emit_progress("Completed", 100.0, &mut sys, &mut components);

    let composite_score = (single_core_score as f64 * 0.25
        + multi_core_score as f64 * 0.35
        + crypto_score as f64 * 0.20
        + matrix_score as f64 * 0.20)
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
        single_core_score,
        multi_core_score,
        crypto_score,
        matrix_score,
        memory_bandwidth_gb_s,
        composite_score,
        tier: tier.clone(),
        peak_cpu_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        elapsed_secs: elapsed,
        cancelled: false,
        summary: format!(
            "Score {} ({}) — SC: {} | MC: {} | Mem: {:.1} GB/s",
            composite_score, tier, single_core_score, multi_core_score, memory_bandwidth_gb_s
        ),
    })
}

fn cancelled_result(preset: &str, elapsed: f64) -> PerfBenchResult {
    PerfBenchResult {
        status: TestStatus::Warn,
        preset: preset.to_string(),
        single_core_score: 0,
        multi_core_score: 0,
        crypto_score: 0,
        matrix_score: 0,
        memory_bandwidth_gb_s: 0.0,
        composite_score: 0,
        tier: "Cancelled".to_string(),
        peak_cpu_temp_c: None,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled: true,
        summary: "Performance benchmark was cancelled by the technician.".to_string(),
    }
}
