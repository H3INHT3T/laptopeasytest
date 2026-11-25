use crate::types::{BatteryHealthReport, BatteryLiveSample, TestStatus};
use chrono::Utc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
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
