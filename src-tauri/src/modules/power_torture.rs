use crate::modules::{
    baselines,
    gpu_stress::{diagnose_gpu_throttling, scan_rgba_frame_integrity},
    ram_test, simd_kernels,
    telemetry::{TelemetryReader, ThermalSafetyCheck},
    vram_test::{self, clamp_gpu_thermal_cutoff},
};
use crate::types::{
    BaselineRating, BurnInProgress, BurnInResult, PowerTortureProgress, PowerTortureResult,
    TestStatus, CPU_THERMAL_CUTOFF_DEFAULT_C, CPU_THERMAL_CUTOFF_MAX_C, CPU_THERMAL_CUTOFF_MIN_C,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytemuck::{Pod, Zeroable};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use wgpu::util::DeviceExt;

pub(crate) fn clamp_cpu_thermal_cutoff(cutoff_c: f32) -> f32 {
    if !cutoff_c.is_finite() {
        CPU_THERMAL_CUTOFF_DEFAULT_C
    } else {
        cutoff_c.clamp(CPU_THERMAL_CUTOFF_MIN_C, CPU_THERMAL_CUTOFF_MAX_C)
    }
}

pub(crate) struct WorkerPoolGuard {
    pub worker_stop: Arc<AtomicBool>,
    pub handles: Vec<JoinHandle<()>>,
}

impl WorkerPoolGuard {
    pub fn shutdown(&mut self) {
        self.worker_stop.store(true, Ordering::SeqCst);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for WorkerPoolGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

const SHADER_WGSL: &str = include_str!("../shaders/fur_torus.wgsl");

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct Uniforms {
    resolution: [f32; 2],
    time: f32,
    stress_iters: f32,
}

fn encode_preview(rgba_padded: &[u8], width: u32, height: u32, padded_bpr: u32) -> Option<String> {
    let out_w = (width / 2).max(1);
    let out_h = (height / 2).max(1);
    let mut rgb = Vec::with_capacity((out_w * out_h * 3) as usize);
    for y in 0..out_h {
        let row = (y * 2) as usize * padded_bpr as usize;
        for x in 0..out_w {
            let px = row + (x * 2) as usize * 4;
            if px + 2 < rgba_padded.len() {
                rgb.push(rgba_padded[px]);
                rgb.push(rgba_padded[px + 1]);
                rgb.push(rgba_padded[px + 2]);
            } else {
                rgb.extend_from_slice(&[0, 0, 0]);
            }
        }
    }
    let mut bytes = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut bytes, 70);
    enc.encode(&rgb, out_w, out_h, ColorType::Rgb8.into()).ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(&bytes)))
}

/// Simultaneous CPU (AVX2/NEON) + GPU (wgpu 3D Shader) + RAM Combined Power & Charger Torture.
/// Exposes VRM/shared-heatpipe throttling, weak/fake AC chargers (Battery Drain While Plugged In),
/// and thermal paste/fan defects under full-chassis maximum wattage.
pub(crate) fn finalize_power_torture_outcome(
    baseline: &BaselineRating,
    fps_drop_pct: f64,
    avg_fps: f64,
    simd_isa: &str,
    throttle_reason: &str,
    elapsed: f64,
    artifact_errors: u64,
    thermal_cutoff_triggered: bool,
    thermal_throttling_detected: bool,
    power_limit_throttling: bool,
    battery_drain_while_plugged: bool,
    battery_delta_pct: Option<f64>,
    combined_peak_temp: Option<f32>,
    safe_cpu_cutoff: f32,
    safe_gpu_cutoff: f32,
    sensor_available_ever: bool,
    cancelled: bool,
) -> (TestStatus, String, String, String) {
    let hardware_fault = thermal_cutoff_triggered || artifact_errors > 0;

    let durability_grade = if cancelled && !hardware_fault {
        "CANCELLED".to_string()
    } else {
        baselines::compute_durability_grade(
            baseline.percent_of_normal,
            fps_drop_pct,
            artifact_errors,
            thermal_cutoff_triggered,
            battery_drain_while_plugged,
        )
    };

    let status = if hardware_fault {
        TestStatus::Fail
    } else if battery_drain_while_plugged
        || thermal_throttling_detected
        || power_limit_throttling
        || cancelled
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF ({:.0}°C; CPU limit {:.0}°C / GPU limit {:.0}°C) during Combined CPU+GPU+RAM Torture!",
            combined_peak_temp.unwrap_or(safe_gpu_cutoff),
            safe_cpu_cutoff,
            safe_gpu_cutoff
        )
    } else if artifact_errors > 0 {
        format!(
            "FAIL: {} GPU render artifact error(s) detected under Combined Power Torture!",
            artifact_errors
        )
    } else if cancelled {
        if battery_drain_while_plugged {
            format!(
                "[CANCELLED] Combined CPU ({}) + GPU ({:.1} FPS) stopped early at {:.0}s — WARNING: Battery DRAINED while AC plugged in (delta {:.1}%).",
                simd_isa,
                avg_fps,
                elapsed,
                battery_delta_pct.unwrap_or(0.0)
            )
        } else {
            format!(
                "[CANCELLED] Combined CPU ({}) + GPU ({:.1} FPS, Drop {:.1}%, Throttle: {}) + RAM stopped early by technician at {:.0}s.",
                simd_isa, avg_fps, fps_drop_pct, throttle_reason, elapsed
            )
        }
    } else if battery_drain_while_plugged {
        format!(
            "[Grade {}] WARNING: Battery DRAINED while AC plugged in (delta {:.1}%) under full CPU+GPU load! Check charger wattage / DC-in circuit.",
            durability_grade,
            battery_delta_pct.unwrap_or(0.0)
        )
    } else {
        format!(
            "[Grade {} — {}] Combined CPU ({}) + GPU ({:.1} FPS, Drop {:.1}%, Throttle: {}) + RAM stable for {:.0}s.",
            durability_grade, baseline.grade, simd_isa, avg_fps, fps_drop_pct, throttle_reason, elapsed
        )
    };

    let sensor_note = if !sensor_available_ever {
        " Thermal sensors unavailable — duration safely bounded."
    } else {
        ""
    };
    let plain_summary = if thermal_cutoff_triggered {
        format!(
            "Combined power torture shut down safely at {:.0}°C (limits: CPU {:.0}°C / GPU {:.0}°C). Shared cooling cannot sustain full chassis wattage.",
            combined_peak_temp.unwrap_or(safe_gpu_cutoff),
            safe_cpu_cutoff,
            safe_gpu_cutoff
        )
    } else if artifact_errors > 0 {
        format!(
            "Combined power stress triggered {} GPU rendering artifact error(s). Inspect GPU/VRM stability.",
            artifact_errors
        )
    } else if cancelled {
        if battery_drain_while_plugged {
            format!(
                "Combined power torture was cancelled early at {:.0}s, and detected AC battery drain ({:.1}%). Inspect charger wattage.",
                elapsed,
                battery_delta_pct.unwrap_or(0.0).abs()
            )
        } else {
            format!(
                "Combined power torture was cancelled early by technician at {:.0}s ({:.1} avg FPS, {:.1}% drop).{}",
                elapsed, avg_fps, fps_drop_pct, sensor_note
            )
        }
    } else if battery_drain_while_plugged {
        format!(
            "Charger undersized or DC-in fault: battery drained {:.1}% while plugged into AC under full CPU+GPU load.",
            battery_delta_pct.unwrap_or(0.0).abs()
        )
    } else {
        format!(
            "Full-chassis power torture passed ({:.0}s): {:.1} avg FPS, {:.1}% drop ({}), no AC charger drain.{}",
            elapsed, avg_fps, fps_drop_pct, throttle_reason, sensor_note
        )
    };

    (status, durability_grade, summary, plain_summary)
}

pub(crate) fn compute_power_sensor_bounded_duration(
    duration_secs: u64,
    sensor_unavailable: bool,
) -> u64 {
    if sensor_unavailable {
        duration_secs.min(180)
    } else {
        duration_secs
    }
}

pub fn run_power_torture(
    app: &AppHandle,
    adapter_index: Option<usize>,
    duration_secs: u64,
    thermal_cutoff_c: f32,
    cancel: Arc<AtomicBool>,
) -> Result<PowerTortureResult, String> {
    let safe_cpu_cutoff = clamp_cpu_thermal_cutoff(thermal_cutoff_c);
    let safe_gpu_cutoff = clamp_gpu_thermal_cutoff(thermal_cutoff_c);
    let requested_duration_secs = duration_secs.clamp(30, 1800);
    let simd_isa = simd_kernels::detected_simd_isa().to_string();

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let mut adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    if adapters.is_empty() {
        return Err("No compatible GPU adapter found for Combined Power Torture.".to_string());
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
    let is_discrete = info.device_type == wgpu::DeviceType::DiscreteGpu;

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("LaptopBench Power Torture GPU"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .map_err(|e| format!("Failed to open GPU for Power Torture: {}", e))?;

    let width: u32 = if is_discrete { 1280 } else { 960 };
    let height: u32 = if is_discrete { 720 } else { 540 };
    let stress_iters: f32 = if is_discrete { 96.0 } else { 64.0 };

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("PowerTorture Shader"),
        source: wgpu::ShaderSource::Wgsl(SHADER_WGSL.into()),
    });
    let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Uniforms"),
        contents: bytemuck::cast_slice(&[Uniforms {
            resolution: [width as f32, height as f32],
            time: 0.0,
            stress_iters,
        }]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("PT BGL"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("PT BG"),
        layout: &bgl,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform_buf.as_entire_binding(),
        }],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("PT PL"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let texture_format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("PT Pipeline"),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: texture_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });
    let render_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("PT Target"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: texture_format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let render_view = render_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bpr = (((width * 4) + align - 1) / align) * align;
    let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("PT Readback"),
        size: (padded_bpr * height) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    // Spawn dedicated background CPU AVX2/NEON + RAM load threads wrapped in RAII WorkerPoolGuard
    let worker_stop = Arc::new(AtomicBool::new(false));
    let cpu_ops = Arc::new(AtomicU64::new(0));
    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(2);
    let mut handles = Vec::with_capacity(num_workers);
    for w_idx in 0..num_workers {
        let stop_flag = worker_stop.clone();
        let cancel_flag = cancel.clone();
        let ops_counter = cpu_ops.clone();
        handles.push(std::thread::spawn(move || {
            let mut ram_scratch = vec![0x55u8; 8 * 1024 * 1024]; // 8 MB per thread RAM pressure
            let mut iter: u32 = 0;
            while !stop_flag.load(Ordering::Relaxed) && !cancel_flag.load(Ordering::Relaxed) {
                let _ = simd_kernels::simd_ai_gemm_step(112, (w_idx as f32) + (iter as f32) * 0.01);
                // Touch RAM pages to draw DRAM controller wattage too
                let fill_val = ((iter + w_idx as u32) & 0xFF) as u8;
                for b in ram_scratch.iter_mut().step_by(64) {
                    *b = fill_val;
                }
                ops_counter.fetch_add(1, Ordering::Relaxed);
                iter = iter.wrapping_add(1);
            }
        }));
    }
    let mut worker_guard = WorkerPoolGuard {
        worker_stop,
        handles,
    };

    let mut telemetry = TelemetryReader::new();
    let init_snap = telemetry.sample_throttled(true, Duration::from_millis(900));
    let battery_start_pct = init_snap.battery_percent;

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut last_snap_time = Instant::now() - Duration::from_secs(5);
    let mut cur_snap = init_snap.clone();
    let mut frames_rendered = 0u64;
    let mut window_frames = 0u64;
    let mut fps_samples: Vec<f64> = Vec::with_capacity(1024);
    let mut gpu_power_samples: Vec<f32> = Vec::with_capacity(1024);
    let mut gpu_load_samples: Vec<f32> = Vec::with_capacity(1024);
    let mut peak_cpu_temp: Option<f32> = cur_snap.cpu_temp_c;
    let mut peak_gpu_temp: Option<f32> = cur_snap.gpu_temp_c;
    let mut peak_gpu_power: Option<f32> = cur_snap.gpu_power_w;
    let mut peak_cpu_power: Option<f32> = cur_snap.cpu_power_w;
    let mut drain_ticks = 0u32;
    let mut battery_drain_while_plugged = false;
    let mut thermal_cutoff_triggered = false;
    let mut cancelled = false;
    let mut artifact_errors: u64 = 0;
    let mut prev_frame_hash: Option<u64> = None;
    let mut stalled_streak: u32 = 0;
    let mut prev_frame_time: f32 = -1.0;
    let mut sensor_polls = 0u32;
    let mut sensor_available_ever = cur_snap.cpu_temp_available || cur_snap.gpu_temp_available;
    let mut duration_secs = requested_duration_secs;

    if let ThermalSafetyCheck::CutoffTriggered { sensor, temp_c } =
        TelemetryReader::is_thermal_safe(&cur_snap, safe_cpu_cutoff, safe_gpu_cutoff)
    {
        if sensor == "CPU" {
            peak_cpu_temp = Some(peak_cpu_temp.map_or(temp_c, |p| p.max(temp_c)));
        } else {
            peak_gpu_temp = Some(peak_gpu_temp.map_or(temp_c, |p| p.max(temp_c)));
        }
        thermal_cutoff_triggered = true;
    }

    while !thermal_cutoff_triggered && started.elapsed().as_secs() < duration_secs {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let elapsed_s = started.elapsed().as_secs_f32();
        let u = Uniforms {
            resolution: [width as f32, height as f32],
            time: elapsed_s,
            stress_iters,
        };
        queue.write_buffer(&uniform_buf, 0, bytemuck::cast_slice(&[u]));

        let need_emit = last_emit.elapsed().as_millis() >= 350;
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut rpass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("PT Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &render_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
            });
            rpass.set_pipeline(&pipeline);
            rpass.set_bind_group(0, &bg, &[]);
            rpass.draw(0..3, 0..1);
        }
        if need_emit {
            enc.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &render_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback_buf,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_bpr),
                        rows_per_image: Some(height),
                    },
                },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
        }
        queue.submit(Some(enc.finish()));
        device.poll(wgpu::Maintain::Wait);
        frames_rendered += 1;
        window_frames += 1;

        if last_snap_time.elapsed() >= Duration::from_millis(900) {
            cur_snap = telemetry.sample_throttled(true, Duration::from_millis(900));
            sensor_polls += 1;
            if let Some(ct) = cur_snap.cpu_temp_c {
                peak_cpu_temp = Some(peak_cpu_temp.map_or(ct, |p| p.max(ct)));
            }
            if let Some(gt) = cur_snap.gpu_temp_c {
                peak_gpu_temp = Some(peak_gpu_temp.map_or(gt, |p| p.max(gt)));
            }
            if let Some(gp) = cur_snap.gpu_power_w.filter(|v| v.is_finite()) {
                gpu_power_samples.push(gp);
                peak_gpu_power = Some(peak_gpu_power.map_or(gp, |p| p.max(gp)));
            }
            if let Some(gl) = cur_snap.gpu_load_pct.filter(|v| v.is_finite()) {
                gpu_load_samples.push(gl);
            }
            if let Some(cp) = cur_snap.cpu_power_w.filter(|v| v.is_finite()) {
                peak_cpu_power = Some(peak_cpu_power.map_or(cp, |p| p.max(cp)));
            }

            if cur_snap.cpu_temp_available || cur_snap.gpu_temp_available {
                sensor_available_ever = true;
            }

            // Detect Battery Drain While AC Charger Plugged In!
            if cur_snap.ac_plugged == Some(true) {
                let watts_draining = cur_snap.battery_watts.map(|w| w < -1.5).unwrap_or(false);
                let pct_dropped = match (battery_start_pct, cur_snap.battery_percent) {
                    (Some(s), Some(c)) => (s - c) >= 1.5,
                    _ => false,
                };
                if watts_draining || pct_dropped {
                    drain_ticks += 1;
                    if drain_ticks >= 2 || pct_dropped {
                        battery_drain_while_plugged = true;
                    }
                }
            }

            match TelemetryReader::is_thermal_safe(&cur_snap, safe_cpu_cutoff, safe_gpu_cutoff) {
                ThermalSafetyCheck::CutoffTriggered { sensor, temp_c } => {
                    if sensor == "CPU" {
                        peak_cpu_temp = Some(peak_cpu_temp.map_or(temp_c, |p| p.max(temp_c)));
                    } else {
                        peak_gpu_temp = Some(peak_gpu_temp.map_or(temp_c, |p| p.max(temp_c)));
                    }
                    thermal_cutoff_triggered = true;
                    break;
                }
                ThermalSafetyCheck::SensorUnavailable => {
                    if !sensor_available_ever && sensor_polls >= 2 && started.elapsed().as_secs_f64() >= 2.0 {
                        duration_secs = compute_power_sensor_bounded_duration(
                            requested_duration_secs,
                            true,
                        );
                    }
                }
                ThermalSafetyCheck::Safe => {
                    sensor_available_ever = true;
                }
            }

            last_snap_time = Instant::now();
        }

        if need_emit {
            let win_s = last_emit.elapsed().as_secs_f64().max(0.001);
            let inst_fps = window_frames as f64 / win_s;
            if frames_rendered > 3 {
                fps_samples.push(inst_fps);
            }
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let avg_fps = frames_rendered as f64 / elapsed;
            let ops_rate = cpu_ops.load(Ordering::Relaxed) as f64 / elapsed;

            let slice = readback_buf.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
            device.poll(wgpu::Maintain::Wait);
            let preview_data_url = if rx.recv().ok().and_then(|r| r.ok()).is_some() {
                let mapped = slice.get_mapped_range();
                let time_adv = elapsed_s > prev_frame_time + 0.05;
                let scan = scan_rgba_frame_integrity(
                    &mapped,
                    width,
                    height,
                    padded_bpr,
                    prev_frame_hash,
                    stalled_streak,
                    time_adv,
                );
                prev_frame_hash = Some(scan.frame_hash);
                stalled_streak = scan.new_stalled_streak;
                prev_frame_time = elapsed_s;
                artifact_errors = artifact_errors.saturating_add(scan.errors_detected);

                let url = encode_preview(&mapped, width, height, padded_bpr);
                drop(mapped);
                readback_buf.unmap();
                url
            } else {
                None
            };

            let battery_delta_pct = match (battery_start_pct, cur_snap.battery_percent) {
                (Some(s), Some(c)) => Some(((c - s) * 10.0).round() / 10.0),
                _ => None,
            };
            let thermal_warning = cur_snap.cpu_temp_c.map(|t| t >= safe_cpu_cutoff - 6.0).unwrap_or(false)
                || cur_snap.gpu_temp_c.map(|t| t >= safe_gpu_cutoff - 6.0).unwrap_or(false);
            let throttle_state = if thermal_warning {
                "Throttling".to_string()
            } else {
                "Steady".to_string()
            };

            let _ = app.emit(
                "torture:progress",
                PowerTortureProgress {
                    running: true,
                    adapter_name: adapter_name.clone(),
                    simd_isa: simd_isa.clone(),
                    elapsed_secs: (elapsed * 10.0).round() / 10.0,
                    duration_secs,
                    percent: ((elapsed / duration_secs as f64) * 100.0).min(99.5),
                    gpu_fps: (inst_fps * 10.0).round() / 10.0,
                    gpu_avg_fps: (avg_fps * 10.0).round() / 10.0,
                    cpu_ops_per_sec: (ops_rate * 10.0).round() / 10.0,
                    telemetry: cur_snap.clone(),
                    battery_start_pct,
                    battery_delta_pct,
                    battery_drain_while_plugged,
                    thermal_warning,
                    preview_data_url,
                    artifact_errors,
                    throttle_state,
                },
            );

            window_frames = 0;
            last_emit = Instant::now();
        }
    }

    // Explicitly shut down worker pool (Drop guard also guarantees cleanup on panic/early return)
    worker_guard.shutdown();

    let final_snap = telemetry.sample_throttled(true, Duration::from_millis(500));
    let battery_end_pct = final_snap.battery_percent;
    let battery_delta_pct = match (battery_start_pct, battery_end_pct) {
        (Some(s), Some(e)) => Some(((e - s) * 10.0).round() / 10.0),
        _ => None,
    };

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let avg_fps = ((frames_rendered as f64 / elapsed) * 10.0).round() / 10.0;
    let fps_drop_pct = if fps_samples.len() >= 8 {
        let k = (fps_samples.len() / 5).max(2);
        let early: f64 = fps_samples[..k].iter().sum::<f64>() / k as f64;
        let late: f64 = fps_samples[fps_samples.len() - k..].iter().sum::<f64>() / k as f64;
        ((((early - late) / early.max(0.1)) * 100.0).clamp(0.0, 99.0) * 10.0).round() / 10.0
    } else {
        0.0
    };

    let combined_peak_temp = match (peak_cpu_temp, peak_gpu_temp) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };

    let avg_gpu_power_w = if gpu_power_samples.is_empty() {
        None
    } else {
        Some(((gpu_power_samples.iter().sum::<f32>() / gpu_power_samples.len() as f32) * 10.0).round() / 10.0)
    };
    let avg_gpu_load_pct = if gpu_load_samples.is_empty() {
        None
    } else {
        Some(((gpu_load_samples.iter().sum::<f32>() / gpu_load_samples.len() as f32) * 10.0).round() / 10.0)
    };

    let (thermal_throttling_detected, power_limit_throttling, throttle_reason) =
        diagnose_gpu_throttling(
            fps_drop_pct,
            peak_gpu_temp.or(peak_cpu_temp),
            safe_gpu_cutoff,
            thermal_cutoff_triggered,
            avg_gpu_power_w,
            peak_gpu_power,
            avg_gpu_load_pct,
        );

    let baseline = baselines::rate_power_torture(
        fps_drop_pct,
        battery_drain_while_plugged,
        thermal_cutoff_triggered,
        combined_peak_temp,
    );
    let (status, durability_grade, summary, plain_summary) = finalize_power_torture_outcome(
        &baseline,
        fps_drop_pct,
        avg_fps,
        &simd_isa,
        &throttle_reason,
        elapsed,
        artifact_errors,
        thermal_cutoff_triggered,
        thermal_throttling_detected,
        power_limit_throttling,
        battery_drain_while_plugged,
        battery_delta_pct,
        combined_peak_temp,
        safe_cpu_cutoff,
        safe_gpu_cutoff,
        sensor_available_ever,
        cancelled,
    );

    Ok(PowerTortureResult {
        status,
        adapter_name,
        simd_isa,
        duration_secs,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        avg_fps,
        fps_drop_pct,
        peak_cpu_temp_c: peak_cpu_temp.map(|t| (t * 10.0).round() / 10.0),
        peak_gpu_temp_c: peak_gpu_temp.map(|t| (t * 10.0).round() / 10.0),
        peak_gpu_power_w: peak_gpu_power.map(|p| (p * 10.0).round() / 10.0),
        battery_start_pct,
        battery_end_pct,
        battery_delta_pct,
        battery_drain_while_plugged,
        thermal_cutoff_triggered,
        cancelled,
        durability_grade,
        baseline,
        summary,
        artifact_errors,
        avg_gpu_power_w,
        peak_cpu_power_w: peak_cpu_power.map(|p| (p * 10.0).round() / 10.0),
        thermal_throttling_detected,
        power_limit_throttling,
        throttle_reason,
        sensor_available: sensor_available_ever,
        effective_cpu_cutoff_c: safe_cpu_cutoff,
        effective_gpu_cutoff_c: safe_gpu_cutoff,
        plain_summary,
    })
}

/// Optional 1-Click Unattended Shelf Burn-In Marathon (5m / 15m / 30m)
/// Chains: (1) TM5 RAM Stress -> (2) Dedicated GPU VRAM Integrity -> (3) Combined CPU+GPU+RAM Power Torture
pub fn run_shelf_burnin(
    app: &AppHandle,
    total_minutes: u64,
    thermal_cutoff_c: f32,
    memory_type_hint: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<BurnInResult, String> {
    let safe_cpu_cutoff = clamp_cpu_thermal_cutoff(thermal_cutoff_c);
    let safe_gpu_cutoff = clamp_gpu_thermal_cutoff(thermal_cutoff_c);
    let mins = total_minutes.clamp(3, 60);
    let total_secs = mins * 60;
    let ram_secs = ((total_secs as f64) * 0.30).round() as u64;
    let vram_secs = ((total_secs as f64) * 0.25).round() as u64;
    let torture_secs = total_secs.saturating_sub(ram_secs + vram_secs).max(30);

    let started = Instant::now();
    let mut telemetry = TelemetryReader::new();
    let mut stage_notes: Vec<String> = Vec::new();

    // Stage 1/3: TM5 RAM Stress
    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: true,
            stage_index: 1,
            total_stages: 3,
            stage_name: "Stage 1/3: TestMem5 RAM Stability".into(),
            stage_detail: format!("Testing system DRAM integrity for {}s...", ram_secs),
            overall_percent: 5.0,
            elapsed_secs: 0.0,
            total_duration_secs: total_secs,
            ram_errors: 0,
            vram_errors: 0,
            battery_drain_alert: false,
            telemetry: Some(telemetry.sample_throttled(true, Duration::from_millis(900))),
        },
    );

    let ram_res = ram_test::run_ram_stress_test(
        app,
        "quick",
        Some(60),
        Some(ram_secs),
        memory_type_hint,
        cancel.clone(),
    )?;
    if ram_res.thermal_cutoff_triggered || ram_res.errors_found > 0 {
        let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
        let msg = if ram_res.thermal_cutoff_triggered {
            format!(
                "Burn-In halted during Stage 1 (RAM Stress): CPU thermal cutoff triggered ({:.0}°C).",
                ram_res.peak_cpu_temp_c.unwrap_or(safe_cpu_cutoff)
            )
        } else {
            format!(
                "Burn-In halted during Stage 1 (RAM Stress): {} RAM bit error(s) detected.",
                ram_res.errors_found
            )
        };
        return Ok(BurnInResult {
            status: TestStatus::Fail,
            total_minutes: mins,
            elapsed_secs: elapsed,
            cancelled: cancel.load(Ordering::Relaxed) || ram_res.cancelled,
            thermal_cutoff_triggered: ram_res.thermal_cutoff_triggered,
            ram_result: Some(ram_res),
            vram_result: None,
            torture_result: None,
            durability_grade: "FAIL".into(),
            summary: msg.clone(),
            plain_summary: msg,
        });
    }
    if cancel.load(Ordering::Relaxed) || ram_res.cancelled {
        return Ok(cancelled_burnin(mins, started.elapsed().as_secs_f64(), Some(ram_res), None, None));
    }

    // Stage 2/3: Dedicated GPU VRAM Integrity (propagating clamped safe GPU thermal cutoff!)
    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: true,
            stage_index: 2,
            total_stages: 3,
            stage_name: "Stage 2/3: Dedicated GPU VRAM Integrity".into(),
            stage_detail: format!(
                "Sweeping GPU VRAM buffers via wgpu compute for {}s (Cutoff {:.0}°C)...",
                vram_secs, safe_gpu_cutoff
            ),
            overall_percent: 35.0,
            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: 0,
            battery_drain_alert: false,
            telemetry: Some(telemetry.sample_throttled(true, Duration::from_millis(900))),
        },
    );

    let vram_res = match vram_test::run_vram_integrity_test_with_cutoff(
        app,
        None,
        None,
        vram_secs,
        safe_gpu_cutoff,
        cancel.clone(),
    ) {
        Ok(v) => Some(v),
        Err(e) => {
            stage_notes.push(format!("VRAM stage skipped/error: {}", e));
            None
        }
    };
    let vram_errs = vram_res.as_ref().map(|v| v.errors_found).unwrap_or(0);
    let vram_cutoff = vram_res.as_ref().map(|v| v.thermal_cutoff_triggered).unwrap_or(false);
    let vram_cancelled = vram_res.as_ref().map(|v| v.cancelled).unwrap_or(false);
    if vram_cutoff || vram_errs > 0 {
        let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
        let msg = if vram_cutoff {
            format!(
                "Burn-In halted during Stage 2 (VRAM): GPU thermal cutoff triggered ({:.0}°C >= {:.0}°C).",
                vram_res.as_ref().and_then(|v| v.peak_temp_c).unwrap_or(safe_gpu_cutoff),
                safe_gpu_cutoff
            )
        } else {
            format!(
                "Burn-In halted during Stage 2 (VRAM): {} VRAM integrity error(s) detected.",
                vram_errs
            )
        };
        return Ok(BurnInResult {
            status: TestStatus::Fail,
            total_minutes: mins,
            elapsed_secs: elapsed,
            cancelled: cancel.load(Ordering::Relaxed) || vram_cancelled,
            ram_result: Some(ram_res),
            vram_result: vram_res,
            torture_result: None,
            durability_grade: "FAIL".into(),
            summary: msg.clone(),
            thermal_cutoff_triggered: vram_cutoff,
            plain_summary: msg,
        });
    }
    if cancel.load(Ordering::Relaxed) || vram_cancelled {
        return Ok(cancelled_burnin(
            mins,
            started.elapsed().as_secs_f64(),
            Some(ram_res),
            vram_res,
            None,
        ));
    }

    // Stage 3/3: Combined CPU + GPU + RAM Power Torture
    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: true,
            stage_index: 3,
            total_stages: 3,
            stage_name: "Stage 3/3: Combined CPU + GPU + RAM Power Torture".into(),
            stage_detail: format!(
                "Maximum full-chassis thermal & charger stress for {}s (CPU {:.0}°C / GPU {:.0}°C)...",
                torture_secs, safe_cpu_cutoff, safe_gpu_cutoff
            ),
            overall_percent: 62.0,
            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: vram_errs,
            battery_drain_alert: false,
            telemetry: Some(telemetry.sample_throttled(true, Duration::from_millis(900))),
        },
    );

    let torture_res = match run_power_torture(app, None, torture_secs, thermal_cutoff_c, cancel.clone()) {
        Ok(t) => Some(t),
        Err(e) => {
            stage_notes.push(format!("Power torture stage error: {}", e));
            None
        }
    };
    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;

    let torture_artifacts = torture_res.as_ref().map(|t| t.artifact_errors).unwrap_or(0);
    let torture_cutoff = torture_res
        .as_ref()
        .map(|t| t.thermal_cutoff_triggered)
        .unwrap_or(false);
    let torture_cancelled = torture_res.as_ref().map(|t| t.cancelled).unwrap_or(false);
    let drain = torture_res
        .as_ref()
        .map(|t| t.battery_drain_while_plugged)
        .unwrap_or(false);
    let drop_pct = torture_res.as_ref().map(|t| t.fps_drop_pct).unwrap_or(0.0);
    let cancel_flag = cancel.load(Ordering::Relaxed);

    let (status, grade, stage_detail, summary, plain_summary, cancelled_out, cutoff_out) =
        finalize_shelf_burnin_outcome(
            mins,
            elapsed,
            ram_res.errors_found,
            vram_errs,
            vram_cutoff,
            torture_artifacts,
            torture_cutoff,
            torture_cancelled,
            drain,
            drop_pct,
            &stage_notes,
            cancel_flag,
        );

    let stage_name = if matches!(status, TestStatus::Fail) {
        "Shelf Burn-In Failed"
    } else if cancelled_out {
        "Shelf Burn-In Cancelled"
    } else if !stage_notes.is_empty() {
        "Shelf Burn-In Incomplete"
    } else {
        "Shelf Burn-In Complete"
    };

    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: false,
            stage_index: 3,
            total_stages: 3,
            stage_name: stage_name.into(),
            stage_detail,
            overall_percent: 100.0,
            elapsed_secs: elapsed,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: vram_errs,
            battery_drain_alert: drain,
            telemetry: Some(telemetry.sample_throttled(true, Duration::from_millis(500))),
        },
    );

    Ok(BurnInResult {
        status,
        total_minutes: mins,
        elapsed_secs: elapsed,
        cancelled: cancelled_out,
        ram_result: Some(ram_res),
        vram_result: vram_res,
        torture_result: torture_res,
        durability_grade: grade,
        summary,
        thermal_cutoff_triggered: cutoff_out,
        plain_summary,
    })
}

pub(crate) fn finalize_shelf_burnin_outcome(
    mins: u64,
    elapsed: f64,
    ram_errors: u64,
    vram_errors: u64,
    vram_cutoff: bool,
    torture_artifacts: u64,
    torture_cutoff: bool,
    torture_cancelled: bool,
    drain: bool,
    drop_pct: f64,
    stage_notes: &[String],
    cancel_flag: bool,
) -> (TestStatus, String, String, String, String, bool, bool) {
    let total_hw_errors = ram_errors + vram_errors + torture_artifacts;
    let cutoff = vram_cutoff || torture_cutoff;
    let cancelled = cancel_flag || torture_cancelled;
    let note_suffix = if stage_notes.is_empty() {
        String::new()
    } else {
        format!(" | {}", stage_notes.join("; "))
    };

    if total_hw_errors > 0 || cutoff {
        let grade = "FAIL".to_string();
        let stage_detail = "Final Durability Grade: FAIL".to_string();
        let summary = format!(
            "[Grade FAIL] {}m Shelf Burn-In finished ({:.0}s): RAM {} err | VRAM {} err | Power Torture Drop {:.1}%{}{}{}{}",
            mins,
            elapsed,
            ram_errors,
            vram_errors,
            drop_pct,
            if cutoff { " | THERMAL CUTOFF" } else { "" },
            if drain { " | CHARGER DRAIN WARNING" } else { "" },
            if cancelled { " | CANCELLED AFTER FAULT" } else { "" },
            note_suffix
        );
        let plain_summary = if cutoff {
            format!(
                "Shelf Burn-In triggered thermal safety cutoff ({}m, {:.0}s). Cooling system needs service.",
                mins, elapsed
            )
        } else {
            format!(
                "Shelf Burn-In detected {} hardware error(s) (RAM {}, VRAM {}, GPU {}). Unit failed reliability check.",
                total_hw_errors, ram_errors, vram_errors, torture_artifacts
            )
        };
        (
            TestStatus::Fail,
            grade,
            stage_detail,
            summary,
            plain_summary,
            cancelled,
            cutoff,
        )
    } else if cancelled {
        let grade = "INCOMPLETE".to_string();
        let stage_detail = "Cancelled by technician".to_string();
        let summary = format!(
            "[INCOMPLETE] Unattended {}m Shelf Burn-In was cancelled early by technician at {:.0}s (RAM {} err | VRAM {} err | Torture Drop {:.1}%){}{}.",
            mins,
            elapsed,
            ram_errors,
            vram_errors,
            drop_pct,
            if drain { " | CHARGER DRAIN WARNING" } else { "" },
            note_suffix
        );
        let plain_summary = format!(
            "Unattended Shelf Burn-In was stopped early by technician at {:.0}s (0 hardware errors detected before cancellation).{}",
            elapsed, note_suffix
        );
        (
            TestStatus::Warn,
            grade,
            stage_detail,
            summary,
            plain_summary,
            true,
            false,
        )
    } else if !stage_notes.is_empty() {
        let grade = "INCOMPLETE".to_string();
        let stage_detail = "Incomplete — stage error encountered".to_string();
        let summary = format!(
            "[INCOMPLETE] {}m Shelf Burn-In finished with partial-stage error(s) ({:.0}s): RAM {} err | VRAM {} err | Power Torture Drop {:.1}%{}{}",
            mins,
            elapsed,
            ram_errors,
            vram_errors,
            drop_pct,
            if drain { " | CHARGER DRAIN WARNING" } else { "" },
            note_suffix
        );
        let plain_summary = format!(
            "Shelf Burn-In could not complete all stages ({}m, {:.0}s): {}. Re-test required for skipped/errored stage(s).",
            mins,
            elapsed,
            stage_notes.join("; ")
        );
        (
            TestStatus::Warn,
            grade,
            stage_detail,
            summary,
            plain_summary,
            false,
            false,
        )
    } else {
        let grade = baselines::compute_durability_grade(
            100.0,
            drop_pct,
            total_hw_errors,
            cutoff,
            drain,
        );
        let status = if drain || drop_pct >= 20.0 {
            TestStatus::Warn
        } else {
            TestStatus::Pass
        };
        let stage_detail = format!("Final Durability Grade: {}", grade);
        let summary = format!(
            "[Grade {}] {}m Shelf Burn-In finished ({:.0}s): RAM {} err | VRAM {} err | Power Torture Drop {:.1}%{}",
            grade,
            mins,
            elapsed,
            ram_errors,
            vram_errors,
            drop_pct,
            if drain { " | CHARGER DRAIN WARNING" } else { "" }
        );
        let plain_summary = format!(
            "Shelf Burn-In Grade {}: {}m unattended marathon passed ({:.0}s) — 0 RAM/VRAM errors, {:.1}% FPS drop.{}",
            grade,
            mins,
            elapsed,
            drop_pct,
            if drain { " Charger drain detected." } else { " AC power stable." }
        );
        (
            status,
            grade,
            stage_detail,
            summary,
            plain_summary,
            false,
            false,
        )
    }
}

fn cancelled_burnin(
    mins: u64,
    elapsed: f64,
    ram_result: Option<crate::types::RamTestResult>,
    vram_result: Option<crate::types::VramTestResult>,
    torture_result: Option<PowerTortureResult>,
) -> BurnInResult {
    BurnInResult {
        status: TestStatus::Warn,
        total_minutes: mins,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled: true,
        ram_result,
        vram_result,
        torture_result,
        durability_grade: "INCOMPLETE".into(),
        summary: "Unattended Shelf Burn-In was cancelled early by technician.".into(),
        thermal_cutoff_triggered: false,
        plain_summary: "Unattended Shelf Burn-In was stopped early by technician.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_power_torture_cpu_and_gpu_cutoffs_clamped() {
        assert_eq!(clamp_gpu_thermal_cutoff(105.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(95.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::NAN), 92.0);
        assert_eq!(clamp_cpu_thermal_cutoff(105.0), 95.0);
        assert_eq!(clamp_cpu_thermal_cutoff(92.0), 92.0);
        assert_eq!(clamp_cpu_thermal_cutoff(60.0), 80.0);
        assert_eq!(clamp_cpu_thermal_cutoff(f32::NAN), 92.0);
        assert_eq!(compute_power_sensor_bounded_duration(900, true), 180);
        assert_eq!(compute_power_sensor_bounded_duration(900, false), 900);
    }

    #[test]
    fn test_worker_pool_guard_stops_and_joins_on_drop() {
        let stop = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let exited_clone = exited.clone();
        let handle = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(5));
            }
            exited_clone.store(true, Ordering::SeqCst);
        });

        {
            let _guard = WorkerPoolGuard {
                worker_stop: stop.clone(),
                handles: vec![handle],
            };
            assert!(!stop.load(Ordering::Relaxed));
        }
        assert!(stop.load(Ordering::SeqCst));
        assert!(exited.load(Ordering::SeqCst));
    }

    #[test]
    fn test_power_torture_and_burnin_serde_compat() {
        let pt: PowerTortureResult =
            serde_json::from_str(r#"{"status":"pass","avgFps":64.2}"#).unwrap();
        assert_eq!(pt.avg_fps, 64.2);
        assert_eq!(pt.artifact_errors, 0);

        let bi: BurnInResult = serde_json::from_str(r#"{"status":"pass","totalMinutes":15}"#).unwrap();
        assert_eq!(bi.total_minutes, 15);
        assert!(!bi.thermal_cutoff_triggered);

        let empty_pt: PowerTortureResult = serde_json::from_str("{}").unwrap();
        assert!(!empty_pt.thermal_cutoff_triggered);
        let empty_bi: BurnInResult = serde_json::from_str("{}").unwrap();
        assert_eq!(empty_bi.plain_summary, "");
    }

    #[test]
    fn test_cancelled_power_torture_returns_cancelled_grade_and_warn_not_a_plus() {
        // Even with 100% baseline score, 0% FPS drop, and 0 artifact errors, a cancelled run
        // must return Warn + "CANCELLED" + "[CANCELLED]" summary, never "A+" or "A".
        let baseline = baselines::rate_power_torture(0.0, false, false, Some(72.0));
        assert_eq!(baseline.percent_of_normal, 100.0);

        let (status, grade, summary, plain_summary) = finalize_power_torture_outcome(
            &baseline,
            0.0,
            60.0,
            "AVX2",
            "None",
            4.2,
            0,
            false,
            false,
            false,
            false,
            Some(0.0),
            Some(72.0),
            92.0,
            92.0,
            true,
            true,
        );
        assert!(matches!(status, TestStatus::Warn));
        assert_eq!(grade, "CANCELLED");
        assert_ne!(grade, "A+");
        assert_ne!(grade, "A");
        assert!(summary.starts_with("[CANCELLED]"), "unexpected summary: {}", summary);
        assert!(!summary.contains("[Grade A+"), "summary leaked Grade A+: {}", summary);
        assert!(plain_summary.to_lowercase().contains("cancelled"));

        // Non-cancelled healthy run with rate_power_torture (100.0%) returns Pass + A
        let (ok_status, ok_grade, ok_summary, _) = finalize_power_torture_outcome(
            &baseline,
            0.0,
            60.0,
            "AVX2",
            "None",
            120.0,
            0,
            false,
            false,
            false,
            false,
            Some(0.0),
            Some(72.0),
            92.0,
            92.0,
            true,
            false,
        );
        assert!(matches!(ok_status, TestStatus::Pass));
        assert_eq!(ok_grade, "A");
        assert!(ok_summary.starts_with("[Grade A"));

        // Even with >102% score (which produces A+ when uncancelled), cancelled still yields CANCELLED
        let boosted_baseline = BaselineRating {
            percent_of_normal: 105.0,
            ..baseline.clone()
        };
        let (_, boosted_ok_grade, _, _) = finalize_power_torture_outcome(
            &boosted_baseline,
            0.0,
            60.0,
            "AVX2",
            "None",
            120.0,
            0,
            false,
            false,
            false,
            false,
            Some(0.0),
            Some(72.0),
            92.0,
            92.0,
            true,
            false,
        );
        assert_eq!(boosted_ok_grade, "A+");
        let (boosted_cancel_status, boosted_cancel_grade, boosted_cancel_summary, _) =
            finalize_power_torture_outcome(
                &boosted_baseline,
                0.0,
                60.0,
                "AVX2",
                "None",
                4.2,
                0,
                false,
                false,
                false,
                false,
                Some(0.0),
                Some(72.0),
                92.0,
                92.0,
                true,
                true,
            );
        assert!(matches!(boosted_cancel_status, TestStatus::Warn));
        assert_eq!(boosted_cancel_grade, "CANCELLED");
        assert!(boosted_cancel_summary.starts_with("[CANCELLED]"));
    }

    #[test]
    fn test_cancelled_power_torture_with_hardware_fault_preserves_fail() {
        let cutoff_baseline = baselines::rate_power_torture(0.0, false, true, Some(94.0));
        let (status_cutoff, grade_cutoff, summary_cutoff, _) = finalize_power_torture_outcome(
            &cutoff_baseline,
            0.0,
            45.0,
            "AVX2",
            "Thermal Cutoff",
            8.0,
            0,
            true,
            true,
            false,
            false,
            None,
            Some(94.0),
            92.0,
            92.0,
            true,
            true,
        );
        assert!(matches!(status_cutoff, TestStatus::Fail));
        assert_eq!(grade_cutoff, "FAIL");
        assert!(summary_cutoff.contains("THERMAL CUTOFF"));

        let clean_baseline = baselines::rate_power_torture(0.0, false, false, Some(74.0));
        let (status_art, grade_art, summary_art, _) = finalize_power_torture_outcome(
            &clean_baseline,
            0.0,
            50.0,
            "AVX2",
            "None",
            10.0,
            3,
            false,
            false,
            false,
            false,
            None,
            Some(74.0),
            92.0,
            92.0,
            true,
            true,
        );
        assert!(matches!(status_art, TestStatus::Fail));
        assert_eq!(grade_art, "FAIL");
        assert!(summary_art.starts_with("FAIL:"));
    }

    #[test]
    fn test_shelf_burnin_stage3_cancelled_without_faults_returns_incomplete_warn() {
        let (status, grade, stage_detail, summary, plain_summary, cancelled_out, cutoff_out) =
            finalize_shelf_burnin_outcome(
                5,
                42.3,
                0,
                0,
                false,
                0,
                false,
                true,
                false,
                0.0,
                &[],
                true,
            );
        assert!(matches!(status, TestStatus::Warn));
        assert_eq!(grade, "INCOMPLETE");
        assert_eq!(stage_detail, "Cancelled by technician");
        assert!(cancelled_out);
        assert!(!cutoff_out);
        assert!(!summary.contains("Grade A"), "summary leaked Grade A: {}", summary);
        assert!(!summary.contains("A+"), "summary leaked A+: {}", summary);
        assert!(!plain_summary.to_lowercase().contains("passed"), "plain_summary leaked passed: {}", plain_summary);
        assert!(plain_summary.to_lowercase().contains("stopped early"));

        // Also when cancel_flag is false on outer token yet torture_cancelled is true:
        let (st2, gr2, det2, sum2, plain2, canc2, _) = finalize_shelf_burnin_outcome(
            5, 42.3, 0, 0, false, 0, false, true, false, 0.0, &[], false,
        );
        assert!(matches!(st2, TestStatus::Warn));
        assert_eq!(gr2, "INCOMPLETE");
        assert_eq!(det2, "Cancelled by technician");
        assert!(canc2);
        assert!(!sum2.contains("Grade A"));
        assert!(!plain2.to_lowercase().contains("passed"));
    }

    #[test]
    fn test_shelf_burnin_stage3_cancelled_with_fault_preserves_fail() {
        let (st_err, gr_err, _, sum_err, _, canc_err, cut_err) = finalize_shelf_burnin_outcome(
            15, 110.0, 2, 0, false, 0, false, true, false, 4.0, &[], true,
        );
        assert!(matches!(st_err, TestStatus::Fail));
        assert_eq!(gr_err, "FAIL");
        assert!(canc_err);
        assert!(!cut_err);
        assert!(sum_err.contains("FAIL"));

        let (st_cut, gr_cut, _, sum_cut, plain_cut, canc_cut, cut_cut) = finalize_shelf_burnin_outcome(
            15, 95.0, 0, 0, false, 0, true, true, false, 3.0, &[], true,
        );
        assert!(matches!(st_cut, TestStatus::Fail));
        assert_eq!(gr_cut, "FAIL");
        assert!(canc_cut);
        assert!(cut_cut);
        assert!(sum_cut.contains("THERMAL CUTOFF"));
        assert!(plain_cut.contains("thermal safety cutoff"));
    }

    #[test]
    fn test_shelf_burnin_stage_error_never_awards_grade_a_or_passed() {
        let notes = vec![
            "VRAM stage skipped/error: No discrete adapter".to_string(),
            "Power torture stage error: Device lost".to_string(),
        ];
        let (status, grade, stage_detail, summary, plain_summary, cancelled_out, cutoff_out) =
            finalize_shelf_burnin_outcome(
                5, 30.0, 0, 0, false, 0, false, false, false, 0.0, &notes, false,
            );
        assert!(matches!(status, TestStatus::Warn));
        assert_eq!(grade, "INCOMPLETE");
        assert_ne!(grade, "A");
        assert_ne!(grade, "A+");
        assert!(!cancelled_out);
        assert!(!cutoff_out);
        assert!(stage_detail.to_lowercase().contains("incomplete"));
        assert!(summary.contains("Power torture stage error"));
        assert!(!summary.contains("Grade A"), "summary leaked Grade A: {}", summary);
        assert!(!plain_summary.to_lowercase().contains("passed"), "plain_summary leaked passed: {}", plain_summary);
        assert!(plain_summary.contains("VRAM stage skipped/error"));

        // Healthy uncancelled completion with zero stage_notes still computes Grade A
        let (ok_st, ok_gr, ok_det, ok_sum, ok_plain, ok_canc, _) = finalize_shelf_burnin_outcome(
            5, 300.0, 0, 0, false, 0, false, false, false, 2.5, &[], false,
        );
        assert!(matches!(ok_st, TestStatus::Pass));
        assert_eq!(ok_gr, "A");
        assert_eq!(ok_det, "Final Durability Grade: A");
        assert!(ok_sum.starts_with("[Grade A]"));
        assert!(ok_plain.contains("passed"));
        assert!(!ok_canc);
    }
}
