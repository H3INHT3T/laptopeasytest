use crate::types::{SecurityAuditReport, SecurityCheckItem, TestStatus};

pub fn run_security_audit() -> SecurityAuditReport {
    #[cfg(target_os = "windows")]
    {
        run_windows_security_audit()
    }
    #[cfg(target_os = "macos")]
    {
        run_macos_security_audit()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        SecurityAuditReport {
            overall_status: TestStatus::NotApplicable,
            platform: std::env::consts::OS.to_string(),
            mdm_enrolled: None,
            activation_locked: None,
            bios_locked: None,
            bios_lock_status: "UNVERIFIABLE".to_string(),
            items: Vec::new(),
            summary: "Security audit not implemented on this platform.".to_string(),
            plain_summary: "Ownership & firmware lock audit is supported on Windows and macOS only.".to_string(),
            ownership_risks: Vec::new(),
        }
    }
}

#[allow(dead_code)]
pub(crate) fn parse_dsregcmd_status(out: &str) -> (bool, bool, bool, String) {
    let mut azure_joined = false;
    let mut domain_joined = false;
    let mut workplace_joined = false;
    let mut mdm_url = String::new();

    for line in out.lines() {
        let trimmed = line.trim();
        if let Some((k, val)) = trimmed.split_once(':') {
            let key = k.trim();
            let val = val.trim();
            match key {
                "AzureAdJoined" => azure_joined = val.eq_ignore_ascii_case("YES"),
                "DomainJoined" => domain_joined = val.eq_ignore_ascii_case("YES"),
                "WorkplaceJoined" => workplace_joined = val.eq_ignore_ascii_case("YES"),
                "MdmUrl" => {
                    if !val.is_empty() && !val.eq_ignore_ascii_case("None") {
                        mdm_url = val.to_string();
                    }
                }
                _ => {}
            }
        }
    }
    (azure_joined, domain_joined, workplace_joined, mdm_url)
}

#[allow(dead_code)]
pub(crate) fn evaluate_windows_security_items(
    dsreg: Option<(bool, bool, bool, String)>,
    ps_json: Option<&str>,
) -> SecurityAuditReport {
    use serde_json::Value;

    let mut items = Vec::new();
    let mut ownership_risks = Vec::new();
    let mdm_enrolled;
    let mut bios_locked: Option<bool> = None;
    let mut bios_lock_status = "UNVERIFIABLE".to_string();

    if let Some((azure_joined, domain_joined, workplace_joined, mdm_url)) = dsreg {
        let enrolled = azure_joined || domain_joined || !mdm_url.is_empty();
        mdm_enrolled = Some(enrolled);

        let detail = format!(
            "AzureAD: {} | Domain: {} | Workplace: {} | MDM URL: {}",
            if azure_joined { "YES" } else { "No" },
            if domain_joined { "YES" } else { "No" },
            if workplace_joined { "YES" } else { "No" },
            if mdm_url.is_empty() { "None" } else { &mdm_url }
        );

        let (value, status, buyer_note) = if enrolled {
            let msg = "DO NOT BUY until the seller's IT admin removes this serial from Intune/Autopilot/Domain — otherwise Windows reset can re-lock the laptop remotely.";
            ownership_risks.push(format!("Corporate MDM/Domain Lock: {}", msg));
            ("ENROLLED (Locked/Managed)".to_string(), TestStatus::Fail, msg.to_string())
        } else if workplace_joined {
            let msg = "Personal/workplace account linked (WorkplaceJoined=YES) — less severe than full MDM/Autopilot lock, but seller should sign out and reset Windows before transfer.";
            ownership_risks.push(msg.to_string());
            ("Workplace Account Linked".to_string(), TestStatus::Warn, msg.to_string())
        } else {
            (
                "Clean (Not Enrolled)".to_string(),
                TestStatus::Pass,
                "No corporate MDM, Autopilot, or Active Directory domain enrollment detected.".to_string(),
            )
        };

        items.push(SecurityCheckItem {
            id: "mdm".to_string(),
            label: "MDM / Autopilot / Domain Enrollment".to_string(),
            value,
            status,
            detail,
            buyer_note,
        });
    } else {
        mdm_enrolled = None;
        items.push(SecurityCheckItem {
            id: "mdm".to_string(),
            label: "MDM / Autopilot / Domain Enrollment".to_string(),
            value: "Unavailable".to_string(),
            status: TestStatus::Warn,
            detail: "Could not query dsregcmd /status.".to_string(),
            buyer_note: "Could not verify MDM enrollment via dsregcmd; verify clean Windows OOBE setup with seller.".to_string(),
        });
    }

    if let Some(raw) = ps_json {
        if let Ok(v) = serde_json::from_str::<Value>(raw) {
            // Windows License
            let lic_status = v["licStatus"].as_i64().unwrap_or(-1);
            let lic_name = v["licName"].as_str().unwrap_or("Unknown");
            let lic_key = v["licKey"].as_str().unwrap_or("");
            let (l_val, l_st, l_note) = match lic_status {
                1 => (
                    "Activated (Licensed)".to_string(),
                    TestStatus::Pass,
                    "Genuine Windows activation present.".to_string(),
                ),
                2 | 3 | 6 => (
                    "Grace Period / Notification".to_string(),
                    TestStatus::Warn,
                    "Windows license is in grace/notification state — verify OEM digital license in BIOS.".to_string(),
                ),
                _ => (
                    "Not Activated".to_string(),
                    TestStatus::Warn,
                    "Windows is not activated — check whether an OEM license key exists or buyer must provide a license.".to_string(),
                ),
            };
            items.push(SecurityCheckItem {
                id: "license".to_string(),
                label: "Windows OEM / Activation License".to_string(),
                value: l_val,
                status: l_st,
                detail: if lic_key.is_empty() {
                    lic_name.to_string()
                } else {
                    format!("{} (Key ends: {})", lic_name, lic_key)
                },
                buyer_note: l_note,
            });

            // BitLocker
            let bl_prot = v["bitlocker"]["status"].as_str().unwrap_or("Unknown");
            let bl_enc = v["bitlocker"]["enc"].as_str().unwrap_or("Unknown");
            let bl_pct = v["bitlocker"]["pct"].as_f64();
            let pct_str = match bl_pct {
                Some(p) if p >= 0.0 => format!(" ({:.0}% encrypted)", p),
                _ => String::new(),
            };
            let (b_val, b_st, b_note) = if bl_prot.eq_ignore_ascii_case("On") || bl_prot == "1" {
                let msg = "BitLocker is ON — a BIOS update, TPM reset, or SSD swap will demand the 48-digit BitLocker Recovery Key. Seller must decrypt or wipe cleanly before sale.";
                ownership_risks.push(format!("BitLocker Active: {}", msg));
                ("Encrypted (BitLocker ON)".to_string(), TestStatus::Warn, msg.to_string())
            } else if bl_prot.eq_ignore_ascii_case("Off") || bl_prot == "0" {
                (
                    "Off / Decrypted".to_string(),
                    TestStatus::Pass,
                    "Drive is unencrypted — no risk of pre-sale BitLocker recovery-key lockout.".to_string(),
                )
            } else {
                (
                    "Unknown (Run as Admin)".to_string(),
                    TestStatus::Warn,
                    "Run as Administrator to confirm BitLocker status before transferring ownership.".to_string(),
                )
            };
            items.push(SecurityCheckItem {
                id: "bitlocker".to_string(),
                label: "BitLocker Drive Encryption".to_string(),
                value: b_val,
                status: b_st,
                detail: format!("Protection: {} | Volume State: {}{}", bl_prot, bl_enc, pct_str),
                buyer_note: b_note,
            });

            // TPM 2.0 (now checking present, enabled, and ready)
            let tpm_present = v["tpm"]["present"].as_bool();
            let tpm_enabled = v["tpm"]["enabled"].as_bool();
            let tpm_ready = v["tpm"]["ready"].as_bool().unwrap_or(false);
            let tpm_spec = v["tpm"]["spec"].as_str().unwrap_or("").trim();
            let (t_val, t_st, t_det, t_note) = match tpm_present {
                Some(true) if tpm_ready && tpm_enabled != Some(false) => (
                    "Present & Ready".to_string(),
                    TestStatus::Pass,
                    if tpm_spec.is_empty() {
                        "TPM module detected, enabled, and ready (Windows 11 compliant).".to_string()
                    } else {
                        format!("TPM {} detected, enabled, and ready (Windows 11 compliant).", tpm_spec)
                    },
                    "TPM security chip is active and ready for Windows 11.".to_string(),
                ),
                Some(true) if tpm_enabled == Some(false) => (
                    "Present (Disabled in BIOS)".to_string(),
                    TestStatus::Warn,
                    "TPM hardware is present but disabled in BIOS/UEFI settings.".to_string(),
                    "Enable TPM / PTT / fTPM in BIOS for Windows 11 compatibility.".to_string(),
                ),
                Some(true) => (
                    "Present (Not Ready)".to_string(),
                    TestStatus::Warn,
                    "TPM detected in hardware but not fully initialized/ready.".to_string(),
                    "Initialize or clear TPM in BIOS/Windows Security if needed for Windows 11.".to_string(),
                ),
                Some(false) => (
                    "Not Detected".to_string(),
                    TestStatus::Warn,
                    "No active TPM module detected (may be disabled in BIOS).".to_string(),
                    "Check BIOS for Intel PTT / AMD fTPM; without TPM 2.0, official Windows 11 upgrades are blocked.".to_string(),
                ),
                None => (
                    "Requires Admin".to_string(),
                    TestStatus::Warn,
                    "Run elevated to query TPM status.".to_string(),
                    "Run LaptopBench QC as Administrator to verify TPM 2.0 readiness.".to_string(),
                ),
            };
            items.push(SecurityCheckItem {
                id: "tpm".to_string(),
                label: "TPM Security Chip".to_string(),
                value: t_val,
                status: t_st,
                detail: t_det,
                buyer_note: t_note,
            });

            // Secure Boot
            let sb = v["secureBoot"].as_str().unwrap_or("Unknown");
            let (sb_val, sb_st, sb_note) = if sb.eq_ignore_ascii_case("True") {
                (
                    "Enabled".to_string(),
                    TestStatus::Pass,
                    "UEFI Secure Boot enabled — ready for Windows 11 and anti-cheat software.".to_string(),
                )
            } else if sb.eq_ignore_ascii_case("False") {
                (
                    "Disabled".to_string(),
                    TestStatus::Warn,
                    "Secure Boot is disabled in UEFI — re-enable in BIOS for Windows 11 / Valorant / modern security.".to_string(),
                )
            } else {
                (
                    "Unsupported / Legacy BIOS".to_string(),
                    TestStatus::Warn,
                    "Legacy BIOS or unsupported Secure Boot state — verify UEFI mode.".to_string(),
                )
            };
            items.push(SecurityCheckItem {
                id: "secure_boot".to_string(),
                label: "UEFI Secure Boot".to_string(),
                value: sb_val,
                status: sb_st,
                detail: format!("UEFI Secure Boot reported: {}", sb),
                buyer_note: sb_note,
            });

            // BIOS / UEFI Admin Password Lock Status (Dell / Lenovo / HP WMI + Generic UEFI fallback)
            if let Some(bl_obj) = v.get("biosLock") {
                let state = bl_obj["state"].as_str().unwrap_or("unverifiable").to_lowercase();
                let vendor = bl_obj["vendor"].as_str().unwrap_or("OEM BIOS");
                let raw_detail = bl_obj["detail"].as_str().unwrap_or("").trim();
                let (val, st, note) = match state.as_str() {
                    "locked" => {
                        bios_locked = Some(true);
                        bios_lock_status = "LOCKED".to_string();
                        let msg = "DO NOT BUY until the seller removes the BIOS Supervisor/Admin password — a locked BIOS blocks OS reinstall, boot order, and hardware servicing.";
                        ownership_risks.push(format!("BIOS Password Lock: {}", msg));
                        ("LOCKED (BIOS Password Set)".to_string(), TestStatus::Fail, msg.to_string())
                    }
                    "unlocked" => {
                        bios_locked = Some(false);
                        bios_lock_status = "UNLOCKED".to_string();
                        (
                            "UNLOCKED (No BIOS Password)".to_string(),
                            TestStatus::Pass,
                            "OEM BIOS WMI confirmed no Supervisor/Admin password is set.".to_string(),
                        )
                    }
                    _ => {
                        bios_locked = None;
                        bios_lock_status = "UNVERIFIABLE".to_string();
                        (
                            "UNVERIFIABLE (Verify in BIOS Setup)".to_string(),
                            TestStatus::Warn,
                            "This laptop's OEM WMI does not expose BIOS password state to Windows — reboot and press F2 / F10 / Del to confirm BIOS Setup opens UNLOCKED.".to_string(),
                        )
                    }
                };
                items.push(SecurityCheckItem {
                    id: "bios_lock".to_string(),
                    label: "BIOS / Firmware Lock Status".to_string(),
                    value: val,
                    status: st,
                    detail: if raw_detail.is_empty() {
                        format!("{} firmware lock probe: {}", vendor, bios_lock_status)
                    } else {
                        raw_detail.to_string()
                    },
                    buyer_note: note,
                });
            }

            // Computrace / Absolute Persistence (BIOS anti-theft firmware lock)
            if let Some(ct) = v.get("computrace").filter(|c| c.is_object()) {
                let state = ct["state"].as_str().unwrap_or("clean").to_lowercase();
                let detail = ct["detail"].as_str().unwrap_or("").to_string();
                let (val, st, note) = if state == "active" {
                    let msg = "DO NOT BUY: Absolute / Computrace firmware persistence is ACTIVE! Even wiping or replacing the SSD will re-install corporate tracking/lock.";
                    ownership_risks.push(format!("Computrace / Absolute Active: {}", msg));
                    ("ACTIVE (Persistence Locked)".to_string(), TestStatus::Fail, msg.to_string())
                } else if state == "disabled" {
                    (
                        "Clean (Disabled in BIOS)".to_string(),
                        TestStatus::Pass,
                        "Computrace / Absolute persistence is disabled or permanently deactivated.".to_string(),
                    )
                } else {
                    (
                        "Clean (Not Active)".to_string(),
                        TestStatus::Pass,
                        "No active Absolute / Computrace agent service or BIOS lock detected.".to_string(),
                    )
                };
                items.push(SecurityCheckItem {
                    id: "computrace".to_string(),
                    label: "Computrace / Absolute Lock".to_string(),
                    value: val,
                    status: st,
                    detail,
                    buyer_note: note,
                });
            }

            // Windows Autopilot Cached Enrollment Policy
            if let Some(ap) = v.get("autopilot").filter(|a| a.is_object()) {
                let enrolled = ap["enrolled"].as_bool().unwrap_or(false);
                let tenant = ap["tenant"].as_str().unwrap_or("").trim().to_string();
                let detail = ap["detail"].as_str().unwrap_or("").to_string();
                let (val, st, note) = if enrolled {
                    let msg = format!(
                        "DO NOT BUY: Cached Windows Autopilot corporate profile detected{} — resetting Windows will force corporate login!",
                        if tenant.is_empty() { String::new() } else { format!(" (Tenant: {})", tenant) }
                    );
                    ownership_risks.push(format!("Windows Autopilot Lock: {}", msg));
                    (
                        if tenant.is_empty() { "ENROLLED (Autopilot Policy)".into() } else { format!("ENROLLED ({})", tenant) },
                        TestStatus::Fail,
                        msg,
                    )
                } else {
                    (
                        "Clean (No Autopilot Profile)".to_string(),
                        TestStatus::Pass,
                        "No cached Windows Autopilot corporate provisioning policy found on this device.".to_string(),
                    )
                };
                items.push(SecurityCheckItem {
                    id: "autopilot".to_string(),
                    label: "Windows Autopilot Policy".to_string(),
                    value: val,
                    status: st,
                    detail,
                    buyer_note: note,
                });
            }
        }
    }

    finalize_security_report(
        "Windows",
        mdm_enrolled,
        None,
        bios_locked,
        bios_lock_status,
        items,
        ownership_risks,
    )
}

#[allow(dead_code)]
pub(crate) fn parse_macos_firmware_password(out: &str) -> (Option<bool>, String) {
    let lower = out.to_lowercase();
    if lower.contains("password enabled: yes") {
        (Some(true), "LOCKED".to_string())
    } else if lower.contains("password enabled: no") {
        (Some(false), "UNLOCKED".to_string())
    } else {
        (None, "UNVERIFIABLE".to_string())
    }
}

#[allow(dead_code)]
pub(crate) fn parse_macos_mdm_status(out: &str) -> bool {
    let lower = out.to_lowercase();
    lower.contains("enrolled via dep: yes") || lower.contains("mdm enrollment: yes")
}

#[allow(dead_code)]
pub(crate) fn parse_macos_activation_lock(out: &str) -> (bool, String) {
    let line = out
        .lines()
        .find(|l| l.to_lowercase().contains("activation lock status"))
        .unwrap_or("")
        .trim()
        .to_string();
    let locked = line.to_lowercase().contains("enabled");
    (locked, line)
}

#[allow(dead_code)]
pub(crate) fn finalize_security_report(
    platform: &str,
    mdm_enrolled: Option<bool>,
    activation_locked: Option<bool>,
    bios_locked: Option<bool>,
    bios_lock_status: String,
    items: Vec<SecurityCheckItem>,
    ownership_risks: Vec<String>,
) -> SecurityAuditReport {
    let has_fail = items.iter().any(|i| i.status == TestStatus::Fail);
    let has_warn = items.iter().any(|i| i.status == TestStatus::Warn);
    let overall_status = if has_fail {
        TestStatus::Fail
    } else if has_warn {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if mdm_enrolled == Some(true) || activation_locked == Some(true) || bios_locked == Some(true) {
        "ALERT: MDM, BIOS/Firmware Password, or Apple Activation Lock is active! Verify ownership and clear before purchase.".to_string()
    } else if has_warn {
        "Clean of corporate MDM/Activation locks; review BIOS lock, encryption, license, or firmware warnings."
            .to_string()
    } else if platform == "macOS" {
        "Clean of MDM, Firmware Lock & Activation Lock, FileVault Off, SIP Enabled.".to_string()
    } else {
        "Clean of MDM/Domain & BIOS locks, Windows licensed, TPM & Secure Boot ready.".to_string()
    };

    let plain_summary = if !ownership_risks.is_empty() {
        format!("OWNERSHIP RISK: {}", ownership_risks.join(" | "))
    } else if has_warn {
        format!("{} — minor security/BIOS checks require attention before resale.", summary)
    } else {
        format!("SAFE TO BUY: {}", summary)
    };

    SecurityAuditReport {
        overall_status,
        platform: platform.to_string(),
        mdm_enrolled,
        activation_locked,
        bios_locked,
        bios_lock_status,
        items,
        summary,
        plain_summary,
        ownership_risks,
    }
}

#[cfg(target_os = "windows")]
fn run_windows_security_audit() -> SecurityAuditReport {
    use crate::cmd_util::{run_cmd_stdout, run_powershell};

    let dsreg = run_cmd_stdout("dsregcmd", &["/status"])
        .ok()
        .map(|out| parse_dsregcmd_status(&out));

    // OEM Windows License, BitLocker, TPM 2.0 (with Win32_Tpm fallback), Secure Boot in one batched query
    let ps = r#"
$lic = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-98e3-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -ErrorAction SilentlyContinue | Select-Object -First 1
$licStatus = if ($lic) { $lic.LicenseStatus } else { -1 }
$licName = if ($lic) { $lic.Name } else { 'No license key found' }
$licKey = if ($lic) { $lic.PartialProductKey } else { '' }

$sb = try { Confirm-SecureBootUEFI -ErrorAction Stop } catch { 'Unsupported' }
$tpm = try {
    $t = Get-Tpm -ErrorAction Stop
    $wt = Get-CimInstance -Namespace root\cimv2\security\microsofttpm -ClassName Win32_Tpm -ErrorAction SilentlyContinue | Select-Object -First 1
    $spec = if ($wt -and $wt.SpecVersion) { [string]$wt.SpecVersion } else { '' }
    @{ present = $t.TpmPresent; ready = $t.TpmReady; enabled = $t.TpmEnabled; spec = $spec }
} catch {
    $wt = Get-CimInstance -Namespace root\cimv2\security\microsofttpm -ClassName Win32_Tpm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wt) {
        @{ present = $true; ready = [bool]$wt.IsActivated_InitialValue; enabled = [bool]$wt.IsEnabled_InitialValue; spec = [string]$wt.SpecVersion }
    } else {
        @{ present = $null; ready = $null; enabled = $null; spec = '' }
    }
}
$bl = try {
    $v = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
    @{ status = [string]$v.ProtectionStatus; enc = [string]$v.VolumeStatus; pct = $v.EncryptionPercentage }
} catch {
    @{ status = 'Unknown'; enc = 'Requires Admin'; pct = -1 }
}

$biosInfo = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue | Select-Object -First 1
$biosVendor = if ($biosInfo -and $biosInfo.Manufacturer) { [string]$biosInfo.Manufacturer } else { 'OEM BIOS' }
$biosVer = if ($biosInfo -and $biosInfo.SMBIOSBIOSVersion) { [string]$biosInfo.SMBIOSBIOSVersion } else { '' }
$biosLock = @{ state = 'unverifiable'; vendor = $biosVendor; detail = "BIOS: $biosVendor $biosVer — OEM WMI password interface not exposed; press F2/F10/Del at boot to verify." }

try {
    # 1. Dell Command | Monitor WMI (root\dcim\sysman)
    $dellPw = @(Get-CimInstance -Namespace root\dcim\sysman -ClassName DCIM_BIOSPassword -ErrorAction Stop)
    if ($dellPw.Count -gt 0) {
        $adminPw = $dellPw | Where-Object { $_.AttributeName -match 'Admin|System' -and $_.IsSet -eq 1 }
        if ($adminPw) {
            $names = ($adminPw | ForEach-Object { $_.AttributeName }) -join ', '
            $biosLock = @{ state = 'locked'; vendor = 'Dell'; detail = "Dell WMI (DCIM_BIOSPassword): Password IS SET ($names)." }
        } else {
            $biosLock = @{ state = 'unlocked'; vendor = 'Dell'; detail = "Dell WMI (DCIM_BIOSPassword): Admin & System passwords NOT set (Unlocked)." }
        }
    }
} catch {}

if ($biosLock.state -eq 'unverifiable') {
    try {
        # 2. Lenovo ThinkPad/IdeaPad WMI (root\wmi -> Lenovo_BiosPasswordSettings)
        $lenPw = Get-CimInstance -Namespace root\wmi -ClassName Lenovo_BiosPasswordSettings -ErrorAction Stop | Select-Object -First 1
        if ($lenPw) {
            $psVal = [int]$lenPw.PasswordState
            if ($psVal -gt 0) {
                $biosLock = @{ state = 'locked'; vendor = 'Lenovo'; detail = "Lenovo WMI (Lenovo_BiosPasswordSettings): PasswordState=$psVal (BIOS Password LOCKED)." }
            } else {
                $biosLock = @{ state = 'unlocked'; vendor = 'Lenovo'; detail = "Lenovo WMI (Lenovo_BiosPasswordSettings): PasswordState=0 (BIOS UNLOCKED)." }
            }
        }
    } catch {}
}

if ($biosLock.state -eq 'unverifiable') {
    try {
        # 3. HP Instrumented BIOS WMI (root\hp\instrumentedBIOS)
        $hpSet = @(Get-CimInstance -Namespace root\hp\instrumentedBIOS -ClassName HP_BIOSSetting -ErrorAction Stop)
        if ($hpSet.Count -gt 0) {
            $pwItem = $hpSet | Where-Object { $_.Name -match 'Setup Password|BIOS Power-On|Administrator Password' } | Select-Object -First 1
            if ($pwItem) {
                $valStr = [string]$pwItem.Value
                if ($valStr -match 'Set|Enable|Yes|1|True' -and $valStr -notmatch 'Not Set|Disable|No') {
                    $biosLock = @{ state = 'locked'; vendor = 'HP'; detail = "HP WMI (HP_BIOSSetting): $($pwItem.Name) = $valStr (LOCKED)." }
                } else {
                    $biosLock = @{ state = 'unlocked'; vendor = 'HP'; detail = "HP WMI (HP_BIOSSetting): $($pwItem.Name) = $valStr (UNLOCKED)." }
                }
            }
        }
    } catch {}
}

# Computrace / Absolute Persistence check (agent services + Dell/HP/Lenovo WMI)
$ct = @{ state = 'clean'; detail = 'No rpcnet/Absolute agent service or active BIOS Computrace lock detected.' }
$rpcSvc = Get-Service -Name 'rpcnet','rpcnetp','Absolute*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' -or $_.StartType -eq 'Automatic' } | Select-Object -First 1
if ($rpcSvc) {
    $ct = @{ state = 'active'; detail = "Active Absolute Persistence service detected: $($rpcSvc.Name) ($($rpcSvc.Status))." }
} else {
    try {
        $lenCt = Get-CimInstance -Namespace root\wmi -ClassName Lenovo_BiosSetting -ErrorAction Stop | Where-Object { $_.CurrentSetting -match 'Computrace|Absolute' } | Select-Object -First 1
        if ($lenCt) {
            $cs = [string]$lenCt.CurrentSetting
            if ($cs -match 'Enabled|Activated') { $ct = @{ state = 'active'; detail = "Lenovo BIOS WMI: $cs" } }
            else { $ct = @{ state = 'disabled'; detail = "Lenovo BIOS WMI: $cs" } }
        }
    } catch {}
    if ($ct.state -eq 'clean') {
        try {
            $hpCt = Get-CimInstance -Namespace root\hp\instrumentedBIOS -ClassName HP_BIOSSetting -ErrorAction Stop | Where-Object { $_.Name -match 'Absolute|Computrace' } | Select-Object -First 1
            if ($hpCt) {
                $hv = [string]$hpCt.Value
                if ($hv -match 'Active|Enable' -and $hv -notmatch 'Inactive|Disable') { $ct = @{ state = 'active'; detail = "HP BIOS WMI: $($hpCt.Name) = $hv" } }
                else { $ct = @{ state = 'disabled'; detail = "HP BIOS WMI: $($hpCt.Name) = $hv" } }
            }
        } catch {}
    }
}

# Windows Autopilot Cached Policy check
$ap = @{ enrolled = $false; tenant = ''; detail = 'No cached AutoPilotDDSZTDFile.json or registry CloudAssignedTenantDomain.' }
$apPath = Join-Path $env:WINDIR 'Provisioning\Autopilot\AutoPilotDDSZTDFile.json'
if (Test-Path $apPath) {
    try {
        $apJson = Get-Content $apPath -Raw -ErrorAction Stop | ConvertFrom-Json
        $ten = if ($apJson.CloudAssignedTenantDomain) { [string]$apJson.CloudAssignedTenantDomain } else { 'Corporate Tenant' }
        $ap = @{ enrolled = $true; tenant = $ten; detail = "Cached Autopilot JSON found at $apPath (Tenant: $ten)." }
    } catch {
        $ap = @{ enrolled = $true; tenant = 'Cached Policy'; detail = "Cached Autopilot JSON present at $apPath." }
    }
} else {
    try {
        $regAp = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Provisioning\Diagnostics\AutoPilot' -ErrorAction Stop
        if ($regAp -and $regAp.CloudAssignedTenantDomain -and [string]$regAp.CloudAssignedTenantDomain -ne '') {
            $ten = [string]$regAp.CloudAssignedTenantDomain
            $ap = @{ enrolled = $true; tenant = $ten; detail = "Registry AutoPilot CloudAssignedTenantDomain = $ten." }
        }
    } catch {}
}

@{
    licStatus = $licStatus
    licName = $licName
    licKey = $licKey
    secureBoot = [string]$sb
    tpm = $tpm
    bitlocker = $bl
    biosLock = $biosLock
    computrace = $ct
    autopilot = $ap
} | ConvertTo-Json -Depth 4 -Compress
"#;

    let ps_raw = run_powershell(ps).ok();
    evaluate_windows_security_items(dsreg, ps_raw.as_deref())
}

#[cfg(target_os = "macos")]
fn run_macos_security_audit() -> SecurityAuditReport {
    use crate::cmd_util::run_cmd_stdout;

    let mut items = Vec::new();
    let mut ownership_risks = Vec::new();
    let mdm_enrolled;
    let activation_locked;

    // 1. MDM / DEP Enrollment
    match run_cmd_stdout("profiles", &["status", "-type", "enrollment"]) {
        Ok(out) => {
            let enrolled = parse_macos_mdm_status(&out);
            mdm_enrolled = Some(enrolled);
            let buyer_note = if enrolled {
                let msg = "DO NOT BUY until the previous company releases this serial from Apple Business Manager / MDM — otherwise macOS setup can lock remotely after erase.";
                ownership_risks.push(format!("MDM/DEP Lock: {}", msg));
                msg.to_string()
            } else {
                "Not enrolled in Apple DEP / corporate MDM.".to_string()
            };
            items.push(SecurityCheckItem {
                id: "mdm".to_string(),
                label: "MDM / DEP Enrollment".to_string(),
                value: if enrolled {
                    "ENROLLED (Locked/Managed)".to_string()
                } else {
                    "Clean (Not Enrolled)".to_string()
                },
                status: if enrolled { TestStatus::Fail } else { TestStatus::Pass },
                detail: out.replace('\n', " | "),
                buyer_note,
            });
        }
        Err(e) => {
            mdm_enrolled = None;
            items.push(SecurityCheckItem {
                id: "mdm".to_string(),
                label: "MDM / DEP Enrollment".to_string(),
                value: "Check Failed".to_string(),
                status: TestStatus::Warn,
                detail: e,
                buyer_note: "Could not query Apple DEP/MDM enrollment status.".to_string(),
            });
        }
    }

    // 2. Activation Lock (Find My Mac)
    match run_cmd_stdout("system_profiler", &["SPHardwareDataType"]) {
        Ok(out) => {
            let (locked, line) = parse_macos_activation_lock(&out);
            activation_locked = Some(locked);
            let buyer_note = if locked {
                let msg = "Find My Activation Lock is enabled — seller must sign out of iCloud / remove device from Find My before purchase or the Mac cannot be reactivated.";
                ownership_risks.push(format!("Activation Lock: {}", msg));
                msg.to_string()
            } else {
                "Activation Lock disabled — Mac is not bound to a seller Apple ID.".to_string()
            };
            items.push(SecurityCheckItem {
                id: "activation_lock".to_string(),
                label: "Apple Activation Lock (Find My)".to_string(),
                value: if line.is_empty() {
                    "Disabled / Not Supported".to_string()
                } else if locked {
                    "LOCKED (Enabled)".to_string()
                } else {
                    "Disabled (Clean)".to_string()
                },
                status: if locked { TestStatus::Fail } else { TestStatus::Pass },
                detail: if line.is_empty() {
                    "No Activation Lock flag reported by SPHardwareDataType.".to_string()
                } else {
                    line
                },
                buyer_note,
            });
        }
        Err(e) => {
            activation_locked = None;
            items.push(SecurityCheckItem {
                id: "activation_lock".to_string(),
                label: "Apple Activation Lock (Find My)".to_string(),
                value: "Unavailable".to_string(),
                status: TestStatus::Warn,
                detail: e,
                buyer_note: "Could not verify Find My Activation Lock.".to_string(),
            });
        }
    }

    // 3. FileVault
    if let Ok(out) = run_cmd_stdout("fdesetup", &["status"]) {
        let on = out.to_lowercase().contains("filevault is on");
        let buyer_note = if on {
            let msg = "FileVault is ON — seller must decrypt or perform Erase All Content and Settings before transfer so buyer isn't locked out.";
            ownership_risks.push(format!("FileVault Active: {}", msg));
            msg.to_string()
        } else {
            "FileVault is Off — no disk encryption lockout risk.".to_string()
        };
        items.push(SecurityCheckItem {
            id: "filevault".to_string(),
            label: "FileVault Disk Encryption".to_string(),
            value: if on { "On (Encrypted)".to_string() } else { "Off".to_string() },
            status: if on { TestStatus::Warn } else { TestStatus::Pass },
            detail: out,
            buyer_note,
        });
    }

    // 4. SIP (System Integrity Protection)
    if let Ok(out) = run_cmd_stdout("csrutil", &["status"]) {
        let enabled = out.to_lowercase().contains("enabled");
        let buyer_note = if enabled {
            "macOS System Integrity Protection (SIP) is active (unmodified OS security).".to_string()
        } else {
            "SIP is disabled — OS security was modified; perform a clean macOS reinstall after purchase.".to_string()
        };
        items.push(SecurityCheckItem {
            id: "sip".to_string(),
            label: "System Integrity Protection (SIP)".to_string(),
            value: if enabled { "Enabled".to_string() } else { "Disabled".to_string() },
            status: if enabled { TestStatus::Pass } else { TestStatus::Warn },
            detail: out,
            buyer_note,
        });
    }

    // 5. BIOS / Firmware Password & Apple Silicon Recovery Lock Status
    let mut bios_locked: Option<bool> = None;
    let mut bios_lock_status = "UNVERIFIABLE".to_string();
    let is_apple_silicon = std::env::consts::ARCH == "aarch64";
    if is_apple_silicon {
        // Apple Silicon uses Recovery Lock (MDM) + Activation Lock instead of Intel EFI firmwarepasswd
        if activation_locked == Some(true) || mdm_enrolled == Some(true) {
            bios_locked = Some(true);
            bios_lock_status = "LOCKED".to_string();
            let msg = "Apple Silicon Mac has Activation Lock or MDM enrolled — Recovery / Firmware Lock may block erasing or booting macOS Recovery.";
            ownership_risks.push(format!("Firmware / Recovery Lock Risk: {}", msg));
            items.push(SecurityCheckItem {
                id: "bios_lock".to_string(),
                label: "BIOS / Firmware & Recovery Lock".to_string(),
                value: "LOCKED (Activation/MDM Risk)".to_string(),
                status: TestStatus::Fail,
                detail: "Apple Silicon firmware security bound to Activation Lock or MDM.".to_string(),
                buyer_note: msg.to_string(),
            });
        } else {
            bios_locked = Some(false);
            bios_lock_status = "UNLOCKED".to_string();
            items.push(SecurityCheckItem {
                id: "bios_lock".to_string(),
                label: "BIOS / Firmware & Recovery Lock".to_string(),
                value: "UNLOCKED (Clean)".to_string(),
                status: TestStatus::Pass,
                detail: "Apple Silicon Mac: No Activation Lock and no corporate MDM/Recovery Lock detected.".to_string(),
                buyer_note: "Firmware & Recovery boot are unlocked — safe for clean macOS erase/reinstall.".to_string(),
            });
        }
    } else if let Ok(out) = run_cmd_stdout("firmwarepasswd", &["-check"]) {
        let (locked_opt, st_str) = parse_macos_firmware_password(&out);
        bios_locked = locked_opt;
        bios_lock_status = st_str;
        let (val, st, note) = match locked_opt {
            Some(true) => {
                let msg = "Intel Mac EFI Firmware Password is ENABLED — DO NOT BUY until seller disables Firmware Password in macOS Recovery.";
                ownership_risks.push(format!("EFI Firmware Password Lock: {}", msg));
                ("LOCKED (EFI Firmware Password)".to_string(), TestStatus::Fail, msg.to_string())
            }
            Some(false) => (
                "UNLOCKED (No Firmware Password)".to_string(),
                TestStatus::Pass,
                "Intel Mac EFI Firmware Password is disabled (Unlocked).".to_string(),
            ),
            None => (
                "UNVERIFIABLE (Requires Sudo)".to_string(),
                TestStatus::Warn,
                "Could not read firmwarepasswd state — hold Option (⌥) at boot to confirm no padlock prompt appears.".to_string(),
            ),
        };
        items.push(SecurityCheckItem {
            id: "bios_lock".to_string(),
            label: "BIOS / EFI Firmware Lock".to_string(),
            value: val,
            status: st,
            detail: out.trim().to_string(),
            buyer_note: note,
        });
    } else {
        items.push(SecurityCheckItem {
            id: "bios_lock".to_string(),
            label: "BIOS / EFI Firmware Lock".to_string(),
            value: "UNVERIFIABLE (Verify at Boot)".to_string(),
            status: TestStatus::Warn,
            detail: "firmwarepasswd -check requires administrator privileges on Intel Macs.".to_string(),
            buyer_note: "Hold Option (⌥) during startup to confirm no EFI padlock password prompt appears.".to_string(),
        });
    }

    finalize_security_report(
        "macOS",
        mdm_enrolled,
        activation_locked,
        bios_locked,
        bios_lock_status,
        items,
        ownership_risks,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dsregcmd_mdm_and_workplace() {
        let clean = "AzureAdJoined : NO\nDomainJoined : NO\nWorkplaceJoined : NO\nMdmUrl : None\n";
        assert_eq!(
            parse_dsregcmd_status(clean),
            (false, false, false, String::new())
        );

        let enrolled = "AzureAdJoined : YES\nDomainJoined : NO\nWorkplaceJoined : NO\nMdmUrl : https://enrollment.manage.microsoft.com/\n";
        assert_eq!(
            parse_dsregcmd_status(enrolled),
            (
                true,
                false,
                false,
                "https://enrollment.manage.microsoft.com/".to_string()
            )
        );
    }

    #[test]
    fn test_evaluate_windows_security_items_scenarios() {
        let clean_ps = r#"{
            "licStatus": 1,
            "licName": "Windows(R), Professional edition",
            "licKey": "ABCDE",
            "secureBoot": "True",
            "tpm": {"present": true, "ready": true, "enabled": true, "spec": "2.0"},
            "bitlocker": {"status": "Off", "enc": "FullyDecrypted", "pct": 0}
        }"#;
        let clean = evaluate_windows_security_items(
            Some((false, false, false, String::new())),
            Some(clean_ps),
        );
        assert_eq!(clean.overall_status, TestStatus::Pass);
        assert!(clean.ownership_risks.is_empty());
        assert!(clean.plain_summary.contains("SAFE TO BUY"));

        let locked_ps = r#"{
            "licStatus": 1,
            "licName": "Windows",
            "licKey": "12345",
            "secureBoot": "False",
            "tpm": {"present": true, "ready": false, "enabled": false, "spec": "2.0"},
            "bitlocker": {"status": "On", "enc": "FullyEncrypted", "pct": 100}
        }"#;
        let locked = evaluate_windows_security_items(
            Some((true, false, true, "https://mdm.corp".into())),
            Some(locked_ps),
        );
        assert_eq!(locked.overall_status, TestStatus::Fail);
        assert_eq!(locked.mdm_enrolled, Some(true));
        assert!(locked.ownership_risks.iter().any(|r| r.contains("Corporate MDM/Domain Lock")));
        assert!(locked.ownership_risks.iter().any(|r| r.contains("BitLocker Active")));
        let bl = locked.items.iter().find(|i| i.id == "bitlocker").unwrap();
        assert!(bl.detail.contains("100% encrypted"));
        let tpm = locked.items.iter().find(|i| i.id == "tpm").unwrap();
        assert_eq!(tpm.value, "Present (Disabled in BIOS)");
    }

    #[test]
    fn test_parse_macos_mdm_and_activation_lock() {
        assert!(parse_macos_mdm_status("Enrolled via DEP: Yes\nMDM enrollment: No"));
        assert!(!parse_macos_mdm_status("Enrolled via DEP: No\nMDM enrollment: No"));

        let (locked, line) = parse_macos_activation_lock("      Activation Lock Status: Enabled\n");
        assert!(locked);
        assert!(line.contains("Enabled"));

        let (clean, _) = parse_macos_activation_lock("      Activation Lock Status: Disabled\n");
        assert!(!clean);
    }

    #[test]
    fn test_bios_lock_status_windows_and_macos() {
        let unlocked_ps = r#"{
            "licStatus": 1,
            "licName": "Windows 11 Pro",
            "licKey": "11111",
            "secureBoot": "True",
            "tpm": {"present": true, "ready": true, "enabled": true, "spec": "2.0"},
            "bitlocker": {"status": "Off", "enc": "FullyDecrypted", "pct": 0},
            "biosLock": {"state": "unlocked", "vendor": "Dell", "detail": "Dell WMI: Unlocked"}
        }"#;
        let rep_u = evaluate_windows_security_items(
            Some((false, false, false, String::new())),
            Some(unlocked_ps),
        );
        assert_eq!(rep_u.bios_locked, Some(false));
        assert_eq!(rep_u.bios_lock_status, "UNLOCKED");
        assert_eq!(rep_u.overall_status, TestStatus::Pass);

        let locked_ps = r#"{
            "licStatus": 1,
            "licName": "Windows 11 Pro",
            "licKey": "11111",
            "secureBoot": "True",
            "tpm": {"present": true, "ready": true, "enabled": true, "spec": "2.0"},
            "bitlocker": {"status": "Off", "enc": "FullyDecrypted", "pct": 0},
            "biosLock": {"state": "locked", "vendor": "Lenovo", "detail": "Lenovo PasswordState=1"}
        }"#;
        let rep_l = evaluate_windows_security_items(
            Some((false, false, false, String::new())),
            Some(locked_ps),
        );
        assert_eq!(rep_l.bios_locked, Some(true));
        assert_eq!(rep_l.bios_lock_status, "LOCKED");
        assert_eq!(rep_l.overall_status, TestStatus::Fail);
        assert!(rep_l.ownership_risks.iter().any(|r| r.contains("BIOS Password Lock")));

        assert_eq!(
            parse_macos_firmware_password("Password Enabled: Yes\n"),
            (Some(true), "LOCKED".to_string())
        );
        assert_eq!(
            parse_macos_firmware_password("Password Enabled: No\n"),
            (Some(false), "UNLOCKED".to_string())
        );
    }

    #[test]
    fn test_computrace_and_autopilot_lock_detection() {
        let locked_ps = r#"{
            "licStatus": 1,
            "licName": "Windows 11 Pro",
            "licKey": "11111",
            "secureBoot": "True",
            "tpm": {"present": true, "ready": true, "enabled": true, "spec": "2.0"},
            "bitlocker": {"status": "Off", "enc": "FullyDecrypted", "pct": 0},
            "computrace": {"state": "active", "detail": "rpcnet running"},
            "autopilot": {"enrolled": true, "tenant": "acme-corp.com", "detail": "Cached JSON"}
        }"#;
        let rep = evaluate_windows_security_items(
            Some((false, false, false, String::new())),
            Some(locked_ps),
        );
        assert_eq!(rep.overall_status, TestStatus::Fail);
        assert!(rep.ownership_risks.iter().any(|r| r.contains("Computrace")));
        assert!(rep.ownership_risks.iter().any(|r| r.contains("Autopilot")));

        let clean_ps = r#"{
            "licStatus": 1,
            "licName": "Windows 11 Pro",
            "licKey": "11111",
            "secureBoot": "True",
            "tpm": {"present": true, "ready": true, "enabled": true, "spec": "2.0"},
            "bitlocker": {"status": "Off", "enc": "FullyDecrypted", "pct": 0},
            "computrace": {"state": "clean", "detail": "Not active"},
            "autopilot": {"enrolled": false, "tenant": "", "detail": "Clean"}
        }"#;
        let rep_clean = evaluate_windows_security_items(
            Some((false, false, false, String::new())),
            Some(clean_ps),
        );
        assert_eq!(rep_clean.overall_status, TestStatus::Pass);
        assert!(rep_clean.ownership_risks.is_empty());
    }
}
