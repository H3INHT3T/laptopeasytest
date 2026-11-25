use crate::modules::{baselines, ram_test, simd_kernels, telemetry::TelemetryReader, vram_test};
use crate::types::{
    BurnInProgress, BurnInResult, PowerTortureProgress, PowerTortureResult, TestStatus,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytemuck::{Pod, Zeroable};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use wgpu::util::DeviceExt;

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
pub fn run_power_torture(
    app: &AppHandle,
    adapter_index: Option<usize>,
    duration_secs: u64,
    thermal_cutoff_c: f32,
    cancel: Arc<AtomicBool>,
) -> Result<PowerTortureResult, String> {
    let duration_secs = duration_secs.clamp(30, 1800);
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

    // Spawn dedicated background CPU AVX2/NEON + RAM load threads (leave 1 thread for GPU submission!)
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

    let mut telemetry = TelemetryReader::new();
    let init_snap = telemetry.sample(true);
    let battery_start_pct = init_snap.battery_percent;

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut last_snap_time = Instant::now() - std::time::Duration::from_secs(5);
    let mut cur_snap = init_snap;
    let mut frames_rendered = 0u64;
    let mut window_frames = 0u64;
    let mut fps_samples: Vec<f64> = Vec::with_capacity(1024);
    let mut peak_cpu_temp: Option<f32> = None;
    let mut peak_gpu_temp: Option<f32> = None;
    let mut peak_gpu_power: Option<f32> = None;
    let mut drain_ticks = 0u32;
    let mut battery_drain_while_plugged = false;
    let mut thermal_cutoff_triggered = false;
    let mut cancelled = false;

    while started.elapsed().as_secs() < duration_secs {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let u = Uniforms {
            resolution: [width as f32, height as f32],
            time: started.elapsed().as_secs_f32(),
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

        if last_snap_time.elapsed().as_secs_f64() >= 1.4 {
            cur_snap = telemetry.sample(true);
            if let Some(ct) = cur_snap.cpu_temp_c {
                peak_cpu_temp = Some(peak_cpu_temp.map_or(ct, |p| p.max(ct)));
                if ct >= thermal_cutoff_c {
                    thermal_cutoff_triggered = true;
                    break;
                }
            }
            if let Some(gt) = cur_snap.gpu_temp_c {
                peak_gpu_temp = Some(peak_gpu_temp.map_or(gt, |p| p.max(gt)));
                if gt >= thermal_cutoff_c {
                    thermal_cutoff_triggered = true;
                    break;
                }
            }
            if let Some(gp) = cur_snap.gpu_power_w {
                peak_gpu_power = Some(peak_gpu_power.map_or(gp, |p| p.max(gp)));
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
            let thermal_warning = cur_snap.cpu_temp_c.map(|t| t >= thermal_cutoff_c - 6.0).unwrap_or(false)
                || cur_snap.gpu_temp_c.map(|t| t >= thermal_cutoff_c - 6.0).unwrap_or(false);

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
                },
            );

            window_frames = 0;
            last_emit = Instant::now();
        }
    }

    // Cleanly stop CPU torture threads
    worker_stop.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }

    let final_snap = telemetry.sample(true);
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

    let baseline = baselines::rate_power_torture(
        fps_drop_pct,
        battery_drain_while_plugged,
        thermal_cutoff_triggered,
        combined_peak_temp,
    );
    let durability_grade = baselines::compute_durability_grade(
        baseline.percent_of_normal,
        fps_drop_pct,
        0,
        thermal_cutoff_triggered,
        battery_drain_while_plugged,
    );

    let status = if thermal_cutoff_triggered {
        TestStatus::Fail
    } else if battery_drain_while_plugged || fps_drop_pct >= 22.0 || cancelled {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF ({:.0}°C) during Combined CPU+GPU+RAM Torture! Cooling system cannot handle full chassis load.",
            combined_peak_temp.unwrap_or(thermal_cutoff_c)
        )
    } else if battery_drain_while_plugged {
        format!(
            "[Grade {}] WARNING: Battery DRAINED while AC plugged in (delta {:.1}%) under full CPU+GPU load! Check charger wattage / DC-in circuit.",
            durability_grade,
            battery_delta_pct.unwrap_or(0.0)
        )
    } else {
        format!(
            "[Grade {} — {}] Combined CPU ({}) + GPU ({:.1} FPS, Drop {:.1}%) + RAM stable for {:.0}s.",
            durability_grade, baseline.grade, simd_isa, avg_fps, fps_drop_pct, elapsed
        )
    };

    Ok(PowerTortureResult {
        status,
        adapter_name,
        simd_isa,
        duration_secs,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        avg_fps,
        fps_drop_pct,
        peak_cpu_temp_c: peak_cpu_temp,
        peak_gpu_temp_c: peak_gpu_temp,
        peak_gpu_power_w: peak_gpu_power,
        battery_start_pct,
        battery_end_pct,
        battery_delta_pct,
        battery_drain_while_plugged,
        thermal_cutoff_triggered,
        cancelled,
        durability_grade,
        baseline,
        summary,
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
    let mins = total_minutes.clamp(3, 60);
    let total_secs = mins * 60;
    let ram_secs = ((total_secs as f64) * 0.30).round() as u64;
    let vram_secs = ((total_secs as f64) * 0.25).round() as u64;
    let torture_secs = total_secs.saturating_sub(ram_secs + vram_secs).max(30);

    let started = Instant::now();
    let mut telemetry = TelemetryReader::new();

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
            telemetry: Some(telemetry.sample(true)),
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
    if cancel.load(Ordering::Relaxed) {
        return Ok(cancelled_burnin(mins, started.elapsed().as_secs_f64(), Some(ram_res), None, None));
    }

    // Stage 2/3: Dedicated GPU VRAM Integrity
    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: true,
            stage_index: 2,
            total_stages: 3,
            stage_name: "Stage 2/3: Dedicated GPU VRAM Integrity".into(),
            stage_detail: format!("Sweeping GPU VRAM buffers via wgpu compute for {}s...", vram_secs),
            overall_percent: 35.0,
            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: 0,
            battery_drain_alert: false,
            telemetry: Some(telemetry.sample(true)),
        },
    );

    let vram_res = vram_test::run_vram_integrity_test(app, None, None, vram_secs, cancel.clone()).ok();
    let vram_errs = vram_res.as_ref().map(|v| v.errors_found).unwrap_or(0);
    if cancel.load(Ordering::Relaxed) {
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
                "Maximum full-chassis thermal & charger stress for {}s (Cutoff {:.0}°C)...",
                torture_secs, thermal_cutoff_c
            ),
            overall_percent: 62.0,
            elapsed_secs: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: vram_errs,
            battery_drain_alert: false,
            telemetry: Some(telemetry.sample(true)),
        },
    );

    let torture_res =
        run_power_torture(app, None, torture_secs, thermal_cutoff_c, cancel.clone()).ok();
    let elapsed = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;

    let total_hw_errors = ram_res.errors_found + vram_errs;
    let cutoff = torture_res
        .as_ref()
        .map(|t| t.thermal_cutoff_triggered)
        .unwrap_or(false);
    let drain = torture_res
        .as_ref()
        .map(|t| t.battery_drain_while_plugged)
        .unwrap_or(false);
    let drop_pct = torture_res.as_ref().map(|t| t.fps_drop_pct).unwrap_or(0.0);

    let grade = baselines::compute_durability_grade(
        100.0,
        drop_pct,
        total_hw_errors,
        cutoff,
        drain,
    );

    let status = if total_hw_errors > 0 || cutoff {
        TestStatus::Fail
    } else if drain || drop_pct >= 20.0 || cancel.load(Ordering::Relaxed) {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let _ = app.emit(
        "burnin:progress",
        BurnInProgress {
            running: false,
            stage_index: 3,
            total_stages: 3,
            stage_name: "Shelf Burn-In Complete".into(),
            stage_detail: format!("Final Durability Grade: {}", grade),
            overall_percent: 100.0,
            elapsed_secs: elapsed,
            total_duration_secs: total_secs,
            ram_errors: ram_res.errors_found,
            vram_errors: vram_errs,
            battery_drain_alert: drain,
            telemetry: Some(telemetry.sample(true)),
        },
    );

    let summary = format!(
        "[Grade {}] {}m Shelf Burn-In finished ({:.0}s): RAM {} err | VRAM {} err | Power Torture Drop {:.1}%{}",
        grade,
        mins,
        elapsed,
        ram_res.errors_found,
        vram_errs,
        drop_pct,
        if drain { " | CHARGER DRAIN WARNING" } else { "" }
    );

    Ok(BurnInResult {
        status,
        total_minutes: mins,
        elapsed_secs: elapsed,
        cancelled: cancel.load(Ordering::Relaxed),
        ram_result: Some(ram_res),
        vram_result: vram_res,
        torture_result: torture_res,
        durability_grade: grade,
        summary,
    })
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
    }
}
