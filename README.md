# LaptopBench QC v2.6.0

> **Created by Hein Htet Zaw • Telegram: @ich8g92**

**LaptopBench QC v2.6.0** is an offline-first, native-Rust-powered cross-platform laptop hardware diagnostics, hardware-safe durability burn-in, and Quality Control (QC) desktop suite for **Windows (x64)** and **macOS (Apple Silicon + Intel Universal)** — built with **Tauri v2**, **Rust**, **AVX2/NEON SIMD**, **wgpu**, and **React + TypeScript** using a clean Novabench/OCCT-inspired **White, Black & Cobalt Blue** (`#FFFFFF`, `#09090B`, `#2563EB`) sequential step-by-step interface.

## What's New in v2.6.0 — Express Auto-QC, Cosmetic Grading & Photos, Warranty Return-Unit Archive & OEM Thermal Sensors

- **1-Click Express Auto-QC Queue (`Fast Intake 2m` vs `Deep Resale QC 8m`)** — Runs Specs, Network, BIOS/Security, Battery, Crash Logs, SSD SMART + Direct-IO, RAM/CPU/GPU stress, and Hardware Controls automatically in one queue, then jumps directly to human-interactive stages.
- **Physical & Cosmetic Grading + Up to 4 Condition Photos** — Grade units (`A+ Mint` / `A Clean` / `B Minor Wear` / `C Heavy Wear`), toggle 6 physical checks (`Chassis`, `Screen Coating`, `Hinges`, `Palmrest`, `Screws/Seals`, `OEM Charger`), and attach photos via File Upload or Webcam Snapshot straight into exported HTML/PDF Certificates.
- **Searchable Tested-Laptop Warranty Archive + Automatic Return-Unit Anti-Fraud Diff** — Every exported QC Certificate is auto-archived locally by Serial Number (`qc_archive.json`) with instant search, 1-click PDF/HTML launch, JSON backup/import, and automatic alerts if a returning unit's Battery %, SSD serial/wear, or RAM capacity changed since sale!
- **Expanded Windows OEM Thermal Fallbacks** — Adds Dell (`DCIM_NumericSensor`), HP (`HP_BIOSNumericSensor`), Generic `CIM_TemperatureSensor`, and HWiNFO64 WMI (`root\HWiNFO`) temperature fallbacks alongside ACPI, LHM, and NVML.

## Highlights from v2.5.0 — True OCCT CPU Stress Engine, Dual Graphs & Summary-First Inner Screens

- **Native Rust OCCT-Style Continuous CPU Stress Engine (`cpu_stress.rs`)** — Selectable `Small / Medium / Large` data set, `Steady` vs `Variable Spikes` load mode, `All Cores` vs `Physical Only`, deterministic per-thread mathematical checksum error detection, live Windows **WHEA-Logger Event ID 19** hardware error counter, optional **Stop on First Error**, hard thermal cutoff (`85–95 °C`), and **15–30s Post-Load Cool-Down Recovery Check** (`Δ°C` drop rate to catch clogged fans or dried thermal paste).
- **Dual Live Oscilloscope Graphs in Stress Lab** — Live Performance (Clock/FPS/GB/s) + Thermal Curve graphs side by side, with Stress Lab results exported straight into the PDF / HTML / JSON QC Certificate.
- **Novabench Summary-First Inner Stages** — Added reusable `NovabenchScoreBar` & collapsible `TechnicalDetailsDrawer` across `SpecsView`, `PerformanceView`, `StorageView`, `BatteryView`, and `PortsSpeakersView` to eliminate dense text clutter.

## Highlights from v2.4.0 — BIOS Lock Status, Live Brightness/Radios/Headphone Checks & macOS First-Launch Guide

- **BIOS / Firmware Lock Status (`LOCKED` / `UNLOCKED` / `VERIFY`)** — Stage 02 now queries OEM BIOS Supervisor/Admin Password status (Dell `DCIM_BIOSPassword`, Lenovo `Lenovo_BiosPasswordSettings`, HP `HP_BIOSSetting`, macOS `firmwarepasswd` & Apple Silicon Recovery/Activation Lock) and surfaces a clear `BIOS: LOCKED / UNLOCKED / VERIFY` indicator.
- **Live Display Brightness, Keyboard Backlight, Wi-Fi, Bluetooth, Airplane Mode & 3.5mm Headphone Jack Checks** — Native Rust probes (`hardware_controls.rs`) with live Display Brightness control & `20% → 100%` sweep in Stage 06, Keyboard Backlight verification in Stage 08, and full live hardware radio/headphone/brightness verification matrix in Stage 14.
- **macOS Sequoia / Tahoe First-Launch Gatekeeper Fix** — Added `entitlements.plist`, expanded `Info.plist` Bluetooth/Local Network permissions, automatic Apple Developer ID signing/notarization hooks + strict ad-hoc signing in CI, and a 1-click [`scripts/Open-LaptopBench-Mac.command`](scripts/Open-LaptopBench-Mac.command) helper.

### macOS First-Launch Instructions (Gatekeeper)
If macOS shows *"Apple could not verify LaptopBench QC is free of malware"* on first launch (standard for open-source unsigned builds):
1. Drag **LaptopBench QC** into **Applications**.
2. Open **Terminal** and run:
   ```bash
   xattr -cr "/Applications/LaptopBench QC.app" && open "/Applications/LaptopBench QC.app"
   ```
   *(Or click **Done**, then open **System Settings → Privacy & Security → Security → Open Anyway**.)*

## Highlights from v2.3.0 — Real-World Calibration, Safety Bounds & Long-Term Reliability

- **UserBenchmark Offline-First Comparison & Vehicle Tiers** — Evaluates CPU, GPU, SSD, and RAM against mobile-aware UserBenchmark-calibrated hardware tiers (**UFO** down to **Raft**), **Gaming / Desktop / Workstation** scores, Same-Class Standing (`Above Expectations`, `As Expected`, `Below Expectations`, `Underperforming`), bottleneck detection, plain-language buyer takeaways, and optional non-blocking live lookup fallback.
- **PassMark-11 Weighted Harmonic Mean Calibration** — Computes CPU Mark (9 subtests: Single-Core, Integer, Float, Prime, Vector AVX2/NEON, Encryption, Compression, Sorting, Physics) and Memory Mark (Database, Cached/Uncached Read, Write, Available RAM, Latency, Threaded) alongside Office, Creator AI GEMM, and 3D Path-Tracer scopes.
- **Battery Discharge Normality Test** — Two-phase Idle + Load battery discharge diagnostic measuring average watts, power draw stability (`CV%`), voltage sag (`mV`), SoC cliff detection (`>=3%/5s`), BMS drift ratio, and wear indicators to classify discharge behavior as **`NORMAL`** or **`ABNORMAL`** (gracefully handling `AC_CONNECTED`, `NOT_APPLICABLE`, and `<=15%` low-SoC safety aborts).
- **Interactive Touchscreen Display Test (Stage 07)** — Fullscreen-ready `16x10` dead-zone grid coverage, multi-touch `pointerId` tracking, swipe linearity RMS error, and touch polling rate (`Hz`), with one-click **Skip Step** on non-touch laptops.
- **23-Pattern MonitorTest Display Check & NKRO Keyboard Suite** — Expanded persistence/burn-in, Moiré dot/line, power-supply zooming, gamma, and 256-step gradient patterns in an unobstructed fullscreen portal, plus stuck-key pre-check, NKRO rollover counter, and `<25ms` key-chatter detection.
- **Hard Hardware-Safety Bounds Enforced in Native Rust**:
  - **Thermal Cutoffs**: CPU `<=95°C` (default `92°C`) and GPU/VRAM `<=92°C` (clamped `75–92°C`) mid-stage safety abort.
  - **SSD Safe Write Budget**: Capped at `128 MB` (Quick), `256 MB` (Standard), or `512 MB` (Burn-In), requiring `>= 4x` free disk space (min `2048 MB`) with RAII `TempFileGuard` cleanup.
  - **RAM OS Reserve Headroom**: Protects `>= max(512 MB, 22% RAM)` capped at `1800 MB` for OS & WebView2 stability.
  - **Battery Safety Bounds**: `<=15%` SoC abort floor and `90s` hard discharge test cap.
- **Swiss Lab Certificates (PDF + HTML + Tamper-Check JSON)** — Plain-language `"What This Means for Long-Term Use"` buyer summary, UserBenchmark standings, Battery Discharge Normality, Touchscreen & Network diagnostics, offline QR seal, and `"Created by Hein Htet Zaw • Telegram: @ich8g92"` attribution.

## 14-Step Sequential Diagnostic Pipeline (Windows & macOS Parity)

Every stage runs in a locked sequential pipeline with an explicit **`Skip Step`** option on every module:

1. **All-Hardware Specifications & Network Diagnostics** — CPU, caches, RAM DIMM slots/channel mode, iGPU/dGPU, NVMe/SATA drives, displays, Wi-Fi signal/RSSI, USB/audio/camera peripherals, plus live gateway ping, packet loss, and DNS resolution check.
2. **Lock, MDM & License Audit** — Windows Intune/Autopilot/Azure AD, OEM license, BitLocker, TPM 2.0, Secure Boot; macOS DEP/MDM (`profiles`), Activation Lock / Find My Mac, FileVault, SIP.
3. **Battery Health, Voltage Sag & Discharge Normality** — Design vs Full capacity, wear %, cycle count, live wattage monitor, 15s voltage sag pulse, and two-phase Battery Discharge Normality classifier.
4. **System Error & Crash Logs** — Windows Event Logs & Minidumps (BSOD, Kernel-Power 41, WHEA, Disk, GPU TDR, thermal events); macOS `panic-full` DiagnosticReports & unified logs.
5. **SSD SMART Health (DriveDx-Style) & Direct I/O Benchmark** — NVMe SMART Log `0x02` (`Percentage Used`, `Available Spare`, `Critical Warning`, `Media Errors`, `Unsafe Shutdowns`, `TBW`) plus unbuffered Direct I/O Seq, 4K QD1/QD32, 70/30 Mixed, SLC sustained curve, and read-back verification within safe `128/256/512 MB` budgets.
6. **Display Fullscreen Check (23 MonitorTest Patterns)** — Unobstructed borderless fullscreen with hover-only HUD: dead pixels, backlight bleed, Moiré dot/line, burn-in persistence, gamma, 256-step gradients, power-supply zooming, and motion Hz.
7. **Touchscreen & Multi-Touch Display Test** — Interactive `16x10` grid coverage, simultaneous multi-touch tracking, swipe linearity RMS, polling Hz, and 1-click **Skip Step** for non-touch laptops.
8. **Keyboard & Touchpad Test** — Windows Compact, Windows Full + Numpad, and MacBook layouts, stuck-key pre-check, NKRO rollover counter, key latency, `<25ms` chatter detection, and low-level Windows hook.
9. **Fingerprint & Face ID Biometrics** — Sensor hardware & driver health check plus live Windows Hello / macOS Touch ID prompt.
10. **Camera & Microphone Test** — Live webcam resolution/FPS preview, microphone SNR & dB waveform, and 3-second loopback playback.
11. **RAM Stress Test (TestMem5 Engine)** — Native multi-threaded `MT0.dll` kernels (`RefreshStable`, `SimpleTest 1MB–64MB` with prime `257/359/479` & `256` strides, `MirrorMove`, `MirrorMove128`, `BlockMove`) respecting OS reserve headroom and CPU thermal cutoff.
12. **360° Perf & Creator Suite + UserBenchmark Calibration** — PassMark-11 Weighted Harmonic Mean CPU & Memory Marks, AVX2/NEON SIMD GEMM, 3D Path-Tracer, Hot-CPU Throttle Drop %, Shop Model History, and UserBenchmark Vehicle Tier standings.
13. **GPU Burn-In, VRAM Integrity & Combined Power Torture** — Native `wgpu` FurMark-2 shader stress with artifact & throttle detection, Dedicated VRAM Integrity sweep (`<=92°C` cutoff), and Simultaneous CPU+GPU+RAM Power & AC Charger Torture.
14. **Ports & Speakers Sign-Off + Branded QC Export** — Left/Right/Stereo speaker sweep, physical port checklist, persistent Shop Profile, and offline **PDF + HTML + SHA-256 JSON** certification export.

## Local Development, Testing & Windows GNU Toolchain

```powershell
# Windows GNU builds require w64devkit\windres-only first on PATH (filtering WinLibs/MinGW):
$w = "$env:LOCALAPPDATA\w64devkit\windres-only"
$cleanPath = ($env:PATH -split ';' | Where-Object { $_ -and ($_ -notmatch 'mingw|WinLibs|WinGet') }) -join ';'
$env:PATH = "$w;$cleanPath"

# Install & build frontend
pnpm install
pnpm exec tsc --noEmit
pnpm build

# Run Rust unit tests & build debug binary
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml

# Run CLI hardware & safety self-test
.\src-tauri\target\debug\laptopbench-qc.exe --self-test

# Build production installers (.msi/.exe on Windows, .dmg/.app on macOS)
pnpm tauri build
```

## Automated Windows + macOS Universal Releases

Push a version tag (e.g., `git tag v2.6.0 && git push --tags`) or manually trigger `.github/workflows/release.yml` to compile and publish:
- **Windows x64**: `.msi` and `.exe` (NSIS) installers
- **macOS Universal (Apple Silicon + Intel)**: `.dmg` bundle
