fn main() {
    #[cfg(target_os = "windows")]
    {
        // Embed Administrator UAC manifest in release builds (unless LAPTOPBENCH_NO_ELEVATE=1)
        // so NVMe/SATA SMART, BitLocker, OEM licensing, and full Event Logs work seamlessly.
        let is_release = std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false);
        let skip_elevate = std::env::var("LAPTOPBENCH_NO_ELEVATE").map(|v| v == "1").unwrap_or(false);

        if is_release && !skip_elevate {
            let windows = tauri_build::WindowsAttributes::new().app_manifest(
                r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#,
            );
            tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
                .expect("failed to run tauri-build with Windows UAC manifest");
            return;
        }
    }

    tauri_build::build();
}
