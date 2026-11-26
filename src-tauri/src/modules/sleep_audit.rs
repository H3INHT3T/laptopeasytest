//! Passive Sleep / Modern Standby (S0ix / S3) Drain & Wake-Crash Audit (v3.0.0)
//!
//! 100% passive OS telemetry audit (zero sleep/reboot interruption):
//! - Windows: `powercfg /a`, `powercfg /devicequery wake_armed`, `powercfg /sleepstudy /xml`,
//!   and Kernel-Power wake/sleep crash events.
//! - macOS: `pmset -g custom` and `pmset -g log` DarkWake / sleep failure counts.

use crate::types::{SleepStandbyReport, TestStatus};

/// Parses Windows `powercfg /a` output into a clean human-readable sleep state label.
pub fn parse_windows_powercfg_a(out: &str) -> String {
    let low = out.to_lowercase();
    if low.contains("s0 low power idle") || low.contains("network connected") {
        "Modern Standby (S0ix)".to_string()
    } else if low.contains("standby (s3)") {
        "Classic S3 Sleep".to_string()
    } else if low.contains("hibernate") {
        "Hibernate Only (No S0/S3)".to_string()
    } else {
        "Unknown Sleep Mode".to_string()
    }
}

/// Parses `powercfg /devicequery wake_armed` output into active wake-capable devices.
pub fn parse_windows_wake_armed(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case("none"))
        .map(ToString::to_string)
        .collect()
}

/// Parses `powercfg /sleepstudy /xml` output to extract standby drain rates (%/hr) across
/// meaningful standby sessions (>= 15 minutes). Returns `(sessions, avg_drain_pct_hr, max_drain_pct_hr)`.
pub fn parse_windows_sleepstudy_xml(xml: &str) -> (u32, Option<f64>, Option<f64>) {
    let extract_attr = |slice: &str, attr: &str| -> Option<String> {
        let needle = format!("{}=\"", attr);
        let start = slice.find(&needle)? + needle.len();
        let end = slice[start..].find('"')? + start;
        let val = slice[start..end].trim().to_string();
        if val.is_empty() { None } else { Some(val) }
    };

    let mut drain_rates: Vec<f64> = Vec::new();
    let mut cursor = xml;

    while let Some(pos) = cursor.find("<ScenarioInstance") {
        let after = &cursor[pos..];
        let tag_end = match after.find('>') {
            Some(i) => i,
            None => break,
        };
        let tag_slice = &after[..=tag_end];
        let scenario_type = extract_attr(tag_slice, "ScenarioType")
            .or_else(|| extract_attr(tag_slice, "Type"))
            .unwrap_or_default()
            .to_lowercase();
        let is_sleep_session = scenario_type.contains("sleep")
            || scenario_type.contains("standby")
            || scenario_type.contains("cs")
            || scenario_type == "2";

        if is_sleep_session {
            // Duration in seconds (or ticks) + Entry/Exit Battery Remaining Capacity or Percent
            let dur_s = extract_attr(tag_slice, "Duration")
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            // Windows SleepStudy XML sometimes stores Duration in 100ns ticks or seconds
            let dur_secs = if dur_s > 1_000_000.0 {
                dur_s / 10_000_000.0
            } else {
                dur_s
            };

            let entry_pct = extract_attr(tag_slice, "EntryBatteryPercent")
                .and_then(|s| s.parse::<f64>().ok());
            let exit_pct = extract_attr(tag_slice, "ExitBatteryPercent")
                .and_then(|s| s.parse::<f64>().ok());
            let drain_pct = match (entry_pct, exit_pct) {
                (Some(a), Some(b)) if a >= b => Some(a - b),
                _ => {
                    let entry_mwh = extract_attr(tag_slice, "EntryBatteryRemainingCapacity")
                        .and_then(|s| s.parse::<f64>().ok());
                    let exit_mwh = extract_attr(tag_slice, "ExitBatteryRemainingCapacity")
                        .and_then(|s| s.parse::<f64>().ok());
                    let full_mwh = extract_attr(tag_slice, "EntryBatteryFullChargeCapacity")
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|&f| f > 0.0);
                    match (entry_mwh, exit_mwh, full_mwh) {
                        (Some(a), Some(b), Some(f)) if a >= b => Some(((a - b) / f) * 100.0),
                        _ => None,
                    }
                }
            };

            if dur_secs >= 900.0 {
                if let Some(dp) = drain_pct {
                    let hrs = dur_secs / 3600.0;
                    let rate = (dp / hrs).clamp(0.0, 100.0);
                    drain_rates.push(rate);
                }
            }
        }
        cursor = &after[tag_end + 1..];
    }

    if drain_rates.is_empty() {
        return (0, None, None);
    }
    let count = drain_rates.len() as u32;
    let avg = (drain_rates.iter().sum::<f64>() / count as f64 * 10.0).round() / 10.0;
    let max = (drain_rates.iter().copied().fold(0.0f64, f64::max) * 10.0).round() / 10.0;
    (count, Some(avg), Some(max))
}

/// Parses macOS `pmset -g log` snippet for DarkWake counts and sleep/wake failure events.
#[allow(dead_code)]
pub fn parse_macos_pmset_log(out: &str) -> (u32, u32) {
    let mut dark_wakes = 0u32;
    let mut wake_failures = 0u32;
    for line in out.lines() {
        let low = line.to_lowercase();
        if low.contains("darkwake") {
            dark_wakes = dark_wakes.saturating_add(1);
        }
        if low.contains("sleep wake failure")
            || low.contains("kernel panic")
            || low.contains("thermal sleep")
            || low.contains("watchdog")
        {
            wake_failures = wake_failures.saturating_add(1);
        }
    }
    (dark_wakes, wake_failures)
}

/// Pure Smart-Bench classifier for Sleep & Modern Standby reliability.
pub fn classify_sleep_standby_audit(
    platform: &str,
    sleep_mode: String,
    wake_armed_devices: Vec<String>,
    sessions_analyzed: u32,
    avg_drain_pct_per_hr: Option<f64>,
    max_drain_pct_per_hr: Option<f64>,
    sleep_crash_count: u32,
    dark_wake_count: u32,
) -> SleepStandbyReport {
    let worst_drain = max_drain_pct_per_hr.or(avg_drain_pct_per_hr).unwrap_or(0.0);

    let (status, verdict, plain_summary) = if sleep_crash_count >= 2 || worst_drain > 12.0 {
        let mut reasons = Vec::new();
        if sleep_crash_count >= 2 {
            reasons.push(format!("{} sleep/wake crash event(s)", sleep_crash_count));
        }
        if worst_drain > 12.0 {
            reasons.push(format!("severe standby battery drain ({:.1}%/hr)", worst_drain));
        }
        (
            TestStatus::Fail,
            "SLEEP_FAULT".to_string(),
            format!(
                "FAIL: Unstable sleep/standby on {} ({}) — inspect NVMe/Wi-Fi/dGPU power drivers or BIOS sleep settings.",
                sleep_mode,
                reasons.join(", ")
            ),
        )
    } else if sleep_crash_count == 1
        || worst_drain > 5.0
        || wake_armed_devices.len() >= 5
        || dark_wake_count >= 15
    {
        let mut reasons = Vec::new();
        if sleep_crash_count == 1 {
            reasons.push("1 recent sleep/wake crash".to_string());
        }
        if worst_drain > 5.0 {
            reasons.push(format!("elevated standby drain ({:.1}%/hr)", worst_drain));
        }
        if wake_armed_devices.len() >= 5 {
            reasons.push(format!("{} wake-armed devices", wake_armed_devices.len()));
        }
        if dark_wake_count >= 15 {
            reasons.push(format!("{} DarkWake events", dark_wake_count));
        }
        (
            TestStatus::Warn,
            "HIGH_STANDBY_DRAIN".to_string(),
            format!(
                "WARN ({}): {} — check background wake sources or Modern Standby power settings.",
                sleep_mode,
                reasons.join("; ")
            ),
        )
    } else {
        let drain_txt = match avg_drain_pct_per_hr {
            Some(d) => format!(" ({:.1}%/hr avg drain across {} session(s))", d, sessions_analyzed),
            None => " (no abnormal drain sessions recorded)".to_string(),
        };
        (
            TestStatus::Pass,
            "HEALTHY".to_string(),
            format!(
                "PASS: {} healthy{}, {} wake-armed device(s), 0 sleep crashes.",
                sleep_mode,
                drain_txt,
                wake_armed_devices.len()
            ),
        )
    };

    SleepStandbyReport {
        status,
        verdict,
        platform: platform.to_string(),
        sleep_mode,
        wake_armed_devices,
        sessions_analyzed,
        avg_drain_pct_per_hr,
        max_drain_pct_per_hr,
        sleep_crash_count,
        dark_wake_count,
        plain_summary,
    }
}

pub fn run_sleep_standby_audit() -> SleepStandbyReport {
    #[cfg(target_os = "windows")]
    {
        use crate::cmd_util::{run_cmd_stdout, run_powershell};

        let mode_out = run_cmd_stdout("powercfg", &["/a"]).unwrap_or_default();
        let sleep_mode = parse_windows_powercfg_a(&mode_out);

        let wake_out = run_cmd_stdout("powercfg", &["/devicequery", "wake_armed"]).unwrap_or_default();
        let wake_armed = parse_windows_wake_armed(&wake_out);

        let xml_path = std::env::temp_dir().join(format!(
            "laptopbench_sleepstudy_{}.xml",
            std::process::id()
        ));
        let xml_str = xml_path.to_string_lossy().to_string();
        let _ = run_cmd_stdout("powercfg", &["/sleepstudy", "/xml", "/output", &xml_str]);
        let (sessions, avg_drain, max_drain) = if let Ok(content) = std::fs::read_to_string(&xml_path) {
            let _ = std::fs::remove_file(&xml_path);
            parse_windows_sleepstudy_xml(&content)
        } else {
            (0, None, None)
        };

        // Check System event log for Sleep/Wake failures (Kernel-Power 41 right after Sleep, or Event 506/507 crashes)
        let ps = "(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=109,507; Level=1,2; StartTime=(Get-Date).AddDays(-14)} -ErrorAction SilentlyContinue | Measure-Object).Count";
        let sleep_crashes = run_powershell(ps)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);

        classify_sleep_standby_audit(
            "Windows",
            sleep_mode,
            wake_armed,
            sessions,
            avg_drain,
            max_drain,
            sleep_crashes,
            0,
        )
    }

    #[cfg(target_os = "macos")]
    {
        use crate::cmd_util::run_cmd_stdout;
        let pm_log = run_cmd_stdout("pmset", &["-g", "log"]).unwrap_or_default();
        let tail: String = pm_log
            .lines()
            .rev()
            .take(160)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let (dark_wakes, wake_failures) = parse_macos_pmset_log(&tail);
        classify_sleep_standby_audit(
            "macOS",
            "macOS Standby / Power Nap".to_string(),
            vec![],
            0,
            None,
            None,
            wake_failures,
            dark_wakes,
        )
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        classify_sleep_standby_audit("Other", "Unknown".into(), vec![], 0, None, None, 0, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_windows_powercfg_a_and_wake_armed() {
        let s0 = "The following sleep states are available on this system:\n    Standby (S0 Low Power Idle) Network Connected\n    Hibernate\n";
        assert_eq!(parse_windows_powercfg_a(s0), "Modern Standby (S0ix)");

        let s3 = "The following sleep states are available on this system:\n    Standby (S3)\n";
        assert_eq!(parse_windows_powercfg_a(s3), "Classic S3 Sleep");

        let wakes = parse_windows_wake_armed("HID Keyboard Device\nRealtek PCIe GbE\n");
        assert_eq!(wakes.len(), 2);
        assert!(parse_windows_wake_armed("NONE\n").is_empty());
    }

    #[test]
    fn test_parse_sleepstudy_xml_and_classify_drain() {
        let xml = r#"<SleepStudy>
            <ScenarioInstance ScenarioType="2" Duration="7200" EntryBatteryPercent="90" ExitBatteryPercent="74" />
            <ScenarioInstance ScenarioType="2" Duration="3600" EntryBatteryPercent="70" ExitBatteryPercent="68" />
        </SleepStudy>"#;
        let (n, avg, max) = parse_windows_sleepstudy_xml(xml);
        assert_eq!(n, 2);
        assert_eq!(max, Some(8.0));
        assert_eq!(avg, Some(5.0));

        // 8%/hr drain -> WARN HIGH_STANDBY_DRAIN
        let rep_warn = classify_sleep_standby_audit(
            "Windows",
            "Modern Standby (S0ix)".into(),
            vec!["HID Keyboard".into()],
            n,
            avg,
            max,
            0,
            0,
        );
        assert_eq!(rep_warn.status, TestStatus::Warn);
        assert_eq!(rep_warn.verdict, "HIGH_STANDBY_DRAIN");

        // 15%/hr drain -> FAIL SLEEP_FAULT
        let rep_fail = classify_sleep_standby_audit(
            "Windows",
            "Modern Standby (S0ix)".into(),
            vec![],
            1,
            Some(15.0),
            Some(15.0),
            0,
            0,
        );
        assert_eq!(rep_fail.status, TestStatus::Fail);
        assert_eq!(rep_fail.verdict, "SLEEP_FAULT");

        // Healthy 0.8%/hr drain -> PASS HEALTHY
        let rep_ok = classify_sleep_standby_audit(
            "Windows",
            "Modern Standby (S0ix)".into(),
            vec!["HID Keyboard".into()],
            2,
            Some(0.8),
            Some(1.1),
            0,
            0,
        );
        assert_eq!(rep_ok.status, TestStatus::Pass);
        assert_eq!(rep_ok.verdict, "HEALTHY");
    }
}
