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
struct NvmeHealthLog {
    temperature_c: Option<i32>,
    available_spare_pct: Option<u32>,
    wear_percent: Option<u32>,
    tbw_gb: Option<f64>,
    power_cycles: Option<u64>,
    power_on_hours: Option<u64>,
    unsafe_shutdowns: Option<u64>,
    media_errors: Option<u64>,
    critical_warning: u8,
}

/// Queries Windows' native `IOCTL_STORAGE_QUERY_PROPERTY` (`StorageAdapterProtocolSpecificProperty`)
/// for the 512-byte NVMe SMART / Health Information Log (Log Page 0x02) directly in Rust!
#[cfg(target_os = "windows")]
fn query_windows_nvme_smart_ioctl(drive_index: u32) -> Option<NvmeHealthLog> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *const std::ffi::c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: isize,
        ) -> isize;
        fn DeviceIoControl(
            hDevice: isize,
            dwIoControlCode: u32,
            lpInBuffer: *const u8,
            nInBufferSize: u32,
            lpOutBuffer: *mut u8,
            nOutBufferSize: u32,
            lpBytesReturned: *mut u32,
            lpOverlapped: *mut std::ffi::c_void,
        ) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    const INVALID_HANDLE_VALUE: isize = -1;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;

    let path_str = format!(r"\\.\PhysicalDrive{}", drive_index);
    let wide: Vec<u16> = OsStr::new(&path_str)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle == 0 {
        return None;
    }

    // Build STORAGE_PROPERTY_QUERY (8 bytes) + STORAGE_PROTOCOL_SPECIFIC_DATA (40 bytes) + 512-byte log buffer
    // Offset 0..4: PropertyId = 49 (StorageAdapterProtocolSpecificProperty)
    // Offset 4..8: QueryType = 0 (PropertyStandardQuery)
    // Offset 8..48: STORAGE_PROTOCOL_SPECIFIC_DATA:
    //   [8..12]  ProtocolType = 3 (ProtocolTypeNvme)
    //   [12..16] DataType = 2 (NVMeDataTypeLogPage)
    //   [16..20] ProtocolDataRequestValue = 2 (NVME_LOG_PAGE_HEALTH_INFO)
    //   [20..24] ProtocolDataRequestSubValue = 0
    //   [24..28] ProtocolDataOffset = 40 (sizeof STORAGE_PROTOCOL_SPECIFIC_DATA)
    //   [28..32] ProtocolDataLength = 512
    //   [32..36] FixedProtocolReturnData = 0
    //   [36..48] SubValue2/3/4 = 0
    let mut buf = vec![0u8; 8 + 40 + 512];
    buf[0..4].copy_from_slice(&49u32.to_le_bytes());
    buf[4..8].copy_from_slice(&0u32.to_le_bytes());
    buf[8..12].copy_from_slice(&3u32.to_le_bytes());
    buf[12..16].copy_from_slice(&2u32.to_le_bytes());
    buf[16..20].copy_from_slice(&2u32.to_le_bytes());
    buf[24..28].copy_from_slice(&40u32.to_le_bytes());
    buf[28..32].copy_from_slice(&512u32.to_le_bytes());

    let mut returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            buf.as_ptr(),
            buf.len() as u32,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        CloseHandle(handle);
    }

    if ok == 0 || returned < 8 + 40 + 180 {
        return None;
    }

    // Output starts with STORAGE_PROTOCOL_DATA_DESCRIPTOR (Version u32, Size u32, STORAGE_PROTOCOL_SPECIFIC_DATA 40B)
    let data_offset = u32::from_le_bytes([buf[24], buf[25], buf[26], buf[27]]) as usize;
    let log_start = 8 + data_offset;
    if log_start + 180 > buf.len() {
        return None;
    }
    let log = &buf[log_start..];

    let read_u64 = |off: usize| -> u64 {
        u64::from_le_bytes([
            log[off],
            log[off + 1],
            log[off + 2],
            log[off + 3],
            log[off + 4],
            log[off + 5],
            log[off + 6],
            log[off + 7],
        ])
    };

    let critical_warning = log[0];
    let temp_k = u16::from_le_bytes([log[1], log[2]]) as i32;
    let temperature_c = if temp_k > 250 && temp_k < 420 {
        Some(temp_k - 273)
    } else {
        None
    };
    let available_spare_pct = Some(log[3] as u32).filter(|&s| s <= 100);
    let wear_percent = Some((log[5] as u32).min(100));

    let duw = read_u64(48);
    let tbw_gb = if duw > 0 {
        Some(((duw as f64 * 512_000.0) / 1_000_000_000.0 * 10.0).round() / 10.0)
    } else {
        None
    };
    let power_cycles = Some(read_u64(112));
    let power_on_hours = Some(read_u64(128));
    let unsafe_shutdowns = Some(read_u64(144));
    let media_errors = Some(read_u64(160));

    Some(NvmeHealthLog {
        temperature_c,
        available_spare_pct,
        wear_percent,
        tbw_gb,
        power_cycles,
        power_on_hours,
        unsafe_shutdowns,
        media_errors,
        critical_warning,
    })
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
                    let dev_id_str = d["deviceId"].as_str().unwrap_or("0").to_string();
                    let dev_idx = dev_id_str.parse::<u32>().ok();
                    let model = d["model"].as_str().unwrap_or("Disk").trim().to_string();
                    let health_str = d["health"].as_str().unwrap_or("Unknown").to_string();
                    let mut wear = d["wear"].as_u64().map(|w| w.min(100) as u32);
                    let mut temp = d["temp"].as_i64().filter(|&t| t > 0 && t < 130).map(|t| t as i32);
                    let mut poh = d["poh"].as_u64();
                    let read_err = d["readErr"].as_u64();
                    let mut media_errors = d["readUncorr"].as_u64();
                    let write_err = d["writeErr"].as_u64();
                    let mut power_cycles: Option<u64> = None;
                    let mut unsafe_shutdowns: Option<u64> = None;
                    let mut tbw_gb: Option<f64> = None;
                    let mut available_spare_pct: Option<u32> = None;
                    let mut nvme_crit = 0u8;
                    let mut ioctl_used = false;

                    // Enrich with Native Windows NVMe SMART IOCTL (DriveDx-grade counters!)
                    if let Some(idx) = dev_idx {
                        if let Some(nvme) = query_windows_nvme_smart_ioctl(idx) {
                            ioctl_used = true;
                            nvme_crit = nvme.critical_warning;
                            if nvme.wear_percent.is_some() {
                                wear = nvme.wear_percent;
                            }
                            if nvme.temperature_c.is_some() {
                                temp = nvme.temperature_c;
                            }
                            if nvme.power_on_hours.is_some() {
                                poh = nvme.power_on_hours;
                            }
                            if nvme.media_errors.is_some() {
                                media_errors = nvme.media_errors;
                            }
                            power_cycles = nvme.power_cycles;
                            unsafe_shutdowns = nvme.unsafe_shutdowns;
                            tbw_gb = nvme.tbw_gb;
                            available_spare_pct = nvme.available_spare_pct;
                        }
                    }

                    let health_pct = wear.map(|w| 100u32.saturating_sub(w));

                    let status = if predict_any_fail
                        || nvme_crit != 0
                        || health_str.eq_ignore_ascii_case("Unhealthy")
                        || media_errors.unwrap_or(0) > 0
                        || health_pct.map(|h| h < 50).unwrap_or(false)
                    {
                        TestStatus::Fail
                    } else if health_str.eq_ignore_ascii_case("Warning")
                        || health_pct.map(|h| h < 80).unwrap_or(false)
                        || available_spare_pct.map(|s| s < 20).unwrap_or(false)
                        || temp.map(|t| t >= 70).unwrap_or(false)
                    {
                        TestStatus::Warn
                    } else {
                        TestStatus::Pass
                    };

                    let notes = if status == TestStatus::Fail {
                        format!(
                            "CRITICAL: Drive reported unhealthy SMART status, media errors, or critical warning (0x{:02X}).",
                            nvme_crit
                        )
                    } else if ioctl_used {
                        format!(
                            "Native NVMe IOCTL SMART OK — {}% health remaining{}{}{}",
                            health_pct.map(|h| h.to_string()).unwrap_or_else(|| "N/A".into()),
                            temp.map(|t| format!(", {}°C", t)).unwrap_or_default(),
                            tbw_gb.map(|g| format!(", {:.1} TBW", g / 1000.0)).unwrap_or_default(),
                            unsafe_shutdowns.map(|u| format!(", {} unsafe shutdowns", u)).unwrap_or_default(),
                        )
                    } else if wear.is_none() && poh.is_none() {
                        "Basic health OK (run as Administrator for native NVMe SMART IOCTL counters)."
                            .to_string()
                    } else {
                        format!(
                            "SMART OK — {}% health remaining{}",
                            health_pct.map(|h| h.to_string()).unwrap_or_else(|| "N/A".into()),
                            temp.map(|t| format!(", {}°C", t)).unwrap_or_default()
                        )
                    };

                    drives.push(DriveSmartInfo {
                        device_id: dev_id_str,
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
                        power_cycles,
                        unsafe_shutdowns,
                        media_errors,
                        read_errors: read_err,
                        write_errors: write_err,
                        tbw_gb,
                        available_spare_pct,
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
    target_mount: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<StorageBenchResult, String> {
    // True second-hand shop durability sizes (bypassing RAM cache!)
    let (size_mb, rand_ops): (u64, usize) = match preset {
        "standard" => (2048, 8192), // 2 GB sustained + 8K random ops
        "burnin" => (4096, 16384),  // 4 GB sustained SLC-exhaustion + 16K random ops
        _ => (1024, 4096),          // 1 GB real Direct-IO Quick Shop QC
    };

    let filename = format!("laptopbench_qc_ssd_durability_{}.tmp", std::process::id());
    let chosen_path = if let Some(ref mount) = target_mount {
        let m = mount.trim();
        if !m.is_empty() {
            let candidate = PathBuf::from(m).join(&filename);
            if open_direct_bench_file(&candidate).is_ok() {
                let _ = fs::remove_file(&candidate);
                candidate
            } else {
                std::env::temp_dir().join(&filename)
            }
        } else {
            std::env::temp_dir().join(&filename)
        }
    } else {
        std::env::temp_dir().join(&filename)
    };
    let tmp_path = chosen_path;
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
