// LaptopBench QC v3.5.0 — True Native Rust wgpu + winit Uncapped Fullscreen DX12/Vulkan/Metal 3D Engine
// Renders 4 hardware-intensive GPU scenes directly to a native OS fullscreen surface (PresentMode::Immediate),
// completely bypassing WebView2's 60Hz VSync lock on Windows (DX12/Vulkan) and macOS (Metal).

use crate::modules::{
    telemetry::{TelemetryReader, ThermalSafetyCheck},
    vram_test::clamp_gpu_thermal_cutoff,
};
use crate::types::{LiveTelemetrySnapshot, Native3dSceneScore, Native3dSuiteResult, TestStatus};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytemuck::{Pod, Zeroable};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{Fullscreen, Window, WindowId};

const SUITE_SHADER_WGSL: &str = include_str!("../shaders/native_3d_suite.wgsl");
const PARTICLES_SHADER_WGSL: &str = include_str!("../shaders/native_particles.wgsl");
const HUD_SHADER_WGSL: &str = include_str!("../shaders/native_hud.wgsl");
const ALU_CANARY_WGSL: &str = include_str!("../shaders/vram_verify.wgsl");

const PARTICLE_COUNT: u32 = 500_000;
const HUD_W: u32 = 1280;
const HUD_H: u32 = 72;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct SuiteUniforms {
    resolution: [f32; 2],
    time: f32,
    scene_mode: u32,
    cam_yaw: f32,
    cam_pitch: f32,
    cam_zoom: f32,
    stress_mult: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct ParticleUniforms {
    time: f32,
    dt: f32,
    aspect: f32,
    particle_count: u32,
    attractor_x: f32,
    attractor_y: f32,
    zoom: f32,
    _pad: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct ParticleVertex {
    pos: [f32; 2],
    vel: [f32; 2],
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct AluCanaryParams {
    seed: u32,
    pattern_mode: u32,
    word_count: u32,
    _pad: u32,
}

#[derive(Clone, Copy)]
struct NativeSceneDef {
    id: &'static str,
    name: &'static str,
    short: &'static str,
    mode: u32, // 0=FurMark, 1=PathTrace, 2=Canyon, 3=Particles500k
}

const NATIVE_SCENES: [NativeSceneDef; 4] = [
    NativeSceneDef {
        id: "native_furmark",
        name: "Native FurMark Volumetric Fur-Torus Thermal Hammer",
        short: "FURMARK TORUS",
        mode: 0,
    },
    NativeSceneDef {
        id: "native_pathtrace",
        name: "Native Multi-Bounce Path-Traced PBR & Glass Caustics",
        short: "PATH-TRACED PBR",
        mode: 1,
    },
    NativeSceneDef {
        id: "native_canyon",
        name: "Native Volumetric Alpine Canyon, Clouds & Ocean",
        short: "VOLUMETRIC CANYON",
        mode: 2,
    },
    NativeSceneDef {
        id: "native_particles",
        name: "Native 500,000-Particle GPU Compute Gravity Vortex",
        short: "500K GPU COMPUTE",
        mode: 3,
    },
];

#[derive(Clone, Default)]
struct SharedGpuTelemetry {
    temp_c: Option<f32>,
    peak_temp_c: Option<f32>,
    load_pct: Option<f32>,
    power_w: Option<f32>,
    peak_power_w: Option<f32>,
    cutoff_triggered: bool,
}

#[derive(Clone)]
struct CliConfig {
    res_label: String,
    target_w: u32,
    target_h: u32,
    secs_per_scene: f64,
    adapter_index: Option<usize>,
    thermal_cutoff_c: f32,
    scene_indices: Vec<usize>,
}

fn parse_cli_config(args: &[String]) -> CliConfig {
    let mut res_label = "1080p".to_string();
    let mut secs_per_scene = 12.0f64;
    let mut adapter_index: Option<usize> = None;
    let mut thermal_cutoff_c = 86.0f32;
    let mut scene_arg = "all".to_string();

    for arg in args {
        if let Some(v) = arg.strip_prefix("--res=") {
            res_label = v.to_lowercase();
        } else if let Some(v) = arg.strip_prefix("--secs=") {
            if let Ok(n) = v.parse::<f64>() {
                secs_per_scene = n.clamp(5.0, 60.0);
            }
        } else if let Some(v) = arg.strip_prefix("--adapter=") {
            if let Ok(n) = v.parse::<usize>() {
                adapter_index = Some(n);
            }
        } else if let Some(v) = arg.strip_prefix("--cutoff=") {
            if let Ok(n) = v.parse::<f32>() {
                thermal_cutoff_c = clamp_gpu_thermal_cutoff(n);
            }
        } else if let Some(v) = arg.strip_prefix("--scene=") {
            scene_arg = v.to_lowercase();
        }
    }

    let (target_w, target_h, canonical_res) = match res_label.as_str() {
        "4k" | "2160p" => (3840, 2160, "3840x2160 (4K)"),
        "1440p" | "2k" => (2560, 1440, "2560x1440 (1440p)"),
        "720p" => (1280, 720, "1280x720 (720p)"),
        _ => (1920, 1080, "1920x1080 (1080p)"),
    };

    let scene_indices = match scene_arg.as_str() {
        "0" | "furmark" | "native_furmark" => vec![0],
        "1" | "pathtrace" | "native_pathtrace" => vec![1],
        "2" | "canyon" | "native_canyon" => vec![2],
        "3" | "particles" | "native_particles" => vec![3],
        _ => vec![0, 1, 2, 3],
    };

    CliConfig {
        res_label: canonical_res.to_string(),
        target_w,
        target_h,
        secs_per_scene,
        adapter_index,
        thermal_cutoff_c,
        scene_indices,
    }
}

fn init_particles(count: u32) -> Vec<ParticleVertex> {
    let mut out = Vec::with_capacity(count as usize);
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next_f = || -> f32 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 40) as f32) / 16_777_216.0
    };
    for i in 0..count {
        let arm = (i % 3) as f32 * 2.0943951;
        let r = 0.14 + next_f().sqrt() * 0.92;
        let theta = arm + r * 3.8 + (next_f() - 0.5) * 0.55;
        let x = theta.cos() * r;
        let y = theta.sin() * r * 0.85;
        let vx = -theta.sin() * (0.45 + 0.35 * (1.0 - r));
        let vy = theta.cos() * (0.45 + 0.35 * (1.0 - r));
        out.push(ParticleVertex {
            pos: [x, y],
            vel: [vx, vy],
        });
    }
    out
}

fn compute_frame_percentiles(frame_ms: &[f64]) -> (f64, f64, f64, f64) {
    if frame_ms.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let clean: Vec<f64> = frame_ms.iter().map(|d| d.clamp(0.05, 500.0)).collect();
    let avg_ms = clean.iter().sum::<f64>() / clean.len() as f64;
    let mut sorted = clean;
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let n1 = ((sorted.len() as f64 * 0.01).ceil() as usize).clamp(1, sorted.len());
    let avg_1_ms = sorted[..n1].iter().sum::<f64>() / n1 as f64;
    let n01 = ((sorted.len() as f64 * 0.001).ceil() as usize).clamp(1, sorted.len());
    let avg_01_ms = sorted[..n01].iter().sum::<f64>() / n01 as f64;
    (
        (1000.0 / avg_ms.max(0.05) * 10.0).round() / 10.0,
        (1000.0 / avg_1_ms.max(0.05) * 10.0).round() / 10.0,
        (1000.0 / avg_01_ms.max(0.05) * 10.0).round() / 10.0,
        (avg_ms * 100.0).round() / 100.0,
    )
}

fn classify_native_3d_tier(avg_fps: f64, target_h: u32) -> &'static str {
    let scale = match target_h {
        h if h >= 2160 => 3.5,
        h if h >= 1440 => 1.75,
        _ => 1.0,
    };
    let eq_1080 = avg_fps * scale;
    if eq_1080 >= 220.0 {
        "Flagship RTX / Workstation dGPU"
    } else if eq_1080 >= 115.0 {
        "Performance Gaming dGPU"
    } else if eq_1080 >= 55.0 {
        "Mainstream dGPU / High-End iGPU"
    } else if eq_1080 >= 24.0 {
        "Ultrabook Integrated GPU"
    } else {
        "Entry / Low-Power Graphics"
    }
}

// ---------- Compact 5x7 Bitmap Font for Live On-Screen Native GPU HUD ----------
fn glyph_5x7(ch: char) -> [u8; 7] {
    match ch.to_ascii_uppercase() {
        'A' => [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'B' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
        'C' => [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
        'D' => [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
        'E' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
        'F' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
        'G' => [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
        'H' => [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'I' => [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        'J' => [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
        'K' => [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
        'L' => [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
        'M' => [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
        'N' => [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
        'O' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        'P' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
        'Q' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
        'R' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
        'S' => [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
        'T' => [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
        'U' => [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        'V' => [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
        'W' => [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
        'X' => [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
        'Y' => [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
        'Z' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
        '0' => [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        '2' => [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
        '3' => [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
        '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        '5' => [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        '6' => [0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110],
        '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
        '.' => [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
        ':' => [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000],
        '/' => [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
        '-' => [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
        '|' => [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
        '%' => [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
        '(' => [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
        ')' => [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
        '+' => [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
        _ => [0; 7],
    }
}

fn draw_hud_text(buf: &mut [u8], x0: i32, y0: i32, scale: i32, text: &str, rgba: [u8; 4]) {
    let mut cx = x0;
    for ch in text.chars() {
        let g = glyph_5x7(ch);
        for (ry, row) in g.iter().enumerate() {
            for rx in 0..5 {
                if (row & (1 << (4 - rx))) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            let px = cx + rx * scale + sx;
                            let py = y0 + (ry as i32) * scale + sy;
                            if px >= 0 && px < HUD_W as i32 && py >= 0 && py < HUD_H as i32 {
                                let idx = ((py as u32 * HUD_W + px as u32) * 4) as usize;
                                buf[idx] = rgba[0];
                                buf[idx + 1] = rgba[1];
                                buf[idx + 2] = rgba[2];
                                buf[idx + 3] = rgba[3];
                            }
                        }
                    }
                }
            }
        }
        cx += 6 * scale;
    }
}

fn rasterize_hud(
    buf: &mut [u8],
    line1: &str,
    line2: &str,
    spark_ms: &[f64],
    progress_frac: f64,
) {
    // Dark translucent Swiss HUD bar background
    for y in 0..HUD_H {
        let is_border = y >= HUD_H - 2;
        let prog_x = (progress_frac.clamp(0.0, 1.0) * HUD_W as f64) as u32;
        for x in 0..HUD_W {
            let idx = ((y * HUD_W + x) * 4) as usize;
            if is_border {
                if x <= prog_x {
                    buf[idx] = 37;
                    buf[idx + 1] = 99;
                    buf[idx + 2] = 235;
                    buf[idx + 3] = 255;
                } else {
                    buf[idx] = 45;
                    buf[idx + 1] = 52;
                    buf[idx + 2] = 68;
                    buf[idx + 3] = 220;
                }
            } else {
                buf[idx] = 9;
                buf[idx + 1] = 11;
                buf[idx + 2] = 16;
                buf[idx + 3] = 212;
            }
        }
    }

    // Top row: Scene + Uncapped FPS + Telemetry
    draw_hud_text(buf, 18, 12, 2, line1, [248, 250, 252, 255]);
    // Bottom row: Controls + Resolution + Backend
    draw_hud_text(buf, 18, 42, 2, line2, [147, 197, 253, 255]);

    // Right-side Frame-Time Sparkline (x = 1090..1260, y = 12..58)
    let gx0 = 1090u32;
    let gw = 170u32;
    let gy0 = 12u32;
    let gh = 46u32;
    for y in gy0..gy0 + gh {
        for x in gx0..gx0 + gw {
            let idx = ((y * HUD_W + x) * 4) as usize;
            buf[idx] = 18;
            buf[idx + 1] = 24;
            buf[idx + 2] = 38;
            buf[idx + 3] = 230;
        }
    }
    if spark_ms.len() > 1 {
        let len = spark_ms.len();
        for (i, &ms) in spark_ms.iter().enumerate() {
            let bx = gx0 + ((i as u32 * gw) / len as u32).min(gw - 1);
            let norm = (ms / 36.0).clamp(0.05, 1.0);
            let bar_h = (norm * (gh as f64 - 4.0)) as u32;
            let by_start = gy0 + gh - 2 - bar_h;
            for y in by_start..(gy0 + gh - 2) {
                let idx = ((y * HUD_W + bx) * 4) as usize;
                buf[idx] = 59;
                buf[idx + 1] = 130;
                buf[idx + 2] = 246;
                buf[idx + 3] = 255;
            }
        }
    }
}

fn capture_native_preview_jpeg(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    suite_shader: &wgpu::ShaderModule,
    scene_mode: u32,
) -> Option<String> {
    let w = 640u32;
    let h = 360u32;
    let uniform = SuiteUniforms {
        resolution: [w as f32, h as f32],
        time: 4.2,
        scene_mode,
        cam_yaw: 0.25,
        cam_pitch: 0.14,
        cam_zoom: 1.0,
        stress_mult: 1.0,
    };
    let ubuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Preview Uniform"),
        contents: bytemuck::cast_slice(&[uniform]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Preview BGL"),
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
        label: Some("Preview BG"),
        layout: &bgl,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: ubuf.as_entire_binding(),
        }],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Preview PL"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Preview Pipe"),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: suite_shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: suite_shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
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

    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Preview Tex"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    let unpadded = w * 4;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded = ((unpadded + align - 1) / align) * align;
    let read_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Preview Readback"),
        size: (padded * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut rpass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Preview Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
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
        rpass.set_pipeline(&pipe);
        rpass.set_bind_group(0, &bg, &[]);
        rpass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &read_buf,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(enc.finish()));
    device.poll(wgpu::Maintain::Wait);

    let slice = read_buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::Maintain::Wait);
    if rx.recv().ok()?.is_err() {
        return None;
    }
    let mapped = slice.get_mapped_range();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h as usize {
        let row_off = y * padded as usize;
        for x in 0..w as usize {
            let px = row_off + x * 4;
            rgb.push(mapped[px]);
            rgb.push(mapped[px + 1]);
            rgb.push(mapped[px + 2]);
        }
    }
    drop(mapped);
    read_buf.unmap();

    let mut jpeg_bytes = Vec::new();
    let mut enc_jpg = JpegEncoder::new_with_quality(&mut jpeg_bytes, 84);
    enc_jpg.encode(&rgb, w, h, ColorType::Rgb8.into()).ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(jpeg_bytes)))
}

struct NativeGpuState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    adapter_name: String,
    backend_name: String,
    present_mode_name: String,
    suite_shader: wgpu::ShaderModule,
    suite_pipe: wgpu::RenderPipeline,
    suite_uniform_buf: wgpu::Buffer,
    suite_bg: wgpu::BindGroup,
    part_compute_pipe: wgpu::ComputePipeline,
    part_render_pipe: wgpu::RenderPipeline,
    part_uniform_buf: wgpu::Buffer,
    part_buf: wgpu::Buffer,
    part_compute_bg: wgpu::BindGroup,
    part_render_bg: wgpu::BindGroup,
    hud_pipe: wgpu::RenderPipeline,
    hud_tex: wgpu::Texture,
    hud_bg: wgpu::BindGroup,
    hud_rgba: Vec<u8>,
    alu_pipe: wgpu::ComputePipeline,
    alu_param_buf: wgpu::Buffer,
    alu_err_buf: wgpu::Buffer,
    alu_read_buf: wgpu::Buffer,
    alu_bg: wgpu::BindGroup,
}

impl NativeGpuState {
    fn new(window: Arc<Window>, cli: &CliConfig) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });
        let surface = instance
            .create_surface(window.clone())
            .map_err(|e| format!("Failed to create native wgpu surface: {}", e))?;

        let mut adapters: Vec<wgpu::Adapter> = instance
            .enumerate_adapters(wgpu::Backends::PRIMARY)
            .into_iter()
            .filter(|a| a.is_surface_supported(&surface))
            .collect();
        if adapters.is_empty() {
            return Err("No hardware GPU adapter supports the native fullscreen surface.".into());
        }
        let chosen_idx = match cli.adapter_index {
            Some(idx) if idx < adapters.len() => idx,
            _ => adapters
                .iter()
                .position(|a| a.get_info().device_type == wgpu::DeviceType::DiscreteGpu)
                .unwrap_or(0),
        };
        let adapter = adapters.swap_remove(chosen_idx);
        let info = adapter.get_info();
        let adapter_name = info.name.clone();
        let backend_name = format!("{:?}", info.backend);

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("LaptopBench Native 3D Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|e| format!("Failed to open native GPU device: {}", e))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);

        // ZERO VSync cap: prefer Immediate -> Mailbox -> AutoNoVsync -> Fifo
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Immediate) {
            wgpu::PresentMode::Immediate
        } else if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else if caps.present_modes.contains(&wgpu::PresentMode::AutoNoVsync) {
            wgpu::PresentMode::AutoNoVsync
        } else {
            wgpu::PresentMode::Fifo
        };
        let present_mode_name = format!("{:?}", present_mode);

        let size = window.inner_size();
        let surf_w = cli.target_w.min(adapter.limits().max_texture_dimension_2d).max(size.width.max(640));
        let surf_h = cli.target_h.min(adapter.limits().max_texture_dimension_2d).max(size.height.max(400));
        // Respect selected target resolution (or exact window surface size if smaller/larger)
        let cfg_w = if cli.target_w > 0 { cli.target_w.min(adapter.limits().max_texture_dimension_2d) } else { surf_w };
        let cfg_h = if cli.target_h > 0 { cli.target_h.min(adapter.limits().max_texture_dimension_2d) } else { surf_h };

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: cfg_w.max(640),
            height: cfg_h.max(400),
            present_mode,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 1,
        };
        surface.configure(&device, &config);

        // --- Pipeline 1: Fullscreen 3D Suite (FurMark / PathTrace / Canyon) ---
        let suite_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native 3D Suite WGSL"),
            source: wgpu::ShaderSource::Wgsl(SUITE_SHADER_WGSL.into()),
        });
        let suite_uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Suite Uniforms"),
            contents: bytemuck::cast_slice(&[SuiteUniforms {
                resolution: [config.width as f32, config.height as f32],
                time: 0.0,
                scene_mode: 0,
                cam_yaw: 0.0,
                cam_pitch: 0.0,
                cam_zoom: 1.0,
                stress_mult: if info.device_type == wgpu::DeviceType::DiscreteGpu { 1.25 } else { 1.0 },
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let suite_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Suite BGL"),
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
        let suite_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Suite BG"),
            layout: &suite_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: suite_uniform_buf.as_entire_binding(),
            }],
        });
        let suite_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Suite PL"),
            bind_group_layouts: &[&suite_bgl],
            push_constant_ranges: &[],
        });
        let suite_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Suite Pipeline"),
            layout: Some(&suite_pl),
            vertex: wgpu::VertexState {
                module: &suite_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &suite_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
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

        // --- Pipeline 2: 500,000-Particle GPU Compute Flocking & Vortex ---
        let part_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native Particles WGSL"),
            source: wgpu::ShaderSource::Wgsl(PARTICLES_SHADER_WGSL.into()),
        });
        let part_uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Particle Uniforms"),
            contents: bytemuck::cast_slice(&[ParticleUniforms {
                time: 0.0,
                dt: 0.016,
                aspect: config.width as f32 / config.height.max(1) as f32,
                particle_count: PARTICLE_COUNT,
                attractor_x: 0.0,
                attractor_y: 0.0,
                zoom: 1.0,
                _pad: 0.0,
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let init_data = init_particles(PARTICLE_COUNT);
        let part_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("500K Particle Storage"),
            contents: bytemuck::cast_slice(&init_data),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::VERTEX,
        });
        let part_comp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Particle Comp BGL"),
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
            ],
        });
        let part_compute_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Particle Comp BG"),
            layout: &part_comp_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: part_uniform_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: part_buf.as_entire_binding(),
                },
            ],
        });
        let part_comp_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Particle Comp PL"),
            bind_group_layouts: &[&part_comp_bgl],
            push_constant_ranges: &[],
        });
        let part_compute_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Particle Compute Pipe"),
            layout: Some(&part_comp_pl),
            module: &part_shader,
            entry_point: Some("cs_particles"),
            compilation_options: Default::default(),
            cache: None,
        });

        let part_rend_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Particle Render BGL"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let part_render_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Particle Render BG"),
            layout: &part_rend_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: part_uniform_buf.as_entire_binding(),
            }],
        });
        let part_rend_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Particle Render PL"),
            bind_group_layouts: &[&part_rend_bgl],
            push_constant_ranges: &[],
        });
        let part_render_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Particle Render Pipe"),
            layout: Some(&part_rend_pl),
            vertex: wgpu::VertexState {
                module: &part_shader,
                entry_point: Some("vs_particle"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<ParticleVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 8,
                            shader_location: 1,
                        },
                    ],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &part_shader,
                entry_point: Some("fs_particle"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent::OVER,
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::PointList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // --- Pipeline 3: Native GPU HUD Overlay ---
        let hud_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native HUD WGSL"),
            source: wgpu::ShaderSource::Wgsl(HUD_SHADER_WGSL.into()),
        });
        let hud_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Native HUD Texture"),
            size: wgpu::Extent3d {
                width: HUD_W,
                height: HUD_H,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let hud_view = hud_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let hud_samp = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let hud_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("HUD BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let hud_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("HUD BG"),
            layout: &hud_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&hud_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&hud_samp),
                },
            ],
        });
        let hud_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("HUD PL"),
            bind_group_layouts: &[&hud_bgl],
            push_constant_ranges: &[],
        });
        let hud_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("HUD Pipeline"),
            layout: Some(&hud_pl),
            vertex: wgpu::VertexState {
                module: &hud_shader,
                entry_point: Some("vs_hud"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &hud_shader,
                entry_point: Some("fs_hud"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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

        // --- Pipeline 4: Hardware ALU Artifact Canary ---
        let alu_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ALU Canary WGSL"),
            source: wgpu::ShaderSource::Wgsl(ALU_CANARY_WGSL.into()),
        });
        let alu_param_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("ALU Canary Params"),
            contents: bytemuck::cast_slice(&[AluCanaryParams {
                seed: 0x2468_ACE1,
                pattern_mode: 0,
                word_count: 65_536,
                _pad: 0,
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let alu_err_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("ALU Err"),
            contents: bytemuck::cast_slice(&[0u32]),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        });
        let alu_read_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("ALU Read"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let alu_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ALU BGL"),
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
            ],
        });
        let alu_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ALU BG"),
            layout: &alu_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: alu_param_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: alu_err_buf.as_entire_binding(),
                },
            ],
        });
        let alu_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ALU PL"),
            bind_group_layouts: &[&alu_bgl],
            push_constant_ranges: &[],
        });
        let alu_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("ALU Pipe"),
            layout: Some(&alu_pl),
            module: &alu_shader,
            entry_point: Some("cs_alu_verify"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            window,
            surface,
            device,
            queue,
            config,
            adapter_name,
            backend_name,
            present_mode_name,
            suite_shader,
            suite_pipe,
            suite_uniform_buf,
            suite_bg,
            part_compute_pipe,
            part_render_pipe,
            part_uniform_buf,
            part_buf,
            part_compute_bg,
            part_render_bg,
            hud_pipe,
            hud_tex,
            hud_bg,
            hud_rgba: vec![0u8; (HUD_W * HUD_H * 4) as usize],
            alu_pipe,
            alu_param_buf,
            alu_err_buf,
            alu_read_buf,
            alu_bg,
        })
    }

    fn run_alu_canary(&self, seed: u32) -> u64 {
        self.queue.write_buffer(&self.alu_err_buf, 0, bytemuck::cast_slice(&[0u32]));
        self.queue.write_buffer(
            &self.alu_param_buf,
            0,
            bytemuck::cast_slice(&[AluCanaryParams {
                seed,
                pattern_mode: 0,
                word_count: 65_536,
                _pad: 0,
            }]),
        );
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            cpass.set_pipeline(&self.alu_pipe);
            cpass.set_bind_group(0, &self.alu_bg, &[]);
            cpass.dispatch_workgroups(256, 1, 1);
        }
        enc.copy_buffer_to_buffer(&self.alu_err_buf, 0, &self.alu_read_buf, 0, 4);
        self.queue.submit(Some(enc.finish()));
        self.device.poll(wgpu::Maintain::Wait);
        let slice = self.alu_read_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device.poll(wgpu::Maintain::Wait);
        let errs = if rx.recv().ok().and_then(|r| r.ok()).is_some() {
            let d = slice.get_mapped_range();
            let v = u32::from_le_bytes([d[0], d[1], d[2], d[3]]) as u64;
            drop(d);
            self.alu_read_buf.unmap();
            v
        } else {
            0
        };
        errs
    }
}

struct NativeBenchApp {
    cli: CliConfig,
    gpu: Option<NativeGpuState>,
    init_error: Option<String>,
    shared_tel: Arc<Mutex<SharedGpuTelemetry>>,
    stop_tel: Arc<AtomicBool>,
    suite_started: Instant,
    scene_pos: usize,
    scene_started: Instant,
    last_frame: Instant,
    last_hud_update: Instant,
    last_canary: Instant,
    frame_times_ms: Vec<f64>,
    spark_ms: Vec<f64>,
    scene_artifacts: u64,
    completed_scenes: Vec<Native3dSceneScore>,
    cancelled: bool,
    thermal_cutoff: bool,
    preview_data_url: Option<String>,
    // Interactive Free-Cam & Cursor Attractor
    cam_yaw: f32,
    cam_pitch: f32,
    cam_zoom: f32,
    dragging: bool,
    last_cursor: Option<(f64, f64)>,
    attractor: (f32, f32),
    keys_held: [bool; 4], // W, A, S, D
}

impl NativeBenchApp {
    fn new(cli: CliConfig, shared_tel: Arc<Mutex<SharedGpuTelemetry>>, stop_tel: Arc<AtomicBool>) -> Self {
        let now = Instant::now();
        Self {
            cli,
            gpu: None,
            init_error: None,
            shared_tel,
            stop_tel,
            suite_started: now,
            scene_pos: 0,
            scene_started: now,
            last_frame: now,
            last_hud_update: now - Duration::from_secs(1),
            last_canary: now,
            frame_times_ms: Vec::with_capacity(4096),
            spark_ms: Vec::with_capacity(100),
            scene_artifacts: 0,
            completed_scenes: Vec::new(),
            cancelled: false,
            thermal_cutoff: false,
            preview_data_url: None,
            cam_yaw: 0.0,
            cam_pitch: 0.0,
            cam_zoom: 1.0,
            dragging: false,
            last_cursor: None,
            attractor: (0.0, 0.0),
            keys_held: [false; 4],
        }
    }

    fn finalize_current_scene(&mut self) {
        if self.scene_pos >= self.cli.scene_indices.len() {
            return;
        }
        let sc = NATIVE_SCENES[self.cli.scene_indices[self.scene_pos]];
        let (avg_fps, low1, low01, avg_ms) = compute_frame_percentiles(&self.frame_times_ms);
        let tel = self.shared_tel.lock().ok().map(|g| g.clone()).unwrap_or_default();
        let res_scale = match self.cli.target_h {
            h if h >= 2160 => 3.5,
            h if h >= 1440 => 1.75,
            _ => 1.0,
        };
        let score = ((avg_fps * 72.0 + low1 * 28.0) * res_scale).round().max(50.0) as u64;
        let status = if self.scene_artifacts > 0 || self.thermal_cutoff {
            TestStatus::Fail
        } else if avg_fps < 12.0 {
            TestStatus::Warn
        } else {
            TestStatus::Pass
        };
        let frames = self.frame_times_ms.len() as u64;
        self.completed_scenes.retain(|s| s.id != sc.id);
        self.completed_scenes.push(Native3dSceneScore {
            id: sc.id.to_string(),
            name: sc.name.to_string(),
            avg_fps,
            low_1pct_fps: low1,
            low_01pct_fps: low01,
            avg_frame_ms: avg_ms,
            frames_rendered: frames,
            peak_temp_c: tel.peak_temp_c,
            peak_power_w: tel.peak_power_w,
            artifact_errors: self.scene_artifacts,
            score,
            status,
        });

        // Capture preview image once cleanly using Scene 1 (Path-Traced PBR) or Scene 0 (FurMark)
        if self.preview_data_url.is_none() && (sc.mode == 1 || sc.mode == 0) {
            if let Some(gpu) = &self.gpu {
                self.preview_data_url = capture_native_preview_jpeg(
                    &gpu.device,
                    &gpu.queue,
                    &gpu.suite_shader,
                    sc.mode,
                );
            }
        }
    }

    fn switch_scene(&mut self, next_pos: usize, event_loop: &ActiveEventLoop) {
        self.finalize_current_scene();
        if next_pos >= self.cli.scene_indices.len() {
            self.stop_tel.store(true, Ordering::SeqCst);
            event_loop.exit();
            return;
        }
        self.scene_pos = next_pos;
        self.scene_started = Instant::now();
        self.last_frame = Instant::now();
        self.frame_times_ms.clear();
        self.spark_ms.clear();
        self.scene_artifacts = 0;
        self.cam_yaw = 0.0;
        self.cam_pitch = 0.0;
        self.cam_zoom = 1.0;
    }

    fn build_result(&self) -> Native3dSuiteResult {
        let tel = self.shared_tel.lock().ok().map(|g| g.clone()).unwrap_or_default();
        let (adapter_name, backend, present_mode) = match &self.gpu {
            Some(g) => (g.adapter_name.clone(), g.backend_name.clone(), g.present_mode_name.clone()),
            None => ("Unknown GPU".into(), "Unknown".into(), "Unknown".into()),
        };
        let n = self.completed_scenes.len().max(1) as f64;
        let avg_fps = (self.completed_scenes.iter().map(|s| s.avg_fps).sum::<f64>() / n * 10.0).round() / 10.0;
        let low_1pct_fps = (self.completed_scenes.iter().map(|s| s.low_1pct_fps).sum::<f64>() / n * 10.0).round() / 10.0;
        let composite_score = (self.completed_scenes.iter().map(|s| s.score).sum::<u64>() as f64 / n).round() as u64;
        let total_artifacts: u64 = self.completed_scenes.iter().map(|s| s.artifact_errors).sum();
        let tier = classify_native_3d_tier(avg_fps, self.cli.target_h).to_string();
        let status = if total_artifacts > 0 || self.thermal_cutoff {
            TestStatus::Fail
        } else if self.cancelled || avg_fps < 15.0 {
            TestStatus::Warn
        } else {
            TestStatus::Pass
        };
        let elapsed_secs = (self.suite_started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
        let temp_txt = tel
            .peak_temp_c
            .map(|t| format!(" | Peak {:.0}C", t))
            .unwrap_or_default();
        let power_txt = tel
            .peak_power_w
            .map(|w| format!(" | {:.0}W", w))
            .unwrap_or_default();
        let summary = format!(
            "Native {} {} ({}): {:.1} FPS avg ({:.1} 1% Low) | Score {} | {} | {} artifacts{}{}",
            backend,
            self.cli.res_label,
            present_mode,
            avg_fps,
            low_1pct_fps,
            composite_score,
            tier,
            total_artifacts,
            temp_txt,
            power_txt
        );
        let plain_summary = if total_artifacts > 0 {
            format!(
                "FAIL: {} hardware GPU calculation/artifact error(s) detected on {} during native {} stress!",
                total_artifacts, adapter_name, backend
            )
        } else if self.thermal_cutoff {
            format!(
                "THERMAL CUTOFF: {} exceeded safe temperature limit ({:.0}C) during native {} 3D load.",
                adapter_name, self.cli.thermal_cutoff_c, backend
            )
        } else {
            format!(
                "{} ran native uncapped {} 3D at {:.1} FPS avg ({:.1} 1% Low) in {} ({} tier, 0 artifacts).",
                adapter_name, backend, avg_fps, low_1pct_fps, self.cli.res_label, tier
            )
        };

        Native3dSuiteResult {
            status,
            adapter_name,
            backend,
            present_mode,
            resolution: self.cli.res_label.clone(),
            composite_score,
            avg_fps,
            low_1pct_fps,
            peak_temp_c: tel.peak_temp_c,
            peak_power_w: tel.peak_power_w,
            artifact_errors: total_artifacts,
            thermal_cutoff_triggered: self.thermal_cutoff,
            cancelled: self.cancelled,
            elapsed_secs,
            tier,
            scenes: self.completed_scenes.clone(),
            preview_data_url: self.preview_data_url.clone(),
            summary,
            plain_summary,
        }
    }
}

impl ApplicationHandler for NativeBenchApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gpu.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("LaptopBench QC v3.5.0 — Native Uncapped DX12/Vulkan/Metal 3D Suite")
            .with_fullscreen(Some(Fullscreen::Borderless(None)))
            .with_inner_size(PhysicalSize::new(self.cli.target_w, self.cli.target_h));
        match event_loop.create_window(attrs) {
            Ok(win) => {
                let win = Arc::new(win);
                match NativeGpuState::new(win.clone(), &self.cli) {
                    Ok(state) => {
                        self.gpu = Some(state);
                        self.suite_started = Instant::now();
                        self.scene_started = Instant::now();
                        self.last_frame = Instant::now();
                        win.request_redraw();
                    }
                    Err(e) => {
                        self.init_error = Some(e);
                        self.stop_tel.store(true, Ordering::SeqCst);
                        event_loop.exit();
                    }
                }
            }
            Err(e) => {
                self.init_error = Some(format!("Failed to create native fullscreen window: {}", e));
                self.stop_tel.store(true, Ordering::SeqCst);
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.cancelled = true;
                self.finalize_current_scene();
                self.stop_tel.store(true, Ordering::SeqCst);
                event_loop.exit();
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        physical_key: PhysicalKey::Code(code),
                        state,
                        ..
                    },
                ..
            } => {
                let pressed = state == ElementState::Pressed;
                match code {
                    KeyCode::KeyW => self.keys_held[0] = pressed,
                    KeyCode::KeyA => self.keys_held[1] = pressed,
                    KeyCode::KeyS => self.keys_held[2] = pressed,
                    KeyCode::KeyD => self.keys_held[3] = pressed,
                    KeyCode::Escape | KeyCode::KeyQ if pressed => {
                        self.cancelled = true;
                        self.finalize_current_scene();
                        self.stop_tel.store(true, Ordering::SeqCst);
                        event_loop.exit();
                    }
                    KeyCode::KeyN | KeyCode::ArrowRight | KeyCode::Space if pressed => {
                        self.switch_scene(self.scene_pos + 1, event_loop);
                    }
                    KeyCode::KeyP | KeyCode::ArrowLeft if pressed => {
                        let prev = self.scene_pos.saturating_sub(1);
                        self.switch_scene(prev, event_loop);
                    }
                    _ => {}
                }
            }
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                self.dragging = state == ElementState::Pressed;
                if !self.dragging {
                    self.last_cursor = None;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(gpu) = &self.gpu {
                    let sz = gpu.window.inner_size();
                    let nx = ((position.x as f32 / sz.width.max(1) as f32) - 0.5) * 2.0;
                    let ny = (0.5 - (position.y as f32 / sz.height.max(1) as f32)) * 2.0;
                    self.attractor = (nx, ny);
                }
                if self.dragging {
                    if let Some((lx, ly)) = self.last_cursor {
                        self.cam_yaw += ((position.x - lx) as f32) * 0.0055;
                        self.cam_pitch = (self.cam_pitch + ((position.y - ly) as f32) * 0.0045).clamp(-0.9, 0.9);
                    }
                    self.last_cursor = Some((position.x, position.y));
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => p.y as f32 * 0.02,
                };
                self.cam_zoom = (self.cam_zoom * (1.0 + dy * 0.08)).clamp(0.45, 2.5);
            }
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt_secs = (now - self.last_frame).as_secs_f64().clamp(0.0001, 0.25);
                self.last_frame = now;
                let dt_ms = dt_secs * 1000.0;
                self.frame_times_ms.push(dt_ms);
                self.spark_ms.push(dt_ms);
                if self.spark_ms.len() > 85 {
                    self.spark_ms.remove(0);
                }

                // WASD Free-Cam motion
                let move_s = dt_secs as f32 * 1.4;
                if self.keys_held[0] {
                    self.cam_zoom = (self.cam_zoom + move_s * 0.5).clamp(0.45, 2.5);
                }
                if self.keys_held[2] {
                    self.cam_zoom = (self.cam_zoom - move_s * 0.5).clamp(0.45, 2.5);
                }
                if self.keys_held[1] {
                    self.cam_yaw -= move_s;
                }
                if self.keys_held[3] {
                    self.cam_yaw += move_s;
                }

                // Check thermal cutoff from telemetry thread
                let cutoff_hit = self
                    .shared_tel
                    .lock()
                    .map(|tel| tel.cutoff_triggered)
                    .unwrap_or(false);
                if cutoff_hit {
                    self.thermal_cutoff = true;
                    self.finalize_current_scene();
                    self.stop_tel.store(true, Ordering::SeqCst);
                    event_loop.exit();
                    return;
                }

                let scene_elapsed = self.scene_started.elapsed().as_secs_f64();
                if scene_elapsed >= self.cli.secs_per_scene {
                    self.switch_scene(self.scene_pos + 1, event_loop);
                    return;
                }

                let sc = NATIVE_SCENES[self.cli.scene_indices[self.scene_pos]];

                if let Some(gpu) = &mut self.gpu {
                    // Periodic hardware ALU artifact check during FurMark scene
                    if sc.mode == 0 && self.last_canary.elapsed() >= Duration::from_millis(1600) {
                        self.last_canary = Instant::now();
                        let errs = gpu.run_alu_canary((scene_elapsed * 1000.0) as u32);
                        self.scene_artifacts = self.scene_artifacts.saturating_add(errs);
                    }

                    // Update GPU HUD bitmap every ~110ms
                    if self.last_hud_update.elapsed() >= Duration::from_millis(110) {
                        self.last_hud_update = Instant::now();
                        let tail_start = self.frame_times_ms.len().saturating_sub(180);
                        let (fps, low1, low01, avg_ms) = compute_frame_percentiles(&self.frame_times_ms[tail_start..]);
                        let tel = self.shared_tel.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let temp_s = tel.temp_c.map(|t| format!("{:.0}C", t)).unwrap_or_else(|| "N/A".into());
                        let pwr_s = tel.power_w.map(|w| format!("{:.0}W", w)).unwrap_or_else(|| "--W".into());
                        let load_s = tel.load_pct.map(|l| format!("{:.0}%", l)).unwrap_or_else(|| "--%".into());
                        let rem = (self.cli.secs_per_scene - scene_elapsed).max(0.0);
                        let line1 = format!(
                            "{:02}/{:02} {} | {:.1} FPS (1%L {:.1} 0.1%L {:.1}) {:.1}MS | GPU {} {} {} | ERR {}",
                            self.scene_pos + 1,
                            self.cli.scene_indices.len(),
                            sc.short,
                            fps,
                            low1,
                            low01,
                            avg_ms,
                            temp_s,
                            load_s,
                            pwr_s,
                            self.scene_artifacts
                        );
                        let line2 = format!(
                            "{} {} ({}) | REM {:.1}S | ESC:EXIT  N/P:NEXT/PREV  DRAG/WASD/WHEEL:CAM",
                            gpu.backend_name.to_uppercase(),
                            self.cli.res_label.to_uppercase(),
                            gpu.present_mode_name.to_uppercase(),
                            rem
                        );
                        rasterize_hud(
                            &mut gpu.hud_rgba,
                            &line1,
                            &line2,
                            &self.spark_ms,
                            scene_elapsed / self.cli.secs_per_scene.max(1.0),
                        );
                        gpu.queue.write_texture(
                            wgpu::TexelCopyTextureInfo {
                                texture: &gpu.hud_tex,
                                mip_level: 0,
                                origin: wgpu::Origin3d::ZERO,
                                aspect: wgpu::TextureAspect::All,
                            },
                            &gpu.hud_rgba,
                            wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(HUD_W * 4),
                                rows_per_image: Some(HUD_H),
                            },
                            wgpu::Extent3d {
                                width: HUD_W,
                                height: HUD_H,
                                depth_or_array_layers: 1,
                            },
                        );
                    }

                    // Render frame to uncapped native surface
                    let frame = match gpu.surface.get_current_texture() {
                        Ok(f) => f,
                        Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                            gpu.surface.configure(&gpu.device, &gpu.config);
                            gpu.window.request_redraw();
                            return;
                        }
                        Err(_) => {
                            gpu.window.request_redraw();
                            return;
                        }
                    };
                    let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
                    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

                    if sc.mode == 3 {
                        // Scene 3: 500,000-Particle GPU Compute + Additive HDR Render
                        gpu.queue.write_buffer(
                            &gpu.part_uniform_buf,
                            0,
                            bytemuck::cast_slice(&[ParticleUniforms {
                                time: scene_elapsed as f32,
                                dt: dt_secs as f32,
                                aspect: gpu.config.width as f32 / gpu.config.height.max(1) as f32,
                                particle_count: PARTICLE_COUNT,
                                attractor_x: self.attractor.0,
                                attractor_y: self.attractor.1,
                                zoom: self.cam_zoom,
                                _pad: 0.0,
                            }]),
                        );
                        {
                            let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                            cpass.set_pipeline(&gpu.part_compute_pipe);
                            cpass.set_bind_group(0, &gpu.part_compute_bg, &[]);
                            cpass.dispatch_workgroups((PARTICLE_COUNT + 255) / 256, 1, 1);
                        }
                        {
                            let mut rpass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                                label: Some("Particles Render Pass"),
                                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                    view: &view,
                                    resolve_target: None,
                                    ops: wgpu::Operations {
                                        load: wgpu::LoadOp::Clear(wgpu::Color {
                                            r: 0.012,
                                            g: 0.016,
                                            b: 0.032,
                                            a: 1.0,
                                        }),
                                        store: wgpu::StoreOp::Store,
                                    },
                                })],
                                depth_stencil_attachment: None,
                                occlusion_query_set: None,
                                timestamp_writes: None,
                            });
                            rpass.set_pipeline(&gpu.part_render_pipe);
                            rpass.set_bind_group(0, &gpu.part_render_bg, &[]);
                            rpass.set_vertex_buffer(0, gpu.part_buf.slice(..));
                            rpass.draw(0..PARTICLE_COUNT, 0..1);
                            // Top HUD overlay
                            rpass.set_pipeline(&gpu.hud_pipe);
                            rpass.set_bind_group(0, &gpu.hud_bg, &[]);
                            rpass.draw(0..6, 0..1);
                        }
                    } else {
                        // Scenes 0, 1, 2: Native Fullscreen Fragment Raymarching / Path-Tracing
                        gpu.queue.write_buffer(
                            &gpu.suite_uniform_buf,
                            0,
                            bytemuck::cast_slice(&[SuiteUniforms {
                                resolution: [gpu.config.width as f32, gpu.config.height as f32],
                                time: scene_elapsed as f32,
                                scene_mode: sc.mode,
                                cam_yaw: self.cam_yaw,
                                cam_pitch: self.cam_pitch,
                                cam_zoom: self.cam_zoom,
                                stress_mult: 1.15,
                            }]),
                        );
                        {
                            let mut rpass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                                label: Some("Suite Render Pass"),
                                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                    view: &view,
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
                            rpass.set_pipeline(&gpu.suite_pipe);
                            rpass.set_bind_group(0, &gpu.suite_bg, &[]);
                            rpass.draw(0..3, 0..1);
                            // Top HUD overlay
                            rpass.set_pipeline(&gpu.hud_pipe);
                            rpass.set_bind_group(0, &gpu.hud_bg, &[]);
                            rpass.draw(0..6, 0..1);
                        }
                    }

                    gpu.queue.submit(Some(enc.finish()));
                    frame.present();
                    gpu.window.request_redraw();
                }
            }
            _ => {}
        }
    }
}

/// Entrypoint invoked when `laptopbench-qc --native-3d-bench ...` runs in its own native fullscreen process.
pub fn run_native_3d_bench_cli(args: &[String]) -> Result<(), String> {
    let cli = parse_cli_config(args);
    let shared_tel = Arc::new(Mutex::new(SharedGpuTelemetry::default()));
    let stop_tel = Arc::new(AtomicBool::new(false));

    // Background GPU telemetry + thermal safety cutoff thread
    let tel_clone = shared_tel.clone();
    let stop_clone = stop_tel.clone();
    let cutoff_c = cli.thermal_cutoff_c;
    let tel_handle = std::thread::spawn(move || {
        let mut reader = TelemetryReader::new();
        while !stop_clone.load(Ordering::Relaxed) {
            let (gt, gl, gp) = reader.sample_gpu_only();
            let snap = LiveTelemetrySnapshot {
                gpu_temp_c: gt,
                gpu_load_pct: gl,
                gpu_power_w: gp,
                gpu_temp_available: gt.is_some(),
                ..Default::default()
            };
            let check = TelemetryReader::is_thermal_safe(&snap, f32::INFINITY, cutoff_c);
            if let Ok(mut guard) = tel_clone.lock() {
                guard.temp_c = gt;
                guard.load_pct = gl;
                guard.power_w = gp;
                if let Some(t) = gt {
                    guard.peak_temp_c = Some(guard.peak_temp_c.map_or(t, |p| p.max(t)));
                }
                if let Some(w) = gp {
                    guard.peak_power_w = Some(guard.peak_power_w.map_or(w, |p| p.max(w)));
                }
                if matches!(check, ThermalSafetyCheck::CutoffTriggered { .. }) {
                    guard.cutoff_triggered = true;
                }
            }
            std::thread::sleep(Duration::from_millis(750));
        }
    });

    let event_loop = EventLoop::new().map_err(|e| format!("Failed to init native EventLoop: {}", e))?;
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = NativeBenchApp::new(cli, shared_tel, stop_tel.clone());
    event_loop
        .run_app(&mut app)
        .map_err(|e| format!("Native 3D event loop error: {}", e))?;

    stop_tel.store(true, Ordering::SeqCst);
    let _ = tel_handle.join();

    if let Some(err) = app.init_error {
        return Err(err);
    }

    let result = app.build_result();
    let json = serde_json::to_string(&result).map_err(|e| format!("JSON serialize error: {}", e))?;
    println!("LAPTOPBENCH_NATIVE3D_JSON:{}", json);
    Ok(())
}

/// Parent Tauri helper: spawns the current binary in `--native-3d-bench` mode and streams back its JSON result.
pub fn launch_native_3d_suite_subprocess(
    resolution: &str,
    secs_per_scene: u64,
    adapter_index: Option<usize>,
    thermal_cutoff_c: f32,
    scene: Option<&str>,
    cancel: Arc<AtomicBool>,
) -> Result<Native3dSuiteResult, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Failed to locate executable: {}", e))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--native-3d-bench")
        .arg(format!("--res={}", resolution))
        .arg(format!("--secs={}", secs_per_scene.clamp(5, 60)))
        .arg(format!("--cutoff={:.0}", clamp_gpu_thermal_cutoff(thermal_cutoff_c)))
        .arg(format!("--scene={}", scene.unwrap_or("all")))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(idx) = adapter_index {
        cmd.arg(format!("--adapter={}", idx));
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch native fullscreen 3D process: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture native 3D stdout".to_string())?;
    let stderr = child.stderr.take();

    let out_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let out_clone = out_lines.clone();
    let reader_t = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            if let Ok(mut g) = out_clone.lock() {
                g.push(line);
            }
        }
    });

    let err_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let err_clone = err_lines.clone();
    let err_t = std::thread::spawn(move || {
        if let Some(se) = stderr {
            for line in BufReader::new(se).lines().flatten() {
                if let Ok(mut g) = err_clone.lock() {
                    g.push(line);
                }
            }
        }
    });

    let mut killed_by_cancel = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            killed_by_cancel = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(e) => return Err(format!("Native 3D wait error: {}", e)),
        }
    }
    let _ = child.wait();
    let _ = reader_t.join();
    let _ = err_t.join();

    if killed_by_cancel {
        return Ok(Native3dSuiteResult {
            status: TestStatus::Warn,
            cancelled: true,
            resolution: resolution.to_string(),
            summary: "Native 3D suite cancelled by technician.".into(),
            plain_summary: "Native uncapped 3D benchmark was stopped before completion.".into(),
            ..Default::default()
        });
    }

    let lines = out_lines.lock().map(|g| g.clone()).unwrap_or_default();
    for line in lines.iter().rev() {
        if let Some(payload) = line.strip_prefix("LAPTOPBENCH_NATIVE3D_JSON:") {
            let parsed: Native3dSuiteResult = serde_json::from_str(payload)
                .map_err(|e| format!("Failed to parse native 3D result JSON: {}", e))?;
            return Ok(parsed);
        }
    }

    let errs = err_lines.lock().map(|g| g.join(" | ")).unwrap_or_default();
    Err(format!(
        "Native 3D benchmark process exited without result JSON. {}",
        if errs.is_empty() {
            "Ensure GPU drivers support DX12/Vulkan/Metal.".to_string()
        } else {
            errs
        }
    ))
}

/// Headless hardware shader + 500,000-particle compute validation for `--self-test`.
pub fn smoke_test_native_3d_shaders() -> Result<String, String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..Default::default()
    });
    let adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY);
    let adapter = adapters
        .into_iter()
        .find(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
        .ok_or_else(|| "No hardware GPU adapter available for native 3D smoke test".to_string())?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("Native3D Smoke Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .map_err(|e| format!("Native3D smoke device error: {}", e))?;

    // Validate all 3 WGSL modules compile cleanly on live hardware driver
    let suite_sm = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Smoke Suite WGSL"),
        source: wgpu::ShaderSource::Wgsl(SUITE_SHADER_WGSL.into()),
    });
    let part_sm = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Smoke Particles WGSL"),
        source: wgpu::ShaderSource::Wgsl(PARTICLES_SHADER_WGSL.into()),
    });
    let _hud_sm = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Smoke HUD WGSL"),
        source: wgpu::ShaderSource::Wgsl(HUD_SHADER_WGSL.into()),
    });

    // Dispatch 1 full 500,000-particle compute step on hardware GPU
    let pu = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Smoke PU"),
        contents: bytemuck::cast_slice(&[ParticleUniforms {
            time: 1.0,
            dt: 0.016,
            aspect: 1.77,
            particle_count: PARTICLE_COUNT,
            attractor_x: 0.0,
            attractor_y: 0.0,
            zoom: 1.0,
            _pad: 0.0,
        }]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let pbuf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Smoke 500K"),
        size: (PARTICLE_COUNT as u64) * std::mem::size_of::<ParticleVertex>() as u64,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Smoke BGL"),
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
        ],
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Smoke BG"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: pu.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: pbuf.as_entire_binding() },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Smoke PL"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let cpipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Smoke Comp"),
        layout: Some(&pl),
        module: &part_sm,
        entry_point: Some("cs_particles"),
        compilation_options: Default::default(),
        cache: None,
    });

    let t0 = Instant::now();
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        cpass.set_pipeline(&cpipe);
        cpass.set_bind_group(0, &bg, &[]);
        cpass.dispatch_workgroups((PARTICLE_COUNT + 255) / 256, 1, 1);
    }
    queue.submit(Some(enc.finish()));
    device.poll(wgpu::Maintain::Wait);
    let comp_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // Also verify preview JPEG capture of Scene 1 (Path-Traced PBR Studio)
    let preview_ok = capture_native_preview_jpeg(&device, &queue, &suite_sm, 1).is_some();

    Ok(format!(
        "Native3D=OK ({} {:?}, 500kParticles={:.1}ms, preview={})",
        info.name, info.backend, comp_ms, preview_ok
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_native_3d_percentiles_and_tier_classification() {
        let samples = vec![4.0, 5.0, 5.0, 6.0, 10.0, 5.0, 5.0, 5.0, 5.0, 5.0];
        let (avg, low1, low01, avg_ms) = compute_frame_percentiles(&samples);
        assert!(avg > 150.0 && avg < 220.0);
        assert!(low1 <= avg);
        assert!(low01 <= low1);
        assert!(avg_ms > 4.5 && avg_ms < 6.0);

        assert_eq!(classify_native_3d_tier(70.0, 2160), "Flagship RTX / Workstation dGPU");
        assert_eq!(classify_native_3d_tier(35.0, 1080), "Ultrabook Integrated GPU");
    }

    #[test]
    fn test_native_3d_cli_parsing() {
        let args = vec![
            "laptopbench-qc.exe".into(),
            "--native-3d-bench".into(),
            "--res=4k".into(),
            "--secs=15".into(),
            "--scene=pathtrace".into(),
        ];
        let cfg = parse_cli_config(&args);
        assert_eq!(cfg.target_w, 3840);
        assert_eq!(cfg.target_h, 2160);
        assert_eq!(cfg.secs_per_scene, 15.0);
        assert_eq!(cfg.scene_indices, vec![1]);
    }
}
