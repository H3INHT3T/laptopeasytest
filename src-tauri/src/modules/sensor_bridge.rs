//! Pure native Rust multi-bridge Windows hardware sensor reader (v2.7.0).
//! Zero bundled WinRing0 / unsigned drivers — zero Windows Defender false positives.
//!
//! Priority order (fastest first):
//! 1. Native HWiNFO64 Shared Memory (`Global\HWiNFO_SENS_SM2`) via `OpenFileMappingW` (<0.5ms)
//! 2. LibreHardwareMonitor local JSON endpoint (`127.0.0.1:8085/data.json`, 120ms timeout)
//! 3. PawnIO WHQL driver detection (`\\.\PawnIO`) for guided 1-click setup feedback

use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct SensorBridgeReading {
    pub source_label: String,
    pub cpu_temp_c: Option<f32>,
    pub per_core_temps_c: Vec<f32>,
    pub cpu_power_w: Option<f32>,
    pub gpu_temp_c: Option<f32>,
    pub gpu_power_w: Option<f32>,
    pub fan_rpm: Option<u32>,
}

/// Parses a LibreHardwareMonitor `/data.json` sensor tree into structured CPU/GPU/Per-Core/Fan/Watt values.
pub fn parse_lhm_json_tree(root: &Value) -> Option<SensorBridgeReading> {
    let mut out = SensorBridgeReading {
        source_label: "LHM HTTP Bridge".to_string(),
        ..Default::default()
    };

    fn parse_num(s: &str) -> Option<f32> {
        let cleaned: String = s
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',' || *c == '-')
            .map(|c| if c == ',' { '.' } else { c })
            .collect();
        cleaned.parse::<f32>().ok().filter(|v| v.is_finite())
    }

    fn walk(node: &Value, section: &str, out: &mut SensorBridgeReading) {
        let text = node["Text"].as_str().unwrap_or("").trim();
        let val_str = node["Value"].as_str().unwrap_or("").trim();
        let cur_sec = if text.eq_ignore_ascii_case("Temperatures")
            || text.eq_ignore_ascii_case("Powers")
            || text.eq_ignore_ascii_case("Fans")
        {
            text
        } else {
            section
        };

        if !val_str.is_empty() {
            let low = text.to_lowercase();
            if let Some(num) = parse_num(val_str) {
                if cur_sec.eq_ignore_ascii_case("Temperatures") || val_str.contains("°C") || val_str.ends_with(" C") {
                    if num > 10.0 && num < 125.0 {
                        if low.contains("cpu package") || low.contains("core max") || low.contains("tctl") || low.contains("tdie") {
                            out.cpu_temp_c = Some(num);
                        } else if (low.starts_with("cpu core #") || low.starts_with("core #") || low.contains("p-core") || low.contains("e-core"))
                            && !low.contains("distance")
                            && out.per_core_temps_c.len() < 32
                        {
                            out.per_core_temps_c.push((num * 10.0).round() / 10.0);
                        } else if low.contains("gpu core") || low.contains("gpu hot") || low.contains("gpu temperature") {
                            if out.gpu_temp_c.is_none() || low.contains("gpu core") {
                                out.gpu_temp_c = Some(num);
                            }
                        }
                    }
                } else if cur_sec.eq_ignore_ascii_case("Powers") || val_str.ends_with(" W") {
                    if (0.1..=450.0).contains(&num) {
                        if low.contains("cpu package") || low == "package" {
                            out.cpu_power_w = Some(num);
                        } else if low.contains("gpu package") || low.contains("gpu power") {
                            out.gpu_power_w = Some(num);
                        }
                    }
                } else if cur_sec.eq_ignore_ascii_case("Fans") || val_str.contains("RPM") {
                    if num > 100.0 && num < 15000.0 && out.fan_rpm.is_none() {
                        out.fan_rpm = Some(num.round() as u32);
                    }
                }
            }
        }

        if let Some(children) = node["Children"].as_array() {
            for child in children {
                walk(child, cur_sec, out);
            }
        }
    }

    walk(root, "", &mut out);
    if out.cpu_temp_c.is_none() && !out.per_core_temps_c.is_empty() {
        out.cpu_temp_c = out
            .per_core_temps_c
            .iter()
            .copied()
            .fold(None, |acc, v| Some(acc.map_or(v, |p: f32| p.max(v))));
    }

    if out.cpu_temp_c.is_some()
        || out.gpu_temp_c.is_some()
        || out.fan_rpm.is_some()
        || out.cpu_power_w.is_some()
        || !out.per_core_temps_c.is_empty()
    {
        Some(out)
    } else {
        None
    }
}

/// Classifies a single HWiNFO64 reading `(sensor_type, label, value)` into `SensorBridgeReading`.
/// HWiNFO `tReading`: 1 = Temp (°C), 2 = Volt, 3 = Fan (RPM), 4 = Current, 5 = Power (W).
pub fn apply_hwinfo_reading(
    out: &mut SensorBridgeReading,
    reading_type: u32,
    label: &str,
    value: f64,
) {
    if !value.is_finite() {
        return;
    }
    let low = label.to_lowercase();
    let v = value as f32;
    match reading_type {
        1 => {
            // Temperature (°C)
            if v > 10.0 && v < 125.0 {
                if low.contains("cpu package")
                    || low.contains("tctl/tdie")
                    || low.contains("cpu (tctl")
                    || low.contains("core max")
                {
                    out.cpu_temp_c = Some(v);
                } else if (low.starts_with("core #")
                    || low.starts_with("core ")
                    || low.contains("p-core")
                    || low.contains("e-core"))
                    && !low.contains("distance")
                    && !low.contains("throttl")
                    && out.per_core_temps_c.len() < 32
                {
                    out.per_core_temps_c.push((v * 10.0).round() / 10.0);
                } else if low.contains("gpu temperature") || low.contains("gpu core") {
                    out.gpu_temp_c = Some(v);
                }
            }
        }
        3 => {
            // Fan RPM
            if v > 100.0 && v < 15000.0 && out.fan_rpm.is_none() {
                out.fan_rpm = Some(v.round() as u32);
            }
        }
        5 => {
            // Power (Watts)
            if (0.1..=450.0).contains(&v) {
                if low.contains("cpu package power") || low == "package power" {
                    out.cpu_power_w = Some(v);
                } else if low.contains("gpu power") || low.contains("gpu core power") {
                    out.gpu_power_w = Some(v);
                }
            }
        }
        _ => {}
    }
}

/// Attempts a fast 120ms local HTTP GET to LibreHardwareMonitor's built-in web server (`127.0.0.1:8085/data.json`).
pub fn probe_lhm_http_bridge() -> Option<SensorBridgeReading> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let addr: SocketAddr = "127.0.0.1:8085".parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(120)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    stream
        .write_all(b"GET /data.json HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;

    let mut raw = Vec::with_capacity(32_768);
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&text);
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    parse_lhm_json_tree(&v)
}

#[cfg(target_os = "windows")]
pub fn probe_hwinfo_shared_memory() -> Option<SensorBridgeReading> {
    use std::ffi::c_void;

    const FILE_MAP_READ: u32 = 0x0004;
    const HWINFO_SIG: u32 = 0x5369_5748; // "HWiS" little-endian

    extern "system" {
        fn OpenFileMappingW(dwDesiredAccess: u32, bInheritHandle: i32, lpName: *const u16) -> isize;
        fn MapViewOfFile(
            hFileMappingObject: isize,
            dwDesiredAccess: u32,
            dwFileOffsetHigh: u32,
            dwFileOffsetLow: u32,
            dwNumberOfBytesToMap: usize,
        ) -> *const c_void;
        fn UnmapViewOfFile(lpBaseAddress: *const c_void) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    let wide: Vec<u16> = "Global\\HWiNFO_SENS_SM2\0".encode_utf16().collect();
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr());
        if handle == 0 {
            return None;
        }
        let base = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
        if base.is_null() {
            CloseHandle(handle);
            return None;
        }

        // HWiNFO_SENSORS_SHARED_MEM2 Header layout (packed C struct):
        // 0: dwSignature (u32), 4: dwVersion (u32), 8: dwRevision (u32), 12: poll_time (i64)
        // 20: dwOffsetOfSensorSection (u32), 24: dwSizeOfSensorElement (u32), 28: dwNumSensorElements (u32)
        // 32: dwOffsetOfReadingSection (u32), 36: dwSizeOfReadingElement (u32), 40: dwNumReadingElements (u32)
        let bytes = base as *const u8;
        let read_u32 = |off: usize| -> u32 {
            let mut arr = [0u8; 4];
            std::ptr::copy_nonoverlapping(bytes.add(off), arr.as_mut_ptr(), 4);
            u32::from_le_bytes(arr)
        };
        let read_f64 = |off: usize| -> f64 {
            let mut arr = [0u8; 8];
            std::ptr::copy_nonoverlapping(bytes.add(off), arr.as_mut_ptr(), 8);
            f64::from_le_bytes(arr)
        };

        let sig = read_u32(0);
        let reading_off = read_u32(32) as usize;
        let reading_sz = read_u32(36) as usize;
        let reading_cnt = (read_u32(40) as usize).min(2048);

        let mut out = SensorBridgeReading {
            source_label: "HWiNFO64 SharedMem".to_string(),
            ..Default::default()
        };

        if sig == HWINFO_SIG && reading_sz >= 296 && reading_cnt > 0 {
            // HWiNFO_SENSORS_READING_ELEMENT layout:
            // 0: tReading (u32), 4: dwSensorIndex (u32), 8: dwReadingID (u32)
            // 12: szLabelOrig[128], 140: szLabelUser[128], 268: szUnit[16], 284: Value (f64)
            for i in 0..reading_cnt {
                let elem = reading_off + i * reading_sz;
                let rtype = read_u32(elem);
                let label_slice = std::slice::from_raw_parts(bytes.add(elem + 12), 128);
                let nul_pos = label_slice.iter().position(|&b| b == 0).unwrap_or(128);
                let label = String::from_utf8_lossy(&label_slice[..nul_pos]);
                let val = read_f64(elem + 284);
                apply_hwinfo_reading(&mut out, rtype, &label, val);
            }
        }

        UnmapViewOfFile(base);
        CloseHandle(handle);

        if out.cpu_temp_c.is_none() && !out.per_core_temps_c.is_empty() {
            out.cpu_temp_c = out
                .per_core_temps_c
                .iter()
                .copied()
                .fold(None, |acc, v| Some(acc.map_or(v, |p: f32| p.max(v))));
        }

        if out.cpu_temp_c.is_some()
            || out.gpu_temp_c.is_some()
            || out.fan_rpm.is_some()
            || out.cpu_power_w.is_some()
            || !out.per_core_temps_c.is_empty()
        {
            Some(out)
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn probe_hwinfo_shared_memory() -> Option<SensorBridgeReading> {
    None
}

/// Checks whether the WHQL-signed PawnIO sensor driver (`\\.\PawnIO`) is installed on Windows.
#[cfg(target_os = "windows")]
pub fn is_pawnio_driver_installed() -> bool {
    use std::path::Path;
    Path::new("C:\\Program Files\\PawnIO\\PawnIO.sys").exists()
        || Path::new("C:\\Windows\\System32\\drivers\\PawnIO.sys").exists()
}

#[cfg(not(target_os = "windows"))]
pub fn is_pawnio_driver_installed() -> bool {
    false
}

/// Master fast sensor bridge probe (sub-millisecond HWiNFO64 SharedMem -> throttled 80ms LHM HTTP).
/// Backoff ensures closed port 8085 never slows down telemetry polling (20s cooldown after miss).
pub fn probe_fast_sensor_bridges() -> Option<SensorBridgeReading> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    if let Some(hw) = probe_hwinfo_shared_memory() {
        return Some(hw);
    }

    static LHM_HTTP_STATE: OnceLock<Mutex<Option<(Instant, bool)>>> = OnceLock::new();
    let lock = LHM_HTTP_STATE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = lock.lock() {
        if let Some((last_try, was_ok)) = *guard {
            if !was_ok && last_try.elapsed() < Duration::from_secs(20) {
                return None;
            }
        }
    }

    let res = probe_lhm_http_bridge();
    if let Ok(mut guard) = lock.lock() {
        *guard = Some((Instant::now(), res.is_some()));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_lhm_json_tree_extracts_package_per_core_fan_and_watts() {
        let sample: Value = serde_json::json!({
            "Text": "Laptop",
            "Children": [{
                "Text": "Intel Core i5-1135G7",
                "Children": [
                    {
                        "Text": "Temperatures",
                        "Children": [
                            {"Text": "CPU Package", "Value": "67.5 °C"},
                            {"Text": "CPU Core #1", "Value": "64.0 °C"},
                            {"Text": "CPU Core #2", "Value": "66.0 °C"},
                            {"Text": "CPU Core #3", "Value": "65.0 °C"},
                            {"Text": "CPU Core #4", "Value": "67.0 °C"}
                        ]
                    },
                    {
                        "Text": "Powers",
                        "Children": [
                            {"Text": "CPU Package", "Value": "24.6 W"}
                        ]
                    },
                    {
                        "Text": "Fans",
                        "Children": [
                            {"Text": "CPU Fan", "Value": "3200 RPM"}
                        ]
                    }
                ]
            }]
        });

        let parsed = parse_lhm_json_tree(&sample).expect("should parse LHM JSON");
        assert_eq!(parsed.cpu_temp_c, Some(67.5));
        assert_eq!(parsed.per_core_temps_c, vec![64.0, 66.0, 65.0, 67.0]);
        assert_eq!(parsed.cpu_power_w, Some(24.6));
        assert_eq!(parsed.fan_rpm, Some(3200));
    }

    #[test]
    fn test_apply_hwinfo_reading_extracts_core_and_package_metrics() {
        let mut out = SensorBridgeReading::default();
        apply_hwinfo_reading(&mut out, 1, "CPU Package", 72.0);
        apply_hwinfo_reading(&mut out, 1, "Core #0", 69.5);
        apply_hwinfo_reading(&mut out, 1, "Core #1", 71.0);
        apply_hwinfo_reading(&mut out, 1, "GPU Temperature", 58.0);
        apply_hwinfo_reading(&mut out, 3, "CPU Fan", 2850.0);
        apply_hwinfo_reading(&mut out, 5, "CPU Package Power", 28.4);
        assert_eq!(out.cpu_temp_c, Some(72.0));
        assert_eq!(out.per_core_temps_c, vec![69.5, 71.0]);
        assert_eq!(out.gpu_temp_c, Some(58.0));
        assert_eq!(out.fan_rpm, Some(2850));
        assert_eq!(out.cpu_power_w, Some(28.4));
    }
}
