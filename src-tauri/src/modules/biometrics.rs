use crate::types::{BiometricAuthResult, BiometricSensorInfo, BiometricsHardwareReport, TestStatus};

pub fn detect_biometrics_hardware() -> BiometricsHardwareReport {
    #[cfg(target_os = "windows")]
    {
        detect_windows_biometrics()
    }
    #[cfg(target_os = "macos")]
    {
        detect_macos_biometrics()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        BiometricsHardwareReport {
            platform: std::env::consts::OS.to_string(),
            fingerprint_present: false,
            face_ir_present: false,
            sensors: Vec::new(),
            suggested_status: TestStatus::NotApplicable,
            summary: "Biometric detection not implemented on this OS.".to_string(),
        }
    }
}

pub fn trigger_live_biometric_prompt() -> BiometricAuthResult {
    #[cfg(target_os = "windows")]
    {
        trigger_windows_hello_prompt()
    }
    #[cfg(target_os = "macos")]
    {
        trigger_macos_touchid_prompt()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        BiometricAuthResult {
            outcome: "NotPresent".to_string(),
            status: TestStatus::NotApplicable,
            message: "Biometric prompt not supported on this OS.".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_biometrics() -> BiometricsHardwareReport {
    use crate::cmd_util::run_powershell;
    use serde_json::Value;

    let ps = r#"
$fp = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Biometric'" -ErrorAction SilentlyContinue | ForEach-Object {
    @{ kind = 'Fingerprint'; name = [string]$_.Name; err = [int]$_.ConfigManagerErrorCode }
})
$ir = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object {
    ($_.PNPClass -in @('Camera','Image')) -and ($_.Name -match 'IR|Infrared|Hello|Depth|Facial')
} | ForEach-Object {
    @{ kind = 'Face ID / IR Camera'; name = [string]$_.Name; err = [int]$_.ConfigManagerErrorCode }
})
@{ fp = $fp; ir = $ir } | ConvertTo-Json -Depth 4 -Compress
"#;

    let mut sensors = Vec::new();
    let mut fp_present = false;
    let mut ir_present = false;

    if let Ok(raw) = run_powershell(ps) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = v["fp"].as_array() {
                for s in arr {
                    fp_present = true;
                    let err = s["err"].as_u64().map(|x| x as u32);
                    sensors.push(BiometricSensorInfo {
                        kind: "Fingerprint".to_string(),
                        name: s["name"].as_str().unwrap_or("Fingerprint Sensor").to_string(),
                        driver_ok: err.unwrap_or(0) == 0,
                        error_code: err,
                    });
                }
            }
            if let Some(arr) = v["ir"].as_array() {
                for s in arr {
                    ir_present = true;
                    let err = s["err"].as_u64().map(|x| x as u32);
                    sensors.push(BiometricSensorInfo {
                        kind: "Face ID / IR Camera".to_string(),
                        name: s["name"].as_str().unwrap_or("IR Camera").to_string(),
                        driver_ok: err.unwrap_or(0) == 0,
                        error_code: err,
                    });
                }
            }
        }
    }

    let any_driver_err = sensors.iter().any(|s| !s.driver_ok);
    let suggested_status = if sensors.is_empty() {
        TestStatus::NotApplicable
    } else if any_driver_err {
        TestStatus::Fail
    } else {
        TestStatus::Pass
    };

    let summary = if sensors.is_empty() {
        "No Fingerprint or Windows Hello IR Face hardware detected (mark N/A if laptop lacks biometrics)."
            .to_string()
    } else if any_driver_err {
        "Biometric sensor detected with a Windows Device Manager driver error!".to_string()
    } else {
        format!(
            "Detected {} biometric sensor(s) with healthy drivers. You may trigger a live Windows Hello prompt or approve as Hardware OK.",
            sensors.len()
        )
    };

    BiometricsHardwareReport {
        platform: "Windows".to_string(),
        fingerprint_present: fp_present,
        face_ir_present: ir_present,
        sensors,
        suggested_status,
        summary,
    }
}

#[cfg(target_os = "windows")]
fn trigger_windows_hello_prompt() -> BiometricAuthResult {
    use crate::cmd_util::run_powershell;

    let ps = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($avail -ne 'Available') {
    Write-Output "AVAIL:$avail"
    exit 0
}
$res = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('LaptopBench QC: Verify Fingerprint / Face ID')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "RESULT:$res"
"#;

    match run_powershell(ps) {
        Ok(out) => {
            let line = out.lines().last().unwrap_or("").trim();
            if line.contains("RESULT:Verified") {
                BiometricAuthResult {
                    outcome: "Verified".to_string(),
                    status: TestStatus::Pass,
                    message: "Windows Hello biometric verification succeeded!".to_string(),
                }
            } else if line.contains("NotConfiguredForUser") {
                BiometricAuthResult {
                    outcome: "NotEnrolled".to_string(),
                    status: TestStatus::Pass,
                    message: "Hardware ready — Windows Hello is not enrolled on this fresh Windows user account (OK for newly reset laptops)."
                        .to_string(),
                }
            } else if line.contains("DeviceNotPresent") {
                BiometricAuthResult {
                    outcome: "NotPresent".to_string(),
                    status: TestStatus::NotApplicable,
                    message: "Windows reports no biometric verification device present.".to_string(),
                }
            } else if line.contains("Canceled") {
                BiometricAuthResult {
                    outcome: "Canceled".to_string(),
                    status: TestStatus::Warn,
                    message: "Verification prompt was canceled by the technician.".to_string(),
                }
            } else {
                BiometricAuthResult {
                    outcome: "Error".to_string(),
                    status: TestStatus::Warn,
                    message: format!("Windows Hello returned: {}", line),
                }
            }
        }
        Err(e) => BiometricAuthResult {
            outcome: "Error".to_string(),
            status: TestStatus::Warn,
            message: format!("Could not launch Windows Hello prompt: {}", e),
        },
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_biometrics() -> BiometricsHardwareReport {
    use crate::cmd_util::run_cmd_stdout;

    let mut sensors = Vec::new();
    let mut fp_present = false;

    if let Ok(io) = run_cmd_stdout("ioreg", &["-r", "-c", "AppleBiometricSensor"]) {
        if io.contains("AppleBiometricSensor") {
            fp_present = true;
            sensors.push(BiometricSensorInfo {
                kind: "Touch ID".to_string(),
                name: "Apple Touch ID Sensor (Secure Enclave)".to_string(),
                driver_ok: true,
                error_code: Some(0),
            });
        }
    }
    if !fp_present {
        if let Ok(bio) = run_cmd_stdout("bioutil", &["-r"]) {
            if bio.to_lowercase().contains("touch id") {
                fp_present = true;
                sensors.push(BiometricSensorInfo {
                    kind: "Touch ID".to_string(),
                    name: "Apple Touch ID".to_string(),
                    driver_ok: true,
                    error_code: Some(0),
                });
            }
        }
    }

    let suggested_status = if fp_present {
        TestStatus::Pass
    } else {
        TestStatus::NotApplicable
    };

    let summary = if fp_present {
        "Apple Touch ID hardware detected (Face ID is N/A on macOS laptops). Trigger Touch ID prompt or approve as Hardware OK."
            .to_string()
    } else {
        "No Touch ID sensor detected on this Mac.".to_string()
    };

    BiometricsHardwareReport {
        platform: "macOS".to_string(),
        fingerprint_present: fp_present,
        face_ir_present: false,
        sensors,
        suggested_status,
        summary,
    }
}

#[cfg(target_os = "macos")]
fn trigger_macos_touchid_prompt() -> BiometricAuthResult {
    use crate::cmd_util::run_cmd_stdout;

    let swift_code = r#"
import LocalAuthentication
import Foundation
let ctx = LAContext()
var err: NSError?
if !ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
    let code = (err?.code ?? -1)
    if code == LAError.biometryNotEnrolled.rawValue {
        print("NOT_ENROLLED")
    } else if code == LAError.biometryNotAvailable.rawValue {
        print("NOT_PRESENT")
    } else {
        print("UNAVAILABLE:\(err?.localizedDescription ?? "")")
    }
    exit(0)
}
let sem = DispatchSemaphore(value: 0)
ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "LaptopBench QC: Verify Touch ID sensor") { ok, evalErr in
    if ok {
        print("VERIFIED")
    } else {
        print("FAILED:\(evalErr?.localizedDescription ?? "Canceled")")
    }
    sem.signal()
}
sem.wait()
"#;

    match run_cmd_stdout("swift", &["-e", swift_code]) {
        Ok(out) => {
            let line = out.lines().last().unwrap_or("").trim();
            if line == "VERIFIED" {
                BiometricAuthResult {
                    outcome: "Verified".to_string(),
                    status: TestStatus::Pass,
                    message: "Touch ID verified successfully!".to_string(),
                }
            } else if line == "NOT_ENROLLED" {
                BiometricAuthResult {
                    outcome: "NotEnrolled".to_string(),
                    status: TestStatus::Pass,
                    message: "Touch ID hardware present — no fingerprint enrolled yet (OK for freshly wiped MacBook)."
                        .to_string(),
                }
            } else if line == "NOT_PRESENT" {
                BiometricAuthResult {
                    outcome: "NotPresent".to_string(),
                    status: TestStatus::NotApplicable,
                    message: "Touch ID biometry not available on this Mac.".to_string(),
                }
            } else {
                BiometricAuthResult {
                    outcome: "Canceled".to_string(),
                    status: TestStatus::Warn,
                    message: format!("Touch ID prompt result: {}", line),
                }
            }
        }
        Err(e) => BiometricAuthResult {
            outcome: "Error".to_string(),
            status: TestStatus::Warn,
            message: format!("Could not invoke Touch ID prompt (Swift runtime unavailable): {}", e),
        },
    }
}
