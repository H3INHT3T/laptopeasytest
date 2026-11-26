use crate::modules::{baselines, userbenchmark};
use crate::types::{
    DriveSmartInfo, StorageBenchProgress, StorageBenchResult, StorageSmartReport, TestStatus,
    UserBenchmarkInput, SSD_FREE_SPACE_MULTIPLIER, SSD_WRITE_BUDGET_MAX_MB,
    SSD_WRITE_BUDGET_QUICK_MB, SSD_WRITE_BUDGET_STD_MB,
};
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub(crate) const SSD_TEMP_WARN_C: i32 = 75;
pub(crate) const SSD_TEMP_CUTOFF_C: i32 = 82;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SsdWriteBudget {
    pub total_budget_mb: u64,
    pub seq_mb: u64,
    pub rand_qd1_write_mb: u64,
    pub rand_qd32_write_mb: u64,
    pub mixed_write_mb: u64,
}

/// Pure Smart-Bench classifier for SSD Thermal Throttling & Write-Collapse Audit (v3.0.0).
/// Compares First-Third vs Final-Third sequential write throughput along with drive temperature rise.
pub fn classify_ssd_write_collapse(
    chunk_speeds: &[f64],
    temp_start_c: Option<i32>,
    temp_peak_c: Option<i32>,
) -> (f64, f64, f64, Option<i32>, String) {
    let temp_rise_c = match (temp_start_c, temp_peak_c) {
        (Some(s), Some(p)) => Some((p - s).max(0)),
        _ => None,
    };
    if chunk_speeds.len() < 3 {
        let avg = if chunk_speeds.is_empty() {
            0.0
        } else {
            (chunk_speeds.iter().sum::<f64>() / chunk_speeds.len() as f64 * 10.0).round() / 10.0
        };
        return (avg, avg, 0.0, temp_rise_c, "STEADY".to_string());
    }

    let third = (chunk_speeds.len() / 3).max(1);
    let early = (chunk_speeds[..third].iter().sum::<f64>() / third as f64 * 10.0).round() / 10.0;
    let late = (chunk_speeds[chunk_speeds.len() - third..].iter().sum::<f64>() / third as f64 * 10.0).round() / 10.0;
    let collapse_pct = if early > 1.0 {
        (((early - late).max(0.0) / early) * 100.0 * 10.0).round() / 10.0
    } else {
        0.0
    };

    let hot = temp_peak_c.map(|t| t >= 68).unwrap_or(false)
        || temp_rise_c.map(|r| r >= 14).unwrap_or(false);

    let verdict = if collapse_pct >= 45.0 && hot {
        "SSD_THERMAL_THROTTLE".to_string()
    } else if collapse_pct >= 45.0 {
        "SLC_CACHE_DROP".to_string()
    } else {
        "STEADY".to_string()
    };

    (early, late, collapse_pct, temp_rise_c, verdict)
}

pub(crate) fn compute_ssd_write_budget(preset: &str) -> SsdWriteBudget {
    match preset {
        "standard" => SsdWriteBudget {
            total_budget_mb: SSD_WRITE_BUDGET_STD_MB, // 256 MB
            seq_mb: 192,
            rand_qd1_write_mb: 24,
            rand_qd32_write_mb: 24,
            mixed_write_mb: 16,
        },
        "burnin" => SsdWriteBudget {
            total_budget_mb: SSD_WRITE_BUDGET_MAX_MB, // 512 MB
            seq_mb: 384,
            rand_qd1_write_mb: 48,
            rand_qd32_write_mb: 48,
            mixed_write_mb: 32,
        },
        _ => SsdWriteBudget {
            total_budget_mb: SSD_WRITE_BUDGET_QUICK_MB, // 128 MB
            seq_mb: 96,
            rand_qd1_write_mb: 12,
            rand_qd32_write_mb: 12,
            mixed_write_mb: 8,
        },
    }
}

pub(crate) fn validate_free_space_mb(avail_mb: u64, budget_mb: u64) -> Result<(), String> {
    let required_mb = budget_mb
        .saturating_mul(SSD_FREE_SPACE_MULTIPLIER)
        .max(2048);
    if avail_mb < required_mb {
        return Err(format!(
            "Insufficient free disk space: {} MB available, require at least {} MB ({}x {} MB write budget, minimum 2048 MB).",
            avail_mb, required_mb, SSD_FREE_SPACE_MULTIPLIER, budget_mb
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn query_available_disk_mb(dir: &Path) -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = OsStr::new(dir)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_avail: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_avail,
            &mut total_bytes,
            &mut total_free,
        )
    };
    if ok != 0 {
        Some(free_avail / (1024 * 1024))
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn query_available_disk_mb(dir: &Path) -> Option<u64> {
    use sysinfo::Disks;

    let canonical = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let disks = Disks::new_with_refreshed_list();
    let mut best_match: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if canonical.starts_with(mount) {
            let depth = mount.as_os_str().len();
            if best_match.map(|(d, _)| depth > d).unwrap_or(true) {
                best_match = Some((depth, disk.available_space() / (1024 * 1024)));
            }
        }
    }
    best_match.map(|(_, mb)| mb)
}

pub(crate) fn check_free_space_for_budget(dir: &Path, budget_mb: u64) -> Result<u64, String> {
    let avail_mb = query_available_disk_mb(dir)
        .ok_or_else(|| format!("Unable to verify free disk space on '{}'.", dir.display()))?;
    validate_free_space_mb(avail_mb, budget_mb)?;
    Ok(avail_mb)
}

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

pub(crate) fn compute_mb_per_sec(bytes: u64, elapsed_secs: f64) -> f64 {
    (((bytes as f64 / (1024.0 * 1024.0)) / elapsed_secs.max(0.001)) * 10.0).round() / 10.0
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct NvmeHealthLog {
    pub temperature_c: Option<i32>,
    pub available_spare_pct: Option<u32>,
    pub available_spare_threshold_pct: Option<u32>,
    pub percentage_used_raw: Option<u32>,
    pub tbw_gb: Option<f64>,
    pub power_cycles: Option<u64>,
    pub power_on_hours: Option<u64>,
    pub unsafe_shutdowns: Option<u64>,
    pub media_errors: Option<u64>,
    pub critical_warning: u8,
    pub critical_warning_flags: Vec<String>,
}

pub(crate) fn decode_critical_warning_flags(mask: u8) -> Vec<String> {
    let mut flags = Vec::new();
    if (mask & 0x01) != 0 {
        flags.push("Available spare below threshold".to_string());
    }
    if (mask & 0x02) != 0 {
        flags.push("Temperature threshold exceeded".to_string());
    }
    if (mask & 0x04) != 0 {
        flags.push("NVM subsystem reliability degraded".to_string());
    }
    if (mask & 0x08) != 0 {
        flags.push("Media placed in read-only mode".to_string());
    }
    if (mask & 0x10) != 0 {
        flags.push("Volatile memory backup device failed".to_string());
    }
    if (mask & 0xE0) != 0 {
        flags.push(format!("Reserved critical flag (0x{:02X})", mask & 0xE0));
    }
    flags
}

#[allow(dead_code)]
pub(crate) fn parse_nvme_smart_log_0x02(log: &[u8]) -> Option<NvmeHealthLog> {
    if log.len() < 180 {
        return None;
    }

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
    let critical_warning_flags = decode_critical_warning_flags(critical_warning);
    let temp_k = u16::from_le_bytes([log[1], log[2]]) as i32;
    let temperature_c = if temp_k > 250 && temp_k < 420 {
        Some(temp_k - 273)
    } else {
        None
    };
    let available_spare_pct = Some(log[3] as u32).filter(|&s| s <= 100);
    let available_spare_threshold_pct = Some(log[4] as u32).filter(|&s| s <= 100);
    let percentage_used_raw = Some(log[5] as u32);

    let duw_bytes: [u8; 16] = log[48..64].try_into().ok()?;
    let duw = u128::from_le_bytes(duw_bytes);
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
        available_spare_threshold_pct,
        percentage_used_raw,
        tbw_gb,
        power_cycles,
        power_on_hours,
        unsafe_shutdowns,
        media_errors,
        critical_warning,
        critical_warning_flags,
    })
}

pub(crate) fn evaluate_drive_smart_status(
    predict_fail: bool,
    health_str: &str,
    nvme_crit: u8,
    crit_flags: &[String],
    health_pct: Option<u32>,
    available_spare_pct: Option<u32>,
    spare_threshold_pct: Option<u32>,
    media_errors: Option<u64>,
    temp_c: Option<i32>,
    tbw_gb: Option<f64>,
    unsafe_shutdowns: Option<u64>,
    poh: Option<u64>,
    ioctl_used: bool,
) -> (TestStatus, String, String) {
    let spare_below_thresh = match (available_spare_pct, spare_threshold_pct) {
        (Some(spare), Some(thresh)) => spare <= thresh,
        _ => false,
    };
    let is_fail = predict_fail
        || nvme_crit != 0
        || health_str.eq_ignore_ascii_case("Unhealthy")
        || health_str.to_lowercase().contains("fail")
        || media_errors.unwrap_or(0) > 0
        || health_pct.map(|h| h < 50).unwrap_or(false)
        || spare_below_thresh
        || temp_c.map(|t| t >= SSD_TEMP_CUTOFF_C).unwrap_or(false);

    let is_warn = !is_fail
        && (health_str.eq_ignore_ascii_case("Warning")
            || health_pct.map(|h| h < 80).unwrap_or(false)
            || available_spare_pct.map(|s| s < 20).unwrap_or(false)
            || temp_c.map(|t| t >= SSD_TEMP_WARN_C).unwrap_or(false));

    let status = if is_fail {
        TestStatus::Fail
    } else if is_warn {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let notes = if status == TestStatus::Fail {
        let mut reasons = Vec::new();
        if nvme_crit != 0 {
            if crit_flags.is_empty() {
                reasons.push(format!("critical warning 0x{:02X}", nvme_crit));
            } else {
                reasons.push(crit_flags.join("; "));
            }
        }
        if media_errors.unwrap_or(0) > 0 {
            reasons.push(format!("{} media/uncorrectable error(s)", media_errors.unwrap_or(0)));
        }
        if spare_below_thresh {
            reasons.push(format!(
                "spare {}% at/below threshold {}%",
                available_spare_pct.unwrap_or(0),
                spare_threshold_pct.unwrap_or(0)
            ));
        }
        if health_pct.map(|h| h < 50).unwrap_or(false) {
            reasons.push(format!("remaining life {}%", health_pct.unwrap_or(0)));
        }
        if temp_c.map(|t| t >= SSD_TEMP_CUTOFF_C).unwrap_or(false) {
            reasons.push(format!("critical temperature {}°C", temp_c.unwrap_or(0)));
        }
        if reasons.is_empty() {
            reasons.push(format!("OS health '{}'", health_str));
        }
        format!("CRITICAL: {}", reasons.join(", "))
    } else if ioctl_used {
        format!(
            "Native NVMe IOCTL SMART OK — {}% health remaining{}{}{}",
            health_pct.map(|h| h.to_string()).unwrap_or_else(|| "N/A".into()),
            temp_c.map(|t| format!(", {}°C", t)).unwrap_or_default(),
            tbw_gb.map(|g| format!(", {:.1} TBW", g / 1000.0)).unwrap_or_default(),
            unsafe_shutdowns.map(|u| format!(", {} unsafe shutdowns", u)).unwrap_or_default(),
        )
    } else if health_pct.is_none() && poh.is_none() {
        "Basic health OK (run as Administrator for native NVMe SMART IOCTL counters)."
            .to_string()
    } else {
        format!(
            "SMART OK — {}% health remaining{}",
            health_pct.map(|h| h.to_string()).unwrap_or_else(|| "N/A".into()),
            temp_c.map(|t| format!(", {}°C", t)).unwrap_or_default()
        )
    };

    let health_txt = health_pct
        .map(|h| format!("{}% life remaining", h))
        .unwrap_or_else(|| format!("OS status {}", health_str));
    let tbw_txt = tbw_gb
        .map(|g| format!(", {:.1} TB written", g / 1000.0))
        .unwrap_or_default();
    let spare_txt = available_spare_pct
        .map(|s| {
            if let Some(th) = spare_threshold_pct {
                format!(", spare {}% (min {}%)", s, th)
            } else {
                format!(", spare {}%", s)
            }
        })
        .unwrap_or_default();
    let temp_txt = temp_c.map(|t| format!(", {}°C", t)).unwrap_or_default();
    let poh_txt = poh.map(|h| format!(", {} power-on hrs", h)).unwrap_or_default();

    let plain_summary = match status {
        TestStatus::Fail => format!(
            "Replace/avoid drive: {} ({}{}{}{}).",
            notes, health_txt, spare_txt, temp_txt, tbw_txt
        ),
        TestStatus::Warn => format!(
            "Drive shows wear or thermal warning: {}{}{}{}{}.",
            health_txt, spare_txt, temp_txt, tbw_txt, poh_txt
        ),
        _ => format!(
            "Healthy drive: {}{}{}{}{}.",
            health_txt, spare_txt, temp_txt, tbw_txt, poh_txt
        ),
    };

    (status, notes, plain_summary)
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
    parse_nvme_smart_log_0x02(log)
}

#[cfg(target_os = "windows")]
fn resolve_windows_physical_drive_index(path: &Path) -> Option<u32> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetVolumePathNameW(
            lpszFileName: *const u16,
            lpszVolumePathName: *mut u16,
            cchBufferLength: u32,
        ) -> i32;
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
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;

    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut vol_buf = vec![0u16; 260];
    let ok = unsafe { GetVolumePathNameW(wide_path.as_ptr(), vol_buf.as_mut_ptr(), vol_buf.len() as u32) };
    if ok == 0 {
        return Some(0);
    }
    let nul_pos = vol_buf.iter().position(|&c| c == 0).unwrap_or(0);
    let vol_str = String::from_utf16_lossy(&vol_buf[..nul_pos]);
    let trimmed = vol_str.trim_end_matches('\\');
    let dev_path = format!(r"\\.\{}", trimmed);
    let dev_wide: Vec<u16> = OsStr::new(&dev_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            dev_wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle == 0 {
        return Some(0);
    }

    let mut out = [0u8; 64];
    let mut returned: u32 = 0;
    let io_ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        CloseHandle(handle);
    }

    if io_ok != 0 && returned >= 12 {
        let count = u32::from_le_bytes([out[0], out[1], out[2], out[3]]);
        if count >= 1 {
            // VOLUME_DISK_EXTENTS: NumberOfDiskExtents (u32, 4B padding on 64-bit) -> Extents[0].DiskNumber at offset 8
            let disk_num = u32::from_le_bytes([out[8], out[9], out[10], out[11]]);
            return Some(disk_num);
        }
    }
    Some(0)
}

fn poll_drive_temp_c(_drive_idx: Option<u32>, _mount_hint: Option<&str>) -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        let idx = _drive_idx.unwrap_or(0);
        query_windows_nvme_smart_ioctl(idx).and_then(|n| n.temperature_c)
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(bsd) = _mount_hint {
            if !bsd.trim().is_empty() && !bsd.starts_with('/') {
                if let Ok(sc) = crate::cmd_util::run_cmd_stdout("smartctl", &["-j", "-a", &format!("/dev/{}", bsd)]) {
                    if let Ok(sv) = serde_json::from_str::<serde_json::Value>(&sc) {
                        return sv["nvme_smart_health_information_log"]["temperature"]
                            .as_i64()
                            .map(|x| x as i32);
                    }
                }
            }
        }
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
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
                    let dev_id_str = d["deviceId"].as_str().unwrap_or("0").to_string();
                    let dev_idx = dev_id_str.parse::<u32>().ok();
                    let model = d["model"].as_str().unwrap_or("Disk").trim().to_string();
                    let health_str = d["health"].as_str().unwrap_or("Unknown").to_string();
                    let mut percentage_used_raw = d["wear"].as_u64().map(|w| w as u32);
                    let mut wear = percentage_used_raw.map(|w| w.min(100));
                    let mut temp = d["temp"].as_i64().filter(|&t| t > 0 && t < 130).map(|t| t as i32);
                    let mut poh = d["poh"].as_u64();
                    let read_err = d["readErr"].as_u64();
                    let mut media_errors = d["readUncorr"].as_u64();
                    let write_err = d["writeErr"].as_u64();
                    let mut power_cycles: Option<u64> = None;
                    let mut unsafe_shutdowns: Option<u64> = None;
                    let mut tbw_gb: Option<f64> = None;
                    let mut available_spare_pct: Option<u32> = None;
                    let mut available_spare_threshold_pct: Option<u32> = None;
                    let mut nvme_crit = 0u8;
                    let mut critical_warning_flags: Vec<String> = Vec::new();
                    let mut ioctl_used = false;

                    // Enrich with Native Windows NVMe SMART IOCTL (DriveDx-grade counters!)
                    if let Some(idx) = dev_idx {
                        if let Some(nvme) = query_windows_nvme_smart_ioctl(idx) {
                            ioctl_used = true;
                            nvme_crit = nvme.critical_warning;
                            critical_warning_flags = nvme.critical_warning_flags;
                            if nvme.percentage_used_raw.is_some() {
                                percentage_used_raw = nvme.percentage_used_raw;
                                wear = nvme.percentage_used_raw.map(|w| w.min(100));
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
                            available_spare_threshold_pct = nvme.available_spare_threshold_pct;
                        }
                    }

                    let health_pct = percentage_used_raw.map(|w| 100u32.saturating_sub(w));
                    let (status, notes, plain_summary) = evaluate_drive_smart_status(
                        predict_any_fail,
                        &health_str,
                        nvme_crit,
                        &critical_warning_flags,
                        health_pct,
                        available_spare_pct,
                        available_spare_threshold_pct,
                        media_errors,
                        temp,
                        tbw_gb,
                        unsafe_shutdowns,
                        poh,
                        ioctl_used,
                    );

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
                        critical_warning_flags,
                        available_spare_threshold_pct,
                        percentage_used_raw,
                        plain_summary,
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

                            let mut percentage_used_raw: Option<u32> = None;
                            let mut wear: Option<u32> = None;
                            let mut temp: Option<i32> = None;
                            let mut poh: Option<u64> = None;
                            let mut cycles: Option<u64> = None;
                            let mut unsafe_sd: Option<u64> = None;
                            let mut media_err: Option<u64> = None;
                            let mut tbw_gb: Option<f64> = None;
                            let mut spare: Option<u32> = None;
                            let mut spare_thresh: Option<u32> = None;
                            let mut crit_mask: u8 = 0;

                            if let Ok(sc) = run_cmd_stdout("smartctl", &["-j", "-a", &format!("/dev/{}", bsd)]) {
                                if let Ok(sv) = serde_json::from_str::<Value>(&sc) {
                                    let log = &sv["nvme_smart_health_information_log"];
                                    percentage_used_raw = log["percentage_used"].as_u64().map(|x| x as u32);
                                    wear = percentage_used_raw.map(|x| x.min(100));
                                    temp = log["temperature"].as_i64().map(|x| x as i32);
                                    poh = log["power_on_hours"].as_u64();
                                    cycles = log["power_cycles"].as_u64();
                                    unsafe_sd = log["unsafe_shutdowns"].as_u64();
                                    media_err = log["media_errors"].as_u64();
                                    spare = log["available_spare"].as_u64().map(|x| x as u32);
                                    spare_thresh = log["available_spare_threshold"].as_u64().map(|x| x as u32);
                                    crit_mask = log["critical_warning"].as_u64().unwrap_or(0) as u8;
                                    if let Some(duw) = log["data_units_written"].as_u64() {
                                        tbw_gb = Some(((duw as f64 * 512_000.0) / 1e9 * 10.0).round() / 10.0);
                                    }
                                }
                            }

                            let crit_flags = decode_critical_warning_flags(crit_mask);
                            let health_pct = percentage_used_raw.map(|w| 100u32.saturating_sub(w));
                            let (status, notes, plain_summary) = evaluate_drive_smart_status(
                                false,
                                &smart_status,
                                crit_mask,
                                &crit_flags,
                                health_pct,
                                spare,
                                spare_thresh,
                                media_err,
                                temp,
                                tbw_gb,
                                unsafe_sd,
                                poh,
                                false,
                            );

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
                                notes,
                                critical_warning_flags: crit_flags,
                                available_spare_threshold_pct: spare_thresh,
                                percentage_used_raw,
                                plain_summary,
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

pub(crate) struct TempFileGuard(pub(crate) PathBuf);
impl TempFileGuard {
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn open_direct_bench_file(path: &Path) -> Result<(File, bool), String> {
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

fn open_direct_bench_existing_rw(path: &Path, use_direct: bool) -> Result<File, String> {
    #[cfg(target_os = "windows")]
    if use_direct {
        use std::os::windows::fs::OpenOptionsExt;
        if let Ok(f) = OpenOptions::new()
            .write(true)
            .read(true)
            .custom_flags(0x2000_0000 | 0x8000_0000)
            .open(path)
        {
            return Ok(f);
        }
    }

    let file = OpenOptions::new()
        .write(true)
        .read(true)
        .open(path)
        .map_err(|e| format!("Could not open temp benchmark file for multi-queue I/O: {}", e))?;

    #[cfg(target_os = "macos")]
    if use_direct {
        use std::os::unix::io::AsRawFd;
        extern "C" {
            fn fcntl(fd: i32, cmd: i32, ...) -> i32;
        }
        const F_NOCACHE: i32 = 48;
        let _ = unsafe { fcntl(file.as_raw_fd(), F_NOCACHE, 1) };
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = use_direct;

    Ok(file)
}

pub(crate) fn compute_slc_cache_metrics(chunk_speeds: &[f64]) -> (f64, f64, f64) {
    if chunk_speeds.is_empty() {
        return (0.0, 0.0, 100.0);
    }
    let finite: Vec<f64> = chunk_speeds
        .iter()
        .copied()
        .filter(|s| s.is_finite() && *s > 0.0)
        .collect();
    if finite.is_empty() {
        return (0.0, 0.0, 100.0);
    }
    if finite.len() < 4 {
        let avg = finite.iter().sum::<f64>() / finite.len() as f64;
        return ((avg * 10.0).round() / 10.0, 0.0, 100.0);
    }
    let k = (finite.len() / 4).max(1);
    let early_avg = finite[..k].iter().sum::<f64>() / k as f64;
    let late_avg = finite[finite.len() - k..].iter().sum::<f64>() / k as f64;
    let drop_pct = (((early_avg - late_avg) / early_avg.max(0.1)) * 100.0).clamp(0.0, 99.0);
    let stability_pct = (100.0 - drop_pct).clamp(0.0, 100.0);
    (
        (late_avg * 10.0).round() / 10.0,
        (drop_pct * 10.0).round() / 10.0,
        (stability_pct * 10.0).round() / 10.0,
    )
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
    let budget = compute_ssd_write_budget(preset);
    let target_dir = if let Some(ref mount) = target_mount {
        let m = mount.trim();
        if !m.is_empty() {
            let dir = PathBuf::from(m);
            if !dir.is_dir() {
                return Err(format!("Selected storage target '{}' is not a valid directory.", m));
            }
            dir
        } else {
            std::env::temp_dir()
        }
    } else {
        std::env::temp_dir()
    };

    // Enforce free-space safety guard BEFORE creating or writing any temporary file
    let _avail_mb = check_free_space_for_budget(&target_dir, budget.total_budget_mb)?;

    let filename = format!("laptopbench_qc_ssd_durability_{}.tmp", std::process::id());
    let tmp_path = target_dir.join(&filename);
    // RAII guard constructed BEFORE opening/creating temp file so no file can ever leak
    let guard = TempFileGuard(tmp_path.clone());

    let (mut file, direct_io) = open_direct_bench_file(guard.path())?;

    #[cfg(target_os = "windows")]
    let drive_idx = resolve_windows_physical_drive_index(guard.path());
    #[cfg(not(target_os = "windows"))]
    let drive_idx: Option<u32> = None;
    let mount_hint_str = target_mount.as_deref();

    let started = Instant::now();
    let chunk_size = 4 * 1024 * 1024; // 4 MB aligned chunks
    let size_mb = budget.seq_mb;
    let total_chunks = ((size_mb as usize * 1024 * 1024) / chunk_size).max(1);

    let mut write_buf = AlignedBuffer::new(chunk_size);
    let mut read_buf = AlignedBuffer::new(chunk_size);
    let mut integrity_errors: u64 = 0;
    let mut bytes_written: u64 = 0;

    struct DriveThermalState {
        last_poll: Instant,
        cur_temp: Option<i32>,
        peak_temp: Option<i32>,
        warning: bool,
        cutoff_triggered: bool,
        drive_idx: Option<u32>,
    }
    impl DriveThermalState {
        fn poll(&mut self, mount_hint: Option<&str>, force: bool) -> bool {
            if !force && self.last_poll.elapsed() < Duration::from_millis(1500) {
                return self.cutoff_triggered;
            }
            self.last_poll = Instant::now();
            if let Some(t) = poll_drive_temp_c(self.drive_idx, mount_hint) {
                self.cur_temp = Some(t);
                self.peak_temp = Some(self.peak_temp.map_or(t, |p| p.max(t)));
                if t >= SSD_TEMP_WARN_C {
                    self.warning = true;
                }
                if t >= SSD_TEMP_CUTOFF_C {
                    self.cutoff_triggered = true;
                    return true;
                }
            }
            false
        }
    }

    let mut drive_thermal = DriveThermalState {
        last_poll: Instant::now() - Duration::from_secs(10),
        cur_temp: None,
        peak_temp: None,
        warning: false,
        cutoff_triggered: false,
        drive_idx,
    };
    drive_thermal.poll(mount_hint_str, true);
    let start_drive_temp = drive_thermal.cur_temp;

    // Phase 1: Sustained Direct-IO Sequential Write (within safe budget + SLC cache curve)
    let mut chunk_speeds: Vec<f64> = Vec::with_capacity(total_chunks);
    let t_sw = Instant::now();
    let mut last_emit = Instant::now();
    let mut win_bytes = 0usize;
    for i in 0..total_chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Storage durability test cancelled.".to_string());
        }
        if drive_thermal.poll(mount_hint_str, false) {
            break;
        }
        fill_block_pattern(write_buf.as_mut_slice(), i as u64);
        let t_chunk = Instant::now();
        file.write_all(write_buf.as_slice()).map_err(|e| e.to_string())?;
        let chunk_secs = t_chunk.elapsed().as_secs_f64().max(0.0002);
        chunk_speeds.push((chunk_size as f64 / (1024.0 * 1024.0)) / chunk_secs);
        bytes_written = bytes_written.saturating_add(chunk_size as u64);
        win_bytes += chunk_size;

        if last_emit.elapsed().as_millis() >= 220 || i + 1 == total_chunks {
            let win_mb_s = (win_bytes as f64 / (1024.0 * 1024.0))
                / last_emit.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "storage:progress",
                StorageBenchProgress {
                    phase: format!(
                        "1/5 Sustained Direct Write ({:.0}/{} MB)",
                        ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0),
                        size_mb
                    ),
                    percent: ((i + 1) as f64 / total_chunks as f64) * 24.0,
                    current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                    elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                    integrity_errors,
                    drive_temp_c: drive_thermal.cur_temp,
                    thermal_warning: drive_thermal.warning,
                },
            );
            win_bytes = 0;
            last_emit = Instant::now();
        }
    }
    if !direct_io && !drive_thermal.cutoff_triggered {
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let sw_secs = t_sw.elapsed().as_secs_f64().max(0.001);
    let seq_write_mb_s = compute_mb_per_sec(bytes_written, sw_secs);
    let (slc_sustained_mb_s, slc_cache_drop_pct, write_stability_pct) =
        compute_slc_cache_metrics(&chunk_speeds);

    let mut seq_read_mb_s = 0.0;
    let mut rand_4k_write_mb_s = 0.0;
    let mut rand_4k_write_iops = 0u64;
    let mut rand_4k_read_mb_s = 0.0;
    let mut rand_4k_read_iops = 0u64;
    let mut avg_4k_latency_ms = 0.0;
    let mut p99_4k_latency_ms = 0.0;
    let mut rand_4k_qd32_read_mb_s = 0.0;
    let mut rand_4k_qd32_write_mb_s = 0.0;
    let mut rand_4k_qd32_read_iops = 0u64;
    let mut rand_4k_qd32_write_iops = 0u64;
    let mut mixed_rw_mb_s = 0.0;
    let mut mixed_rw_iops = 0u64;

    if !drive_thermal.cutoff_triggered {
        // Phase 2: Sustained Direct-IO Sequential Read + Full Byte-for-Byte NAND Integrity Verify
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let t_sr = Instant::now();
        last_emit = Instant::now();
        win_bytes = 0;
        let mut bytes_read: u64 = 0;
        for i in 0..total_chunks {
            if cancel.load(Ordering::Relaxed) {
                return Err("Storage durability test cancelled.".to_string());
            }
            if drive_thermal.poll(mount_hint_str, false) {
                break;
            }
            file.read_exact(read_buf.as_mut_slice()).map_err(|e| e.to_string())?;
            bytes_read = bytes_read.saturating_add(chunk_size as u64);
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
                            "2/5 Direct Read & Surface Verify ({:.0}/{} MB)",
                            ((i + 1) * chunk_size) as f64 / (1024.0 * 1024.0),
                            size_mb
                        ),
                        percent: 24.0 + ((i + 1) as f64 / total_chunks as f64) * 24.0,
                        current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                        elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                        integrity_errors,
                        drive_temp_c: drive_thermal.cur_temp,
                        thermal_warning: drive_thermal.warning,
                    },
                );
                win_bytes = 0;
                last_emit = Instant::now();
            }
        }
        let sr_secs = t_sr.elapsed().as_secs_f64().max(0.001);
        seq_read_mb_s = compute_mb_per_sec(bytes_read, sr_secs);
    }

    let block_4k = 4096u64;
    let max_blocks = (size_mb * 1024 * 1024) / block_4k;
    let mut buf_4k = AlignedBuffer::new(4096);
    fill_block_pattern(buf_4k.as_mut_slice(), 0xABCDEF);
    let mut rng: u64 = 0xCAFE_BABE_DEAD_BEEF;

    if !drive_thermal.cutoff_triggered {
        // Phase 3: Random 4K QD1 Write + Read (budgeted strictly within budget.rand_qd1_write_mb)
        let qd1_ops = ((budget.rand_qd1_write_mb as usize * 1024 * 1024) / 4096).max(256);
        let t_rw = Instant::now();
        last_emit = Instant::now();
        let mut win_ops = 0usize;
        let mut qd1_written_ops = 0usize;

        for i in 0..qd1_ops {
            if cancel.load(Ordering::Relaxed) {
                return Err("Storage durability test cancelled.".to_string());
            }
            if drive_thermal.poll(mount_hint_str, false) {
                break;
            }
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let offset = (rng % max_blocks) * block_4k;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            file.write_all(buf_4k.as_slice()).map_err(|e| e.to_string())?;
            bytes_written = bytes_written.saturating_add(4096);
            qd1_written_ops += 1;
            win_ops += 1;

            if last_emit.elapsed().as_millis() >= 220 || i + 1 == qd1_ops {
                let win_mb_s = ((win_ops * 4096) as f64 / (1024.0 * 1024.0))
                    / last_emit.elapsed().as_secs_f64().max(0.001);
                let _ = app.emit(
                    "storage:progress",
                    StorageBenchProgress {
                        phase: format!("3/5 Random 4K QD1 Write ({}/{})", i + 1, qd1_ops),
                        percent: 48.0 + ((i + 1) as f64 / qd1_ops as f64) * 10.0,
                        current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                        elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                        integrity_errors,
                        drive_temp_c: drive_thermal.cur_temp,
                        thermal_warning: drive_thermal.warning,
                    },
                );
                win_ops = 0;
                last_emit = Instant::now();
            }
        }
        if !direct_io && !drive_thermal.cutoff_triggered {
            file.sync_all().map_err(|e| e.to_string())?;
        }
        let rw_secs = t_rw.elapsed().as_secs_f64().max(0.001);
        rand_4k_write_mb_s =
            (((qd1_written_ops * 4096) as f64 / (1024.0 * 1024.0)) / rw_secs * 10.0).round() / 10.0;
        rand_4k_write_iops = (qd1_written_ops as f64 / rw_secs).round() as u64;

        if !drive_thermal.cutoff_triggered {
            let mut latencies_us = Vec::with_capacity(qd1_ops);
            let t_rr = Instant::now();
            last_emit = Instant::now();
            win_ops = 0;
            let mut qd1_read_ops_done = 0usize;

            for i in 0..qd1_ops {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Storage durability test cancelled.".to_string());
                }
                if drive_thermal.poll(mount_hint_str, false) {
                    break;
                }
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                let offset = (rng % max_blocks) * block_4k;
                let op_t0 = Instant::now();
                file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
                file.read_exact(buf_4k.as_mut_slice()).map_err(|e| e.to_string())?;
                latencies_us.push(op_t0.elapsed().as_micros() as u64);
                qd1_read_ops_done += 1;
                win_ops += 1;

                if last_emit.elapsed().as_millis() >= 220 || i + 1 == qd1_ops {
                    let win_mb_s = ((win_ops * 4096) as f64 / (1024.0 * 1024.0))
                        / last_emit.elapsed().as_secs_f64().max(0.001);
                    let _ = app.emit(
                        "storage:progress",
                        StorageBenchProgress {
                            phase: format!("3/5 Random 4K QD1 Read ({}/{})", i + 1, qd1_ops),
                            percent: 58.0 + ((i + 1) as f64 / qd1_ops as f64) * 12.0,
                            current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                            integrity_errors,
                            drive_temp_c: drive_thermal.cur_temp,
                            thermal_warning: drive_thermal.warning,
                        },
                    );
                    win_ops = 0;
                    last_emit = Instant::now();
                }
            }
            let rr_secs = t_rr.elapsed().as_secs_f64().max(0.001);
            rand_4k_read_mb_s =
                (((qd1_read_ops_done * 4096) as f64 / (1024.0 * 1024.0)) / rr_secs * 10.0).round() / 10.0;
            rand_4k_read_iops = (qd1_read_ops_done as f64 / rr_secs).round() as u64;

            latencies_us.sort_unstable();
            avg_4k_latency_ms = if latencies_us.is_empty() {
                0.0
            } else {
                let sum: u64 = latencies_us.iter().sum();
                ((sum as f64 / latencies_us.len() as f64) / 1000.0 * 100.0).round() / 100.0
            };
            p99_4k_latency_ms = if latencies_us.is_empty() {
                0.0
            } else {
                let p99_idx = ((latencies_us.len() as f64) * 0.99) as usize;
                let v = latencies_us[p99_idx.min(latencies_us.len() - 1)];
                ((v as f64) / 1000.0 * 100.0).round() / 100.0
            };
        }
    }

    if !drive_thermal.cutoff_triggered {
        // Phase 4: 70/30 Mixed R/W Workload (strictly within budget.mixed_write_mb)
        let mixed_write_cap = (budget.mixed_write_mb as usize * 1024 * 1024) / 4096;
        let mixed_total_ops = ((mixed_write_cap * 10) / 3).max(512);
        let mut mixed_writes_done = 0usize;
        let mut mixed_ops_done = 0usize;
        let t_mx = Instant::now();
        last_emit = Instant::now();
        let mut win_ops = 0usize;

        for i in 0..mixed_total_ops {
            if cancel.load(Ordering::Relaxed) {
                return Err("Storage durability test cancelled.".to_string());
            }
            if drive_thermal.poll(mount_hint_str, false) {
                break;
            }
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let offset = (rng % max_blocks) * block_4k;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            if (i % 10) >= 7 && mixed_writes_done < mixed_write_cap {
                file.write_all(buf_4k.as_slice()).map_err(|e| e.to_string())?;
                bytes_written = bytes_written.saturating_add(4096);
                mixed_writes_done += 1;
            } else {
                file.read_exact(buf_4k.as_mut_slice()).map_err(|e| e.to_string())?;
            }
            mixed_ops_done += 1;
            win_ops += 1;

            if last_emit.elapsed().as_millis() >= 220 || i + 1 == mixed_total_ops {
                let win_mb_s = ((win_ops * 4096) as f64 / (1024.0 * 1024.0))
                    / last_emit.elapsed().as_secs_f64().max(0.001);
                let _ = app.emit(
                    "storage:progress",
                    StorageBenchProgress {
                        phase: format!("4/5 Mixed 70/30 R/W ({}/{})", i + 1, mixed_total_ops),
                        percent: 70.0 + ((i + 1) as f64 / mixed_total_ops as f64) * 14.0,
                        current_mb_s: (win_mb_s * 10.0).round() / 10.0,
                        elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                        integrity_errors,
                        drive_temp_c: drive_thermal.cur_temp,
                        thermal_warning: drive_thermal.warning,
                    },
                );
                win_ops = 0;
                last_emit = Instant::now();
            }
        }
        if !direct_io && !drive_thermal.cutoff_triggered {
            file.sync_all().map_err(|e| e.to_string())?;
        }
        let mx_secs = t_mx.elapsed().as_secs_f64().max(0.001);
        mixed_rw_mb_s =
            (((mixed_ops_done * 4096) as f64 / (1024.0 * 1024.0)) / mx_secs * 10.0).round() / 10.0;
        mixed_rw_iops = (mixed_ops_done as f64 / mx_secs).round() as u64;
    }

    drop(file);

    if !drive_thermal.cutoff_triggered {
        // Phase 5: Random 4K Multi-Queue (QD32 simulation across concurrent Direct-IO handles)
        let qd_workers: usize = 8;
        let qd32_write_ops_total = ((budget.rand_qd32_write_mb as usize * 1024 * 1024) / 4096).max(256);
        let qd32_read_ops_total = qd32_write_ops_total.saturating_mul(2);
        let write_per_worker = (qd32_write_ops_total / qd_workers).max(1);
        let read_per_worker = (qd32_read_ops_total / qd_workers).max(1);

        let _ = app.emit(
            "storage:progress",
            StorageBenchProgress {
                phase: "5/5 Random 4K Multi-Queue (QD32 Read/Write)".to_string(),
                percent: 86.0,
                current_mb_s: rand_4k_read_mb_s,
                elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                integrity_errors,
                drive_temp_c: drive_thermal.cur_temp,
                thermal_warning: drive_thermal.warning,
            },
        );

        let qd_read_done = AtomicU64::new(0);
        let qd_write_done = AtomicU64::new(0);
        let tmp_ref = guard.path();

        let t_qd_r = Instant::now();
        std::thread::scope(|s| {
            for w in 0..qd_workers {
                let cancel_ref = &cancel;
                let done_ref = &qd_read_done;
                s.spawn(move || {
                    if let Ok(mut fh) = open_direct_bench_existing_rw(tmp_ref, direct_io) {
                        let mut b = AlignedBuffer::new(4096);
                        let mut wrng = 0x9E37_79B9_7F4A_7C15u64 ^ ((w as u64 + 1) * 0xBF58_476D_1CE4_E5B9);
                        for _ in 0..read_per_worker {
                            if cancel_ref.load(Ordering::Relaxed) {
                                break;
                            }
                            wrng = wrng.wrapping_mul(6364136223846793005).wrapping_add(1);
                            let off = (wrng % max_blocks) * block_4k;
                            if fh.seek(SeekFrom::Start(off)).is_ok()
                                && fh.read_exact(b.as_mut_slice()).is_ok()
                            {
                                done_ref.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                });
            }
        });
        let qd_r_secs = t_qd_r.elapsed().as_secs_f64().max(0.001);
        let r_ops = qd_read_done.load(Ordering::Relaxed);
        rand_4k_qd32_read_mb_s = (((r_ops as f64 * 4096.0) / (1024.0 * 1024.0)) / qd_r_secs * 10.0).round() / 10.0;
        rand_4k_qd32_read_iops = (r_ops as f64 / qd_r_secs).round() as u64;

        check_storage_cancelled(&cancel)?;
        drive_thermal.poll(mount_hint_str, true);

        if !drive_thermal.cutoff_triggered {
            let t_qd_w = Instant::now();
            std::thread::scope(|s| {
                for w in 0..qd_workers {
                    let cancel_ref = &cancel;
                    let done_ref = &qd_write_done;
                    s.spawn(move || {
                        if let Ok(mut fh) = open_direct_bench_existing_rw(tmp_ref, direct_io) {
                            let mut b = AlignedBuffer::new(4096);
                            fill_block_pattern(b.as_mut_slice(), 0x55AA00 + w as u64);
                            let mut wrng = 0xD1B5_4A32_D192_ED03u64 ^ ((w as u64 + 1) * 0x94D0_49BB_1331_11EB);
                            for _ in 0..write_per_worker {
                                if cancel_ref.load(Ordering::Relaxed) {
                                    break;
                                }
                                wrng = wrng.wrapping_mul(6364136223846793005).wrapping_add(1);
                                let off = (wrng % max_blocks) * block_4k;
                                if fh.seek(SeekFrom::Start(off)).is_ok()
                                    && fh.write_all(b.as_slice()).is_ok()
                                {
                                    done_ref.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                            if !direct_io {
                                let _ = fh.sync_all();
                            }
                        }
                    });
                }
            });
            check_storage_cancelled(&cancel)?;
            let qd_w_secs = t_qd_w.elapsed().as_secs_f64().max(0.001);
            let w_ops = qd_write_done.load(Ordering::Relaxed);
            bytes_written = bytes_written.saturating_add(w_ops * 4096);
            rand_4k_qd32_write_mb_s = (((w_ops as f64 * 4096.0) / (1024.0 * 1024.0)) / qd_w_secs * 10.0).round() / 10.0;
            rand_4k_qd32_write_iops = (w_ops as f64 / qd_w_secs).round() as u64;
        }
    }

    drop(guard);

    let peak_drive_temp = drive_thermal.peak_temp;
    let thermal_warning = drive_thermal.warning;
    let thermal_cutoff_triggered = drive_thermal.cutoff_triggered;
    let (seq_write_early_mb_s, seq_write_late_mb_s, write_collapse_pct, temp_rise_c, thermal_throttle_verdict) =
        classify_ssd_write_collapse(&chunk_speeds, start_drive_temp, peak_drive_temp);

    let total_written_mb = (bytes_written + (1024 * 1024 - 1)) / (1024 * 1024);
    let iface = interface_hint.unwrap_or_else(|| "NVMe".into());
    let media = media_hint.unwrap_or_else(|| "SSD".into());
    let baseline = baselines::rate_storage(&iface, &media, seq_read_mb_s, seq_write_mb_s, integrity_errors);

    let ub_cmp = userbenchmark::compare_userbenchmark(&UserBenchmarkInput {
        ssd_interface: Some(iface.clone()),
        ssd_media_type: Some(media.clone()),
        ssd_seq_read_mb_s: Some(seq_read_mb_s),
        ssd_seq_write_mb_s: Some(seq_write_mb_s),
        ssd_rand_4k_read_mb_s: Some(rand_4k_read_mb_s),
        ssd_rand_4k_write_mb_s: Some(rand_4k_write_mb_s),
        ssd_integrity_errors: integrity_errors,
        allow_live_lookup: false,
        ..Default::default()
    });
    let userbenchmark_rating = ub_cmp.ssd;

    let status = if thermal_cutoff_triggered || integrity_errors > 0 || baseline.percent_of_normal < 50.0 {
        TestStatus::Fail
    } else if thermal_warning
        || thermal_throttle_verdict == "SSD_THERMAL_THROTTLE"
        || baseline.percent_of_normal < 80.0
        || p99_4k_latency_ms > 15.0
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let elapsed_secs = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let tier_label = userbenchmark_rating
        .as_ref()
        .map(|u| format!("{} ({:.0}%)", u.vehicle_tier, u.effective_speed_pct))
        .unwrap_or_else(|| baseline.grade.clone());

    let plain_summary = if thermal_cutoff_triggered {
        format!(
            "SSD THERMAL CUTOFF at {}°C (>= {}°C safety limit) after {} MB written — stop heavy writes and inspect NVMe heatsink/airflow.",
            peak_drive_temp.unwrap_or(SSD_TEMP_CUTOFF_C),
            SSD_TEMP_CUTOFF_C,
            total_written_mb
        )
    } else if integrity_errors > 0 {
        format!(
            "FAIL: {} data verification error(s) detected on {} — drive NAND or controller is unreliable.",
            integrity_errors, iface
        )
    } else {
        format!(
            "{} rated {} — Seq {:.0}/{:.0} MB/s, 4K QD32 {}/{} IOPS, 70/30 Mixed {} IOPS, SLC write stability {:.0}% (P99 {:.2}ms, {} MB safe write budget).",
            iface,
            tier_label,
            seq_read_mb_s,
            seq_write_mb_s,
            rand_4k_qd32_read_iops,
            rand_4k_qd32_write_iops,
            mixed_rw_iops,
            write_stability_pct,
            p99_4k_latency_ms,
            total_written_mb
        )
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF at {}°C (>= {}°C) after {} MB written — Direct-IO stopped safely.",
            peak_drive_temp.unwrap_or(SSD_TEMP_CUTOFF_C),
            SSD_TEMP_CUTOFF_C,
            total_written_mb
        )
    } else {
        format!(
            "[{}] Direct-IO {} MB written — Read {:.0} MB/s | Write {:.0} MB/s | QD32 {}/{} IOPS | Mixed {} IOPS | P99 {:.2}ms | {} err",
            baseline.grade,
            total_written_mb,
            seq_read_mb_s,
            seq_write_mb_s,
            rand_4k_qd32_read_iops,
            rand_4k_qd32_write_iops,
            mixed_rw_iops,
            p99_4k_latency_ms,
            integrity_errors
        )
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
        elapsed_secs,
        baseline,
        summary,
        total_written_mb,
        rand_4k_qd32_read_mb_s,
        rand_4k_qd32_write_mb_s,
        rand_4k_qd32_read_iops,
        rand_4k_qd32_write_iops,
        mixed_rw_mb_s,
        mixed_rw_iops,
        slc_sustained_mb_s,
        slc_cache_drop_pct,
        write_stability_pct,
        peak_drive_temp_c: peak_drive_temp,
        thermal_warning,
        thermal_cutoff_triggered,
        userbenchmark_rating,
        plain_summary,
        temp_start_c: start_drive_temp,
        temp_rise_c,
        seq_write_early_mb_s,
        seq_write_late_mb_s,
        write_collapse_pct,
        thermal_throttle_verdict,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_ssd_write_collapse_thermal_vs_slc_vs_steady() {
        let hot_drop = vec![2400.0, 2300.0, 1200.0, 600.0, 400.0, 350.0];
        let (early, late, pct, rise, v) = classify_ssd_write_collapse(&hot_drop, Some(44), Some(72));
        assert_eq!(v, "SSD_THERMAL_THROTTLE");
        assert!(early > 2000.0 && late < 400.0);
        assert!(pct > 80.0);
        assert_eq!(rise, Some(28));

        let cool_slc = vec![2200.0, 2100.0, 1400.0, 900.0, 600.0, 550.0];
        let (_, _, _, _, v_slc) = classify_ssd_write_collapse(&cool_slc, Some(40), Some(48));
        assert_eq!(v_slc, "SLC_CACHE_DROP");

        let steady = vec![2000.0, 1980.0, 1950.0, 1920.0, 1910.0, 1900.0];
        let (_, _, _, _, v_ok) = classify_ssd_write_collapse(&steady, Some(42), Some(50));
        assert_eq!(v_ok, "STEADY");
    }

    #[test]
    fn test_ssd_write_budget_caps_across_presets() {
        for (preset, max_mb) in [
            ("quick", SSD_WRITE_BUDGET_QUICK_MB),
            ("standard", SSD_WRITE_BUDGET_STD_MB),
            ("burnin", SSD_WRITE_BUDGET_MAX_MB),
        ] {
            let b = compute_ssd_write_budget(preset);
            assert_eq!(b.total_budget_mb, max_mb);
            assert!(b.total_budget_mb <= 512);
            let sum = b.seq_mb + b.rand_qd1_write_mb + b.rand_qd32_write_mb + b.mixed_write_mb;
            assert!(sum <= b.total_budget_mb, "sum {} exceeded {}", sum, b.total_budget_mb);
            assert!(b.seq_mb > 0 && b.rand_qd1_write_mb > 0 && b.rand_qd32_write_mb > 0 && b.mixed_write_mb > 0);
        }
    }

    #[test]
    fn test_free_space_guard_enforces_4x_budget_and_2gb_floor() {
        assert!(validate_free_space_mb(2047, 128).is_err());
        assert!(validate_free_space_mb(2048, 128).is_ok());
        assert!(validate_free_space_mb(2047, 512).is_err());
        assert!(validate_free_space_mb(2048, 512).is_ok());
        assert!(validate_free_space_mb(4095, 1024).is_err());
        assert!(validate_free_space_mb(4096, 1024).is_ok());
    }

    #[test]
    fn test_temp_file_guard_drop_on_return_error_and_panic() {
        let pid = std::process::id();
        let p_ok = std::env::temp_dir().join(format!("lb_guard_ok_{}.tmp", pid));
        {
            let _g = TempFileGuard(p_ok.clone());
            fs::write(&p_ok, b"ok").unwrap();
            assert!(p_ok.exists());
        }
        assert!(!p_ok.exists());

        let p_err = std::env::temp_dir().join(format!("lb_guard_err_{}.tmp", pid));
        let res: Result<(), ()> = (|| {
            let _g = TempFileGuard(p_err.clone());
            fs::write(&p_err, b"err").unwrap();
            assert!(p_err.exists());
            Err(())
        })();
        assert!(res.is_err());
        assert!(!p_err.exists());

        let p_panic = std::env::temp_dir().join(format!("lb_guard_panic_{}.tmp", pid));
        let panic_res = std::panic::catch_unwind(|| {
            let _g = TempFileGuard(p_panic.clone());
            fs::write(&p_panic, b"panic").unwrap();
            assert!(p_panic.exists());
            panic!("simulated abort");
        });
        assert!(panic_res.is_err());
        assert!(!p_panic.exists());
    }

    #[test]
    fn test_nvme_smart_log_0x02_parsing_and_drivedx_rules() {
        let mut log = vec![0u8; 512];
        log[0] = 0x05; // bit 0 spare below threshold + bit 2 reliability degraded
        let temp_k: u16 = 273 + 76; // 76°C
        log[1..3].copy_from_slice(&temp_k.to_le_bytes());
        log[3] = 8; // available spare 8%
        log[4] = 10; // available spare threshold 10%
        log[5] = 115; // 115% used (>100% preserved in percentage_used_raw!)
        let duw: u128 = 200_000; // 200k * 512KB = 102.4 GB
        log[48..64].copy_from_slice(&duw.to_le_bytes());
        log[112..120].copy_from_slice(&42u64.to_le_bytes());
        log[128..136].copy_from_slice(&1234u64.to_le_bytes());
        log[144..152].copy_from_slice(&7u64.to_le_bytes());
        log[160..168].copy_from_slice(&0u64.to_le_bytes());

        let parsed = parse_nvme_smart_log_0x02(&log).unwrap();
        assert_eq!(parsed.temperature_c, Some(76));
        assert_eq!(parsed.available_spare_pct, Some(8));
        assert_eq!(parsed.available_spare_threshold_pct, Some(10));
        assert_eq!(parsed.percentage_used_raw, Some(115));
        assert_eq!(parsed.critical_warning_flags.len(), 2);
        assert_eq!(parsed.power_cycles, Some(42));
        assert_eq!(parsed.power_on_hours, Some(1234));
        assert_eq!(parsed.unsafe_shutdowns, Some(7));
        assert_eq!(parsed.tbw_gb, Some(102.4));

        let (st_fail, _, _) = evaluate_drive_smart_status(
            false,
            "Healthy",
            parsed.critical_warning,
            &parsed.critical_warning_flags,
            Some(0),
            parsed.available_spare_pct,
            parsed.available_spare_threshold_pct,
            parsed.media_errors,
            parsed.temperature_c,
            parsed.tbw_gb,
            parsed.unsafe_shutdowns,
            parsed.power_on_hours,
            true,
        );
        assert_eq!(st_fail, TestStatus::Fail);

        // 75°C triggers Warn; 82°C triggers Fail
        let (st_warn, _, _) = evaluate_drive_smart_status(
            false,
            "Healthy",
            0,
            &[],
            Some(95),
            Some(100),
            Some(10),
            Some(0),
            Some(75),
            Some(12000.0),
            Some(2),
            Some(400),
            true,
        );
        assert_eq!(st_warn, TestStatus::Warn);

        let (st_hot_fail, _, _) = evaluate_drive_smart_status(
            false,
            "Healthy",
            0,
            &[],
            Some(95),
            Some(100),
            Some(10),
            Some(0),
            Some(82),
            Some(12000.0),
            Some(2),
            Some(400),
            true,
        );
        assert_eq!(st_hot_fail, TestStatus::Fail);
    }

    #[test]
    fn test_slc_cache_stability_metrics() {
        let flat = [2000.0, 2000.0, 2000.0, 2000.0, 2000.0, 2000.0, 2000.0, 2000.0];
        let (sust, drop, stab) = compute_slc_cache_metrics(&flat);
        assert_eq!(sust, 2000.0);
        assert_eq!(drop, 0.0);
        assert_eq!(stab, 100.0);

        let exhausted = [2400.0, 2400.0, 1600.0, 1200.0, 600.0, 600.0, 600.0, 600.0];
        let (sust2, drop2, stab2) = compute_slc_cache_metrics(&exhausted);
        assert_eq!(sust2, 600.0);
        assert_eq!(drop2, 75.0);
        assert_eq!(stab2, 25.0);
    }

    #[test]
    fn test_partial_seq_read_mb_s_uses_actual_bytes_read() {
        // Early abort after 1 chunk (4 MB) out of 96 MB in 0.5s must report 8.0 MB/s, not 192.0 MB/s
        assert_eq!(compute_mb_per_sec(4 * 1024 * 1024, 0.5), 8.0);
        assert_eq!(compute_mb_per_sec(0, 0.5), 0.0);
    }

    #[test]
    fn test_post_phase_cancellation_guard_rejects_cancelled_scope() {
        let cancel = AtomicBool::new(false);
        assert!(check_storage_cancelled(&cancel).is_ok());

        std::thread::scope(|s| {
            let cancel_ref = &cancel;
            s.spawn(move || {
                cancel_ref.store(true, Ordering::Relaxed);
            });
        });

        let res = check_storage_cancelled(&cancel);
        assert_eq!(res, Err("Storage durability test cancelled.".to_string()));
    }
}

fn check_storage_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("Storage durability test cancelled.".to_string())
    } else {
        Ok(())
    }
}
