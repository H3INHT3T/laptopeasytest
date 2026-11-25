use crate::cmd_util::is_elevated;
use crate::types::{
    DiskSpecInfo, DisplaySpecInfo, GpuSpecInfo, NetworkAdapterInfo, PeripheralDeviceInfo,
    RamModuleInfo, SystemSpecs, VolumeSpecInfo,
};
use sysinfo::{Disks, System};

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
    let os_build = System::kernel_version().unwrap_or_default();
    let architecture = std::env::consts::ARCH.to_string();
    let hostname = System::host_name().unwrap_or_else(|| "Unknown".to_string());
    let uptime_seconds = System::uptime();

    // Cross-platform logical volumes via sysinfo
    let sys_disks = Disks::new_with_refreshed_list();
    let volumes: Vec<VolumeSpecInfo> = sys_disks
        .list()
        .iter()
        .map(|d| VolumeSpecInfo {
            mount: d.mount_point().to_string_lossy().to_string(),
            label: d.name().to_string_lossy().to_string(),
            file_system: d.file_system().to_string_lossy().to_string(),
            total_gb: ((d.total_space() as f64 / 1_073_741_824.0) * 10.0).round() / 10.0,
            free_gb: ((d.available_space() as f64 / 1_073_741_824.0) * 10.0).round() / 10.0,
        })
        .collect();

    #[cfg(target_os = "windows")]
    let hw = collect_windows_hardware();

    #[cfg(target_os = "macos")]
    let hw = collect_macos_hardware();

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let hw = DetailedHw::default();

    let is_gaming_capable = detect_gaming_capable(&hw.gpus, &cpu_brand);
    let (wifi_ssid, wifi_signal_pct, wifi_rssi_dbm, wifi_radio_type, wifi_antenna_warning) =
        probe_wifi_antenna_rssi();
    let (ram_channel_mode, ram_config_warning) =
        audit_ram_configuration(&hw.ram_modules, hw.ram_slots_total);

    SystemSpecs {
        os_family,
        os_name,
        os_version,
        os_build: if hw.os_build.is_empty() { os_build } else { hw.os_build },
        architecture,
        hostname,
        manufacturer: hw.manufacturer,
        model: hw.model,
        system_sku: hw.system_sku,
        chassis_type: hw.chassis_type,
        serial_number: hw.serial_number,
        system_uuid: hw.system_uuid,
        motherboard_vendor: hw.motherboard_vendor,
        motherboard_product: hw.motherboard_product,
        motherboard_serial: hw.motherboard_serial,
        bios_vendor: hw.bios_vendor,
        bios_version: hw.bios_version,
        bios_date: hw.bios_date,
        cpu_brand,
        cpu_socket: hw.cpu_socket,
        cpu_physical_cores,
        cpu_logical_cores,
        cpu_base_mhz,
        cpu_max_mhz: hw.cpu_max_mhz,
        cpu_l2_kb: hw.cpu_l2_kb,
        cpu_l3_kb: hw.cpu_l3_kb,
        cpu_virtualization: hw.cpu_virtualization,
        total_ram_gb: (total_ram_gb * 100.0).round() / 100.0,
        ram_slots_total: hw.ram_slots_total,
        ram_max_capacity_gb: hw.ram_max_capacity_gb,
        ram_modules: hw.ram_modules,
        gpus: hw.gpus,
        disks: hw.disks,
        volumes,
        displays: hw.displays,
        network_adapters: hw.network_adapters,
        peripherals: hw.peripherals,
        wifi_ssid,
        wifi_signal_pct,
        wifi_rssi_dbm,
        wifi_radio_type,
        wifi_antenna_warning,
        ram_channel_mode,
        ram_config_warning,
        is_gaming_capable,
        is_elevated: is_elevated(),
        uptime_seconds,
    }
}

/// Audits installed RAM DIMMs for single-channel bottlenecks, mismatched speeds (downclocking),
/// or asymmetric capacities (Flex Mode) — common issues in refurbished/upgraded second-hand laptops.
fn audit_ram_configuration(
    modules: &[RamModuleInfo],
    slots_total: Option<u32>,
) -> (Option<String>, Option<String>) {
    if modules.is_empty() {
        return (Some("Unified / Integrated Memory".into()), None);
    }
    if modules.len() == 1 {
        let m = &modules[0];
        let is_unified = m.form_factor.to_lowercase().contains("unified")
            || m.memory_type.to_lowercase().contains("lpddr");
        if !is_unified && slots_total.unwrap_or(2) >= 2 {
            return (
                Some(format!("Single-Channel (1 of {} slots)", slots_total.unwrap_or(2))),
                Some(format!(
                    "SINGLE-CHANNEL BOTTLENECK: Only 1 DIMM ({} GB) installed across {} slots — adding a matched second stick increases iGPU & memory bandwidth up to 40%.",
                    m.capacity_gb,
                    slots_total.unwrap_or(2)
                )),
            );
        }
        return (Some("On-Board / Soldered".into()), None);
    }

    let speeds: Vec<u32> = modules.iter().filter_map(|m| m.speed_mhz).filter(|&s| s > 0).collect();
    let min_spd = speeds.iter().copied().min();
    let max_spd = speeds.iter().copied().max();
    let caps: Vec<u64> = modules.iter().map(|m| m.capacity_gb.round() as u64).collect();
    let asymmetric_cap = caps.windows(2).any(|w| w[0] != w[1]);
    let mismatched_spd = match (min_spd, max_spd) {
        (Some(a), Some(b)) => b.saturating_sub(a) >= 200,
        _ => false,
    };

    let mut warnings = Vec::new();
    if mismatched_spd {
        warnings.push(format!(
            "MISMATCHED RAM SPEEDS ({} MHz vs {} MHz) — faster stick is forced to downclock to {} MHz.",
            max_spd.unwrap_or(0),
            min_spd.unwrap_or(0),
            min_spd.unwrap_or(0)
        ));
    }
    if asymmetric_cap {
        let cap_str = caps.iter().map(|c| format!("{}GB", c)).collect::<Vec<_>>().join(" + ");
        warnings.push(format!(
            "ASYMMETRIC RAM CAPACITY ({}) — running in partial Flex Mode instead of full symmetric Dual-Channel.",
            cap_str
        ));
    }

    let mode = if asymmetric_cap {
        format!("Flex Mode ({}x DIMM)", modules.len())
    } else {
        format!("Dual-Channel Matched ({}x DIMM)", modules.len())
    };

    let warn_opt = if warnings.is_empty() {
        None
    } else {
        Some(warnings.join(" | "))
    };
    (Some(mode), warn_opt)
}

/// Probes connected Wi-Fi RSSI / Signal % to catch disconnected internal M.2 antenna coax cables
/// left unplugged after prior repair or thermal repaste.
fn probe_wifi_antenna_rssi() -> (Option<String>, Option<u32>, Option<i32>, Option<String>, Option<String>) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::cmd_util::run_cmd_stdout("netsh", &["wlan", "show", "interfaces"]) {
            let mut ssid: Option<String> = None;
            let mut signal_pct: Option<u32> = None;
            let mut radio: Option<String> = None;
            for line in out.lines() {
                let t = line.trim();
                if let Some((k, v)) = t.split_once(':') {
                    let key = k.trim().to_lowercase();
                    let val = v.trim();
                    if key == "ssid" && !val.is_empty() {
                        ssid = Some(val.to_string());
                    } else if key == "signal" {
                        let digits: String = val.chars().take_while(|c| c.is_ascii_digit()).collect();
                        if let Ok(p) = digits.parse::<u32>() {
                            signal_pct = Some(p.min(100));
                        }
                    } else if key == "radio type" && !val.is_empty() {
                        radio = Some(val.to_string());
                    }
                }
            }
            let rssi_dbm = signal_pct.map(|p| (p as i32 / 2) - 100);
            let warn = match signal_pct {
                Some(p) if p < 45 => Some(format!(
                    "WEAK WI-FI SIGNAL ({}% / {} dBm) — inspect internal M.2 Wi-Fi antenna coax connectors (MAIN/AUX) for loose or disconnected cable!",
                    p,
                    rssi_dbm.unwrap_or(-85)
                )),
                _ => None,
            };
            return (ssid, signal_pct, rssi_dbm, radio, warn);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = crate::cmd_util::run_cmd_stdout(
            "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
            &["-I"],
        ) {
            let mut ssid: Option<String> = None;
            let mut rssi: Option<i32> = None;
            for line in out.lines() {
                let t = line.trim();
                if let Some((k, v)) = t.split_once(':') {
                    match k.trim() {
                        "SSID" => ssid = Some(v.trim().to_string()),
                        "agrCtlRSSI" => rssi = v.trim().parse::<i32>().ok(),
                        _ => {}
                    }
                }
            }
            let pct = rssi.map(|r| (((r + 100) * 2).clamp(0, 100)) as u32);
            let warn = match rssi {
                Some(r) if r < -77 => Some(format!(
                    "WEAK WI-FI RSSI ({} dBm) — inspect internal AirPort antenna cable!",
                    r
                )),
                _ => None,
            };
            return (ssid, pct, rssi, Some("Apple AirPort 802.11".into()), warn);
        }
    }

    (None, None, None, None, None)
}

#[derive(Default)]
struct DetailedHw {
    os_build: String,
    manufacturer: String,
    model: String,
    system_sku: String,
    chassis_type: String,
    serial_number: String,
    system_uuid: String,
    motherboard_vendor: String,
    motherboard_product: String,
    motherboard_serial: String,
    bios_vendor: String,
    bios_version: String,
    bios_date: String,
    cpu_socket: String,
    cpu_max_mhz: Option<u64>,
    cpu_l2_kb: Option<u64>,
    cpu_l3_kb: Option<u64>,
    cpu_virtualization: Option<bool>,
    ram_slots_total: Option<u32>,
    ram_max_capacity_gb: Option<f64>,
    ram_modules: Vec<RamModuleInfo>,
    gpus: Vec<GpuSpecInfo>,
    disks: Vec<DiskSpecInfo>,
    displays: Vec<DisplaySpecInfo>,
    network_adapters: Vec<NetworkAdapterInfo>,
    peripherals: Vec<PeripheralDeviceInfo>,
}

#[cfg(target_os = "windows")]
fn collect_windows_hardware() -> DetailedHw {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let script = r#"
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue | Select-Object -First 1
$csp = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue | Select-Object -First 1
$enc = Get-CimInstance Win32_SystemEnclosure -ErrorAction SilentlyContinue | Select-Object -First 1
$bb = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -First 1
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$memArr = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue | Select-Object -First 1

$rams = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        slot = [string]$_.DeviceLocator
        capacity = [double]$_.Capacity
        speed = $_.ConfiguredClockSpeed
        speed2 = $_.Speed
        smbiosType = $_.SMBIOSMemoryType
        formFactor = $_.FormFactor
        manufacturer = [string]$_.Manufacturer
        partNumber = [string]$_.PartNumber
        serial = [string]$_.SerialNumber
    }
})

# Exact 64-bit VRAM lookup from Windows display class registry (fixes 4GB WMI uint32 truncation)
$vramMap = @{}
Get-ItemProperty -Path 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -ErrorAction SilentlyContinue | ForEach-Object {
    $desc = [string]$_.DriverDesc
    $qw = $_.'HardwareInformation.qwMemorySize'
    if ($desc -and $qw -gt 0) { $vramMap[$desc.Trim().ToLower()] = [double]$qw }
}

$gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
    $n = [string]$_.Name
    $vram = [double]$_.AdapterRAM
    if ($n -and $vramMap.ContainsKey($n.Trim().ToLower())) {
        $vram = $vramMap[$n.Trim().ToLower()]
    }
    @{
        name = $n
        vendor = [string]$_.AdapterCompatibility
        vram = $vram
        driver = [string]$_.DriverVersion
        driverDate = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' }
        pnp = [string]$_.PNPDeviceID
        resX = $_.CurrentHorizontalResolution
        resY = $_.CurrentVerticalResolution
        refresh = $_.CurrentRefreshRate
    }
})

$disks = @(Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        model = [string]$_.Model
        iface = [string]$_.InterfaceType
        media = [string]$_.MediaType
        size = [double]$_.Size
        serial = [string]$_.SerialNumber
        firmware = [string]$_.FirmwareRevision
    }
})

$monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
    $nameChars = ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
    $mfgChars = ($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
    @{ name = $nameChars; mfg = $mfgChars; inst = [string]$_.InstanceName }
})
$monSize = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue | ForEach-Object {
    @{ wCm = [double]$_.MaxHorizontalImageSize; hCm = [double]$_.MaxVerticalImageSize }
})

$nics = @(Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True" -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        name = [string]$_.Name
        mac = [string]$_.MACAddress
        speed = [double]$_.Speed
        enabled = [bool]$_.NetEnabled
        status = [string]$_.NetConnectionStatus
    }
})

$audio = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | ForEach-Object {
    @{ cat = 'Audio'; name = [string]$_.Name; mfg = [string]$_.Manufacturer; status = [string]$_.Status }
})
$cams = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.PNPClass -in @('Camera','Image') } | ForEach-Object {
    @{ cat = 'Camera'; name = [string]$_.Name; mfg = [string]$_.Manufacturer; status = [string]$_.Status }
})
$bt = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Bluetooth'" -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object {
    @{ cat = 'Bluetooth'; name = [string]$_.Name; mfg = [string]$_.Manufacturer; status = [string]$_.Status }
})
$usb = @(Get-CimInstance Win32_USBController -ErrorAction SilentlyContinue | ForEach-Object {
    @{ cat = 'USB / Thunderbolt'; name = [string]$_.Name; mfg = [string]$_.Manufacturer; status = [string]$_.Status }
})

@{
    osBuild = if ($os) { "$($os.Version) (Build $($os.BuildNumber))" } else { '' }
    manufacturer = if ($cs) { [string]$cs.Manufacturer } else { 'Unknown' }
    model = if ($cs) { [string]$cs.Model } else { 'Unknown' }
    sku = if ($cs -and $cs.SystemSKUNumber) { [string]$cs.SystemSKUNumber } else { '' }
    chassis = if ($enc -and $enc.ChassisTypes) { [int]$enc.ChassisTypes[0] } else { 0 }
    serial = if ($bios) { [string]$bios.SerialNumber } else { 'Unknown' }
    uuid = if ($csp) { [string]$csp.UUID } else { '' }
    mbVendor = if ($bb) { [string]$bb.Manufacturer } else { '' }
    mbProduct = if ($bb) { [string]$bb.Product } else { '' }
    mbSerial = if ($bb) { [string]$bb.SerialNumber } else { '' }
    biosVendor = if ($bios) { [string]$bios.Manufacturer } else { '' }
    biosVer = if ($bios) { [string]$bios.SMBIOSBIOSVersion } else { 'Unknown' }
    biosDate = if ($bios -and $bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { '' }
    cpuSocket = if ($cpu) { [string]$cpu.SocketDesignation } else { '' }
    cpuMaxMhz = if ($cpu) { [uint64]$cpu.MaxClockSpeed } else { 0 }
    cpuL2 = if ($cpu) { [uint64]$cpu.L2CacheSize } else { 0 }
    cpuL3 = if ($cpu) { [uint64]$cpu.L3CacheSize } else { 0 }
    cpuVirt = if ($cpu) { [bool]$cpu.VirtualizationFirmwareEnabled } else { $null }
    ramSlots = if ($memArr) { [uint32]$memArr.MemoryDevices } else { 0 }
    ramMaxKb = if ($memArr) { [double]$memArr.MaxCapacity } else { 0 }
    rams = $rams
    gpus = $gpus
    disks = $disks
    monitors = $monitors
    monSize = $monSize
    nics = $nics
    peripherals = @($audio + $cams + $bt + $usb)
} | ConvertTo-Json -Depth 5 -Compress
"#;

    let mut hw = DetailedHw {
        manufacturer: "Unknown".into(),
        model: "Unknown".into(),
        serial_number: "Unknown".into(),
        bios_version: "Unknown".into(),
        ..Default::default()
    };

    if let Ok(raw) = run_powershell(script) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            hw.os_build = v["osBuild"].as_str().unwrap_or("").trim().to_string();
            hw.manufacturer = v["manufacturer"].as_str().unwrap_or("Unknown").trim().to_string();
            hw.model = v["model"].as_str().unwrap_or("Unknown").trim().to_string();
            hw.system_sku = v["sku"].as_str().unwrap_or("").trim().to_string();
            hw.chassis_type = match v["chassis"].as_u64().unwrap_or(0) {
                8 => "Portable",
                9 => "Laptop",
                10 => "Notebook",
                11 => "Hand Held",
                14 => "Sub Notebook",
                30 => "Tablet",
                31 => "Convertible 2-in-1",
                32 => "Detachable",
                3 | 4 | 6 | 7 => "Desktop",
                _ => "Notebook / PC",
            }
            .to_string();
            hw.serial_number = v["serial"].as_str().unwrap_or("Unknown").trim().to_string();
            hw.system_uuid = v["uuid"].as_str().unwrap_or("").trim().to_string();
            hw.motherboard_vendor = v["mbVendor"].as_str().unwrap_or("").trim().to_string();
            hw.motherboard_product = v["mbProduct"].as_str().unwrap_or("").trim().to_string();
            hw.motherboard_serial = v["mbSerial"].as_str().unwrap_or("").trim().to_string();
            hw.bios_vendor = v["biosVendor"].as_str().unwrap_or("").trim().to_string();
            hw.bios_version = v["biosVer"].as_str().unwrap_or("Unknown").trim().to_string();
            hw.bios_date = v["biosDate"].as_str().unwrap_or("").trim().to_string();

            hw.cpu_socket = v["cpuSocket"].as_str().unwrap_or("").trim().to_string();
            hw.cpu_max_mhz = v["cpuMaxMhz"].as_u64().filter(|&x| x > 0);
            hw.cpu_l2_kb = v["cpuL2"].as_u64().filter(|&x| x > 0);
            hw.cpu_l3_kb = v["cpuL3"].as_u64().filter(|&x| x > 0);
            hw.cpu_virtualization = v["cpuVirt"].as_bool();

            hw.ram_slots_total = v["ramSlots"].as_u64().filter(|&x| x > 0).map(|x| x as u32);
            let max_kb = v["ramMaxKb"].as_f64().unwrap_or(0.0);
            if max_kb > 0.0 {
                hw.ram_max_capacity_gb = Some(((max_kb / (1024.0 * 1024.0)) * 10.0).round() / 10.0);
            }

            if let Some(arr) = v["rams"].as_array() {
                for r in arr {
                    let cap_bytes = r["capacity"].as_f64().unwrap_or(0.0);
                    let speed = r["speed"]
                        .as_u64()
                        .or_else(|| r["speed2"].as_u64())
                        .filter(|&x| x > 0)
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
                    let form_factor = match r["formFactor"].as_u64().unwrap_or(0) {
                        8 => "DIMM",
                        12 => "SO-DIMM",
                        13 => "SRIMM",
                        15 => "FB-DIMM",
                        0 => "Onboard / Soldered",
                        _ => "Module",
                    }
                    .to_string();

                    hw.ram_modules.push(RamModuleInfo {
                        slot: r["slot"].as_str().unwrap_or("DIMM").trim().to_string(),
                        capacity_gb: ((cap_bytes / 1_073_741_824.0) * 100.0).round() / 100.0,
                        speed_mhz: speed,
                        memory_type: mem_type,
                        form_factor,
                        manufacturer: r["manufacturer"].as_str().unwrap_or("Unknown").trim().to_string(),
                        part_number: r["partNumber"].as_str().unwrap_or("").trim().to_string(),
                        serial_number: r["serial"].as_str().unwrap_or("").trim().to_string(),
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
                            hw.displays.push(DisplaySpecInfo {
                                name: format!("Display ({})", name),
                                manufacturer: vendor.clone(),
                                resolution: format!("{}x{}", rx, ry),
                                refresh_rate_hz: g["refresh"].as_u64().map(|h| h as u32),
                                diagonal_inches: None,
                            });
                        }
                    }

                    hw.gpus.push(GpuSpecInfo {
                        name,
                        vendor,
                        vram_mb,
                        driver_version: g["driver"].as_str().unwrap_or("").trim().to_string(),
                        driver_date: g["driverDate"].as_str().unwrap_or("").trim().to_string(),
                        pnp_device_id: g["pnp"].as_str().unwrap_or("").trim().to_string(),
                        is_discrete,
                    });
                }
            }

            let mon_sizes = v["monSize"].as_array().cloned().unwrap_or_default();
            if let Some(mons) = v["monitors"].as_array() {
                for (i, m) in mons.iter().enumerate() {
                    let mname = m["name"].as_str().unwrap_or("").trim();
                    let mmfg = m["mfg"].as_str().unwrap_or("").trim();
                    let diag = mon_sizes.get(i).and_then(|s| {
                        let w = s["wCm"].as_f64().unwrap_or(0.0);
                        let h = s["hCm"].as_f64().unwrap_or(0.0);
                        if w > 5.0 && h > 5.0 {
                            let inches = (w * w + h * h).sqrt() / 2.54;
                            Some((inches * 10.0).round() / 10.0)
                        } else {
                            None
                        }
                    });
                    if let Some(d) = hw.displays.get_mut(i) {
                        if !mname.is_empty() {
                            d.name = mname.to_string();
                        }
                        if !mmfg.is_empty() {
                            d.manufacturer = mmfg.to_string();
                        }
                        d.diagonal_inches = diag;
                    } else if !mname.is_empty() || !mmfg.is_empty() {
                        hw.displays.push(DisplaySpecInfo {
                            name: if mname.is_empty() { "Internal Panel".into() } else { mname.into() },
                            manufacturer: mmfg.into(),
                            resolution: "Active".into(),
                            refresh_rate_hz: None,
                            diagonal_inches: diag,
                        });
                    }
                }
            }

            if let Some(arr) = v["disks"].as_array() {
                for d in arr {
                    let size_b = d["size"].as_f64().unwrap_or(0.0);
                    hw.disks.push(DiskSpecInfo {
                        model: d["model"].as_str().unwrap_or("Storage Drive").trim().to_string(),
                        interface_type: d["iface"].as_str().unwrap_or("Unknown").trim().to_string(),
                        media_type: d["media"].as_str().unwrap_or("Fixed Disk").trim().to_string(),
                        size_gb: ((size_b / 1_000_000_000.0) * 10.0).round() / 10.0,
                        serial_number: d["serial"].as_str().unwrap_or("").trim().to_string(),
                        firmware: d["firmware"].as_str().unwrap_or("").trim().to_string(),
                        partition_style: "GPT/MBR".to_string(),
                    });
                }
            }

            if let Some(arr) = v["nics"].as_array() {
                for n in arr {
                    let name = n["name"].as_str().unwrap_or("").trim().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let nl = name.to_lowercase();
                    let kind = if nl.contains("wi-fi") || nl.contains("wifi") || nl.contains("wireless") || nl.contains("802.11") {
                        "Wi-Fi"
                    } else if nl.contains("bluetooth") {
                        "Bluetooth"
                    } else if nl.contains("ethernet") || nl.contains("gigabit") || nl.contains("pcie") || nl.contains("realtek") || nl.contains("lan") {
                        "Ethernet"
                    } else {
                        "Network"
                    }
                    .to_string();
                    let spd = n["speed"].as_f64().unwrap_or(0.0);
                    let link_speed = if spd >= 1e9 {
                        format!("{:.1} Gbps", spd / 1e9)
                    } else if spd >= 1e6 {
                        format!("{:.0} Mbps", spd / 1e6)
                    } else {
                        "Disconnected".to_string()
                    };
                    let enabled = n["enabled"].as_bool().unwrap_or(false);
                    hw.network_adapters.push(NetworkAdapterInfo {
                        name,
                        kind,
                        mac_address: n["mac"].as_str().unwrap_or("—").to_string(),
                        link_speed,
                        status: if enabled { "Connected".into() } else { "Standby / Disconnected".into() },
                    });
                }
            }

            if let Some(arr) = v["peripherals"].as_array() {
                for p in arr {
                    let name = p["name"].as_str().unwrap_or("").trim().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    hw.peripherals.push(PeripheralDeviceInfo {
                        category: p["cat"].as_str().unwrap_or("Device").to_string(),
                        name,
                        manufacturer: p["mfg"].as_str().unwrap_or("").trim().to_string(),
                        status: p["status"].as_str().unwrap_or("OK").to_string(),
                    });
                }
            }
        }
    }

    hw
}

#[cfg(target_os = "macos")]
fn collect_macos_hardware() -> DetailedHw {
    use crate::cmd_util::run_cmd_stdout;
    use serde_json::Value;

    let mut hw = DetailedHw {
        manufacturer: "Apple Inc.".into(),
        model: "Mac".into(),
        chassis_type: "MacBook / Mac".into(),
        serial_number: "Unknown".into(),
        motherboard_vendor: "Apple Inc.".into(),
        bios_vendor: "Apple Inc.".into(),
        bios_version: "Apple Firmware".into(),
        ..Default::default()
    };

    if let Ok(raw) = run_cmd_stdout(
        "system_profiler",
        &[
            "-json",
            "SPHardwareDataType",
            "SPMemoryDataType",
            "SPDisplaysDataType",
            "SPNVMeDataType",
            "SPSerialATADataType",
            "SPAudioDataType",
            "SPCameraDataType",
            "SPBluetoothDataType",
            "SPAirPortDataType",
            "SPUSBDataType",
        ],
    ) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(hw_j) = v["SPHardwareDataType"].as_array().and_then(|a| a.first()) {
                let mname = hw_j["machine_name"].as_str().unwrap_or("Mac");
                let mid = hw_j["machine_model"].as_str().unwrap_or("");
                hw.model = if mid.is_empty() {
                    mname.to_string()
                } else {
                    format!("{} ({})", mname, mid)
                };
                hw.system_sku = hw_j["model_number"].as_str().unwrap_or("").to_string();
                hw.serial_number = hw_j["serial_number"].as_str().unwrap_or("Unknown").to_string();
                hw.system_uuid = hw_j["platform_UUID"].as_str().unwrap_or("").to_string();
                hw.motherboard_product = mid.to_string();
                hw.bios_version = hw_j["os_loader_version"]
                    .as_str()
                    .or_else(|| hw_j["boot_rom_version"].as_str())
                    .unwrap_or("Apple Firmware")
                    .to_string();
                hw.cpu_socket = hw_j["chip_type"].as_str().unwrap_or("Apple Silicon / Intel").to_string();
            }

            if let Some(mem_arr) = v["SPMemoryDataType"].as_array() {
                for m in mem_arr {
                    if let Some(items) = m["_items"].as_array() {
                        for item in items {
                            let sz = item["dimm_size"].as_str().unwrap_or("0 GB");
                            let gb = sz.split_whitespace().next().and_then(|n| n.parse::<f64>().ok()).unwrap_or(0.0);
                            hw.ram_modules.push(RamModuleInfo {
                                slot: item["_name"].as_str().unwrap_or("Slot").to_string(),
                                capacity_gb: gb,
                                speed_mhz: item["dimm_speed"]
                                    .as_str()
                                    .and_then(|s| s.split_whitespace().next())
                                    .and_then(|n| n.parse::<u32>().ok()),
                                memory_type: item["dimm_type"].as_str().unwrap_or("Unified/DDR").to_string(),
                                form_factor: "SO-DIMM / Unified".to_string(),
                                manufacturer: item["dimm_manufacturer"].as_str().unwrap_or("Apple").to_string(),
                                part_number: item["dimm_part_number"].as_str().unwrap_or("").to_string(),
                                serial_number: item["dimm_serial_number"].as_str().unwrap_or("").to_string(),
                            });
                        }
                    } else if let Some(mtype) = m["dimm_type"].as_str() {
                        let sz = m["SPMemoryDataType"].as_str().unwrap_or("");
                        let gb = sz.split_whitespace().next().and_then(|n| n.parse::<f64>().ok()).unwrap_or(0.0);
                        hw.ram_modules.push(RamModuleInfo {
                            slot: "Unified SoC".to_string(),
                            capacity_gb: gb,
                            speed_mhz: None,
                            memory_type: mtype.to_string(),
                            form_factor: "Unified Package".to_string(),
                            manufacturer: m["dimm_manufacturer"].as_str().unwrap_or("Apple").to_string(),
                            part_number: String::new(),
                            serial_number: String::new(),
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
                    let full_name = if cores.is_empty() { gname } else { format!("{} ({}-Core)", gname, cores) };
                    let n_l = full_name.to_lowercase();
                    let is_discrete = n_l.contains("radeon")
                        || n_l.contains("nvidia")
                        || n_l.contains("pro")
                        || n_l.contains("max")
                        || n_l.contains("ultra");

                    hw.gpus.push(GpuSpecInfo {
                        name: full_name,
                        vendor,
                        vram_mb: None,
                        driver_version: g["spdisplays_mtlgpufamilysupport"].as_str().unwrap_or("Metal").to_string(),
                        driver_date: String::new(),
                        pnp_device_id: g["sppci_bus"].as_str().unwrap_or("Built-In").to_string(),
                        is_discrete,
                    });

                    if let Some(ndrvs) = g["spdisplays_ndrvs"].as_array() {
                        for d in ndrvs {
                            hw.displays.push(DisplaySpecInfo {
                                name: d["_name"].as_str().unwrap_or("Built-in Retina Display").to_string(),
                                manufacturer: "Apple".to_string(),
                                resolution: d["_spdisplays_pixels"]
                                    .as_str()
                                    .or_else(|| d["_spdisplays_resolution"].as_str())
                                    .unwrap_or("Retina")
                                    .to_string(),
                                refresh_rate_hz: None,
                                diagonal_inches: None,
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
                                hw.disks.push(DiskSpecInfo {
                                    model: d["device_model"].as_str().or_else(|| d["_name"].as_str()).unwrap_or("Apple SSD").trim().to_string(),
                                    interface_type: if key == "SPNVMeDataType" { "NVMe" } else { "SATA" }.to_string(),
                                    media_type: "SSD".to_string(),
                                    size_gb: ((size_bytes / 1_000_000_000.0) * 10.0).round() / 10.0,
                                    serial_number: d["device_serial"].as_str().unwrap_or("").trim().to_string(),
                                    firmware: d["device_revision"].as_str().unwrap_or("").trim().to_string(),
                                    partition_style: d["partition_map_type"].as_str().unwrap_or("GPT").to_string(),
                                });
                            }
                        }
                    }
                }
            }

            if let Some(arr) = v["SPAudioDataType"].as_array() {
                for a in arr {
                    if let Some(items) = a["_items"].as_array() {
                        for item in items {
                            hw.peripherals.push(PeripheralDeviceInfo {
                                category: "Audio".into(),
                                name: item["_name"].as_str().unwrap_or("Audio Device").into(),
                                manufacturer: item["coreaudio_device_manufacturer"].as_str().unwrap_or("Apple").into(),
                                status: "OK".into(),
                            });
                        }
                    }
                }
            }

            if let Some(arr) = v["SPCameraDataType"].as_array() {
                for c in arr {
                    hw.peripherals.push(PeripheralDeviceInfo {
                        category: "Camera".into(),
                        name: c["_name"].as_str().unwrap_or("FaceTime HD Camera").into(),
                        manufacturer: "Apple".into(),
                        status: "OK".into(),
                    });
                }
            }

            if let Some(arr) = v["SPAirPortDataType"].as_array() {
                for ap in arr {
                    if let Some(ifaces) = ap["spairport_airport_interfaces"].as_array() {
                        for iface in ifaces {
                            hw.network_adapters.push(NetworkAdapterInfo {
                                name: iface["_name"].as_str().unwrap_or("Wi-Fi").into(),
                                kind: "Wi-Fi".into(),
                                mac_address: iface["spairport_wireless_mac_address"].as_str().unwrap_or("—").into(),
                                link_speed: iface["spairport_wireless_card_type"].as_str().unwrap_or("802.11ax").into(),
                                status: iface["spairport_status_information"].as_str().unwrap_or("Active").into(),
                            });
                        }
                    }
                }
            }

            if let Some(arr) = v["SPUSBDataType"].as_array() {
                for u in arr {
                    hw.peripherals.push(PeripheralDeviceInfo {
                        category: "USB / Thunderbolt".into(),
                        name: u["_name"].as_str().unwrap_or("USB Bus").into(),
                        manufacturer: "Apple".into(),
                        status: "OK".into(),
                    });
                }
            }
        }
    }

    hw
}
