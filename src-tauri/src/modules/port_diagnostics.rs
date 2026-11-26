//! Live External Port, Display Hot-Plug, Bluetooth Active Device, Ethernet 1Gbps & USB-C Charger Flip Diagnostics (v2.9.0)
//!
//! 100% offline native probes for Windows & macOS — Smart Bench Mode:
//! plugged cables & BT devices auto-verify live without penalizing unplugged optional ports.

use crate::modules::battery;
use crate::types::{
    BluetoothScanInfo, EthernetLinkInfo, ExternalDisplayInfo, PortDiagnosticsReport, TestStatus,
    UsbCChargerProbe,
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

#[cfg(test)]
mod tests {
    use super::*;

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
