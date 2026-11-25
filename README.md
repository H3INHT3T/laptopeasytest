# LaptopBench QC

> **Created by Hein Htet Zaw** • Telegram: `@ich8g92`

**LaptopBench QC** is a 100% offline, native-Rust-powered cross-platform laptop hardware diagnostics and Quality Control (QC) desktop suite for **Windows** and **macOS**, built with **Tauri v2**, **Rust**, **wgpu**, and **React + TypeScript** using a clean **White, Black & Blue** sequential step-by-step interface.

## Included Diagnostic Modules (Windows & macOS Parity)

1. **System Specifications** — Full CPU, RAM DIMM slots/speed, integrated & discrete GPUs, NVMe/SATA storage, display panels, BIOS/firmware, and serial number detection (auto-detects Gaming / Pro dGPU laptops).
2. **Lock, MDM & License Audit**
   - **Windows**: Intune / Autopilot / Azure AD / Domain join (`dsregcmd`), OEM Windows activation license, BitLocker status, TPM 2.0, UEFI Secure Boot.
   - **macOS**: DEP / MDM enrollment (`profiles`), Apple Activation Lock / Find My Mac, FileVault, SIP.
3. **Battery Health & Guided Live Charge/Discharge** — Design vs Full capacity, health/wear %, cycle count, voltage, adapter wattage, plus a live 1-second charge/discharge wattage monitor guiding unplug & replug verification.
4. **System Error & Crash Logs** — Scans Windows System/Application Event Logs & `C:\Windows\Minidump` (BSOD/BugCheck, Kernel-Power 41, WHEA hardware, Disk I/O, GPU TDR) and macOS `panic-full` DiagnosticReports & unified logs.
5. **Display Check (MonitorTest Suite)** — True borderless fullscreen 15-pattern suite: Solid RGB/CMY/B/W dead-pixel screens, dark-gray backlight-bleed uniformity, RGB/Grayscale gradients, contrast/gamma steps, geometry grid, and motion/ghosting bar with live measured Hz.
6. **Keyboard Test (Offline Key-Test)** — Visual keyboard with Windows Compact, Windows Full + Numpad, and MacBook layouts, live press/tested highlighting, `<25ms` key-chatter bounce detector, and optional Windows low-level hook (`Win` / `PrintScreen` capture).
7. **SSD Health (SMART) & Speed Benchmark (DriveDx-inspired)** — NVMe/SATA SMART wear, health %, temp, power-on hours, media errors, plus a safe non-destructive temporary-file Sequential & Random 4K Read/Write benchmark.
8. **RAM Stress Test (TestMem5 Engine)** — Multi-threaded native Rust deterministic bit-pattern verifier (Checkerboard, Walking 1/0, Address XOR Moving Inversion, SplitMix64 PRNG) with Quick QC / Standard / Burn-in presets.
9. **Fingerprint & Face ID Biometrics** — Two-stage check: detects sensor hardware & driver health first (supports freshly reset laptops cleanly), plus optional live Windows Hello / macOS Touch ID prompt.
10. **Camera & Microphone Test** — Live webcam preview with resolution/FPS readout + live microphone waveform, dB meter, and 3-second Record & Playback loopback.
11. **Performance Benchmark (PerformanceTest-inspired)** — Single-core, multi-core, SHA-256 crypto, FP64 matrix multiply, and memory bandwidth composite score & tier rating with live CPU temperature readout.
12. **Gaming GPU Stress (FurMark wgpu Engine)** — Native Rust `wgpu` (DX12 / Vulkan / Metal) procedural raymarched 3D furry-torus stress test with GPU adapter picker, live FPS/frame-time/temperature/power telemetry, and safety thermal cutoff.
13. **Pre-Report Ports & Speaker Reminder + Branded Export** — Prompts physical ports & stereo speaker verification (with built-in Left/Right/Stereo test chimes), saves default **Shop Name**, **Technician Username**, and optional **Shop Logo**, and exports **PDF Certificate + Branded HTML + JSON Archive**.

## Local Development & Building

### Prerequisites
- Rust stable (`x86_64-pc-windows-msvc` on Windows; `aarch64-apple-darwin` / `x86_64-apple-darwin` on macOS)
- Node.js 20+ & `pnpm`
- Windows: Visual Studio C++ Build Tools (run from a VS Developer prompt or load `vcvars64.bat`)

### Commands
```bash
# Install frontend dependencies
pnpm install

# Run Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run in development mode
pnpm tauri dev

# Build production installers (.msi/.exe on Windows, .dmg/.app on macOS)
pnpm tauri build
```

## Automated Windows + macOS Universal Releases

Push a git tag (e.g., `git tag v1.0.0 && git push --tags`) or manually trigger the included GitHub Actions workflow at `.github/workflows/release.yml` to compile and upload both:
- **Windows x64** `.msi` and `.exe` (NSIS) installers (with embedded UAC Administrator manifest)
- **macOS Universal (Apple Silicon + Intel)** `.dmg` and `.app` bundles
