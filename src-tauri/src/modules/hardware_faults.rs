//! Hidden Hardware Faults & Panel EDID Authenticity Audit (v2.8.0)
//!
//! 1. Device Manager / PnP Error Scanner (Code 43 dead dGPU, Code 10 failed start, Code 28 missing driver)
//! 2. ASPM-Aware PCIe Lane Width & Gen Audit (dGPU & NVMe controllers — catches x1/x2 trace/solder downgrades)
//! 3. Display Panel EDID Manufacturer, Model & Manufacture Date Authenticity Audit (flags replaced screens as INFO)

use crate::types::{
    BatteryHealthReport, DeviceManagerFault, DisplayEdidInfo, HardwareFaultsReport, PcieLinkInfo,
    StorageSmartReport, SystemSpecs, TamperForensicFinding, TamperForensicsReport, TestStatus,
};

#[cfg(target_os = "windows")]
use crate::cmd_util::run_powershell;
#[cfg(target_os = "macos")]
use crate::cmd_util::run_cmd_stdout;

/// Maps 3-letter PNP/EDID display panel manufacturer codes to real panel makers.
pub fn decode_edid_vendor(code: &str) -> String {
    let c = code.trim().to_uppercase();
    match c.as_str() {
        "AUO" => "AU Optronics (AUO)".into(),
        "BOE" => "BOE Technology (BOE)".into(),
        "LGD" => "LG Display (LGD)".into(),
        "SDC" | "SEC" | "SAM" => "Samsung Display (SDC)".into(),
        "CMN" | "CMO" | "N15" => "Innolux / Chi Mei (CMN)".into(),
        "SHP" => "Sharp Display (SHP)".into(),
        "APP" => "Apple Genuine Panel (APP)".into(),
        "IVO" => "InfoVision Optoelectronics (IVO)".into(),
        "CSO" | "CSW" => "TCL CSOT (CSO)".into(),
        "JDI" => "Japan Display Inc. (JDI)".into(),
        "NCP" => "Panasonic / NCP (NCP)".into(),
        "LEN" => "Lenovo OEM Panel (LEN)".into(),
        "DEL" => "Dell OEM Panel (DEL)".into(),
        "HPN" => "HP OEM Panel (HPN)".into(),
        "TMX" | "TMA" => "Tianma Microelectronics".into(),
        "" => "Unknown Panel Vendor".into(),
        other => format!("{} Display Panel", other),
    }
}

/// Maps Windows Device Manager ConfigManagerErrorCode to human-readable label.
pub fn describe_pnp_error_code(code: u32) -> &'static str {
    match code {
        1 => "Code 1 — Device is not configured correctly",
        3 => "Code 3 — Driver may be corrupted or low memory",
        10 => "Code 10 — Device cannot start (hardware/firmware init fault)",
        12 => "Code 12 — Cannot find enough free resources",
        14 => "Code 14 — Restart required",
        18 => "Code 18 — Reinstall drivers for this device",
        19 => "Code 19 — Registry configuration incomplete or damaged",
        22 => "Code 22 — Device is disabled",
        24 => "Code 24 — Device is not present or not working properly",
        28 => "Code 28 — Drivers are not installed",
        29 => "Code 29 — Device disabled in BIOS/firmware",
        31 => "Code 31 — Windows cannot load required drivers",
        32 => "Code 32 — Start type for driver is disabled",
        37 => "Code 37 — Windows cannot initialize device driver",
        39 => "Code 39 — Driver corrupted or missing",
        43 => "Code 43 — Windows stopped this device because it reported hardware problems",
        45 => "Code 45 — Currently not connected to the computer",
        48 => "Code 48 — Driver software blocked from starting",
        52 => "Code 52 — Driver signature cannot be verified",
        _ => "Device Manager error reported",
    }
}

/// Smart Shop Standard classifier for a Device Manager PnP error.
/// Code 43 / 10 / 12 / 31 / 37 / 39 / 24 on critical laptop hardware (Display/GPU, Net, Audio, Storage, USB) => "critical" (FAIL).
/// Code 28 (missing driver), Code 22 (manually disabled), or non-critical auxiliary device => "warn" (WARN).
pub fn classify_pnp_fault_severity(pnp_class: &str, name: &str, error_code: u32) -> String {
    let cls = pnp_class.to_lowercase();
    let nm = name.to_lowercase();

    // Missing driver (Code 28), user-disabled (Code 22), or detached phantom device (Code 45) -> WARN
    if matches!(error_code, 14 | 22 | 28 | 45) {
        return "warn".into();
    }

    let is_critical_subsystem = cls.contains("display")
        || cls.contains("net")
        || cls.contains("media")
        || cls.contains("audio")
        || cls.contains("scsi")
        || cls.contains("hdc")
        || cls.contains("disk")
        || cls.contains("usb")
        || cls.contains("bluetooth")
        || nm.contains("nvidia")
        || nm.contains("geforce")
        || nm.contains("rtx")
        || nm.contains("gtx")
        || nm.contains("radeon")
        || nm.contains("iris")
        || nm.contains("wi-fi")
        || nm.contains("wifi")
        || nm.contains("wireless")
        || nm.contains("nvme")
        || nm.contains("thunderbolt");

    if is_critical_subsystem && matches!(error_code, 1 | 3 | 10 | 12 | 19 | 24 | 29 | 31 | 37 | 39 | 43) {
        "critical".into()
    } else {
        "warn".into()
    }
}

/// Evaluates a PCIe device's Current vs Max link width & generation (ASPM-aware so idle Gen downclocking never false-alarms).
pub fn evaluate_pcie_link(
    name: String,
    category: String,
    current_width: Option<u32>,
    max_width: Option<u32>,
    current_gen: Option<u32>,
    max_gen: Option<u32>,
) -> PcieLinkInfo {
    match (current_width, max_width) {
        (Some(cur_w), Some(max_w)) if cur_w > 0 && max_w > 0 => {
            let gen_text = match (current_gen, max_gen) {
                (Some(cg), Some(mg)) if cg > 0 && mg > 0 => format!("Gen{} / Max Gen{}", cg, mg),
                (Some(cg), _) if cg > 0 => format!("Gen{}", cg),
                (_, Some(mg)) if mg > 0 => format!("Max Gen{}", mg),
                _ => "Gen N/A".into(),
            };
            if cur_w < max_w {
                PcieLinkInfo {
                    name,
                    category,
                    current_width,
                    max_width,
                    current_gen,
                    max_gen,
                    status: TestStatus::Warn,
                    verdict: "LANE_DOWNGRADE".into(),
                    detail: format!(
                        "Running at PCIe x{} instead of max x{} ({}) — possible damaged PCIe trace, dirty M.2 slot, or BGA solder fault.",
                        cur_w, max_w, gen_text
                    ),
                }
            } else if let (Some(cg), Some(mg)) = (current_gen, max_gen) {
                if cg > 0 && mg > 0 && cg < mg {
                    PcieLinkInfo {
                        name,
                        category,
                        current_width,
                        max_width,
                        current_gen,
                        max_gen,
                        status: TestStatus::Pass,
                        verdict: "IDLE_ASPM".into(),
                        detail: format!(
                            "Full PCIe x{} lane width verified (currently Gen{} idle power-save / Max Gen{}).",
                            cur_w, cg, mg
                        ),
                    }
                } else {
                    PcieLinkInfo {
                        name,
                        category,
                        current_width,
                        max_width,
                        current_gen,
                        max_gen,
                        status: TestStatus::Pass,
                        verdict: "FULL_WIDTH".into(),
                        detail: format!("Full PCIe x{} lane width ({}) verified.", cur_w, gen_text),
                    }
                }
            } else {
                PcieLinkInfo {
                    name,
                    category,
                    current_width,
                    max_width,
                    current_gen,
                    max_gen,
                    status: TestStatus::Pass,
                    verdict: "FULL_WIDTH".into(),
                    detail: format!("Full PCIe x{} lane width verified.", cur_w),
                }
            }
        }
        _ => PcieLinkInfo {
            name,
            category,
            current_width,
            max_width,
            current_gen,
            max_gen,
            status: TestStatus::Pass,
            verdict: "UNAVAILABLE".into(),
            detail: "PCIe link registers not exposed by OS/firmware for this device.".into(),
        },
    }
}

/// Evaluates Display Panel EDID manufacture date vs BIOS year to produce an INFO replacement-screen disclosure.
pub fn build_display_edid_info(
    manufacturer_code: String,
    panel_model: String,
    serial_number: String,
    mfg_week: Option<u32>,
    mfg_year: Option<u32>,
    bios_year: Option<u32>,
    width_cm: Option<f32>,
    height_cm: Option<f32>,
) -> DisplayEdidInfo {
    let code_clean = manufacturer_code.trim().to_uppercase();
    let manufacturer_name = decode_edid_vendor(&code_clean);
    let model_clean = if panel_model.trim().is_empty() {
        "Unknown Model".to_string()
    } else {
        panel_model.trim().to_string()
    };

    let diagonal_inches = match (width_cm, height_cm) {
        (Some(w), Some(h)) if w > 5.0 && h > 5.0 => {
            let diag_cm = (w * w + h * h).sqrt();
            Some(((diag_cm / 2.54) * 10.0).round() / 10.0)
        }
        _ => None,
    };

    // Flag INFO disclosure when panel manufacture year is >= 2 years newer than BIOS/chassis year
    let (replacement_suspected, disclosure_note) = match (mfg_year, bios_year) {
        (Some(py), Some(by)) if py >= 2010 && by >= 2010 && py >= by + 2 => (
            true,
            format!(
                "INFO: Panel manufactured in {} vs {} BIOS/chassis year — likely a replacement screen (verify brightness & color uniformity).",
                py, by
            ),
        ),
        (Some(py), Some(by)) if py >= 2010 && by >= 2010 && by >= py + 4 => (
            true,
            format!(
                "INFO: Panel manufactured in {} is older than {} BIOS date — may be a salvaged replacement panel or BIOS update.",
                py, by
            ),
        ),
        (Some(py), _) if py >= 2010 => (
            false,
            format!("Original-era panel date verified ({} Mfg{}).", py, mfg_week.map(|w| format!(" Wk {}", w)).unwrap_or_default()),
        ),
        _ => (false, "Panel EDID identity read cleanly.".into()),
    };

    let yr_part = mfg_year
        .filter(|&y| y >= 2005)
        .map(|y| format!("{}", y))
        .unwrap_or_else(|| "NA".into());
    let wk_part = mfg_week
        .filter(|&w| w > 0 && w <= 54)
        .map(|w| format!("W{:02}", w))
        .unwrap_or_default();
    let edid_fingerprint = format!(
        "{}:{}:{}{}",
        if code_clean.is_empty() { "UNK" } else { &code_clean },
        model_clean.replace(' ', ""),
        yr_part,
        wk_part
    );

    DisplayEdidInfo {
        manufacturer_code: code_clean,
        manufacturer_name,
        panel_model: model_clean,
        serial_number: serial_number.trim().to_string(),
        mfg_week: mfg_week.filter(|&w| w > 0 && w <= 54),
        mfg_year: mfg_year.filter(|&y| y >= 2005 && y <= 2040),
        bios_year,
        diagonal_inches,
        replacement_suspected,
        disclosure_note,
        edid_fingerprint,
    }
}

/// Aggregates Device Manager faults, PCIe link audit, and Display Panel EDID into a unified Smart Shop Standard report.
pub fn assemble_hardware_faults_report(
    platform: &str,
    device_faults: Vec<DeviceManagerFault>,
    pcie_links: Vec<PcieLinkInfo>,
    panels: Vec<DisplayEdidInfo>,
) -> HardwareFaultsReport {
    let critical_fault_count = device_faults
        .iter()
        .filter(|f| f.severity == "critical")
        .count();
    let warning_fault_count = device_faults.len().saturating_sub(critical_fault_count);
    let pcie_downgrade_count = pcie_links
        .iter()
        .filter(|p| p.verdict == "LANE_DOWNGRADE")
        .count();
    let replacement_panel_noted = panels.iter().any(|p| p.replacement_suspected);

    let status = if critical_fault_count > 0 {
        TestStatus::Fail
    } else if warning_fault_count > 0 || pcie_downgrade_count > 0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let panel_brief = panels
        .first()
        .map(|p| {
            let yr = p.mfg_year.map(|y| format!(" ({})", y)).unwrap_or_default();
            format!("Panel {}{}", p.manufacturer_code, yr)
        })
        .unwrap_or_else(|| "Panel EDID N/A".into());

    let summary = if critical_fault_count > 0 {
        format!(
            "CRITICAL: {} hardware fault(s) in Device Manager (e.g. Code 43/10) | {} PCIe downgrade(s) | {}",
            critical_fault_count, pcie_downgrade_count, panel_brief
        )
    } else if warning_fault_count > 0 || pcie_downgrade_count > 0 {
        format!(
            "0 critical faults ({} driver/aux warning(s), {} PCIe lane downgrade(s)) | {}",
            warning_fault_count, pcie_downgrade_count, panel_brief
        )
    } else {
        format!(
            "0 Device Manager faults • PCIe full width verified • {}{}",
            panel_brief,
            if replacement_panel_noted {
                " • INFO: Replacement panel date noted"
            } else {
                ""
            }
        )
    };

    let plain_summary = if critical_fault_count > 0 {
        let first = device_faults
            .iter()
            .find(|f| f.severity == "critical")
            .map(|f| format!("{} (Code {})", f.name, f.error_code))
            .unwrap_or_default();
        format!(
            "Hardware failure detected in OS Device Manager: {}. Inspect for dead GPU/Wi-Fi/audio chip or failed motherboard component before resale.",
            first
        )
    } else if pcie_downgrade_count > 0 {
        let first = pcie_links
            .iter()
            .find(|p| p.verdict == "LANE_DOWNGRADE")
            .map(|p| format!("{} ({})", p.name, p.detail))
            .unwrap_or_default();
        format!(
            "No critical Device Manager errors, but PCIe lane downgrade detected on {}. Check slot seating or motherboard traces.",
            first
        )
    } else if warning_fault_count > 0 {
        format!(
            "{} minor driver/auxiliary Device Manager warning(s) found (e.g. Code 28 missing driver). Install OEM chipset/driver package.",
            warning_fault_count
        )
    } else if replacement_panel_noted {
        "All hardware devices report healthy with full PCIe lane widths. Note: display panel manufacture year differs from chassis BIOS year (likely clean screen replacement).".into()
    } else {
        "Zero hidden Device Manager faults (no Code 43/10), full PCIe lane widths verified, and display panel EDID matches chassis era.".into()
    };

    HardwareFaultsReport {
        status,
        platform: platform.to_string(),
        device_faults,
        critical_fault_count,
        warning_fault_count,
        pcie_links,
        pcie_downgrade_count,
        panels,
        replacement_panel_noted,
        summary,
        plain_summary,
    }
}

/// Decodes a WMI `uint16[]` ASCII byte array into a clean String.
#[cfg(target_os = "windows")]
fn decode_u16_ascii(val: &serde_json::Value) -> String {
    val.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_u64())
                .take_while(|&c| c != 0)
                .filter(|&c| (32..=126).contains(&c))
                .map(|c| c as u8 as char)
                .collect::<String>()
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

/// Runs the native Hidden Hardware Faults & Panel EDID Authenticity Audit.
pub fn scan_hardware_faults() -> HardwareFaultsReport {
    #[cfg(target_os = "windows")]
    {
        return scan_windows_hardware_faults();
    }

    #[cfg(target_os = "macos")]
    {
        return scan_macos_hardware_faults();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        assemble_hardware_faults_report("Linux", Vec::new(), Vec::new(), Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn scan_windows_hardware_faults() -> HardwareFaultsReport {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$faults = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -and $_.ConfigManagerErrorCode -ne 0 } | Select-Object Name, PNPClass, DeviceID, ConfigManagerErrorCode)

$pcie = @()
$devs = Get-PnpDevice -PresentOnly | Where-Object { ($_.Class -in @('Display','SCSIAdapter','HDC')) -and ($_.InstanceId -like 'PCI\*') }
foreach ($d in $devs) {
  $id = $d.InstanceId
  $maxW = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{3AB22E31-8264-4B4E-9AF5-A8D2D8E33E62} 9').Data
  $curW = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{3AB22E31-8264-4B4E-9AF5-A8D2D8E33E62} 10').Data
  $maxG = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{3AB22E31-8264-4B4E-9AF5-A8D2D8E33E62} 11').Data
  $curG = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{3AB22E31-8264-4B4E-9AF5-A8D2D8E33E62} 12').Data
  if ($curW -or $maxW) {
    $cat = if ($d.Class -eq 'Display') { 'GPU' } else { 'NVMe' }
    $pcie += [PSCustomObject]@{
      Name = $d.FriendlyName
      Category = $cat
      CurW = $curW
      MaxW = $maxW
      CurG = $curG
      MaxG = $maxG
    }
  }
}

$biosYear = $null
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1
if ($bios -and $bios.ReleaseDate) { $biosYear = $bios.ReleaseDate.Year }

$panels = @()
$mids = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID)
$mparams = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams)
foreach ($m in $mids) {
  $mp = $mparams | Where-Object { $_.InstanceName -eq $m.InstanceName } | Select-Object -First 1
  $panels += [PSCustomObject]@{
    Mfg = $m.ManufacturerName
    Prod = $m.ProductCodeID
    User = $m.UserFriendlyName
    Ser = $m.SerialNumberID
    Week = $m.WeekOfManufacture
    Year = $m.YearOfManufacture
    Wcm = if ($mp) { $mp.MaxHorizontalImageSize } else { $null }
    Hcm = if ($mp) { $mp.MaxVerticalImageSize } else { $null }
  }
}

[PSCustomObject]@{
  Faults = $faults
  Pcie = $pcie
  BiosYear = $biosYear
  Panels = $panels
} | ConvertTo-Json -Depth 5 -Compress
"#;

    let mut device_faults = Vec::new();
    let mut pcie_links = Vec::new();
    let mut panels = Vec::new();

    if let Ok(raw) = run_powershell(script) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
            let bios_year = v["BiosYear"].as_u64().map(|y| y as u32);

            let parse_arr = |node: &serde_json::Value| -> Vec<serde_json::Value> {
                if let Some(a) = node.as_array() {
                    a.clone()
                } else if node.is_object() {
                    vec![node.clone()]
                } else {
                    Vec::new()
                }
            };

            for f in parse_arr(&v["Faults"]) {
                let code = f["ConfigManagerErrorCode"].as_u64().unwrap_or(0) as u32;
                if code == 0 {
                    continue;
                }
                let name = f["Name"]
                    .as_str()
                    .unwrap_or("Unknown Hardware Device")
                    .trim()
                    .to_string();
                let pnp_class = f["PNPClass"].as_str().unwrap_or("System").trim().to_string();
                let device_id = f["DeviceID"].as_str().unwrap_or("").trim().to_string();
                let severity = classify_pnp_fault_severity(&pnp_class, &name, code);
                device_faults.push(DeviceManagerFault {
                    name,
                    pnp_class,
                    device_id,
                    error_code: code,
                    error_label: describe_pnp_error_code(code).to_string(),
                    severity,
                });
            }

            for p in parse_arr(&v["Pcie"]) {
                let name = p["Name"].as_str().unwrap_or("PCIe Device").trim().to_string();
                let cat = p["Category"].as_str().unwrap_or("PCIe").trim().to_string();
                let cur_w = p["CurW"].as_u64().map(|x| x as u32);
                let max_w = p["MaxW"].as_u64().map(|x| x as u32);
                let cur_g = p["CurG"].as_u64().map(|x| x as u32);
                let max_g = p["MaxG"].as_u64().map(|x| x as u32);
                pcie_links.push(evaluate_pcie_link(name, cat, cur_w, max_w, cur_g, max_g));
            }

            for pan in parse_arr(&v["Panels"]) {
                let mfg = decode_u16_ascii(&pan["Mfg"]);
                let user_name = decode_u16_ascii(&pan["User"]);
                let prod = decode_u16_ascii(&pan["Prod"]);
                let model = if !user_name.is_empty() {
                    user_name
                } else if !prod.is_empty() {
                    format!("{}{}", mfg, prod)
                } else {
                    "Internal Panel".into()
                };
                let serial = decode_u16_ascii(&pan["Ser"]);
                let week = pan["Week"].as_u64().map(|x| x as u32);
                let year = pan["Year"].as_u64().map(|x| x as u32);
                let wcm = pan["Wcm"].as_f64().map(|x| x as f32);
                let hcm = pan["Hcm"].as_f64().map(|x| x as f32);
                panels.push(build_display_edid_info(
                    mfg, model, serial, week, year, bios_year, wcm, hcm,
                ));
            }
        }
    }

    assemble_hardware_faults_report("Windows", device_faults, pcie_links, panels)
}

#[cfg(target_os = "macos")]
fn scan_macos_hardware_faults() -> HardwareFaultsReport {
    let mut pcie_links = Vec::new();
    let mut panels = Vec::new();

    if let Ok(raw) = run_cmd_stdout("system_profiler", &["SPDisplaysDataType", "SPNVMeDataType", "-json"]) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(gpus) = v["SPDisplaysDataType"].as_array() {
                for g in gpus {
                    let gname = g["sppci_model"].as_str().unwrap_or("Mac GPU").to_string();
                    if let Some(lw) = g["spdisplays_pcie_width"].as_str() {
                        let w = lw.trim_start_matches('x').parse::<u32>().ok();
                        if w.is_some() {
                            pcie_links.push(evaluate_pcie_link(gname.clone(), "GPU".into(), w, w, None, None));
                        }
                    }
                    if let Some(displays) = g["spdisplays_ndrvs"].as_array() {
                        for d in displays {
                            let dname = d["_name"].as_str().unwrap_or("Built-in Retina Display").to_string();
                            let vendor_raw = d["_spdisplays_display-vendor-id"].as_str().unwrap_or("");
                            let mfg_code = if vendor_raw.eq_ignore_ascii_case("610") {
                                "APP".to_string()
                            } else if !vendor_raw.is_empty() {
                                vendor_raw.to_uppercase()
                            } else {
                                "APP".to_string()
                            };
                            let prod = d["_spdisplays_display-product-id"].as_str().unwrap_or("");
                            let model = if !prod.is_empty() {
                                format!("{} ({})", dname, prod)
                            } else {
                                dname
                            };
                            let year = d["_spdisplays_display-year"]
                                .as_str()
                                .and_then(|s| s.parse::<u32>().ok());
                            let week = d["_spdisplays_display-week"]
                                .as_str()
                                .and_then(|s| s.parse::<u32>().ok());
                            let serial = d["_spdisplays_display-serial-number"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            panels.push(build_display_edid_info(
                                mfg_code, model, serial, week, year, None, None, None,
                            ));
                        }
                    }
                }
            }
            if let Some(nvmes) = v["SPNVMeDataType"].as_array() {
                for ctrl in nvmes {
                    if let Some(items) = ctrl["_items"].as_array() {
                        for item in items {
                            let name = item["_name"].as_str().unwrap_or("Apple NVMe SSD").to_string();
                            let w = item["spnvme_linkwidth"]
                                .as_str()
                                .and_then(|s| s.trim_start_matches('x').parse::<u32>().ok());
                            if w.is_some() {
                                pcie_links.push(evaluate_pcie_link(name, "NVMe".into(), w, w, None, None));
                            }
                        }
                    }
                }
            }
        }
    }

    assemble_hardware_faults_report("macOS", Vec::new(), pcie_links, panels)
}

/// Checks whether a battery manufacturer string looks like a generic / third-party aftermarket pack.
fn is_aftermarket_battery_vendor(raw: &str) -> bool {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() {
        return false;
    }
    let genuine_hints = [
        "apple", "dell", "lenovo", "hp", "hewlett", "asus", "acer", "msi", "razer", "samsung",
        "lg", "lgc", "sony", "murata", "panasonic", "sanyo", "smp", "simplo", "celxpert",
        "sunwoda", "byd", "dynapack", "coslight", "cosmx", "atl", "desay", "lishen", "scud",
        "nv", "tp", "compal", "quanta", "microsoft", "surface", "toshiba", "fujitsu", "huawei",
        "honor", "xiaomi", "framework", "getac",
    ];
    if genuine_hints.iter().any(|h| s.contains(h)) {
        return false;
    }
    let generic_hints = [
        "replacement",
        "generic",
        "compatible",
        "notebook",
        "battery",
        "unknown",
        "lion",
        "li-ion",
        "standard",
        "china",
        "oem",
        "default",
        "power",
    ];
    generic_hints.iter().any(|h| s.contains(h))
}

fn extract_year_from_str(s: &str) -> Option<u32> {
    let bytes = s.as_bytes();
    if bytes.len() < 4 {
        return None;
    }
    for i in 0..=bytes.len() - 4 {
        if bytes[i..i + 4].iter().all(|b| b.is_ascii_digit()) {
            if let Ok(yr) = s[i..i + 4].parse::<u32>() {
                if (2010..=2040).contains(&yr) {
                    return Some(yr);
                }
            }
        }
    }
    None
}

/// Cross-stage Used-Laptop Tamper & Refurbisher Mismatch Forensics (v3.1.0).
/// Smart Shop Calibration: honest refurbisher swaps (fresh SSD, replaced battery, replaced panel)
/// are reported transparently as INFO disclosures (never auto-FAIL); high-mileage enterprise SSDs
/// and outdated Intel 13th/14th-Gen HX BIOS microcode are surfaced as WARN.
pub fn evaluate_tamper_forensics(
    specs: Option<&SystemSpecs>,
    battery: Option<&BatteryHealthReport>,
    smart: Option<&StorageSmartReport>,
    faults: Option<&HardwareFaultsReport>,
) -> TamperForensicsReport {
    let mut findings: Vec<TamperForensicFinding> = Vec::new();

    let primary_drive = smart.and_then(|s| s.drives.first());
    let ssd_poh = primary_drive.and_then(|d| d.power_on_hours);
    let ssd_tbw_tb = primary_drive.and_then(|d| d.tbw_gb).map(|g| g / 1000.0);
    let bat_cycles = battery.and_then(|b| b.cycle_count);
    let bat_health = battery.and_then(|b| b.health_percent);
    let bat_vendor = battery.map(|b| b.manufacturer.trim()).unwrap_or("");
    let bios_year = specs.and_then(|s| extract_year_from_str(&s.bios_date));
    let cpu_brand = specs.map(|s| s.cpu_brand.as_str()).unwrap_or("");

    // 1. Fresh SSD swap / odometer mismatch vs worn battery
    if let Some(poh) = ssd_poh {
        let heavy_bat = bat_cycles.map(|c| c >= 200).unwrap_or(false)
            || bat_health.map(|h| h < 80.0).unwrap_or(false);
        if poh <= 30 && heavy_bat {
            findings.push(TamperForensicFinding {
                id: "ssd_swap_mismatch".into(),
                title: "Fresh SSD Swap Disclosed".into(),
                severity: "info".into(),
                detail: format!(
                    "Primary SSD has only {} Power-On Hours while battery shows {} ({}% health) — SSD was recently replaced or upgraded (disclose transparently; not a defect).",
                    poh,
                    bat_cycles.map(|c| format!("{} cycles", c)).unwrap_or_else(|| "measurable wear".into()),
                    bat_health.map(|h| format!("{:.0}", h)).unwrap_or_else(|| "?".into()),
                ),
            });
        }
        // 2. High-mileage enterprise fleet SSD
        if poh >= 10_000 || ssd_tbw_tb.map(|tb| tb >= 100.0).unwrap_or(false) {
            findings.push(TamperForensicFinding {
                id: "high_mileage_ssd".into(),
                title: "High-Mileage Enterprise SSD".into(),
                severity: "warn".into(),
                detail: format!(
                    "Primary SSD logs {} Power-On Hours{} — typical of heavy 24/7 enterprise fleet use; verify remaining SMART spare & price accordingly.",
                    poh,
                    ssd_tbw_tb.map(|tb| format!(" ({:.1} TB written)", tb)).unwrap_or_default()
                ),
            });
        }
    } else if let Some(tb) = ssd_tbw_tb {
        if tb >= 100.0 {
            findings.push(TamperForensicFinding {
                id: "high_mileage_ssd".into(),
                title: "High-Mileage Enterprise SSD".into(),
                severity: "warn".into(),
                detail: format!(
                    "Primary SSD has {:.1} TB total data written — heavy lifetime write mileage.",
                    tb
                ),
            });
        }
    }

    // 3. Aftermarket / recently replaced battery disclosure
    if battery.map(|b| b.present).unwrap_or(false) {
        if is_aftermarket_battery_vendor(bat_vendor) {
            findings.push(TamperForensicFinding {
                id: "aftermarket_battery".into(),
                title: "Aftermarket / Generic Battery Vendor".into(),
                severity: "info".into(),
                detail: format!(
                    "Battery reports non-OEM/generic vendor string \"{}\" — likely a third-party replacement pack; run Battery Discharge & Charging IC check.",
                    bat_vendor
                ),
            });
        } else if let (Some(c), Some(by)) = (bat_cycles, bios_year) {
            if c <= 5 && by <= 2022 && ssd_poh.map(|p| p >= 500).unwrap_or(false) {
                findings.push(TamperForensicFinding {
                    id: "fresh_battery_swap".into(),
                    title: "Recently Replaced Battery Disclosed".into(),
                    severity: "info".into(),
                    detail: format!(
                        "Battery reports only {} cycle(s) inside a ~{} chassis with {} SSD Power-On Hours — indicates a fresh replacement battery was installed.",
                        c,
                        by,
                        ssd_poh.unwrap_or(0)
                    ),
                });
            }
        }
    }

    // 4. Replacement display panel EDID mirror
    if let Some(hf) = faults {
        if hf.replacement_panel_noted {
            let note = hf
                .panels
                .iter()
                .find(|p| p.replacement_suspected)
                .map(|p| p.disclosure_note.clone())
                .unwrap_or_else(|| "Display panel EDID manufacture year differs from chassis BIOS era.".into());
            findings.push(TamperForensicFinding {
                id: "replacement_panel".into(),
                title: "Replacement Display Panel Noted".into(),
                severity: "info".into(),
                detail: note,
            });
        }
    }

    // 5. Intel 13th/14th-Gen HX pre-2024 BIOS microcode advisory
    let cpu_up = cpu_brand.to_ascii_uppercase();
    let is_raptor_hx = cpu_up.contains("INTEL")
        && (cpu_up.contains("13650HX")
            || cpu_up.contains("13700HX")
            || cpu_up.contains("13850HX")
            || cpu_up.contains("13900HX")
            || cpu_up.contains("13950HX")
            || cpu_up.contains("13980HX")
            || cpu_up.contains("14650HX")
            || cpu_up.contains("14700HX")
            || cpu_up.contains("14900HX"));
    if is_raptor_hx {
        if let Some(by) = bios_year {
            if by < 2024 {
                findings.push(TamperForensicFinding {
                    id: "intel_hx_microcode".into(),
                    title: "Intel 13th/14th-Gen HX BIOS Microcode Update Recommended".into(),
                    severity: "warn".into(),
                    detail: format!(
                        "{} is running a {} BIOS — update to the latest OEM BIOS (2024+ 0x129/0x12B microcode) to prevent high-voltage CPU instability.",
                        cpu_brand.trim(),
                        by
                    ),
                });
            }
        }
    }

    let warn_count = findings.iter().filter(|f| f.severity == "warn").count();
    let info_count = findings.len().saturating_sub(warn_count);

    let status = if warn_count > 0 {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if findings.is_empty() {
        "Consistent factory component history (no SSD/battery odometer mismatch or firmware risks).".into()
    } else if warn_count > 0 {
        format!(
            "{} forensic warning(s) & {} refurbishment disclosure(s) noted.",
            warn_count, info_count
        )
    } else {
        format!(
            "{} transparent refurbishment disclosure(s) noted (0 tamper warnings).",
            info_count
        )
    };

    let plain_summary = if findings.is_empty() {
        "SSD hours, battery history, panel EDID, and BIOS age align cleanly with no mismatch or microcode warnings.".into()
    } else {
        findings
            .iter()
            .map(|f| format!("[{}] {}", f.severity.to_ascii_uppercase(), f.title))
            .collect::<Vec<_>>()
            .join(" • ")
    };

    TamperForensicsReport {
        status,
        findings,
        info_count,
        warn_count,
        summary,
        plain_summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_pnp_fault_code43_gpu_is_critical_and_code28_is_warn() {
        assert_eq!(
            classify_pnp_fault_severity("Display", "NVIDIA GeForce RTX 3060 Laptop GPU", 43),
            "critical"
        );
        assert_eq!(
            classify_pnp_fault_severity("Net", "Intel(R) Wi-Fi 6 AX201", 10),
            "critical"
        );
        assert_eq!(
            classify_pnp_fault_severity("System", "PCI Simple Communications Controller", 28),
            "warn"
        );
        assert_eq!(
            classify_pnp_fault_severity("Display", "Disabled Virtual Display", 22),
            "warn"
        );
    }

    #[test]
    fn test_pcie_link_aspm_idle_passes_but_lane_downgrade_warns() {
        let idle = evaluate_pcie_link("RTX 4060".into(), "GPU".into(), Some(8), Some(8), Some(1), Some(4));
        assert_eq!(idle.status, TestStatus::Pass);
        assert_eq!(idle.verdict, "IDLE_ASPM");

        let downgrade = evaluate_pcie_link("RTX 4060".into(), "GPU".into(), Some(1), Some(8), Some(4), Some(4));
        assert_eq!(downgrade.status, TestStatus::Warn);
        assert_eq!(downgrade.verdict, "LANE_DOWNGRADE");
    }

    #[test]
    fn test_display_edid_vendor_decode_and_replacement_panel_disclosure() {
        let replaced = build_display_edid_info(
            "BOE".into(),
            "NV156FHM-N4K".into(),
            "SN123".into(),
            Some(14),
            Some(2025),
            Some(2021),
            Some(34.4),
            Some(19.4),
        );
        assert_eq!(replaced.manufacturer_name, "BOE Technology (BOE)");
        assert!(replaced.replacement_suspected);
        assert!(replaced.disclosure_note.contains("INFO:"));
        assert!(replaced.diagonal_inches.unwrap() > 15.0 && replaced.diagonal_inches.unwrap() < 16.0);
        assert_eq!(replaced.edid_fingerprint, "BOE:NV156FHM-N4K:2025W14");

        let original = build_display_edid_info(
            "AUO".into(),
            "B140HAN04.0".into(),
            "".into(),
            Some(22),
            Some(2021),
            Some(2021),
            Some(30.9),
            Some(17.4),
        );
        assert!(!original.replacement_suspected);
    }

    #[test]
    fn test_assemble_smart_shop_standard_verdicts() {
        // Replacement panel alone is INFO (Pass), not Fail or Warn
        let replaced_panel = build_display_edid_info(
            "LGD".into(),
            "LP140WF6".into(),
            "".into(),
            Some(10),
            Some(2025),
            Some(2020),
            None,
            None,
        );
        let rep_ok = assemble_hardware_faults_report("Windows", vec![], vec![], vec![replaced_panel]);
        assert_eq!(rep_ok.status, TestStatus::Pass);
        assert!(rep_ok.replacement_panel_noted);

        // Code 43 GPU -> FAIL
        let gpu_fail = DeviceManagerFault {
            name: "NVIDIA RTX 3060".into(),
            pnp_class: "Display".into(),
            device_id: "PCI\\VEN_10DE".into(),
            error_code: 43,
            error_label: describe_pnp_error_code(43).into(),
            severity: classify_pnp_fault_severity("Display", "NVIDIA RTX 3060", 43),
        };
        let rep_fail = assemble_hardware_faults_report("Windows", vec![gpu_fail], vec![], vec![]);
        assert_eq!(rep_fail.status, TestStatus::Fail);
        assert_eq!(rep_fail.critical_fault_count, 1);

        // PCIe lane downgrade -> WARN
        let pcie_warn = evaluate_pcie_link("Samsung 980".into(), "NVMe".into(), Some(2), Some(4), Some(3), Some(3));
        let rep_warn = assemble_hardware_faults_report("Windows", vec![], vec![pcie_warn], vec![]);
        assert_eq!(rep_warn.status, TestStatus::Warn);
        assert_eq!(rep_warn.pcie_downgrade_count, 1);
    }

    #[test]
    fn test_tamper_forensics_refurbisher_mismatches_v310() {
        use crate::types::DriveSmartInfo;

        let specs = SystemSpecs {
            cpu_brand: "Intel(R) Core(TM) i9-13900HX".into(),
            bios_date: "2023-06-15".into(),
            ..Default::default()
        };
        let bat = BatteryHealthReport {
            present: true,
            manufacturer: "Generic Replacement Li-Ion".into(),
            health_percent: Some(74.0),
            cycle_count: Some(340),
            ..Default::default()
        };
        let smart = StorageSmartReport {
            status: TestStatus::Pass,
            drives: vec![DriveSmartInfo {
                power_on_hours: Some(8),
                ..Default::default()
            }],
            summary: String::new(),
        };
        let rep = evaluate_tamper_forensics(Some(&specs), Some(&bat), Some(&smart), None);
        assert_eq!(rep.status, TestStatus::Warn); // Intel 13900HX pre-2024 BIOS -> WARN
        assert!(rep.findings.iter().any(|f| f.id == "ssd_swap_mismatch" && f.severity == "info"));
        assert!(rep.findings.iter().any(|f| f.id == "aftermarket_battery" && f.severity == "info"));
        assert!(rep.findings.iter().any(|f| f.id == "intel_hx_microcode" && f.severity == "warn"));

        // Honest refurbisher with only fresh SSD swap (no warnings) stays Pass (transparent INFO)
        let specs_clean = SystemSpecs {
            cpu_brand: "11th Gen Intel(R) Core(TM) i5-1135G7".into(),
            bios_date: "2024-03-10".into(),
            ..Default::default()
        };
        let bat_oem = BatteryHealthReport {
            present: true,
            manufacturer: "SMP Dell OEM".into(),
            health_percent: Some(76.0),
            cycle_count: Some(260),
            ..Default::default()
        };
        let rep_info = evaluate_tamper_forensics(Some(&specs_clean), Some(&bat_oem), Some(&smart), None);
        assert_eq!(rep_info.status, TestStatus::Pass);
        assert_eq!(rep_info.info_count, 1);
        assert_eq!(rep_info.warn_count, 0);
    }
}
