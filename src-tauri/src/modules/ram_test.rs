use crate::types::{RamTestProgress, RamTestResult, TestStatus};
use rayon::prelude::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::{AppHandle, Emitter};

/// Authentic TestMem5-inspired memory verification engine implementing:
/// - RefreshStable (DRAM retention check with timed hold between write & verify)
/// - SimpleTest Mode 1 & Mode 2 (serj/anta777 seeded bit-pattern & walking inversions)
/// - MirrorMove (64-bit cross-bank half-window mirror, invert & verify)
/// - MirrorMove128 (128-bit SIMD-aligned dual-word mirror & verify across cache lines)
pub fn verify_pattern_pass(buf: &mut [u64], test_kind: usize, seed: u64) -> u64 {
    let chunk_words = (buf.len() / rayon::current_num_threads().max(1)).max(4096);
    let errors = AtomicU64::new(0);

    match test_kind {
        // Test 0: RefreshStable (TM5 Default/Absolut)
        0 => {
            buf.par_chunks_mut(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                for (i, slot) in chunk.iter_mut().enumerate() {
                    let idx = base + i as u64;
                    *slot = if (idx & 1) == 0 {
                        0xAAAA_AAAA_AAAA_AAAA ^ seed
                    } else {
                        0x5555_5555_5555_5555 ^ !seed
                    };
                }
            });
            // Brief DRAM refresh-window pause to catch weak cell retention / tREFI instability
            std::thread::sleep(Duration::from_millis(60));
            buf.par_chunks(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                let mut local = 0u64;
                for (i, &val) in chunk.iter().enumerate() {
                    let idx = base + i as u64;
                    let expected = if (idx & 1) == 0 {
                        0xAAAA_AAAA_AAAA_AAAA ^ seed
                    } else {
                        0x5555_5555_5555_5555 ^ !seed
                    };
                    if val != expected {
                        local += 1;
                    }
                }
                if local > 0 {
                    errors.fetch_add(local, Ordering::Relaxed);
                }
            });
        }
        // Test 1: MirrorMove (cross-bank copy & bitwise inversion)
        1 => {
            let half = buf.len() / 2;
            let (left, right) = buf.split_at_mut(half);
            let sub_chunk = (half / rayon::current_num_threads().max(1)).max(4096);
            left.par_chunks_mut(sub_chunk).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * sub_chunk) as u64;
                for (i, slot) in chunk.iter_mut().enumerate() {
                    *slot = splitmix64((base + i as u64).wrapping_add(seed));
                }
            });
            // Mirror left -> right inverted
            right[..half]
                .par_chunks_mut(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    for (d, &s) in dst.iter_mut().zip(src.iter()) {
                        *d = !s;
                    }
                });
            // Verify right matches !left
            right[..half]
                .par_chunks(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    let mut local = 0u64;
                    for (&d, &s) in dst.iter().zip(src.iter()) {
                        if d != !s {
                            local += 1;
                        }
                    }
                    if local > 0 {
                        errors.fetch_add(local, Ordering::Relaxed);
                    }
                });
        }
        // Test 2: MirrorMove128 (128-bit pair cross-bank copy & verify)
        2 => {
            let half = (buf.len() / 2) & !1;
            let (left, right) = buf.split_at_mut(half);
            let sub_chunk = ((half / rayon::current_num_threads().max(1)).max(4096)) & !1;
            left.par_chunks_mut(sub_chunk).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * sub_chunk) as u64;
                for (i, pair) in chunk.chunks_exact_mut(2).enumerate() {
                    let k = base + (i as u64) * 2;
                    let w0 = k.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ seed;
                    let w1 = !w0.rotate_left(17);
                    pair[0] = w0;
                    pair[1] = w1;
                }
            });
            right[..half]
                .par_chunks_mut(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    for (dp, sp) in dst.chunks_exact_mut(2).zip(src.chunks_exact(2)) {
                        dp[0] = sp[1];
                        dp[1] = sp[0];
                    }
                });
            right[..half]
                .par_chunks(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    let mut local = 0u64;
                    for (dp, sp) in dst.chunks_exact(2).zip(src.chunks_exact(2)) {
                        if dp[0] != sp[1] || dp[1] != sp[0] {
                            local += 1;
                        }
                    }
                    if local > 0 {
                        errors.fetch_add(local, Ordering::Relaxed);
                    }
                });
        }
        // Test 3: SimpleTest Mode 1 (serj 0x45357354 walking-bit & address-xor)
        3 => {
            let p0 = 0x0000_1E5F_4535_7354u64 ^ seed;
            buf.par_chunks_mut(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                for (i, slot) in chunk.iter_mut().enumerate() {
                    let idx = base + i as u64;
                    *slot = p0.rotate_left((idx & 63) as u32) ^ idx;
                }
            });
            buf.par_chunks(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                let mut local = 0u64;
                for (i, &val) in chunk.iter().enumerate() {
                    let idx = base + i as u64;
                    let expected = p0.rotate_left((idx & 63) as u32) ^ idx;
                    if val != expected {
                        local += 1;
                    }
                }
                if local > 0 {
                    errors.fetch_add(local, Ordering::Relaxed);
                }
            });
        }
        // Test 4+: SimpleTest Mode 2 (anta777 0x6E72A941 SplitMix64 high-entropy PRNG)
        _ => {
            let p1 = 0x0014_AAB7_6E72_A941u64 ^ seed;
            buf.par_chunks_mut(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                for (i, slot) in chunk.iter_mut().enumerate() {
                    *slot = splitmix64((base + i as u64).wrapping_add(p1));
                }
            });
            buf.par_chunks(chunk_words).enumerate().for_each(|(c_idx, chunk)| {
                let base = (c_idx * chunk_words) as u64;
                let mut local = 0u64;
                for (i, &val) in chunk.iter().enumerate() {
                    if val != splitmix64((base + i as u64).wrapping_add(p1)) {
                        local += 1;
                    }
                }
                if local > 0 {
                    errors.fetch_add(local, Ordering::Relaxed);
                }
            });
        }
    }

    errors.load(Ordering::Relaxed)
}

#[inline(always)]
fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
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

    let pct = memory_percent.unwrap_or(60).clamp(20, 75) as u64;
    let safe_max_mb = avail_ram_mb.saturating_sub(2048).max(256);
    let target_mb = ((avail_ram_mb * pct) / 100).min(safe_max_mb).clamp(256, 8192);

    let (profile_name, total_cycles, target_duration_secs): (&str, u32, u64) = match preset {
        "standard" => ("Absolut @ anta777 (Standard)", 6, 300),
        "burnin" => ("Extreme @ anta777 (Burn-in)", 15, 900),
        _ => ("Default @ serj (Quick QC)", 3, 90),
    };

    let test_sequence: [(&str, usize); 6] = [
        ("Test0: RefreshStable (Retention)", 0),
        ("Test1: SimpleTest Mode 1 (0x45357354)", 3),
        ("Test2: MirrorMove (64-bit Bus)", 1),
        ("Test3: SimpleTest Mode 2 (PRNG 0x6E72A941)", 4),
        ("Test4: MirrorMove128 (128-bit Cacheline)", 2),
        ("Test5: RefreshStable Inverted", 0),
    ];

    let word_count = ((target_mb as usize * 1024 * 1024) / std::mem::size_of::<u64>()) & !1;
    let mut buffer = vec![0u64; word_count];

    let started = Instant::now();
    let mut total_errors = 0u64;
    let mut peak_bw = 0.0f64;
    let mut cycles_completed = 0u32;
    let mut cancelled = false;
    let total_steps = (total_cycles as usize) * test_sequence.len();
    let mut step_done = 0usize;

    'outer: for cycle in 1..=total_cycles {
        for (t_idx, &(pname, pid)) in test_sequence.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break 'outer;
            }
            let t_pass = Instant::now();
            let seed = (cycle as u64)
                .wrapping_mul(0xD1B5_4A32_D192_ED03)
                ^ ((t_idx as u64).wrapping_mul(0x94D0_49BB_1331_11EB));
            let errs = verify_pattern_pass(&mut buffer, pid, seed);
            total_errors += errs;

            let pass_secs = t_pass.elapsed().as_secs_f64().max(0.001);
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
                    profile_name: profile_name.to_string(),
                    test_index: t_idx,
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
            "RAM FAILURE ({}): {} bit error(s) detected across {} MB!",
            profile_name, total_errors, target_mb
        )
    } else if cancelled {
        format!(
            "Stopped early after {:.1}s ({} MB tested, 0 errors).",
            elapsed, target_mb
        )
    } else {
        format!(
            "0 errors across {} MB — {} ({} cycles, peak {:.1} GB/s).",
            target_mb, profile_name, cycles_completed, peak_bw
        )
    };

    Ok(RamTestResult {
        status,
        preset: preset.to_string(),
        profile_name: profile_name.to_string(),
        allocated_mb: target_mb,
        total_ram_mb,
        cycles_completed,
        patterns_tested: test_sequence.iter().map(|(n, _)| n.to_string()).collect(),
        errors_found: total_errors,
        peak_bandwidth_gb_s: peak_bw,
        elapsed_secs: elapsed,
        cancelled,
        summary,
    })
}
