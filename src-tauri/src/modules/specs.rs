use crate::cmd_util::is_elevated;
use crate::types::{DiskSpecInfo, DisplaySpecInfo, GpuSpecInfo, RamModuleInfo, SystemSpecs};
use sysinfo::System;

fn detect_gaming_capable(gpus: &[GpuSpecInfo], cpu_brand: &str) -> bool {
    let cpu_l = cpu_brand.to_lowercase();
    if cpu_l.contains("apple m1 pro")
        || cpu_l.contains("apple m1 max")
        || cpu_l.contains("apple m1 ultra")
        || cpu_l.contains("apple m2 pro")
        || cpu_l.contains("apple m2 max")
        || cpu_l.contains("apple m2 ultra")
        || cpu_l.contains("apple m3 pro")
        || cpu_l.contains("apple m3 max")
        || cpu_l.contains("apple m3 ultra")
        || cpu_l.contains("apple m4 pro")
        || cpu_l.contains("apple m4 max")
        || cpu_l.contains("apple m4 ultra")
    {
        return true;
    }

    gpus.iter().any(|g| {
        if g.is_discrete {
            return true;
        }
        let n = g.name.to_lowercase();
        n.contains("nvidia")
            || n.contains("geforce")
            || n.contains("rtx")
            || n.contains("gtx")
            || n.contains("quadro")
            || n.contains("radeon rx")
            || n.contains("radeon pro")
            || n.contains("intel arc")
    })
}

pub fn collect_system_specs() -> SystemSpecs {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let cpu_base_mhz = sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);
    let cpu_physical_cores = sys.physical_core_count().unwrap_or_else(|| sys.cpus().len());
    let cpu_logical_cores = sys.cpus().len();
    let total_ram_gb = (sys.total_memory() as f64) / (1024.0 * 1024.0 * 1024.0);

    let os_family = std::env::consts::OS.to_string();
    let os_name = System::long_os_version().unwrap_or_else(|| os_family.clone());
    let os_version = System::os_version().unwrap_or_default();
    let architecture = std::env::consts::ARCH.to_string();
    let hostname = System::host_name().unwrap_or_else(|| "Unknown".to_string());
    let uptime_seconds = System::uptime();

    #[cfg(target_os = "windows")]
    let (manufacturer, model, serial_number, bios_version, ram_modules, gpus, disks, displays) =
        collect_windows_hardware();

    #[cfg(target_os = "macos")]
    let (manufacturer, model, serial_number, bios_version, ram_modules, gpus, disks, displays) =
        collect_macos_hardware();

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (manufacturer, model, serial_number, bios_version, ram_modules, gpus, disks, displays) = (
        "Unknown".to_string(),
        "Unknown".to_string(),
        "Unknown".to_string(),
        "Unknown".to_string(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    );

    let is_gaming_capable = detect_gaming_capable(&gpus, &cpu_brand);

    SystemSpecs {
        os_family,
        os_name,
        os_version,
        architecture,
        hostname,
        manufacturer,
        model,
        serial_number,
        bios_version,
        cpu_brand,
        cpu_physical_cores,
        cpu_logical_cores,
        cpu_base_mhz,
        total_ram_gb: (total_ram_gb * 100.0).round() / 100.0,
        ram_modules,
        gpus,
        disks,
        displays,
        is_gaming_capable,
        is_elevated: is_elevated(),
        uptime_seconds,
    }
}

#[cfg(target_os = "windows")]
fn collect_windows_hardware() -> (
    String,
    String,
    String,
    String,
    Vec<RamModuleInfo>,
    Vec<GpuSpecInfo>,
    Vec<DiskSpecInfo>,
    Vec<DisplaySpecInfo>,
) {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let script = r#"
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue | Select-Object -First 1
$rams = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        slot = $_.DeviceLocator
        capacity = [double]$_.Capacity
        speed = $_.ConfiguredClockSpeed
        speed2 = $_.Speed
        smbiosType = $_.SMBIOSMemoryType
        manufacturer = $_.Manufacturer
        partNumber = $_.PartNumber
    }
})
$gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        name = $_.Name
        vendor = $_.AdapterCompatibility
        vram = [double]$_.AdapterRAM
        driver = $_.DriverVersion
        resX = $_.CurrentHorizontalResolution
        resY = $_.CurrentVerticalResolution
        refresh = $_.CurrentRefreshRate
    }
})
$disks = @(Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        model = $_.Model
        iface = $_.InterfaceType
        media = $_.MediaType
        size = [double]$_.Size
        serial = $_.SerialNumber
    }
})
$monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
    $nameChars = ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
    @{ name = $nameChars }
})
@{
    manufacturer = if ($cs) { $cs.Manufacturer } else { 'Unknown' }
    model = if ($cs) { $cs.Model } else { 'Unknown' }
    serial = if ($bios) { $bios.SerialNumber } else { 'Unknown' }
    bios = if ($bios) { $bios.SMBIOSBIOSVersion } else { 'Unknown' }
    rams = $rams
    gpus = $gpus
    disks = $disks
    monitors = $monitors
} | ConvertTo-Json -Depth 5 -Compress
"#;

    let mut manufacturer = "Unknown".to_string();
    let mut model = "Unknown".to_string();
    let mut serial = "Unknown".to_string();
    let mut bios = "Unknown".to_string();
    let mut ram_modules = Vec::new();
    let mut gpus = Vec::new();
    let mut disks = Vec::new();
    let mut displays = Vec::new();

    if let Ok(raw) = run_powershell(script) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            manufacturer = v["manufacturer"].as_str().unwrap_or("Unknown").trim().to_string();
            model = v["model"].as_str().unwrap_or("Unknown").trim().to_string();
            serial = v["serial"].as_str().unwrap_or("Unknown").trim().to_string();
            bios = v["bios"].as_str().unwrap_or("Unknown").trim().to_string();

            if let Some(arr) = v["rams"].as_array() {
                for r in arr {
                    let cap_bytes = r["capacity"].as_f64().unwrap_or(0.0);
                    let speed = r["speed"]
                        .as_u64()
                        .or_else(|| r["speed2"].as_u64())
                        .map(|s| s as u32);
                    let mem_type = match r["smbiosType"].as_u64().unwrap_or(0) {
                        20 => "DDR",
                        21 => "DDR2",
                        24 => "DDR3",
                        26 => "DDR4",
                        27 => "LPDDR",
                        28 => "LPDDR2",
                        29 => "LPDDR3",
                        30 => "LPDDR4",
                        34 => "DDR5",
                        35 => "LPDDR5",
                        _ => "RAM",
                    }
                    .to_string();

                    ram_modules.push(RamModuleInfo {
                        slot: r["slot"].as_str().unwrap_or("DIMM").trim().to_string(),
                        capacity_gb: ((cap_bytes / 1_073_741_824.0) * 100.0).round() / 100.0,
                        speed_mhz: speed,
                        memory_type: mem_type,
                        manufacturer: r["manufacturer"].as_str().unwrap_or("Unknown").trim().to_string(),
                        part_number: r["partNumber"].as_str().unwrap_or("").trim().to_string(),
                    });
                }
            }

            if let Some(arr) = v["gpus"].as_array() {
                for g in arr {
                    let name = g["name"].as_str().unwrap_or("GPU").trim().to_string();
                    let vendor = g["vendor"].as_str().unwrap_or("Unknown").trim().to_string();
                    let vram_bytes = g["vram"].as_f64().unwrap_or(0.0);
                    let vram_mb = if vram_bytes > 0.0 {
                        Some((vram_bytes / (1024.0 * 1024.0)).round() as u64)
                    } else {
                        None
                    };
                    let n_l = name.to_lowercase();
                    let is_discrete = (n_l.contains("nvidia")
                        || n_l.contains("geforce")
                        || n_l.contains("rtx")
                        || n_l.contains("gtx")
                        || n_l.contains("radeon rx")
                        || n_l.contains("radeon pro")
                        || n_l.contains("intel arc"))
                        && !n_l.contains("microsoft basic");

                    if let (Some(rx), Some(ry)) = (g["resX"].as_u64(), g["resY"].as_u64()) {
                        if rx > 0 && ry > 0 {
                            displays.push(DisplaySpecInfo {
                                name: format!("Display ({})", name),
                                resolution: format!("{}x{}", rx, ry),
                                refresh_rate_hz: g["refresh"].as_u64().map(|h| h as u32),
                            });
                        }
                    }

                    gpus.push(GpuSpecInfo {
                        name,
                        vendor,
                        vram_mb,
                        driver_version: g["driver"].as_str().unwrap_or("").trim().to_string(),
                        is_discrete,
                    });
                }
            }

            // Enrich display names from WmiMonitorID if available
            if let Some(mons) = v["monitors"].as_array() {
                for (i, m) in mons.iter().enumerate() {
                    let mname = m["name"].as_str().unwrap_or("").trim();
                    if !mname.is_empty() {
                        if let Some(d) = displays.get_mut(i) {
                            d.name = mname.to_string();
                        } else {
                            displays.push(DisplaySpecInfo {
                                name: mname.to_string(),
                                resolution: "Active".to_string(),
                                refresh_rate_hz: None,
                            });
                        }
                    }
                }
            }

            if let Some(arr) = v["disks"].as_array() {
                for d in arr {
                    let size_b = d["size"].as_f64().unwrap_or(0.0);
                    disks.push(DiskSpecInfo {
                        model: d["model"].as_str().unwrap_or("Storage Drive").trim().to_string(),
                        interface_type: d["iface"].as_str().unwrap_or("Unknown").trim().to_string(),
                        media_type: d["media"].as_str().unwrap_or("Fixed Disk").trim().to_string(),
                        size_gb: ((size_b / 1_000_000_000.0) * 10.0).round() / 10.0,
                        serial_number: d["serial"].as_str().unwrap_or("").trim().to_string(),
                    });
                }
            }
        }
    }

    (manufacturer, model, serial, bios, ram_modules, gpus, disks, displays)
}

#[cfg(target_os = "macos")]
fn collect_macos_hardware() -> (
    String,
    String,
    String,
    String,
    Vec<RamModuleInfo>,
    Vec<GpuSpecInfo>,
    Vec<DiskSpecInfo>,
    Vec<DisplaySpecInfo>,
) {
    use crate::cmd_util::run_cmd_stdout;
    use serde_json::Value;

    let mut manufacturer = "Apple Inc.".to_string();
    let mut model = "Mac".to_string();
    let mut serial = "Unknown".to_string();
    let mut bios = "Unknown".to_string();
    let mut ram_modules = Vec::new();
    let mut gpus = Vec::new();
    let mut disks = Vec::new();
    let mut displays = Vec::new();

    if let Ok(raw) = run_cmd_stdout(
        "system_profiler",
        &[
            "-json",
            "SPHardwareDataType",
            "SPMemoryDataType",
            "SPDisplaysDataType",
            "SPNVMeDataType",
            "SPSerialATADataType",
        ],
    ) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(hw) = v["SPHardwareDataType"].as_array().and_then(|a| a.first()) {
                let mname = hw["machine_name"].as_str().unwrap_or("Mac");
                let mid = hw["machine_model"].as_str().unwrap_or("");
                model = if mid.is_empty() {
                    mname.to_string()
                } else {
                    format!("{} ({})", mname, mid)
                };
                serial = hw["serial_number"].as_str().unwrap_or("Unknown").to_string();
                bios = hw["os_loader_version"]
                    .as_str()
                    .or_else(|| hw["boot_rom_version"].as_str())
                    .unwrap_or("Apple Firmware")
                    .to_string();
                manufacturer = "Apple Inc.".to_string();
            }

            if let Some(mem_arr) = v["SPMemoryDataType"].as_array() {
                for m in mem_arr {
                    if let Some(items) = m["_items"].as_array() {
                        for item in items {
                            let sz = item["dimm_size"].as_str().unwrap_or("0 GB");
                            let gb = sz
                                .split_whitespace()
                                .next()
                                .and_then(|n| n.parse::<f64>().ok())
                                .unwrap_or(0.0);
                            ram_modules.push(RamModuleInfo {
                                slot: item["_name"].as_str().unwrap_or("Slot").to_string(),
                                capacity_gb: gb,
                                speed_mhz: item["dimm_speed"]
                                    .as_str()
                                    .and_then(|s| s.split_whitespace().next())
                                    .and_then(|n| n.parse::<u32>().ok()),
                                memory_type: item["dimm_type"].as_str().unwrap_or("Unified/DDR").to_string(),
                                manufacturer: item["dimm_manufacturer"].as_str().unwrap_or("Apple").to_string(),
                                part_number: item["dimm_part_number"].as_str().unwrap_or("").to_string(),
                            });
                        }
                    } else if let Some(mtype) = m["dimm_type"].as_str() {
                        let sz = m["SPMemoryDataType"].as_str().unwrap_or("");
                        let gb = sz
                            .split_whitespace()
                            .next()
                            .and_then(|n| n.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        ram_modules.push(RamModuleInfo {
                            slot: "Unified Memory".to_string(),
                            capacity_gb: gb,
                            speed_mhz: None,
                            memory_type: mtype.to_string(),
                            manufacturer: m["dimm_manufacturer"].as_str().unwrap_or("Apple").to_string(),
                            part_number: String::new(),
                        });
                    }
                }
            }

            if let Some(disp_arr) = v["SPDisplaysDataType"].as_array() {
                for g in disp_arr {
                    let gname = g["sppci_model"]
                        .as_str()
                        .or_else(|| g["_name"].as_str())
                        .unwrap_or("Apple GPU")
                        .to_string();
                    let vendor = g["spdisplays_vendor"].as_str().unwrap_or("Apple").to_string();
                    let cores = g["sppci_cores"].as_str().unwrap_or("");
                    let full_name = if cores.is_empty() {
                        gname.clone()
                    } else {
                        format!("{} ({}-Core)", gname, cores)
                    };
                    let n_l = full_name.to_lowercase();
                    let is_discrete = n_l.contains("radeon")
                        || n_l.contains("nvidia")
                        || n_l.contains("pro")
                        || n_l.contains("max")
                        || n_l.contains("ultra");

                    gpus.push(GpuSpecInfo {
                        name: full_name,
                        vendor,
                        vram_mb: None,
                        driver_version: g["spdisplays_mtlgpufamilysupport"].as_str().unwrap_or("Metal").to_string(),
                        is_discrete,
                    });

                    if let Some(ndrvs) = g["spdisplays_ndrvs"].as_array() {
                        for d in ndrvs {
                            displays.push(DisplaySpecInfo {
                                name: d["_name"].as_str().unwrap_or("Built-in Display").to_string(),
                                resolution: d["_spdisplays_pixels"]
                                    .as_str()
                                    .or_else(|| d["_spdisplays_resolution"].as_str())
                                    .unwrap_or("Retina")
                                    .to_string(),
                                refresh_rate_hz: None,
                            });
                        }
                    }
                }
            }

            for key in ["SPNVMeDataType", "SPSerialATADataType"] {
                if let Some(controllers) = v[key].as_array() {
                    for ctrl in controllers {
                        if let Some(items) = ctrl["_items"].as_array() {
                            for d in items {
                                let size_bytes = d["size_in_bytes"].as_f64().unwrap_or(0.0);
                                disks.push(DiskSpecInfo {
                                    model: d["device_model"]
                                        .as_str()
                                        .or_else(|| d["_name"].as_str())
                                        .unwrap_or("Apple SSD")
                                        .trim()
                                        .to_string(),
                                    interface_type: if key == "SPNVMeDataType" { "NVMe" } else { "SATA" }.to_string(),
                                    media_type: "SSD".to_string(),
                                    size_gb: ((size_bytes / 1_000_000_000.0) * 10.0).round() / 10.0,
                                    serial_number: d["device_serial"].as_str().unwrap_or("").trim().to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    (manufacturer, model, serial, bios, ram_modules, gpus, disks, displays)
}
