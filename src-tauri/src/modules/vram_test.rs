use crate::modules::{
    baselines,
    telemetry::{TelemetryReader, ThermalSafetyCheck},
};
use crate::types::{
    LiveTelemetrySnapshot, TestStatus, VramTestProgress, VramTestResult,
    GPU_THERMAL_CUTOFF_DEFAULT_C, GPU_THERMAL_CUTOFF_MAX_C, GPU_THERMAL_CUTOFF_MIN_C,
};
use bytemuck::{Pod, Zeroable};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use wgpu::util::DeviceExt;

const VRAM_SHADER_WGSL: &str = include_str!("../shaders/vram_verify.wgsl");

pub(crate) fn clamp_gpu_thermal_cutoff(cutoff_c: f32) -> f32 {
    if !cutoff_c.is_finite() {
        GPU_THERMAL_CUTOFF_DEFAULT_C
    } else {
        cutoff_c.clamp(GPU_THERMAL_CUTOFF_MIN_C, GPU_THERMAL_CUTOFF_MAX_C)
    }
}

pub(crate) fn compute_vram_sensor_bounded_duration(
    duration_secs: u64,
    sensor_unavailable: bool,
) -> u64 {
    if sensor_unavailable {
        duration_secs.min(180)
    } else {
        duration_secs
    }
}

fn poll_gpu_thermal(
    telemetry: &mut TelemetryReader,
    safe_cutoff_c: f32,
) -> (Option<f32>, ThermalSafetyCheck) {
    let (gpu_temp_c, gpu_load_pct, gpu_power_w) = telemetry.sample_gpu_only();
    let snap = LiveTelemetrySnapshot {
        gpu_temp_c,
        gpu_load_pct,
        gpu_power_w,
        gpu_temp_available: gpu_temp_c.is_some(),
        ..Default::default()
    };
    let check = TelemetryReader::is_thermal_safe(&snap, f32::INFINITY, safe_cutoff_c);
    (gpu_temp_c, check)
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct VramParams {
    seed: u32,
    pattern_mode: u32,
    word_count: u32,
    _pad: u32,
}

const PATTERN_NAMES: [&str; 4] = [
    "Pattern 0: Alternating Checkerboard (0xAAAA5555)",
    "Pattern 1: Walking 1-Bit Bus Line Sweep",
    "Pattern 2: Inverted Walking 0-Bit Retention",
    "Pattern 3: High-Entropy Address PRNG Hash",
];

/// Runs a fast 1 MB compute shader verification pass for `--self-test` hardware validation.
pub fn smoke_test_vram_shader() -> Result<String, String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    let adapter = adapters
        .into_iter()
        .find(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
        .ok_or_else(|| "No hardware wgpu adapter available for VRAM smoke test".to_string())?;
    let name = adapter.get_info().name;

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("VRAM Smoke Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .map_err(|e| format!("Failed to open GPU device: {}", e))?;

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("VRAM Verify Shader"),
        source: wgpu::ShaderSource::Wgsl(VRAM_SHADER_WGSL.into()),
    });

    let words: u32 = 262_144; // 1 MB
    let vram_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("VRAM Smoke Buffer"),
        size: (words as u64) * 4,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let err_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Error Counter"),
        contents: bytemuck::cast_slice(&[0u32]),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
    });
    let err_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Error Readback"),
        size: 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let params = VramParams {
        seed: 0x1357_9BDF,
        pattern_mode: 3,
        word_count: words,
        _pad: 0,
    };
    let param_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Params"),
        contents: bytemuck::cast_slice(&[params]),
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let bgl = create_vram_bgl(&device);
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("VRAM PL"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let write_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("cs_write"),
        layout: Some(&pl),
        module: &shader,
        entry_point: Some("cs_write"),
        compilation_options: Default::default(),
        cache: None,
    });
    let verify_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("cs_verify"),
        layout: Some(&pl),
        module: &shader,
        entry_point: Some("cs_verify"),
        compilation_options: Default::default(),
        cache: None,
    });

    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("VRAM BG"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: param_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: vram_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: err_buf.as_entire_binding() },
        ],
    });

    let wg = (words + 255) / 256;
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        cpass.set_pipeline(&write_pipe);
        cpass.set_bind_group(0, &bg, &[]);
        cpass.dispatch_workgroups(wg, 1, 1);
    }
    {
        let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        cpass.set_pipeline(&verify_pipe);
        cpass.set_bind_group(0, &bg, &[]);
        cpass.dispatch_workgroups(wg, 1, 1);
    }
    enc.copy_buffer_to_buffer(&err_buf, 0, &err_readback, 0, 4);
    queue.submit(Some(enc.finish()));
    device.poll(wgpu::Maintain::Wait);

    let errs = read_u32_buffer(&device, &err_readback)?;
    if errs != 0 {
        return Err(format!("VRAM smoke test detected {} bit errors on {}!", errs, name));
    }
    Ok(format!("{} (1 MB wgpu compute verified, 0 errors)", name))
}

fn create_vram_bgl(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("VRAM Compute BGL"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

fn read_u32_buffer(device: &wgpu::Device, buf: &wgpu::Buffer) -> Result<u32, String> {
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    device.poll(wgpu::Maintain::Wait);
    rx.recv()
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("VRAM readback map failed: {:?}", e))?;
    let data = slice.get_mapped_range();
    let val = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    drop(data);
    buf.unmap();
    Ok(val)
}

/// OCCT-style Dedicated GPU VRAM Integrity Test using native `wgpu` Compute Shaders.
/// Allocates multiple 32 MB GPU storage chunks simultaneously so all memory banks hold live
/// bit patterns at once, then sweeps 4 deterministic patterns checking for GDDR/HBM bit flips.
pub fn run_vram_integrity_test(
    app: &AppHandle,
    adapter_index: Option<usize>,
    target_vram_mb: Option<u64>,
    duration_secs: u64,
    cancel: Arc<AtomicBool>,
) -> Result<VramTestResult, String> {
    run_vram_integrity_test_with_cutoff(
        app,
        adapter_index,
        target_vram_mb,
        duration_secs,
        GPU_THERMAL_CUTOFF_DEFAULT_C,
        cancel,
    )
}

pub fn run_vram_integrity_test_with_cutoff(
    app: &AppHandle,
    adapter_index: Option<usize>,
    target_vram_mb: Option<u64>,
    duration_secs: u64,
    thermal_cutoff_c: f32,
    cancel: Arc<AtomicBool>,
) -> Result<VramTestResult, String> {
    let safe_cutoff_c = clamp_gpu_thermal_cutoff(thermal_cutoff_c);
    let requested_duration_secs = duration_secs.clamp(20, 1800);

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let mut adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    if adapters.is_empty() {
        return Err("No compatible GPU adapter found by wgpu.".to_string());
    }
    let chosen_idx = match adapter_index {
        Some(idx) if idx < adapters.len() => idx,
        _ => adapters
            .iter()
            .position(|a| a.get_info().device_type == wgpu::DeviceType::DiscreteGpu)
            .unwrap_or(0),
    };
    let adapter = adapters.swap_remove(chosen_idx);
    let info = adapter.get_info();
    let adapter_name = info.name.clone();
    let backend_str = format!("{:?}", info.backend);
    let is_discrete = info.device_type == wgpu::DeviceType::DiscreteGpu;

    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("LaptopBench VRAM Integrity Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(limits.clone()),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .map_err(|e| format!("Failed to initialize GPU compute device: {}", e))?;

    // Each chunk is 32 MB (8,388,608 u32 words -> 32,768 workgroups, safely under 65,535 & 128 MB limits)
    let max_chunk_bytes = (32u64 * 1024 * 1024)
        .min(limits.max_storage_buffer_binding_size as u64)
        .min(limits.max_buffer_size);
    let chunk_mb = (max_chunk_bytes / (1024 * 1024)).max(8);
    let chunk_bytes = chunk_mb * 1024 * 1024;
    let words_per_chunk = (chunk_bytes / 4) as u32;
    let workgroups = (words_per_chunk + 255) / 256;

    let requested_mb = target_vram_mb.unwrap_or(if is_discrete { 1024 } else { 384 }).clamp(128, 4096);
    let num_chunks = ((requested_mb / chunk_mb) as usize).clamp(4, 128);
    let allocated_vram_mb = (num_chunks as u64) * chunk_mb;

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("VRAM Integrity Compute Shader"),
        source: wgpu::ShaderSource::Wgsl(VRAM_SHADER_WGSL.into()),
    });

    let bgl = create_vram_bgl(&device);
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("VRAM PL"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let write_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("cs_write"),
        layout: Some(&pl),
        module: &shader,
        entry_point: Some("cs_write"),
        compilation_options: Default::default(),
        cache: None,
    });
    let verify_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("cs_verify"),
        layout: Some(&pl),
        module: &shader,
        entry_point: Some("cs_verify"),
        compilation_options: Default::default(),
        cache: None,
    });

    let err_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("VRAM Error Atomic"),
        contents: bytemuck::cast_slice(&[0u32]),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
    });
    let err_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("VRAM Error Readback"),
        size: 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let param_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("VRAM Params"),
        contents: bytemuck::cast_slice(&[VramParams {
            seed: 0,
            pattern_mode: 0,
            word_count: words_per_chunk,
            _pad: 0,
        }]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    // Allocate all VRAM chunks upfront so the GPU memory controller holds the entire working set simultaneously
    let mut chunks = Vec::with_capacity(num_chunks);
    let mut bind_groups = Vec::with_capacity(num_chunks);
    for _i in 0..num_chunks {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("VRAM Chunk"),
            size: chunk_bytes,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("VRAM Chunk BG"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: err_buf.as_entire_binding() },
            ],
        });
        chunks.push(buf);
        bind_groups.push(bg);
    }

    struct VramThermalState {
        last_poll: Instant,
        cur_gpu_temp: Option<f32>,
        peak_temp: Option<f32>,
        cutoff_triggered: bool,
        sensor_polls: u32,
        sensor_available_ever: bool,
        duration_secs: u64,
        requested_duration_secs: u64,
        safe_cutoff_c: f32,
    }
    impl VramThermalState {
        fn poll(&mut self, telemetry: &mut TelemetryReader, started: &Instant, force: bool) -> bool {
            if !force && self.last_poll.elapsed() < Duration::from_millis(900) {
                return self.cutoff_triggered;
            }
            self.last_poll = Instant::now();
            self.sensor_polls += 1;
            let (gt, check) = poll_gpu_thermal(telemetry, self.safe_cutoff_c);
            self.cur_gpu_temp = gt;
            if let Some(t) = gt {
                self.sensor_available_ever = true;
                self.peak_temp = Some(self.peak_temp.map_or(t, |p| p.max(t)));
            }
            match check {
                ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => {
                    self.peak_temp = Some(self.peak_temp.map_or(temp_c, |p| p.max(temp_c)));
                    self.cutoff_triggered = true;
                    true
                }
                ThermalSafetyCheck::SensorUnavailable => {
                    if !self.sensor_available_ever
                        && self.sensor_polls >= 2
                        && started.elapsed().as_secs_f64() >= 2.0
                    {
                        self.duration_secs =
                            compute_vram_sensor_bounded_duration(self.requested_duration_secs, true);
                    }
                    false
                }
                ThermalSafetyCheck::Safe => {
                    self.sensor_available_ever = true;
                    false
                }
            }
        }
    }

    let mut telemetry = TelemetryReader::new();
    let started = Instant::now();
    let mut total_errors: u64 = 0;
    let mut total_gb_verified: f64 = 0.0;
    let mut passes_completed: u32 = 0;
    let mut cancelled = false;
    let mut thermal = VramThermalState {
        last_poll: Instant::now() - Duration::from_secs(5),
        cur_gpu_temp: None,
        peak_temp: None,
        cutoff_triggered: false,
        sensor_polls: 0,
        sensor_available_ever: false,
        duration_secs: requested_duration_secs,
        requested_duration_secs,
        safe_cutoff_c,
    };

    thermal.poll(&mut telemetry, &started, true);

    while !thermal.cutoff_triggered && started.elapsed().as_secs() < thermal.duration_secs {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let pattern_idx = (passes_completed as usize) % PATTERN_NAMES.len();
        let pass_seed = (passes_completed.wrapping_add(1))
            .wrapping_mul(0x9E37_79B9)
            ^ 0xA5A5_5A5A;

        // Reset atomic error counter to 0 before each pattern sweep
        queue.write_buffer(&err_buf, 0, bytemuck::cast_slice(&[0u32]));

        let t_pass = Instant::now();

        // Phase A: Write all chunks across VRAM banks (with <= 1s thermal polling)
        for (c_idx, bg) in bind_groups.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            if thermal.poll(&mut telemetry, &started, false) {
                break;
            }
            let p = VramParams {
                seed: pass_seed.wrapping_add((c_idx as u32).wrapping_mul(0x45D9_F3B)),
                pattern_mode: pattern_idx as u32,
                word_count: words_per_chunk,
                _pad: 0,
            };
            queue.write_buffer(&param_buf, 0, bytemuck::cast_slice(&[p]));
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            {
                let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                cpass.set_pipeline(&write_pipe);
                cpass.set_bind_group(0, bg, &[]);
                cpass.dispatch_workgroups(workgroups, 1, 1);
            }
            queue.submit(Some(enc.finish()));
        }
        device.poll(wgpu::Maintain::Wait);
        if cancelled || thermal.cutoff_triggered {
            break;
        }

        // Phase B: Verify all chunks back from VRAM (with <= 1s thermal polling)
        for (c_idx, bg) in bind_groups.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            if thermal.poll(&mut telemetry, &started, false) {
                break;
            }
            let p = VramParams {
                seed: pass_seed.wrapping_add((c_idx as u32).wrapping_mul(0x45D9_F3B)),
                pattern_mode: pattern_idx as u32,
                word_count: words_per_chunk,
                _pad: 0,
            };
            queue.write_buffer(&param_buf, 0, bytemuck::cast_slice(&[p]));
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            {
                let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                cpass.set_pipeline(&verify_pipe);
                cpass.set_bind_group(0, bg, &[]);
                cpass.dispatch_workgroups(workgroups, 1, 1);
            }
            queue.submit(Some(enc.finish()));
        }
        let mut copy_enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        copy_enc.copy_buffer_to_buffer(&err_buf, 0, &err_readback, 0, 4);
        queue.submit(Some(copy_enc.finish()));
        device.poll(wgpu::Maintain::Wait);
        if cancelled || thermal.cutoff_triggered {
            break;
        }

        let pass_errs = read_u32_buffer(&device, &err_readback).unwrap_or(0) as u64;
        total_errors += pass_errs;
        passes_completed += 1;

        let pass_secs = t_pass.elapsed().as_secs_f64().max(0.001);
        let pass_gb = (allocated_vram_mb as f64 * 2.0) / 1024.0; // Write + Read
        total_gb_verified += pass_gb;
        let inst_bw = ((pass_gb / pass_secs) * 10.0).round() / 10.0;

        let _ = thermal.poll(&mut telemetry, &started, false);

        let elapsed = started.elapsed().as_secs_f64();
        let pct = ((elapsed / thermal.duration_secs as f64) * 100.0).min(99.5);
        let thermal_warning = thermal
            .cur_gpu_temp
            .map(|t| t >= safe_cutoff_c - 6.0)
            .unwrap_or(false);
        let _ = app.emit(
            "vram:progress",
            VramTestProgress {
                running: true,
                adapter_name: adapter_name.clone(),
                pattern_name: PATTERN_NAMES[pattern_idx].to_string(),
                pass_number: passes_completed,
                percent: (pct * 10.0).round() / 10.0,
                allocated_vram_mb,
                total_gb_verified: (total_gb_verified * 10.0).round() / 10.0,
                bandwidth_gb_s: inst_bw,
                errors_found: total_errors,
                elapsed_secs: (elapsed * 10.0).round() / 10.0,
                duration_secs: thermal.duration_secs,
                gpu_temp_c: thermal.cur_gpu_temp,
                thermal_warning,
                gpu_temp_available: thermal.sensor_available_ever,
            },
        );
    }

    drop(bind_groups);
    drop(chunks);

    let peak_temp = thermal.peak_temp;
    let thermal_cutoff_triggered = thermal.cutoff_triggered;
    let sensor_available_ever = thermal.sensor_available_ever;

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let avg_bw = ((total_gb_verified / elapsed) * 10.0).round() / 10.0;
    let baseline = baselines::rate_vram(&adapter_name, is_discrete, avg_bw, total_errors);
    let status = if total_errors > 0 || thermal_cutoff_triggered {
        TestStatus::Fail
    } else if cancelled {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "GPU THERMAL CUTOFF ({:.0}°C >= {:.0}°C) during VRAM test on {} — stopped safely after {:.1} GB ({} err).",
            peak_temp.unwrap_or(safe_cutoff_c),
            safe_cutoff_c,
            adapter_name,
            total_gb_verified,
            total_errors
        )
    } else if total_errors > 0 {
        format!(
            "FAIL: {} GPU VRAM bit-flip error(s) detected on {} ({} MB pool, {:.1} GB verified)!",
            total_errors, adapter_name, allocated_vram_mb, total_gb_verified
        )
    } else if cancelled {
        format!(
            "Stopped early ({:.0}s): 0 VRAM errors across {:.1} GB verified on {} ({:.1} GB/s).",
            elapsed, total_gb_verified, adapter_name, avg_bw
        )
    } else {
        format!(
            "[{}] 0 VRAM Errors — {} MB pool, {:.1} GB verified in {} passes ({:.1} GB/s effective) on {}.",
            baseline.grade, allocated_vram_mb, total_gb_verified, passes_completed, avg_bw, adapter_name
        )
    };

    let sensor_note = if !sensor_available_ever {
        " GPU thermal sensor unavailable — duration safely bounded."
    } else {
        ""
    };
    let plain_summary = if thermal_cutoff_triggered {
        format!(
            "VRAM test aborted because {} reached {:.0}°C (safety limit {:.0}°C). Inspect GPU cooling.",
            adapter_name,
            peak_temp.unwrap_or(safe_cutoff_c),
            safe_cutoff_c
        )
    } else if total_errors > 0 {
        format!(
            "Faulty GPU memory: {} VRAM bit error(s) detected on {} ({} MB pool). Avoid this unit.",
            total_errors, adapter_name, allocated_vram_mb
        )
    } else {
        format!(
            "VRAM healthy on {}: 0 bit errors across {:.1} GB verified ({} MB pool, {:.1} GB/s).{}",
            adapter_name, total_gb_verified, allocated_vram_mb, avg_bw, sensor_note
        )
    };

    Ok(VramTestResult {
        status,
        adapter_name,
        backend: backend_str,
        allocated_vram_mb,
        passes_completed,
        total_gb_verified: (total_gb_verified * 10.0).round() / 10.0,
        avg_bandwidth_gb_s: avg_bw,
        errors_found: total_errors,
        peak_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled,
        baseline,
        summary,
        thermal_cutoff_triggered,
        effective_cutoff_c: safe_cutoff_c,
        sensor_available: sensor_available_ever,
        plain_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vram_thermal_cutoff_clamp_and_trigger() {
        assert_eq!(clamp_gpu_thermal_cutoff(95.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(105.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(92.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(85.0), 85.0);
        assert_eq!(clamp_gpu_thermal_cutoff(60.0), 75.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::NAN), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::INFINITY), 92.0);

        let hot = LiveTelemetrySnapshot {
            gpu_temp_c: Some(92.0),
            gpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&hot, f32::INFINITY, clamp_gpu_thermal_cutoff(100.0)),
            ThermalSafetyCheck::CutoffTriggered {
                sensor: "GPU",
                temp_c: 92.0
            }
        );

        let cool = LiveTelemetrySnapshot {
            gpu_temp_c: Some(78.0),
            gpu_temp_available: true,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&cool, f32::INFINITY, clamp_gpu_thermal_cutoff(95.0)),
            ThermalSafetyCheck::Safe
        );

        let missing = LiveTelemetrySnapshot {
            gpu_temp_c: None,
            gpu_temp_available: false,
            ..Default::default()
        };
        assert_eq!(
            TelemetryReader::is_thermal_safe(&missing, f32::INFINITY, 92.0),
            ThermalSafetyCheck::SensorUnavailable
        );
    }

    #[test]
    fn test_vram_sensor_unavailable_caps_duration() {
        assert_eq!(compute_vram_sensor_bounded_duration(900, true), 180);
        assert_eq!(compute_vram_sensor_bounded_duration(120, true), 120);
        assert_eq!(compute_vram_sensor_bounded_duration(900, false), 900);
    }

    #[test]
    fn test_vram_result_serde_backward_compat() {
        let v22 = r#"{"status":"pass","adapterName":"RTX 4060","errorsFound":0}"#;
        let res: VramTestResult = serde_json::from_str(v22).unwrap();
        assert_eq!(res.adapter_name, "RTX 4060");
        assert!(!res.thermal_cutoff_triggered);
        assert_eq!(res.effective_cutoff_c, 0.0);

        let empty_prog: VramTestProgress = serde_json::from_str("{}").unwrap();
        assert!(!empty_prog.thermal_warning);
    }
}
