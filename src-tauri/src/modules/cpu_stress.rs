use crate::modules::{simd_kernels, telemetry};
use crate::types::{
    CpuStressProgress, CpuStressResult, TestStatus, CPU_THERMAL_CUTOFF_MAX_C,
    CPU_THERMAL_CUTOFF_MIN_C,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Deterministic floating-point + integer mix kernel used by every CPU stress worker thread.
/// Running the same `seed` and `words` must always produce the exact same u64 digest; any
/// bit-flip in ALU, FPU, L1/L2/L3 cache, or IMC produces a checksum mismatch error.
pub fn compute_deterministic_cpu_block(seed: u64, buf: &mut [u64]) -> u64 {
    let mut acc_i: u64 = seed ^ 0x9E37_79B9_7F4A_7C15;
    let mut acc_f: f64 = ((seed & 0xFFFF) as f64 + 1.125) * 0.000_976_562_5;

    for (idx, slot) in buf.iter_mut().enumerate() {
        acc_i = acc_i
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407 ^ (idx as u64));
        let rot = acc_i.rotate_left(((idx as u32) & 31) + 7);
        acc_f = (acc_f * 1.000_003_1 + ((rot & 0xFF) as f64) * 0.000_122_070_312_5) % 1024.0;
        *slot = rot ^ acc_f.to_bits();
    }

    let mut digest: u64 = 0xCBF2_9CE4_8422_2325;
    for &v in buf.iter() {
        digest ^= v;
        digest = digest.wrapping_mul(0x0000_0100_0000_01B3);
    }
    digest
}

pub fn data_set_words_per_thread(data_set: &str) -> (usize, &'static str) {
    match data_set.to_lowercase().as_str() {
        "small" => (4_096, "Small (32 KB L1/L2 — Max Heat)"),
        "large" => (524_288, "Large (4 MB L3 + IMC)"),
        _ => (32_768, "Medium (256 KB L2/L3 Balanced)"),
    }
}

pub fn classify_cooldown_recovery(
    peak_temp_c: Option<f32>,
    end_temp_c: Option<f32>,
) -> (Option<f32>, String, String) {
    match (peak_temp_c, end_temp_c) {
        (Some(peak), Some(end)) => {
            let drop = (peak - end).max(0.0);
            if drop >= 12.0 || end <= 58.0 {
                (
                    Some(drop),
                    "EXCELLENT".to_string(),
                    format!(
                        "Fast heatsink recovery: cooled {:.1}°C ({:.0}°C → {:.0}°C) right after load.",
                        drop, peak, end
                    ),
                )
            } else if drop >= 6.0 || end <= 68.0 {
                (
                    Some(drop),
                    "NORMAL".to_string(),
                    format!(
                        "Healthy cooling recovery: dropped {:.1}°C ({:.0}°C → {:.0}°C) during cool-down.",
                        drop, peak, end
                    ),
                )
            } else {
                (
                    Some(drop),
                    "SLOW_COOLING".to_string(),
                    format!(
                        "Slow thermal recovery: only dropped {:.1}°C ({:.0}°C → {:.0}°C) — check for clogged fan vents or dried thermal paste.",
                        drop, peak, end
                    ),
                )
            }
        }
        _ => (
            None,
            "SENSOR_UNAVAILABLE".to_string(),
            "CPU temperature sensor unavailable on this firmware; cool-down recovery delta skipped.".to_string(),
        ),
    }
}

#[cfg(target_os = "windows")]
fn query_windows_whea_count() -> u64 {
    use crate::cmd_util::run_powershell;
    let ps = "(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Id=19; StartTime=(Get-Date).AddMinutes(-30)} -ErrorAction SilentlyContinue | Measure-Object).Count";
    run_powershell(ps)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(not(target_os = "windows"))]
fn query_windows_whea_count() -> u64 {
    0
}

pub fn run_cpu_stress_test(
    app: &AppHandle,
    data_set: &str,
    load_type: &str,
    threads_mode: &str,
    duration_secs: u64,
    thermal_cutoff_c: f32,
    stop_on_error: bool,
    cooldown_secs: u64,
    cancel: Arc<AtomicBool>,
) -> Result<CpuStressResult, String> {
    let dur = duration_secs.clamp(15, 1800);
    let cutoff = if thermal_cutoff_c.is_finite() {
        thermal_cutoff_c.clamp(CPU_THERMAL_CUTOFF_MIN_C, CPU_THERMAL_CUTOFF_MAX_C)
    } else {
        92.0
    };
    let cooldown = cooldown_secs.min(30);
    let is_variable = load_type.eq_ignore_ascii_case("variable");
    let (words_per_thread, dataset_label) = data_set_words_per_thread(data_set);

    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let phys = sysinfo::System::new().physical_core_count().unwrap_or(logical);
    let thread_count = if threads_mode.eq_ignore_ascii_case("physical") {
        phys.clamp(1, logical)
    } else {
        logical.max(1)
    };

    let simd_isa = simd_kernels::detected_simd_isa().to_string();
    let whea_baseline = query_windows_whea_count();

    let stop_workers = Arc::new(AtomicBool::new(false));
    let pause_workers = Arc::new(AtomicBool::new(false));
    let calc_errors = Arc::new(AtomicU64::new(0));
    let iterations_done = Arc::new(AtomicU64::new(0));

    let mut handles = Vec::with_capacity(thread_count);
    for tid in 0..thread_count {
        let stop_f = stop_workers.clone();
        let pause_f = pause_workers.clone();
        let cancel_f = cancel.clone();
        let err_c = calc_errors.clone();
        let iter_c = iterations_done.clone();

        handles.push(std::thread::spawn(move || {
            let mut buf = vec![0u64; words_per_thread];
            let base_seed = 0x517C_C1B7_2722_0A95u64 ^ ((tid as u64) << 17);
            let expected_digest = compute_deterministic_cpu_block(base_seed, &mut buf);

            while !stop_f.load(Ordering::Relaxed) && !cancel_f.load(Ordering::Relaxed) {
                if pause_f.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(40));
                    continue;
                }
                // Run heavy SIMD FMA step for realistic thermal load alongside deterministic checksum check
                let gemm = simd_kernels::simd_ai_gemm_step(48, 1.0 + (tid as f32) * 0.01);
                if !gemm.is_finite() {
                    err_c.fetch_add(1, Ordering::Relaxed);
                }
                let got = compute_deterministic_cpu_block(base_seed, &mut buf);
                if got != expected_digest {
                    err_c.fetch_add(1, Ordering::Relaxed);
                }
                iter_c.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    let mut tel = telemetry::TelemetryReader::new();
    let started = Instant::now();
    let mut peak_temp_c: Option<f32> = None;
    let mut initial_clock_mhz: Option<u64> = None;
    let mut min_clock_mhz: u64 = u64::MAX;
    let mut max_clock_mhz: u64 = 0;
    let mut sum_clock_mhz: u64 = 0;
    let mut clock_samples: u64 = 0;
    let mut thermal_cutoff_triggered = false;
    let mut stopped_on_error = false;
    let mut whea_errors: u64 = 0;
    let mut last_whea_poll = Instant::now();

    loop {
        let elapsed = started.elapsed().as_secs_f64();
        if elapsed >= dur as f64 || cancel.load(Ordering::Relaxed) {
            break;
        }

        // Variable load spikes: 2.5s full load / 0.8s idle transient cycle
        if is_variable {
            let cycle_pos = elapsed % 3.3;
            pause_workers.store(cycle_pos >= 2.5, Ordering::Relaxed);
        }

        let snap = tel.sample(true);
        if snap.cpu_clock_mhz > 0 {
            if initial_clock_mhz.is_none() && elapsed >= 2.0 {
                initial_clock_mhz = Some(snap.cpu_clock_mhz);
            }
            min_clock_mhz = min_clock_mhz.min(snap.cpu_clock_mhz);
            max_clock_mhz = max_clock_mhz.max(snap.cpu_clock_mhz);
            sum_clock_mhz += snap.cpu_clock_mhz;
            clock_samples += 1;
        }
        if let Some(t) = snap.cpu_temp_c {
            peak_temp_c = Some(peak_temp_c.map_or(t, |p| p.max(t)));
            if t >= cutoff {
                thermal_cutoff_triggered = true;
                break;
            }
        }

        if last_whea_poll.elapsed() >= Duration::from_secs(6) {
            let now_whea = query_windows_whea_count();
            whea_errors = now_whea.saturating_sub(whea_baseline);
            last_whea_poll = Instant::now();
        }

        let c_errs = calc_errors.load(Ordering::Relaxed);
        let total_errs = c_errs + whea_errors;
        if stop_on_error && total_errs > 0 {
            stopped_on_error = true;
            break;
        }

        let pct = ((elapsed / dur as f64) * 100.0).min(100.0);
        let _ = app.emit(
            "cpu_stress:progress",
            CpuStressProgress {
                running: true,
                phase: if is_variable && pause_workers.load(Ordering::Relaxed) {
                    "Variable Load (Transient Idle)".to_string()
                } else {
                    format!("Stressing {} ({} threads)", dataset_label, thread_count)
                },
                percent: pct,
                elapsed_secs: elapsed,
                duration_secs: dur,
                cpu_usage_pct: snap.cpu_usage_pct as f64,
                cpu_clock_mhz: snap.cpu_clock_mhz,
                cpu_temp_c: snap.cpu_temp_c,
                cpu_power_w: snap.cpu_power_w,
                calc_errors: c_errs,
                whea_errors,
                iterations_completed: iterations_done.load(Ordering::Relaxed),
                in_cooldown: false,
            },
        );

        std::thread::sleep(Duration::from_millis(500));
    }

    // Stop worker threads cleanly before cool-down measurement
    stop_workers.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }

    let stress_elapsed = started.elapsed().as_secs_f64();
    let cancelled = cancel.load(Ordering::Relaxed);

    // Final WHEA check
    let final_whea = query_windows_whea_count();
    whea_errors = whea_errors.max(final_whea.saturating_sub(whea_baseline));
    let c_errs = calc_errors.load(Ordering::Relaxed);
    let total_errors = c_errs + whea_errors;

    // Optional Post-Load Cool-Down Recovery Check (skipped if user cancelled)
    let mut cooldown_end_temp_c: Option<f32> = None;
    if !cancelled && cooldown > 0 {
        let cd_start = Instant::now();
        while cd_start.elapsed().as_secs() < cooldown && !cancel.load(Ordering::Relaxed) {
            let snap = tel.sample(true);
            if snap.cpu_temp_c.is_some() {
                cooldown_end_temp_c = snap.cpu_temp_c;
            }
            let cd_elapsed = cd_start.elapsed().as_secs_f64();
            let _ = app.emit(
                "cpu_stress:progress",
                CpuStressProgress {
                    running: true,
                    phase: format!("Cool-Down Recovery ({:.0}s / {}s)", cd_elapsed, cooldown),
                    percent: 100.0,
                    elapsed_secs: stress_elapsed + cd_elapsed,
                    duration_secs: dur,
                    cpu_usage_pct: snap.cpu_usage_pct as f64,
                    cpu_clock_mhz: snap.cpu_clock_mhz,
                    cpu_temp_c: snap.cpu_temp_c,
                    cpu_power_w: snap.cpu_power_w,
                    calc_errors: c_errs,
                    whea_errors,
                    iterations_completed: iterations_done.load(Ordering::Relaxed),
                    in_cooldown: true,
                },
            );
            std::thread::sleep(Duration::from_millis(1000));
        }
    }

    let (cooldown_drop_c, cooldown_verdict, cooldown_note) =
        classify_cooldown_recovery(peak_temp_c, cooldown_end_temp_c);

    let avg_clock_mhz = if clock_samples > 0 {
        sum_clock_mhz / clock_samples
    } else {
        0
    };
    let min_clock = if min_clock_mhz == u64::MAX {
        avg_clock_mhz
    } else {
        min_clock_mhz
    };
    let throttle_drop_pct = match initial_clock_mhz {
        Some(init) if init > 0 && avg_clock_mhz < init => {
            ((init - avg_clock_mhz) as f64 / init as f64) * 100.0
        }
        _ => 0.0,
    };

    let status = if total_errors > 0 || thermal_cutoff_triggered {
        TestStatus::Fail
    } else if cancelled || throttle_drop_pct >= 20.0 || cooldown_verdict == "SLOW_COOLING" {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if total_errors > 0 {
        format!(
            "FAIL: {} CPU stability error(s) detected ({} calc, {} WHEA) across {} threads.",
            total_errors, c_errs, whea_errors, thread_count
        )
    } else if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF: CPU hit {:.0}°C (limit {:.0}°C) — heatsink cleaning/repaste required.",
            peak_temp_c.unwrap_or(cutoff),
            cutoff
        )
    } else if cancelled {
        format!(
            "Stopped early at {:.0}s — 0 errors across {} threads.",
            stress_elapsed, thread_count
        )
    } else {
        format!(
            "0 errors over {:.0}s ({} threads, avg {} MHz, throttle {:.1}%, cool-down: {}).",
            stress_elapsed, thread_count, avg_clock_mhz, throttle_drop_pct, cooldown_verdict
        )
    };

    let plain_summary = if total_errors > 0 {
        format!(
            "Unstable CPU detected ({} hardware/calculation error(s)) — do not certify until cooling/BIOS voltages are fixed.",
            total_errors
        )
    } else if thermal_cutoff_triggered {
        format!(
            "CPU reached the {:.0}°C safety cutoff and stopped automatically to protect hardware. Clean fan/heatsink and replace thermal paste.",
            cutoff
        )
    } else if throttle_drop_pct >= 20.0 {
        format!(
            "0 calculation errors, but CPU throttled {:.1}% under sustained load. {}",
            throttle_drop_pct, cooldown_note
        )
    } else {
        format!(
            "CPU remained 100% error-free under sustained {} load ({} threads). {}",
            dataset_label, thread_count, cooldown_note
        )
    };

    Ok(CpuStressResult {
        status,
        data_set: data_set.to_string(),
        load_type: load_type.to_string(),
        threads_used: thread_count,
        simd_isa,
        duration_secs: dur,
        elapsed_secs: stress_elapsed,
        calc_errors: c_errs,
        whea_errors,
        total_errors,
        iterations_completed: iterations_done.load(Ordering::Relaxed),
        avg_clock_mhz,
        min_clock_mhz: min_clock,
        max_clock_mhz,
        throttle_drop_pct,
        peak_temp_c,
        cooldown_end_temp_c,
        cooldown_drop_c,
        cooldown_verdict,
        thermal_cutoff_triggered,
        effective_cutoff_c: cutoff,
        stopped_on_error,
        cancelled,
        summary,
        plain_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic_cpu_kernel_repeatability_and_error_detection() {
        let mut buf_a = vec![0u64; 1024];
        let mut buf_b = vec![0u64; 1024];
        let d1 = compute_deterministic_cpu_block(0xDEAD_BEEF, &mut buf_a);
        let d2 = compute_deterministic_cpu_block(0xDEAD_BEEF, &mut buf_b);
        assert_eq!(d1, d2);
        assert_eq!(buf_a, buf_b);

        let d3 = compute_deterministic_cpu_block(0xDEAD_BEEE, &mut buf_b);
        assert_ne!(d1, d3);
    }

    #[test]
    fn test_cooldown_recovery_classification() {
        let (drop_ex, v_ex, _) = classify_cooldown_recovery(Some(86.0), Some(68.0));
        assert_eq!(v_ex, "EXCELLENT");
        assert!((drop_ex.unwrap() - 18.0).abs() < 0.01);

        let (_, v_norm, _) = classify_cooldown_recovery(Some(80.0), Some(72.0));
        assert_eq!(v_norm, "NORMAL");

        let (_, v_slow, note_slow) = classify_cooldown_recovery(Some(88.0), Some(84.0));
        assert_eq!(v_slow, "SLOW_COOLING");
        assert!(note_slow.contains("thermal paste"));

        let (drop_na, v_na, _) = classify_cooldown_recovery(None, None);
        assert!(drop_na.is_none());
        assert_eq!(v_na, "SENSOR_UNAVAILABLE");
    }
}
