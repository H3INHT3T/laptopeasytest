use crate::modules::simd_kernels;
use crate::types::{
    BatteryCapacityHistoryPoint, BatteryChargeProgress, BatteryChargeResult,
    BatteryDischargeProgress, BatteryDischargeResult, BatteryHealthReport, BatteryLiveSample,
    BatterySagProgress, BatterySagResult, TestStatus, BATTERY_DISCHARGE_MAX_SECS,
    BATTERY_LOW_SOC_ABORT_PCT,
};
use chrono::Utc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

struct WorkerPoolGuard {
    worker_stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl WorkerPoolGuard {
    fn spawn_simd_load(cancel: &AtomicBool) -> Self {
        let worker_stop = Arc::new(AtomicBool::new(false));
        let n_threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(1).max(2))
            .unwrap_or(2);
        let cancel_ptr = cancel.load(Ordering::Relaxed);
        let mut handles = Vec::with_capacity(n_threads);
        if !cancel_ptr {
            for idx in 0..n_threads {
                let st = worker_stop.clone();
                handles.push(std::thread::spawn(move || {
                    let mut k = 0u32;
                    while !st.load(Ordering::Relaxed) {
                        let _ = simd_kernels::simd_ai_gemm_step(
                            96,
                            (idx as f32) + (k as f32) * 0.01,
                        );
                        k = k.wrapping_add(1);
                    }
                }));
            }
        }
        Self {
            worker_stop,
            handles,
        }
    }

    fn shutdown(&mut self) {
        self.worker_stop.store(true, Ordering::SeqCst);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for WorkerPoolGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn get_battery_health() -> BatteryHealthReport {
    #[cfg(target_os = "windows")]
    {
        get_windows_battery_health()
    }
    #[cfg(target_os = "macos")]
    {
        get_macos_battery_health()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        BatteryHealthReport {
            present: false,
            status: TestStatus::NotApplicable,
            manufacturer: String::new(),
            chemistry: String::new(),
            design_capacity_mwh: None,
            full_charge_capacity_mwh: None,
            health_percent: None,
            wear_percent: None,
            cycle_count: None,
            current_charge_percent: None,
            is_charging: false,
            ac_plugged: true,
            voltage_mv: None,
            rate_mw: None,
            adapter_watts: None,
            notes: "Battery query not supported on this OS.".to_string(),
            cycle_source: String::new(),
            capacity_history: Vec::new(),
            adapter_source: String::new(),
            adapter_warning: None,
        }
    }
}

/// Evaluates whether the connected AC / USB-C PD adapter wattage is adequate for this laptop class (v3.1.0).
/// Catches undersized / generic 45W-65W adapters shipped with discrete-GPU gaming or workstation laptops.
pub fn evaluate_charger_adequacy(
    ac_plugged: bool,
    adapter_watts: Option<u32>,
    has_discrete_gpu: bool,
) -> Option<String> {
    if !ac_plugged {
        return None;
    }
    let w = adapter_watts?;
    if has_discrete_gpu && w <= 65 {
        Some(format!(
            "Undersized AC charger ({}W) detected on discrete-GPU laptop — battery may drain under gaming/full load. Verify OEM 130W+ adapter.",
            w
        ))
    } else if w < 30 {
        Some(format!(
            "Very low-wattage USB-C / AC adapter ({}W) detected — laptop may trickle-charge or lose charge during normal use.",
            w
        ))
    } else {
        None
    }
}

/// Smart-Bench Active Charging IC & Conservation-Mode Classifier (v2.10.0).
/// Distinguishes healthy AC charging, OEM 80%/90% Battery Conservation Mode (WARN, not FAIL),
/// trickle/slow USB-C PD negotiation (WARN), and real "Plugged in, not charging" IC/MOSFET faults (FAIL).
pub fn classify_battery_charge_test(
    samples: &[BatteryLiveSample],
    duration_secs: f64,
    cancelled: bool,
) -> BatteryChargeResult {
    if samples.is_empty() {
        let msg = "No internal battery detected (AC-only desktop or battery disconnected).".to_string();
        return BatteryChargeResult {
            status: TestStatus::NotApplicable,
            verdict: "NOT_APPLICABLE".to_string(),
            duration_secs: round1(duration_secs),
            plain_summary: msg.clone(),
            summary: format!("NOT_APPLICABLE: {}", msg),
            ..Default::default()
        };
    }

    let first = &samples[0];
    let last = &samples[samples.len() - 1];
    let any_ac = samples.iter().any(|s| s.ac_plugged);
    let any_charging = samples.iter().any(|s| s.is_charging);
    let start_pct = round1(first.charge_percent);
    let end_pct = round1(last.charge_percent);
    let gain_pct = round1(end_pct - start_pct);

    let finite_watts: Vec<f64> = samples
        .iter()
        .filter_map(|s| s.watts.filter(|w| w.is_finite()))
        .collect();
    let avg_w = if finite_watts.is_empty() {
        None
    } else {
        Some(round2(finite_watts.iter().sum::<f64>() / finite_watts.len() as f64))
    };
    let peak_w = finite_watts
        .iter()
        .copied()
        .reduce(f64::max)
        .map(round2);

    if cancelled && duration_secs < 4.0 {
        let msg = format!(
            "Charging IC check stopped early at {:.1}s before enough AC telemetry was captured.",
            duration_secs
        );
        return BatteryChargeResult {
            status: TestStatus::Warn,
            verdict: "CANCELLED".to_string(),
            duration_secs: round1(duration_secs),
            ac_plugged: last.ac_plugged,
            start_charge_pct: start_pct,
            end_charge_pct: end_pct,
            charge_gain_pct: gain_pct,
            avg_charge_watts: avg_w,
            peak_charge_watts: peak_w,
            start_voltage_mv: first.voltage_mv,
            end_voltage_mv: last.voltage_mv,
            plain_summary: msg.clone(),
            summary: format!("CANCELLED: {}", msg),
        };
    }

    if !any_ac || !last.ac_plugged {
        let msg = "AC power adapter is not connected. Plug in the charger and re-run to verify the charging IC.".to_string();
        return BatteryChargeResult {
            status: TestStatus::Warn,
            verdict: "AC_UNPLUGGED".to_string(),
            duration_secs: round1(duration_secs),
            ac_plugged: false,
            start_charge_pct: start_pct,
            end_charge_pct: end_pct,
            charge_gain_pct: gain_pct,
            avg_charge_watts: avg_w,
            peak_charge_watts: peak_w,
            start_voltage_mv: first.voltage_mv,
            end_voltage_mv: last.voltage_mv,
            plain_summary: msg.clone(),
            summary: format!("AC_UNPLUGGED: {}", msg),
        };
    }

    let eff_avg_w = avg_w.unwrap_or(0.0);
    let eff_peak_w = peak_w.unwrap_or(0.0);
    let has_watt_sensor = avg_w.is_some();

    let (status, verdict, plain_summary) = if eff_avg_w >= 2.0
        || eff_peak_w >= 2.5
        || gain_pct >= 0.5
        || (end_pct >= 96.0 && (!has_watt_sensor || eff_avg_w >= -0.5))
    {
        let w_txt = avg_w
            .map(|w| format!(" at {:+.1}W avg (peak {:+.1}W)", w, eff_peak_w))
            .unwrap_or_default();
        let detail = if end_pct >= 96.0 && eff_avg_w < 2.0 {
            format!(
                "AC adapter verified at {:.0}% full charge{} — charging circuit holding full float voltage.",
                end_pct, w_txt
            )
        } else {
            format!(
                "Charging IC healthy: active AC charge verified{} ({:.1}% -> {:.1}% over {:.0}s).",
                w_txt, start_pct, end_pct, duration_secs
            )
        };
        (TestStatus::Pass, "PASS".to_string(), detail)
    } else if ((77.0..=84.0).contains(&end_pct) || (87.0..=95.9).contains(&end_pct))
        && (!has_watt_sensor || eff_avg_w > -1.5)
    {
        (
            TestStatus::Warn,
            "CONSERVATION_MODE".to_string(),
            format!(
                "AC connected at {:.0}% with ~{:.1}W net charge — likely OEM Battery Conservation / Charge Limit (80% or 90% threshold) rather than a dead charging IC. Temporarily disable conservation mode in BIOS/OEM app to confirm full charge.",
                end_pct, eff_avg_w
            ),
        )
    } else if eff_avg_w >= 0.3 || eff_peak_w >= 0.5 || (!has_watt_sensor && any_charging) {
        (
            TestStatus::Warn,
            "SLOW_CHARGE".to_string(),
            format!(
                "Slow/trickle AC charging detected ({:+.1}W avg at {:.0}% SoC) — verify charger wattage or USB-C PD handshake.",
                eff_avg_w, end_pct
            ),
        )
    } else if end_pct < 75.0 && (!has_watt_sensor || eff_avg_w <= 0.0) {
        (
            TestStatus::Fail,
            "CHARGING_IC_FAULT".to_string(),
            format!(
                "FAIL: Plugged into AC at {:.0}% (< 75%) but battery is NOT charging ({:+.1}W avg, {:.1}% gain over {:.0}s) — inspect DC-IN MOSFET, charging IC, USB-C PD controller, or battery BMS.",
                end_pct, eff_avg_w, gain_pct, duration_secs
            ),
        )
    } else {
        (
            TestStatus::Warn,
            "SLOW_CHARGE".to_string(),
            format!(
                "AC connected at {:.0}% with minimal net charge ({:+.1}W avg) — verify charger output and OEM battery charge thresholds.",
                end_pct, eff_avg_w
            ),
        )
    };

    BatteryChargeResult {
        status,
        verdict: verdict.clone(),
        duration_secs: round1(duration_secs),
        ac_plugged: true,
        start_charge_pct: start_pct,
        end_charge_pct: end_pct,
        charge_gain_pct: gain_pct,
        avg_charge_watts: avg_w,
        peak_charge_watts: peak_w,
        start_voltage_mv: first.voltage_mv,
        end_voltage_mv: last.voltage_mv,
        summary: format!("{}: {}", verdict, plain_summary),
        plain_summary,
    }
}

/// Bounded 12-second Active AC Charging IC Verification Test (v2.10.0).
pub fn run_battery_charge_test(
    duration_secs: Option<u64>,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<BatteryChargeResult, String> {
    let dur = duration_secs.unwrap_or(12).clamp(6, 30);
    let Some(init) = sample_battery_live() else {
        return Ok(classify_battery_charge_test(&[], 0.0, false));
    };

    if !init.ac_plugged {
        let _ = app.emit(
            "battery:charge",
            BatteryChargeProgress {
                running: false,
                elapsed_secs: 0.0,
                duration_secs: dur,
                charge_percent: init.charge_percent,
                ac_plugged: false,
                is_charging: init.is_charging,
                voltage_mv: init.voltage_mv,
                watts: init.watts,
                note: "AC adapter unplugged — connect charger to verify charging IC.".to_string(),
            },
        );
        return Ok(classify_battery_charge_test(&[init], 0.0, false));
    }

    let started = Instant::now();
    let mut samples = vec![init.clone()];

    while started.elapsed().as_secs() < dur {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Some(s) = sample_battery_live() {
            let note = if !s.ac_plugged {
                "AC adapter disconnected mid-check!".to_string()
            } else if let Some(w) = s.watts {
                if w >= 2.0 {
                    format!("Active AC charging detected ({:+.1}W).", w)
                } else if s.charge_percent >= 77.0 && s.charge_percent <= 84.0 && w.abs() < 1.5 {
                    "Holding ~80% on AC — checking for OEM Conservation Mode.".to_string()
                } else if w <= 0.0 {
                    format!("AC plugged in at {:.0}% with {:+.1}W — monitoring charging IC response...", s.charge_percent, w)
                } else {
                    format!("Trickle charge ({:+.1}W) — monitoring ramp-up...", w)
                }
            } else {
                format!("Sampling AC charging state ({:.1}%)...", s.charge_percent)
            };
            let _ = app.emit(
                "battery:charge",
                BatteryChargeProgress {
                    running: true,
                    elapsed_secs: round1(started.elapsed().as_secs_f64()),
                    duration_secs: dur,
                    charge_percent: s.charge_percent,
                    ac_plugged: s.ac_plugged,
                    is_charging: s.is_charging,
                    voltage_mv: s.voltage_mv,
                    watts: s.watts,
                    note,
                },
            );
            samples.push(s);
        }
        for _ in 0..5 {
            if cancel.load(Ordering::Relaxed) || started.elapsed().as_secs() >= dur {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    let elapsed = started.elapsed().as_secs_f64();
    let cancelled = cancel.load(Ordering::Relaxed);
    let result = classify_battery_charge_test(&samples, elapsed, cancelled);
    let last = samples.last();
    let _ = app.emit(
        "battery:charge",
        BatteryChargeProgress {
            running: false,
            elapsed_secs: round1(elapsed),
            duration_secs: dur,
            charge_percent: last.map(|s| s.charge_percent).unwrap_or(0.0),
            ac_plugged: last.map(|s| s.ac_plugged).unwrap_or(false),
            is_charging: last.map(|s| s.is_charging).unwrap_or(false),
            voltage_mv: last.and_then(|s| s.voltage_mv),
            watts: last.and_then(|s| s.watts),
            note: result.plain_summary.clone(),
        },
    );
    Ok(result)
}

pub fn sample_battery_live() -> Option<BatteryLiveSample> {
    #[cfg(target_os = "windows")]
    {
        windows_fast::sample_windows_battery_fast()
    }
    #[cfg(target_os = "macos")]
    {
        sample_macos_battery_fast()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let report = get_battery_health();
        if !report.present {
            return None;
        }
        let watts = report
            .rate_mw
            .map(|mw| ((mw as f64) / 1000.0 * 100.0).round() / 100.0);
        Some(BatteryLiveSample {
            timestamp_ms: Utc::now().timestamp_millis(),
            charge_percent: report.current_charge_percent.unwrap_or(0.0),
            ac_plugged: report.ac_plugged,
            is_charging: report.is_charging,
            voltage_mv: report.voltage_mv,
            rate_mw: report.rate_mw,
            watts,
        })
    }
}

pub fn spawn_battery_monitor(app: AppHandle, stop_flag: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            if let Some(sample) = sample_battery_live() {
                let _ = app.emit("battery:sample", &sample);
            }
            // Sleep in 200ms increments so stopping feels instantaneous
            for _ in 0..8 {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
}

/// 15-Second Battery Voltage-Sag Load Pulse:
/// Applies a controlled multi-core SIMD CPU load while sampling live battery voltage (mV),
/// discharge wattage (W), and State-of-Charge (%) to catch worn cells that collapse under load.
pub fn run_battery_sag_pulse(
    app: &AppHandle,
    duration_secs: u64,
    cancel: Arc<AtomicBool>,
) -> Result<BatterySagResult, String> {
    let dur = duration_secs.clamp(10, 45);
    let init = sample_battery_live()
        .ok_or_else(|| "No internal battery detected for voltage-sag pulse test.".to_string())?;

    let start_pct = init.charge_percent;
    let start_mv = init.voltage_mv;
    let was_on_battery = !init.ac_plugged;

    // Spawn controlled multi-core SIMD load threads
    let worker_stop = Arc::new(AtomicBool::new(false));
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(2))
        .unwrap_or(2);
    let mut handles = Vec::with_capacity(n_threads);
    for idx in 0..n_threads {
        let st = worker_stop.clone();
        let cn = cancel.clone();
        handles.push(std::thread::spawn(move || {
            let mut k = 0u32;
            while !st.load(Ordering::Relaxed) && !cn.load(Ordering::Relaxed) {
                let _ = simd_kernels::simd_ai_gemm_step(96, (idx as f32) + (k as f32) * 0.01);
                k = k.wrapping_add(1);
            }
        }));
    }

    let started = Instant::now();
    let mut min_mv = start_mv;
    let mut end_pct = start_pct;
    let mut peak_discharge_w: Option<f64> = None;

    while started.elapsed().as_secs() < dur {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Some(s) = sample_battery_live() {
            end_pct = s.charge_percent;
            if let Some(v) = s.voltage_mv {
                min_mv = Some(min_mv.map_or(v, |m| m.min(v)));
            }
            if let Some(w) = s.watts {
                let abs_w = w.abs();
                peak_discharge_w = Some(peak_discharge_w.map_or(abs_w, |p| p.max(abs_w)));
            }
            let v_drop = match (start_mv, s.voltage_mv) {
                (Some(a), Some(b)) => (a as i64) - (b as i64),
                _ => 0,
            };
            let _ = app.emit(
                "battery:sag",
                BatterySagProgress {
                    running: true,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    duration_secs: dur,
                    charge_percent: s.charge_percent,
                    voltage_mv: s.voltage_mv,
                    watts: s.watts,
                    ac_plugged: s.ac_plugged,
                    voltage_drop_mv: v_drop,
                    charge_drop_pct: ((start_pct - s.charge_percent) * 10.0).round() / 10.0,
                },
            );
        }
        std::thread::sleep(Duration::from_millis(900));
    }

    worker_stop.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }

    let charge_drop_pct = (((start_pct - end_pct).max(0.0)) * 10.0).round() / 10.0;
    let max_voltage_sag_mv = match (start_mv, min_mv) {
        (Some(a), Some(b)) => ((a as i64) - (b as i64)).max(0),
        _ => 0,
    };

    let status = if charge_drop_pct >= 8.0 || max_voltage_sag_mv >= 1200 {
        TestStatus::Fail
    } else if !was_on_battery || charge_drop_pct >= 4.0 || max_voltage_sag_mv >= 750 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if !was_on_battery {
        format!(
            "Pulse ran while AC plugged in (unplug AC for true cell sag test). Voltage sag: {} mV, Charge delta: -{:.1}%.",
            max_voltage_sag_mv, charge_drop_pct
        )
    } else if status == TestStatus::Fail {
        format!(
            "FAIL: Severe battery cell collapse under {}s load! Charge dropped {:.1}%, Voltage sagged {} mV — replace battery.",
            dur, charge_drop_pct, max_voltage_sag_mv
        )
    } else if status == TestStatus::Warn {
        format!(
            "WARN: Elevated internal cell resistance under {}s load (Charge -{:.1}%, Voltage sag {} mV).",
            dur, charge_drop_pct, max_voltage_sag_mv
        )
    } else {
        format!(
            "PASS: Stable cells under {}s CPU load pulse — Charge -{:.1}%, Voltage sag {} mV{}.",
            dur,
            charge_drop_pct,
            max_voltage_sag_mv,
            peak_discharge_w.map(|w| format!(", Peak {:.1}W", w)).unwrap_or_default()
        )
    };

    Ok(BatterySagResult {
        status,
        duration_secs: dur,
        was_on_battery,
        start_charge_pct: start_pct,
        end_charge_pct: end_pct,
        charge_drop_pct,
        start_voltage_mv: start_mv,
        min_voltage_mv: min_mv,
        max_voltage_sag_mv,
        peak_discharge_w,
        summary,
    })
}

/// Bounded Two-Phase Battery Discharge Normality Test (R3):
/// Phase A: Idle Baseline (10-15s) -> Phase B: Controlled Multi-Core SIMD Load (up to 90s total).
/// Polls live in-process battery telemetry at ~1Hz with 200ms cancel responsiveness and enforces
/// hardware-safe preconditions (not applicable if no battery, warn if AC connected, abort <= 15% SoC).
pub fn run_battery_discharge_test(
    duration_secs: Option<u32>,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<BatteryDischargeResult, String> {
    let total_secs = clamp_discharge_duration(duration_secs);
    let idle_secs = (total_secs / 4).clamp(10, 15).min(total_secs / 2);
    let load_secs = total_secs.saturating_sub(idle_secs);

    let health = get_battery_health();
    let init = sample_battery_live();

    let emit_progress = |running: bool,
                         phase: &str,
                         elapsed: f64,
                         sample: Option<&BatteryLiveSample>,
                         start_mv: Option<u64>,
                         start_pct: f64,
                         note: &str| {
        let s_pct = sample.map(|s| s.charge_percent).unwrap_or(start_pct);
        let v_sag = match (start_mv, sample.and_then(|s| s.voltage_mv)) {
            (Some(a), Some(b)) => (a as i64) - (b as i64),
            _ => 0,
        };
        let _ = app.emit(
            "battery:discharge",
            BatteryDischargeProgress {
                running,
                phase: phase.to_string(),
                elapsed_secs: (elapsed * 10.0).round() / 10.0,
                duration_secs: total_secs,
                charge_percent: s_pct,
                voltage_mv: sample.and_then(|s| s.voltage_mv),
                watts: sample.and_then(|s| s.watts),
                ac_plugged: sample.map(|s| s.ac_plugged).unwrap_or(false),
                voltage_sag_mv: v_sag,
                charge_drop_pct: ((start_pct - s_pct).max(0.0) * 10.0).round() / 10.0,
                note: note.to_string(),
            },
        );
    };

    if !health.present || init.is_none() {
        let msg = "No internal battery detected (desktop PC or battery disconnected).";
        emit_progress(false, "Precondition", 0.0, None, None, 0.0, msg);
        return Ok(classify_battery_discharge(
            &[],
            0,
            &health,
            0.0,
            Some(("NOT_APPLICABLE", msg)),
            false,
        ));
    }

    let init_sample = init.unwrap();
    let start_pct = init_sample.charge_percent;
    let start_mv = init_sample.voltage_mv;

    if init_sample.ac_plugged {
        let msg = "AC power adapter is plugged in. Unplug AC charger to run the battery discharge normality test.";
        emit_progress(false, "Precondition", 0.0, Some(&init_sample), start_mv, start_pct, msg);
        return Ok(classify_battery_discharge(
            &[init_sample],
            1,
            &health,
            0.0,
            Some(("AC_CONNECTED", msg)),
            false,
        ));
    }

    if start_pct <= BATTERY_LOW_SOC_ABORT_PCT {
        let msg = "Battery charge is at or below 15%. Charge battery to at least 20% before running discharge diagnostics.";
        emit_progress(false, "Precondition", 0.0, Some(&init_sample), start_mv, start_pct, msg);
        return Ok(classify_battery_discharge(
            &[init_sample],
            1,
            &health,
            0.0,
            Some(("ABORTED_LOW_BATTERY", msg)),
            false,
        ));
    }

    let started = Instant::now();
    let mut samples = Vec::with_capacity((total_secs as usize) + 2);
    samples.push(init_sample.clone());
    emit_progress(
        true,
        "Idle Baseline",
        0.0,
        Some(&init_sample),
        start_mv,
        start_pct,
        "Measuring idle power baseline...",
    );

    let mut abort_reason: Option<(&'static str, &'static str)> = None;
    let mut was_cancelled = false;

    let sleep_poll_cancel = |cancel: &AtomicBool| -> bool {
        for _ in 0..5 {
            if cancel.load(Ordering::Relaxed) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        cancel.load(Ordering::Relaxed)
    };

    // Phase A: Idle Baseline
    for _ in 0..idle_secs {
        if sleep_poll_cancel(cancel) {
            was_cancelled = true;
            break;
        }
        if let Some(s) = sample_battery_live() {
            if s.ac_plugged {
                samples.push(s);
                abort_reason = Some((
                    "AC_CONNECTED",
                    "AC charger was plugged in during test. Unplug AC adapter and re-run for accurate battery assessment.",
                ));
                break;
            }
            if s.charge_percent <= BATTERY_LOW_SOC_ABORT_PCT {
                samples.push(s);
                abort_reason = Some((
                    "ABORTED_LOW_BATTERY",
                    "Battery dropped to <=15% during test; stopped automatically to protect cells from deep discharge.",
                ));
                break;
            }
            emit_progress(
                true,
                "Idle Baseline",
                started.elapsed().as_secs_f64(),
                Some(&s),
                start_mv,
                start_pct,
                "Measuring idle power baseline...",
            );
            samples.push(s);
        }
    }

    let idle_sample_count = samples.len();

    // Phase B: Controlled SIMD Load
    if abort_reason.is_none() && !was_cancelled && load_secs > 0 {
        let mut pool = WorkerPoolGuard::spawn_simd_load(cancel);
        for _ in 0..load_secs {
            if sleep_poll_cancel(cancel) {
                was_cancelled = true;
                break;
            }
            if let Some(s) = sample_battery_live() {
                if s.ac_plugged {
                    samples.push(s);
                    abort_reason = Some((
                        "AC_CONNECTED",
                        "AC charger was plugged in during load phase. Unplug AC adapter and re-run.",
                    ));
                    break;
                }
                if s.charge_percent <= BATTERY_LOW_SOC_ABORT_PCT {
                    samples.push(s);
                    abort_reason = Some((
                        "ABORTED_LOW_BATTERY",
                        "Battery dropped to <=15% under load; stopped automatically to protect battery health.",
                    ));
                    break;
                }
                emit_progress(
                    true,
                    "Controlled Load",
                    started.elapsed().as_secs_f64(),
                    Some(&s),
                    start_mv,
                    start_pct,
                    "Applying controlled SIMD CPU load & monitoring cell stability...",
                );
                samples.push(s);
            }
        }
        pool.shutdown();
    }

    let elapsed_secs = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let result = classify_battery_discharge(
        &samples,
        idle_sample_count,
        &health,
        elapsed_secs,
        abort_reason,
        was_cancelled,
    );

    emit_progress(
        false,
        "Complete",
        elapsed_secs,
        samples.last(),
        start_mv,
        start_pct,
        &result.plain_summary,
    );

    Ok(result)
}

pub fn clamp_discharge_duration(duration_secs: Option<u32>) -> u64 {
    (duration_secs.unwrap_or(55) as u64).clamp(20, BATTERY_DISCHARGE_MAX_SECS)
}

pub fn classify_battery_discharge(
    samples: &[BatteryLiveSample],
    idle_sample_count: usize,
    health: &BatteryHealthReport,
    duration_secs: f64,
    abort_override: Option<(&str, &str)>,
    cancelled: bool,
) -> BatteryDischargeResult {
    let wear_pct = round1(health.wear_percent.unwrap_or(0.0).max(0.0));
    let cycle_count = health.cycle_count.unwrap_or(0);
    let finite_soc_samples: Vec<&BatteryLiveSample> = samples
        .iter()
        .filter(|s| s.charge_percent.is_finite())
        .collect();
    let soc_start_pct = finite_soc_samples
        .first()
        .map(|s| s.charge_percent)
        .or_else(|| health.current_charge_percent.filter(|v| v.is_finite()))
        .unwrap_or(0.0);
    let soc_end_pct = finite_soc_samples
        .last()
        .map(|s| s.charge_percent)
        .unwrap_or(soc_start_pct);

    if let Some((verdict, msg)) = abort_override {
        let status = if verdict == "NOT_APPLICABLE" {
            TestStatus::NotApplicable
        } else {
            TestStatus::Warn
        };
        return BatteryDischargeResult {
            status,
            verdict: verdict.to_string(),
            plain_summary: msg.to_string(),
            reasons: vec![msg.to_string()],
            idle_avg_watts: 0.0,
            load_avg_watts: 0.0,
            power_cv_pct: 0.0,
            voltage_sag_mv: 0.0,
            soc_start_pct: round1(soc_start_pct),
            soc_end_pct: round1(soc_end_pct),
            max_step_drop_pct: 0.0,
            wear_pct,
            cycle_count,
            bms_drift_ratio: 0.0,
            duration_secs: round1(duration_secs),
            samples: samples.to_vec(),
        };
    }

    let split = idle_sample_count.min(samples.len());
    let idle_slice = &samples[..split];
    let load_slice = &samples[split..];
    let finite_load_count = load_slice
        .iter()
        .filter(|s| s.charge_percent.is_finite())
        .count();

    let idle_watts: Vec<f64> = idle_slice
        .iter()
        .filter_map(|s| s.watts.filter(|w| w.is_finite()).map(|w| w.abs()))
        .collect();
    let load_watts: Vec<f64> = load_slice
        .iter()
        .filter_map(|s| s.watts.filter(|w| w.is_finite()).map(|w| w.abs()))
        .collect();

    let idle_avg_watts = if idle_watts.is_empty() {
        0.0
    } else {
        round2(idle_watts.iter().sum::<f64>() / idle_watts.len() as f64)
    };
    let load_avg_watts = if load_watts.is_empty() {
        0.0
    } else {
        round2(load_watts.iter().sum::<f64>() / load_watts.len() as f64)
    };

    let has_watts = !idle_watts.is_empty() || !load_watts.is_empty();

    // Steady-state coefficient of variation over load wattage (skip first 2 ramp-up samples if >= 5 exist)
    let steady_load_watts: &[f64] = if load_watts.len() >= 5 {
        &load_watts[2..]
    } else {
        &load_watts[..]
    };
    let power_cv_pct = if steady_load_watts.len() >= 3 {
        let mean = steady_load_watts.iter().sum::<f64>() / steady_load_watts.len() as f64;
        if mean > 0.5 {
            let var = steady_load_watts
                .iter()
                .map(|w| {
                    let d = w - mean;
                    d * d
                })
                .sum::<f64>()
                / steady_load_watts.len() as f64;
            round2((var.sqrt() / mean) * 100.0)
        } else {
            0.0
        }
    } else {
        0.0
    };

    // Voltage sag: idle baseline mV - minimum load mV
    let idle_voltages: Vec<u64> = idle_slice.iter().filter_map(|s| s.voltage_mv).collect();
    let load_voltages: Vec<u64> = load_slice.iter().filter_map(|s| s.voltage_mv).collect();
    let idle_baseline_mv: Option<f64> = if !idle_voltages.is_empty() {
        Some(idle_voltages.iter().map(|&v| v as f64).sum::<f64>() / idle_voltages.len() as f64)
    } else {
        samples.iter().filter_map(|s| s.voltage_mv).next().map(|v| v as f64)
    };
    let min_load_mv: Option<f64> = load_voltages
        .iter()
        .copied()
        .min()
        .or_else(|| samples.iter().filter_map(|s| s.voltage_mv).min())
        .map(|v| v as f64);

    let has_voltage = idle_baseline_mv.is_some()
        && min_load_mv.is_some()
        && samples.iter().filter_map(|s| s.voltage_mv).count() >= 2;
    let voltage_sag_mv = match (idle_baseline_mv, min_load_mv) {
        (Some(a), Some(b)) if has_voltage => round1((a - b).max(0.0)),
        _ => 0.0,
    };

    // Max SoC step drop within any <= 5.5s window (including dt == 0 duplicate timestamps)
    let mut max_step_drop_pct = 0.0f64;
    for i in 0..finite_soc_samples.len() {
        for j in (i + 1)..finite_soc_samples.len() {
            let dt = finite_soc_samples[j].timestamp_ms - finite_soc_samples[i].timestamp_ms;
            if (0..=5500).contains(&dt) {
                let drop =
                    (finite_soc_samples[i].charge_percent - finite_soc_samples[j].charge_percent)
                        .max(0.0);
                if drop > max_step_drop_pct {
                    max_step_drop_pct = drop;
                }
            } else if dt > 5500 {
                break;
            }
        }
        if i + 1 < finite_soc_samples.len() {
            let drop = (finite_soc_samples[i].charge_percent
                - finite_soc_samples[i + 1].charge_percent)
                .max(0.0);
            if drop > max_step_drop_pct {
                max_step_drop_pct = drop;
            }
        }
    }
    max_step_drop_pct = round2(max_step_drop_pct);

    let reported_drop = (soc_start_pct - soc_end_pct).max(0.0);

    // BMS drift ratio: reported SoC drop vs energy-integrated expected drop
    let mut integrated_mwh = 0.0f64;
    for pair in samples.windows(2) {
        let dt_ms = pair[1].timestamp_ms - pair[0].timestamp_ms;
        if dt_ms <= 0 || dt_ms > 15_000 {
            continue;
        }
        let w0 = pair[0].watts.filter(|w| w.is_finite()).map(|w| w.abs());
        let w1 = pair[1].watts.filter(|w| w.is_finite()).map(|w| w.abs());
        let avg_w = match (w0, w1) {
            (Some(a), Some(b)) => Some((a + b) * 0.5),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        if let Some(w) = avg_w {
            let dt_hours = (dt_ms as f64) / 3_600_000.0;
            integrated_mwh += (w * 1000.0) * dt_hours;
        }
    }
    let cap_mwh = health
        .full_charge_capacity_mwh
        .or(health.design_capacity_mwh)
        .unwrap_or(0);
    let bms_drift_ratio = if cap_mwh > 0 && integrated_mwh > 0.0 {
        let expected_drop_pct = (integrated_mwh / cap_mwh as f64) * 100.0;
        if expected_drop_pct >= 0.2 {
            round2(reported_drop / expected_drop_pct)
        } else {
            0.0
        }
    } else {
        0.0
    };

    let mut fail_reasons = Vec::new();
    let mut warn_reasons = Vec::new();

    if max_step_drop_pct >= 3.0 {
        fail_reasons.push(format!(
            "Sudden State-of-Charge cliff detected (-{:.1}% within 5s) — worn or imbalanced cell.",
            max_step_drop_pct
        ));
    }
    if reported_drop >= 8.0 {
        fail_reasons.push(format!(
            "Excessive charge drop (-{:.1}%) during bounded {:.0}s discharge test.",
            reported_drop, duration_secs
        ));
    }
    if has_voltage && voltage_sag_mv >= 1200.0 {
        fail_reasons.push(format!(
            "Severe voltage sag ({:.0} mV) under controlled load — high internal cell resistance.",
            voltage_sag_mv
        ));
    }
    if wear_pct > 35.0 {
        fail_reasons.push(format!(
            "High battery capacity wear ({:.1}% wear) — battery replacement recommended.",
            wear_pct
        ));
    }
    if steady_load_watts.len() >= 3 && power_cv_pct > 25.0 {
        fail_reasons.push(format!(
            "Unstable discharge wattage (CV {:.1}% > 25%) — erratic power delivery or throttling.",
            power_cv_pct
        ));
    }

    if wear_pct >= 20.0 && wear_pct <= 35.0 {
        warn_reasons.push(format!(
            "Moderate battery wear ({:.1}% lost capacity) — shortened runtime expected.",
            wear_pct
        ));
    }
    if !idle_watts.is_empty() && idle_avg_watts > 18.0 {
        warn_reasons.push(format!(
            "Elevated idle power draw ({:.1}W > 18W) — background load or dGPU wake drain.",
            idle_avg_watts
        ));
    }
    if has_voltage && voltage_sag_mv >= 750.0 && voltage_sag_mv < 1200.0 {
        warn_reasons.push(format!(
            "Elevated load voltage sag ({:.0} mV) — aging cells showing increased resistance.",
            voltage_sag_mv
        ));
    }
    if steady_load_watts.len() >= 3 && power_cv_pct > 15.0 && power_cv_pct <= 25.0 {
        warn_reasons.push(format!(
            "Moderate power-draw variance under steady load (CV {:.1}%).",
            power_cv_pct
        ));
    }
    if has_watts && reported_drop >= 2.0 && bms_drift_ratio > 2.0 {
        warn_reasons.push(format!(
            "BMS fuel-gauge drift ({:.2}x expected drop based on {:.1}W power draw) — battery calibration or cell mismatch.",
            bms_drift_ratio, load_avg_watts.max(idle_avg_watts)
        ));
    }

    let mut reasons = Vec::new();
    reasons.extend(fail_reasons.iter().cloned());
    reasons.extend(warn_reasons.iter().cloned());

    let has_abnormal_fault = !fail_reasons.is_empty() || !warn_reasons.is_empty();
    if cancelled && !has_abnormal_fault {
        let msg = format!(
            "Battery discharge test cancelled after {:.0}s before completing load verification ({} finite sample(s), {} load sample(s)).",
            duration_secs,
            finite_soc_samples.len(),
            finite_load_count
        );
        return BatteryDischargeResult {
            status: TestStatus::Warn,
            verdict: "CANCELLED".to_string(),
            plain_summary: format!("CANCELLED: {}", msg),
            reasons: vec![msg],
            idle_avg_watts,
            load_avg_watts,
            power_cv_pct,
            voltage_sag_mv,
            soc_start_pct: round1(soc_start_pct),
            soc_end_pct: round1(soc_end_pct),
            max_step_drop_pct,
            wear_pct,
            cycle_count,
            bms_drift_ratio,
            duration_secs: round1(duration_secs),
            samples: samples.to_vec(),
        };
    }

    if finite_soc_samples.len() < 2 {
        let msg = "Insufficient valid battery State-of-Charge telemetry (< 2 finite readings) to evaluate discharge normality.".to_string();
        reasons.insert(0, msg.clone());
        return BatteryDischargeResult {
            status: TestStatus::Warn,
            verdict: "INSUFFICIENT_SAMPLES".to_string(),
            plain_summary: format!("INSUFFICIENT_SAMPLES: {}", msg),
            reasons,
            idle_avg_watts,
            load_avg_watts,
            power_cv_pct,
            voltage_sag_mv,
            soc_start_pct: round1(soc_start_pct),
            soc_end_pct: round1(soc_end_pct),
            max_step_drop_pct,
            wear_pct,
            cycle_count,
            bms_drift_ratio,
            duration_secs: round1(duration_secs),
            samples: samples.to_vec(),
        };
    }

    let (status, verdict) = if !fail_reasons.is_empty() {
        (TestStatus::Fail, "ABNORMAL".to_string())
    } else if !warn_reasons.is_empty() {
        (TestStatus::Warn, "ABNORMAL".to_string())
    } else {
        (TestStatus::Pass, "NORMAL".to_string())
    };

    let sensor_caveat = match (has_voltage, has_watts) {
        (true, true) => String::new(),
        (false, true) => " (Note: live voltage mV sensor unavailable from firmware; assessed via wattage & SoC stability.)".to_string(),
        (true, false) => " (Note: live wattage sensor unavailable from firmware; assessed via voltage sag & SoC stability.)".to_string(),
        (false, false) => " (Note: firmware omitted live voltage/wattage telemetry; assessed via SoC curve & wear metrics.)".to_string(),
    };

    let plain_summary = if verdict == "NORMAL" {
        format!(
            "NORMAL: Smooth battery discharge over {:.0}s (SoC {:.1}% -> {:.1}%, idle {:.1}W, load {:.1}W, sag {:.0} mV, wear {:.1}%). Safe for unplugged use.{}",
            duration_secs, soc_start_pct, soc_end_pct, idle_avg_watts, load_avg_watts, voltage_sag_mv, wear_pct, sensor_caveat
        )
    } else {
        format!(
            "ABNORMAL: {} (SoC {:.1}% -> {:.1}%, sag {:.0} mV, CV {:.1}%, wear {:.1}%).{}",
            reasons.first().map(|s| s.as_str()).unwrap_or("Irregular discharge detected"),
            soc_start_pct,
            soc_end_pct,
            voltage_sag_mv,
            power_cv_pct,
            wear_pct,
            sensor_caveat
        )
    };

    BatteryDischargeResult {
        status,
        verdict,
        plain_summary,
        reasons,
        idle_avg_watts,
        load_avg_watts,
        power_cv_pct,
        voltage_sag_mv,
        soc_start_pct: round1(soc_start_pct),
        soc_end_pct: round1(soc_end_pct),
        max_step_drop_pct,
        wear_pct,
        cycle_count,
        bms_drift_ratio,
        duration_secs: round1(duration_secs),
        samples: samples.to_vec(),
    }
}

fn round1(v: f64) -> f64 {
    if v.is_finite() {
        (v * 10.0).round() / 10.0
    } else {
        0.0
    }
}

fn round2(v: f64) -> f64 {
    if v.is_finite() {
        (v * 100.0).round() / 100.0
    } else {
        0.0
    }
}

#[cfg(target_os = "windows")]
mod windows_fast {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[repr(C)]
    struct SystemBatteryState {
        ac_on_line: u8,
        battery_present: u8,
        charging: u8,
        discharging: u8,
        spare1: [u8; 3],
        tag: u8,
        max_capacity: u32,
        remaining_capacity: u32,
        rate: i32,
        estimated_time: u32,
        default_alert1: u32,
        default_alert2: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    #[repr(C)]
    struct SpDeviceInterfaceData {
        cb_size: u32,
        interface_class_guid: Guid,
        flags: u32,
        reserved: usize,
    }

    #[repr(C)]
    struct BatteryWaitStatus {
        battery_tag: u32,
        timeout: u32,
        power_state: u32,
        low_capacity: u32,
        high_capacity: u32,
    }

    #[repr(C)]
    struct BatteryStatus {
        power_state: u32,
        capacity: u32,
        voltage: u32,
        rate: i32,
    }

    type GetSystemPowerStatusFn = unsafe extern "system" fn(*mut SystemPowerStatus) -> i32;
    type CallNtPowerInformationFn = unsafe extern "system" fn(
        information_level: u32,
        input_buffer: *const c_void,
        input_buffer_length: u32,
        output_buffer: *mut c_void,
        output_buffer_length: u32,
    ) -> i32;
    type CreateFileWFn = unsafe extern "system" fn(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *const c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: *mut c_void,
    ) -> *mut c_void;
    type DeviceIoControlFn = unsafe extern "system" fn(
        h_device: *mut c_void,
        dw_io_control_code: u32,
        lp_in_buffer: *const c_void,
        n_in_buffer_size: u32,
        lp_out_buffer: *mut c_void,
        n_out_buffer_size: u32,
        lp_bytes_returned: *mut u32,
        lp_overlapped: *mut c_void,
    ) -> i32;
    type CloseHandleFn = unsafe extern "system" fn(*mut c_void) -> i32;
    type SetupDiGetClassDevsWFn = unsafe extern "system" fn(
        class_guid: *const Guid,
        enumerator: *const u16,
        hwnd_parent: *mut c_void,
        flags: u32,
    ) -> *mut c_void;
    type SetupDiEnumDeviceInterfacesFn = unsafe extern "system" fn(
        device_info_set: *mut c_void,
        device_info_data: *const c_void,
        interface_class_guid: *const Guid,
        member_index: u32,
        device_interface_data: *mut SpDeviceInterfaceData,
    ) -> i32;
    type SetupDiGetDeviceInterfaceDetailWFn = unsafe extern "system" fn(
        device_info_set: *mut c_void,
        device_interface_data: *const SpDeviceInterfaceData,
        device_interface_detail_data: *mut c_void,
        device_interface_detail_data_size: u32,
        required_size: *mut u32,
        device_info_data: *mut c_void,
    ) -> i32;
    type SetupDiDestroyDeviceInfoListFn = unsafe extern "system" fn(*mut c_void) -> i32;

    struct WinBatteryApi {
        get_system_power_status: Option<GetSystemPowerStatusFn>,
        call_nt_power_information: Option<CallNtPowerInformationFn>,
        create_file_w: Option<CreateFileWFn>,
        device_io_control: Option<DeviceIoControlFn>,
        close_handle: Option<CloseHandleFn>,
        setup_di_get_class_devs_w: Option<SetupDiGetClassDevsWFn>,
        setup_di_enum_device_interfaces: Option<SetupDiEnumDeviceInterfacesFn>,
        setup_di_get_device_interface_detail_w: Option<SetupDiGetDeviceInterfaceDetailWFn>,
        setup_di_destroy_device_info_list: Option<SetupDiDestroyDeviceInfoListFn>,
    }

    unsafe fn load_proc<T>(
        module: windows_sys::Win32::Foundation::HMODULE,
        name: &'static [u8],
    ) -> Option<T> {
        let addr = GetProcAddress(module, name.as_ptr())?;
        Some(std::mem::transmute_copy(&addr))
    }

    impl WinBatteryApi {
        fn load() -> Self {
            unsafe {
                let k32 = LoadLibraryA(b"kernel32.dll\0".as_ptr());
                let powr = LoadLibraryA(b"powrprof.dll\0".as_ptr());
                let setup = LoadLibraryA(b"setupapi.dll\0".as_ptr());

                let get_system_power_status = if !k32.is_null() {
                    load_proc(k32, b"GetSystemPowerStatus\0")
                } else {
                    None
                };
                let create_file_w = if !k32.is_null() {
                    load_proc(k32, b"CreateFileW\0")
                } else {
                    None
                };
                let device_io_control = if !k32.is_null() {
                    load_proc(k32, b"DeviceIoControl\0")
                } else {
                    None
                };
                let close_handle = if !k32.is_null() {
                    load_proc(k32, b"CloseHandle\0")
                } else {
                    None
                };
                let call_nt_power_information = if !powr.is_null() {
                    load_proc(powr, b"CallNtPowerInformation\0")
                } else {
                    None
                };
                let setup_di_get_class_devs_w = if !setup.is_null() {
                    load_proc(setup, b"SetupDiGetClassDevsW\0")
                } else {
                    None
                };
                let setup_di_enum_device_interfaces = if !setup.is_null() {
                    load_proc(setup, b"SetupDiEnumDeviceInterfaces\0")
                } else {
                    None
                };
                let setup_di_get_device_interface_detail_w = if !setup.is_null() {
                    load_proc(setup, b"SetupDiGetDeviceInterfaceDetailW\0")
                } else {
                    None
                };
                let setup_di_destroy_device_info_list = if !setup.is_null() {
                    load_proc(setup, b"SetupDiDestroyDeviceInfoList\0")
                } else {
                    None
                };

                Self {
                    get_system_power_status,
                    call_nt_power_information,
                    create_file_w,
                    device_io_control,
                    close_handle,
                    setup_di_get_class_devs_w,
                    setup_di_enum_device_interfaces,
                    setup_di_get_device_interface_detail_w,
                    setup_di_destroy_device_info_list,
                }
            }
        }
    }

    fn query_ioctl_voltage_and_rate(api: &WinBatteryApi) -> (Option<u64>, Option<i64>) {
        let (
            Some(get_devs),
            Some(enum_if),
            Some(get_detail),
            Some(destroy_list),
            Some(create_file),
            Some(ioctl),
            Some(close_h),
        ) = (
            api.setup_di_get_class_devs_w,
            api.setup_di_enum_device_interfaces,
            api.setup_di_get_device_interface_detail_w,
            api.setup_di_destroy_device_info_list,
            api.create_file_w,
            api.device_io_control,
            api.close_handle,
        )
        else {
            return (None, None);
        };

        const GUID_DEVCLASS_BATTERY: Guid = Guid {
            data1: 0x7263_1e54,
            data2: 0x78a4,
            data3: 0x11d0,
            data4: [0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a],
        };
        const DIGCF_PRESENT: u32 = 0x0000_0002;
        const DIGCF_DEVICEINTERFACE: u32 = 0x0000_0010;
        const GENERIC_READ: u32 = 0x8000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const FILE_SHARE_READ_WRITE: u32 = 0x0000_0003;
        const OPEN_EXISTING: u32 = 3;
        const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
        const IOCTL_BATTERY_QUERY_TAG: u32 = 0x0029_4040;
        const IOCTL_BATTERY_QUERY_STATUS: u32 = 0x0029_404C;
        let invalid_handle = (-1isize) as *mut c_void;

        let h_dev_info = unsafe {
            get_devs(
                &GUID_DEVCLASS_BATTERY,
                std::ptr::null(),
                std::ptr::null_mut(),
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            )
        };
        if h_dev_info.is_null() || h_dev_info == invalid_handle {
            return (None, None);
        }

        let mut voltage_mv: Option<u64> = None;
        let mut rate_mw: Option<i64> = None;

        for idx in 0..4u32 {
            let mut iface_data = SpDeviceInterfaceData {
                cb_size: size_of::<SpDeviceInterfaceData>() as u32,
                interface_class_guid: GUID_DEVCLASS_BATTERY,
                flags: 0,
                reserved: 0,
            };
            if unsafe {
                enum_if(
                    h_dev_info,
                    std::ptr::null(),
                    &GUID_DEVCLASS_BATTERY,
                    idx,
                    &mut iface_data,
                )
            } == 0
            {
                break;
            }

            let mut req_size: u32 = 0;
            unsafe {
                get_detail(
                    h_dev_info,
                    &iface_data,
                    std::ptr::null_mut(),
                    0,
                    &mut req_size,
                    std::ptr::null_mut(),
                );
            }
            if req_size < 8 || req_size > 4096 {
                continue;
            }

            let mut buf = vec![0u8; req_size as usize];
            let detail_cb: u32 = if cfg!(target_pointer_width = "64") {
                8
            } else {
                6
            };
            buf[..4].copy_from_slice(&detail_cb.to_le_bytes());
            if unsafe {
                get_detail(
                    h_dev_info,
                    &iface_data,
                    buf.as_mut_ptr().cast::<c_void>(),
                    req_size,
                    &mut req_size,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                continue;
            }

            let path_ptr = unsafe { buf.as_ptr().add(4).cast::<u16>() };
            let mut h_bat = unsafe {
                create_file(
                    path_ptr,
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if h_bat == invalid_handle {
                h_bat = unsafe {
                    create_file(
                        path_ptr,
                        GENERIC_READ,
                        FILE_SHARE_READ_WRITE,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL,
                        std::ptr::null_mut(),
                    )
                };
            }
            if h_bat.is_null() || h_bat == invalid_handle {
                continue;
            }

            let wait_ms: u32 = 0;
            let mut tag: u32 = 0;
            let mut bytes_ret: u32 = 0;
            let ok_tag = unsafe {
                ioctl(
                    h_bat,
                    IOCTL_BATTERY_QUERY_TAG,
                    (&wait_ms as *const u32).cast::<c_void>(),
                    size_of::<u32>() as u32,
                    (&mut tag as *mut u32).cast::<c_void>(),
                    size_of::<u32>() as u32,
                    &mut bytes_ret,
                    std::ptr::null_mut(),
                )
            };
            if ok_tag != 0 && tag != 0 {
                let bws = BatteryWaitStatus {
                    battery_tag: tag,
                    timeout: 0,
                    power_state: 0,
                    low_capacity: 0,
                    high_capacity: 0,
                };
                let mut bs = BatteryStatus {
                    power_state: 0,
                    capacity: 0,
                    voltage: 0,
                    rate: i32::MIN,
                };
                let ok_st = unsafe {
                    ioctl(
                        h_bat,
                        IOCTL_BATTERY_QUERY_STATUS,
                        (&bws as *const BatteryWaitStatus).cast::<c_void>(),
                        size_of::<BatteryWaitStatus>() as u32,
                        (&mut bs as *mut BatteryStatus).cast::<c_void>(),
                        size_of::<BatteryStatus>() as u32,
                        &mut bytes_ret,
                        std::ptr::null_mut(),
                    )
                };
                if ok_st != 0 {
                    if bs.voltage > 0 && bs.voltage != 0xFFFF_FFFF {
                        voltage_mv = Some(bs.voltage as u64);
                    }
                    if bs.rate != i32::MIN && bs.rate.saturating_abs() <= 300_000 {
                        rate_mw = Some(bs.rate as i64);
                    }
                }
            }
            unsafe {
                close_h(h_bat);
            }
            if voltage_mv.is_some() {
                break;
            }
        }

        unsafe {
            destroy_list(h_dev_info);
        }
        (voltage_mv, rate_mw)
    }

    pub(super) fn sample_windows_battery_fast() -> Option<BatteryLiveSample> {
        static API: OnceLock<WinBatteryApi> = OnceLock::new();
        let api = API.get_or_init(WinBatteryApi::load);

        let mut present: Option<bool> = None;
        let mut ac_plugged: Option<bool> = None;
        let mut is_charging = false;
        let mut charge_pct: Option<f64> = None;
        let mut rate_mw: Option<i64> = None;

        if let Some(f) = api.get_system_power_status {
            let mut sps = SystemPowerStatus {
                ac_line_status: 255,
                battery_flag: 255,
                battery_life_percent: 255,
                system_status_flag: 0,
                battery_life_time: 0,
                battery_full_life_time: 0,
            };
            if unsafe { f(&mut sps) } != 0 {
                ac_plugged = match sps.ac_line_status {
                    0 => Some(false),
                    1 => Some(true),
                    _ => None,
                };
                if sps.battery_flag != 255 && (sps.battery_flag & 128) != 0 {
                    present = Some(false);
                } else {
                    if sps.battery_flag != 255 && (sps.battery_flag & 8) != 0 {
                        is_charging = true;
                    }
                    if sps.battery_life_percent <= 100 {
                        present = Some(true);
                        charge_pct = Some(sps.battery_life_percent as f64);
                    }
                }
            }
        }

        if let Some(f) = api.call_nt_power_information {
            const SYSTEM_BATTERY_STATE: u32 = 5;
            let mut sbs = SystemBatteryState {
                ac_on_line: 0,
                battery_present: 0,
                charging: 0,
                discharging: 0,
                spare1: [0; 3],
                tag: 0,
                max_capacity: 0,
                remaining_capacity: 0,
                rate: i32::MIN,
                estimated_time: 0,
                default_alert1: 0,
                default_alert2: 0,
            };
            let st = unsafe {
                f(
                    SYSTEM_BATTERY_STATE,
                    std::ptr::null(),
                    0,
                    (&mut sbs as *mut SystemBatteryState).cast::<c_void>(),
                    size_of::<SystemBatteryState>() as u32,
                )
            };
            if st == 0 {
                let sbs_present = sbs.battery_present != 0;
                present = Some(sbs_present);
                if !sbs_present {
                    return None;
                }
                if ac_plugged.is_none() {
                    ac_plugged = Some(sbs.ac_on_line != 0);
                }
                if sbs.charging != 0 {
                    is_charging = true;
                }
                if sbs.max_capacity > 0 && sbs.remaining_capacity <= sbs.max_capacity {
                    let frac_pct = ((sbs.remaining_capacity as f64 / sbs.max_capacity as f64)
                        * 100.0)
                        .clamp(0.0, 100.0);
                    charge_pct = Some((frac_pct * 10.0).round() / 10.0);
                }
                if sbs.rate != i32::MIN && sbs.rate.saturating_abs() <= 300_000 {
                    rate_mw = Some(sbs.rate as i64);
                }
            }
        }

        if present != Some(true) {
            return None;
        }

        let (voltage_mv, ioctl_rate_mw) = query_ioctl_voltage_and_rate(api);
        if rate_mw.is_none() {
            rate_mw = ioctl_rate_mw;
        }
        let watts = rate_mw.map(|mw| ((mw as f64) / 1000.0 * 100.0).round() / 100.0);

        Some(BatteryLiveSample {
            timestamp_ms: Utc::now().timestamp_millis(),
            charge_percent: charge_pct.unwrap_or(0.0),
            ac_plugged: ac_plugged.unwrap_or(false),
            is_charging,
            voltage_mv,
            rate_mw,
            watts,
        })
    }
}

#[cfg(target_os = "windows")]
fn get_windows_battery_health() -> BatteryHealthReport {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$wb = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $wb) {
    @{ present = $false } | ConvertTo-Json -Compress
    exit 0
}
$static = Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1
$full = Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1
$cycle = Get-CimInstance -Namespace root\wmi -ClassName BatteryCycleCount -ErrorAction SilentlyContinue | Select-Object -First 1
$st = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1

$design = if ($static -and $static.DesignedCapacity -gt 0) { [uint64]$static.DesignedCapacity } elseif ($wb.DesignCapacity -gt 0) { [uint64]$wb.DesignCapacity } else { 0 }
$fullCap = if ($full -and $full.FullChargedCapacity -gt 0) { [uint64]$full.FullChargedCapacity } else { 0 }
$cycles = if ($cycle) { [uint32]$cycle.CycleCount } else { 0 }
$chgRate = if ($st -and $st.ChargeRate -gt 0) { [int64]$st.ChargeRate } elseif ($st -and $st.DischargeRate -gt 0) { -[int64]$st.DischargeRate } else { 0 }
$volt = if ($st -and $st.Voltage -gt 0) { [uint64]$st.Voltage } elseif ($wb.DesignVoltage -gt 0) { [uint64]$wb.DesignVoltage } else { 0 }
$ac = if ($st) { [bool]$st.PowerOnline } else { ($wb.BatteryStatus -in @(2,6,7,8,9)) }
$charging = if ($st) { [bool]$st.Charging } else { ($wb.BatteryStatus -in @(6,7,8,9)) }
$hasDgpu = [bool](Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX|Quadro|Radeon RX|Radeon Pro|Arc A\d' } | Select-Object -First 1)
$adapterW = $null
$adapterSrc = ''
try {
    $dellPsu = Get-CimInstance -Namespace root\dcim\sysman -ClassName DCIM_PowerSupply -ErrorAction Stop | Where-Object { $_.TotalOutputPower -gt 0 } | Select-Object -First 1
    if ($dellPsu) {
        $adapterW = [uint32]([math]::Round([double]$dellPsu.TotalOutputPower))
        $adapterSrc = 'Dell DCIM WMI'
    }
} catch {}
if ($null -eq $adapterW -and $ac -and $chgRate -gt 20000) {
    $est = [uint32]([math]::Ceiling(([double]$chgRate / 1000.0) + 15.0))
    $adapterW = $est
    $adapterSrc = 'Measured Charge Rate'
}

@{
    present = $true
    manufacturer = if ($static -and $static.ManufactureName) { [string]$static.ManufactureName } else { 'OEM' }
    chemistry = switch ($wb.Chemistry) { 1 {'Other'} 2 {'Unknown'} 3 {'Lead Acid'} 4 {'NiCd'} 5 {'NiMH'} 6 {'Li-Ion'} 7 {'Zinc Air'} 8 {'Li-Poly'} default {'Li-Ion'} }
    design = $design
    full = $fullCap
    cycles = $cycles
    chargePct = [double]$wb.EstimatedChargeRemaining
    ac = $ac
    charging = $charging
    voltage = $volt
    rateMw = $chgRate
    adapterWatts = $adapterW
    adapterSrc = $adapterSrc
    hasDgpu = $hasDgpu
} | ConvertTo-Json -Compress
"#;

    let mut report = BatteryHealthReport {
        present: false,
        status: TestStatus::NotApplicable,
        manufacturer: "Unknown".to_string(),
        chemistry: "Li-Ion".to_string(),
        design_capacity_mwh: None,
        full_charge_capacity_mwh: None,
        health_percent: None,
        wear_percent: None,
        cycle_count: None,
        current_charge_percent: None,
        is_charging: false,
        ac_plugged: true,
        voltage_mv: None,
        rate_mw: None,
        adapter_watts: None,
        notes: "No battery detected (desktop PC or battery disconnected).".to_string(),
        cycle_source: String::new(),
        capacity_history: Vec::new(),
        adapter_source: String::new(),
        adapter_warning: None,
    };

    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if !v["present"].as_bool().unwrap_or(false) {
                return report;
            }
            report.present = true;
            report.manufacturer = v["manufacturer"].as_str().unwrap_or("OEM").trim().to_string();
            report.chemistry = v["chemistry"].as_str().unwrap_or("Li-Ion").to_string();
            let mut design = v["design"].as_u64().filter(|&x| x > 0);
            let mut full = v["full"].as_u64().filter(|&x| x > 0);
            let mut cycles = v["cycles"].as_u64().filter(|&x| x > 0).map(|x| x as u32);
            let mut cycle_source = if cycles.is_some() {
                "ACPI/WMI".to_string()
            } else {
                String::new()
            };

            // Enrich via `powercfg /batteryreport /xml` to unlock real CycleCount on Dell/HP/Lenovo
            // where WMI BatteryCycleCount returns 0, plus historical capacity wear checkpoints.
            if let Some(parsed_xml) = read_windows_powercfg_battery_xml() {
                if design.is_none() {
                    design = parsed_xml.design_mwh;
                }
                if full.is_none() {
                    full = parsed_xml.full_charge_mwh;
                }
                if cycles.is_none() {
                    if let Some(c) = parsed_xml.cycle_count {
                        cycles = Some(c);
                        cycle_source = "Windows Battery Report XML".to_string();
                    }
                }
                if report.manufacturer == "OEM" || report.manufacturer.is_empty() {
                    if let Some(m) = parsed_xml.manufacturer {
                        report.manufacturer = m;
                    }
                }
                if let Some(c) = parsed_xml.chemistry {
                    if report.chemistry == "Unknown" || report.chemistry.is_empty() {
                        report.chemistry = c;
                    }
                }
                report.capacity_history = parsed_xml.capacity_history;
            }

            report.design_capacity_mwh = design;
            report.full_charge_capacity_mwh = full;
            report.cycle_count = cycles;
            report.cycle_source = cycle_source;
            report.current_charge_percent = v["chargePct"].as_f64();
            report.ac_plugged = v["ac"].as_bool().unwrap_or(false);
            report.is_charging = v["charging"].as_bool().unwrap_or(false);
            report.voltage_mv = v["voltage"].as_u64().filter(|&x| x > 0);
            report.rate_mw = v["rateMw"].as_i64();
            report.adapter_watts = v["adapterWatts"].as_u64().filter(|&w| w > 0 && w <= 500).map(|w| w as u32);
            report.adapter_source = v["adapterSrc"].as_str().unwrap_or("").trim().to_string();
            let has_dgpu = v["hasDgpu"].as_bool().unwrap_or(false);
            report.adapter_warning = evaluate_charger_adequacy(report.ac_plugged, report.adapter_watts, has_dgpu);

            if let (Some(d), Some(f)) = (design, full) {
                let health = ((f as f64 / d as f64) * 100.0).min(100.0);
                let wear = (100.0 - health).max(0.0);
                report.health_percent = Some((health * 10.0).round() / 10.0);
                report.wear_percent = Some((wear * 10.0).round() / 10.0);
            }

            report.status = match report.health_percent {
                Some(h) if h >= 80.0 => TestStatus::Pass,
                Some(h) if h >= 65.0 => TestStatus::Warn,
                Some(_) => TestStatus::Fail,
                None => TestStatus::Warn,
            };
            if report.adapter_warning.is_some() && report.status == TestStatus::Pass {
                report.status = TestStatus::Warn;
            }

            report.notes = match report.health_percent {
                Some(h) if h >= 80.0 => format!("Healthy battery ({:.1}% capacity remaining).", h),
                Some(h) if h >= 65.0 => {
                    format!("Moderate battery wear ({:.1}% capacity remaining).", h)
                }
                Some(h) => format!(
                    "Degraded battery ({:.1}% capacity remaining — replacement advised).",
                    h
                ),
                None => "Battery detected; OEM firmware did not expose full capacity telemetry."
                    .to_string(),
            };
            if let Some(ref aw) = report.adapter_warning {
                report.notes = format!("{} | {}", report.notes, aw);
            }
        }
    }

    report
}

#[derive(Debug, Clone, Default)]
pub struct ParsedPowercfgBatteryXml {
    pub design_mwh: Option<u64>,
    pub full_charge_mwh: Option<u64>,
    pub cycle_count: Option<u32>,
    pub manufacturer: Option<String>,
    pub chemistry: Option<String>,
    pub capacity_history: Vec<BatteryCapacityHistoryPoint>,
}

/// Pure XML parser for `powercfg /batteryreport /xml` output (cross-platform unit-testable).
/// Extracts static battery info (including CycleCount when WMI reports 0) plus up to 8 recent
/// historical capacity checkpoints from `<History><HistoryEntry .../>` blocks.
pub fn parse_windows_powercfg_battery_xml(content: &str) -> Option<ParsedPowercfgBatteryXml> {
    if content.trim().is_empty() {
        return None;
    }

    let extract_tag = |slice: &str, tag: &str| -> Option<String> {
        let open = format!("<{}>", tag);
        let close = format!("</{}>", tag);
        let start = slice.find(&open)? + open.len();
        let end = slice[start..].find(&close)? + start;
        let val = slice[start..end].trim().to_string();
        if val.is_empty() {
            None
        } else {
            Some(val)
        }
    };

    let extract_attr = |slice: &str, attr: &str| -> Option<String> {
        let needle = format!("{}=\"", attr);
        let start = slice.find(&needle)? + needle.len();
        let end = slice[start..].find('"')? + start;
        let val = slice[start..end].trim().to_string();
        if val.is_empty() {
            None
        } else {
            Some(val)
        }
    };

    // Scope static fields to <Batteries> section if present so we don't accidentally match a
    // stale <HistoryEntry> capacity before the current <Battery> block.
    let battery_scope = if let Some(b_start) = content.find("<Batteries>") {
        let rest = &content[b_start..];
        if let Some(b_end) = rest.find("</Batteries>") {
            &rest[..b_end]
        } else {
            rest
        }
    } else {
        content
    };

    let design_mwh = extract_tag(battery_scope, "DesignCapacity")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&x| x > 0);
    let full_charge_mwh = extract_tag(battery_scope, "FullChargeCapacity")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&x| x > 0);
    let cycle_count = extract_tag(battery_scope, "CycleCount")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|&c| c > 0);
    let manufacturer = extract_tag(battery_scope, "Manufacturer");
    let chemistry = extract_tag(battery_scope, "Chemistry");

    // Parse <HistoryEntry ...> records (Windows emits StartDate/EndDate attributes or child tags)
    let mut history: Vec<BatteryCapacityHistoryPoint> = Vec::new();
    let mut cursor = content;
    while let Some(pos) = cursor.find("<HistoryEntry") {
        let after = &cursor[pos..];
        let tag_end = match after.find('>') {
            Some(i) => i,
            None => break,
        };
        let is_self_closing = tag_end > 0 && after.as_bytes()[tag_end - 1] == b'/';
        let (entry_slice, advance) = if is_self_closing {
            (&after[..=tag_end], tag_end + 1)
        } else if let Some(close_pos) = after.find("</HistoryEntry>") {
            (&after[..close_pos + "</HistoryEntry>".len()], close_pos + "</HistoryEntry>".len())
        } else {
            (&after[..=tag_end], tag_end + 1)
        };

        let raw_date = extract_attr(entry_slice, "StartDate")
            .or_else(|| extract_attr(entry_slice, "EndDate"))
            .or_else(|| extract_tag(entry_slice, "Date"))
            .unwrap_or_default();
        let date = raw_date.split('T').next().unwrap_or(&raw_date).trim().to_string();

        let h_full = extract_attr(entry_slice, "FullChargeCapacity")
            .or_else(|| extract_tag(entry_slice, "FullChargeCapacity"))
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|&x| x > 0);
        let h_design = extract_attr(entry_slice, "DesignCapacity")
            .or_else(|| extract_tag(entry_slice, "DesignCapacity"))
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|&x| x > 0)
            .or(design_mwh);

        if let (Some(f), Some(d)) = (h_full, h_design) {
            if !date.is_empty() && d > 0 {
                let hp = round1(((f as f64 / d as f64) * 100.0).min(100.0));
                if history.last().map(|p| p.date.as_str()) != Some(date.as_str()) {
                    history.push(BatteryCapacityHistoryPoint {
                        date,
                        full_charge_mwh: f,
                        design_mwh: d,
                        health_pct: hp,
                    });
                }
            }
        }
        cursor = &after[advance..];
    }

    // Keep at most 8 evenly spaced / recent checkpoints so the UI & PDF stay clean
    if history.len() > 8 {
        let step = history.len() / 8;
        let mut sampled: Vec<BatteryCapacityHistoryPoint> = history
            .iter()
            .step_by(step.max(1))
            .take(7)
            .cloned()
            .collect();
        if let Some(last) = history.last() {
            if sampled.last().map(|p| p.date.as_str()) != Some(last.date.as_str()) {
                sampled.push(last.clone());
            }
        }
        history = sampled;
    }

    Some(ParsedPowercfgBatteryXml {
        design_mwh,
        full_charge_mwh,
        cycle_count,
        manufacturer,
        chemistry,
        capacity_history: history,
    })
}

#[cfg(target_os = "windows")]
fn read_windows_powercfg_battery_xml() -> Option<ParsedPowercfgBatteryXml> {
    use crate::cmd_util::run_cmd_stdout;
    let xml_path = std::env::temp_dir().join(format!(
        "laptopbench_battery_{}.xml",
        std::process::id()
    ));
    let xml_str = xml_path.to_string_lossy().to_string();
    let _ = run_cmd_stdout("powercfg", &["/batteryreport", "/xml", "/output", &xml_str]);
    let content = std::fs::read_to_string(&xml_path).ok()?;
    let _ = std::fs::remove_file(&xml_path);
    parse_windows_powercfg_battery_xml(&content)
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct MacosIoregBattery {
    pub design_mah: Option<i64>,
    pub max_mah: Option<i64>,
    pub current_charge_percent: Option<f64>,
    pub cycle_count: Option<u32>,
    pub voltage_mv: Option<u64>,
    pub amperage_ma: Option<i64>,
    pub is_charging: bool,
    pub ac_plugged: bool,
    pub adapter_watts: Option<u32>,
}

#[allow(dead_code)]
pub(crate) fn parse_macos_ioreg_battery(out: &str) -> Option<MacosIoregBattery> {
    if !out.contains("AppleSmartBattery") {
        return None;
    }

    let parse_int = |key: &str| -> Option<i64> {
        let prefix = format!("\"{}\" =", key);
        for line in out.lines() {
            let t = line
                .trim_start_matches(|c: char| c.is_whitespace() || c == '|')
                .trim_end();
            if t.starts_with(&prefix) {
                if let Some((_, rhs)) = t.split_once('=') {
                    let clean = rhs.trim().trim_end_matches(',');
                    if let Ok(v) = clean
                        .parse::<i64>()
                        .or_else(|_| clean.parse::<u64>().map(|u| u as i64))
                    {
                        return Some(v);
                    }
                }
            }
        }
        None
    };

    let parse_bool = |key: &str| -> bool {
        let prefix = format!("\"{}\" =", key);
        for line in out.lines() {
            let t = line
                .trim_start_matches(|c: char| c.is_whitespace() || c == '|')
                .trim_end();
            if t.starts_with(&prefix) {
                return t.contains("Yes") || t.contains("true");
            }
        }
        false
    };

    let design_mah = parse_int("DesignCapacity").filter(|&x| x > 0);
    let max_mah = parse_int("AppleRawMaxCapacity")
        .or_else(|| parse_int("NominalChargeCapacity"))
        .or_else(|| parse_int("MaxCapacity"))
        .filter(|&x| x > 0);

    let raw_cur = parse_int("AppleRawCurrentCapacity").filter(|&x| x >= 0);
    let raw_max = parse_int("AppleRawMaxCapacity").filter(|&x| x > 0);
    let cur_cap = parse_int("CurrentCapacity").filter(|&x| x >= 0);
    let std_max = parse_int("MaxCapacity").filter(|&x| x > 0);

    let current_charge_percent = if let (Some(rc), Some(rm)) = (raw_cur, raw_max) {
        Some((((rc as f64 / rm as f64) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0)
    } else if let Some(cur) = cur_cap {
        if std_max.map(|m| m > 100).unwrap_or(false) {
            let m = std_max.unwrap();
            Some((((cur as f64 / m as f64) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0)
        } else if cur > 100 {
            if let Some(m) = max_mah {
                Some((((cur as f64 / m as f64) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0)
            } else {
                None
            }
        } else {
            Some((cur as f64).clamp(0.0, 100.0))
        }
    } else {
        None
    };

    let cycle_count = parse_int("CycleCount").filter(|&v| v >= 0).map(|v| v as u32);
    let voltage_mv = parse_int("Voltage").filter(|&x| x > 0).map(|v| v as u64);
    let amperage_ma = parse_int("InstantAmperage")
        .or_else(|| parse_int("Amperage"))
        .map(|v| {
            if (0x8000_0000i64..=0xFFFF_FFFFi64).contains(&v) {
                (v as u32 as i32) as i64
            } else {
                v
            }
        });
    let is_charging = parse_bool("IsCharging");
    let ac_plugged = parse_bool("ExternalConnected");

    let mut adapter_watts = None;
    for line in out.lines() {
        if let Some(idx) = line.find("\"Watts\"") {
            let after_key = line[idx + "\"Watts\"".len()..].trim_start();
            if let Some(after_eq) = after_key.strip_prefix('=') {
                let num: String = after_eq
                    .trim_start()
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(w) = num.parse::<u32>() {
                    adapter_watts = Some(w);
                }
            }
        }
    }

    Some(MacosIoregBattery {
        design_mah,
        max_mah,
        current_charge_percent,
        cycle_count,
        voltage_mv,
        amperage_ma,
        is_charging,
        ac_plugged,
        adapter_watts,
    })
}

#[cfg(target_os = "macos")]
fn sample_macos_battery_fast() -> Option<BatteryLiveSample> {
    use crate::cmd_util::run_cmd_stdout;
    let out = run_cmd_stdout("ioreg", &["-r", "-c", "AppleSmartBattery", "-d", "1"]).ok()?;
    let parsed = parse_macos_ioreg_battery(&out)?;
    let rate_mw = match (parsed.amperage_ma, parsed.voltage_mv) {
        (Some(ma), Some(mv)) => Some((ma * (mv as i64)) / 1000),
        _ => None,
    };
    let watts = rate_mw.map(|mw| ((mw as f64) / 1000.0 * 100.0).round() / 100.0);
    Some(BatteryLiveSample {
        timestamp_ms: Utc::now().timestamp_millis(),
        charge_percent: parsed.current_charge_percent.unwrap_or(0.0),
        ac_plugged: parsed.ac_plugged,
        is_charging: parsed.is_charging,
        voltage_mv: parsed.voltage_mv,
        rate_mw,
        watts,
    })
}

#[cfg(target_os = "macos")]
fn get_macos_battery_health() -> BatteryHealthReport {
    use crate::cmd_util::run_cmd_stdout;

    let mut report = BatteryHealthReport {
        present: false,
        status: TestStatus::NotApplicable,
        manufacturer: "Apple".to_string(),
        chemistry: "Li-Ion".to_string(),
        design_capacity_mwh: None,
        full_charge_capacity_mwh: None,
        health_percent: None,
        wear_percent: None,
        cycle_count: None,
        current_charge_percent: None,
        is_charging: false,
        ac_plugged: true,
        voltage_mv: None,
        rate_mw: None,
        adapter_watts: None,
        notes: "No internal battery detected.".to_string(),
        cycle_source: String::new(),
        capacity_history: Vec::new(),
        adapter_source: String::new(),
        adapter_warning: None,
    };

    if let Ok(out) = run_cmd_stdout("ioreg", &["-r", "-c", "AppleSmartBattery", "-d", "1"]) {
        let Some(parsed) = parse_macos_ioreg_battery(&out) else {
            return report;
        };
        report.present = true;

        let nom_v = parsed.voltage_mv.map(|mv| mv as f64 / 1000.0).unwrap_or(11.4);
        report.design_capacity_mwh = parsed
            .design_mah
            .map(|m| (m as f64 * nom_v).round() as u64);
        report.full_charge_capacity_mwh = parsed
            .max_mah
            .map(|m| (m as f64 * nom_v).round() as u64);
        report.cycle_count = parsed.cycle_count;
        if parsed.cycle_count.is_some() {
            report.cycle_source = "macOS IORegistry".to_string();
        }
        report.current_charge_percent = parsed.current_charge_percent;
        report.voltage_mv = parsed.voltage_mv;
        report.is_charging = parsed.is_charging;
        report.ac_plugged = parsed.ac_plugged;
        report.adapter_watts = parsed.adapter_watts;
        if parsed.adapter_watts.is_some() {
            report.adapter_source = "macOS IORegistry USB-C PD".to_string();
        }
        report.adapter_warning = evaluate_charger_adequacy(report.ac_plugged, report.adapter_watts, false);

        if let (Some(ma), Some(mv)) = (parsed.amperage_ma, parsed.voltage_mv) {
            report.rate_mw = Some((ma * (mv as i64)) / 1000);
        }

        if let (Some(d), Some(m)) = (parsed.design_mah, parsed.max_mah) {
            let health = ((m as f64 / d as f64) * 100.0).min(100.0);
            let wear = (100.0 - health).max(0.0);
            report.health_percent = Some((health * 10.0).round() / 10.0);
            report.wear_percent = Some((wear * 10.0).round() / 10.0);
        }

        report.status = match (report.health_percent, report.cycle_count) {
            (Some(h), Some(c)) if h >= 80.0 && c < 800 => TestStatus::Pass,
            (Some(h), _) if h >= 75.0 => TestStatus::Warn,
            (Some(_), _) => TestStatus::Fail,
            _ => TestStatus::Warn,
        };

        report.notes = format!(
            "Apple Smart Battery — Health: {}%, Cycles: {}.",
            report
                .health_percent
                .map(|h| format!("{:.1}", h))
                .unwrap_or_else(|| "?".to_string()),
            report
                .cycle_count
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string())
        );
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_health(wear_pct: f64, full_mwh: Option<u64>, cycles: Option<u32>) -> BatteryHealthReport {
        BatteryHealthReport {
            present: true,
            status: TestStatus::Pass,
            manufacturer: "OEM".into(),
            chemistry: "Li-Ion".into(),
            design_capacity_mwh: Some(50_000),
            full_charge_capacity_mwh: full_mwh,
            health_percent: Some((100.0 - wear_pct).max(0.0)),
            wear_percent: Some(wear_pct),
            cycle_count: cycles,
            current_charge_percent: Some(80.0),
            is_charging: false,
            ac_plugged: false,
            voltage_mv: Some(11_400),
            rate_mw: Some(-6_000),
            adapter_watts: None,
            notes: String::new(),
            cycle_source: "Test".into(),
            capacity_history: Vec::new(),
            adapter_source: String::new(),
            adapter_warning: None,
        }
    }

    fn mk_sample(t_s: i64, soc: f64, mv: Option<u64>, watts: Option<f64>) -> BatteryLiveSample {
        BatteryLiveSample {
            timestamp_ms: 1_700_000_000_000 + t_s * 1000,
            charge_percent: soc,
            ac_plugged: false,
            is_charging: false,
            voltage_mv: mv,
            rate_mw: watts.map(|w| -(w * 1000.0) as i64),
            watts: watts.map(|w| -w),
        }
    }

    #[test]
    fn test_clamp_discharge_duration_bounds() {
        assert_eq!(clamp_discharge_duration(None), 55);
        assert_eq!(clamp_discharge_duration(Some(5)), 20);
        assert_eq!(clamp_discharge_duration(Some(60)), 60);
        assert_eq!(clamp_discharge_duration(Some(300)), BATTERY_DISCHARGE_MAX_SECS);
        assert_eq!(BATTERY_DISCHARGE_MAX_SECS, 90);
        assert_eq!(BATTERY_LOW_SOC_ABORT_PCT, 15.0);
    }

    #[test]
    fn test_classify_normal_discharge_pass() {
        let mut samples = Vec::new();
        // 12s idle @ ~6W, 11.6V
        for t in 0..12 {
            samples.push(mk_sample(t, 80.0 - (t as f64) * 0.01, Some(11_600), Some(6.0)));
        }
        // 40s load @ ~28W (slight ramp + steady), ~11.38V (220mV sag)
        for t in 12..52 {
            let w = 27.5 + ((t % 3) as f64) * 0.5;
            let soc = 79.88 - ((t - 12) as f64) * 0.017;
            samples.push(mk_sample(t, soc, Some(11_380), Some(w)));
        }
        let health = mk_health(8.0, Some(46_000), Some(95));
        let res = classify_battery_discharge(&samples, 12, &health, 52.0, None, false);
        assert_eq!(res.status, TestStatus::Pass);
        assert_eq!(res.verdict, "NORMAL");
        assert!(res.reasons.is_empty(), "Unexpected reasons: {:?}", res.reasons);
        assert!((res.idle_avg_watts - 6.0).abs() < 0.1);
        assert!(res.load_avg_watts > 26.0 && res.load_avg_watts < 30.0);
        assert!(res.power_cv_pct < 5.0);
        assert!((res.voltage_sag_mv - 220.0).abs() < 1.0);
        assert_eq!(res.cycle_count, 95);
        assert!(res.plain_summary.contains("NORMAL"));
    }

    #[test]
    fn test_classify_sudden_soc_cliff_and_total_drop_fail() {
        let mut samples = Vec::new();
        for t in 0..10 {
            samples.push(mk_sample(t, 70.0, Some(11_500), Some(6.0)));
        }
        for t in 10..20 {
            let soc = if t < 15 { 69.5 } else { 65.0 }; // 4.5% cliff in 1s!
            samples.push(mk_sample(t, soc, Some(11_200), Some(24.0)));
        }
        let health = mk_health(10.0, Some(45_000), Some(120));
        let res = classify_battery_discharge(&samples, 10, &health, 20.0, None, false);
        assert_eq!(res.status, TestStatus::Fail);
        assert_eq!(res.verdict, "ABNORMAL");
        assert!(res.max_step_drop_pct >= 4.0);
        assert!(res.reasons.iter().any(|r| r.contains("cliff")));

        // >= 8% total drop over 40s also fails
        let mut slow_cliff = Vec::new();
        for t in 0..10 {
            slow_cliff.push(mk_sample(t, 70.0, Some(11_500), Some(6.0)));
        }
        for t in 10..50 {
            let soc = 70.0 - ((t - 9) as f64) * 0.25; // 10% total drop
            slow_cliff.push(mk_sample(t, soc, Some(11_200), Some(24.0)));
        }
        let res2 = classify_battery_discharge(&slow_cliff, 10, &health, 50.0, None, false);
        assert_eq!(res2.status, TestStatus::Fail);
        assert_eq!(res2.verdict, "ABNORMAL");
        assert!(res2.reasons.iter().any(|r| r.contains("Excessive charge drop")));
    }

    #[test]
    fn test_classify_voltage_sag_cv_wear_and_bms_drift() {
        // Severe voltage sag >= 1200 mV -> Fail
        let mut sag_samples = Vec::new();
        for t in 0..10 {
            sag_samples.push(mk_sample(t, 75.0, Some(11_800), Some(6.0)));
        }
        for t in 10..30 {
            sag_samples.push(mk_sample(t, 74.6, Some(10_500), Some(25.0))); // 1300 mV sag
        }
        let health = mk_health(12.0, Some(44_000), Some(150));
        let sag_res = classify_battery_discharge(&sag_samples, 10, &health, 30.0, None, false);
        assert_eq!(sag_res.status, TestStatus::Fail);
        assert_eq!(sag_res.verdict, "ABNORMAL");
        assert!((sag_res.voltage_sag_mv - 1300.0).abs() < 1.0);

        // Moderate voltage sag 800 mV -> Warn + ABNORMAL
        let mut warn_sag = Vec::new();
        for t in 0..10 {
            warn_sag.push(mk_sample(t, 75.0, Some(11_800), Some(6.0)));
        }
        for t in 10..30 {
            warn_sag.push(mk_sample(t, 74.6, Some(11_000), Some(25.0))); // 800 mV sag
        }
        let warn_res = classify_battery_discharge(&warn_sag, 10, &health, 30.0, None, false);
        assert_eq!(warn_res.status, TestStatus::Warn);
        assert_eq!(warn_res.verdict, "ABNORMAL");

        // High power CV > 25% -> Fail
        let mut cv_samples = Vec::new();
        for t in 0..10 {
            cv_samples.push(mk_sample(t, 75.0, Some(11_500), Some(6.0)));
        }
        for t in 10..24 {
            let w = if t % 2 == 0 { 10.0 } else { 35.0 };
            cv_samples.push(mk_sample(t, 74.7, Some(11_300), Some(w)));
        }
        let cv_res = classify_battery_discharge(&cv_samples, 10, &health, 24.0, None, false);
        assert_eq!(cv_res.status, TestStatus::Fail);
        assert!(cv_res.power_cv_pct > 25.0);

        // BMS drift: reported drop 3.5% vs ~0.7% expected (~25W * 45s / 45Wh) -> Warn ABNORMAL
        let mut drift_samples = Vec::new();
        for t in 0..10 {
            drift_samples.push(mk_sample(t, 75.0, Some(11_500), Some(6.0)));
        }
        for t in 10..55 {
            let soc = 75.0 - ((t - 9) as f64) * 0.078; // ~3.5% total
            drift_samples.push(mk_sample(t, soc, Some(11_300), Some(25.0)));
        }
        let drift_res = classify_battery_discharge(&drift_samples, 10, &health, 55.0, None, false);
        assert_eq!(drift_res.status, TestStatus::Warn);
        assert_eq!(drift_res.verdict, "ABNORMAL");
        assert!(drift_res.bms_drift_ratio > 2.0);

        // Integer 1% quantization guard: 1.0% drop must NOT false-trigger BMS drift
        let mut quant_samples = Vec::new();
        for t in 0..10 {
            quant_samples.push(mk_sample(t, 75.0, Some(11_500), Some(6.0)));
        }
        for t in 10..40 {
            let soc = if t < 25 { 75.0 } else { 74.0 };
            quant_samples.push(mk_sample(t, soc, Some(11_300), Some(22.0)));
        }
        let quant_res = classify_battery_discharge(&quant_samples, 10, &health, 40.0, None, false);
        assert_eq!(quant_res.status, TestStatus::Pass);
        assert_eq!(quant_res.verdict, "NORMAL");

        // High wear > 35% -> Fail
        let worn_health = mk_health(42.0, Some(29_000), Some(850));
        let mut normal_curve = Vec::new();
        for t in 0..10 {
            normal_curve.push(mk_sample(t, 80.0, Some(11_500), Some(6.0)));
        }
        for t in 10..30 {
            normal_curve.push(mk_sample(t, 79.7, Some(11_300), Some(24.0)));
        }
        let worn_res = classify_battery_discharge(&normal_curve, 10, &worn_health, 30.0, None, false);
        assert_eq!(worn_res.status, TestStatus::Fail);
        assert_eq!(worn_res.verdict, "ABNORMAL");
    }

    #[test]
    fn test_classify_missing_sensors_and_preconditions() {
        let mut no_sensor_samples = Vec::new();
        for t in 0..10 {
            no_sensor_samples.push(mk_sample(t, 82.0, None, None));
        }
        for t in 10..35 {
            no_sensor_samples.push(mk_sample(t, 81.6, None, None));
        }
        let health = mk_health(10.0, Some(45_000), Some(40));
        let res = classify_battery_discharge(&no_sensor_samples, 10, &health, 35.0, None, false);
        assert_eq!(res.status, TestStatus::Pass);
        assert_eq!(res.verdict, "NORMAL");
        assert_eq!(res.voltage_sag_mv, 0.0);
        assert_eq!(res.idle_avg_watts, 0.0);
        assert!(res.plain_summary.contains("omitted live voltage/wattage"));

        let na = classify_battery_discharge(
            &[],
            0,
            &health,
            0.0,
            Some(("NOT_APPLICABLE", "No internal battery detected.")),
            false,
        );
        assert_eq!(na.status, TestStatus::NotApplicable);
        assert_eq!(na.verdict, "NOT_APPLICABLE");

        let ac = classify_battery_discharge(
            &[],
            0,
            &health,
            0.0,
            Some(("AC_CONNECTED", "Unplug AC charger.")),
            false,
        );
        assert_eq!(ac.status, TestStatus::Warn);
        assert_eq!(ac.verdict, "AC_CONNECTED");

        let low = classify_battery_discharge(
            &[],
            0,
            &health,
            0.0,
            Some(("ABORTED_LOW_BATTERY", "Battery <= 15%.")),
            false,
        );
        assert_eq!(low.status, TestStatus::Warn);
        assert_eq!(low.verdict, "ABORTED_LOW_BATTERY");
    }

    #[test]
    fn test_macos_ioreg_signed_amperage_and_capacity_helpers() {
        // Apple Silicon style: CurrentCapacity in %, InstantAmperage as two's complement u64
        let apple_silicon = r#"
    | |   +-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000400, registered, matched, active, busy 0 (0 ms), retain 6>
    | |     {
    | |       "ExternalConnected" = No
    | |       "IsCharging" = No
    | |       "CurrentCapacity" = 78
    | |       "MaxCapacity" = 100
    | |       "DesignCapacity" = 5103
    | |       "AppleRawCurrentCapacity" = 3650
    | |       "AppleRawMaxCapacity" = 4680
    | |       "CycleCount" = 112
    | |       "Voltage" = 11420
    | |       "InstantAmperage" = 18446744073709550366
    | |       "AdapterDetails" = {"Watts"=67}
    | |     }
"#;
        let parsed = parse_macos_ioreg_battery(apple_silicon).expect("AppleSmartBattery should parse");
        assert!(!parsed.ac_plugged);
        assert!(!parsed.is_charging);
        assert_eq!(parsed.amperage_ma, Some(-1250)); // 18446744073709550366u64 as i64 == -1250
        assert_eq!(parsed.voltage_mv, Some(11_420));
        assert_eq!(parsed.cycle_count, Some(112));
        assert_eq!(parsed.adapter_watts, Some(67));
        // 3650 / 4680 * 100 = 77.99 -> 78.0%
        assert_eq!(parsed.current_charge_percent, Some(78.0));

        // Intel Mac style: CurrentCapacity & MaxCapacity in mAh (> 100), no AppleRaw*
        let intel_mac = r#"
    | |   +-o AppleSmartBattery  <class AppleSmartBattery>
    | |     {
    | |       "ExternalConnected" = Yes
    | |       "IsCharging" = Yes
    | |       "CurrentCapacity" = 3200
    | |       "MaxCapacity" = 4000
    | |       "DesignCapacity" = 4800
    | |       "CycleCount" = 240
    | |       "Voltage" = 12100
    | |       "InstantAmperage" = 1500
    | |     }
"#;
        let parsed_intel = parse_macos_ioreg_battery(intel_mac).expect("Intel ioreg should parse");
        assert!(parsed_intel.ac_plugged);
        assert!(parsed_intel.is_charging);
        assert_eq!(parsed_intel.amperage_ma, Some(1500));
        assert_eq!(parsed_intel.current_charge_percent, Some(80.0));

        // Low Intel mAh battery (<= 100 mAh) + 32-bit two's complement InstantAmperage + spaced "Watts" = 67
        let intel_low = r#"
    | |   +-o AppleSmartBattery  <class AppleSmartBattery>
    | |     {
    | |       "ExternalConnected" = No
    | |       "IsCharging" = No
    | |       "CurrentCapacity" = 100
    | |       "MaxCapacity" = 4000
    | |       "DesignCapacity" = 4800
    | |       "Voltage" = 10950
    | |       "InstantAmperage" = 4294966046
    | |       "AdapterDetails" = {"Watts" = 67}
    | |     }
"#;
        let parsed_low = parse_macos_ioreg_battery(intel_low).expect("Low Intel ioreg should parse");
        assert_eq!(parsed_low.current_charge_percent, Some(2.5));
        assert_eq!(parsed_low.amperage_ma, Some(-1250));
        assert_eq!(parsed_low.adapter_watts, Some(67));
    }

    #[test]
    fn test_classify_early_cancel_insufficient_nan_and_duplicate_timestamp_drop() {
        let health = mk_health(8.0, Some(46_000), Some(50));

        // 8 idle-only samples with cancelled=true must NOT return Pass / NORMAL
        let mut idle_only = Vec::new();
        for t in 0..8 {
            idle_only.push(mk_sample(t, 80.0, Some(11_600), Some(6.0)));
        }
        let cancelled_idle = classify_battery_discharge(&idle_only, 8, &health, 8.0, None, true);
        assert_eq!(cancelled_idle.status, TestStatus::Warn);
        assert_eq!(cancelled_idle.verdict, "CANCELLED");
        assert!(cancelled_idle.plain_summary.contains("load verification"));

        // < 5 load samples with cancelled=true and no fault must also return CANCELLED
        let mut short_load = Vec::new();
        for t in 0..10 {
            short_load.push(mk_sample(t, 80.0, Some(11_600), Some(6.0)));
        }
        for t in 10..13 {
            short_load.push(mk_sample(t, 79.9, Some(11_400), Some(24.0)));
        }
        let cancelled_short = classify_battery_discharge(&short_load, 10, &health, 13.0, None, true);
        assert_eq!(cancelled_short.status, TestStatus::Warn);
        assert_eq!(cancelled_short.verdict, "CANCELLED");

        // < 2 finite samples when not cancelled must NOT return NORMAL
        let empty_res = classify_battery_discharge(&[], 0, &health, 0.0, None, false);
        assert_eq!(empty_res.status, TestStatus::Warn);
        assert_eq!(empty_res.verdict, "INSUFFICIENT_SAMPLES");

        let one_sample = vec![mk_sample(0, 80.0, Some(11_600), Some(6.0))];
        let one_res = classify_battery_discharge(&one_sample, 1, &health, 1.0, None, false);
        assert_eq!(one_res.status, TestStatus::Warn);
        assert_eq!(one_res.verdict, "INSUFFICIENT_SAMPLES");

        let nan_samples = vec![
            mk_sample(0, f64::NAN, Some(11_600), Some(6.0)),
            mk_sample(1, f64::INFINITY, Some(11_600), Some(6.0)),
        ];
        let nan_res = classify_battery_discharge(&nan_samples, 1, &health, 2.0, None, false);
        assert_eq!(nan_res.status, TestStatus::Warn);
        assert_eq!(nan_res.verdict, "INSUFFICIENT_SAMPLES");

        // Duplicate timestamps (dt == 0) must not hide a >= 3.0% step drop
        let dup_ts = vec![
            mk_sample(0, 80.0, Some(11_500), Some(6.0)),
            mk_sample(0, 78.5, Some(11_400), Some(22.0)),
            mk_sample(0, 76.9, Some(11_300), Some(22.0)),
        ];
        let dup_res = classify_battery_discharge(&dup_ts, 1, &health, 3.0, None, false);
        assert_eq!(dup_res.status, TestStatus::Fail);
        assert_eq!(dup_res.verdict, "ABNORMAL");
        assert!((dup_res.max_step_drop_pct - 3.1).abs() < 0.01);

        // Late cancellation after >= 15 samples (>= 10 load) with no fault must still return CANCELLED (Warn), not NORMAL (Pass)
        let mut late_cancel_samples = Vec::new();
        for t in 0..10 {
            late_cancel_samples.push(mk_sample(t, 82.0 - (t as f64) * 0.01, Some(11_600), Some(6.0)));
        }
        for t in 10..20 {
            late_cancel_samples.push(mk_sample(t, 81.9 - ((t - 10) as f64) * 0.02, Some(11_380), Some(24.0)));
        }
        let late_cancel_res =
            classify_battery_discharge(&late_cancel_samples, 10, &health, 20.0, None, true);
        assert_eq!(late_cancel_res.status, TestStatus::Warn);
        assert_eq!(late_cancel_res.verdict, "CANCELLED");
    }

    #[test]
    fn test_parse_windows_powercfg_battery_xml_cycles_and_history() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<BatteryReport>
  <Batteries>
    <Battery>
      <Manufacturer>BYD</Manufacturer>
      <Chemistry>LiP</Chemistry>
      <DesignCapacity>54000</DesignCapacity>
      <FullChargeCapacity>47520</FullChargeCapacity>
      <CycleCount>184</CycleCount>
    </Battery>
  </Batteries>
  <History>
    <HistoryEntry StartDate="2025-01-05" EndDate="2025-01-12" FullChargeCapacity="52800" DesignCapacity="54000" />
    <HistoryEntry StartDate="2025-06-01T00:00:00" EndDate="2025-06-08" FullChargeCapacity="49680" DesignCapacity="54000" />
    <HistoryEntry StartDate="2026-01-10" EndDate="2026-01-17" FullChargeCapacity="47520" DesignCapacity="54000" />
  </History>
</BatteryReport>"#;
        let parsed = parse_windows_powercfg_battery_xml(xml).expect("XML should parse");
        assert_eq!(parsed.design_mwh, Some(54_000));
        assert_eq!(parsed.full_charge_mwh, Some(47_520));
        assert_eq!(parsed.cycle_count, Some(184));
        assert_eq!(parsed.manufacturer.as_deref(), Some("BYD"));
        assert_eq!(parsed.chemistry.as_deref(), Some("LiP"));
        assert_eq!(parsed.capacity_history.len(), 3);
        assert_eq!(parsed.capacity_history[0].date, "2025-01-05");
        assert!((parsed.capacity_history[2].health_pct - 88.0).abs() < 0.1);
    }

    #[test]
    fn test_classify_battery_charge_ic_and_conservation_mode() {
        let mk_ac = |t: i64, soc: f64, w: f64, chg: bool| BatteryLiveSample {
            timestamp_ms: 1_700_000_000_000 + t * 1000,
            charge_percent: soc,
            ac_plugged: true,
            is_charging: chg,
            voltage_mv: Some(12_400),
            rate_mw: Some((w * 1000.0) as i64),
            watts: Some(w),
        };

        // 1. Healthy active charging (+35W)
        let ok_samples = vec![mk_ac(0, 52.0, 34.5, true), mk_ac(12, 53.0, 35.2, true)];
        let res_ok = classify_battery_charge_test(&ok_samples, 12.0, false);
        assert_eq!(res_ok.status, TestStatus::Pass);
        assert_eq!(res_ok.verdict, "PASS");

        // 2. OEM 80% Conservation Mode (holding 80% at 0W on AC -> WARN, NOT FAIL!)
        let cons_samples = vec![mk_ac(0, 80.0, 0.0, false), mk_ac(12, 80.0, 0.0, false)];
        let res_cons = classify_battery_charge_test(&cons_samples, 12.0, false);
        assert_eq!(res_cons.status, TestStatus::Warn);
        assert_eq!(res_cons.verdict, "CONSERVATION_MODE");

        // 3. Dead Charging IC / MOSFET (<75% on AC, 0W / draining -> FAIL!)
        let dead_ic = vec![mk_ac(0, 48.0, 0.0, false), mk_ac(12, 47.8, -4.5, false)];
        let res_dead = classify_battery_charge_test(&dead_ic, 12.0, false);
        assert_eq!(res_dead.status, TestStatus::Fail);
        assert_eq!(res_dead.verdict, "CHARGING_IC_FAULT");

        // 4. Slow / trickle USB-C PD charge (+1.1W at 40% -> WARN)
        let slow = vec![mk_ac(0, 40.0, 1.1, true), mk_ac(12, 40.0, 1.2, true)];
        let res_slow = classify_battery_charge_test(&slow, 12.0, false);
        assert_eq!(res_slow.status, TestStatus::Warn);
        assert_eq!(res_slow.verdict, "SLOW_CHARGE");

        // 5. Unplugged AC -> WARN AC_UNPLUGGED
        let unplugged = vec![mk_sample(0, 60.0, Some(11_400), Some(12.0))];
        let res_unp = classify_battery_charge_test(&unplugged, 0.0, false);
        assert_eq!(res_unp.status, TestStatus::Warn);
        assert_eq!(res_unp.verdict, "AC_UNPLUGGED");
    }

    #[test]
    fn test_charger_adequacy_undersized_dgpu_v310() {
        // 45W charger on discrete-GPU gaming laptop -> WARN
        let warn_dgpu = evaluate_charger_adequacy(true, Some(45), true);
        assert!(warn_dgpu.is_some());
        assert!(warn_dgpu.unwrap().contains("Undersized AC charger (45W)"));

        // 130W charger on discrete-GPU laptop -> OK
        assert!(evaluate_charger_adequacy(true, Some(130), true).is_none());

        // 65W charger on ultrabook (no dGPU) -> OK
        assert!(evaluate_charger_adequacy(true, Some(65), false).is_none());

        // 18W phone charger on any laptop -> WARN
        let phone = evaluate_charger_adequacy(true, Some(18), false);
        assert!(phone.is_some());

        // Unplugged -> None
        assert!(evaluate_charger_adequacy(false, Some(45), true).is_none());
    }
}
