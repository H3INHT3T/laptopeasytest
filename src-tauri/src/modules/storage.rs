use crate::modules::baselines;
use crate::types::{
    DriveSmartInfo, StorageBenchProgress, StorageBenchResult, StorageSmartReport, TestStatus,
};
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::fs::{self, File, OpenOptions};
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
                            let smart_status = d["smart_status"].as_str().unwrap_or("Verified").to_string();
                            let size_gb = ((d["size_in_bytes"].as_f64().unwrap_or(0.0) / 1_000_000_000.0) * 10.0).round() / 10.0;

                            let mut wear: Option<u32> = None;
                            let mut temp: Option<i32> = None;
                            let mut poh: Option<u64> = None;
                            let mut cycles: Option<u64> = None;
                            let mut unsafe_sd: Option<u64> = None;
                            let mut media_err: Option<u64> = None;
                            let mut tbw_gb: Option<f64> = None;
                            let mut spare: Option<u32> = None;

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

/// 4096-byte page-aligned buffer required for Windows FILE_FLAG_NO_BUFFERING true Direct I/O.
struct AlignedBuffer {
    ptr: *mut u8,
    layout: Layout,
}

impl AlignedBuffer {
    fn new(size: usize) -> Self {
        let layout = Layout::from_size_align(size, 4096).expect("valid 4K aligned layout");
        let ptr = unsafe { alloc_zeroed(layout) };
        if ptr.is_null() {
            panic!("Failed to allocate 4K-aligned storage benchmark buffer");
        }
        Self { ptr, layout }
    }

    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.layout.size()) }
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.layout.size()) }
    }
}

impl Drop for AlignedBuffer {
    fn drop(&mut self) {
        unsafe { dealloc(self.ptr, self.layout) };
    }
}

struct TempFileGuard(PathBuf);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn open_direct_bench_file(path: &PathBuf) -> Result<(File, bool), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_NO_BUFFERING (0x20000000) | FILE_FLAG_WRITE_THROUGH (0x80000000)
        // Bypasses Windows RAM page cache so we measure REAL SSD NAND flash speed!
        if let Ok(f) = OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .truncate(true)
            .custom_flags(0x2000_0000 | 0x8000_0000)
            .open(path)
        {
            return Ok((f, true));
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("Could not create temp benchmark file: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        // Bypass macOS Unified Buffer Cache via F_NOCACHE (48)
        use std::os::unix::io::AsRawFd;
        extern "C" {
            fn fcntl(fd: i32, cmd: i32, ...) -> i32;
        }
        const F_NOCACHE: i32 = 48;
        let rc = unsafe { fcntl(file.as_raw_fd(), F_NOCACHE, 1) };
        return Ok((file, rc != -1));
    }

    #[cfg(not(target_os = "macos"))]
    Ok((file, false))
}

fn fill_block_pattern(buf: &mut [u8], block_idx: u64) {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15 ^ block_idx.wrapping_mul(0xD1B5_4A32_D192_ED03);
    for chunk in buf.chunks_exact_mut(8) {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        chunk.copy_from_slice(&state.to_le_bytes());
    }
}

pub fn run_storage_benchmark(
    app: &AppHandle,
    preset: &str,
    interface_hint: Option<String>,
    media_hint: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<StorageBenchResult, String> {
    // True second-hand shop durability sizes (bypassing RAM cache!)
    let (size_mb, rand_ops): (u64, usize) = match preset {
        "standard" => (2048, 8192), // 2 GB sustained + 8K random ops
        "burnin" => (4096, 16384),  // 4 GB sustained SLC-exhaustion + 16K random ops
        _ => (1024, 4096),          // 1 GB real Direct-IO Quick Shop QC
    };

    let tmp_path = std::env::temp_dir().join(format!(
        "laptopbench_qc_ssd_durability_{}.tmp",
        std::process::id()
    ));
    let _guard = TempFileGuard(tmp_path.clone());

    let (mut file, direct_io) = open_direct_bench_file(&tmp_path)?;
    let started = Instant::now();
    let chunk_size = 4 * 1024 * 1024; // 4 MB aligned chunks
    let total_chunks = (size_mb as usize * 1024 * 1024) / chunk_size;

    let mut write_buf = AlignedBuffer::new(chunk_size);
    let mut read_buf = AlignedBuffer::new(chunk_size);
    let mut integrity_errors: u64 = 0;

    // Phase 1: Sustained Direct-IO Sequential Write (with unique deterministic block patterns)
    let t_sw = Instant::now();
    let mut last_emit = Instant::now();
    let mut win_bytes = 0usize;
    for i in 0..total_chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage durability test cancelled.".to_string());
        }
        fill_block_pattern(write_buf.as_mut_slice(), i as u64);
        file.write_all(write_buf.as_slice()).map_err(|e| e.to_string())?;
        win_bytes += chunk_size;

        if last_emit.elapsed().as_millis() >= 220 || i + 1 == total_chunks {
            let win_mb_s = (win_bytes as f64 / (1024.0 * 1024.0))
                / last_emit.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: format!(
                        "1/4 Sustained Direct Write ({:.0}/{} MB)",
                        ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0),
                        size_mb
                    ),
                    percent: ((i + 1) as f64 / total_chunks as f64) * 32.0,
                    current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    integrity_errors,
                },
            );
            win_bytes = 0;
            last_emit = Instant::now();
        }
    }
    if !direct_io {
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let sw_secs = t_sw.elapsed().as_secs_f64().max(0.001);
    let seq_write_mb_s = (size_mb as f64 / sw_secs * 10.0).round() / 10.0;

    // Phase 2: Sustained Direct-IO Sequential Read + Full Byte-for-Byte NAND Integrity Verify
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let t_sr = Instant::now();
    last_emit = Instant::now();
    win_bytes = 0;
    for i in 0..total_chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage durability test cancelled.".to_string());
        }
        file.read_exact(read_buf.as_mut_slice()).map_err(|e| e.to_string())?;
        // Verify deterministic pattern against written block to catch silent NAND corruption!
        fill_block_pattern(write_buf.as_mut_slice(), i as u64);
        if read_buf.as_slice() != write_buf.as_slice() {
            integrity_errors += 1;
        }
        win_bytes += chunk_size;

        if last_emit.elapsed().as_millis() >= 220 || i + 1 == total_chunks {
            let win_mb_s = (win_bytes as f64 / (1024.0 * 1024.0))
                / last_emit.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: format!(
                        "2/4 Direct Read & Surface Verify ({:.0}/{} MB)",
                        ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0),
                        size_mb
                    ),
                    percent: 32.0 + ((i + 1) as f64 / total_chunks as f64) * 34.0,
                    current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    integrity_errors,
                },
            );
            win_bytes = 0;
            last_emit = Instant::now();
        }
    }
    let sr_secs = t_sr.elapsed().as_secs_f64().max(0.001);
    let seq_read_mb_s = (size_mb as f64 / sr_secs * 10.0).round() / 10.0;

    // Phase 3: Random 4K Write (Sector-Aligned Direct-IO)
    let block_4k = 4096u64;
    let max_blocks = (size_mb * 1024 * 1024) / block_4k;
    let mut buf_4k = AlignedBuffer::new(4096);
    fill_block_pattern(buf_4k.as_mut_slice(), 0xABCDEF);
    let mut rng: u64 = 0xCAFE_BABE_DEAD_BEEF;
    let t_rw = Instant::now();
    last_emit = Instant::now();
    let mut win_ops = 0usize;

    for i in 0..rand_ops {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage durability test cancelled.".to_string());
        }
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let offset = (rng % max_blocks) * block_4k;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        file.write_all(buf_4k.as_slice()).map_err(|e| e.to_string())?;
        win_ops += 1;

        if last_emit.elapsed().as_millis() >= 220 || i + 1 == rand_ops {
            let win_mb_s = ((win_ops * 4096) as f64 / (1024.0 * 1024.0))
                / last_emit.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: format!("3/4 Random 4K Direct Write ({}/{})", i + 1, rand_ops),
                    percent: 66.0 + ((i + 1) as f64 / rand_ops as f64) * 17.0,
                    current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    integrity_errors,
                },
            );
            win_ops = 0;
            last_emit = Instant::now();
        }
    }
    if !direct_io {
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let rw_secs = t_rw.elapsed().as_secs_f64().max(0.001);
    let rand_4k_write_mb_s =
        (((rand_ops * 4096) as f64 / (1024.0 * 1024.0)) / rw_secs * 10.0).round() / 10.0;
    let rand_4k_write_iops = (rand_ops as f64 / rw_secs).round() as u64;

    // Phase 4: Random 4K Read + Per-Op Latency Histogram (Avg & P99 ms)
    let mut latencies_us = Vec::with_capacity(rand_ops);
    let t_rr = Instant::now();
    last_emit = Instant::now();
    win_ops = 0;

    for i in 0..rand_ops {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage durability test cancelled.".to_string());
        }
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let offset = (rng % max_blocks) * block_4k;
        let op_t0 = Instant::now();
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        file.read_exact(buf_4k.as_mut_slice()).map_err(|e| e.to_string())?;
        latencies_us.push(op_t0.elapsed().as_micros() as u64);
        win_ops += 1;

        if last_emit.elapsed().as_millis() >= 220 || i + 1 == rand_ops {
            let win_mb_s = ((win_ops * 4096) as f64 / (1024.0 * 1024.0))
                / last_emit.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: format!("4/4 Random 4K Read & Latency ({}/{})", i + 1, rand_ops),
                    percent: 83.0 + ((i + 1) as f64 / rand_ops as f64) * 17.0,
                    current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    integrity_errors,
                },
            );
            win_ops = 0;
            last_emit = Instant::now();
        }
    }
    let rr_secs = t_rr.elapsed().as_secs_f64().max(0.001);
    let rand_4k_read_mb_s =
        (((rand_ops * 4096) as f64 / (1024.0 * 1024.0)) / rr_secs * 10.0).round() / 10.0;
    let rand_4k_read_iops = (rand_ops as f64 / rr_secs).round() as u64;

    latencies_us.sort_unstable();
    let avg_4k_latency_ms = if latencies_us.is_empty() {
        0.0
    } else {
        let sum: u64 = latencies_us.iter().sum();
        ((sum as f64 / latencies_us.len() as f64) / 1000.0 * 100.0).round() / 100.0
    };
    let p99_4k_latency_ms = if latencies_us.is_empty() {
        0.0
    } else {
        let p99_idx = ((latencies_us.len() as f64) * 0.99) as usize;
        let v = latencies_us[p99_idx.min(latencies_us.len() - 1)];
        ((v as f64) / 1000.0 * 100.0).round() / 100.0
    };

    drop(file);

    let iface = interface_hint.unwrap_or_else(|| "NVMe".into());
    let media = media_hint.unwrap_or_else(|| "SSD".into());
    let baseline = baselines::rate_storage(&iface, &media, seq_read_mb_s, seq_write_mb_s, integrity_errors);

    let status = if integrity_errors > 0 || baseline.percent_of_normal < 50.0 {
        TestStatus::Fail
    } else if baseline.percent_of_normal < 80.0 || p99_4k_latency_ms > 15.0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    Ok(StorageBenchResult {
        status,
        preset: preset.to_string(),
        test_size_mb: size_mb,
        direct_io,
        seq_write_mb_s,
        seq_read_mb_s,
        rand_4k_write_mb_s,
        rand_4k_read_mb_s,
        rand_4k_write_iops,
        rand_4k_read_iops,
        avg_4k_latency_ms,
        p99_4k_latency_ms,
        integrity_errors,
        elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        baseline: baseline.clone(),
        summary: format!(
            "[{}] Direct-IO {} MB — Read {:.0} MB/s | Write {:.0} MB/s | 4K {} IOPS (P99 {:.2}ms) | {} verify errors",
            baseline.grade, size_mb, seq_read_mb_s, seq_write_mb_s, rand_4k_read_iops, p99_4k_latency_ms, integrity_errors
        ),
    })
}
