fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let is_release = std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false);
    let skip_elevate = std::env::var("LAPTOPBENCH_NO_ELEVATE")
        .map(|v| v == "1")
        .unwrap_or(false);

    if target_os == "windows" && is_release && !skip_elevate {
        // Embed Administrator UAC manifest in release builds (unless LAPTOPBENCH_NO_ELEVATE=1)
        // so NVMe/SATA SMART, BitLocker, OEM licensing, and full Event Logs work seamlessly.
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

    tauri_build::build();

    if target_os == "windows" && target_env == "gnu" && !is_release {
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            let out_path = std::path::Path::new(&out_dir);
            let res_a = out_path.join("libresource.a");
            if res_a.exists() {
                // embed-resource only emits rustc-link-arg-bins; [lib] unit-test binaries
                // require the Common-Controls v6 manifest for comctl32!TaskDialogIndirect,
                // and Cargo rejects rustc-link-arg-tests when no [[test]] target exists.
                println!("cargo:rustc-link-arg={}", res_a.display());
            }
            // Ensure WebView2Loader.dll is also present next to test binaries in deps/.
            if let Some(target_dir) = out_path
                .ancestors()
                .find(|p| p.file_name() == Some(std::ffi::OsStr::new("build")))
                .and_then(|p| p.parent())
            {
                let dll = target_dir.join("WebView2Loader.dll");
                let deps_dir = target_dir.join("deps");
                let deps_dll = deps_dir.join("WebView2Loader.dll");
                if dll.exists() {
                    let _ = std::fs::create_dir_all(&deps_dir);
                    let _ = std::fs::copy(&dll, &deps_dll);
                }
            }
        }
    }
}
