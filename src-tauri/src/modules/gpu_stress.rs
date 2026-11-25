use crate::modules::baselines;
use crate::types::{GpuAdapterInfo, GpuStressProgress, GpuStressResult, TestStatus};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytemuck::{Pod, Zeroable};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use std::sync::{
    atomic::{AtomicBool, Ordering},
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

fn read_gpu_telemetry() -> (Option<f32>, Option<f32>, Option<f32>) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::cmd_util::run_cmd_stdout(
            "nvidia-smi",
            &[
                "--query-gpu=temperature.gpu,utilization.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
        ) {
            if let Some(first_line) = out.lines().next() {
                let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 3 {
                    let temp = parts[0].parse::<f32>().ok();
                    let load = parts[1].parse::<f32>().ok();
                    let power = parts[2].parse::<f32>().ok();
                    if temp.is_some() {
                        return (temp, load, power);
                    }
                }
            }
        }
    }

    let components = sysinfo::Components::new_with_refreshed_list();
    let mut gpu_temp: Option<f32> = None;
    for comp in components.list() {
        let label = comp.label().to_lowercase();
        if label.contains("gpu") || label.contains("radeon") || label.contains("amd") {
            if let Some(t) = comp.temperature() {
                if t > 10.0 && t < 130.0 {
                    gpu_temp = Some(gpu_temp.map_or(t, |p| p.max(t)));
                }
            }
        }
    }
    (gpu_temp, None, None)
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

pub fn run_gpu_stress_test(
    app: &AppHandle,
    adapter_index: Option<usize>,
    preset: &str,
    resolution: &str,
    extreme_mode: bool,
    thermal_cutoff_c: f32,
    cancel: Arc<AtomicBool>,
) -> Result<GpuStressResult, String> {
    let duration_secs: u64 = match preset {
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

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut last_telemetry = Instant::now() - std::time::Duration::from_secs(5);
    let mut frames_rendered = 0u64;
    let mut window_frames = 0u64;
    let mut min_fps = f64::MAX;
    let mut max_fps = 0.0f64;
    let mut fps_samples: Vec<f64> = Vec::with_capacity(2048);
    let mut peak_temp: Option<f32> = None;
    let mut peak_power: Option<f32> = None;
    let mut cur_temp: Option<f32> = None;
    let mut cur_load: Option<f32> = None;
    let mut cur_power: Option<f32> = None;
    let mut thermal_cutoff_triggered = false;
    let mut cancelled = false;

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

        if last_telemetry.elapsed().as_secs_f64() >= 1.2 {
            let (t, l, p) = read_gpu_telemetry();
            cur_temp = t;
            cur_load = l;
            cur_power = p;
            if let Some(tv) = t {
                peak_temp = Some(peak_temp.map_or(tv, |prev| prev.max(tv)));
                if tv >= thermal_cutoff_c {
                    thermal_cutoff_triggered = true;
                    break;
                }
            }
            if let Some(pv) = p {
                peak_power = Some(peak_power.map_or(pv, |prev| prev.max(pv)));
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
                let url = encode_preview_jpeg(&mapped, width, height, padded_bpr);
                drop(mapped);
                readback_buf.unmap();
                url
            } else {
                None
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
                    thermal_warning: cur_temp.map(|t| t >= thermal_cutoff_c - 7.0).unwrap_or(false),
                    preview_data_url,
                },
            );

            window_frames = 0;
            last_emit = Instant::now();
        }
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
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

    let res_label = format!("{}x{}", width, height);
    let baseline = baselines::rate_gpu(&adapter_name, &res_label, avg_fps, fps_drop_pct, thermal_cutoff_triggered);

    let status = if thermal_cutoff_triggered {
        TestStatus::Fail
    } else if cancelled
        || fps_drop_pct >= 20.0
        || peak_temp.map(|t| t >= thermal_cutoff_c - 6.0).unwrap_or(false)
    {
        TestStatus::Warn
    } else {
        TestStatus::Pass
    };

    let summary = if thermal_cutoff_triggered {
        format!(
            "THERMAL CUTOFF at {:.0}°C on {}! Inspect GPU fans & paste.",
            peak_temp.unwrap_or(thermal_cutoff_c),
            adapter_name
        )
    } else if cancelled {
        format!(
            "Stopped early ({:.0}s) on {} — Avg {:.1} FPS (1% Low {:.1}, Drop {:.1}%).",
            elapsed, adapter_name, avg_fps, low_1pct_fps, fps_drop_pct
        )
    } else {
        format!(
            "[{} — {:.0}% of Normal] {} @ {} — Avg {:.1} FPS (1% Low {:.1}, Throttle Drop {:.1}%){}.",
            baseline.grade,
            baseline.percent_of_normal,
            adapter_name,
            res_label,
            avg_fps,
            low_1pct_fps,
            fps_drop_pct,
            peak_temp.map(|t| format!(", Peak {:.0}°C", t)).unwrap_or_default()
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
        peak_temp_c: peak_temp,
        peak_power_w: peak_power,
        thermal_cutoff_triggered,
        elapsed_secs: (elapsed * 10.0).round() / 10.0,
        cancelled,
        baseline,
        summary,
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
