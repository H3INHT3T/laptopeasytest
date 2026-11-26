use crate::types::{ErrorLogEntry, ErrorLogsReport, TestStatus};

pub fn scan_error_logs(days: u32) -> ErrorLogsReport {
    #[cfg(target_os = "windows")]
    {
        scan_windows_error_logs(days)
    }
    #[cfg(target_os = "macos")]
    {
        scan_macos_error_logs(days)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        ErrorLogsReport {
            status: TestStatus::NotApplicable,
            days_scanned: days,
            critical_count: 0,
            error_count: 0,
            bsod_or_panic_count: 0,
            whea_or_hw_count: 0,
            disk_error_count: 0,
            gpu_reset_count: 0,
            minidump_files: Vec::new(),
            entries: Vec::new(),
            summary: "Error log scanner not supported on this OS.".to_string(),
            thermal_event_count: 0,
            plain_summary: "System event log scanning is supported on Windows and macOS only.".to_string(),
            buyer_interpretation: Vec::new(),
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EventClassFlags {
    pub category: &'static str,
    pub is_bsod: bool,
    pub is_whea: bool,
    pub is_disk: bool,
    pub is_gpu: bool,
    pub is_thermal: bool,
}

#[allow(dead_code)]
pub(crate) fn classify_windows_event(
    source: &str,
    event_id: Option<u32>,
    message: &str,
) -> EventClassFlags {
    let src_l = source.to_lowercase();
    let msg_l = message.to_lowercase();

    if src_l.contains("thermal")
        || (src_l.contains("kernel-power") && matches!(event_id, Some(86 | 87 | 88)))
        || (src_l.contains("acpi")
            && (msg_l.contains("thermal")
                || msg_l.contains("overheat")
                || msg_l.contains("critical temperature")))
        || msg_l.contains("thermal shutdown")
        || msg_l.contains("thermtrip")
    {
        EventClassFlags {
            category: "Thermal / Overheat",
            is_bsod: false,
            is_whea: false,
            is_disk: false,
            is_gpu: false,
            is_thermal: true,
        }
    } else if src_l.contains("bugcheck")
        || (src_l.contains("kernel-power") && event_id == Some(41))
        || msg_l.contains("bugcheck")
    {
        EventClassFlags {
            category: "BSOD / Unexpected Shutdown",
            is_bsod: true,
            is_whea: false,
            is_disk: false,
            is_gpu: false,
            is_thermal: false,
        }
    } else if src_l.contains("whea") {
        EventClassFlags {
            category: "Hardware (WHEA)",
            is_bsod: false,
            is_whea: true,
            is_disk: false,
            is_gpu: false,
            is_thermal: false,
        }
    } else if is_windows_storage_event(&src_l, event_id, &msg_l) {
        EventClassFlags {
            category: "Storage / Disk I/O",
            is_bsod: false,
            is_whea: false,
            is_disk: true,
            is_gpu: false,
            is_thermal: false,
        }
    } else if src_l.contains("display")
        || src_l.contains("nvlddmkm")
        || src_l.contains("amdkmdag")
        || src_l.contains("atikmpag")
        || src_l.contains("igfx")
        || src_l.contains("igdkmd")
        || src_l.contains("dxgkrnl")
        || src_l.contains("livekernelevent")
        || event_id == Some(4101)
        || msg_l.contains("tdr")
    {
        EventClassFlags {
            category: "GPU / Display Driver",
            is_bsod: false,
            is_whea: false,
            is_disk: false,
            is_gpu: true,
            is_thermal: false,
        }
    } else {
        EventClassFlags {
            category: "System / App",
            is_bsod: false,
            is_whea: false,
            is_disk: false,
            is_gpu: false,
            is_thermal: false,
        }
    }
}

fn is_windows_storage_event(src_l: &str, event_id: Option<u32>, msg_l: &str) -> bool {
    let is_storage_source = src_l.contains("disk")
        || src_l.contains("stornvme")
        || src_l.contains("storport")
        || src_l.contains("ntfs")
        || src_l.contains("iastor")
        || src_l.contains("partmgr")
        || src_l.contains("nvme")
        || (src_l.contains("volmgr") && event_id == Some(161));
    if is_storage_source {
        return true;
    }

    let is_app_source = src_l.contains("application error")
        || src_l.contains("application hang")
        || src_l.contains(".net runtime")
        || src_l.contains("windows error reporting");
    if is_app_source {
        return false;
    }

    msg_l.contains("nvme")
        && (msg_l.contains("i/o error")
            || msg_l.contains("io error")
            || msg_l.contains("reset to device")
            || msg_l.contains("bad block")
            || msg_l.contains("timeout")
            || msg_l.contains("timed out")
            || msg_l.contains("controller error")
            || msg_l.contains("media error")
            || msg_l.contains("device error")
            || msg_l.contains("corrupt"))
}

#[allow(dead_code)]
pub(crate) fn is_macos_log_header(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    let low = t.to_lowercase();
    low.starts_with("filtering the log data")
        || low == "timestamp"
        || low.starts_with("timestamp ")
        || low.starts_with("timestamp\t")
}

#[allow(dead_code)]
fn parse_first_signed_i32(s: &str) -> Option<i32> {
    let trimmed = s.trim_start_matches(|c: char| c.is_whitespace() || c == ':' || c == '=');
    let mut buf = String::new();
    for (i, ch) in trimmed.char_indices() {
        if ((ch == '-' || ch == '+') && i == 0) || ch.is_ascii_digit() {
            buf.push(ch);
        } else {
            break;
        }
    }
    if buf.is_empty() || buf == "-" || buf == "+" {
        None
    } else {
        buf.parse::<i32>().ok()
    }
}

#[allow(dead_code)]
pub(crate) fn classify_macos_log_line(line: &str) -> Option<EventClassFlags> {
    if is_macos_log_header(line) {
        return None;
    }
    let low = line.to_lowercase();
    if let Some(pos) = low.find("previous shutdown cause") {
        let after = &low[pos + "previous shutdown cause".len()..];
        return match parse_first_signed_i32(after) {
            Some(-128) => Some(EventClassFlags {
                category: "Thermal / Overheat",
                is_bsod: false,
                is_whea: false,
                is_disk: false,
                is_gpu: false,
                is_thermal: true,
            }),
            Some(c) if c < 0 => Some(EventClassFlags {
                category: "Hardware / Shutdown Fault",
                is_bsod: false,
                is_whea: true,
                is_disk: false,
                is_gpu: false,
                is_thermal: false,
            }),
            _ => None,
        };
    }

    if low.contains("thermal") || low.contains("overheat") {
        Some(EventClassFlags {
            category: "Thermal / Overheat",
            is_bsod: false,
            is_whea: false,
            is_disk: false,
            is_gpu: false,
            is_thermal: true,
        })
    } else if low.contains("disk") || low.contains("nvme") {
        Some(EventClassFlags {
            category: "Storage / NVMe",
            is_bsod: false,
            is_whea: false,
            is_disk: true,
            is_gpu: false,
            is_thermal: false,
        })
    } else if low.contains("gpu") {
        Some(EventClassFlags {
            category: "GPU / Display",
            is_bsod: false,
            is_whea: false,
            is_disk: false,
            is_gpu: true,
            is_thermal: false,
        })
    } else {
        Some(EventClassFlags {
            category: "Hardware Fault",
            is_bsod: false,
            is_whea: true,
            is_disk: false,
            is_gpu: false,
            is_thermal: false,
        })
    }
}

#[allow(dead_code)]
pub(crate) fn parse_macos_unified_log_lines(out: &str) -> Vec<(&str, EventClassFlags)> {
    out.lines()
        .map(str::trim)
        .filter(|l| !is_macos_log_header(l))
        .filter_map(|l| classify_macos_log_line(l).map(|flags| (l, flags)))
        .take(60)
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_error_logs_report(
    days: u32,
    minidump_files: Vec<String>,
    entries: Vec<ErrorLogEntry>,
    critical_count: usize,
    error_count: usize,
    bsod_count: usize,
    whea_count: usize,
    disk_count: usize,
    gpu_count: usize,
    thermal_count: usize,
    is_macos: bool,
) -> ErrorLogsReport {
    let hw_fail = if is_macos {
        whea_count > 2
    } else {
        whea_count > 0
    };
    let hw_warn = is_macos && whea_count > 0;
    let status = if hw_fail || disk_count > 2 || bsod_count > 1 || thermal_count > 0 {
        TestStatus::Fail
    } else if critical_count > 0
        || bsod_count > 0
        || disk_count > 0
        || gpu_count > 0
        || hw_warn
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let mut buyer_interpretation = Vec::new();
    if whea_count > 0 {
        if is_macos {
            buyer_interpretation.push(format!(
                "Hardware / Kernel Faults ({}): macOS Unified Log reported hardware or abnormal shutdown faults — check logic board, storage, or power delivery.",
                whea_count
            ));
        } else {
            buyer_interpretation.push(format!(
                "WHEA Hardware Errors ({}): CPU, RAM, PCIe, or NVMe bus reported hardware-level errors — high risk of motherboard, SSD, or memory instability.",
                whea_count
            ));
        }
    }
    if bsod_count > 0 {
        if is_macos {
            buyer_interpretation.push(format!(
                "Kernel Panics / Watchdog Crashes ({} event(s), {} report(s)): macOS crashed unexpectedly — inspect panic logs for hardware or driver faults.",
                bsod_count,
                minidump_files.len()
            ));
        } else if minidump_files.is_empty() {
            buyer_interpretation.push(format!(
                "Unexpected Shutdowns / Power-41 ({}): Sudden power loss without a crash dump — often caused by failing battery, DC jack, VRM, or thermal cutoff.",
                bsod_count
            ));
        } else {
            buyer_interpretation.push(format!(
                "BSOD / Kernel Crashes ({} events, {} dump file(s)): OS crashed hard — check whether triggered by a bad driver or hardware fault.",
                bsod_count,
                minidump_files.len()
            ));
        }
    }
    if thermal_count > 0 {
        buyer_interpretation.push(format!(
            "Thermal Shutdown / Overheat Events ({}): Laptop hit critical temperature cutoff — inspect cooling fan, vents, and thermal paste.",
            thermal_count
        ));
    }
    if disk_count > 0 {
        buyer_interpretation.push(format!(
            "Storage / Disk I/O Errors ({}): SSD/NVMe controller timeouts or bad blocks logged — cross-check with Drive SMART health.",
            disk_count
        ));
    }
    if gpu_count > 0 {
        buyer_interpretation.push(format!(
            "GPU Driver Resets / TDR ({}): Display driver timed out and recovered — can indicate unstable GPU/VRAM or corrupted driver.",
            gpu_count
        ));
    }
    if buyer_interpretation.is_empty() {
        if is_macos {
            buyer_interpretation.push(format!(
                "Clean history over last {} day(s): No kernel panics, hardware faults, thermal shutdowns, disk I/O errors, or GPU resets recorded.",
                days
            ));
        } else {
            buyer_interpretation.push(format!(
                "Clean history over last {} day(s): No BSODs, WHEA hardware faults, thermal shutdowns, disk I/O timeouts, or GPU TDR resets recorded.",
                days
            ));
        }
    }

    let summary = if status == TestStatus::Fail {
        if is_macos {
            format!(
                "Hardware/crash alerts found in last {}d: {} Kernel Panic, {} Hardware fault, {} Disk I/O, {} GPU resets, {} Thermal.",
                days, bsod_count, whea_count, disk_count, gpu_count, thermal_count
            )
        } else {
            format!(
                "Hardware/crash alerts found in last {}d: {} BSOD/Power-41, {} WHEA hardware, {} Disk I/O, {} GPU resets, {} Thermal.",
                days, bsod_count, whea_count, disk_count, gpu_count, thermal_count
            )
        }
    } else if status == TestStatus::Warn {
        if is_macos {
            format!(
                "{} critical / {} error entries in last {}d ({} Kernel Panic, {} Hardware fault, {} Disk, {} GPU, {} Thermal). Review details.",
                critical_count, error_count, days, bsod_count, whea_count, disk_count, gpu_count, thermal_count
            )
        } else {
            format!(
                "{} critical / {} error entries in last {}d ({} BSOD/Power, {} Disk, {} GPU, {} Thermal). Review details.",
                critical_count, error_count, days, bsod_count, disk_count, gpu_count, thermal_count
            )
        }
    } else if is_macos {
        format!(
            "Clean logs over last {}d — 0 Kernel Panics, 0 hardware faults, 0 disk errors ({} minor log entries).",
            days, error_count
        )
    } else {
        format!(
            "Clean logs over last {}d — 0 BSODs, 0 WHEA hardware errors, 0 disk errors ({} minor app errors).",
            days, error_count
        )
    };

    let plain_summary = buyer_interpretation.join(" ");

    ErrorLogsReport {
        status,
        days_scanned: days,
        critical_count,
        error_count,
        bsod_or_panic_count: bsod_count,
        whea_or_hw_count: whea_count,
        disk_error_count: disk_count,
        gpu_reset_count: gpu_count,
        minidump_files,
        entries,
        summary,
        thermal_event_count: thermal_count,
        plain_summary,
        buyer_interpretation,
    }
}

#[cfg(target_os = "windows")]
fn scan_windows_error_logs(days: u32) -> ErrorLogsReport {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let mut minidump_files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(r"C:\Windows\Minidump") {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_lowercase().ends_with(".dmp") {
                minidump_files.push(name);
            }
        }
    }

    let script = format!(
        r#"
$since = (Get-Date).AddDays(-{days})
$main = @(Get-WinEvent -FilterHashtable @{{ LogName=@('System','Application'); Level=@(1,2); StartTime=$since }} -MaxEvents 120 -ErrorAction SilentlyContinue)
$wheaWarn = @(Get-WinEvent -FilterHashtable @{{ LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Level=@(3); StartTime=$since }} -MaxEvents 40 -ErrorAction SilentlyContinue)
$therm = @(Get-WinEvent -FilterHashtable @{{ LogName='System'; ProviderName=@('Microsoft-Windows-Kernel-Power','ACPI'); Id=@(86,87,88); StartTime=$since }} -MaxEvents 20 -ErrorAction SilentlyContinue)
$all = @($main + $wheaWarn + $therm | Where-Object {{ $_ -ne $null }} | Group-Object {{ "$($_.LogName):$($_.RecordId)" }} | ForEach-Object {{ $_.Group[0] }} | Sort-Object TimeCreated -Descending | Select-Object -First 150)
$events = @($all | ForEach-Object {{
    $msg = if ($_.Message) {{ ($_.Message -replace '\r?\n', ' ').Trim() }} else {{ '' }}
    if ($msg.Length -gt 240) {{ $msg = $msg.Substring(0, 240) + '...' }}
    $lvl = switch ([int]$_.Level) {{ 1 {{ 'Critical' }} 3 {{ 'Warning' }} default {{ 'Error' }} }}
    @{{
        ts = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
        source = [string]$_.ProviderName
        level = $lvl
        id = [int]$_.Id
        msg = $msg
    }}
}})
$events | ConvertTo-Json -Depth 3 -Compress
"#
    );

    let mut entries = Vec::new();
    let mut critical_count = 0usize;
    let mut error_count = 0usize;
    let mut bsod_count = minidump_files.len();
    let mut whea_count = 0usize;
    let mut disk_count = 0usize;
    let mut gpu_count = 0usize;
    let mut thermal_count = 0usize;

    if let Ok(raw) = run_powershell(&script) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && trimmed != "null" {
            let parsed: Result<Vec<Value>, _> = serde_json::from_str(trimmed)
                .or_else(|_| serde_json::from_str::<Value>(trimmed).map(|single| vec![single]));
            if let Ok(arr) = parsed {
                for ev in arr {
                    let source = ev["source"].as_str().unwrap_or("System").to_string();
                    let level = ev["level"].as_str().unwrap_or("Error").to_string();
                    let event_id = ev["id"].as_u64().map(|x| x as u32);
                    let message = ev["msg"].as_str().unwrap_or("").to_string();

                    if level == "Critical" {
                        critical_count += 1;
                    } else if level == "Error" {
                        error_count += 1;
                    }

                    let flags = classify_windows_event(&source, event_id, &message);
                    if flags.is_bsod {
                        bsod_count += 1;
                    }
                    if flags.is_whea {
                        whea_count += 1;
                    }
                    if flags.is_disk {
                        disk_count += 1;
                    }
                    if flags.is_gpu {
                        gpu_count += 1;
                    }
                    if flags.is_thermal {
                        thermal_count += 1;
                    }

                    entries.push(ErrorLogEntry {
                        timestamp: ev["ts"].as_str().unwrap_or("").to_string(),
                        source,
                        level,
                        event_id,
                        category: flags.category.to_string(),
                        message,
                    });
                }
            }
        }
    }

    evaluate_error_logs_report(
        days,
        minidump_files,
        entries,
        critical_count,
        error_count,
        bsod_count,
        whea_count,
        disk_count,
        gpu_count,
        thermal_count,
        false,
    )
}

#[cfg(target_os = "macos")]
fn scan_macos_error_logs(days: u32) -> ErrorLogsReport {
    use crate::cmd_util::run_cmd_stdout;
    use std::path::PathBuf;

    let mut entries = Vec::new();
    let mut panic_files = Vec::new();
    let mut panic_count = 0usize;
    let mut gpu_count = 0usize;
    let mut disk_count = 0usize;
    let mut hw_count = 0usize;
    let mut thermal_count = 0usize;

    let mut dirs_to_scan = vec![PathBuf::from("/Library/Logs/DiagnosticReports")];
    if let Some(home) = dirs::home_dir() {
        dirs_to_scan.push(home.join("Library/Logs/DiagnosticReports"));
    }

    for dir in dirs_to_scan {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let low = name.to_lowercase();
                if low.contains("panic") || low.contains("gpurestart") || low.contains("watchdog") {
                    panic_files.push(name.clone());
                    let cat = if low.contains("gpurestart") {
                        gpu_count += 1;
                        "GPU Reset"
                    } else {
                        panic_count += 1;
                        "Kernel Panic"
                    };
                    entries.push(ErrorLogEntry {
                        timestamp: entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .map(|t| {
                                let dt: chrono::DateTime<chrono::Local> = t.into();
                                dt.format("%Y-%m-%d %H:%M:%S").to_string()
                            })
                            .unwrap_or_default(),
                        source: "DiagnosticReports".to_string(),
                        level: "Critical".to_string(),
                        event_id: None,
                        category: cat.to_string(),
                        message: format!("Diagnostic report file: {}", name),
                    });
                }
            }
        }
    }

    // Query unified log for recent hardware / I/O / thermal faults
    let last_arg = format!("{}d", days.min(7));
    if let Ok(out) = run_cmd_stdout(
        "log",
        &[
            "show",
            "--last",
            &last_arg,
            "--predicate",
            "eventMessage CONTAINS[c] 'disk0: I/O error' OR (eventMessage CONTAINS[c] 'NVMe' AND messageType == 'fault') OR eventMessage CONTAINS[c] 'GPU Restart' OR eventMessage CONTAINS[c] 'thermal' OR eventMessage CONTAINS[c] 'Previous shutdown cause'",
            "--style",
            "compact",
        ],
    ) {
        for (trimmed, flags) in parse_macos_unified_log_lines(&out) {
            if flags.is_disk {
                disk_count += 1;
            }
            if flags.is_gpu {
                gpu_count += 1;
            }
            if flags.is_whea {
                hw_count += 1;
            }
            if flags.is_thermal {
                thermal_count += 1;
            }
            entries.push(ErrorLogEntry {
                timestamp: trimmed.chars().take(19).collect(),
                source: "Unified Log".to_string(),
                level: if flags.is_thermal {
                    "Critical".to_string()
                } else {
                    "Error".to_string()
                },
                event_id: None,
                category: flags.category.to_string(),
                message: trimmed.chars().take(220).collect(),
            });
        }
    }

    let critical_count = panic_count + thermal_count;
    let error_count = entries.len().saturating_sub(critical_count);

    evaluate_error_logs_report(
        days,
        panic_files,
        entries,
        critical_count,
        error_count,
        panic_count,
        hw_count,
        disk_count,
        gpu_count,
        thermal_count,
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_windows_events_expanded_scopes() {
        let whea17 = classify_windows_event(
            "Microsoft-Windows-WHEA-Logger",
            Some(17),
            "A corrected hardware error has occurred. Component: PCI Express Root Port",
        );
        assert!(whea17.is_whea);
        assert_eq!(whea17.category, "Hardware (WHEA)");

        let kp41 = classify_windows_event(
            "Microsoft-Windows-Kernel-Power",
            Some(41),
            "The system has rebooted without cleanly shutting down first.",
        );
        assert!(kp41.is_bsod);

        let therm = classify_windows_event(
            "Microsoft-Windows-Kernel-Power",
            Some(86),
            "The system was shut down due to a critical thermal event.",
        );
        assert!(therm.is_thermal);
        assert_eq!(therm.category, "Thermal / Overheat");

        let igfx = classify_windows_event(
            "Display",
            Some(4101),
            "Display driver igfx stopped responding and has successfully recovered.",
        );
        assert!(igfx.is_gpu);

        let stor = classify_windows_event("volmgr", Some(161), "Dump file creation failed");
        assert!(stor.is_disk);
    }

    #[test]
    fn test_evaluate_error_logs_report_verdicts_and_interpretation() {
        let clean = evaluate_error_logs_report(30, vec![], vec![], 0, 2, 0, 0, 0, 0, 0, false);
        assert_eq!(clean.status, TestStatus::Pass);
        assert_eq!(clean.thermal_event_count, 0);
        assert!(clean.plain_summary.contains("Clean history"));

        let warn_gpu = evaluate_error_logs_report(30, vec![], vec![], 0, 1, 0, 0, 0, 1, 0, false);
        assert_eq!(warn_gpu.status, TestStatus::Warn);
        assert!(warn_gpu.buyer_interpretation.iter().any(|b| b.contains("GPU Driver Resets")));

        let fail_whea_therm =
            evaluate_error_logs_report(30, vec![], vec![], 1, 3, 1, 2, 0, 0, 1, false);
        assert_eq!(fail_whea_therm.status, TestStatus::Fail);
        assert_eq!(fail_whea_therm.thermal_event_count, 1);
        assert!(fail_whea_therm.plain_summary.contains("WHEA Hardware Errors"));
        assert!(fail_whea_therm.plain_summary.contains("Thermal Shutdown"));
    }

    #[test]
    fn test_macos_log_headers_and_shutdown_causes() {
        let log_out = "\
Filtering the log data using \"eventMessage CONTAINS[c] 'Previous shutdown cause'\"
Timestamp                       Ty Process[PID:TID]
2026-11-25 10:00:00.000 Df kernel[0:10] (AppleSMC) Previous shutdown cause: 5
2026-11-25 10:05:00.000 Df kernel[0:10] (AppleSMC) Previous shutdown cause: 3
2026-11-25 10:10:00.000 Df kernel[0:10] (AppleSMC) Previous shutdown cause: 0
";
        let parsed = parse_macos_unified_log_lines(log_out);
        assert!(parsed.is_empty(), "Headers and benign shutdown causes must be ignored: {:?}", parsed);

        assert!(classify_macos_log_line("Timestamp                       Ty Process[PID:TID]").is_none());
        assert!(classify_macos_log_line("Filtering the log data using ...").is_none());
        assert!(classify_macos_log_line("2026-11-25 10:00:00 Df kernel: Previous shutdown cause: 5").is_none());

        let thermal = classify_macos_log_line("2026-11-25 10:15:00 Df kernel: Previous shutdown cause: -128")
            .expect("-128 must be classified");
        assert!(thermal.is_thermal);
        assert!(!thermal.is_whea);

        let neg_fault = classify_macos_log_line("2026-11-25 10:20:00 Df kernel: Previous shutdown cause: -60")
            .expect("-60 fault must be classified");
        assert!(neg_fault.is_whea);
        assert!(!neg_fault.is_thermal);

        let mac_warn = evaluate_error_logs_report(7, vec![], vec![], 0, 1, 0, 1, 0, 0, 0, true);
        assert_eq!(mac_warn.status, TestStatus::Warn);
        assert!(!mac_warn.plain_summary.contains("WHEA"));
        assert!(mac_warn.plain_summary.contains("Hardware / Kernel Faults"));

        let mac_fail = evaluate_error_logs_report(7, vec![], vec![], 0, 3, 0, 3, 0, 0, 0, true);
        assert_eq!(mac_fail.status, TestStatus::Fail);
        assert!(!mac_fail.summary.contains("WHEA"));
    }

    #[test]
    fn test_windows_app_error_nvme_path_not_flagged_as_disk() {
        let app_err = classify_windows_event(
            "Application Error",
            Some(1000),
            "Faulting application name: app.exe, Faulting application path: C:\\nvme_viewer\\app.exe",
        );
        assert!(!app_err.is_disk);
        assert_eq!(app_err.category, "System / App");

        let real_nvme = classify_windows_event(
            "stornvme",
            Some(129),
            "Reset to device, \\Device\\RaidPort0, was issued.",
        );
        assert!(real_nvme.is_disk);
        assert_eq!(real_nvme.category, "Storage / Disk I/O");

        let kernel_nvme = classify_windows_event(
            "Microsoft-Windows-Kernel-PnP",
            Some(219),
            "NVMe controller error / I/O error reported on bus.",
        );
        assert!(kernel_nvme.is_disk);
    }
}
