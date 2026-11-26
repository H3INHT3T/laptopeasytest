//! Auto-Detect Portable USB Local Storage Mode (v3.1.0)
//!
//! When LaptopBench QC runs from a removable USB drive, uses a `portable` filename
//! (e.g. `LaptopBench.QC_3.1.0_x64-portable.exe`), or finds a `portable.txt` marker
//! file beside the executable, all shop data (Shop Profile/Logo, QC Warranty Archive,
//! Shop Model History, Resumable Sessions, and Default Reports) automatically save into
//! `./LaptopBench_Data/` next to the executable — leaving zero trace on customer laptops.
//! Standard installed builds (Setup `.exe` / `.msi` / `/Applications`) continue using
//! OS-standard `AppData` and `Documents` directories.

use crate::types::PortableStorageInfo;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
struct PortableDetection {
    is_portable: bool,
    reason: String,
    portable_root: Option<PathBuf>,
}

/// Pure, cross-platform decision logic for Portable USB Mode.
pub(crate) fn evaluate_portable_mode(
    exe_path: &Path,
    is_removable_drive: bool,
    has_marker_file: bool,
) -> (bool, &'static str) {
    if has_marker_file {
        return (true, "portable.txt marker");
    }
    if is_removable_drive {
        return (true, "Removable USB drive");
    }
    if let Some(name) = exe_path.file_name().and_then(|s| s.to_str()) {
        if name.to_ascii_lowercase().contains("portable") {
            return (true, "Portable executable filename");
        }
    }
    (false, "Standard installed mode")
}

#[cfg(target_os = "windows")]
fn is_exe_on_removable_drive(exe_path: &Path) -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
    }
    const DRIVE_REMOVABLE: u32 = 2;

    let s = exe_path.to_string_lossy();
    let trimmed = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        let root = format!("{}:\\", bytes[0] as char);
        let wide: Vec<u16> = OsStr::new(&root)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dtype = unsafe { GetDriveTypeW(wide.as_ptr()) };
        return dtype == DRIVE_REMOVABLE;
    }
    false
}

#[cfg(target_os = "macos")]
fn is_exe_on_removable_drive(exe_path: &Path) -> bool {
    let s = exe_path.to_string_lossy();
    s.starts_with("/Volumes/") && !s.starts_with("/Volumes/Macintosh HD")
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn is_exe_on_removable_drive(exe_path: &Path) -> bool {
    let s = exe_path.to_string_lossy();
    s.starts_with("/media/") || s.starts_with("/run/media/") || s.starts_with("/mnt/")
}

fn ensure_writable_dir(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".lbqc_write_probe");
    if fs::write(&probe, b"ok").is_ok() {
        let _ = fs::remove_file(&probe);
        true
    } else {
        false
    }
}

fn cached_detection() -> &'static PortableDetection {
    static DETECTED: OnceLock<PortableDetection> = OnceLock::new();
    DETECTED.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else {
            return PortableDetection {
                is_portable: false,
                reason: "Standard installed mode".into(),
                portable_root: None,
            };
        };
        let Some(exe_dir) = exe.parent() else {
            return PortableDetection {
                is_portable: false,
                reason: "Standard installed mode".into(),
                portable_root: None,
            };
        };

        let has_marker = exe_dir.join("portable.txt").exists()
            || exe_dir.join("portable.flag").exists();
        let is_removable = is_exe_on_removable_drive(&exe);
        let (want_portable, reason) = evaluate_portable_mode(&exe, is_removable, has_marker);

        if want_portable {
            let candidate = exe_dir.join("LaptopBench_Data");
            if ensure_writable_dir(&candidate) {
                return PortableDetection {
                    is_portable: true,
                    reason: reason.to_string(),
                    portable_root: Some(candidate),
                };
            }
            return PortableDetection {
                is_portable: false,
                reason: "Read-only volume fallback (AppData)".into(),
                portable_root: None,
            };
        }

        PortableDetection {
            is_portable: false,
            reason: reason.to_string(),
            portable_root: None,
        }
    })
}

/// Resolves config directory (`shop_profile.json`, `shop_model_history.json`, `sessions/`).
pub fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = cached_detection().portable_root.as_ref() {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        return Ok(root.clone());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Resolves persistent data directory (`qc_archive.json`).
pub fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(root) = cached_detection().portable_root.as_ref() {
        let _ = fs::create_dir_all(root);
        return root.clone();
    }
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LaptopBenchQC"));
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Resolves default QC Certificate Reports directory.
pub fn resolve_default_reports_dir() -> PathBuf {
    if let Some(root) = cached_detection().portable_root.as_ref() {
        return root.join("Reports");
    }
    dirs::document_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("LaptopBenchQC")
        .join("Reports")
}

/// Returns Portable USB Mode status for the UI badge and PreReportModal.
pub fn get_portable_mode_info(app: &AppHandle) -> PortableStorageInfo {
    let det = cached_detection();
    let data_dir = resolve_data_dir(app).to_string_lossy().to_string();
    let reports_dir = resolve_default_reports_dir().to_string_lossy().to_string();
    PortableStorageInfo {
        is_portable: det.is_portable,
        reason: det.reason.clone(),
        data_dir,
        reports_dir,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evaluate_portable_mode_rules() {
        let installed = Path::new(r"C:\Program Files\LaptopBench QC\laptopbench-qc.exe");
        assert_eq!(
            evaluate_portable_mode(installed, false, false),
            (false, "Standard installed mode")
        );

        let usb_exe = Path::new(r"E:\Tools\laptopbench-qc.exe");
        assert_eq!(
            evaluate_portable_mode(usb_exe, true, false),
            (true, "Removable USB drive")
        );

        let portable_name = Path::new(r"D:\Bench\LaptopBench.QC_3.1.0_x64-portable.exe");
        assert_eq!(
            evaluate_portable_mode(portable_name, false, false),
            (true, "Portable executable filename")
        );

        let marker = Path::new(r"C:\ShopBench\laptopbench-qc.exe");
        assert_eq!(
            evaluate_portable_mode(marker, false, true),
            (true, "portable.txt marker")
        );
    }
}
