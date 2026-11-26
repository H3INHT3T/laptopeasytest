use crate::modules::{
    baselines, cpu_stress,
    telemetry::{TelemetryReader, ThermalSafetyCheck},
    userbenchmark,
    vram_test::clamp_gpu_thermal_cutoff,
};
use crate::types::{
    GpuAdapterInfo, GpuStressProgress, GpuStressResult, LiveTelemetrySnapshot, TestStatus,
    UserBenchmarkInput,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytemuck::{Pod, Zeroable};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use wgpu::util::DeviceExt;

const SHADER_WGSL: &str = include_str!("../shaders/fur_torus.wgsl");
const ALU_VERIFY_WGSL: &str = include_str!("../shaders/vram_verify.wgsl");

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct Uniforms {
    resolution: [f32; 2],
    time: f32,
    stress_iters: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct AluParams {
    seed: u32,
    pattern_mode: u32,
    word_count: u32,
    _pad: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameIntegrityScan {
    pub errors_detected: u64,
    pub blackout: bool,
    pub stalled: bool,
    pub frame_hash: u64,
    pub new_stalled_streak: u32,
}

pub(crate) fn compute_gpu_sensor_bounded_duration(
    duration_secs: u64,
    extreme_mode: bool,
    sensor_unavailable: bool,
) -> u64 {
    if sensor_unavailable {
        duration_secs.min(if extreme_mode { 120 } else { 180 })
    } else {
        duration_secs
    }
}

pub(crate) fn scan_rgba_frame_integrity(
    rgba_padded: &[u8],
    width: u32,
    height: u32,
    padded_bpr: u32,
    prev_hash: Option<u64>,
    stalled_streak: u32,
    time_advanced: bool,
) -> FrameIntegrityScan {
    if width == 0 || height == 0 || rgba_padded.is_empty() {
        return FrameIntegrityScan {
            errors_detected: 1,
            blackout: true,
            stalled: false,
            frame_hash: 0,
            new_stalled_streak: 0,
        };
    }

    let gx_steps = 16u32.min(width);
    let gy_steps = 16u32.min(height);
    let mut max_rgb: u8 = 0;
    let mut alpha_corrupt: u64 = 0;
    let mut hash: u64 = 0xCBF2_9CE4_8422_2325;

    for gy in 0..gy_steps {
        let sy = ((gy as u64 * height as u64) / gy_steps as u64) as usize;
        let row_off = sy * padded_bpr as usize;
        for gx in 0..gx_steps {
            let sx = ((gx as u64 * width as u64) / gx_steps as u64) as usize;
            let px = row_off + sx * 4;
            if px + 3 < rgba_padded.len() {
                let r = rgba_padded[px];
                let g = rgba_padded[px + 1];
                let b = rgba_padded[px + 2];
                let a = rgba_padded[px + 3];
                max_rgb = max_rgb.max(r).max(g).max(b);
                if a != 255 {
                    alpha_corrupt += 1;
                }
                for byte in [r, g, b, a] {
                    hash ^= byte as u64;
                    hash = hash.wrapping_mul(0x1000_0000_01B3);
                }
            }
        }
    }

    let blackout = max_rgb == 0;
    let new_stalled_streak = if time_advanced && prev_hash == Some(hash) {
        stalled_streak.saturating_add(1)
    } else {
        0
    };
    let stalled = new_stalled_streak >= 4;
    let errors_detected = alpha_corrupt + u64::from(blackout) + u64::from(stalled);

    FrameIntegrityScan {
        errors_detected,
        blackout,
        stalled,
        frame_hash: hash,
        new_stalled_streak,
    }
}

pub(crate) fn diagnose_gpu_throttling(
    fps_drop_pct: f64,
    peak_temp_c: Option<f32>,
    safe_cutoff_c: f32,
    thermal_cutoff_triggered: bool,
    avg_power_w: Option<f32>,
    peak_power_w: Option<f32>,
    avg_load_pct: Option<f32>,
) -> (bool, bool, String) {
    if thermal_cutoff_triggered {
        return (true, false, "Thermal Cutoff".to_string());
    }
    let hot = peak_temp_c.map(|t| t >= safe_cutoff_c - 4.0).unwrap_or(false);
    let thermal_throttle = fps_drop_pct >= 20.0
        || (fps_drop_pct >= 15.0 && peak_temp_c.map(|t| t >= 80.0).unwrap_or(false))
        || hot;
    if thermal_throttle {
        return (true, false, "Thermal Throttling".to_string());
    }

    let power_sag = match (peak_power_w, avg_power_w) {
        (Some(pk), Some(av)) if pk > 10.0 => av < pk * 0.85,
        _ => false,
    };
    let cool_under_load = peak_temp_c.map(|t| t < 78.0).unwrap_or(true);
    let power_limit = (fps_drop_pct >= 12.0 && cool_under_load)
        || (power_sag && cool_under_load && avg_load_pct.map(|l| l >= 95.0).unwrap_or(false));
    if power_limit {
        return (false, true, "Power-Limit Throttling".to_string());
    }
    (false, false, "None (Steady)".to_string())
}

pub fn list_gpu_adapters() -> Vec<GpuAdapterInfo> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    let has_hw_gpu = adapters
        .iter()
        .any(|a| a.get_info().device_type != wgpu::DeviceType::Cpu);
    adapters
        .into_iter()
        .enumerate()
        .filter(|(_, adapter)| !has_hw_gpu || adapter.get_info().device_type != wgpu::DeviceType::Cpu)
        .map(|(index, adapter)| {
            let info = adapter.get_info();
            let is_discrete = info.device_type == wgpu::DeviceType::DiscreteGpu
                || info.name.to_lowercase().contains("pro")
                || info.name.to_lowercase().contains("max")
                || info.name.to_lowercase().contains("ultra");
            GpuAdapterInfo {
                index,
                name: info.name,
                backend: format!("{:?}", info.backend),
                device_type: format!("{:?}", info.device_type),
                vendor_id: info.vendor,
                is_discrete,
            }
        })
        .collect()
}

fn encode_preview_jpeg(rgba_padded: &[u8], width: u32, height: u32, padded_bpr: u32) -> Option<String> {
    let out_w = (width / 2).max(1);
    let out_h = (height / 2).max(1);
    let mut rgb = Vec::with_capacity((out_w * out_h * 3) as usize);

    for y in 0..out_h {
        let sy = (y * 2) as usize;
        let row_offset = sy * padded_bpr as usize;
        for x in 0..out_w {
            let sx = (x * 2) as usize;
            let px = row_offset + sx * 4;
            if px + 2 < rgba_padded.len() {
                rgb.push(rgba_padded[px]);
                rgb.push(rgba_padded[px + 1]);
                rgb.push(rgba_padded[px + 2]);
            } else {
                rgb.extend_from_slice(&[0, 0, 0]);
            }
        }
    }

    let mut jpeg_bytes = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut jpeg_bytes, 72);
    enc.encode(&rgb, out_w, out_h, ColorType::Rgb8.into()).ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(&jpeg_bytes)))
}

fn read_u32_buf(device: &wgpu::Device, buf: &wgpu::Buffer) -> Option<u32> {
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::Maintain::Wait);
    if rx.recv().ok().and_then(|r| r.ok()).is_some() {
        let data = slice.get_mapped_range();
        let val = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        drop(data);
        buf.unmap();
        Some(val)
    } else {
        None
    }
}

pub fn run_gpu_stress_test(
    app: &AppHandle,
    adapter_index: Option<usize>,
    preset: &str,
    resolution: &str,
    extreme_mode: bool,
    thermal_cutoff_c: f32,
    cancel: Arc<AtomicBool>,
) -> Result<GpuStressResult, String> {
    let safe_cutoff_c = clamp_gpu_thermal_cutoff(thermal_cutoff_c);
    let requested_duration_secs: u64 = match preset {
        "standard" => 300,  // 5 min durability
        "burnin" => 900,    // 15 min gaming burn-in
        "extended" => 1800, // 30 min extended stress
        _ => 120,           // 2 min Shop QC
    };

    let (width, height): (u32, u32) = match resolution {
        "1080p" => (1920, 1080),
        "1440p" => (2560, 1440),
        "4k" | "2160p" => (3840, 2160),
        _ => (1280, 720),
    };

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let mut adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    if adapters.is_empty() {
        return Err("No compatible GPU adapter found by wgpu (DX12/Vulkan/Metal).".to_string());
    }

    let chosen_idx = match adapter_index {
        Some(idx) if idx < adapters.len() => idx,
        _ => adapters
            .iter()
            .position(|a| a.get_info().device_type == wgpu::DeviceType::DiscreteGpu)
            .unwrap_or(0),
    };
    let adapter = adapters.swap_remove(chosen_idx);
    let adapter_info = adapter.get_info();
    let adapter_name = adapter_info.name.clone();
    let backend_str = format!("{:?}", adapter_info.backend);

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("LaptopBench GPU Stress Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .map_err(|e| format!("Failed to initialize GPU device: {}", e))?;

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("FurTorus Stress Shader"),
        source: wgpu::ShaderSource::Wgsl(SHADER_WGSL.into()),
    });

    let stress_iters = if extreme_mode {
        128.0
    } else if adapter_info.device_type == wgpu::DeviceType::DiscreteGpu {
        96.0
    } else {
        64.0
    };

    let uniform_data = Uniforms {
        resolution: [width as f32, height as f32],
        time: 0.0,
        stress_iters,
    };
    let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Uniforms"),
        contents: bytemuck::cast_slice(&[uniform_data]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Uniform Layout"),
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
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Uniform BindGroup"),
        layout: &bind_group_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform_buf.as_entire_binding(),
        }],
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("FurTorus Pipeline Layout"),
        bind_group_layouts: &[&bind_group_layout],
        push_constant_ranges: &[],
    });

    let texture_format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("FurTorus Pipeline"),
        layout: Some(&pipeline_layout),
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

    // Periodic compute ALU canary (`cs_alu_verify` from `vram_verify.wgsl`)
    let alu_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("ALU Canary Shader"),
        source: wgpu::ShaderSource::Wgsl(ALU_VERIFY_WGSL.into()),
    });
    let alu_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("ALU Canary BGL"),
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
    });
    let alu_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("ALU Canary PL"),
        bind_group_layouts: &[&alu_bgl],
        push_constant_ranges: &[],
    });
    let alu_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("cs_alu_verify"),
        layout: Some(&alu_pl),
        module: &alu_shader,
        entry_point: Some("cs_alu_verify"),
        compilation_options: Default::default(),
        cache: None,
    });
    let alu_words = 4096u32;
    let alu_param_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("ALU Params"),
        contents: bytemuck::cast_slice(&[AluParams {
            seed: 1,
            pattern_mode: 0,
            word_count: alu_words,
            _pad: 0,
        }]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let alu_dummy_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("ALU Dummy"),
        contents: bytemuck::cast_slice(&[0u32]),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let alu_err_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("ALU Error Counter"),
        contents: bytemuck::cast_slice(&[0u32]),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
    });
    let alu_err_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ALU Error Readback"),
        size: 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let alu_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ALU Canary BG"),
        layout: &alu_bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: alu_param_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: alu_dummy_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: alu_err_buf.as_entire_binding() },
        ],
    });

    let render_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Stress Render Target"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: texture_format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let render_view = render_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let unpadded_bpr = width * 4;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bpr = ((unpadded_bpr + align - 1) / align) * align;
    let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Preview Readback Buffer"),
        size: (padded_bpr * height) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut telemetry = TelemetryReader::new();
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut last_telemetry = Instant::now() - Duration::from_secs(5);
    let mut last_alu_canary = Instant::now() - Duration::from_secs(5);
    let mut frames_rendered = 0u64;
    let mut window_frames = 0u64;
    let mut min_fps = f64::MAX;
    let mut max_fps = 0.0f64;
    let mut fps_samples: Vec<f64> = Vec::with_capacity(2048);
    let mut power_samples: Vec<f32> = Vec::with_capacity(1024);
    let mut load_samples: Vec<f32> = Vec::with_capacity(1024);
    let mut peak_temp: Option<f32> = None;
    let mut peak_power: Option<f32> = None;
    let mut cur_temp: Option<f32> = None;
    let mut cur_load: Option<f32> = None;
    let mut cur_power: Option<f32> = None;
    let mut thermal_cutoff_triggered = false;
    let mut cancelled = false;
    let mut artifact_errors: u64 = 0;
    let mut prev_frame_hash: Option<u64> = None;
    let mut stalled_streak: u32 = 0;
    let mut prev_frame_time: f32 = -1.0;
    let mut sensor_polls = 0u32;
    let mut sensor_available_ever = false;
    let mut duration_secs = requested_duration_secs;

    while started.elapsed().as_secs() < duration_secs {
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

        let need_preview = last_emit.elapsed().as_millis() >= 250;
        let run_alu = last_alu_canary.elapsed() >= Duration::from_secs(2);
        if run_alu {
            queue.write_buffer(&alu_err_buf, 0, bytemuck::cast_slice(&[0u32]));
            queue.write_buffer(
                &alu_param_buf,
                0,
                bytemuck::cast_slice(&[AluParams {
                    seed: (frames_rendered as u32).wrapping_add(1),
                    pattern_mode: 0,
                    word_count: alu_words,
                    _pad: 0,
                }]),
            );
        }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("FurTorus Frame"),
        });
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("FurTorus Pass"),
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
            rpass.set_bind_group(0, &bind_group, &[]);
            rpass.draw(0..3, 0..1);
        }

        if run_alu {
            {
                let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                cpass.set_pipeline(&alu_pipe);
                cpass.set_bind_group(0, &alu_bg, &[]);
                cpass.dispatch_workgroups(alu_words / 64, 1, 1);
            }
            encoder.copy_buffer_to_buffer(&alu_err_buf, 0, &alu_err_readback, 0, 4);
        }

        if need_preview {
            encoder.copy_texture_to_buffer(
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
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
        }

        queue.submit(Some(encoder.finish()));
        device.poll(wgpu::Maintain::Wait);

        frames_rendered += 1;
        window_frames += 1;

        if run_alu {
            if let Some(errs) = read_u32_buf(&device, &alu_err_readback) {
                artifact_errors = artifact_errors.saturating_add(errs as u64);
            }
            last_alu_canary = Instant::now();
        }

        if last_telemetry.elapsed() >= Duration::from_millis(900) {
            let (t, l, p) = telemetry.sample_gpu_only();
            sensor_polls += 1;
            cur_temp = t;
            cur_load = l;
            cur_power = p;
            if let Some(lv) = l.filter(|v| v.is_finite()) {
                load_samples.push(lv);
            }
            if let Some(pv) = p.filter(|v| v.is_finite()) {
                power_samples.push(pv);
                peak_power = Some(peak_power.map_or(pv, |prev| prev.max(pv)));
            }
            if let Some(tv) = t {
                sensor_available_ever = true;
                peak_temp = Some(peak_temp.map_or(tv, |prev| prev.max(tv)));
            }

            let gpu_snap = LiveTelemetrySnapshot {
                gpu_temp_c: t,
                gpu_load_pct: l,
                gpu_power_w: p,
                gpu_temp_available: t.is_some(),
                ..Default::default()
            };
            match TelemetryReader::is_thermal_safe(&gpu_snap, f32::INFINITY, safe_cutoff_c) {
                ThermalSafetyCheck::CutoffTriggered { temp_c, .. } => {
                    peak_temp = Some(peak_temp.map_or(temp_c, |prev| prev.max(temp_c)));
                    thermal_cutoff_triggered = true;
                    break;
                }
                ThermalSafetyCheck::SensorUnavailable => {
                    if !sensor_available_ever && sensor_polls >= 2 && started.elapsed().as_secs_f64() >= 2.0 {
                        duration_secs = compute_gpu_sensor_bounded_duration(
                            requested_duration_secs,
                            extreme_mode,
                            true,
                        );
                    }
                }
                ThermalSafetyCheck::Safe => {
                    sensor_available_ever = true;
                }
            }
            last_telemetry = Instant::now();
        }

        if need_preview {
            let win_secs = last_emit.elapsed().as_secs_f64().max(0.001);
            let inst_fps = window_frames as f64 / win_secs;
            if frames_rendered > 4 {
                fps_samples.push(inst_fps);
                if inst_fps < min_fps {
                    min_fps = inst_fps;
                }
                if inst_fps > max_fps {
                    max_fps = inst_fps;
                }
            }
            let total_elapsed = started.elapsed().as_secs_f64().max(0.001);
            let avg_fps = frames_rendered as f64 / total_elapsed;
            let low_1pct_fps = compute_low_1pct(&fps_samples, inst_fps);

            let slice = readback_buf.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |res| {
                let _ = tx.send(res);
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

                let url = encode_preview_jpeg(&mapped, width, height, padded_bpr);
                drop(mapped);
                readback_buf.unmap();
                url
            } else {
                None
            };

            let live_drop = if fps_samples.len() >= 10 {
                let k = (fps_samples.len() / 5).max(3);
                let early: f64 = fps_samples[..k].iter().sum::<f64>() / k as f64;
                let late: f64 = fps_samples[fps_samples.len() - k..].iter().sum::<f64>() / k as f64;
                ((early - late) / early.max(0.1) * 100.0).clamp(0.0, 99.0)
            } else {
                0.0
            };
            let throttle_state = if cur_temp.map(|t| t >= safe_cutoff_c - 4.0).unwrap_or(false)
                || live_drop >= 18.0
            {
                "Throttling".to_string()
            } else {
                "Steady".to_string()
            };

            let _ = app.emit(
                "gpu:progress",
                GpuStressProgress {
                    running: true,
                    adapter_name: adapter_name.clone(),
                    width,
                    height,
                    fps: (inst_fps * 10.0).round() / 10.0,
                    avg_fps: (avg_fps * 10.0).round() / 10.0,
                    min_fps: if min_fps < f64::MAX {
                        (min_fps * 10.0).round() / 10.0
                    } else {
                        (inst_fps * 10.0).round() / 10.0
                    },
                    low_1pct_fps: (low_1pct_fps * 10.0).round() / 10.0,
                    frame_time_ms: (1000.0 / inst_fps.max(0.1) * 10.0).round() / 10.0,
                    frames_rendered,
                    elapsed_secs: (total_elapsed * 10.0).round() / 10.0,
                    duration_secs,
                    gpu_temp_c: cur_temp,
                    gpu_load_pct: cur_load,
                    gpu_power_w: cur_power,
                    thermal_warning: cur_temp.map(|t| t >= safe_cutoff_c - 7.0).unwrap_or(false),
                    preview_data_url,
                    artifact_errors,
                    gpu_temp_available: sensor_available_ever,
                    throttle_state,
                    in_cooldown: false,
                },
            );

            window_frames = 0;
            last_emit = Instant::now();
        }
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.001);

    // Automatic 12-Second Post-Load GPU Cool-Down Recovery Check (skippable via Stop without losing GPU scores)
    let cooldown_start_temp_c = cur_temp.or(peak_temp).map(|t| (t * 10.0).round() / 10.0);
    let mut cooldown_end_temp_c: Option<f32> = None;
    let mut cooldown_skipped = false;
    let mut cd_elapsed_secs = 0.0f32;
    if !cancelled && !thermal_cutoff_triggered && sensor_available_ever && cooldown_start_temp_c.is_some() {
        let cd_secs = 12u64;
        let cd_started = Instant::now();
        while cd_started.elapsed().as_secs() < cd_secs {
            if cancel.load(Ordering::Relaxed) {
                cooldown_skipped = true;
                break;
            }
            let (t, l, p) = telemetry.sample_gpu_only();
            if let Some(tv) = t {
                cooldown_end_temp_c = Some((tv * 10.0).round() / 10.0);
            }
            let cd_now = cd_started.elapsed().as_secs_f64();
            let _ = app.emit(
                "gpu:progress",
                GpuStressProgress {
                    running: true,
                    adapter_name: adapter_name.clone(),
                    width,
                    height,
                    fps: 0.0,
                    avg_fps: ((frames_rendered as f64 / elapsed) * 10.0).round() / 10.0,
                    min_fps: if min_fps < f64::MAX { (min_fps * 10.0).round() / 10.0 } else { 0.0 },
                    low_1pct_fps: (compute_low_1pct(&fps_samples, 0.0) * 10.0).round() / 10.0,
                    frame_time_ms: 0.0,
                    frames_rendered,
                    elapsed_secs: ((elapsed + cd_now) * 10.0).round() / 10.0,
                    duration_secs,
                    gpu_temp_c: t,
                    gpu_load_pct: l,
                    gpu_power_w: p,
                    thermal_warning: false,
                    preview_data_url: None,
                    artifact_errors,
                    gpu_temp_available: sensor_available_ever,
                    throttle_state: format!("Cool-Down Recovery ({:.0}s / {}s)", cd_now.min(cd_secs as f64), cd_secs),
                    in_cooldown: true,
                },
            );
            for _ in 0..5 {
                if cancel.load(Ordering::Relaxed) || cd_started.elapsed().as_secs() >= cd_secs {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        cd_elapsed_secs = cd_started.elapsed().as_secs_f32().max(1.0);
    }

    let (cooldown_drop_c, cooldown_rate_c_per_sec, cooldown_verdict, cooldown_note) = if cooldown_skipped {
        (
            None,
            None,
            "SKIPPED".to_string(),
            "Cool-down phase skipped by technician; GPU scores preserved.".to_string(),
        )
    } else {
        cpu_stress::classify_smart_cooldown(cooldown_start_temp_c, cooldown_end_temp_c, cd_elapsed_secs.max(12.0))
    };

    let avg_fps = ((frames_rendered as f64 / elapsed) * 10.0).round() / 10.0;
    let final_min = if min_fps < f64::MAX {
        (min_fps * 10.0).round() / 10.0
    } else {
        avg_fps
    };
    let final_max = if max_fps > 0.0 {
        (max_fps * 10.0).round() / 10.0
    } else {
        avg_fps
    };
    let low_1pct_fps = (compute_low_1pct(&fps_samples, avg_fps) * 10.0).round() / 10.0;

    // Thermal throttle FPS drop: compare early 20% window vs final 20% window
    let fps_drop_pct = if fps_samples.len() >= 10 {
        let k = (fps_samples.len() / 5).max(3);
        let early: f64 = fps_samples[..k].iter().sum::<f64>() / k as f64;
        let late: f64 = fps_samples[fps_samples.len() - k..].iter().sum::<f64>() / k as f64;
        ((((early - late) / early.max(0.1)) * 100.0).clamp(0.0, 99.0) * 10.0).round() / 10.0
    } else {
        0.0
    };

    let avg_power_w = if power_samples.is_empty() {
        None
    } else {
        let avg = power_samples.iter().sum::<f32>() / power_samples.len() as f32;
        Some((avg * 10.0).round() / 10.0)
    };
    let avg_load_pct = if load_samples.is_empty() {
        None
    } else {
        let avg = load_samples.iter().sum::<f32>() / load_samples.len() as f32;
        Some((avg * 10.0).round() / 10.0)
    };

    let (thermal_throttling_detected, power_limit_throttling, throttle_reason) =
        diagnose_gpu_throttling(
            fps_drop_pct,
            peak_temp,
            safe_cutoff_c,
            thermal_cutoff_triggered,
            avg_power_w,
            peak_power,
            avg_load_pct,
        );

    let res_label = format!("{}x{}", width, height);
    let baseline = baselines::rate_gpu(&adapter_name, &res_label, avg_fps, fps_drop_pct, thermal_cutoff_triggered);

    let ub_cmp = userbenchmark::compare_userbenchmark(&UserBenchmarkInput {
        gpu_name: Some(adapter_name.clone()),
        gpu_resolution: Some(res_label.clone()),
        gpu_avg_fps: Some(avg_fps),
        gpu_fps_drop_pct: Some(fps_drop_pct),
        gpu_thermal_cutoff: thermal_cutoff_triggered,
        allow_live_lookup: false,
        ..Default::default()
    });
    let userbenchmark_rating = ub_cmp.gpu;

    let status = if thermal_cutoff_triggered || artifact_errors > 0 {
        TestStatus::Fail
    } else if cancelled
        || thermal_throttling_detected
        || power_limit_throttling
        || cooldown_verdict == "POOR_COOLING"
        || peak_temp.map(|t| t >= safe_cutoff_c - 6.0).unwrap_or(false)
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let cooldown_summary_tag = if let Some(drop_c) = cooldown_drop_c {
        format!(", Cool-Down -{:.1}°C ({})", drop_c, cooldown_verdict)
    } else {
        String::new()
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF at {:.0}°C (limit {:.0}°C) on {}! Inspect GPU fans & paste.",
            peak_temp.unwrap_or(safe_cutoff_c),
            safe_cutoff_c,
            adapter_name
        )
    } else if artifact_errors > 0 {
        format!(
            "FAIL: {} GPU render/shader artifact error(s) detected on {}!",
            artifact_errors, adapter_name
        )
    } else if cancelled {
        format!(
            "Stopped early ({:.0}s) on {} — Avg {:.1} FPS (1% Low {:.1}, Drop {:.1}%).",
            elapsed, adapter_name, avg_fps, low_1pct_fps, fps_drop_pct
        )
    } else {
        format!(
            "[{} — {:.0}% of Normal] {} @ {} — Avg {:.1} FPS (1% Low {:.1}, Drop {:.1}%, Throttle: {}){}{}.",
            baseline.grade,
            baseline.percent_of_normal,
            adapter_name,
            res_label,
            avg_fps,
            low_1pct_fps,
            fps_drop_pct,
            throttle_reason,
            peak_temp.map(|t| format!(", Peak {:.0}°C", t)).unwrap_or_default(),
            cooldown_summary_tag
        )
    };

    let ub_txt = userbenchmark_rating
        .as_ref()
        .map(|u| format!(" UserBenchmark: {} ({:.0}% — {}).", u.vehicle_tier, u.effective_speed_pct, u.standing_label))
        .unwrap_or_default();
    let sensor_note = if !sensor_available_ever {
        " GPU thermal sensor unavailable — duration safely bounded."
    } else {
        ""
    };
    let cooldown_plain_part = if let Some(drop_c) = cooldown_drop_c {
        format!(" Cool-Down: -{:.1}°C ({}).", drop_c, cooldown_verdict)
    } else {
        String::new()
    };
    let plain_summary = if thermal_cutoff_triggered {
        format!(
            "{} overheated to {:.0}°C (cutoff {:.0}°C) and shut down safely. Replace thermal paste or clean GPU cooling.",
            adapter_name,
            peak_temp.unwrap_or(safe_cutoff_c),
            safe_cutoff_c
        )
    } else if artifact_errors > 0 {
        format!(
            "{} produced {} rendering/compute artifact error(s) under FurMark-style load. GPU core or memory may be defective.",
            adapter_name, artifact_errors
        )
    } else {
        format!(
            "{} @ {}: Avg {:.1} FPS (1% Low {:.1} FPS, {:.1}% FPS drop, Throttle: {}).{}{}{}",
            adapter_name, res_label, avg_fps, low_1pct_fps, fps_drop_pct, throttle_reason, cooldown_plain_part, ub_txt, sensor_note
        )
    };

    Ok(GpuStressResult {
        status,
        adapter_name,
        backend: backend_str,
        resolution: res_label,
        preset: preset.to_string(),
        avg_fps,
        min_fps: final_min,
        max_fps: final_max,
        low_1pct_fps,
        fps_drop_pct,
        frames_rendered,
        peak_temp_c: peak_temp.map(|t| (t * 10.0).round() / 10.0),
        peak_power_w: peak_power.map(|p| (p * 10.0).round() / 10.0),
        thermal_cutoff_triggered,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled,
        baseline,
        summary,
        artifact_errors,
        avg_power_w,
        avg_load_pct,
        thermal_throttling_detected,
        power_limit_throttling,
        throttle_reason,
        sensor_available: sensor_available_ever,
        effective_cutoff_c: safe_cutoff_c,
        plain_summary,
        userbenchmark_rating,
        cooldown_start_temp_c,
        cooldown_end_temp_c,
        cooldown_drop_c,
        cooldown_rate_c_per_sec,
        cooldown_verdict,
        cooldown_note,
    })
}

fn compute_low_1pct(samples: &[f64], fallback: f64) -> f64 {
    if samples.is_empty() {
        return fallback;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = (sorted.len() / 20).max(1);
    sorted[..n].iter().sum::<f64>() / n as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_gpu_thermal_cutoff() {
        assert_eq!(clamp_gpu_thermal_cutoff(95.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(105.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(92.0), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(84.0), 84.0);
        assert_eq!(clamp_gpu_thermal_cutoff(60.0), 75.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::NAN), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::INFINITY), 92.0);
        assert_eq!(clamp_gpu_thermal_cutoff(f32::NEG_INFINITY), 92.0);
    }

    #[test]
    fn test_sensor_unavailable_caps_duration() {
        assert_eq!(compute_gpu_sensor_bounded_duration(1800, false, true), 180);
        assert_eq!(compute_gpu_sensor_bounded_duration(900, true, true), 120);
        assert_eq!(compute_gpu_sensor_bounded_duration(1800, false, false), 1800);
        assert_eq!(compute_gpu_sensor_bounded_duration(900, true, false), 900);
    }

    #[test]
    fn test_scan_rgba_frame_integrity() {
        let w = 32u32;
        let h = 32u32;
        let bpr = 256u32;
        let mut frame = vec![0u8; (bpr * h) as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let off = y * bpr as usize + x * 4;
                frame[off] = (x * 7) as u8;
                frame[off + 1] = (y * 7) as u8;
                frame[off + 2] = 128;
                frame[off + 3] = 255;
            }
        }
        let s1 = scan_rgba_frame_integrity(&frame, w, h, bpr, None, 0, true);
        assert_eq!(s1.errors_detected, 0);
        assert!(!s1.blackout);
        assert!(!s1.stalled);

        // Non-255 alpha corruption
        frame[3] = 120;
        let s_alpha = scan_rgba_frame_integrity(&frame, w, h, bpr, None, 0, true);
        assert!(s_alpha.errors_detected >= 1);
        frame[3] = 255;

        // Blackout frame (RGB all zero)
        let mut black = vec![0u8; (bpr * h) as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                black[y * bpr as usize + x * 4 + 3] = 255;
            }
        }
        let s_black = scan_rgba_frame_integrity(&black, w, h, bpr, None, 0, true);
        assert!(s_black.blackout);
        assert!(s_black.errors_detected >= 1);

        // Stalled frame (>= 4 identical hashes while time advanced)
        let mut streak = 0;
        let mut prev = Some(s1.frame_hash);
        for step in 0..4 {
            let st = scan_rgba_frame_integrity(&frame, w, h, bpr, prev, streak, true);
            prev = Some(st.frame_hash);
            streak = st.new_stalled_streak;
            if step == 3 {
                assert!(st.stalled);
                assert!(st.errors_detected >= 1);
            } else {
                assert!(!st.stalled);
            }
        }
    }

    #[test]
    fn test_diagnose_gpu_throttling() {
        let (th, pw, r) = diagnose_gpu_throttling(5.0, Some(92.0), 92.0, true, Some(65.0), Some(70.0), Some(99.0));
        assert!(th && !pw && r == "Thermal Cutoff");

        let (th2, pw2, r2) = diagnose_gpu_throttling(22.0, Some(84.0), 92.0, false, Some(65.0), Some(70.0), Some(99.0));
        assert!(th2 && !pw2 && r2 == "Thermal Throttling");

        let (th3, pw3, r3) = diagnose_gpu_throttling(14.0, Some(68.0), 92.0, false, Some(45.0), Some(75.0), Some(99.0));
        assert!(!th3 && pw3 && r3 == "Power-Limit Throttling");

        let (th4, pw4, r4) = diagnose_gpu_throttling(2.5, Some(72.0), 92.0, false, Some(68.0), Some(72.0), Some(98.0));
        assert!(!th4 && !pw4 && r4 == "None (Steady)");
    }

    #[test]
    fn test_gpu_stress_result_serde_backward_compat() {
        let v22 = r#"{"status":"pass","adapterName":"RTX 4070","avgFps":120.5}"#;
        let r: GpuStressResult = serde_json::from_str(v22).unwrap();
        assert_eq!(r.adapter_name, "RTX 4070");
        assert_eq!(r.artifact_errors, 0);
        assert!(r.userbenchmark_rating.is_none());
    }
}
