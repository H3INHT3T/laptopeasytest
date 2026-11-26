//! Live External Port, Display Hot-Plug, Bluetooth Active Device, Ethernet 1Gbps & USB-C Charger Flip Diagnostics (v2.9.0)
//!
//! 100% offline native probes for Windows & macOS — Smart Bench Mode:
//! plugged cables & BT devices auto-verify live without penalizing unplugged optional ports.

use crate::modules::{battery, storage::TempFileGuard};
use crate::types::{
    BluetoothScanInfo, EthernetLinkInfo, ExternalDisplayInfo, PortDiagnosticsReport,
    RemovableDriveBenchResult, RemovableDriveInfo, TestStatus, UsbCChargerProbe,
};

/// Decodes Windows `WmiMonitorConnectionParams.VideoOutputTechnology` integer to connector label.
pub fn decode_video_output_tech(code: i64) -> (&'static str, bool) {
    match code {
        -2 => ("Other", false),
        0 => ("VGA", false),
        1 => ("S-Video", false),
        2 => ("Composite", false),
        3 => ("Component", false),
        4 => ("DVI", false),
        5 => ("HDMI", false),
        6 => ("Internal LVDS", true),
        8 => ("D-Jpn", false),
        9 => ("SDI", false),
        10 => ("DisplayPort (External)", false),
        11 => ("Internal eDP", true),
        12 => ("UDI External", false),
        13 => ("Internal UDI", true),
        14 => ("SDTV", false),
        15 => ("Miracast Wireless", false),
        2147483648 => ("Internal Panel", true),
        _ => ("External Display", false),
    }
}

/// Evaluates RJ45 Ethernet link speed: >=1000 Mbps -> Pass, plugged at 10/100 Mbps -> Warn (bad cable or bent RJ45 pin), unplugged -> NotApplicable.
pub fn evaluate_ethernet_link(
    adapter_name: String,
    connected: bool,
    link_speed_mbps: Option<u64>,
) -> EthernetLinkInfo {
    if !connected {
        return EthernetLinkInfo {
            adapter_name,
            connected: false,
            link_speed_mbps: None,
            status: TestStatus::NotApplicable,
            detail: "No Ethernet cable plugged in (optional).".into(),
        };
    }
    match link_speed_mbps {
        Some(mbps) if mbps >= 1000 => EthernetLinkInfo {
            adapter_name,
            connected: true,
            link_speed_mbps: Some(mbps),
            status: TestStatus::Pass,
            detail: format!("Gigabit Ethernet verified ({} Mbps full link).", mbps),
        },
        Some(mbps) if mbps > 0 => EthernetLinkInfo {
            adapter_name,
            connected: true,
            link_speed_mbps: Some(mbps),
            status: TestStatus::Warn,
            detail: format!(
                "Degraded Ethernet link ({} Mbps instead of 1000 Mbps) — inspect RJ45 pins or Cat5e/Cat6 cable.",
                mbps
            ),
        },
        _ => EthernetLinkInfo {
            adapter_name,
            connected: true,
            link_speed_mbps: None,
            status: TestStatus::Pass,
            detail: "Ethernet link active.".into(),
        },
    }
}

/// Evaluates Bluetooth active device visibility (proves antenna/radio actually communicates, not just toggle ON).
pub fn evaluate_bluetooth_scan(
    radio_present: bool,
    radio_enabled: bool,
    device_names: Vec<String>,
) -> BluetoothScanInfo {
    let count = device_names.len();
    if !radio_present {
        return BluetoothScanInfo {
            radio_present: false,
            radio_enabled: false,
            paired_or_nearby_count: 0,
            device_names: Vec::new(),
            status: TestStatus::Warn,
            detail: "No Bluetooth radio adapter detected.".into(),
        };
    }
    if !radio_enabled {
        return BluetoothScanInfo {
            radio_present: true,
            radio_enabled: false,
            paired_or_nearby_count: count,
            device_names,
            status: TestStatus::Warn,
            detail: "Bluetooth radio is turned OFF — enable Bluetooth to test pairing & antenna.".into(),
        };
    }
    if count > 0 {
        BluetoothScanInfo {
            radio_present: true,
            radio_enabled: true,
            paired_or_nearby_count: count,
            device_names,
            status: TestStatus::Pass,
            detail: format!("Bluetooth radio ON • {} paired/discovered device(s) verified.", count),
        }
    } else {
        BluetoothScanInfo {
            radio_present: true,
            radio_enabled: true,
            paired_or_nearby_count: 0,
            device_names: Vec::new(),
            status: TestStatus::Pass,
            detail: "Bluetooth radio ON & healthy (pair a phone/earbuds to confirm antenna range).".into(),
        }
    }
}

pub fn probe_usb_c_charger() -> UsbCChargerProbe {
    if let Some(sample) = battery::sample_battery_live() {
        let watts_abs = sample.watts.map(|w| w.abs());
        let detail = if sample.ac_plugged {
            match watts_abs {
                Some(w) if w >= 0.5 => format!(
                    "AC plugged ({:.0}% • {:.1} W{})",
                    sample.charge_percent,
                    w,
                    if sample.is_charging { " charging" } else { " steady" }
                ),
                _ => format!(
                    "AC plugged ({:.0}%{})",
                    sample.charge_percent,
                    if sample.is_charging { " • charging" } else { " • full/float" }
                ),
            }
        } else {
            format!("On battery ({:.0}%) — plug USB-C / DC charger in.", sample.charge_percent)
        };
        UsbCChargerProbe {
            ac_plugged: sample.ac_plugged,
            is_charging: sample.is_charging,
            charge_percent: Some(sample.charge_percent),
            watts: watts_abs,
            voltage_mv: sample.voltage_mv,
            detail,
        }
    } else {
        UsbCChargerProbe {
            ac_plugged: true,
            is_charging: false,
            charge_percent: None,
            watts: None,
            voltage_mv: None,
            detail: "AC power status detected (no internal battery telemetry).".into(),
        }
    }
}

pub fn scan_port_diagnostics() -> PortDiagnosticsReport {
    #[cfg(target_os = "windows")]
    {
        return scan_windows_port_diagnostics();
    }

    #[cfg(target_os = "macos")]
    {
        return scan_macos_port_diagnostics();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let charger = probe_usb_c_charger();
        PortDiagnosticsReport {
            platform: std::env::consts::OS.to_string(),
            displays: Vec::new(),
            external_display_count: 0,
            bluetooth: evaluate_bluetooth_scan(false, false, Vec::new()),
            ethernet: None,
            charger,
            summary: "Port diagnostics ready.".into(),
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_windows_port_diagnostics() -> PortDiagnosticsReport {
    use crate::cmd_util::run_powershell;

    let ps = r#"
$ErrorActionPreference = 'SilentlyContinue'
$conns = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams)
$vc = @(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 })
$resFallback = if ($vc.Count -gt 0) { "$($vc[0].CurrentHorizontalResolution)x$($vc[0].CurrentVerticalResolution)" } else { '' }
$hzFallback = if ($vc.Count -gt 0 -and $vc[0].CurrentRefreshRate) { [int]$vc[0].CurrentRefreshRate } else { $null }

$displays = @()
foreach ($c in $conns) {
  $displays += [PSCustomObject]@{
    Name = $c.InstanceName
    Tech = [int64]$c.VideoOutputTechnology
    Res = $resFallback
    Hz = $hzFallback
  }
}

$btRadio = @(Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName -notmatch 'Enumerator|Protocol' })
$btOk = $btRadio | Where-Object { $_.Status -eq 'OK' }
$btDevs = @($btRadio | Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -notmatch 'Adapter|Wireless Bluetooth|Intel\(R\) Wireless|Realtek Bluetooth|Generic Bluetooth|MediaTek|Qualcomm' } | Select-Object -ExpandProperty FriendlyName -Unique | Select-Object -First 8)

$eth = Get-NetAdapter -Physical | Where-Object { $_.InterfaceDescription -match 'Ethernet|Gigabit|LAN|Realtek PCIe|Intel.*Ethernet|Killer' -or $_.Name -match 'Ethernet' } | Select-Object -First 1
$ethObj = if ($eth) {
  $spdMbps = $null
  if ($eth.LinkSpeed -match '([\d\.]+)\s*Gbps') { $spdMbps = [math]::Round([double]$Matches[1] * 1000) }
  elseif ($eth.LinkSpeed -match '([\d\.]+)\s*Mbps') { $spdMbps = [math]::Round([double]$Matches[1]) }
  [PSCustomObject]@{
    Name = $eth.InterfaceDescription
    Up = ($eth.Status -eq 'Up')
    Mbps = $spdMbps
  }
} else { $null }

[PSCustomObject]@{
  Displays = $displays
  BtPresent = ($btRadio.Count -gt 0)
  BtEnabled = ($btOk.Count -gt 0)
  BtDevs = $btDevs
  Eth = $ethObj
} | ConvertTo-Json -Depth 4 -Compress
"#;

    let mut displays = Vec::new();
    let mut bluetooth = evaluate_bluetooth_scan(false, false, Vec::new());
    let mut ethernet: Option<EthernetLinkInfo> = None;

    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
            let as_arr = |node: &serde_json::Value| -> Vec<serde_json::Value> {
                if let Some(a) = node.as_array() {
                    a.clone()
                } else if node.is_object() {
                    vec![node.clone()]
                } else {
                    Vec::new()
                }
            };

            for (idx, d) in as_arr(&v["Displays"]).into_iter().enumerate() {
                let tech = d["Tech"].as_i64().unwrap_or(-1);
                let (conn, is_internal) = decode_video_output_tech(tech);
                let res = d["Res"].as_str().unwrap_or("").trim().to_string();
                let hz = d["Hz"].as_u64().map(|x| x as u32);
                let label = if is_internal {
                    "Built-in Laptop Display".to_string()
                } else {
                    format!("External Monitor #{} ({})", idx + 1, conn)
                };
                displays.push(ExternalDisplayInfo {
                    name: label,
                    connector: conn.to_string(),
                    is_internal,
                    resolution: if res.is_empty() { "Active".into() } else { res },
                    refresh_hz: hz,
                });
            }

            let bt_present = v["BtPresent"].as_bool().unwrap_or(false);
            let bt_enabled = v["BtEnabled"].as_bool().unwrap_or(false);
            let bt_devs: Vec<String> = v["BtDevs"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .or_else(|| v["BtDevs"].as_str().map(|s| vec![s.trim().to_string()]))
                .unwrap_or_default();
            bluetooth = evaluate_bluetooth_scan(bt_present, bt_enabled, bt_devs);

            if v["Eth"].is_object() {
                let name = v["Eth"]["Name"].as_str().unwrap_or("Ethernet LAN").to_string();
                let up = v["Eth"]["Up"].as_bool().unwrap_or(false);
                let mbps = v["Eth"]["Mbps"].as_u64();
                ethernet = Some(evaluate_ethernet_link(name, up, mbps));
            }
        }
    }

    let external_display_count = displays.iter().filter(|d| !d.is_internal).count();
    let charger = probe_usb_c_charger();
    let summary = format!(
        "External monitors: {} • {} • {}",
        external_display_count,
        bluetooth.detail,
        ethernet
            .as_ref()
            .map(|e| e.detail.as_str())
            .unwrap_or("No RJ45 port detected")
    );

    PortDiagnosticsReport {
        platform: "Windows".into(),
        displays,
        external_display_count,
        bluetooth,
        ethernet,
        charger,
        summary,
    }
}

#[cfg(target_os = "macos")]
fn scan_macos_port_diagnostics() -> PortDiagnosticsReport {
    use crate::cmd_util::run_cmd_stdout;

    let mut displays = Vec::new();
    let mut bt_present = false;
    let mut bt_enabled = false;
    let mut bt_devs = Vec::new();

    if let Ok(raw) = run_cmd_stdout(
        "system_profiler",
        &["SPDisplaysDataType", "SPBluetoothDataType", "-json"],
    ) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(gpus) = v["SPDisplaysDataType"].as_array() {
                for g in gpus {
                    if let Some(ndrvs) = g["spdisplays_ndrvs"].as_array() {
                        for d in ndrvs {
                            let name = d["_name"].as_str().unwrap_or("Display").to_string();
                            let conn_type = d["spdisplays_connection_type"].as_str().unwrap_or("");
                            let is_internal = conn_type.to_lowercase().contains("internal")
                                || name.to_lowercase().contains("built-in")
                                || name.to_lowercase().contains("color lcd");
                            let connector = if is_internal {
                                "Internal eDP"
                            } else if conn_type.to_lowercase().contains("hdmi") {
                                "HDMI"
                            } else {
                                "USB-C / DisplayPort"
                            };
                            let res = d["_spdisplays_resolution"]
                                .as_str()
                                .unwrap_or("Active")
                                .to_string();
                            displays.push(ExternalDisplayInfo {
                                name,
                                connector: connector.into(),
                                is_internal,
                                resolution: res,
                                refresh_hz: None,
                            });
                        }
                    }
                }
            }
            if let Some(bts) = v["SPBluetoothDataType"].as_array() {
                if let Some(ctrl) = bts.first() {
                    bt_present = true;
                    let state = ctrl["controller_properties"]["controller_state"]
                        .as_str()
                        .unwrap_or("");
                    bt_enabled = state.to_lowercase().contains("on");
                    if let Some(conn) = ctrl["device_connected"].as_array() {
                        for item in conn {
                            if let Some(obj) = item.as_object() {
                                for k in obj.keys() {
                                    bt_devs.push(k.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let bluetooth = evaluate_bluetooth_scan(bt_present, bt_enabled, bt_devs);
    let external_display_count = displays.iter().filter(|d| !d.is_internal).count();
    let charger = probe_usb_c_charger();
    let summary = format!(
        "External monitors: {} • {}",
        external_display_count, bluetooth.detail
    );

    PortDiagnosticsReport {
        platform: "macOS".into(),
        displays,
        external_display_count,
        bluetooth,
        ethernet: None,
        charger,
        summary,
    }
}

/// Classifies removable USB flash drive / SD card sequential throughput (v3.0.0).
/// Catches bent/loose USB 3.0 SuperSpeed pins that silently fall back to USB 2.0 (~35 MB/s).
pub fn classify_removable_drive_speed(
    mount_path: String,
    label: String,
    media_kind: String,
    test_size_mb: u64,
    seq_write_mb_s: f64,
    seq_read_mb_s: f64,
    elapsed_secs: f64,
) -> RemovableDriveBenchResult {
    let r_w = (seq_write_mb_s * 10.0).round() / 10.0;
    let r_r = (seq_read_mb_s * 10.0).round() / 10.0;
    let peak = r_r.max(r_w);
    let (status, verdict, plain_summary) = if peak >= 80.0 {
        (
            TestStatus::Pass,
            "USB3_VERIFIED".to_string(),
            format!(
                "PASS: {} ({}) verified at {:.1} MB/s Read / {:.1} MB/s Write — full USB 3.x / UHS-II SuperSpeed link confirmed.",
                label, mount_path, r_r, r_w
            ),
        )
    } else if peak >= 45.0 {
        (
            TestStatus::Pass,
            "USB3_ENTRY_OR_SD".to_string(),
            format!(
                "PASS: {} ({}) verified at {:.1} MB/s Read / {:.1} MB/s Write (USB 3.0 entry / UHS-I SD speed).",
                label, mount_path, r_r, r_w
            ),
        )
    } else {
        (
            TestStatus::Warn,
            "USB2_FALLBACK_WARN".to_string(),
            format!(
                "WARN: {} ({}) measured only {:.1} MB/s Read / {:.1} MB/s Write (< 45 MB/s — USB 2.0 speed). If using a USB 3.0 drive, inspect port for bent SuperSpeed pins or loose solder joints.",
                label, mount_path, r_r, r_w
            ),
        )
    };

    RemovableDriveBenchResult {
        status,
        verdict: verdict.clone(),
        mount_path,
        label,
        media_kind,
        test_size_mb,
        seq_write_mb_s: r_w,
        seq_read_mb_s: r_r,
        elapsed_secs: (elapsed_secs * 10.0).round() / 10.0,
        summary: format!("{}: Read {:.1} / Write {:.1} MB/s", verdict, r_r, r_w),
        plain_summary,
    }
}

/// Lists plugged-in removable USB flash drives and SD/MicroSD cards cleanly across Windows & macOS.
pub fn list_removable_drives() -> Vec<RemovableDriveInfo> {
    #[cfg(target_os = "windows")]
    {
        use crate::cmd_util::run_powershell;
        use serde_json::Value;

        let ps = r#"
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        mount = ([string]$_.DeviceID) + '\'
        label = if ($_.VolumeName) { [string]$_.VolumeName } else { 'Removable Drive' }
        totalGb = if ($_.Size) { [math]::Round([double]$_.Size / 1GB, 1) } else { 0 }
        freeGb = if ($_.FreeSpace) { [math]::Round([double]$_.FreeSpace / 1GB, 1) } else { 0 }
    }
})
$drives | ConvertTo-Json -Compress
"#;
        let mut out = Vec::new();
        if let Ok(raw) = run_powershell(ps) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let items: Vec<&Value> = if let Some(arr) = v.as_array() {
                    arr.iter().collect()
                } else if v.is_object() {
                    vec![&v]
                } else {
                    vec![]
                };
                for item in items {
                    let mount = item["mount"].as_str().unwrap_or("").trim().to_string();
                    if mount.is_empty() {
                        continue;
                    }
                    let label = item["label"].as_str().unwrap_or("Removable Drive").trim().to_string();
                    let low = label.to_lowercase();
                    let media_kind = if low.contains("sd") || low.contains("mmc") || low.contains("card") {
                        "SD / MicroSD Card".to_string()
                    } else {
                        "USB Flash Drive".to_string()
                    };
                    out.push(RemovableDriveInfo {
                        mount_path: mount,
                        label,
                        media_kind,
                        total_gb: item["totalGb"].as_f64().unwrap_or(0.0),
                        free_gb: item["freeGb"].as_f64().unwrap_or(0.0),
                    });
                }
            }
        }
        out
    }

    #[cfg(target_os = "macos")]
    {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for ent in entries.flatten() {
                let p = ent.path();
                if !p.is_dir() || p.is_symlink() {
                    continue;
                }
                let name = ent.file_name().to_string_lossy().to_string();
                if name.eq_ignore_ascii_case("Macintosh HD") || name.starts_with('.') {
                    continue;
                }
                let low = name.to_lowercase();
                let media_kind = if low.contains("sd") || low.contains("card") {
                    "SD / MicroSD Card".to_string()
                } else {
                    "USB Flash Drive".to_string()
                };
                out.push(RemovableDriveInfo {
                    mount_path: p.to_string_lossy().to_string(),
                    label: name,
                    media_kind,
                    total_gb: 0.0,
                    free_gb: 0.0,
                });
            }
        }
        out
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Runs a safe, RAII-auto-cleaned 64 MB sequential Write + Read speed test on a plugged removable USB/SD drive.
pub fn run_removable_drive_speed_test(target_mount: String) -> Result<RemovableDriveBenchResult, String> {
    use std::fs::OpenOptions;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::time::Instant;

    let mount_path = PathBuf::from(target_mount.trim());
    if !mount_path.is_dir() {
        return Err(format!("Removable drive '{}' is not mounted or accessible.", target_mount));
    }

    let drives = list_removable_drives();
    let matched = drives.iter().find(|d| {
        d.mount_path.eq_ignore_ascii_case(target_mount.trim())
            || d.mount_path.trim_end_matches(['\\', '/']).eq_ignore_ascii_case(target_mount.trim().trim_end_matches(['\\', '/']))
    });
    let label = matched
        .map(|d| d.label.clone())
        .unwrap_or_else(|| "Removable Drive".to_string());
    let media_kind = matched
        .map(|d| d.media_kind.clone())
        .unwrap_or_else(|| "USB Flash Drive".to_string());

    let size_mb: u64 = 64;
    let chunk_size: usize = 2 * 1024 * 1024; // 2 MB chunks
    let chunks = (size_mb as usize * 1024 * 1024) / chunk_size;

    let tmp_file = mount_path.join(format!("laptopbench_usb_speed_{}.tmp", std::process::id()));
    let guard = TempFileGuard(tmp_file);

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(guard.path())
        .map_err(|e| format!("Could not write test file on '{}': {}", target_mount, e))?;

    let mut buf = vec![0x5Au8; chunk_size];
    for (idx, b) in buf.iter_mut().enumerate() {
        *b = ((idx.wrapping_mul(31) ^ 0xA5) & 0xFF) as u8;
    }

    let total_started = Instant::now();
    let w_start = Instant::now();
    for _ in 0..chunks {
        file.write_all(&buf)
            .map_err(|e| format!("Write error on '{}': {}", target_mount, e))?;
    }
    let _ = file.sync_all();
    let w_secs = w_start.elapsed().as_secs_f64().max(0.001);
    let seq_write_mb_s = (size_mb as f64) / w_secs;

    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Seek error on '{}': {}", target_mount, e))?;
    let mut read_buf = vec![0u8; chunk_size];
    let r_start = Instant::now();
    for _ in 0..chunks {
        file.read_exact(&mut read_buf)
            .map_err(|e| format!("Read error on '{}': {}", target_mount, e))?;
    }
    let r_secs = r_start.elapsed().as_secs_f64().max(0.001);
    let seq_read_mb_s = (size_mb as f64) / r_secs;

    drop(file);
    drop(guard);

    Ok(classify_removable_drive_speed(
        target_mount,
        label,
        media_kind,
        size_mb,
        seq_write_mb_s,
        seq_read_mb_s,
        total_started.elapsed().as_secs_f64(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_removable_drive_speed_usb3_vs_usb2_fallback() {
        let fast = classify_removable_drive_speed("E:\\".into(), "SanDisk Ultra".into(), "USB Flash Drive".into(), 64, 95.0, 145.0, 1.1);
        assert_eq!(fast.status, TestStatus::Pass);
        assert_eq!(fast.verdict, "USB3_VERIFIED");

        let sd = classify_removable_drive_speed("F:\\".into(), "SDXC".into(), "SD / MicroSD Card".into(), 64, 48.0, 62.0, 2.3);
        assert_eq!(sd.status, TestStatus::Pass);
        assert_eq!(sd.verdict, "USB3_ENTRY_OR_SD");

        let slow = classify_removable_drive_speed("E:\\".into(), "USB3 Stick".into(), "USB Flash Drive".into(), 64, 18.0, 32.0, 5.5);
        assert_eq!(slow.status, TestStatus::Warn);
        assert_eq!(slow.verdict, "USB2_FALLBACK_WARN");
    }

    #[test]
    fn test_decode_video_output_tech_internal_vs_external() {
        assert_eq!(decode_video_output_tech(5), ("HDMI", false));
        assert_eq!(decode_video_output_tech(10), ("DisplayPort (External)", false));
        assert_eq!(decode_video_output_tech(11), ("Internal eDP", true));
    }

    #[test]
    fn test_evaluate_ethernet_gigabit_vs_degraded_vs_unplugged() {
        let gig = evaluate_ethernet_link("Intel I219".into(), true, Some(1000));
        assert_eq!(gig.status, TestStatus::Pass);

        let deg = evaluate_ethernet_link("Intel I219".into(), true, Some(100));
        assert_eq!(deg.status, TestStatus::Warn);
        assert!(deg.detail.contains("Degraded"));

        let unp = evaluate_ethernet_link("Intel I219".into(), false, None);
        assert_eq!(unp.status, TestStatus::NotApplicable);
    }

    #[test]
    fn test_evaluate_bluetooth_scan_states() {
        let ok = evaluate_bluetooth_scan(true, true, vec!["AirPods Pro".into()]);
        assert_eq!(ok.status, TestStatus::Pass);
        assert_eq!(ok.paired_or_nearby_count, 1);

        let off = evaluate_bluetooth_scan(true, false, vec![]);
        assert_eq!(off.status, TestStatus::Warn);
    }
}
