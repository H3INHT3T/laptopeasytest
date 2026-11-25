use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use rayon::prelude::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone, Copy)]
struct Vec3(f32, f32, f32);

impl Vec3 {
    #[inline(always)]
    fn add(self, o: Vec3) -> Vec3 { Vec3(self.0 + o.0, self.1 + o.1, self.2 + o.2) }
    #[inline(always)]
    fn sub(self, o: Vec3) -> Vec3 { Vec3(self.0 - o.0, self.1 - o.1, self.2 - o.2) }
    #[inline(always)]
    fn mul(self, s: f32) -> Vec3 { Vec3(self.0 * s, self.1 * s, self.2 * s) }
    #[inline(always)]
    fn hadamard(self, o: Vec3) -> Vec3 { Vec3(self.0 * o.0, self.1 * o.1, self.2 * o.2) }
    #[inline(always)]
    fn dot(self, o: Vec3) -> f32 { self.0 * o.0 + self.1 * o.1 + self.2 * o.2 }
    #[inline(always)]
    fn norm(self) -> Vec3 {
        let l = self.dot(self).sqrt().max(1e-6);
        Vec3(self.0 / l, self.1 / l, self.2 / l)
    }
    #[inline(always)]
    fn reflect(self, n: Vec3) -> Vec3 {
        self.sub(n.mul(2.0 * self.dot(n)))
    }
}

struct Sphere {
    center: Vec3,
    radius: f32,
    albedo: Vec3,
    reflectivity: f32,
    spec_pow: f32,
}

const SPHERES: [Sphere; 5] = [
    // Center Cobalt Blue Glossy Sphere
    Sphere { center: Vec3(0.0, 0.35, -3.2), radius: 0.95, albedo: Vec3(0.14, 0.39, 0.92), reflectivity: 0.45, spec_pow: 96.0 },
    // Left Mirror Chrome Sphere
    Sphere { center: Vec3(-1.85, 0.1, -3.6), radius: 0.72, albedo: Vec3(0.92, 0.94, 0.98), reflectivity: 0.82, spec_pow: 140.0 },
    // Right Matte Obsidian Sphere
    Sphere { center: Vec3(1.80, 0.05, -3.3), radius: 0.68, albedo: Vec3(0.08, 0.09, 0.12), reflectivity: 0.35, spec_pow: 64.0 },
    // Front Mini Accent Blue Sphere
    Sphere { center: Vec3(-0.75, -0.32, -2.05), radius: 0.28, albedo: Vec3(0.25, 0.55, 1.0), reflectivity: 0.50, spec_pow: 80.0 },
    // Front Mini White Ceramic Sphere
    Sphere { center: Vec3(0.82, -0.34, -2.15), radius: 0.26, albedo: Vec3(0.96, 0.97, 1.0), reflectivity: 0.25, spec_pow: 48.0 },
];

fn trace_ray(ro: Vec3, rd: Vec3, depth: u32) -> Vec3 {
    let mut best_t = 1e9f32;
    let mut hit_idx: i32 = -1;

    for (i, s) in SPHERES.iter().enumerate() {
        let oc = ro.sub(s.center);
        let b = oc.dot(rd);
        let c = oc.dot(oc) - s.radius * s.radius;
        let disc = b * b - c;
        if disc > 0.0 {
            let t = -b - disc.sqrt();
            if t > 0.002 && t < best_t {
                best_t = t;
                hit_idx = i as i32;
            }
        }
    }

    // Studio ground plane at y = -0.60
    let mut hit_plane = false;
    if rd.1.abs() > 1e-4 {
        let tp = (-0.60 - ro.1) / rd.1;
        if tp > 0.002 && tp < best_t {
            best_t = tp;
            hit_plane = true;
            hit_idx = -1;
        }
    }

    if !hit_plane && hit_idx < 0 {
        // Studio crisp white-to-cobalt sky gradient
        let t = (0.5 * (rd.1 + 1.0)).clamp(0.0, 1.0);
        return Vec3(0.94, 0.96, 1.0).mul(1.0 - t).add(Vec3(0.06, 0.12, 0.26).mul(t));
    }

    let pos = ro.add(rd.mul(best_t));
    let (normal, albedo, refl, spec_pow) = if hit_plane {
        let cx = (pos.0 * 1.6).floor() as i32;
        let cz = (pos.2 * 1.6).floor() as i32;
        let checker = ((cx + cz) & 1) == 0;
        let col = if checker { Vec3(0.95, 0.96, 0.98) } else { Vec3(0.11, 0.12, 0.15) };
        (Vec3(0.0, 1.0, 0.0), col, 0.22, 32.0)
    } else {
        let s = &SPHERES[hit_idx as usize];
        (pos.sub(s.center).norm(), s.albedo, s.reflectivity, s.spec_pow)
    };

    // Dual studio key & rim lights with hard shadow ray
    let lights = [
        (Vec3(3.5, 5.5, 1.0), Vec3(1.0, 1.0, 1.0), 0.95f32),
        (Vec3(-4.0, 3.2, -0.5), Vec3(0.55, 0.75, 1.0), 0.55f32),
    ];

    let mut direct = albedo.mul(0.14);
    for (lpos, lcol, intensity) in lights {
        let ldir = lpos.sub(pos).norm();
        let ldist = lpos.sub(pos).dot(lpos.sub(pos)).sqrt();
        let mut shadowed = false;
        let shadow_ro = pos.add(normal.mul(0.004));
        for s in &SPHERES {
            let oc = shadow_ro.sub(s.center);
            let b = oc.dot(ldir);
            let c = oc.dot(oc) - s.radius * s.radius;
            let disc = b * b - c;
            if disc > 0.0 {
                let t = -b - disc.sqrt();
                if t > 0.002 && t < ldist {
                    shadowed = true;
                    break;
                }
            }
        }
        if !shadowed {
            let diff = normal.dot(ldir).max(0.0);
            let half_v = ldir.sub(rd).norm();
            let spec = normal.dot(half_v).max(0.0).powf(spec_pow);
            direct = direct
                .add(albedo.hadamard(lcol).mul(diff * intensity))
                .add(lcol.mul(spec * 0.55 * intensity));
        }
    }

    if depth > 0 && refl > 0.05 {
        let rdir = rd.reflect(normal).norm();
        let rcol = trace_ray(pos.add(normal.mul(0.004)), rdir, depth - 1);
        direct = direct.mul(1.0 - refl).add(rcol.mul(refl));
    }

    direct
}

/// Cinebench-style Multi-Core 3D Path-Tracing Benchmark.
/// Renders progressive tile batches across all CPU threads, calling `on_preview` with live
/// JPEG frames so the technician watches tiles render in real time!
pub fn run_creator_raytrace_bench(
    width: u32,
    height: u32,
    spp: u32,
    min_duration_secs: f64,
    cancel: &Arc<AtomicBool>,
    mut on_preview: impl FnMut(f64, Option<String>),
) -> Option<(u64, f64, Option<String>)> {
    let tile_size = 32u32;
    let tiles_x = (width + tile_size - 1) / tile_size;
    let tiles_y = (height + tile_size - 1) / tile_size;
    let total_tiles = (tiles_x * tiles_y) as usize;

    let mut rgb = vec![14u8; (width * height * 3) as usize];
    let started = Instant::now();
    let mut total_rays: u64 = 0;
    let mut frames_done = 0u32;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let batch_size = (rayon::current_num_threads() * 2).max(8);
        let mut cursor = 0usize;

        while cursor < total_tiles {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let end = (cursor + batch_size).min(total_tiles);
            let tile_results: Vec<(u32, u32, u32, u32, Vec<u8>)> = (cursor..end)
                .into_par_iter()
                .map(|t_idx| {
                    let tx = (t_idx as u32) % tiles_x;
                    let ty = (t_idx as u32) / tiles_x;
                    let x0 = tx * tile_size;
                    let y0 = ty * tile_size;
                    let tw = (width - x0).min(tile_size);
                    let th = (height - y0).min(tile_size);
                    let mut out = vec![0u8; (tw * th * 3) as usize];
                    let aspect = width as f32 / height as f32;
                    let ro = Vec3(0.0, 0.35, 1.35);

                    for py in 0..th {
                        for px in 0..tw {
                            let gx = x0 + px;
                            let gy = y0 + py;
                            let mut acc = Vec3(0.0, 0.0, 0.0);
                            for s in 0..spp {
                                let jx = ((s as f32 + 0.5) / spp as f32) - 0.5;
                                let jy = (((s * 7 + 3) % spp.max(1)) as f32 / spp as f32) - 0.5;
                                let u = ((gx as f32 + 0.5 + jx) / width as f32) * 2.0 - 1.0;
                                let v = 1.0 - ((gy as f32 + 0.5 + jy) / height as f32) * 2.0;
                                let rd = Vec3(u * aspect * 0.62, v * 0.62 - 0.08, -1.0).norm();
                                acc = acc.add(trace_ray(ro, rd, 3));
                            }
                            let scale = 1.0 / spp as f32;
                            let r = (acc.0 * scale).clamp(0.0, 1.0).powf(1.0 / 2.2);
                            let g = (acc.1 * scale).clamp(0.0, 1.0).powf(1.0 / 2.2);
                            let b = (acc.2 * scale).clamp(0.0, 1.0).powf(1.0 / 2.2);
                            let o = ((py * tw + px) * 3) as usize;
                            out[o] = (r * 255.0) as u8;
                            out[o + 1] = (g * 255.0) as u8;
                            out[o + 2] = (b * 255.0) as u8;
                        }
                    }
                    (x0, y0, tw, th, out)
                })
                .collect();

            for (x0, y0, tw, th, tbuf) in tile_results {
                for py in 0..th {
                    let dst_off = (((y0 + py) * width + x0) * 3) as usize;
                    let src_off = (py * tw * 3) as usize;
                    let row_bytes = (tw * 3) as usize;
                    rgb[dst_off..dst_off + row_bytes].copy_from_slice(&tbuf[src_off..src_off + row_bytes]);
                }
                total_rays += (tw as u64) * (th as u64) * (spp as u64) * 3;
            }

            cursor = end;
            let pct_by_time = (started.elapsed().as_secs_f64() / min_duration_secs).min(1.0);
            let pct_by_tile = cursor as f64 / total_tiles as f64;
            let preview = encode_jpeg(&rgb, width, height);
            on_preview(pct_by_time.max(pct_by_tile * 0.7).min(0.99), preview);
        }

        frames_done += 1;
        if started.elapsed().as_secs_f64() >= min_duration_secs {
            break;
        }
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let mega_rays_per_sec = ((total_rays as f64 / 1_000_000.0) / elapsed * 100.0).round() / 100.0;
    let render_score = (mega_rays_per_sec * 420.0).round() as u64;
    let final_preview = encode_jpeg(&rgb, width, height);
    let _ = frames_done;
    Some((render_score, mega_rays_per_sec, final_preview))
}

fn encode_jpeg(rgb: &[u8], width: u32, height: u32) -> Option<String> {
    let mut bytes = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut bytes, 78);
    enc.encode(rgb, width, height, ColorType::Rgb8.into()).ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(&bytes)))
}
