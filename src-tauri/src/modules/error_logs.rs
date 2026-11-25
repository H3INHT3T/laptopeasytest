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
        }
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
$events = @(Get-WinEvent -FilterHashtable @{{ LogName=@('System','Application'); Level=@(1,2); StartTime=$since }} -MaxEvents 120 -ErrorAction SilentlyContinue | ForEach-Object {{
    $msg = if ($_.Message) {{ ($_.Message -replace '\r?\n', ' ').Trim() }} else {{ '' }}
    if ($msg.Length -gt 240) {{ $msg = $msg.Substring(0, 240) + '...' }}
    @{{
        ts = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
        source = [string]$_.ProviderName
        level = if ($_.Level -eq 1) {{ 'Critical' }} else {{ 'Error' }}
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

    if let Ok(raw) = run_powershell(&script) {
        if !raw.is_empty() {
            let parsed: Result<Vec<Value>, _> = serde_json::from_str(&raw).or_else(|_| {
                serde_json::from_str::<Value>(&raw).map(|single| vec![single])
            });
            if let Ok(arr) = parsed {
                for ev in arr {
                    let source = ev["source"].as_str().unwrap_or("System").to_string();
                    let level = ev["level"].as_str().unwrap_or("Error").to_string();
                    let event_id = ev["id"].as_u64().map(|x| x as u32);
                    let message = ev["msg"].as_str().unwrap_or("").to_string();
                    let src_l = source.to_lowercase();
                    let msg_l = message.to_lowercase();

                    if level == "Critical" {
                        critical_count += 1;
                    } else {
                        error_count += 1;
                    }

                    let category = if src_l.contains("bugcheck")
                        || (src_l.contains("kernel-power") && event_id == Some(41))
                        || msg_l.contains("bugcheck")
                    {
                        bsod_count += 1;
                        "BSOD / Unexpected Shutdown"
                    } else if src_l.contains("whea") {
                        whea_count += 1;
                        "Hardware (WHEA)"
                    } else if src_l.contains("disk")
                        || src_l.contains("stornvme")
                        || src_l.contains("ntfs")
                        || src_l.contains("iaStor".to_lowercase().as_str())
                    {
                        disk_count += 1;
                        "Storage / Disk I/O"
                    } else if src_l.contains("display")
                        || src_l.contains("nvlddmkm")
                        || src_l.contains("amdkmdag")
                        || src_l.contains("dxgkrnl")
                    {
                        gpu_count += 1;
                        "GPU / Display Driver"
                    } else {
                        "System / App"
                    }
                    .to_string();

                    entries.push(ErrorLogEntry {
                        timestamp: ev["ts"].as_str().unwrap_or("").to_string(),
                        source,
                        level,
                        event_id,
                        category,
                        message,
                    });
                }
            }
        }
    }

    let status = if whea_count > 0 || disk_count > 2 || bsod_count > 1 {
        TestStatus::Fail
    } else if critical_count > 0 || bsod_count > 0 || disk_count > 0 || gpu_count > 0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if status == TestStatus::Fail {
        format!(
            "Hardware/crash alerts found in last {}d: {} BSOD/Power-41, {} WHEA hardware, {} Disk I/O, {} GPU resets.",
            days, bsod_count, whea_count, disk_count, gpu_count
        )
    } else if status == TestStatus::Warn {
        format!(
            "{} critical / {} error entries in last {}d ({} BSOD/Power, {} Disk, {} GPU). Review details.",
            critical_count, error_count, days, bsod_count, disk_count, gpu_count
        )
    } else {
        format!(
            "Clean logs over last {}d — 0 BSODs, 0 WHEA hardware errors, 0 disk errors ({} minor app errors).",
            days, error_count
        )
    };

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
    }
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
            "eventMessage CONTAINS[c] 'disk0: I/O error' OR eventMessage CONTAINS[c] 'NVMe' AND messageType == 'fault' OR eventMessage CONTAINS[c] 'GPU Restart'",
            "--style",
            "compact",
        ],
    ) {
        for line in out.lines().skip(1).take(60) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let low = trimmed.to_lowercase();
            let category = if low.contains("disk") || low.contains("nvme") {
                disk_count += 1;
                "Storage / NVMe"
            } else if low.contains("gpu") {
                gpu_count += 1;
                "GPU / Display"
            } else {
                hw_count += 1;
                "Hardware Fault"
            };
            entries.push(ErrorLogEntry {
                timestamp: trimmed.chars().take(19).collect(),
                source: "Unified Log".to_string(),
                level: "Error".to_string(),
                event_id: None,
                category: category.to_string(),
                message: trimmed.chars().take(220).collect(),
            });
        }
    }

    let critical_count = panic_count;
    let error_count = entries.len().saturating_sub(critical_count);
    let status = if panic_count > 0 || disk_count > 1 || hw_count > 2 {
        TestStatus::Fail
    } else if gpu_count > 0 || disk_count > 0 || hw_count > 0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if panic_count > 0 {
        format!(
            "ALERT: {} Kernel Panic report(s) found in DiagnosticReports! Check logic board/RAM/SSD.",
            panic_count
        )
    } else if status == TestStatus::Warn {
        format!(
            "No kernel panics; {} GPU/Disk/HW log warnings found over last {}d.",
            gpu_count + disk_count + hw_count,
            days
        )
    } else {
        format!("Clean macOS logs — 0 Kernel Panics and 0 hardware faults found.")
    };

    ErrorLogsReport {
        status,
        days_scanned: days,
        critical_count,
        error_count,
        bsod_or_panic_count: panic_count,
        whea_or_hw_count: hw_count,
        disk_error_count: disk_count,
        gpu_reset_count: gpu_count,
        minidump_files: panic_files,
        entries,
        summary,
    }
}
