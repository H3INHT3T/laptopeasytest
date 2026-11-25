use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates a Command that never flashes a visible console window on Windows.
pub fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs a PowerShell script silently on Windows and returns stdout as UTF-8 String.
#[cfg(target_os = "windows")]
pub fn run_powershell(script: &str) -> Result<String, String> {
    let wrapped = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; {}",
        script
    );
    let output = silent_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &wrapped])
        .output()
        .map_err(|e| format!("Failed to invoke powershell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() || !stdout.is_empty() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() {
            format!("PowerShell exited with status {}", output.status)
        } else {
            stderr
        })
    }
}

/// Runs a shell/command silently and returns stdout.
pub fn run_cmd_stdout(program: &str, args: &[&str]) -> Result<String, String> {
    let output = silent_command(program)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute '{}': {}", program, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() || !stdout.is_empty() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("'{}' exited with {}", program, output.status)
        } else {
            stderr
        })
    }
}

/// Checks if the current process is running with elevated Administrator/root privileges.
pub fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        run_powershell("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)")
            .map(|s| s.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        run_cmd_stdout("id", &["-u"])
            .map(|s| s.trim() == "0")
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}
