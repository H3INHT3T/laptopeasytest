use crate::modules::simd_kernels;
use crate::types::{
    BatteryHealthReport, BatteryLiveSample, BatterySagProgress, BatterySagResult, TestStatus,
};
use chrono::Utc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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
        }
    }
}

pub fn sample_battery_live() -> Option<BatteryLiveSample> {
    let report = get_battery_health();
    if !report.present {
        return None;
    }
    let watts = report.rate_mw.map(|mw| ((mw as f64) / 1000.0 * 100.0).round() / 100.0);
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

            // Fallback to `powercfg /batteryreport /xml` when WMI root\wmi returns 0
            // (works reliably on Dell/HP/Lenovo/ASUS even without Administrator elevation)
            if design.is_none() || full.is_none() {
                if let Some((p_design, p_full, p_cycles, p_mfg, p_chem)) =
                    read_windows_powercfg_battery_xml()
                {
                    if design.is_none() {
                        design = p_design;
                    }
                    if full.is_none() {
                        full = p_full;
                    }
                    if cycles.is_none() {
                        cycles = p_cycles;
                    }
                    if report.manufacturer == "OEM" || report.manufacturer.is_empty() {
                        if let Some(m) = p_mfg {
                            report.manufacturer = m;
                        }
                    }
                    if let Some(c) = p_chem {
                        report.chemistry = c;
                    }
                }
            }

            report.design_capacity_mwh = design;
            report.full_charge_capacity_mwh = full;
            report.cycle_count = cycles;
            report.current_charge_percent = v["chargePct"].as_f64();
            report.ac_plugged = v["ac"].as_bool().unwrap_or(false);
            report.is_charging = v["charging"].as_bool().unwrap_or(false);
            report.voltage_mv = v["voltage"].as_u64().filter(|&x| x > 0);
            report.rate_mw = v["rateMw"].as_i64();

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
        }
    }

    report
}

#[cfg(target_os = "windows")]
fn read_windows_powercfg_battery_xml() -> Option<(
    Option<u64>,
    Option<u64>,
    Option<u32>,
    Option<String>,
    Option<String>,
)> {
    use crate::cmd_util::run_cmd_stdout;
    let xml_path = std::env::temp_dir().join(format!(
        "laptopbench_battery_{}.xml",
        std::process::id()
    ));
    let xml_str = xml_path.to_string_lossy().to_string();
    let _ = run_cmd_stdout("powercfg", &["/batteryreport", "/xml", "/output", &xml_str]);
    let content = std::fs::read_to_string(&xml_path).ok()?;
    let _ = std::fs::remove_file(&xml_path);

    let extract = |tag: &str| -> Option<String> {
        let open = format!("<{}>", tag);
        let close = format!("</{}>", tag);
        let start = content.find(&open)? + open.len();
        let end = content[start..].find(&close)? + start;
        let val = content[start..end].trim().to_string();
        if val.is_empty() {
            None
        } else {
            Some(val)
        }
    };

    let design = extract("DesignCapacity").and_then(|s| s.parse::<u64>().ok()).filter(|&x| x > 0);
    let full = extract("FullChargeCapacity").and_then(|s| s.parse::<u64>().ok()).filter(|&x| x > 0);
    let cycles = extract("CycleCount").and_then(|s| s.parse::<u32>().ok());
    let mfg = extract("Manufacturer");
    let chem = extract("Chemistry");
    Some((design, full, cycles, mfg, chem))
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
    };

    if let Ok(out) = run_cmd_stdout("ioreg", &["-r", "-c", "AppleSmartBattery", "-d", "1"]) {
        if !out.contains("AppleSmartBattery") {
            return report;
        }
        report.present = true;

        let parse_int = |key: &str| -> Option<i64> {
            for line in out.lines() {
                let t = line.trim();
                if t.starts_with(&format!("\"{}\" =", key)) {
                    if let Some((_, rhs)) = t.split_once('=') {
                        let clean = rhs.trim().trim_end_matches(',');
                        if let Ok(v) = clean.parse::<i64>() {
                            return Some(v);
                        }
                    }
                }
            }
            None
        };
        let parse_bool = |key: &str| -> bool {
            for line in out.lines() {
                let t = line.trim();
                if t.starts_with(&format!("\"{}\" =", key)) {
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
        let cur_pct = parse_int("CurrentCapacity").map(|v| v as f64);
        let cycles = parse_int("CycleCount").map(|v| v as u32);
        let voltage_mv = parse_int("Voltage").filter(|&x| x > 0).map(|v| v as u64);
        let amperage_ma = parse_int("InstantAmperage").or_else(|| parse_int("Amperage"));
        let is_charging = parse_bool("IsCharging");
        let ac_plugged = parse_bool("ExternalConnected");

        // Parse AdapterDetails Watts if present
        let mut adapter_watts = None;
        for line in out.lines() {
            if line.contains("\"Watts\"=") {
                if let Some(idx) = line.find("\"Watts\"=") {
                    let rest = &line[idx + 8..];
                    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(w) = num.parse::<u32>() {
                        adapter_watts = Some(w);
                    }
                }
            }
        }

        // Convert mAh * nominal V (~11.4V or current voltage) to mWh for display consistency
        let nom_v = voltage_mv.map(|mv| mv as f64 / 1000.0).unwrap_or(11.4);
        report.design_capacity_mwh = design_mah.map(|m| (m as f64 * nom_v).round() as u64);
        report.full_charge_capacity_mwh = max_mah.map(|m| (m as f64 * nom_v).round() as u64);
        report.cycle_count = cycles;
        report.current_charge_percent = cur_pct;
        report.voltage_mv = voltage_mv;
        report.is_charging = is_charging;
        report.ac_plugged = ac_plugged;
        report.adapter_watts = adapter_watts;

        if let (Some(ma), Some(mv)) = (amperage_ma, voltage_mv) {
            // InstantAmperage can be signed 64-bit; mA * mV / 1000 = mW
            report.rate_mw = Some((ma * (mv as i64)) / 1000);
        }

        if let (Some(d), Some(m)) = (design_mah, max_mah) {
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
