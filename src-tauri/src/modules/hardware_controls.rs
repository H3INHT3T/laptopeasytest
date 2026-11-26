use crate::types::{
    AirplaneModeInfo, DisplayBrightnessInfo, HardwareControlsReport, HeadphoneJackInfo,
    KeyboardBacklightInfo, RadioControlInfo, TestStatus,
};

pub fn get_hardware_controls_status() -> HardwareControlsReport {
    #[cfg(target_os = "windows")]
    {
        query_windows_hardware_controls()
    }
    #[cfg(target_os = "macos")]
    {
        query_macos_hardware_controls()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        HardwareControlsReport {
            platform: std::env::consts::OS.to_string(),
            summary: "Hardware controls check is supported on Windows and macOS.".to_string(),
            ..Default::default()
        }
    }
}

pub fn set_display_brightness(percent: u8) -> Result<u8, String> {
    let clamped = percent.min(100);
    #[cfg(target_os = "windows")]
    {
        set_windows_display_brightness(clamped)
    }
    #[cfg(target_os = "macos")]
    {
        set_macos_display_brightness(clamped)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = clamped;
        Err("Display brightness control is only supported on Windows and macOS.".to_string())
    }
}

#[allow(dead_code)]
pub(crate) fn evaluate_windows_hardware_controls_json(raw: &str) -> HardwareControlsReport {
    use serde_json::Value;

    let v: Value = match serde_json::from_str(raw.trim()) {
        Ok(val) => val,
        Err(_) => {
            return HardwareControlsReport {
                platform: "Windows".to_string(),
                summary: "Could not parse Windows hardware control telemetry.".to_string(),
                ..Default::default()
            };
        }
    };

    // 1. Display Brightness
    let disp_supported = v["display"]["supported"].as_bool().unwrap_or(false);
    let disp_pct = v["display"]["currentPct"]
        .as_u64()
        .map(|n| n.min(100) as u8);
    let disp_levels = v["display"]["levelsCount"].as_u64().map(|n| n as usize);
    let display_brightness = if disp_supported {
        DisplayBrightnessInfo {
            supported: true,
            current_pct: disp_pct,
            levels_count: disp_levels,
            can_set: true,
            status: TestStatus::Pass,
            detail: format!(
                "Built-in backlight controller active ({}% current, {} brightness steps).",
                disp_pct.unwrap_or(0),
                disp_levels.unwrap_or(0)
            ),
        }
    } else {
        DisplayBrightnessInfo {
            supported: false,
            current_pct: None,
            levels_count: None,
            can_set: false,
            status: TestStatus::Warn,
            detail: "WMI laptop backlight interface unavailable (external monitor or missing GPU/monitor driver). Verify with Fn brightness keys.".to_string(),
        }
    };

    // 2. Keyboard Backlight
    let kb_detected = v["keyboardBacklight"]["detected"].as_bool();
    let kb_pct = v["keyboardBacklight"]["currentPct"]
        .as_u64()
        .map(|n| n.min(100) as u8);
    let kb_detail_raw = v["keyboardBacklight"]["detail"]
        .as_str()
        .unwrap_or("")
        .trim();
    let keyboard_backlight = match kb_detected {
        Some(true) => KeyboardBacklightInfo {
            supported: Some(true),
            current_pct: kb_pct,
            status: TestStatus::Pass,
            detail: if kb_detail_raw.is_empty() {
                "OEM/HID backlit keyboard interface detected — test Fn brightness levels visually.".to_string()
            } else {
                kb_detail_raw.to_string()
            },
        },
        Some(false) => KeyboardBacklightInfo {
            supported: Some(false),
            current_pct: None,
            status: TestStatus::NotApplicable,
            detail: if kb_detail_raw.is_empty() {
                "No OEM keyboard backlight WMI/HID interface reported (verify if laptop has backlit keys via Fn shortcut).".to_string()
            } else {
                kb_detail_raw.to_string()
            },
        },
        None => KeyboardBacklightInfo {
            supported: None,
            current_pct: None,
            status: TestStatus::Pending,
            detail: "Verify keyboard backlight manually using the laptop's Fn + Backlight key (or mark N/A if non-backlit).".to_string(),
        },
    };

    // 3. Wi-Fi Radio
    let wifi_present = v["wifi"]["present"].as_bool().unwrap_or(false);
    let wifi_enabled = v["wifi"]["enabled"].as_bool();
    let wifi_adapter = v["wifi"]["adapter"].as_str().unwrap_or("None").trim().to_string();
    let wifi_ssid = v["wifi"]["ssid"].as_str().unwrap_or("").trim().to_string();
    let wifi_sig = v["wifi"]["signalPct"].as_u64();
    let wifi_state_str = v["wifi"]["state"].as_str().unwrap_or("").trim().to_string();
    let wifi = if !wifi_present {
        RadioControlInfo {
            present: false,
            enabled: Some(false),
            adapter_name: "Not Detected".to_string(),
            connection_detail: "No Wi-Fi adapter found".to_string(),
            status: TestStatus::Fail,
            detail: "No wireless LAN hardware detected — check M.2 Wi-Fi card or driver.".to_string(),
        }
    } else if wifi_enabled == Some(false) {
        RadioControlInfo {
            present: true,
            enabled: Some(false),
            adapter_name: wifi_adapter,
            connection_detail: if wifi_state_str.is_empty() {
                "Radio OFF".to_string()
            } else {
                wifi_state_str
            },
            status: TestStatus::Warn,
            detail: "Wi-Fi adapter present but radio is switched OFF (check Airplane Mode or hardware Wi-Fi key).".to_string(),
        }
    } else {
        let conn = if !wifi_ssid.is_empty() {
            match wifi_sig {
                Some(s) => format!("Connected: {} ({}%)", wifi_ssid, s),
                None => format!("Connected: {}", wifi_ssid),
            }
        } else {
            "Radio ON (Not associated)".to_string()
        };
        RadioControlInfo {
            present: true,
            enabled: Some(true),
            adapter_name: wifi_adapter,
            connection_detail: conn.clone(),
            status: TestStatus::Pass,
            detail: format!("Wi-Fi radio active — {}.", conn),
        }
    };

    // 4. Bluetooth Radio
    let bt_present = v["bluetooth"]["present"].as_bool().unwrap_or(false);
    let bt_enabled = v["bluetooth"]["enabled"].as_bool();
    let bt_adapter = v["bluetooth"]["adapter"]
        .as_str()
        .unwrap_or("Not Detected")
        .trim()
        .to_string();
    let bt_paired = v["bluetooth"]["pairedCount"].as_u64().unwrap_or(0);
    let bt_err = v["bluetooth"]["errorCode"].as_u64().unwrap_or(0);
    let bluetooth = if !bt_present {
        RadioControlInfo {
            present: false,
            enabled: Some(false),
            adapter_name: "Not Detected".to_string(),
            connection_detail: "No Bluetooth radio found".to_string(),
            status: TestStatus::Warn,
            detail: "No Bluetooth controller detected — check combo Wi-Fi/BT card or Bluetooth driver.".to_string(),
        }
    } else if bt_err != 0 {
        RadioControlInfo {
            present: true,
            enabled: Some(false),
            adapter_name: bt_adapter,
            connection_detail: format!("Driver Error (Code {})", bt_err),
            status: TestStatus::Fail,
            detail: format!("Bluetooth adapter reported Windows Device Manager error Code {}.", bt_err),
        }
    } else if bt_enabled == Some(false) {
        RadioControlInfo {
            present: true,
            enabled: Some(false),
            adapter_name: bt_adapter,
            connection_detail: format!("Radio OFF ({} paired)", bt_paired),
            status: TestStatus::Warn,
            detail: "Bluetooth hardware detected but radio is currently OFF (enable in Windows Settings or disable Airplane Mode).".to_string(),
        }
    } else {
        RadioControlInfo {
            present: true,
            enabled: Some(true),
            adapter_name: bt_adapter,
            connection_detail: format!("Radio ON ({} paired device(s))", bt_paired),
            status: TestStatus::Pass,
            detail: format!("Bluetooth radio operational ({} paired/remembered device(s)).", bt_paired),
        }
    };

    // 5. Airplane Mode (SystemRadioState: 1 = Airplane Mode ON, 0 = OFF)
    let am_state = v["airplaneMode"]["state"].as_i64();
    let airplane_mode = match am_state {
        Some(1) => AirplaneModeInfo {
            supported: true,
            active: Some(true),
            status: TestStatus::Warn,
            detail: "Airplane Mode is ACTIVE (SystemRadioState=1) — Wi-Fi & Bluetooth radios are suppressed. Toggle off to test normal operation.".to_string(),
        },
        Some(0) => AirplaneModeInfo {
            supported: true,
            active: Some(false),
            status: TestStatus::Pass,
            detail: "Airplane Mode is OFF (SystemRadioState=0) — radios permitted normally. Press Fn+Airplane key & refresh to verify toggle.".to_string(),
        },
        _ => AirplaneModeInfo {
            supported: false,
            active: None,
            status: TestStatus::Warn,
            detail: "Windows RadioManagement SystemRadioState key unavailable; verify Airplane Mode toggle manually.".to_string(),
        },
    };

    // 6. Headphone / 3.5mm Audio Jack
    let endpoints: Vec<String> = v["audio"]["endpoints"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let hp_name = v["audio"]["headphoneName"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let hp_plugged = v["audio"]["headphonePlugged"].as_bool().unwrap_or(false)
        || !hp_name.is_empty()
        || endpoints.iter().any(|e| {
            let l = e.to_lowercase();
            l.contains("headphone") || l.contains("headset") || l.contains("earphone")
        });
    let active_out = if !hp_name.is_empty() {
        hp_name
    } else if let Some(first_hp) = endpoints.iter().find(|e| {
        let l = e.to_lowercase();
        l.contains("headphone") || l.contains("headset") || l.contains("earphone")
    }) {
        first_hp.clone()
    } else {
        endpoints
            .first()
            .cloned()
            .unwrap_or_else(|| "Built-in Speakers / No active endpoint".to_string())
    };
    let headphone_jack = if hp_plugged {
        HeadphoneJackInfo {
            plugged_in: true,
            active_output_name: active_out.clone(),
            detected_endpoints: endpoints,
            status: TestStatus::Pass,
            detail: format!("Headphone / headset output detected ({}). Run L/R audio tone to confirm clean stereo jack contact.", active_out),
        }
    } else {
        HeadphoneJackInfo {
            plugged_in: false,
            active_output_name: active_out,
            detected_endpoints: endpoints,
            status: TestStatus::Pending,
            detail: "No headphones currently plugged in — plug 3.5mm headphones into the jack and click Refresh to verify auto-switch & L/R sound.".to_string(),
        }
    };

    let summary = format!(
        "Display: {} | Wi-Fi: {} | BT: {} | Airplane: {} | Headphone: {}",
        display_brightness
            .current_pct
            .map(|p| format!("{}%", p))
            .unwrap_or_else(|| "N/A".into()),
        if wifi.enabled == Some(true) { "ON" } else { "OFF" },
        if bluetooth.enabled == Some(true) { "ON" } else { "OFF" },
        match airplane_mode.active {
            Some(true) => "ACTIVE",
            Some(false) => "OFF",
            None => "Unknown",
        },
        if headphone_jack.plugged_in { "Plugged In" } else { "Not Plugged" }
    );

    HardwareControlsReport {
        platform: "Windows".to_string(),
        display_brightness,
        keyboard_backlight,
        wifi,
        bluetooth,
        airplane_mode,
        headphone_jack,
        summary,
    }
}

#[cfg(target_os = "windows")]
fn query_windows_hardware_controls() -> HardwareControlsReport {
    use crate::cmd_util::run_powershell;

    let ps = r#"
$disp = try {
    $b = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
    if ($b) {
        @{ supported = $true; currentPct = [int]$b.CurrentBrightness; levelsCount = @($b.Level).Count }
    } else {
        @{ supported = $false; currentPct = $null; levelsCount = 0 }
    }
} catch {
    @{ supported = $false; currentPct = $null; levelsCount = 0 }
}

$kb = try {
    $dell = Get-CimInstance -Namespace root\dcim\sysman -ClassName DCIM_BIOSEnumeration -ErrorAction SilentlyContinue | Where-Object { $_.AttributeName -match 'Keyboard Illumination|KbdBacklight' } | Select-Object -First 1
    if ($dell) {
        @{ detected = $true; currentPct = $null; detail = "Dell Keyboard Illumination supported (Current: $($dell.CurrentValue))." }
    } else {
        $lenovo = Get-CimInstance -Namespace root\wmi -ClassName Lenovo_BiosSetting -ErrorAction SilentlyContinue | Where-Object { $_.CurrentSetting -match 'KeyboardBacklight' } | Select-Object -First 1
        if ($lenovo) {
            @{ detected = $true; currentPct = $null; detail = "Lenovo Keyboard Backlight supported ($($lenovo.CurrentSetting))." }
        } else {
            $hid = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Backlight|Aura|RGB Keyboard|Keyboard Illumination' } | Select-Object -First 1
            if ($hid) {
                @{ detected = $true; currentPct = $null; detail = "Backlit keyboard device detected: $($hid.FriendlyName)." }
            } else {
                @{ detected = $null; currentPct = $null; detail = '' }
            }
        }
    }
} catch {
    @{ detected = $null; currentPct = $null; detail = '' }
}

$wifiAdapter = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Wi-Fi|Wireless|802\.11|WLAN' -or $_.Name -match 'Wi-Fi|WLAN' } | Select-Object -First 1
$wlanOut = try { (netsh wlan show interfaces 2>$null) -join "`n" } catch { '' }
$wifiSsid = ''
$wifiSig = $null
$wifiRadioOff = $false
if ($wlanOut -match 'SSID\s*:\s*([^\r\n]+)') {
    $cand = $Matches[1].Trim()
    if ($cand -and $cand -notmatch '^BSSID') { $wifiSsid = $cand }
}
if ($wlanOut -match 'Signal\s*:\s*(\d+)%') { $wifiSig = [int]$Matches[1] }
if ($wlanOut -match 'Hardware Off|Software Off') { $wifiRadioOff = $true }
$wifiPresent = [bool]$wifiAdapter -or ($wlanOut -match 'Name\s*:')
$wifiEnabled = if (-not $wifiPresent) { $false } elseif ($wifiRadioOff) { $false } elseif ($wifiAdapter -and $wifiAdapter.Status -eq 'Disabled') { $false } else { $true }
$wifi = @{
    present = $wifiPresent
    enabled = $wifiEnabled
    adapter = if ($wifiAdapter) { [string]$wifiAdapter.InterfaceDescription } else { 'Wi-Fi' }
    ssid = $wifiSsid
    signalPct = $wifiSig
    state = if ($wifiAdapter) { [string]$wifiAdapter.Status } else { if ($wifiRadioOff) { 'Radio OFF' } else { 'Active' } }
}

$btRadioDev = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -match 'Adapter|Radio|Intel|Realtek|MediaTek|Qualcomm|Broadcom|Bluetooth' -and $_.FriendlyName -notmatch 'Enumerator|Service|AVRCP|Hands-Free|A2DP'
} | Select-Object -First 1
$btAll = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue)
$btPaired = @($btAll | Where-Object { $_.FriendlyName -and $_.FriendlyName -notmatch 'Adapter|Radio|Enumerator|Service|RFCOMM|Protocol|Generic Bluetooth|Device Identification|Microsoft Bluetooth' }).Count
$btSvc = Get-Service -Name bthserv -ErrorAction SilentlyContinue
$btPresent = [bool]$btRadioDev -or ($btAll.Count -gt 0)
$btErr = if ($btRadioDev) { [int]$btRadioDev.ConfigManagerErrorCode } else { 0 }
$btEnabled = if (-not $btPresent) { $false } elseif ($btErr -ne 0) { $false } elseif ($btRadioDev -and $btRadioDev.Status -ne 'OK') { $false } else { $true }
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1)
    [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
    $op = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
    $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($op))
    if ($task.Wait(1500)) {
        foreach ($r in $task.Result) {
            if ($r.Kind -eq 'Bluetooth') { $btEnabled = ($r.State -eq 'On') }
            if ($r.Kind -eq 'WiFi') { $wifi.enabled = ($r.State -eq 'On') }
        }
    }
} catch {}
$bt = @{
    present = $btPresent
    enabled = $btEnabled
    adapter = if ($btRadioDev) { [string]$btRadioDev.FriendlyName } elseif ($btPresent) { 'Bluetooth Controller' } else { 'Not Detected' }
    pairedCount = $btPaired
    errorCode = $btErr
}

$amState = try {
    $reg = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\RadioManagement\SystemRadioState' -ErrorAction Stop
    [int]$reg.'(default)'
} catch { $null }
$airplane = @{ state = $amState }

$audioEps = @(Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName } | Select-Object -ExpandProperty FriendlyName)
$hpMatch = $audioEps | Where-Object { $_ -match 'Headphone|Headset|Earphone|AirPods|Buds|3\.5mm' } | Select-Object -First 1
$audio = @{
    endpoints = $audioEps
    headphonePlugged = [bool]$hpMatch
    headphoneName = if ($hpMatch) { [string]$hpMatch } else { '' }
}

@{
    display = $disp
    keyboardBacklight = $kb
    wifi = $wifi
    bluetooth = $bt
    airplaneMode = $airplane
    audio = $audio
} | ConvertTo-Json -Depth 5 -Compress
"#;

    match run_powershell(ps) {
        Ok(raw) => evaluate_windows_hardware_controls_json(&raw),
        Err(e) => HardwareControlsReport {
            platform: "Windows".to_string(),
            summary: format!("Hardware controls probe failed: {}", e),
            ..Default::default()
        },
    }
}

#[cfg(target_os = "windows")]
fn set_windows_display_brightness(percent: u8) -> Result<u8, String> {
    use crate::cmd_util::run_powershell;
    let ps = format!(
        r#"
$m = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
if (-not $m) {{ throw 'No WmiMonitorBrightnessMethods controller found (external monitor or missing driver).' }}
Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{{ Brightness = [byte]{}; Timeout = [uint32]1 }} | Out-Null
$b = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1
if ($b) {{ [int]$b.CurrentBrightness }} else {{ {} }}
"#,
        percent, percent
    );
    let out = run_powershell(&ps)?;
    let parsed = out.trim().parse::<u8>().unwrap_or(percent).min(100);
    Ok(parsed)
}

#[cfg(target_os = "macos")]
fn query_macos_hardware_controls() -> HardwareControlsReport {
    use crate::cmd_util::run_cmd_stdout;
    use serde_json::Value;

    // 1. Display Brightness from ioreg AppleBacklightDisplay / IOMFB
    let mut disp_pct: Option<u8> = None;
    if let Ok(ioreg) = run_cmd_stdout("ioreg", &["-r", "-c", "AppleBacklightDisplay", "-d", "1"]) {
        if let Some(pos) = ioreg.find("\"brightness\"=") {
            let slice = &ioreg[pos..];
            // Parse {"min"=0,"max"=1024,"value"=512}
            let extract = |k: &str| -> Option<f64> {
                let p = slice.find(k)?;
                let rest = &slice[p + k.len()..];
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                num.parse::<f64>().ok()
            };
            if let (Some(max_v), Some(val)) = (extract("\"max\"="), extract("\"value\"=")) {
                if max_v > 0.0 {
                    disp_pct = Some(((val / max_v) * 100.0).round().clamp(0.0, 100.0) as u8);
                }
            }
        }
    }
    let display_brightness = DisplayBrightnessInfo {
        supported: disp_pct.is_some(),
        current_pct: disp_pct,
        levels_count: Some(16),
        can_set: true,
        status: if disp_pct.is_some() { TestStatus::Pass } else { TestStatus::Warn },
        detail: match disp_pct {
            Some(p) => format!("Built-in macOS backlight detected ({}% current). Use slider or brightness keys (F1/F2) to verify smooth dimming.", p),
            None => "Could not read AppleBacklightDisplay directly (Apple Silicon IOMFB or external monitor) — verify brightness using F1/F2 keys or Control Center.".to_string(),
        },
    };

    // 2. Keyboard Backlight from ioreg
    let mut kb_pct: Option<u8> = None;
    let mut kb_found = false;
    if let Ok(ioreg) = run_cmd_stdout("ioreg", &["-r", "-k", "KeyboardBacklightBrightness"]) {
        if ioreg.contains("KeyboardBacklightBrightness") {
            kb_found = true;
            if let Some(line) = ioreg.lines().find(|l| l.contains("KeyboardBacklightBrightness")) {
                if let Some((_, val)) = line.split_once('=') {
                    if let Ok(raw) = val.trim().parse::<f64>() {
                        let pct = if raw <= 1.0 { raw * 100.0 } else if raw <= 255.0 { (raw / 255.0) * 100.0 } else { (raw / 65536.0) * 100.0 };
                        kb_pct = Some(pct.round().clamp(0.0, 100.0) as u8);
                    }
                }
            }
        }
    }
    let keyboard_backlight = KeyboardBacklightInfo {
        supported: if kb_found { Some(true) } else { None },
        current_pct: kb_pct,
        status: if kb_found { TestStatus::Pass } else { TestStatus::Pending },
        detail: if kb_found {
            format!("MacBook keyboard backlight sensor detected ({}%). Adjust via Control Center / F5-F6 to confirm even LED illumination.", kb_pct.unwrap_or(0))
        } else {
            "Test MacBook keyboard backlight visually via Control Center or F5/F6 keys.".to_string()
        },
    };

    // 3. Wi-Fi Radio
    let mut wifi_on = false;
    let mut wifi_ssid = String::new();
    if let Ok(pwr) = run_cmd_stdout("networksetup", &["-getairportpower", "en0"]) {
        wifi_on = pwr.to_lowercase().contains(": on");
    }
    if let Ok(net) = run_cmd_stdout("networksetup", &["-getairportnetwork", "en0"]) {
        if let Some((_, name)) = net.split_once(':') {
            let trimmed = name.trim();
            if !trimmed.to_lowercase().contains("not associated") {
                wifi_ssid = trimmed.to_string();
            }
        }
    }
    let wifi = RadioControlInfo {
        present: true,
        enabled: Some(wifi_on),
        adapter_name: "en0 (AirPort / Wi-Fi)".to_string(),
        connection_detail: if !wifi_on {
            "Radio OFF".to_string()
        } else if !wifi_ssid.is_empty() {
            format!("Connected: {}", wifi_ssid)
        } else {
            "Radio ON (Not associated)".to_string()
        },
        status: if wifi_on { TestStatus::Pass } else { TestStatus::Warn },
        detail: if wifi_on {
            format!("macOS Wi-Fi radio ON{}", if wifi_ssid.is_empty() { String::new() } else { format!(" ({})", wifi_ssid) })
        } else {
            "macOS Wi-Fi radio is switched OFF on en0.".to_string()
        },
    };

    // 4. Bluetooth Radio
    let mut bt_on = false;
    let mut bt_present = false;
    let mut bt_name = "Apple Bluetooth Controller".to_string();
    let mut bt_paired = 0usize;
    if let Ok(raw) = run_cmd_stdout("system_profiler", &["-json", "SPBluetoothDataType"]) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = v["SPBluetoothDataType"].as_array() {
                if let Some(first) = arr.first() {
                    bt_present = true;
                    if let Some(ctrl) = first.get("controller_properties") {
                        if let Some(st) = ctrl["controller_state"].as_str() {
                            bt_on = st.to_lowercase().contains("on");
                        }
                        if let Some(chip) = ctrl["controller_chipset"].as_str() {
                            bt_name = chip.to_string();
                        }
                    }
                    if let Some(conn) = first["device_connected"].as_array() {
                        bt_paired += conn.len();
                    }
                    if let Some(not_conn) = first["device_not_connected"].as_array() {
                        bt_paired += not_conn.len();
                    }
                }
            }
        }
    }
    let bluetooth = RadioControlInfo {
        present: bt_present,
        enabled: Some(bt_on),
        adapter_name: bt_name,
        connection_detail: if bt_on {
            format!("Radio ON ({} paired device(s))", bt_paired)
        } else {
            "Radio OFF".to_string()
        },
        status: if bt_present && bt_on { TestStatus::Pass } else { TestStatus::Warn },
        detail: if bt_on {
            format!("macOS Bluetooth controller active ({} paired/known device(s)).", bt_paired)
        } else {
            "macOS Bluetooth radio is OFF (enable in System Settings → Bluetooth).".to_string()
        },
    };

    // 5. Airplane Mode equivalent on macOS (both Wi-Fi + Bluetooth OFF)
    let all_off = !wifi_on && !bt_on;
    let airplane_mode = AirplaneModeInfo {
        supported: true,
        active: Some(all_off),
        status: if all_off { TestStatus::Warn } else { TestStatus::Pass },
        detail: if all_off {
            "Both Wi-Fi and Bluetooth radios are OFF (Airplane-equivalent offline state on macOS).".to_string()
        } else {
            "Radios active (macOS has no dedicated Airplane Mode key — toggle Wi-Fi & Bluetooth OFF to verify offline radio kill).".to_string()
        },
    };

    // 6. Headphone / 3.5mm Audio Jack from SPAudioDataType
    let mut endpoints = Vec::new();
    let mut hp_plugged = false;
    let mut active_out = "Built-in Speakers".to_string();
    if let Ok(raw) = run_cmd_stdout("system_profiler", &["-json", "SPAudioDataType"]) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(groups) = v["SPAudioDataType"].as_array() {
                for g in groups {
                    if let Some(items) = g["_items"].as_array() {
                        for item in items {
                            let name = item["_name"].as_str().unwrap_or("").trim();
                            if name.is_empty() {
                                continue;
                            }
                            endpoints.push(name.to_string());
                            let low = name.to_lowercase();
                            let is_default = item["coreaudio_default_audio_output_device"]
                                .as_str()
                                .map(|s| s.eq_ignore_ascii_case("spaudio_yes"))
                                .unwrap_or(false);
                            if low.contains("headphone") || low.contains("headset") || low.contains("external") {
                                hp_plugged = true;
                                active_out = name.to_string();
                            } else if is_default && !hp_plugged {
                                active_out = name.to_string();
                            }
                        }
                    }
                }
            }
        }
    }
    let headphone_jack = HeadphoneJackInfo {
        plugged_in: hp_plugged,
        active_output_name: active_out.clone(),
        detected_endpoints: endpoints,
        status: if hp_plugged { TestStatus::Pass } else { TestStatus::Pending },
        detail: if hp_plugged {
            format!("External headphones detected ({}). Run L/R audio tone to verify stereo jack clarity.", active_out)
        } else {
            "No 3.5mm headphones currently plugged in — insert headphones and click Refresh to verify auto-switch.".to_string()
        },
    };

    let summary = format!(
        "Display: {} | Wi-Fi: {} | BT: {} | Radios-Off: {} | Headphone: {}",
        display_brightness.current_pct.map(|p| format!("{}%", p)).unwrap_or_else(|| "Manual".into()),
        if wifi_on { "ON" } else { "OFF" },
        if bt_on { "ON" } else { "OFF" },
        if all_off { "YES" } else { "NO" },
        if hp_plugged { "Plugged In" } else { "Not Plugged" }
    );

    HardwareControlsReport {
        platform: "macOS".to_string(),
        display_brightness,
        keyboard_backlight,
        wifi,
        bluetooth,
        airplane_mode,
        headphone_jack,
        summary,
    }
}

#[cfg(target_os = "macos")]
fn set_macos_display_brightness(percent: u8) -> Result<u8, String> {
    use crate::cmd_util::run_cmd_stdout;
    let frac = format!("{:.2}", (percent as f64) / 100.0);
    if run_cmd_stdout("brightness", &[&frac]).is_ok() {
        return Ok(percent);
    }
    // Fallback: step brightness via AppleScript Display brightness keys if Accessibility permitted
    let key_code = if percent >= 50 { "144" } else { "145" };
    let script = format!("tell application \"System Events\" to repeat 4 times\nkey code {}\nend repeat", key_code);
    run_cmd_stdout("osascript", &["-e", &script])
        .map(|_| percent)
        .map_err(|_| "macOS restricts programmatic backlight changes without Accessibility permission — verify brightness directly with the F1 / F2 keys.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evaluate_windows_hardware_controls_all_healthy() {
        let json = r#"{
            "display": {"supported": true, "currentPct": 75, "levelsCount": 101},
            "keyboardBacklight": {"detected": true, "currentPct": 50, "detail": "Dell Keyboard Illumination supported."},
            "wifi": {"present": true, "enabled": true, "adapter": "Intel Wi-Fi 6 AX201", "ssid": "ShopLab5G", "signalPct": 92, "state": "Up"},
            "bluetooth": {"present": true, "enabled": true, "adapter": "Intel Wireless Bluetooth", "pairedCount": 2, "errorCode": 0},
            "airplaneMode": {"state": 0},
            "audio": {"endpoints": ["Speakers (Realtek Audio)", "Headphones (Realtek Audio)"], "headphonePlugged": true, "headphoneName": "Headphones (Realtek Audio)"}
        }"#;

        let report = evaluate_windows_hardware_controls_json(json);
        assert_eq!(report.platform, "Windows");
        assert!(report.display_brightness.supported);
        assert_eq!(report.display_brightness.current_pct, Some(75));
        assert_eq!(report.keyboard_backlight.supported, Some(true));
        assert_eq!(report.wifi.status, TestStatus::Pass);
        assert_eq!(report.bluetooth.status, TestStatus::Pass);
        assert_eq!(report.airplane_mode.active, Some(false));
        assert_eq!(report.airplane_mode.status, TestStatus::Pass);
        assert!(report.headphone_jack.plugged_in);
        assert_eq!(report.headphone_jack.status, TestStatus::Pass);
    }

    #[test]
    fn test_evaluate_windows_hardware_controls_airplane_mode_and_faults() {
        let json = r#"{
            "display": {"supported": false, "currentPct": null, "levelsCount": 0},
            "keyboardBacklight": {"detected": false, "currentPct": null, "detail": ""},
            "wifi": {"present": true, "enabled": false, "adapter": "Intel Wi-Fi", "ssid": "", "signalPct": null, "state": "Software Off"},
            "bluetooth": {"present": true, "enabled": false, "adapter": "Intel BT", "pairedCount": 0, "errorCode": 43},
            "airplaneMode": {"state": 1},
            "audio": {"endpoints": ["Speakers (Realtek Audio)"], "headphonePlugged": false, "headphoneName": ""}
        }"#;

        let report = evaluate_windows_hardware_controls_json(json);
        assert!(!report.display_brightness.supported);
        assert_eq!(report.wifi.status, TestStatus::Warn);
        assert_eq!(report.bluetooth.status, TestStatus::Fail);
        assert_eq!(report.airplane_mode.active, Some(true));
        assert_eq!(report.airplane_mode.status, TestStatus::Warn);
        assert!(!report.headphone_jack.plugged_in);
        assert_eq!(report.headphone_jack.status, TestStatus::Pending);
    }
}
