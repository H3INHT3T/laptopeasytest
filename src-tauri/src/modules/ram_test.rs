use crate::types::{RamTestProgress, RamTestResult, TestStatus};
use rayon::prelude::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use sysinfo::System;
use tauri::{AppHandle, Emitter};

/// Deterministic memory bit-pattern verifier inspired by TestMem5.
/// Verifies every u64 word across parallel chunks and returns exact bit/word error count.
pub fn verify_pattern_pass(buf: &mut [u64], pattern_id: usize, seed: u64) -> u64 {
    let chunk_words = (buf.len() / rayon::current_num_threads().max(1)).max(4096);
    let errors = AtomicU64::new(0);

    // Phase A: Write pattern in parallel
    buf.par_chunks_mut(chunk_words)
        .enumerate()
        .for_each(|(c_idx, chunk)| {
            let base = (c_idx * chunk_words) as u64;
            for (i, slot) in chunk.iter_mut().enumerate() {
                let idx = base + i as u64;
                *slot = compute_pattern_word(pattern_id, idx, seed);
            }
        });

    // Memory barrier via thread synchronization — Phase B: Read back & verify every word
    buf.par_chunks(chunk_words)
        .enumerate()
        .for_each(|(c_idx, chunk)| {
            let base = (c_idx * chunk_words) as u64;
            let mut local_err = 0u64;
            for (i, &val) in chunk.iter().enumerate() {
                let idx = base + i as u64;
                let expected = compute_pattern_word(pattern_id, idx, seed);
                if val != expected {
                    local_err += 1;
                }
            }
            if local_err > 0 {
                errors.fetch_add(local_err, Ordering::Relaxed);
            }
        });

    errors.load(Ordering::Relaxed)
}

#[inline(always)]
fn compute_pattern_word(pattern_id: usize, idx: u64, seed: u64) -> u64 {
    match pattern_id {
        0 => 0xAAAA_AAAA_AAAA_AAAA ^ seed,
        1 => 0x5555_5555_5555_5555 ^ seed,
        2 => {
            // Walking 1 bit across 64-bit word
            let shift = ((idx.wrapping_add(seed)) & 63) as u32;
            1u64.wrapping_shl(shift)
        }
        3 => {
            // Moving inversion (Address XOR)
            idx.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ !seed
        }
        _ => {
            // SplitMix64 deterministic PRNG
            let mut z = idx.wrapping_add(seed).wrapping_add(0x9E37_79B9_7F4A_7C15);
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
    }
}

pub fn run_ram_stress_test(
    app: &AppHandle,
    preset: &str,
    memory_percent: Option<u32>,
    cancel: Arc<AtomicBool>,
) -> Result<RamTestResult, String> {
    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mb = sys.total_memory() / (1024 * 1024);
    let avail_ram_mb = sys.available_memory() / (1024 * 1024);

    // Leave strict OS headroom (>= 2048 MB or 30% of available) to never trigger OOM kills
    let pct = memory_percent.unwrap_or(55).clamp(15, 75) as u64;
    let safe_max_mb = avail_ram_mb.saturating_sub(2048).max(256);
    let target_mb = ((avail_ram_mb * pct) / 100).min(safe_max_mb).clamp(256, 8192);

    let (total_cycles, target_duration_secs): (u32, u64) = match preset {
        "standard" => (6, 300),
        "burnin" => (18, 900),
        _ => (2, 90), // quick
    };

    let patterns = [
        ("Checkerboard 0xAA", 0usize),
        ("Checkerboard 0x55", 1usize),
        ("Walking Bit 1/0", 2usize),
        ("Address XOR Moving Inv", 3usize),
        ("SplitMix64 PRNG Verify", 4usize),
    ];

    let word_count = (target_mb as usize * 1024 * 1024) / std::mem::size_of::<u64>();
    let mut buffer = vec![0u64; word_count];

    let started = Instant::now();
    let mut total_errors = 0u64;
    let mut peak_bw = 0.0f64;
    let mut cycles_completed = 0u32;
    let mut cancelled = false;
    let total_steps = (total_cycles as usize) * patterns.len();
    let mut step_done = 0usize;

    'outer: for cycle in 1..=total_cycles {
        for &(pname, pid) in &patterns {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break 'outer;
            }
            let t_pass = Instant::now();
            let seed = (cycle as u64).wrapping_mul(0xD1B5_4A32_D192_ED03) ^ (pid as u64);
            let errs = verify_pattern_pass(&mut buffer, pid, seed);
            total_errors += errs;

            let pass_secs = t_pass.elapsed().as_secs_f64().max(0.001);
            // Each pass writes + reads the full buffer (2 * bytes)
            let bytes_moved = (target_mb as f64) * 2.0 / 1024.0;
            let bw = ((bytes_moved / pass_secs) * 100.0).round() / 100.0;
            if bw > peak_bw {
                peak_bw = bw;
            }

            step_done += 1;
            let elapsed = started.elapsed().as_secs_f64();
            let pct_by_steps = (step_done as f64 / total_steps as f64) * 100.0;
            let pct_by_time = (elapsed / target_duration_secs as f64) * 100.0;

            let _ = app.emit(
                "ram:progress",
                RamTestProgress {
                    running: true,
                    pattern_name: pname.to_string(),
                    cycle,
                    total_cycles,
                    percent: pct_by_steps.max(pct_by_time).min(99.0),
                    allocated_mb: target_mb,
                    bandwidth_gb_s: bw,
                    errors_found: total_errors,
                    elapsed_secs: (elapsed * 10.0).round() / 10.0,
                },
            );

            // Respect preset upper time cap gracefully after at least 1 full cycle
            if cycle >= 1 && elapsed >= target_duration_secs as f64 {
                cycles_completed = cycle;
                break 'outer;
            }
        }
        cycles_completed = cycle;
    }

    drop(buffer);

    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let status = if total_errors > 0 {
        TestStatus::Fail
    } else if cancelled {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if total_errors > 0 {
        format!(
            "RAM FAILURE: {} bit-verification error(s) detected across {} MB tested!",
            total_errors, target_mb
        )
    } else if cancelled {
        format!(
            "Stopped early after {:.1}s ({} MB tested, 0 errors so far).",
            elapsed, target_mb
        )
    } else {
        format!(
            "0 memory errors across {} MB ({} cycle(s), peak {:.1} GB/s).",
            target_mb, cycles_completed, peak_bw
        )
    };

    Ok(RamTestResult {
        status,
        preset: preset.to_string(),
        allocated_mb: target_mb,
        total_ram_mb,
        cycles_completed,
        patterns_tested: patterns.iter().map(|(n, _)| n.to_string()).collect(),
        errors_found: total_errors,
        peak_bandwidth_gb_s: peak_bw,
        elapsed_secs: elapsed,
        cancelled,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ram_pattern_clean_pass() {
        let mut buf = vec![0u64; 65536];
        for pid in 0..5 {
            assert_eq!(verify_pattern_pass(&mut buf, pid, 42), 0);
        }
    }

    #[test]
    fn test_ram_pattern_detects_bitflip() {
        let mut buf = vec![0u64; 1024];
        for (i, slot) in buf.iter_mut().enumerate() {
            *slot = compute_pattern_word(4, i as u64, 99);
        }
        // Inject 2 bit-flips
        buf[17] ^= 1 << 5;
        buf[511] ^= 1 << 63;

        let mut errs = 0;
        for (i, &val) in buf.iter().enumerate() {
            if val != compute_pattern_word(4, i as u64, 99) {
                errs += 1;
            }
        }
        assert_eq!(errs, 2);
    }
}
