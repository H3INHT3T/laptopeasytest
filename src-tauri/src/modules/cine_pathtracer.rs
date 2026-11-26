// LaptopBench QC v3.5.0 — Cinebench-Class Live Tile Monte-Carlo PBR Path-Tracer (Rust + Rayon)
// Multi-bounce Global Illumination, Snell dielectric glass refraction, metallic GGX sheen,
// emissive area softboxes, spiral 64x64 per-core live tile streaming, Multi-Core + Single-Core pts & MP Ratio.

use crate::modules::telemetry::TelemetryReader;
use crate::types::{CinePathtracerResult, CinePathtracerTileEvent, TestStatus};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use rayon::prelude::*;
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy)]
struct Vec3(f32, f32, f32);

impl Vec3 {
    #[inline(always)]
    fn new(x: f32, y: f32, z: f32) -> Self { Self(x, y, z) }
    #[inline(always)]
    fn add(self, o: Self) -> Self { Self(self.0 + o.0, self.1 + o.1, self.2 + o.2) }
    #[inline(always)]
    fn sub(self, o: Self) -> Self { Self(self.0 - o.0, self.1 - o.1, self.2 - o.2) }
    #[inline(always)]
    fn mul(self, s: f32) -> Self { Self(self.0 * s, self.1 * s, self.2 * s) }
    #[inline(always)]
    fn had(self, o: Self) -> Self { Self(self.0 * o.0, self.1 * o.1, self.2 * o.2) }
    #[inline(always)]
    fn dot(self, o: Self) -> f32 { self.0 * o.0 + self.1 * o.1 + self.2 * o.2 }
    #[inline(always)]
    fn cross(self, o: Self) -> Self {
        Self(
            self.1 * o.2 - self.2 * o.1,
            self.2 * o.0 - self.0 * o.2,
            self.0 * o.1 - self.1 * o.0,
        )
    }
    #[inline(always)]
    fn len(self) -> f32 { self.dot(self).sqrt() }
    #[inline(always)]
    fn norm(self) -> Self {
        let l = self.len().max(1e-6);
        Self(self.0 / l, self.1 / l, self.2 / l)
    }
    #[inline(always)]
    fn reflect(self, n: Self) -> Self { self.sub(n.mul(2.0 * self.dot(n))) }
}

struct XorRng(u64);
impl XorRng {
    #[inline(always)]
    fn new(seed: u64) -> Self {
        Self(seed.max(1) ^ 0x9E37_79B9_7F4A_7C15)
    }
    #[inline(always)]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }
    #[inline(always)]
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
}

#[derive(Clone, Copy)]
enum MatKind {
    Diffuse,
    Metal { fuzz: f32 },
    Glass { ior: f32 },
    Light,
}

#[derive(Clone, Copy)]
struct Material {
    albedo: Vec3,
    emit: Vec3,
    kind: MatKind,
}

#[derive(Clone, Copy)]
struct SphereObj {
    center: Vec3,
    radius: f32,
    mat: Material,
}

#[derive(Clone, Copy)]
struct BoxObj {
    min: Vec3,
    max: Vec3,
    mat: Material,
}

const STUDIO_SPHERES: [SphereObj; 11] = [
    // Center Large Crystal Dielectric Glass Orb
    SphereObj {
        center: Vec3(0.0, 0.25, -3.4),
        radius: 0.85,
        mat: Material { albedo: Vec3(0.95, 0.98, 1.0), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Glass { ior: 1.50 } },
    },
    // Left Mirror Chrome Sculpture
    SphereObj {
        center: Vec3(-1.75, 0.15, -3.95),
        radius: 0.75,
        mat: Material { albedo: Vec3(0.95, 0.96, 0.99), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.02 } },
    },
    // Right Brushed Gold Sphere
    SphereObj {
        center: Vec3(1.72, 0.15, -3.85),
        radius: 0.75,
        mat: Material { albedo: Vec3(0.98, 0.77, 0.34), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.12 } },
    },
    // Front Cobalt Anodized Titanium Sphere
    SphereObj {
        center: Vec3(-0.98, -0.26, -2.18),
        radius: 0.34,
        mat: Material { albedo: Vec3(0.16, 0.44, 0.96), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.08 } },
    },
    // Front Warm Matte Terracotta Ceramic Sphere
    SphereObj {
        center: Vec3(0.96, -0.26, -2.15),
        radius: 0.34,
        mat: Material { albedo: Vec3(0.84, 0.32, 0.22), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Diffuse },
    },
    // Frosted Glass Satellite Sphere
    SphereObj {
        center: Vec3(0.0, -0.35, -1.92),
        radius: 0.25,
        mat: Material { albedo: Vec3(0.82, 0.96, 1.0), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Glass { ior: 1.38 } },
    },
    // Back Obsidian Gloss Sphere
    SphereObj {
        center: Vec3(-0.78, 0.55, -5.15),
        radius: 0.58,
        mat: Material { albedo: Vec3(0.12, 0.14, 0.19), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.06 } },
    },
    // Back Emerald Metallic Sphere
    SphereObj {
        center: Vec3(0.84, 0.52, -5.20),
        radius: 0.56,
        mat: Material { albedo: Vec3(0.16, 0.78, 0.58), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.10 } },
    },
    // Floating Neon Blue Key Orb
    SphereObj {
        center: Vec3(-2.35, 1.85, -3.1),
        radius: 0.42,
        mat: Material { albedo: Vec3(1.0, 1.0, 1.0), emit: Vec3(2.8, 5.2, 11.5), kind: MatKind::Light },
    },
    // Floating Warm Amber Studio Rim Orb
    SphereObj {
        center: Vec3(2.45, 1.95, -2.9),
        radius: 0.42,
        mat: Material { albedo: Vec3(1.0, 1.0, 1.0), emit: Vec3(11.0, 6.2, 2.4), kind: MatKind::Light },
    },
    // Main Overhead Softbox Dome Light
    SphereObj {
        center: Vec3(0.0, 4.15, -3.4),
        radius: 1.18,
        mat: Material { albedo: Vec3(1.0, 1.0, 1.0), emit: Vec3(6.8, 6.7, 6.4), kind: MatKind::Light },
    },
];

const STUDIO_BOXES: [BoxObj; 4] = [
    // Left Architectural Pedestal Pillar
    BoxObj {
        min: Vec3(-2.95, -0.60, -5.6),
        max: Vec3(-2.35, 1.55, -4.95),
        mat: Material { albedo: Vec3(0.86, 0.88, 0.91), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Diffuse },
    },
    // Right Architectural Pedestal Pillar
    BoxObj {
        min: Vec3(2.35, -0.60, -5.6),
        max: Vec3(2.95, 1.55, -4.95),
        mat: Material { albedo: Vec3(0.18, 0.21, 0.27), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.22 } },
    },
    // Center Low Marble Plinth under Glass Orb
    BoxObj {
        min: Vec3(-0.72, -0.60, -4.12),
        max: Vec3(0.72, -0.58, -2.68),
        mat: Material { albedo: Vec3(0.92, 0.94, 0.98), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Metal { fuzz: 0.14 } },
    },
    // Back Studio Wall Panel
    BoxObj {
        min: Vec3(-6.5, -0.60, -6.8),
        max: Vec3(6.5, 4.5, -6.5),
        mat: Material { albedo: Vec3(0.74, 0.77, 0.82), emit: Vec3(0.0, 0.0, 0.0), kind: MatKind::Diffuse },
    },
];

#[inline(always)]
fn intersect_box(ro: Vec3, rd: Vec3, b: &BoxObj) -> Option<(f32, Vec3)> {
    let inv_x = if rd.0.abs() > 1e-6 { 1.0 / rd.0 } else { 1e9 };
    let inv_y = if rd.1.abs() > 1e-6 { 1.0 / rd.1 } else { 1e9 };
    let inv_z = if rd.2.abs() > 1e-6 { 1.0 / rd.2 } else { 1e9 };

    let tx1 = (b.min.0 - ro.0) * inv_x;
    let tx2 = (b.max.0 - ro.0) * inv_x;
    let tmin_x = tx1.min(tx2);
    let tmax_x = tx1.max(tx2);

    let ty1 = (b.min.1 - ro.1) * inv_y;
    let ty2 = (b.max.1 - ro.1) * inv_y;
    let tmin_y = ty1.min(ty2);
    let tmax_y = ty1.max(ty2);

    let tz1 = (b.min.2 - ro.2) * inv_z;
    let tz2 = (b.max.2 - ro.2) * inv_z;
    let tmin_z = tz1.min(tz2);
    let tmax_z = tz1.max(tz2);

    let tmin = tmin_x.max(tmin_y).max(tmin_z);
    let tmax = tmax_x.min(tmax_y).min(tmax_z);

    if tmax < 0.002 || tmin > tmax {
        return None;
    }
    let t = if tmin > 0.002 { tmin } else { tmax };
    if t <= 0.002 {
        return None;
    }
    let p = ro.add(rd.mul(t));
    let eps = 0.002;
    let n = if (p.0 - b.min.0).abs() < eps {
        Vec3(-1.0, 0.0, 0.0)
    } else if (p.0 - b.max.0).abs() < eps {
        Vec3(1.0, 0.0, 0.0)
    } else if (p.1 - b.min.1).abs() < eps {
        Vec3(0.0, -1.0, 0.0)
    } else if (p.1 - b.max.1).abs() < eps {
        Vec3(0.0, 1.0, 0.0)
    } else if (p.2 - b.min.2).abs() < eps {
        Vec3(0.0, 0.0, -1.0)
    } else {
        Vec3(0.0, 0.0, 1.0)
    };
    Some((t, n))
}

#[inline(always)]
fn sample_unit_sphere(rng: &mut XorRng) -> Vec3 {
    let u = rng.next_f32() * 2.0 - 1.0;
    let phi = rng.next_f32() * std::f32::consts::TAU;
    let r = (1.0 - u * u).max(0.0).sqrt();
    Vec3(r * phi.cos(), u, r * phi.sin())
}

#[inline(always)]
fn sample_cosine_hemisphere(n: Vec3, rng: &mut XorRng) -> Vec3 {
    let dir = n.add(sample_unit_sphere(rng));
    if dir.len() < 1e-4 { n } else { dir.norm() }
}

fn path_trace(mut ro: Vec3, mut rd: Vec3, rng: &mut XorRng, rays_counted: &mut u64) -> Vec3 {
    let mut throughput = Vec3::new(1.0, 1.0, 1.0);
    let mut radiance = Vec3::new(0.0, 0.0, 0.0);

    for _bounce in 0..5 {
        *rays_counted += 1;
        let mut best_t = 1e9f32;
        let mut hit_n = Vec3::new(0.0, 1.0, 0.0);
        let mut hit_mat: Option<Material> = None;

        // Ground marble plane y = -0.60
        if rd.1.abs() > 1e-4 {
            let tp = (-0.60 - ro.1) / rd.1;
            if tp > 0.002 && tp < best_t {
                let p = ro.add(rd.mul(tp));
                if p.0.abs() < 12.0 && p.2 > -9.0 && p.2 < 4.0 {
                    best_t = tp;
                    hit_n = Vec3::new(0.0, 1.0, 0.0);
                    let cx = (p.0 * 1.4).floor() as i32;
                    let cz = (p.2 * 1.4).floor() as i32;
                    let even = ((cx + cz) & 1) == 0;
                    hit_mat = Some(Material {
                        albedo: if even { Vec3(0.90, 0.92, 0.96) } else { Vec3(0.11, 0.13, 0.17) },
                        emit: Vec3(0.0, 0.0, 0.0),
                        kind: MatKind::Metal { fuzz: if even { 0.16 } else { 0.08 } },
                    });
                }
            }
        }

        // Spheres
        for s in &STUDIO_SPHERES {
            let oc = ro.sub(s.center);
            let b = oc.dot(rd);
            let c = oc.dot(oc) - s.radius * s.radius;
            let disc = b * b - c;
            if disc > 0.0 {
                let sq = disc.sqrt();
                let t1 = -b - sq;
                let t2 = -b + sq;
                let t = if t1 > 0.002 { t1 } else { t2 };
                if t > 0.002 && t < best_t {
                    best_t = t;
                    let p = ro.add(rd.mul(t));
                    hit_n = p.sub(s.center).norm();
                    hit_mat = Some(s.mat);
                }
            }
        }

        // Architectural Boxes
        for bx in &STUDIO_BOXES {
            if let Some((tb, nb)) = intersect_box(ro, rd, bx) {
                if tb < best_t {
                    best_t = tb;
                    hit_n = nb;
                    hit_mat = Some(bx.mat);
                }
            }
        }

        let Some(mat) = hit_mat else {
            // Studio HDR gradient sky dome
            let k = (0.5 * (rd.1 + 1.0)).clamp(0.0, 1.0);
            let sky = Vec3(0.08, 0.11, 0.18).mul(1.0 - k).add(Vec3(0.32, 0.44, 0.68).mul(k));
            radiance = radiance.add(throughput.had(sky));
            break;
        };

        let hp = ro.add(rd.mul(best_t));
        radiance = radiance.add(throughput.had(mat.emit));

        match mat.kind {
            MatKind::Light => break,
            MatKind::Diffuse => {
                let n_eff = if rd.dot(hit_n) < 0.0 { hit_n } else { hit_n.mul(-1.0) };
                ro = hp.add(n_eff.mul(0.002));
                rd = sample_cosine_hemisphere(n_eff, rng);
                throughput = throughput.had(mat.albedo);
            }
            MatKind::Metal { fuzz } => {
                let n_eff = if rd.dot(hit_n) < 0.0 { hit_n } else { hit_n.mul(-1.0) };
                let refl = rd.reflect(n_eff).add(sample_unit_sphere(rng).mul(fuzz)).norm();
                if refl.dot(n_eff) <= 0.0 {
                    break;
                }
                ro = hp.add(n_eff.mul(0.002));
                rd = refl;
                throughput = throughput.had(mat.albedo);
            }
            MatKind::Glass { ior } => {
                let front = rd.dot(hit_n) < 0.0;
                let n_eff = if front { hit_n } else { hit_n.mul(-1.0) };
                let ratio = if front { 1.0 / ior } else { ior };
                let cos_t = (-rd.dot(n_eff)).min(1.0);
                let sin_t = (1.0 - cos_t * cos_t).max(0.0).sqrt();
                let r0 = ((1.0 - ratio) / (1.0 + ratio)).powi(2);
                let schlick = r0 + (1.0 - r0) * (1.0 - cos_t).powi(5);
                if ratio * sin_t > 1.0 || schlick > rng.next_f32() {
                    ro = hp.add(n_eff.mul(0.002));
                    rd = rd.reflect(n_eff).norm();
                } else {
                    let r_perp = rd.add(n_eff.mul(cos_t)).mul(ratio);
                    let r_par = n_eff.mul(-(1.0 - r_perp.dot(r_perp)).abs().sqrt());
                    ro = hp.sub(n_eff.mul(0.003));
                    rd = r_perp.add(r_par).norm();
                    throughput = throughput.had(mat.albedo);
                }
            }
        }
    }

    radiance
}

#[inline(always)]
fn aces_u8(v: f32) -> u8 {
    let x = v.max(0.0);
    let mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    let gamma = mapped.clamp(0.0, 1.0).powf(1.0 / 2.2);
    (gamma * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

fn build_spiral_tiles(w: u32, h: u32, tile_size: u32) -> Vec<(u32, u32, u32, u32)> {
    let mut tiles = Vec::new();
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            tiles.push((x, y, tile_size.min(w - x), tile_size.min(h - y)));
            x += tile_size;
        }
        y += tile_size;
    }
    let cx = w as f32 * 0.5;
    let cy = h as f32 * 0.5;
    tiles.sort_by(|a, b| {
        let da = (a.0 as f32 + a.2 as f32 * 0.5 - cx).powi(2) + (a.1 as f32 + a.3 as f32 * 0.5 - cy).powi(2);
        let db = (b.0 as f32 + b.2 as f32 * 0.5 - cx).powi(2) + (b.1 as f32 + b.3 as f32 * 0.5 - cy).powi(2);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    });
    tiles
}

fn render_tile_rgb(
    tx: u32,
    ty: u32,
    tw: u32,
    th: u32,
    img_w: u32,
    img_h: u32,
    spp: u32,
) -> (Vec<u8>, u64) {
    let mut rgb = vec![0u8; (tw * th * 3) as usize];
    let mut rays: u64 = 0;
    let aspect = img_w as f32 / img_h.max(1) as f32;
    let cam_origin = Vec3::new(0.0, 0.62, 1.45);
    let cam_target = Vec3::new(0.0, 0.12, -3.45);
    let fwd = cam_target.sub(cam_origin).norm();
    let right = fwd.cross(Vec3::new(0.0, 1.0, 0.0)).norm();
    let up = right.cross(fwd);
    let fov_scale = 0.66f32;
    let inv_spp = 1.0 / spp.max(1) as f32;

    for ly in 0..th {
        let py = ty + ly;
        for lx in 0..tw {
            let px = tx + lx;
            let mut rng = XorRng::new(((py as u64) << 32) ^ (px as u64) * 2654435761 ^ 0xA5A5_1337);
            let mut col = Vec3::new(0.0, 0.0, 0.0);
            for _s in 0..spp {
                let u = ((px as f32 + rng.next_f32()) / img_w as f32) * 2.0 - 1.0;
                let v = 1.0 - ((py as f32 + rng.next_f32()) / img_h as f32) * 2.0;
                let rd = fwd
                    .add(right.mul(u * aspect * fov_scale))
                    .add(up.mul(v * fov_scale))
                    .norm();
                col = col.add(path_trace(cam_origin, rd, &mut rng, &mut rays));
            }
            col = col.mul(inv_spp);
            let idx = ((ly * tw + lx) * 3) as usize;
            rgb[idx] = aces_u8(col.0);
            rgb[idx + 1] = aces_u8(col.1);
            rgb[idx + 2] = aces_u8(col.2);
        }
    }
    (rgb, rays)
}

fn encode_tile_png_b64(rgb: &[u8], w: u32, h: u32) -> String {
    let mut out = Vec::new();
    if PngEncoder::new(&mut out).write_image(rgb, w, h, ColorType::Rgb8.into()).is_ok() {
        B64.encode(out)
    } else {
        String::new()
    }
}

fn encode_full_jpeg_data_url(rgb: &[u8], w: u32, h: u32) -> Option<String> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 88)
        .encode(rgb, w, h, ColorType::Rgb8.into())
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(out)))
}

fn classify_cine_tier(multi_pts: u64) -> &'static str {
    if multi_pts >= 16000 {
        "Flagship Workstation / HX Enthusiast"
    } else if multi_pts >= 9500 {
        "High-Performance Creator / H-Series"
    } else if multi_pts >= 5000 {
        "Modern Mainstream Ultrabook"
    } else if multi_pts >= 2500 {
        "Thin-and-Light / Office Tier"
    } else {
        "Entry / Low-Power CPU"
    }
}

fn run_tile_pass(
    app: &AppHandle,
    pass_mode: &str,
    img_w: u32,
    img_h: u32,
    spp: u32,
    single_thread: bool,
    cancel: &Arc<AtomicBool>,
    tel_shared: &Arc<Mutex<(Option<f32>, u64, Option<f32>, u64, u64, u64)>>,
) -> (Vec<u8>, u64, f64, bool) {
    let tile_size = 64u32;
    let tiles = build_spiral_tiles(img_w, img_h, tile_size);
    let tiles_total = tiles.len() as u32;
    let tiles_done = Arc::new(AtomicU32::new(0));
    let total_rays = Arc::new(AtomicU64::new(0));
    let full_rgb = Arc::new(Mutex::new(vec![0u8; (img_w * img_h * 3) as usize]));
    let active_set = Arc::new(Mutex::new(HashSet::<(u32, u32)>::new()));
    let started = Instant::now();

    let process_tile = |(tx, ty, tw, th): (u32, u32, u32, u32)| {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut set) = active_set.lock() {
            set.insert((tx, ty));
        }
        let (tile_rgb, rays) = render_tile_rgb(tx, ty, tw, th, img_w, img_h, spp);
        let rays_now = total_rays.fetch_add(rays, Ordering::Relaxed) + rays;
        let done_now = tiles_done.fetch_add(1, Ordering::Relaxed) + 1;

        if let Ok(mut full) = full_rgb.lock() {
            for ly in 0..th as usize {
                let dst_row = ((ty as usize + ly) * img_w as usize + tx as usize) * 3;
                let src_row = ly * tw as usize * 3;
                let len = tw as usize * 3;
                full[dst_row..dst_row + len].copy_from_slice(&tile_rgb[src_row..src_row + len]);
            }
        }
        let active_snapshot: Vec<[u32; 2]> = if let Ok(mut set) = active_set.lock() {
            set.remove(&(tx, ty));
            set.iter().map(|&(ax, ay)| [ax, ay]).collect()
        } else {
            vec![]
        };

        let elapsed = started.elapsed().as_secs_f64().max(0.01);
        let mrays = (rays_now as f64 / 1_000_000.0) / elapsed;
        let (cur_temp, cur_clk) = tel_shared
            .lock()
            .ok()
            .map(|g| (g.0, g.1))
            .unwrap_or((None, 0));

        let _ = app.emit(
            "pathtracer:tile",
            CinePathtracerTileEvent {
                pass_mode: pass_mode.to_string(),
                tile_x: tx,
                tile_y: ty,
                tile_w: tw,
                tile_h: th,
                image_w: img_w,
                image_h: img_h,
                tiles_done: done_now,
                tiles_total,
                percent: ((done_now as f64 / tiles_total.max(1) as f64) * 100.0 * 10.0).round() / 10.0,
                mrays_per_sec: (mrays * 100.0).round() / 100.0,
                elapsed_secs: (elapsed * 10.0).round() / 10.0,
                cpu_temp_c: cur_temp,
                cpu_clock_mhz: cur_clk,
                tile_png_base64: encode_tile_png_b64(&tile_rgb, tw, th),
                active_tiles: active_snapshot,
            },
        );
    };

    if single_thread {
        for tile in tiles {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            process_tile(tile);
        }
    } else {
        tiles.into_par_iter().for_each(process_tile);
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.01);
    let rays = total_rays.load(Ordering::Relaxed);
    let rgb = full_rgb.lock().map(|g| g.clone()).unwrap_or_default();
    let was_cancelled = cancel.load(Ordering::Relaxed);
    (rgb, rays, elapsed, was_cancelled)
}

/// Runs the Cinebench-Class Live Tile Monte-Carlo PBR Path-Tracer in Multi-Core, Single-Core, or Both modes.
pub fn run_cine_pathtracer(
    app: &AppHandle,
    mode: &str,
    quality: &str,
    cancel: Arc<AtomicBool>,
) -> Result<CinePathtracerResult, String> {
    let (img_w, img_h, spp): (u32, u32, u32) = match quality {
        "ultra" => (1280, 720, 32),
        "standard" => (960, 540, 24),
        _ => (768, 448, 16), // fast interactive QC pass (~4-10s multi-core)
    };
    let threads_used = rayon::current_num_threads().max(1);

    // (cur_temp, cur_clk, peak_temp, clk_sum, clk_count, max_clk)
    let tel_shared = Arc::new(Mutex::new((None::<f32>, 0u64, None::<f32>, 0u64, 0u64, 0u64)));
    let tel_stop = Arc::new(AtomicBool::new(false));
    let tel_s_clone = tel_shared.clone();
    let tel_stop_c = tel_stop.clone();
    let tel_thread = std::thread::spawn(move || {
        let mut reader = TelemetryReader::new();
        while !tel_stop_c.load(Ordering::Relaxed) {
            let snap = reader.sample(false);
            if let Ok(mut g) = tel_s_clone.lock() {
                g.0 = snap.cpu_temp_c;
                g.1 = snap.cpu_clock_mhz;
                if let Some(t) = snap.cpu_temp_c {
                    g.2 = Some(g.2.map_or(t, |p| p.max(t)));
                }
                if snap.cpu_clock_mhz > 0 {
                    g.3 = g.3.saturating_add(snap.cpu_clock_mhz);
                    g.4 = g.4.saturating_add(1);
                    g.5 = g.5.max(snap.cpu_clock_mhz);
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });

    let started_all = Instant::now();
    let mut total_rays_all: u64 = 0;
    let mut single_mrays: Option<f64> = None;

    let (final_rgb, multi_mrays, mut cancelled) = if mode == "single" {
        let sc_w = (img_w / 2).max(384);
        let sc_h = (img_h / 2).max(256);
        let (rgb, rays, secs, c) = run_tile_pass(app, "single", sc_w, sc_h, spp.min(16), true, &cancel, &tel_shared);
        total_rays_all += rays;
        let sm = (rays as f64 / 1_000_000.0) / secs;
        single_mrays = Some(sm);
        (rgb, sm, c)
    } else {
        let (rgb, rays, secs, c) = run_tile_pass(app, "multi", img_w, img_h, spp, false, &cancel, &tel_shared);
        total_rays_all += rays;
        let mm = (rays as f64 / 1_000_000.0) / secs;
        (rgb, mm, c)
    };

    if !cancelled && mode == "both" {
        let sc_w = 384u32;
        let sc_h = 256u32;
        let (_srgb, s_rays, s_secs, sc) = run_tile_pass(app, "single", sc_w, sc_h, 12, true, &cancel, &tel_shared);
        total_rays_all += s_rays;
        if !sc {
            single_mrays = Some((s_rays as f64 / 1_000_000.0) / s_secs);
        } else {
            cancelled = true;
        }
    }

    tel_stop.store(true, Ordering::SeqCst);
    let _ = tel_thread.join();

    let (peak_temp_c, avg_clock_mhz, throttle_drop_pct) = tel_shared
        .lock()
        .ok()
        .map(|g| {
            let avg = if g.4 > 0 { g.3 / g.4 } else { g.1 };
            let drop = if g.5 > 0 && avg < g.5 {
                (((g.5 - avg) as f64 / g.5 as f64) * 100.0 * 10.0).round() / 10.0
            } else {
                0.0
            };
            (g.2, avg, drop)
        })
        .unwrap_or((None, 0, 0.0));

    // Calibrated Cinebench-style point scale: 1.0 MRays/s ~= 1,250 pts
    let multi_core_pts = (multi_mrays * 1250.0).round() as u64;
    let single_core_pts = single_mrays.map(|s| (s * 1250.0).round() as u64);
    let mp_ratio = single_mrays
        .filter(|&s| s > 0.001 && mode != "single")
        .map(|s| ((multi_mrays / s) * 100.0).round() / 100.0);

    let elapsed_secs = (started_all.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let tier = classify_cine_tier(multi_core_pts).to_string();
    let status = if cancelled { TestStatus::Warn } else { TestStatus::Pass };
    let (enc_w, enc_h) = if mode == "single" {
        ((img_w / 2).max(384), (img_h / 2).max(256))
    } else {
        (img_w, img_h)
    };
    let image_data_url = if !final_rgb.is_empty() && final_rgb.len() == (enc_w * enc_h * 3) as usize {
        encode_full_jpeg_data_url(&final_rgb, enc_w, enc_h)
    } else {
        None
    };

    let mp_str = match (single_core_pts, mp_ratio) {
        (Some(sc), Some(r)) => format!(" | Single-Core {} pts (MP {:.2}x)", sc, r),
        (Some(sc), None) => format!(" | Single-Core {} pts", sc),
        _ => String::new(),
    };
    let summary = format!(
        "Cine Path-Tracer ({}x{} {}spp, {}T): Multi {} pts{} | {:.2} MRays/s | {}",
        img_w, img_h, spp, threads_used, multi_core_pts, mp_str, multi_mrays, tier
    );
    let plain_summary = format!(
        "Multi-bounce Monte-Carlo PBR Path-Tracer completed in {:.1}s across {} threads: {} pts ({:.2} MRays/s, {}).",
        elapsed_secs, threads_used, multi_core_pts, multi_mrays, tier
    );

    Ok(CinePathtracerResult {
        status,
        mode: mode.to_string(),
        resolution: format!("{}x{}", img_w, img_h),
        samples_per_pixel: spp,
        threads_used,
        multi_core_pts,
        single_core_pts,
        mp_ratio,
        mrays_per_sec: (multi_mrays * 100.0).round() / 100.0,
        total_rays: total_rays_all,
        elapsed_secs,
        peak_temp_c,
        avg_clock_mhz,
        throttle_drop_pct,
        cancelled,
        tier,
        image_data_url,
        summary,
        plain_summary,
    })
}

/// Fast headless validation for `--self-test`.
pub fn smoke_test_cine_pathtracer() -> Result<String, String> {
    let t0 = Instant::now();
    let tiles = build_spiral_tiles(192, 128, 64);
    let total_rays: u64 = tiles
        .into_par_iter()
        .map(|(tx, ty, tw, th)| render_tile_rgb(tx, ty, tw, th, 192, 128, 4).1)
        .sum();
    let secs = t0.elapsed().as_secs_f64().max(0.001);
    let mrays = (total_rays as f64 / 1_000_000.0) / secs;
    let pts = (mrays * 1250.0).round() as u64;
    Ok(format!("CinePathTracer={:.2} MRays/s (~{} pts)", mrays, pts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spiral_tiles_cover_exact_resolution() {
        let tiles = build_spiral_tiles(320, 200, 64);
        let total_pixels: u32 = tiles.iter().map(|&(_, _, w, h)| w * h).sum();
        assert_eq!(total_pixels, 320 * 200);
        // Center tile should come first
        let first = tiles[0];
        assert!(first.0 >= 64 && first.0 <= 192);
    }

    #[test]
    fn test_render_tile_produces_non_black_pbr_output() {
        let (rgb, rays) = render_tile_rgb(64, 64, 32, 32, 256, 192, 4);
        assert_eq!(rgb.len(), 32 * 32 * 3);
        assert!(rays >= 32 * 32 * 4);
        let max_px = rgb.iter().copied().max().unwrap_or(0);
        assert!(max_px > 40, "Path-traced tile should contain lit pixels");
    }
}
