use crate::types::{
    DriveSmartInfo, StorageBenchProgress, StorageBenchResult, StorageSmartReport, TestStatus,
};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

pub fn scan_storage_smart() -> StorageSmartReport {
    #[cfg(target_os = "windows")]
    {
        scan_windows_smart()
    }
    #[cfg(target_os = "macos")]
    {
        scan_macos_smart()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        StorageSmartReport {
            status: TestStatus::NotApplicable,
            drives: Vec::new(),
            summary: "SMART storage scan not implemented on this platform.".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_windows_smart() -> StorageSmartReport {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$disks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
    @{
        deviceId = [string]$_.DeviceId
        model = [string]$_.FriendlyName
        serial = [string]$_.SerialNumber
        bus = [string]$_.BusType
        media = [string]$_.MediaType
        size = [double]$_.Size
        health = [string]$_.HealthStatus
        wear = if ($rel -and $null -ne $rel.Wear) { [int]$rel.Wear } else { $null }
        temp = if ($rel -and $null -ne $rel.Temperature) { [int]$rel.Temperature } else { $null }
        poh = if ($rel -and $null -ne $rel.PowerOnHours) { [uint64]$rel.PowerOnHours } else { $null }
        readErr = if ($rel -and $null -ne $rel.ReadErrorsTotal) { [uint64]$rel.ReadErrorsTotal } else { $null }
        readUncorr = if ($rel -and $null -ne $rel.ReadErrorsUncorrected) { [uint64]$rel.ReadErrorsUncorrected } else { $null }
        writeErr = if ($rel -and $null -ne $rel.WriteErrorsTotal) { [uint64]$rel.WriteErrorsTotal } else { $null }
    }
})
$smartFail = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction SilentlyContinue | ForEach-Object {
    @{ name = $_.InstanceName; predictFail = [bool]$_.PredictFailure }
})
@{ disks = $disks; smartFail = $smartFail } | ConvertTo-Json -Depth 4 -Compress
"#;

    let mut drives = Vec::new();
    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            let predict_any_fail = v["smartFail"]
                .as_array()
                .map(|arr| arr.iter().any(|x| x["predictFail"].as_bool().unwrap_or(false)))
                .unwrap_or(false);

            if let Some(arr) = v["disks"].as_array() {
                for d in arr {
                    let model = d["model"].as_str().unwrap_or("Disk").trim().to_string();
                    let health_str = d["health"].as_str().unwrap_or("Unknown").to_string();
                    let wear = d["wear"].as_u64().map(|w| w.min(100) as u32);
                    let health_pct = wear.map(|w| 100u32.saturating_sub(w));
                    let temp = d["temp"].as_i64().filter(|&t| t > 0 && t < 130).map(|t| t as i32);
                    let poh = d["poh"].as_u64();
                    let read_err = d["readErr"].as_u64();
                    let read_uncorr = d["readUncorr"].as_u64();
                    let write_err = d["writeErr"].as_u64();
                    let media_errors = read_uncorr;

                    let status = if predict_any_fail
                        || health_str.eq_ignore_ascii_case("Unhealthy")
                        || media_errors.unwrap_or(0) > 0
                        || health_pct.map(|h| h < 50).unwrap_or(false)
                    {
                        TestStatus::Fail
                    } else if health_str.eq_ignore_ascii_case("Warning")
                        || health_pct.map(|h| h < 80).unwrap_or(false)
                        || temp.map(|t| t >= 70).unwrap_or(false)
                    {
                        TestStatus::Warn
                    } else {
                        TestStatus::Pass
                    };

                    let notes = if status == TestStatus::Fail {
                        "Drive reported unhealthy SMART status, media errors, or critical wear."
                            .to_string()
                    } else if wear.is_none() && poh.is_none() {
                        "Basic health OK (run as Administrator for full NVMe/SATA reliability counters)."
                            .to_string()
                    } else {
                        format!(
                            "SMART OK — {}% health remaining{}",
                            health_pct.map(|h| h.to_string()).unwrap_or_else(|| "N/A".into()),
                            temp.map(|t| format!(", {}°C", t)).unwrap_or_default()
                        )
                    };

                    drives.push(DriveSmartInfo {
                        device_id: d["deviceId"].as_str().unwrap_or("0").to_string(),
                        model,
                        serial_number: d["serial"].as_str().unwrap_or("").trim().to_string(),
                        interface_type: d["bus"].as_str().unwrap_or("NVMe/SATA").to_string(),
                        media_type: d["media"].as_str().unwrap_or("SSD").to_string(),
                        size_gb: ((d["size"].as_f64().unwrap_or(0.0) / 1_000_000_000.0) * 10.0)
                            .round()
                            / 10.0,
                        health_status: health_str,
                        status,
                        health_percent: health_pct,
                        wear_percent: wear,
                        temperature_c: temp,
                        power_on_hours: poh,
                        power_cycles: None,
                        unsafe_shutdowns: None,
                        media_errors,
                        read_errors: read_err,
                        write_errors: write_err,
                        tbw_gb: None,
                        available_spare_pct: None,
                        notes,
                    });
                }
            }
        }
    }

    let overall = if drives.iter().any(|d| d.status == TestStatus::Fail) {
        TestStatus::Fail
    } else if drives.is_empty() || drives.iter().any(|d| d.status == TestStatus::Warn) {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if drives.is_empty() {
        "Could not enumerate physical disks (ensure Administrator privileges).".to_string()
    } else {
        format!(
            "{} physical drive(s) scanned — {} Healthy.",
            drives.len(),
            drives.iter().filter(|d| d.status == TestStatus::Pass).count()
        )
    };

    StorageSmartReport {
        status: overall,
        drives,
        summary,
    }
}

#[cfg(target_os = "macos")]
fn scan_macos_smart() -> StorageSmartReport {
    use crate::cmd_util::run_cmd_stdout;
    use serde_json::Value;

    let mut drives = Vec::new();

    // 1. Enumerate NVMe drives via system_profiler
    if let Ok(raw) = run_cmd_stdout("system_profiler", &["-json", "SPNVMeDataType"]) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(ctrls) = v["SPNVMeDataType"].as_array() {
                for ctrl in ctrls {
                    if let Some(items) = ctrl["_items"].as_array() {
                        for d in items {
                            let model = d["device_model"]
                                .as_str()
                                .or_else(|| d["_name"].as_str())
                                .unwrap_or("Apple NVMe SSD")
                                .trim()
                                .to_string();
                            let bsd = d["bsd_name"].as_str().unwrap_or("disk0").to_string();
                            let smart_status = d["smart_status"]
                                .as_str()
                                .unwrap_or("Verified")
                                .to_string();
                            let size_gb = ((d["size_in_bytes"].as_f64().unwrap_or(0.0)
                                / 1_000_000_000.0)
                                * 10.0)
                                .round()
                                / 10.0;

                            let mut wear: Option<u32> = None;
                            let mut temp: Option<i32> = None;
                            let mut poh: Option<u64> = None;
                            let mut cycles: Option<u64> = None;
                            let mut unsafe_sd: Option<u64> = None;
                            let mut media_err: Option<u64> = None;
                            let mut tbw_gb: Option<f64> = None;
                            let mut spare: Option<u32> = None;

                            // Enrich with smartctl if available on Mac, otherwise parse ioreg NVMe SMART
                            if let Ok(sc) = run_cmd_stdout("smartctl", &["-j", "-a", &format!("/dev/{}", bsd)]) {
                                if let Ok(sv) = serde_json::from_str::<Value>(&sc) {
                                    let log = &sv["nvme_smart_health_information_log"];
                                    wear = log["percentage_used"].as_u64().map(|x| x.min(100) as u32);
                                    temp = log["temperature"].as_i64().map(|x| x as i32);
                                    poh = log["power_on_hours"].as_u64();
                                    cycles = log["power_cycles"].as_u64();
                                    unsafe_sd = log["unsafe_shutdowns"].as_u64();
                                    media_err = log["media_errors"].as_u64();
                                    spare = log["available_spare"].as_u64().map(|x| x as u32);
                                    if let Some(duw) = log["data_units_written"].as_u64() {
                                        // 1 NVMe data unit = 512,000 bytes
                                        tbw_gb = Some(((duw as f64 * 512_000.0) / 1e9 * 10.0).round() / 10.0);
                                    }
                                }
                            }

                            let health_pct = wear.map(|w| 100u32.saturating_sub(w));
                            let status = if smart_status.to_lowercase().contains("fail")
                                || media_err.unwrap_or(0) > 0
                                || health_pct.map(|h| h < 50).unwrap_or(false)
                            {
                                TestStatus::Fail
                            } else if health_pct.map(|h| h < 80).unwrap_or(false)
                                || spare.map(|s| s < 20).unwrap_or(false)
                            {
                                TestStatus::Warn
                            } else {
                                TestStatus::Pass
                            };

                            drives.push(DriveSmartInfo {
                                device_id: bsd,
                                model,
                                serial_number: d["device_serial"].as_str().unwrap_or("").trim().to_string(),
                                interface_type: "NVMe".to_string(),
                                media_type: "SSD".to_string(),
                                size_gb,
                                health_status: smart_status.clone(),
                                status,
                                health_percent: health_pct,
                                wear_percent: wear,
                                temperature_c: temp,
                                power_on_hours: poh,
                                power_cycles: cycles,
                                unsafe_shutdowns: unsafe_sd,
                                media_errors: media_err,
                                read_errors: None,
                                write_errors: None,
                                tbw_gb,
                                available_spare_pct: spare,
                                notes: format!("macOS SMART Status: {}", smart_status),
                            });
                        }
                    }
                }
            }
        }
    }

    let overall = if drives.iter().any(|d| d.status == TestStatus::Fail) {
        TestStatus::Fail
    } else if drives.is_empty() || drives.iter().any(|d| d.status == TestStatus::Warn) {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    StorageSmartReport {
        status: overall,
        summary: format!("{} NVMe/SSD drive(s) scanned on macOS.", drives.len()),
        drives,
    }
}

/// RAII cleanup guard guaranteeing benchmark temp file is ALWAYS removed even on abort/panic.
struct TempFileGuard(PathBuf);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn run_storage_benchmark(
    app: &AppHandle,
    preset: &str,
    cancel: Arc<AtomicBool>,
) -> Result<StorageBenchResult, String> {
    let size_mb: u64 = match preset {
        "standard" => 512,
        "burnin" => 1024,
        _ => 256, // quick
    };
    let rand_ops: usize = match preset {
        "standard" => 4096,
        "burnin" => 8192,
        _ => 2048,
    };

    let tmp_path = std::env::temp_dir().join(format!(
        "laptopbench_qc_ssd_bench_{}.tmp",
        std::process::id()
    ));
    let _guard = TempFileGuard(tmp_path.clone());

    let started = Instant::now();
    let chunk_size = 4 * 1024 * 1024; // 4 MB sequential chunks
    let total_chunks = (size_mb as usize * 1024 * 1024) / chunk_size;

    // Non-compressible pattern buffer so SSD controllers cannot cheat via zero-compression
    let mut write_buf = vec![0u8; chunk_size];
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    for chunk in write_buf.chunks_exact_mut(8) {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        chunk.copy_from_slice(&state.to_le_bytes());
    }

    // 1. Sequential Write
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(true)
        .open(&tmp_path)
        .map_err(|e| format!("Could not create temp benchmark file: {}", e))?;

    let t_sw = Instant::now();
    for i in 0..total_chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage benchmark cancelled.".to_string());
        }
        file.write_all(&write_buf).map_err(|e| e.to_string())?;
        if i % 8 == 0 || i + 1 == total_chunks {
            let mb_done = ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0);
            let mb_s = mb_done / t_sw.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: "Sequential Write".to_string(),
                    percent: ((i + 1) as f64 / total_chunks as f64) * 35.0,
                    current_mb_s: (mb_s * 10.0).round() / 10.0,
                },
            );
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    let sw_secs = t_sw.elapsed().as_secs_f64().max(0.001);
    let seq_write_mb_s = (size_mb as f64 / sw_secs * 10.0).round() / 10.0;

    // 2. Sequential Read
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut read_buf = vec![0u8; chunk_size];
    let t_sr = Instant::now();
    for i in 0..total_chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage benchmark cancelled.".to_string());
        }
        file.read_exact(&mut read_buf).map_err(|e| e.to_string())?;
        if i % 8 == 0 || i + 1 == total_chunks {
            let mb_done = ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0);
            let mb_s = mb_done / t_sr.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: "Sequential Read".to_string(),
                    percent: 35.0 + ((i + 1) as f64 / total_chunks as f64) * 35.0,
                    current_mb_s: (mb_s * 10.0).round() / 10.0,
                },
            );
        }
    }
    let sr_secs = t_sr.elapsed().as_secs_f64().max(0.001);
    let seq_read_mb_s = (size_mb as f64 / sr_secs * 10.0).round() / 10.0;

    // 3. Random 4K Write
    let block_4k = 4096u64;
    let max_blocks = (size_mb * 1024 * 1024) / block_4k;
    let buf_4k = &write_buf[..4096];
    let mut rng: u64 = 0xCAFE_BABE_DEAD_BEEF;
    let t_rw = Instant::now();
    for i in 0..rand_ops {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage benchmark cancelled.".to_string());
        }
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let offset = (rng % max_blocks) * block_4k;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        file.write_all(buf_4k).map_err(|e| e.to_string())?;
        if i % 256 == 0 {
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: "Random 4K Write".to_string(),
                    percent: 70.0 + (i as f64 / rand_ops as f64) * 15.0,
                    current_mb_s: (((i + 1) * 4096) as f64 / (1024.0 * 1024.0))
                        / t_rw.elapsed().as_secs_f64().max(0.001),
                },
            );
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    let rw_secs = t_rw.elapsed().as_secs_f64().max(0.001);
    let rand_4k_write_mb_s =
        (((rand_ops * 4096) as f64 / (1024.0 * 1024.0)) / rw_secs * 10.0).round() / 10.0;
    let rand_4k_write_iops = (rand_ops as f64 / rw_secs).round() as u64;

    // 4. Random 4K Read
    let mut rbuf_4k = [0u8; 4096];
    let t_rr = Instant::now();
    for i in 0..rand_ops {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage benchmark cancelled.".to_string());
        }
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let offset = (rng % max_blocks) * block_4k;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        file.read_exact(&mut rbuf_4k).map_err(|e| e.to_string())?;
        if i % 256 == 0 {
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: "Random 4K Read".to_string(),
                    percent: 85.0 + (i as f64 / rand_ops as f64) * 15.0,
                    current_mb_s: (((i + 1) * 4096) as f64 / (1024.0 * 1024.0))
                        / t_rr.elapsed().as_secs_f64().max(0.001),
                },
            );
        }
    }
    let rr_secs = t_rr.elapsed().as_secs_f64().max(0.001);
    let rand_4k_read_mb_s =
        (((rand_ops * 4096) as f64 / (1024.0 * 1024.0)) / rr_secs * 10.0).round() / 10.0;
    let rand_4k_read_iops = (rand_ops as f64 / rr_secs).round() as u64;

    drop(file);
    // _guard drops and deletes temp file automatically

    let status = if seq_read_mb_s < 80.0 || seq_write_mb_s < 50.0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    Ok(StorageBenchResult {
        status,
        preset: preset.to_string(),
        test_size_mb: size_mb,
        seq_write_mb_s,
        seq_read_mb_s,
        rand_4k_write_mb_s,
        rand_4k_read_mb_s,
        rand_4k_write_iops,
        rand_4k_read_iops,
        elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        summary: format!(
            "Seq Read {:.0} MB/s | Seq Write {:.0} MB/s | 4K Read {} IOPS",
            seq_read_mb_s, seq_write_mb_s, rand_4k_read_iops
        ),
    })
}
