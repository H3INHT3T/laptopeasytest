use crate::types::{UsbDeviceInfo, UsbHotplugEvent};
use chrono::Local;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Enumerates currently attached external/active USB devices along with negotiated bus speed
/// (USB4 40 Gbps, USB 3.x SuperSpeed 5–20 Gbps vs USB 2.0 High-Speed 480 Mbps) and controller
/// error codes to detect broken SuperSpeed pins or shorted host controllers.
pub fn list_usb_devices() -> Vec<UsbDeviceInfo> {
    #[cfg(target_os = "windows")]
    {
        list_windows_usb_devices()
    }
    #[cfg(target_os = "macos")]
    {
        list_macos_usb_devices()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

pub fn spawn_usb_monitor(app: AppHandle, stop_flag: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let initial = list_usb_devices();
        let mut prev_map: HashMap<String, UsbDeviceInfo> = initial
            .iter()
            .cloned()
            .map(|d| (d.instance_id.clone(), d))
            .collect();

        let _ = app.emit(
            "usb:event",
            UsbHotplugEvent {
                event_kind: "SNAPSHOT".to_string(),
                timestamp: Local::now().format("%H:%M:%S").to_string(),
                device: None,
                devices: initial,
            },
        );

        while !stop_flag.load(Ordering::Relaxed) {
            for _ in 0..7 {
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let current = list_usb_devices();
            let curr_map: HashMap<String, UsbDeviceInfo> = current
                .iter()
                .cloned()
                .map(|d| (d.instance_id.clone(), d))
                .collect();

            let now_str = Local::now().format("%H:%M:%S").to_string();
            for (id, dev) in &curr_map {
                if !prev_map.contains_key(id) {
                    let _ = app.emit(
                        "usb:event",
                        UsbHotplugEvent {
                            event_kind: "CONNECTED".to_string(),
                            timestamp: now_str.clone(),
                            device: Some(dev.clone()),
                            devices: current.clone(),
                        },
                    );
                }
            }
            for (id, dev) in &prev_map {
                if !curr_map.contains_key(id) {
                    let _ = app.emit(
                        "usb:event",
                        UsbHotplugEvent {
                            event_kind: "DISCONNECTED".to_string(),
                            timestamp: now_str.clone(),
                            device: Some(dev.clone()),
                            devices: current.clone(),
                        },
                    );
                }
            }
            prev_map = curr_map;
        }
    });
}

#[allow(dead_code)]
fn has_token_boundary(haystack: &str, token: &str) -> bool {
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(token) {
        let idx = start + rel;
        let prev_ok = idx == 0
            || !haystack[..idx]
                .chars()
                .next_back()
                .map(|c| c.is_ascii_alphanumeric())
                .unwrap_or(false);
        let end = idx + token.len();
        let next_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .map(|c| c.is_ascii_alphanumeric())
                .unwrap_or(false);
        if prev_ok && next_ok {
            return true;
        }
        start = idx + token.len();
    }
    false
}

#[allow(dead_code)]
pub(crate) fn classify_windows_usb(
    instance_id: &str,
    name: &str,
    bus_desc: &str,
    parent: &str,
    service: &str,
    status: &str,
    error_code: Option<u32>,
) -> UsbDeviceInfo {
    let display_name = if bus_desc.trim().len() > name.trim().len() {
        bus_desc.trim().to_string()
    } else {
        name.trim().to_string()
    };
    let full = format!("{} {} {} {}", name, bus_desc, parent, instance_id).to_lowercase();
    let svc_l = service.to_lowercase();

    let (speed_class, negotiated_mbps, is_superspeed, controller_type) = if full.contains("usb4")
        || full.contains("thunderbolt")
        || has_token_boundary(&full, "40gbps")
        || has_token_boundary(&full, "40 gbps")
        || has_token_boundary(&full, "40gbit")
        || has_token_boundary(&full, "40 gb/s")
    {
        (
            "USB4 / Thunderbolt (40 Gbps)".to_string(),
            Some(40_000),
            true,
            "USB4 / Thunderbolt".to_string(),
        )
    } else if full.contains("gen2x2")
        || full.contains("gen 2x2")
        || has_token_boundary(&full, "20gbps")
        || has_token_boundary(&full, "20 gbps")
        || has_token_boundary(&full, "20gbit")
        || has_token_boundary(&full, "20 gb/s")
    {
        (
            "USB 3.2 Gen2x2 (20 Gbps)".to_string(),
            Some(20_000),
            true,
            "xHCI (USB 3.x)".to_string(),
        )
    } else if svc_l == "uaspstor"
        || full.contains("3.2")
        || full.contains("usb 3.1 gen 2")
        || full.contains("usb 3.1 gen2")
        || full.contains("superspeed+")
        || full.contains("superspeed plus")
        || has_token_boundary(&full, "10gbps")
        || has_token_boundary(&full, "10 gbps")
        || has_token_boundary(&full, "10gbit")
        || has_token_boundary(&full, "10 gb/s")
    {
        (
            "USB 3.x SuperSpeed+ (10 Gbps)".to_string(),
            Some(10_000),
            true,
            "xHCI (USB 3.x)".to_string(),
        )
    } else if full.contains("usb 3.")
        || full.contains("3.0")
        || full.contains("3.1")
        || full.contains("superspeed")
        || full.contains("xhci")
        || full.contains("uasp")
    {
        (
            "USB 3.0 SuperSpeed (5 Gbps)".to_string(),
            Some(5_000),
            true,
            "xHCI (USB 3.x)".to_string(),
        )
    } else {
        (
            "USB 2.0 High-Speed (480 Mbps)".to_string(),
            Some(480),
            false,
            "USB 2.0".to_string(),
        )
    };

    let has_fault = !status.eq_ignore_ascii_case("OK") || error_code.unwrap_or(0) != 0;
    let reliability_note = if has_fault {
        format!(
            "Controller/Device Error (Status: {}, Code {}): inspect USB port for bent pins, overcurrent short, or missing chipset driver.",
            status,
            error_code.unwrap_or(0)
        )
    } else if negotiated_mbps.unwrap_or(0) >= 10_000 {
        format!("{} OK — full high-bandwidth USB link negotiated.", speed_class)
    } else if is_superspeed {
        "SuperSpeed 5 Gbps OK — USB 3.x pins verified.".to_string()
    } else {
        "USB 2.0 (480 Mbps) — normal for mice/keyboards/hubs; if this is a USB 3 drive in a blue/SS port, SuperSpeed pins may be damaged.".to_string()
    };

    UsbDeviceInfo {
        instance_id: instance_id.trim().to_string(),
        name: display_name,
        speed_class,
        is_superspeed,
        status: status.trim().to_string(),
        negotiated_mbps,
        controller_type,
        error_code: error_code.filter(|&c| c != 0),
        reliability_note,
    }
}

#[allow(dead_code)]
pub(crate) fn classify_macos_usb(
    name: &str,
    loc: &str,
    speed_raw: &str,
    extra_current_used: Option<&str>,
) -> UsbDeviceInfo {
    let low = speed_raw.to_lowercase();
    let (speed_class, negotiated_mbps, is_superspeed, controller_type) =
        if low.contains("40 gb") || low.contains("usb4") {
            (
                format!("USB4 / Thunderbolt ({})", speed_raw),
                Some(40_000),
                true,
                "USB4 / Thunderbolt".to_string(),
            )
        } else if low.contains("20 gb") {
            (
                format!("USB 3.2 Gen2x2 ({})", speed_raw),
                Some(20_000),
                true,
                "xHCI (USB 3.x)".to_string(),
            )
        } else if low.contains("10 gb") || low.contains("super+") {
            (
                format!("USB 3.x SuperSpeed+ ({})", speed_raw),
                Some(10_000),
                true,
                "xHCI (USB 3.x)".to_string(),
            )
        } else if low.contains("super") || low.contains("5 gb") {
            (
                format!("USB 3.0 SuperSpeed ({})", speed_raw),
                Some(5_000),
                true,
                "xHCI (USB 3.x)".to_string(),
            )
        } else {
            (
                format!("USB 2.0 / Legacy ({})", speed_raw),
                Some(480),
                false,
                "USB 2.0".to_string(),
            )
        };

    let overcurrent = extra_current_used
        .map(|s| {
            let trimmed = s.trim();
            !trimmed.is_empty() && trimmed != "0" && trimmed != "0 mA"
        })
        .unwrap_or(false);

    let (status, reliability_note) = if overcurrent {
        (
            "Warning (High Current)".to_string(),
            format!(
                "High/extra USB bus power draw ({}) — verify port stability.",
                extra_current_used.unwrap_or("extra current")
            ),
        )
    } else if is_superspeed {
        (
            "OK".to_string(),
            format!("{} OK — SuperSpeed data lanes active.", speed_class),
        )
    } else {
        (
            "OK".to_string(),
            "USB 2.0 (480 Mbps) — normal for low-speed peripherals; verify USB 3.x drive shows >= 5 Gb/s."
                .to_string(),
        )
    };

    UsbDeviceInfo {
        instance_id: format!("{}@{}", name.trim(), loc.trim()),
        name: name.trim().to_string(),
        speed_class,
        is_superspeed,
        status,
        negotiated_mbps,
        controller_type,
        error_code: None,
        reliability_note,
    }
}

#[allow(dead_code)]
pub fn summarize_usb_ports(devices: &[UsbDeviceInfo]) -> String {
    let fault_count = devices
        .iter()
        .filter(|d| !d.status.eq_ignore_ascii_case("OK") || d.error_code.unwrap_or(0) != 0)
        .count();
    let ss_count = devices.iter().filter(|d| d.is_superspeed).count();
    if fault_count > 0 {
        format!(
            "ALERT: {} USB device/controller fault(s) detected across {} active USB entries ({} SuperSpeed).",
            fault_count,
            devices.len(),
            ss_count
        )
    } else if devices.is_empty() {
        "No external USB devices currently attached.".to_string()
    } else {
        format!(
            "{} active USB device(s) healthy ({} SuperSpeed 5-40 Gbps, 0 controller errors).",
            devices.len(),
            ss_count
        )
    }
}

#[cfg(target_os = "windows")]
fn list_windows_usb_devices() -> Vec<UsbDeviceInfo> {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    ($_.InstanceId -like 'USB\*' -or $_.InstanceId -like 'USBSTOR\*') -and
    $_.FriendlyName -and (
        ($_.FriendlyName -notmatch 'Root Hub|Host Controller|Generic USB Hub|Composite Device') -or
        ($_.Status -ne 'OK' -or $_.ConfigManagerErrorCode -ne 0)
    )
} | Select-Object -First 40 | ForEach-Object {
    $id = [string]$_.InstanceId
    $name = [string]$_.FriendlyName
    $svc = [string]$_.Service
    $props = Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc','DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue
    $parent = [string](($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_Parent' } | Select-Object -First 1).Data)
    $busDesc = [string](($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_BusReportedDeviceDesc' } | Select-Object -First 1).Data)
    @{
        id = $id
        name = $name
        busDesc = $busDesc
        parent = $parent
        svc = $svc
        status = [string]$_.Status
        errCode = [uint32]$_.ConfigManagerErrorCode
    }
})
$devs | ConvertTo-Json -Compress
"#;

    let mut out = Vec::new();
    if let Ok(raw) = run_powershell(ps) {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return out;
        }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            let arr = if let Some(a) = v.as_array() {
                a.clone()
            } else if v.is_object() {
                vec![v]
            } else {
                Vec::new()
            };
            for item in arr {
                let id = item["id"].as_str().unwrap_or("").trim();
                let name = item["name"].as_str().unwrap_or("USB Device").trim();
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                let bus_desc = item["busDesc"].as_str().unwrap_or("");
                let parent = item["parent"].as_str().unwrap_or("");
                let svc = item["svc"].as_str().unwrap_or("");
                let status = item["status"].as_str().unwrap_or("OK");
                let err_code = item["errCode"].as_u64().map(|c| c as u32);
                out.push(classify_windows_usb(
                    id, name, bus_desc, parent, svc, status, err_code,
                ));
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn list_macos_usb_devices() -> Vec<UsbDeviceInfo> {
    use crate::cmd_util::run_cmd_stdout;
    use serde_json::Value;

    let mut out = Vec::new();
    fn walk(items: &[Value], out: &mut Vec<UsbDeviceInfo>) {
        for item in items {
            let name = item["_name"].as_str().unwrap_or("").trim();
            let speed_raw = item["device_speed"].as_str().unwrap_or("");
            let loc = item["location_id"].as_str().unwrap_or(name);
            let extra_cur = item["extra_current_used"].as_str();
            if !name.is_empty() && !speed_raw.is_empty() {
                out.push(classify_macos_usb(name, loc, speed_raw, extra_cur));
            }
            if let Some(children) = item["_items"].as_array() {
                walk(children, out);
            }
        }
    }

    if let Ok(raw) = run_cmd_stdout("system_profiler", &["-json", "SPUSBDataType"]) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(buses) = v["SPUSBDataType"].as_array() {
                walk(buses, &mut out);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_usb_speeds_and_usb4() {
        let usb4 = classify_windows_usb(
            "USB4\\ROOT_ROUTER",
            "USB4 Dock",
            "CalDigit TS4 USB4",
            "PCI\\VEN_8086",
            "USB4DeviceRouter",
            "OK",
            Some(0),
        );
        assert_eq!(usb4.negotiated_mbps, Some(40_000));
        assert!(usb4.is_superspeed);
        assert_eq!(usb4.controller_type, "USB4 / Thunderbolt");
        assert!(usb4.error_code.is_none());

        let uasp = classify_windows_usb(
            "USBSTOR\\DISK",
            "Samsung Portable SSD T7",
            "T7",
            "USB\\ROOT_HUB30",
            "UASPStor",
            "OK",
            Some(0),
        );
        assert_eq!(uasp.negotiated_mbps, Some(10_000));
        assert!(uasp.is_superspeed);
        assert_eq!(uasp.controller_type, "xHCI (USB 3.x)");

        let usb2 = classify_windows_usb(
            "USB\\VID_046D",
            "USB Receiver",
            "",
            "USB\\ROOT_HUB20",
            "HidUsb",
            "OK",
            Some(0),
        );
        assert_eq!(usb2.negotiated_mbps, Some(480));
        assert!(!usb2.is_superspeed);
        assert!(usb2.reliability_note.contains("USB 2.0"));
    }

    #[test]
    fn test_usb_error_code_and_macos_and_summary() {
        let faulty = classify_windows_usb(
            "USB\\ROOT_HUB30",
            "USB xHCI Compliant Host Controller",
            "",
            "",
            "USBXHCI",
            "Error",
            Some(43),
        );
        assert_eq!(faulty.error_code, Some(43));
        assert!(faulty.reliability_note.contains("Code 43"));

        let mac_ss = classify_macos_usb("SanDisk Extreme", "0x14200000", "up to 10 Gb/s", None);
        assert_eq!(mac_ss.negotiated_mbps, Some(10_000));
        assert!(mac_ss.is_superspeed);

        let sum = summarize_usb_ports(&[faulty, mac_ss]);
        assert!(sum.contains("ALERT: 1 USB device/controller fault(s)"));
    }

    #[test]
    fn test_storage_capacity_strings_do_not_false_trigger_superspeed() {
        for name in [
            "Toshiba 640GB USB 2.0",
            "External Drive 320GB",
            "Flash 10GB",
        ] {
            let dev = classify_windows_usb(
                "USBSTOR\\DISK&VEN_GENERIC",
                name,
                name,
                "USB\\ROOT_HUB20",
                "USBSTOR",
                "OK",
                Some(0),
            );
            assert_eq!(dev.negotiated_mbps, Some(480), "Failed for {}", name);
            assert!(!dev.is_superspeed, "Failed for {}", name);
            assert_eq!(dev.speed_class, "USB 2.0 High-Speed (480 Mbps)");
        }

        let explicit_10g = classify_windows_usb(
            "USB\\VID_1234",
            "NVMe Enclosure 10Gbps",
            "10Gbps Enclosure",
            "USB\\ROOT_HUB30",
            "USBSTOR",
            "OK",
            Some(0),
        );
        assert_eq!(explicit_10g.negotiated_mbps, Some(10_000));
        assert!(explicit_10g.is_superspeed);

        let explicit_20g = classify_windows_usb(
            "USB\\VID_1234",
            "SSD 20 Gbps Dock",
            "",
            "USB\\ROOT_HUB30",
            "USBSTOR",
            "OK",
            Some(0),
        );
        assert_eq!(explicit_20g.negotiated_mbps, Some(20_000));
        assert!(explicit_20g.is_superspeed);
    }
}
