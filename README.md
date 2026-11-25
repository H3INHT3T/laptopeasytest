# LaptopBench QC v2.0

> **Created by Hein Htet Zaw** • Telegram: `@ich8g92`

**LaptopBench QC v2.0** is a 100% offline, native-Rust-powered cross-platform laptop hardware diagnostics, durability burn-in, and Quality Control (QC) desktop suite for **Windows (x64)** and **macOS (Apple Silicon + Intel Universal)** — built with **Tauri v2**, **Rust**, **AVX2/NEON SIMD**, **wgpu**, and **React + TypeScript** using a clean **White, Black & Cobalt Blue** sequential step-by-step interface.

## What's New in v2.0 — 360° All-Scope Performance & Durability Engine

- **Bare-Metal SIMD Kernels (`x86_64 AVX2+FMA` & `ARM64 NEON`)** for high-throughput AI Dense Matrix Multiply (GEMM) and Creator 1080p Image Convolution.
- **Cinebench-Style Multi-Core 3D Path-Tracing Renderer** streaming live 32×32 progressive studio render tiles with Mega-Rays/sec scoring.
- **Full 14-Stage All-Scope Performance Suite (Step 11)** producing **Office Scope**, **Creator & AI Scope**, **CPU Multi-Core**, **Memory Mark**, **Hot-CPU Throttle Drop %**, and an overall **A+ to FAIL Durability Grade**.
- **Dedicated GPU VRAM Integrity Test (Step 12)** — OCCT-style native `wgpu` compute shader sweeping 256 MB–4 GB GPU VRAM pools across 4 deterministic bit-patterns to expose failing GDDR chips & artifacts.
- **Combined CPU + GPU + RAM Power & AC Charger Torture (Step 12)** — pushes the entire chassis to 100% simultaneous load and flags **Battery Drain While Plugged In** (catches under-rated/fake chargers and weak DC-in circuits) plus thermal safety cutoff.
- **Zero-Driver Native Telemetry + Auto-Link** — native OS clocks/usage, NVIDIA NVML (`nvidia-smi`), AC/Battery wattage, macOS IOKit/SMC, plus automatic Windows WMI bridge when **LibreHardwareMonitor / OpenHardwareMonitor** is running.
- **Factory Normal Baselines + Auto-Learning Shop Model History** — compares each tested laptop against BOTH factory normal ranges AND your shop's own rolling average for that exact model (`shop_model_history.json` with Export/Import JSON across shop benches).
- **1-Click Unattended Shelf Burn-In Marathon (5m / 15m / 30m)** — hands-free sequential RAM → GPU VRAM → Combined CPU+GPU+RAM Power Torture right from the Dashboard.

## 13-Step Sequential Diagnostic Pipeline (Windows & macOS Parity)

1. **All-Hardware Specifications** — Complete CPU, caches, RAM DIMM slots/speed/serials, integrated & discrete GPUs, NVMe/SATA drives, volumes, displays, network adapters, USB/audio/camera peripherals, motherboard, BIOS, and serial numbers.
2. **Lock, MDM & License Audit** — Windows Intune/Autopilot/Azure AD/Domain (`dsregcmd`), OEM activation, BitLocker, TPM 2.0, Secure Boot; macOS DEP/MDM (`profiles`), Activation Lock / Find My Mac, FileVault, SIP.
3. **Battery Health & Guided Live Charge/Discharge** — Design vs Full capacity, health/wear %, cycles, voltage, live wattage chart guiding unplug & replug verification.
4. **System Error & Crash Logs** — Windows Event Logs & Minidumps (BSOD, Kernel-Power 41, WHEA, Disk, GPU TDR); macOS `panic-full` DiagnosticReports & unified logs.
5. **SSD SMART Health & Direct I/O Durability Benchmark** — NVMe/SATA SMART wear, health %, temp, power-on hours, media errors, plus unbuffered Direct I/O Sequential + Random 4K IOPS/Latency + Read-Back Data Integrity verification.
6. **Display Fullscreen Check (19 MonitorTest Patterns)** — True borderless fullscreen with bottom-edge hover-only HUD and auto-hiding cursor: dead-pixel colors, backlight-bleed grays, RGB/grayscale gradients, gamma/contrast steps, geometry grids, and motion/ghosting bar with live Hz.
7. **Keyboard Test (Offline Key-Test)** — Windows Compact, Windows Full + Numpad, and MacBook layouts, live pressed/tested highlighting, `<25ms` key-chatter detector, and Windows low-level hook (`Win` / `PrintScreen`).
8. **Fingerprint & Face ID Biometrics** — Two-stage check: detects sensor hardware & driver health first, plus optional live Windows Hello / macOS Touch ID prompt.
9. **Camera & Microphone Test** — Live webcam preview with resolution/FPS readout + live microphone waveform, dB meter, and 3-second Record & Playback loopback.
10. **RAM Stress Test (TestMem5 Engine)** — Multi-threaded native Rust time-enforced TM5 profiles (`Default @ serj`, `Absolut @ anta777`, `Extreme @ anta777`) verifying RefreshStable, SimpleTest, MirrorMove, and MirrorMove128.
11. **360° All-Scope Performance & Creator Suite (v2.0)** — 14-stage PassMark 11 + Office + SIMD AI GEMM + Cinebench-style 3D Path-Tracer + Memory + Hot-CPU Throttle Drop + Factory & Shop Model History comparison.
12. **GPU Burn-In, Dedicated VRAM Integrity & Combined Power Torture (v2.0)** — Native `wgpu` FurMark 2 3D shader stress, Dedicated VRAM Compute Integrity sweep, and Simultaneous CPU+GPU+RAM Power & Charger Torture.
13. **Ports & Speakers Sign-Off + Branded QC Export** — Built-in Left/Right/Stereo speaker chimes, physical port checklist, persistent Shop Name / Technician / Logo, and offline **PDF Certificate + Branded HTML + JSON Archive** export.

## Local Development & Building

```bash
# Install frontend dependencies
pnpm install

# Build frontend
pnpm build

# Run in development mode
pnpm tauri dev

# Build production installers (.msi/.exe on Windows, .dmg/.app on macOS)
pnpm tauri build
```

## Automated Windows + macOS Universal Releases

Push a git tag (e.g., `git tag v2.0.0 && git push --tags`) or manually trigger `.github/workflows/release.yml` to compile and upload both:
- **Windows x64** `.msi` and `.exe` (NSIS) installers
- **macOS Universal (Apple Silicon + Intel)** `.dmg` bundle
