use crate::modules::{
    baselines,
    telemetry::{TelemetryReader, ThermalSafetyCheck},
    userbenchmark,
};
use crate::types::{
    RamTestProgress, RamTestResult, TestStatus, UserBenchmarkInput, CPU_THERMAL_CUTOFF_DEFAULT_C,
    RAM_OS_RESERVE_16GB_CAP_MB, RAM_OS_RESERVE_FLOOR_MB, RAM_OS_RESERVE_PCT,
};
use rayon::prelude::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use sysinfo::System;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy)]
pub(crate) enum Mt0Kernel {
    RefreshStable { hold_ms: u64 },
    SimpleTest { mode: u8, stride: usize, block_mb: usize },
    MirrorMove,
    MirrorMove128,
    BlockMove,
}

pub(crate) fn compute_ram_os_reserve_mb(total_ram_mb: u64) -> u64 {
    let pct_reserve = total_ram_mb.saturating_mul(RAM_OS_RESERVE_PCT) / 100;
    pct_reserve
        .max(RAM_OS_RESERVE_FLOOR_MB)
        .min(RAM_OS_RESERVE_16GB_CAP_MB)
}

pub(crate) fn compute_safe_ram_window_mb(
    total_ram_mb: u64,
    avail_ram_mb: u64,
    requested_pct: u32,
) -> Result<(u64, u64), String> {
    let reserve_mb = compute_ram_os_reserve_mb(total_ram_mb);
    if avail_ram_mb <= reserve_mb + 64 {
        return Err(format!(
            "Insufficient available RAM ({} MB free) to safely allocate a test window while preserving {} MB OS reserve.",
            avail_ram_mb, reserve_mb
        ));
    }
    let safe_max_mb = avail_ram_mb - reserve_mb;
    let pct = requested_pct.clamp(30, 75) as u64;
    let requested_mb = (avail_ram_mb.saturating_mul(pct)) / 100;
    let target_mb = requested_mb.min(safe_max_mb).min(10240).max(64);
    Ok((target_mb, reserve_mb))
}

fn gcd_usize(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

fn coprime_stride(len: usize, desired: usize) -> usize {
    if len <= 1 || desired <= 1 {
        return 1;
    }
    let mut s = desired % len;
    if s == 0 {
        s = 1;
    }
    while gcd_usize(s, len) != 1 {
        s += 1;
        if s >= len {
            s = 1;
            break;
        }
    }
    s
}

#[inline(always)]
fn simple_test_expected(mode: u8, idx: u64, seed: u64) -> u64 {
    match mode {
        0 => {
            // Mode 0: Constant patterns (all-0s, all-1s, 0xAAAA..., 0x5555...)
            match seed & 3 {
                0 => 0x0000_0000_0000_0000u64,
                1 => 0xFFFF_FFFF_FFFF_FFFFu64,
                2 => 0xAAAA_AAAA_AAAA_AAAAu64,
                _ => 0x5555_5555_5555_5555u64,
            }
        }
        1 => {
            // Mode 1: Variable rotating bit pattern (anta777 / serj 0x1E5F45357354)
            let p0 = 0x0000_1E5F_4535_7354u64 ^ seed;
            p0.rotate_left((idx & 63) as u32) ^ idx
        }
        _ => {
            // Mode 2: PRNG address-seeded pattern (0x14AAB76E72A941)
            let p1 = 0x0014_AAB7_6E72_A941u64 ^ seed;
            splitmix64(idx.wrapping_add(p1))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Mt0KernelOutcome {
    pub errors: u64,
    pub bytes_verified: u64,
    pub cancelled: bool,
    pub thermal_cutoff: Option<f32>,
}

fn simple_test_strided_block_write(
    block: &mut [u64],
    block_base: u64,
    mode: u8,
    stride: usize,
    seed: u64,
    abort: &AtomicBool,
) -> bool {
    let b_len = block.len();
    if stride == 256 && b_len >= 256 {
        for col in 0..256usize {
            if (col & 15) == 0 && abort.load(Ordering::Relaxed) {
                return false;
            }
            let mut idx = col;
            while idx < b_len {
                block[idx] = simple_test_expected(mode, block_base + idx as u64, seed);
                idx += 256;
            }
        }
    } else {
        let step = coprime_stride(b_len, stride);
        let mut idx = 0usize;
        for iter in 0..b_len {
            if (iter & 0xFFFF) == 0 && abort.load(Ordering::Relaxed) {
                return false;
            }
            block[idx] = simple_test_expected(mode, block_base + idx as u64, seed);
            idx = (idx + step) % b_len;
        }
    }
    true
}

fn simple_test_strided_block_verify(
    block: &[u64],
    block_base: u64,
    mode: u8,
    stride: usize,
    seed: u64,
    abort: &AtomicBool,
) -> Option<u64> {
    let b_len = block.len();
    let mut local = 0u64;
    if stride == 256 && b_len >= 256 {
        for col in 0..256usize {
            if (col & 15) == 0 && abort.load(Ordering::Relaxed) {
                return None;
            }
            let mut idx = col;
            while idx < b_len {
                if block[idx] != simple_test_expected(mode, block_base + idx as u64, seed) {
                    local += 1;
                }
                idx += 256;
            }
        }
    } else {
        let step = coprime_stride(b_len, stride);
        let mut idx = 0usize;
        for iter in 0..b_len {
            if (iter & 0xFFFF) == 0 && abort.load(Ordering::Relaxed) {
                return None;
            }
            if block[idx] != simple_test_expected(mode, block_base + idx as u64, seed) {
                local += 1;
            }
            idx = (idx + step) % b_len;
        }
    }
    Some(local)
}

#[allow(dead_code)]
pub(crate) fn verify_mt0_kernel(buf: &mut [u64], kernel: Mt0Kernel, seed: u64) -> u64 {
    verify_mt0_kernel_cancellable(buf, kernel, seed, &AtomicBool::new(false), || None).errors
}

pub(crate) fn verify_mt0_kernel_cancellable<P>(
    buf: &mut [u64],
    kernel: Mt0Kernel,
    seed: u64,
    cancel: &AtomicBool,
    poll_thermal: P,
) -> Mt0KernelOutcome
where
    P: FnMut() -> Option<f32>,
{
    verify_mt0_kernel_cancellable_with_window(buf, kernel, seed, 64, cancel, poll_thermal)
}

pub(crate) fn verify_mt0_kernel_cancellable_with_window<P>(
    buf: &mut [u64],
    kernel: Mt0Kernel,
    seed: u64,
    window_mb: usize,
    cancel: &AtomicBool,
    mut poll_thermal: P,
) -> Mt0KernelOutcome
where
    P: FnMut() -> Option<f32>,
{
    if buf.is_empty() {
        return Mt0KernelOutcome {
            errors: 0,
            bytes_verified: 0,
            cancelled: cancel.load(Ordering::Relaxed),
            thermal_cutoff: None,
        };
    }
    let abort = AtomicBool::new(cancel.load(Ordering::Relaxed));
    if abort.load(Ordering::Relaxed) {
        return Mt0KernelOutcome {
            errors: 0,
            bytes_verified: 0,
            cancelled: true,
            thermal_cutoff: None,
        };
    }
    let word_bytes = std::mem::size_of::<u64>() as u64;

    match kernel {
        Mt0Kernel::RefreshStable { hold_ms } => {
            let chunk_words = (buf.len() / rayon::current_num_threads().max(1)).max(4096);
            let errors = AtomicU64::new(0);
            buf.par_chunks_mut(chunk_words)
                .enumerate()
                .for_each(|(c_idx, chunk)| {
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        return;
                    }
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
            if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                return Mt0KernelOutcome {
                    errors: 0,
                    bytes_verified: 0,
                    cancelled: true,
                    thermal_cutoff: None,
                };
            }
            if hold_ms > 0 {
                let mut rem = hold_ms;
                while rem > 0 {
                    let step = rem.min(50);
                    std::thread::sleep(Duration::from_millis(step));
                    rem -= step;
                    if cancel.load(Ordering::Relaxed) {
                        return Mt0KernelOutcome {
                            errors: 0,
                            bytes_verified: 0,
                            cancelled: true,
                            thermal_cutoff: None,
                        };
                    }
                    if let Some(tc) = poll_thermal() {
                        return Mt0KernelOutcome {
                            errors: 0,
                            bytes_verified: 0,
                            cancelled: false,
                            thermal_cutoff: Some(tc),
                        };
                    }
                }
            }
            let verified_words = AtomicU64::new(0);
            buf.par_chunks(chunk_words)
                .enumerate()
                .for_each(|(c_idx, chunk)| {
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        return;
                    }
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
                    verified_words.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                });
            Mt0KernelOutcome {
                errors: errors.load(Ordering::Relaxed),
                bytes_verified: verified_words.load(Ordering::Relaxed) * word_bytes,
                cancelled: abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed),
                thermal_cutoff: None,
            }
        }
        Mt0Kernel::MirrorMove => {
            let errs = verify_pattern_pass(buf, 1, seed);
            Mt0KernelOutcome {
                errors: errs,
                bytes_verified: buf.len() as u64 * word_bytes,
                cancelled: cancel.load(Ordering::Relaxed),
                thermal_cutoff: None,
            }
        }
        Mt0Kernel::MirrorMove128 => {
            let errs = verify_pattern_pass(buf, 2, seed);
            Mt0KernelOutcome {
                errors: errs,
                bytes_verified: buf.len() as u64 * word_bytes,
                cancelled: cancel.load(Ordering::Relaxed),
                thermal_cutoff: None,
            }
        }
        Mt0Kernel::BlockMove => {
            // Cache-line (64-byte = 8 u64) block copy & rotate verification across half windows
            let line = 8usize;
            let half = ((buf.len() / 2) / line) * line;
            if half < line {
                return Mt0KernelOutcome {
                    errors: 0,
                    bytes_verified: 0,
                    cancelled: false,
                    thermal_cutoff: None,
                };
            }
            let (left, right) = buf.split_at_mut(half);
            let sub_chunk = (((half / rayon::current_num_threads().max(1)).max(4096)) / line) * line;
            let sub_chunk = sub_chunk.max(line);
            left.par_chunks_mut(sub_chunk)
                .enumerate()
                .for_each(|(c_idx, chunk)| {
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        return;
                    }
                    let base = (c_idx * sub_chunk) as u64;
                    for (i, slot) in chunk.iter_mut().enumerate() {
                        *slot = splitmix64((base + i as u64).wrapping_add(seed ^ 0xB10C_CA9E));
                    }
                });
            if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                return Mt0KernelOutcome {
                    errors: 0,
                    bytes_verified: 0,
                    cancelled: true,
                    thermal_cutoff: None,
                };
            }
            if let Some(tc) = poll_thermal() {
                return Mt0KernelOutcome {
                    errors: 0,
                    bytes_verified: 0,
                    cancelled: false,
                    thermal_cutoff: Some(tc),
                };
            }
            // Rotate each 8-word cache-line block by 1 word during block copy
            right[..half]
                .par_chunks_mut(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        return;
                    }
                    for (d_blk, s_blk) in dst.chunks_exact_mut(line).zip(src.chunks_exact(line)) {
                        for k in 0..line {
                            d_blk[k] = s_blk[(k + 1) & 7];
                        }
                    }
                });
            if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                return Mt0KernelOutcome {
                    errors: 0,
                    bytes_verified: 0,
                    cancelled: true,
                    thermal_cutoff: None,
                };
            }
            let errors = AtomicU64::new(0);
            let verified_words = AtomicU64::new(0);
            right[..half]
                .par_chunks(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        return;
                    }
                    let mut local = 0u64;
                    for (d_blk, s_blk) in dst.chunks_exact(line).zip(src.chunks_exact(line)) {
                        for k in 0..line {
                            if d_blk[k] != s_blk[(k + 1) & 7] {
                                local += 1;
                            }
                        }
                    }
                    if local > 0 {
                        errors.fetch_add(local, Ordering::Relaxed);
                    }
                    verified_words.fetch_add((dst.len() * 2) as u64, Ordering::Relaxed);
                });
            Mt0KernelOutcome {
                errors: errors.load(Ordering::Relaxed),
                bytes_verified: verified_words.load(Ordering::Relaxed) * word_bytes,
                cancelled: abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed),
                thermal_cutoff: None,
            }
        }
        Mt0Kernel::SimpleTest {
            mode,
            stride,
            block_mb,
        } => {
            let block_words = ((block_mb.clamp(1, 64) * 1024 * 1024) / std::mem::size_of::<u64>())
                .min(buf.len())
                .max(1);
            let errors = AtomicU64::new(0);

            if stride <= 1 {
                let sub = &mut buf[..block_words];
                let chunk_words = (sub.len() / rayon::current_num_threads().max(1)).max(4096);
                sub.par_chunks_mut(chunk_words)
                    .enumerate()
                    .for_each(|(c_idx, chunk)| {
                        if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                            abort.store(true, Ordering::Relaxed);
                            return;
                        }
                        let base = (c_idx * chunk_words) as u64;
                        for (i, slot) in chunk.iter_mut().enumerate() {
                            *slot = simple_test_expected(mode, base + i as u64, seed);
                        }
                    });
                if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                    return Mt0KernelOutcome {
                        errors: 0,
                        bytes_verified: 0,
                        cancelled: true,
                        thermal_cutoff: None,
                    };
                }
                let verified_words = AtomicU64::new(0);
                sub.par_chunks(chunk_words)
                    .enumerate()
                    .for_each(|(c_idx, chunk)| {
                        if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                            abort.store(true, Ordering::Relaxed);
                            return;
                        }
                        let base = (c_idx * chunk_words) as u64;
                        let mut local = 0u64;
                        for (i, &val) in chunk.iter().enumerate() {
                            if val != simple_test_expected(mode, base + i as u64, seed) {
                                local += 1;
                            }
                        }
                        if local > 0 {
                            errors.fetch_add(local, Ordering::Relaxed);
                        }
                        verified_words.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    });
                Mt0KernelOutcome {
                    errors: errors.load(Ordering::Relaxed),
                    bytes_verified: verified_words.load(Ordering::Relaxed) * word_bytes,
                    cancelled: abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed),
                    thermal_cutoff: None,
                }
            } else {
                // Parallel strided sweep across <= 32-64 MB sub-slices with mid-kernel cancel & thermal checks
                let max_win_words = ((window_mb.clamp(1, 64) * 1024 * 1024)
                    / std::mem::size_of::<u64>())
                .max(block_words);
                let blocks_per_win = (max_win_words / block_words).max(1);
                let win_words = blocks_per_win * block_words;

                let mut total_verified_words = 0u64;
                let mut cancelled = false;
                let mut thermal_cutoff: Option<f32> = None;

                for (w_idx, window) in buf.chunks_mut(win_words).enumerate() {
                    if cancel.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed) {
                        abort.store(true, Ordering::Relaxed);
                        cancelled = true;
                        break;
                    }
                    if let Some(tc) = poll_thermal() {
                        abort.store(true, Ordering::Relaxed);
                        thermal_cutoff = Some(tc);
                        break;
                    }

                    let win_base = (w_idx * win_words) as u64;
                    let completed_words = AtomicU64::new(0);
                    window
                        .par_chunks_mut(block_words)
                        .enumerate()
                        .for_each(|(b_idx, block)| {
                            if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                                abort.store(true, Ordering::Relaxed);
                                return;
                            }
                            let block_base = win_base + (b_idx * block_words) as u64;
                            if !simple_test_strided_block_write(
                                block,
                                block_base,
                                mode,
                                stride,
                                seed,
                                &abort,
                            ) {
                                return;
                            }
                            if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                                abort.store(true, Ordering::Relaxed);
                                return;
                            }
                            if let Some(local_errs) = simple_test_strided_block_verify(
                                block,
                                block_base,
                                mode,
                                stride,
                                seed,
                                &abort,
                            ) {
                                if local_errs > 0 {
                                    errors.fetch_add(local_errs, Ordering::Relaxed);
                                }
                                completed_words.fetch_add(block.len() as u64, Ordering::Relaxed);
                            }
                        });

                    total_verified_words += completed_words.load(Ordering::Relaxed);
                    if abort.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        if thermal_cutoff.is_none() {
                            cancelled = true;
                        }
                        break;
                    }
                }

                Mt0KernelOutcome {
                    errors: errors.load(Ordering::Relaxed),
                    bytes_verified: total_verified_words * word_bytes,
                    cancelled,
                    thermal_cutoff,
                }
            }
        }
    }
}

/// Authentic TestMem5-inspired memory verification engine implementing:
/// - RefreshStable (DRAM retention check with timed hold between write & verify)
/// - SimpleTest Mode 1 & Mode 2 (serj/anta777 seeded bit-pattern & walking inversions)
/// - MirrorMove (64-bit cross-bank half-window mirror, invert & verify)
/// - MirrorMove128 (128-bit SIMD-aligned dual-word mirror & verify across cache lines)
pub fn verify_pattern_pass(buf: &mut [u64], test_kind: usize, seed: u64) -> u64 {
    let chunk_words = (buf.len() / rayon::current_num_threads().max(1)).max(4096);
    let errors = AtomicU64::new(0);

    match test_kind {
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
            std::thread::sleep(Duration::from_millis(90));
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
            right[..half]
                .par_chunks_mut(sub_chunk)
                .zip(left.par_chunks(sub_chunk))
                .for_each(|(dst, src)| {
                    for (d, &s) in dst.iter_mut().zip(src.iter()) {
                        *d = !s;
                    }
                });
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

fn build_mt0_sequence(preset: &str, target_mb: u64) -> Vec<(&'static str, Mt0Kernel)> {
    let max_blk = (target_mb as usize).clamp(1, 64);
    let mut seq = vec![
        ("Test0: RefreshStable (Retention)", Mt0Kernel::RefreshStable { hold_ms: 90 }),
        ("Test1: SimpleTest Mode 0 Constant", Mt0Kernel::SimpleTest { mode: 0, stride: 0, block_mb: max_blk.min(16) }),
        ("Test2: SimpleTest Mode 1 (1MB L3 Edge)", Mt0Kernel::SimpleTest { mode: 1, stride: 0, block_mb: 1 }),
        ("Test3: SimpleTest Mode 1 (256 Bank Stride)", Mt0Kernel::SimpleTest { mode: 1, stride: 256, block_mb: max_blk.min(8) }),
        ("Test4: MirrorMove (64-bit Bus)", Mt0Kernel::MirrorMove),
        ("Test5: SimpleTest Mode 2 PRNG (Prime 257)", Mt0Kernel::SimpleTest { mode: 2, stride: 257, block_mb: max_blk.min(32) }),
        ("Test6: MirrorMove128 (128-bit SIMD)", Mt0Kernel::MirrorMove128),
        ("Test7: BlockMove (64B Cache-Line)", Mt0Kernel::BlockMove),
    ];
    if preset == "standard" || preset == "burnin" {
        seq.extend_from_slice(&[
            ("Test8: SimpleTest Mode 1 (4MB Block)", Mt0Kernel::SimpleTest { mode: 1, stride: 0, block_mb: max_blk.min(4) }),
            ("Test9: SimpleTest Mode 2 (Prime 359, 16MB)", Mt0Kernel::SimpleTest { mode: 2, stride: 359, block_mb: max_blk.min(16) }),
            ("Test10: SimpleTest Mode 2 (64MB Full Rank)", Mt0Kernel::SimpleTest { mode: 2, stride: 0, block_mb: max_blk }),
            ("Test11: RefreshStable Inverted", Mt0Kernel::RefreshStable { hold_ms: 110 }),
        ]);
    }
    if preset == "burnin" {
        seq.extend_from_slice(&[
            ("Test12: SimpleTest Mode 0 (2MB Block)", Mt0Kernel::SimpleTest { mode: 0, stride: 256, block_mb: max_blk.min(2) }),
            ("Test13: SimpleTest Mode 2 (Prime 479, 32MB)", Mt0Kernel::SimpleTest { mode: 2, stride: 479, block_mb: max_blk.min(32) }),
            ("Test14: BlockMove High-Entropy", Mt0Kernel::BlockMove),
            ("Test15: MirrorMove128 Sustained", Mt0Kernel::MirrorMove128),
        ]);
    }
    seq
}

pub(crate) fn compute_sensor_bounded_duration(duration_secs: u64, sensor_unavailable: bool) -> u64 {
    if sensor_unavailable {
        duration_secs.min(300)
    } else {
        duration_secs
    }
}

pub fn run_ram_stress_test(
    app: &AppHandle,
    preset: &str,
    memory_percent: Option<u32>,
    custom_duration_secs: Option<u64>,
    memory_type_hint: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<RamTestResult, String> {
    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mb = sys.total_memory() / (1024 * 1024);
    let avail_ram_mb = sys.available_memory() / (1024 * 1024);

    let pct = memory_percent.unwrap_or(65).clamp(30, 75);
    let (target_mb, os_reserve_mb) = compute_safe_ram_window_mb(total_ram_mb, avail_ram_mb, pct)?;

    // Real time-enforced durability durations (never exits in 2 seconds!)
    let (profile_name, default_duration_secs): (&str, u64) = match preset {
        "standard" => ("Absolut @ anta777 (5m Durability)", 300),
        "burnin" => ("Extreme @ anta777 (15m Burn-In)", 900),
        _ => ("Default @ serj (2m Shop QC)", 120),
    };
    let requested_duration_secs = custom_duration_secs.unwrap_or(default_duration_secs).clamp(30, 3600);

    let test_sequence = build_mt0_sequence(preset, target_mb);

    let word_count = ((target_mb as usize * 1024 * 1024) / std::mem::size_of::<u64>()) & !1;

    let mut telemetry = TelemetryReader::new();
    let init_snap = telemetry.sample_throttled(false, Duration::from_millis(900));
    let mut peak_cpu_temp_c: Option<f32> = init_snap.cpu_temp_c;
    let mut thermal_cutoff_triggered = false;
    let mut sensor_unavailable = false;
    let mut sensor_available_ever = init_snap.cpu_temp_available;

    match TelemetryReader::is_thermal_safe(&init_snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY) {
        ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => {
            peak_cpu_temp_c = Some(temp_c);
            thermal_cutoff_triggered = true;
        }
        ThermalSafetyCheck::SensorUnavailable => {
            sensor_unavailable = true;
        }
        ThermalSafetyCheck::Safe => {}
    }

    let mut buffer = if !thermal_cutoff_triggered {
        vec![0u64; word_count]
    } else {
        Vec::new()
    };

    let mut duration_secs = compute_sensor_bounded_duration(requested_duration_secs, sensor_unavailable);

    let started = Instant::now();
    let mut total_errors = 0u64;
    let mut total_gb_verified = 0.0f64;
    let mut peak_bw = 0.0f64;
    let mut bw_sum = 0.0f64;
    let mut bw_samples = 0u64;
    let mut cycles_completed = 0u32;
    let mut cancelled = false;
    let mut per_test_passes = vec![0u32; test_sequence.len()];
    let mut per_test_errors = vec![0u64; test_sequence.len()];

    let mut cycle: u32 = 0;
    if !thermal_cutoff_triggered {
        'outer: loop {
            cycle += 1;
            for (t_idx, &(pname, kernel)) in test_sequence.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break 'outer;
                }

                let snap = telemetry.sample_throttled(false, Duration::from_millis(850));
                if let Some(t) = snap.cpu_temp_c {
                    peak_cpu_temp_c = Some(peak_cpu_temp_c.map_or(t, |p| p.max(t)));
                }
                if snap.cpu_temp_available {
                    sensor_available_ever = true;
                    sensor_unavailable = false;
                }
                match TelemetryReader::is_thermal_safe(&snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY) {
                    ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => {
                        peak_cpu_temp_c = Some(peak_cpu_temp_c.map_or(temp_c, |p| p.max(temp_c)));
                        thermal_cutoff_triggered = true;
                        break 'outer;
                    }
                    ThermalSafetyCheck::SensorUnavailable => {
                        if !sensor_available_ever {
                            sensor_unavailable = true;
                            duration_secs = compute_sensor_bounded_duration(requested_duration_secs, true);
                        }
                    }
                    ThermalSafetyCheck::Safe => {}
                }

                let t_pass = Instant::now();
                let seed = (cycle as u64)
                    .wrapping_mul(0xD1B5_4A32_D192_ED03)
                    ^ ((t_idx as u64).wrapping_mul(0x94D0_49BB_1331_11EB));
                let mut last_snap = snap;
                let outcome = verify_mt0_kernel_cancellable(&mut buffer, kernel, seed, &cancel, || {
                    let s = telemetry.sample_throttled(false, Duration::from_millis(850));
                    if let Some(t) = s.cpu_temp_c {
                        peak_cpu_temp_c = Some(peak_cpu_temp_c.map_or(t, |p| p.max(t)));
                    }
                    if s.cpu_temp_available {
                        sensor_available_ever = true;
                        sensor_unavailable = false;
                    }
                    let check = TelemetryReader::is_thermal_safe(
                        &s,
                        CPU_THERMAL_CUTOFF_DEFAULT_C,
                        f32::INFINITY,
                    );
                    last_snap = s;
                    match check {
                        ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => Some(temp_c),
                        ThermalSafetyCheck::SensorUnavailable => {
                            if !sensor_available_ever {
                                sensor_unavailable = true;
                                duration_secs =
                                    compute_sensor_bounded_duration(requested_duration_secs, true);
                            }
                            None
                        }
                        ThermalSafetyCheck::Safe => None,
                    }
                });
                let errs = outcome.errors;
                total_errors += errs;
                per_test_errors[t_idx] += errs;

                let pass_secs = t_pass.elapsed().as_secs_f64().max(0.001);
                let pass_gb = (outcome.bytes_verified as f64 * 2.0) / (1024.0 * 1024.0 * 1024.0);
                total_gb_verified += pass_gb;
                if let Some(tc) = outcome.thermal_cutoff {
                    peak_cpu_temp_c = Some(peak_cpu_temp_c.map_or(tc, |p| p.max(tc)));
                    thermal_cutoff_triggered = true;
                    break 'outer;
                }
                if outcome.cancelled {
                    cancelled = true;
                    break 'outer;
                }
                per_test_passes[t_idx] += 1;

                let bw = ((pass_gb / pass_secs) * 100.0).round() / 100.0;
                if bw > peak_bw {
                    peak_bw = bw;
                }
                bw_sum += bw;
                bw_samples += 1;

                let elapsed = started.elapsed().as_secs_f64();
                let pct_done = ((elapsed / duration_secs as f64) * 100.0).min(99.5);
                let thermal_warning = last_snap
                    .cpu_temp_c
                    .map(|t| t >= CPU_THERMAL_CUTOFF_DEFAULT_C - 6.0)
                    .unwrap_or(false);

                let _ = app.emit(
                    "ram:progress",
                    RamTestProgress {
                        running: true,
                        profile_name: profile_name.to_string(),
                        test_index: t_idx,
                        pattern_name: pname.to_string(),
                        cycle,
                        percent: pct_done,
                        allocated_mb: target_mb,
                        total_gb_verified: (total_gb_verified * 10.0).round() / 10.0,
                        bandwidth_gb_s: bw,
                        errors_found: total_errors,
                        per_test_passes: per_test_passes.clone(),
                        per_test_errors: per_test_errors.clone(),
                        elapsed_secs: (elapsed * 10.0).round() / 10.0,
                        duration_secs,
                        cpu_temp_c: last_snap.cpu_temp_c,
                        thermal_warning,
                    },
                );

                if elapsed >= duration_secs as f64 {
                    cycles_completed = cycle;
                    break 'outer;
                }
            }
            cycles_completed = cycle;
        }
    }

    drop(buffer);

    if thermal_cutoff_triggered {
        let _ = app.emit(
            "ram:progress",
            RamTestProgress {
                running: false,
                profile_name: profile_name.to_string(),
                test_index: 0,
                pattern_name: "CPU Thermal Cutoff Triggered".to_string(),
                cycle,
                percent: 100.0,
                allocated_mb: target_mb,
                total_gb_verified: (total_gb_verified * 10.0).round() / 10.0,
                bandwidth_gb_s: peak_bw,
                errors_found: total_errors,
                per_test_passes: per_test_passes.clone(),
                per_test_errors: per_test_errors.clone(),
                elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                duration_secs,
                cpu_temp_c: peak_cpu_temp_c,
                thermal_warning: true,
            },
        );
    }

    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let avg_bw = if bw_samples > 0 {
        ((bw_sum / bw_samples as f64) * 10.0).round() / 10.0
    } else {
        peak_bw
    };

    let mtype = memory_type_hint.unwrap_or_else(|| "DDR4".into());
    let baseline = baselines::rate_ram(&mtype, peak_bw, total_errors);

    let ub_cmp = userbenchmark::compare_userbenchmark(&UserBenchmarkInput {
        ram_type: Some(mtype.clone()),
        ram_bandwidth_gb_s: if peak_bw > 0.0 { Some(peak_bw) } else { None },
        ram_errors_found: total_errors,
        allow_live_lookup: false,
        ..Default::default()
    });
    let userbenchmark_rating = ub_cmp.ram;

    let status = if total_errors > 0 || thermal_cutoff_triggered {
        TestStatus::Fail
    } else if cancelled {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "CPU THERMAL CUTOFF ({:.0}°C >= {:.0}°C) during RAM stress — test aborted safely ({:.1} GB verified, {} error(s)).",
            peak_cpu_temp_c.unwrap_or(CPU_THERMAL_CUTOFF_DEFAULT_C),
            CPU_THERMAL_CUTOFF_DEFAULT_C,
            total_gb_verified,
            total_errors
        )
    } else if total_errors > 0 {
        format!(
            "RAM FAILURE ({}): {} bit error(s) after {:.1} GB verified!",
            profile_name, total_errors, total_gb_verified
        )
    } else if cancelled {
        format!(
            "Stopped early at {:.0}s — {:.1} GB verified across {} MB window, 0 errors.",
            elapsed, total_gb_verified, target_mb
        )
    } else {
        format!(
            "[{}] 0 errors across {:.1} GB verified ({} MB window, {} MB OS reserve, {} cycles, {:.0}s, peak {:.1} GB/s).",
            baseline.grade, total_gb_verified, target_mb, os_reserve_mb, cycles_completed, elapsed, peak_bw
        )
    };

    let ub_note = userbenchmark_rating
        .as_ref()
        .map(|u| format!(" UserBenchmark: {} ({:.0}% — {}).", u.vehicle_tier, u.effective_speed_pct, u.standing_label))
        .unwrap_or_default();
    let sensor_note = if sensor_unavailable {
        " Thermal sensor unavailable — duration safely bounded."
    } else {
        ""
    };
    let plain_summary = if thermal_cutoff_triggered {
        format!(
            "RAM test stopped early because CPU temperature hit {:.0}°C (limit {:.0}°C). Clean fans/thermal paste before re-testing.",
            peak_cpu_temp_c.unwrap_or(CPU_THERMAL_CUTOFF_DEFAULT_C),
            CPU_THERMAL_CUTOFF_DEFAULT_C
        )
    } else if total_errors > 0 {
        format!(
            "Unstable RAM: {} memory bit-flip error(s) detected across {:.1} GB verified. Memory module or slot requires replacement.",
            total_errors, total_gb_verified
        )
    } else {
        format!(
            "RAM passed with 0 bit errors across {:.1} GB ({} MB test window, {} MB preserved for OS, peak {:.1} GB/s).{}{}",
            total_gb_verified, target_mb, os_reserve_mb, peak_bw, ub_note, sensor_note
        )
    };

    Ok(RamTestResult {
        status,
        preset: preset.to_string(),
        profile_name: profile_name.to_string(),
        allocated_mb: target_mb,
        total_ram_mb,
        total_gb_verified: (total_gb_verified * 10.0).round() / 10.0,
        cycles_completed,
        patterns_tested: test_sequence.iter().map(|(n, _)| n.to_string()).collect(),
        per_test_passes,
        per_test_errors,
        errors_found: total_errors,
        peak_bandwidth_gb_s: peak_bw,
        avg_bandwidth_gb_s: avg_bw,
        elapsed_secs: elapsed,
        cancelled,
        baseline,
        summary,
        os_reserve_mb,
        peak_cpu_temp_c: peak_cpu_temp_c.map(|t| (t * 10.0).round() / 10.0),
        thermal_cutoff_triggered,
        sensor_unavailable,
        userbenchmark_rating,
        plain_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::LiveTelemetrySnapshot;

    #[test]
    fn test_os_ram_reserve_bounds() {
        // 4 GB -> 22% = 901 MB
        assert_eq!(compute_ram_os_reserve_mb(4096), 901);
        // 2 GB -> 22% = 450 -> floored to 512 MB
        assert_eq!(compute_ram_os_reserve_mb(2048), 512);
        // 8 GB -> 22% = 1802 -> capped at 1800 MB
        assert_eq!(compute_ram_os_reserve_mb(8192), 1800);
        // 16 GB & 32 GB -> capped at 1800 MB
        assert_eq!(compute_ram_os_reserve_mb(16384), 1800);
        assert_eq!(compute_ram_os_reserve_mb(32768), 1800);

        for (total, avail) in [(4096u64, 1800u64), (8192, 3500), (16384, 10000), (32768, 22000)] {
            let (target, reserve) = compute_safe_ram_window_mb(total, avail, 75).unwrap();
            assert!(avail - target >= reserve, "avail={} target={} reserve={}", avail, target, reserve);
        }

        // Insufficient available RAM must error cleanly instead of forcing 512 MB
        assert!(compute_safe_ram_window_mb(8192, 1800, 65).is_err());
        assert!(compute_safe_ram_window_mb(8192, 1850, 65).is_err());
    }

    #[test]
    fn test_ram_memory_percent_clamp_30_to_75() {
        // 20% must clamp up to 30%, 95% must clamp down to 75%
        let (target_20, reserve_20) = compute_safe_ram_window_mb(16384, 10000, 20).unwrap();
        let (target_30, reserve_30) = compute_safe_ram_window_mb(16384, 10000, 30).unwrap();
        assert_eq!(target_20, target_30);
        assert_eq!(reserve_20, reserve_30);
        assert_eq!(target_20, 3000);

        let (target_50, _) = compute_safe_ram_window_mb(16384, 10000, 50).unwrap();
        assert_eq!(target_50, 5000);

        let (target_95, reserve_95) = compute_safe_ram_window_mb(16384, 10000, 95).unwrap();
        let (target_75, reserve_75) = compute_safe_ram_window_mb(16384, 10000, 75).unwrap();
        assert_eq!(target_95, target_75);
        assert_eq!(reserve_95, reserve_75);
        assert_eq!(target_95, 7500);
    }

    #[test]
    fn test_mt0_kernels_clean_and_injected_error() {
        let mut buf = vec![0u64; 16384];
        let kernels = [
            Mt0Kernel::RefreshStable { hold_ms: 0 },
            Mt0Kernel::SimpleTest { mode: 0, stride: 0, block_mb: 1 },
            Mt0Kernel::SimpleTest { mode: 1, stride: 256, block_mb: 1 },
            Mt0Kernel::SimpleTest { mode: 2, stride: 257, block_mb: 1 },
            Mt0Kernel::MirrorMove,
            Mt0Kernel::MirrorMove128,
            Mt0Kernel::BlockMove,
        ];
        for (i, &k) in kernels.iter().enumerate() {
            let errs = verify_mt0_kernel(&mut buf, k, 42 + i as u64);
            assert_eq!(errs, 0, "clean kernel {} failed with {} errors", i, errs);
        }

        // Verify legacy verify_pattern_pass kinds 0..=4 still work cleanly
        for pid in 0..=4 {
            assert_eq!(verify_pattern_pass(&mut buf, pid, 99), 0);
        }

        // Verify injected bit-flip detection on BlockMove & strided SimpleTest
        let b_len = buf.len();
        let step = coprime_stride(b_len, 257);
        let mut idx = 0usize;
        for _ in 0..b_len {
            buf[idx] = simple_test_expected(2, idx as u64, 77);
            idx = (idx + step) % b_len;
        }
        buf[1234] ^= 0x1; // flip 1 bit
        let mut injected_errs = 0u64;
        idx = 0;
        for _ in 0..b_len {
            if buf[idx] != simple_test_expected(2, idx as u64, 77) {
                injected_errs += 1;
            }
            idx = (idx + step) % b_len;
        }
        assert_eq!(injected_errs, 1);
    }

    #[test]
    fn test_ram_thermal_cutoff_and_sensor_unavailable_fallback() {
        let hot_snap = LiveTelemetrySnapshot {
            cpu_temp_c: Some(92.0),
            cpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot_snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY),
            ThermalSafetyCheck::CutoffTriggered {
                sensor: "CPU",
                temp_c: 92.0
            }
        );

        let missing_snap = LiveTelemetrySnapshot {
            cpu_temp_c: None,
            cpu_temp_available: false,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&missing_snap, CPU_THERMAL_CUTOFF_DEFAULT_C, f32::INFINITY),
            ThermalSafetyCheck::SensorUnavailable
        );
        assert_eq!(compute_sensor_bounded_duration(900, true), 300);
        assert_eq!(compute_sensor_bounded_duration(900, false), 900);
    }

    #[test]
    fn test_strided_simple_test_parallel_multi_block_and_bit_flip_detection() {
        // Multi-block buffer (~4.1 MB with odd tail) covering both 256 bank jump and prime strides
        let mut buf = vec![0u64; 540_000];
        for &(mode, stride) in &[(0u8, 256usize), (1, 256), (2, 257), (2, 359), (2, 479)] {
            let errs = verify_mt0_kernel(
                &mut buf,
                Mt0Kernel::SimpleTest {
                    mode,
                    stride,
                    block_mb: 1,
                },
                12345,
            );
            assert_eq!(errs, 0, "multi-block strided pass failed: mode={} stride={}", mode, stride);
        }

        // Verify single flipped bit detection via block helpers for both stride=256 and stride=257
        let abort = AtomicBool::new(false);
        for &stride in &[256usize, 257usize] {
            let mut small = vec![0u64; 4099]; // odd length > 256
            assert!(simple_test_strided_block_write(&mut small, 8192, 2, stride, 55, &abort));
            assert_eq!(
                simple_test_strided_block_verify(&small, 8192, 2, stride, 55, &abort),
                Some(0)
            );
            small[2047] ^= 0x80;
            assert_eq!(
                simple_test_strided_block_verify(&small, 8192, 2, stride, 55, &abort),
                Some(1)
            );
        }
    }

    #[test]
    fn test_strided_simple_test_mid_kernel_cancel_and_thermal_cutoff() {
        // 8 MB buffer split into 1 MB windows (8 windows total)
        let mut buf = vec![0u64; 1_048_576];
        let total_bytes = (buf.len() * std::mem::size_of::<u64>()) as u64;

        // 1. Mid-kernel ThermalCutoff triggered on 3rd window poll
        let cancel_ok = AtomicBool::new(false);
        let mut polls = 0u32;
        let thermal_out = verify_mt0_kernel_cancellable_with_window(
            &mut buf,
            Mt0Kernel::SimpleTest {
                mode: 2,
                stride: 257,
                block_mb: 1,
            },
            77,
            1,
            &cancel_ok,
            || {
                polls += 1;
                if polls >= 3 {
                    Some(93.0)
                } else {
                    None
                }
            },
        );
        assert_eq!(thermal_out.thermal_cutoff, Some(93.0));
        assert!(!thermal_out.cancelled);
        assert_eq!(thermal_out.errors, 0);
        assert!(
            thermal_out.bytes_verified > 0 && thermal_out.bytes_verified < total_bytes,
            "expected partial mid-kernel abort, got {} of {} bytes",
            thermal_out.bytes_verified,
            total_bytes
        );

        // 2. Mid-kernel Cancel triggered on 2nd window poll
        let cancel_flag = AtomicBool::new(false);
        let mut c_polls = 0u32;
        let cancel_out = verify_mt0_kernel_cancellable_with_window(
            &mut buf,
            Mt0Kernel::SimpleTest {
                mode: 1,
                stride: 256,
                block_mb: 1,
            },
            88,
            1,
            &cancel_flag,
            || {
                c_polls += 1;
                if c_polls >= 2 {
                    cancel_flag.store(true, Ordering::Relaxed);
                }
                None
            },
        );
        assert!(cancel_out.cancelled);
        assert_eq!(cancel_out.thermal_cutoff, None);
        assert_eq!(cancel_out.errors, 0);
        assert!(
            cancel_out.bytes_verified > 0 && cancel_out.bytes_verified < total_bytes,
            "expected partial mid-kernel cancel, got {} of {} bytes",
            cancel_out.bytes_verified,
            total_bytes
        );
    }
}
