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
/// (USB 3.x SuperSpeed 5–10+ Gbps vs USB 2.0 High-Speed 480 Mbps) to detect broken SuperSpeed pins!
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

#[cfg(target_os = "windows")]
fn list_windows_usb_devices() -> Vec<UsbDeviceInfo> {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    ($_.InstanceId -like 'USB\*' -or $_.InstanceId -like 'USBSTOR\*') -and
    $_.FriendlyName -and
    $_.FriendlyName -notmatch 'Root Hub|Host Controller|Generic USB Hub|Composite Device'
} | Select-Object -First 40 | ForEach-Object {
    $id = [string]$_.InstanceId
    $name = [string]$_.FriendlyName
    $svc = [string]$_.Service
    $props = Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc','DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue
    $parent = ($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_Parent' } | Select-Object -First 1).Data
    $busDesc = ($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_BusReportedDeviceDesc' } | Select-Object -First 1).Data
    $full = "$name $busDesc $parent".ToLower()
    $isSS = $full -match 'usb 3\.|3\.0|3\.1|3\.2|superspeed|xhci|uasp|uasstor' -or $svc -eq 'UASPStor'
    $speed = if ($svc -eq 'UASPStor' -or $full -match '3\.2|10g|superspeed\+') {
        'USB 3.x SuperSpeed+ (5–10 Gbps)'
    } elseif ($isSS) {
        'USB 3.0 SuperSpeed (5 Gbps)'
    } else {
        'USB 2.0 High-Speed (480 Mbps)'
    }
    @{
        id = $id
        name = if ($busDesc -and $busDesc.Length -gt $name.Length) { [string]$busDesc } else { $name }
        speed = $speed
        isSS = [bool]$isSS
        status = [string]$_.Status
    }
})
$devs | ConvertTo-Json -Compress
"#;

    let mut out = Vec::new();
    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            let arr = if let Some(a) = v.as_array() {
                a.clone()
            } else if v.is_object() {
                vec![v]
            } else {
                Vec::new()
            };
            for item in arr {
                let id = item["id"].as_str().unwrap_or("").trim().to_string();
                let name = item["name"].as_str().unwrap_or("USB Device").trim().to_string();
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                out.push(UsbDeviceInfo {
                    instance_id: id,
                    name,
                    speed_class: item["speed"].as_str().unwrap_or("USB 2.0 (480 Mbps)").to_string(),
                    is_superspeed: item["isSS"].as_bool().unwrap_or(false),
                    status: item["status"].as_str().unwrap_or("OK").to_string(),
                });
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
            if !name.is_empty() && !speed_raw.is_empty() {
                let low = speed_raw.to_lowercase();
                let is_ss = low.contains("super") || low.contains("5 gb") || low.contains("10 gb") || low.contains("20 gb");
                let speed_class = if low.contains("10 gb") || low.contains("20 gb") {
                    format!("USB 3.x SuperSpeed+ ({})", speed_raw)
                } else if is_ss {
                    format!("USB 3.0 SuperSpeed ({})", speed_raw)
                } else {
                    format!("USB 2.0 / Legacy ({})", speed_raw)
                };
                out.push(UsbDeviceInfo {
                    instance_id: format!("{}@{}", name, loc),
                    name: name.to_string(),
                    speed_class,
                    is_superspeed: is_ss,
                    status: "OK".to_string(),
                });
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
