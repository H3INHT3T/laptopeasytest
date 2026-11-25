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
            items: Vec::new(),
            summary: "Security audit not implemented on this platform.".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
fn run_windows_security_audit() -> SecurityAuditReport {
    use crate::cmd_util::{run_cmd_stdout, run_powershell};
    use serde_json::Value;

    let mut items = Vec::new();
    let mdm_enrolled;

    // 1. Azure AD / Intune MDM / Domain Join via dsregcmd /status
    if let Ok(out) = run_cmd_stdout("dsregcmd", &["/status"]) {
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

        let enrolled = azure_joined || domain_joined || !mdm_url.is_empty();
        mdm_enrolled = Some(enrolled);

        let detail = format!(
            "AzureAD: {} | Domain: {} | Workplace: {} | MDM URL: {}",
            if azure_joined { "YES" } else { "No" },
            if domain_joined { "YES" } else { "No" },
            if workplace_joined { "YES" } else { "No" },
            if mdm_url.is_empty() { "None" } else { &mdm_url }
        );

        items.push(SecurityCheckItem {
            id: "mdm".to_string(),
            label: "MDM / Autopilot / Domain Enrollment".to_string(),
            value: if enrolled {
                "ENROLLED (Locked/Managed)".to_string()
            } else {
                "Clean (Not Enrolled)".to_string()
            },
            status: if enrolled { TestStatus::Fail } else { TestStatus::Pass },
            detail,
        });
    } else {
        mdm_enrolled = None;
        items.push(SecurityCheckItem {
            id: "mdm".to_string(),
            label: "MDM / Autopilot / Domain Enrollment".to_string(),
            value: "Unavailable".to_string(),
            status: TestStatus::Warn,
            detail: "Could not query dsregcmd /status.".to_string(),
        });
    }

    // 2. OEM Windows License, BitLocker, TPM 2.0, Secure Boot in one batched PowerShell query
    let ps = r#"
$lic = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-98e3-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -ErrorAction SilentlyContinue | Select-Object -First 1
$licStatus = if ($lic) { $lic.LicenseStatus } else { -1 }
$licName = if ($lic) { $lic.Name } else { 'No license key found' }
$licKey = if ($lic) { $lic.PartialProductKey } else { '' }

$sb = try { Confirm-SecureBootUEFI -ErrorAction Stop } catch { 'Unsupported' }
$tpm = try {
    $t = Get-Tpm -ErrorAction Stop
    @{ present = $t.TpmPresent; ready = $t.TpmReady; enabled = $t.TpmEnabled }
} catch {
    @{ present = $null; ready = $null; enabled = $null }
}
$bl = try {
    $v = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
    @{ status = [string]$v.ProtectionStatus; enc = [string]$v.VolumeStatus; pct = $v.EncryptionPercentage }
} catch {
    @{ status = 'Unknown'; enc = 'Requires Admin'; pct = -1 }
}
@{
    licStatus = $licStatus
    licName = $licName
    licKey = $licKey
    secureBoot = [string]$sb
    tpm = $tpm
    bitlocker = $bl
} | ConvertTo-Json -Depth 4 -Compress
"#;

    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            // Windows License
            let lic_status = v["licStatus"].as_i64().unwrap_or(-1);
            let lic_name = v["licName"].as_str().unwrap_or("Unknown");
            let lic_key = v["licKey"].as_str().unwrap_or("");
            let (l_val, l_st) = match lic_status {
                1 => ("Activated (Licensed)".to_string(), TestStatus::Pass),
                2 | 3 | 6 => ("Grace Period / Notification".to_string(), TestStatus::Warn),
                _ => ("Not Activated".to_string(), TestStatus::Warn),
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
            });

            // BitLocker
            let bl_prot = v["bitlocker"]["status"].as_str().unwrap_or("Unknown");
            let bl_enc = v["bitlocker"]["enc"].as_str().unwrap_or("Unknown");
            let (b_val, b_st) = if bl_prot.eq_ignore_ascii_case("On") || bl_prot == "1" {
                (
                    "Encrypted (BitLocker ON)".to_string(),
                    TestStatus::Warn,
                )
            } else if bl_prot.eq_ignore_ascii_case("Off") || bl_prot == "0" {
                ("Off / Decrypted".to_string(), TestStatus::Pass)
            } else {
                ("Unknown (Run as Admin)".to_string(), TestStatus::Warn)
            };
            items.push(SecurityCheckItem {
                id: "bitlocker".to_string(),
                label: "BitLocker Drive Encryption".to_string(),
                value: b_val,
                status: b_st,
                detail: format!("Protection: {} | Volume State: {}", bl_prot, bl_enc),
            });

            // TPM 2.0
            let tpm_present = v["tpm"]["present"].as_bool();
            let tpm_ready = v["tpm"]["ready"].as_bool().unwrap_or(false);
            let (t_val, t_st, t_det) = match tpm_present {
                Some(true) if tpm_ready => (
                    "Present & Ready".to_string(),
                    TestStatus::Pass,
                    "TPM module detected, enabled, and ready (Windows 11 compliant).".to_string(),
                ),
                Some(true) => (
                    "Present (Not Ready)".to_string(),
                    TestStatus::Warn,
                    "TPM detected in hardware but not fully initialized/enabled in BIOS.".to_string(),
                ),
                Some(false) => (
                    "Not Detected".to_string(),
                    TestStatus::Warn,
                    "No active TPM module detected (may be disabled in BIOS).".to_string(),
                ),
                None => (
                    "Requires Admin".to_string(),
                    TestStatus::Warn,
                    "Run elevated to query TPM status.".to_string(),
                ),
            };
            items.push(SecurityCheckItem {
                id: "tpm".to_string(),
                label: "TPM Security Chip".to_string(),
                value: t_val,
                status: t_st,
                detail: t_det,
            });

            // Secure Boot
            let sb = v["secureBoot"].as_str().unwrap_or("Unknown");
            let (sb_val, sb_st) = if sb.eq_ignore_ascii_case("True") {
                ("Enabled".to_string(), TestStatus::Pass)
            } else if sb.eq_ignore_ascii_case("False") {
                ("Disabled".to_string(), TestStatus::Warn)
            } else {
                ("Unsupported / Legacy BIOS".to_string(), TestStatus::Warn)
            };
            items.push(SecurityCheckItem {
                id: "secure_boot".to_string(),
                label: "UEFI Secure Boot".to_string(),
                value: sb_val,
                status: sb_st,
                detail: format!("UEFI Secure Boot reported: {}", sb),
            });
        }
    }

    let has_fail = items.iter().any(|i| i.status == TestStatus::Fail);
    let has_warn = items.iter().any(|i| i.status == TestStatus::Warn);
    let overall_status = if has_fail {
        TestStatus::Fail
    } else if has_warn {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if mdm_enrolled == Some(true) {
        "ALERT: Device is enrolled in MDM / Corporate Domain! Verify ownership before resale.".to_string()
    } else if has_warn {
        "Clean of MDM enrollment; review warnings (BitLocker, License, or BIOS settings).".to_string()
    } else {
        "Clean of MDM/Domain locks, Windows licensed, TPM & Secure Boot ready.".to_string()
    };

    SecurityAuditReport {
        overall_status,
        platform: "Windows".to_string(),
        mdm_enrolled,
        activation_locked: None,
        items,
        summary,
    }
}

#[cfg(target_os = "macos")]
fn run_macos_security_audit() -> SecurityAuditReport {
    use crate::cmd_util::run_cmd_stdout;

    let mut items = Vec::new();
    let mdm_enrolled;
    let activation_locked;

    // 1. MDM / DEP Enrollment
    match run_cmd_stdout("profiles", &["status", "-type", "enrollment"]) {
        Ok(out) => {
            let lower = out.to_lowercase();
            let enrolled = lower.contains("enrolled via dep: yes")
                || lower.contains("mdm enrollment: yes");
            mdm_enrolled = Some(enrolled);
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
            });
        }
    }

    // 2. Activation Lock (Find My Mac)
    match run_cmd_stdout("system_profiler", &["SPHardwareDataType"]) {
        Ok(out) => {
            let line = out
                .lines()
                .find(|l| l.to_lowercase().contains("activation lock status"))
                .unwrap_or("")
                .trim();
            let locked = line.to_lowercase().contains("enabled");
            activation_locked = Some(locked);
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
                    line.to_string()
                },
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
            });
        }
    }

    // 3. FileVault
    if let Ok(out) = run_cmd_stdout("fdesetup", &["status"]) {
        let on = out.to_lowercase().contains("filevault is on");
        items.push(SecurityCheckItem {
            id: "filevault".to_string(),
            label: "FileVault Disk Encryption".to_string(),
            value: if on { "On (Encrypted)".to_string() } else { "Off".to_string() },
            status: if on { TestStatus::Warn } else { TestStatus::Pass },
            detail: out,
        });
    }

    // 4. SIP (System Integrity Protection)
    if let Ok(out) = run_cmd_stdout("csrutil", &["status"]) {
        let enabled = out.to_lowercase().contains("enabled");
        items.push(SecurityCheckItem {
            id: "sip".to_string(),
            label: "System Integrity Protection (SIP)".to_string(),
            value: if enabled { "Enabled".to_string() } else { "Disabled".to_string() },
            status: if enabled { TestStatus::Pass } else { TestStatus::Warn },
            detail: out,
        });
    }

    let has_fail = items.iter().any(|i| i.status == TestStatus::Fail);
    let has_warn = items.iter().any(|i| i.status == TestStatus::Warn);
    let overall_status = if has_fail {
        TestStatus::Fail
    } else if has_warn {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if mdm_enrolled == Some(true) || activation_locked == Some(true) {
        "ALERT: MDM or Apple Activation Lock is active! Must be cleared before sale.".to_string()
    } else if has_warn {
        "No MDM/Activation Lock detected; check FileVault/SIP notes.".to_string()
    } else {
        "Clean of MDM & Activation Lock, FileVault Off, SIP Enabled.".to_string()
    };

    SecurityAuditReport {
        overall_status,
        platform: "macOS".to_string(),
        mdm_enrolled,
        activation_locked,
        items,
        summary,
    }
}
