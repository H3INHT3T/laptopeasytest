use std::hint::black_box;

/// Reports the active bare-metal SIMD instruction set used by the AI / Matrix kernels.
pub fn detected_simd_isa() -> &'static str {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            return "x86_64 AVX2 + FMA";
        }
        if std::arch::is_x86_feature_detected!("avx") {
            return "x86_64 AVX";
        }
        return "x86_64 SSE2";
    }
    #[cfg(target_arch = "aarch64")]
    {
        "ARM64 NEON + FMA"
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
    {
        "Scalar Portable"
    }
}

/// High-throughput AI / Neural Dense Matrix Multiply (GEMM) kernel using runtime-dispatched
/// AVX2+FMA on x86_64 and NEON FMA on Apple Silicon aarch64.
pub fn simd_ai_gemm_step(dim: usize, seed: f32) -> f32 {
    let n = (dim / 8) * 8;
    let a: Vec<f32> = (0..n * n)
        .map(|i| ((i % 29) as f32) * 0.031 + seed * 0.001 + 0.1)
        .collect();
    let b: Vec<f32> = (0..n * n)
        .map(|i| ((i % 23) as f32) * 0.027 + 0.2)
        .collect();
    let mut c = vec![0.0f32; n * n];

    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            unsafe {
                gemm_avx2_fma(&a, &b, &mut c, n);
            }
            return black_box(c.iter().sum());
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        unsafe {
            gemm_neon(&a, &b, &mut c, n);
        }
        return black_box(c.iter().sum());
    }

    // Scalar fallback
    #[allow(unreachable_code)]
    {
        for i in 0..n {
            for k in 0..n {
                let aik = a[i * n + k];
                let b_row = &b[k * n..(k + 1) * n];
                let c_row = &mut c[i * n..(i + 1) * n];
                for j in 0..n {
                    c_row[j] = aik.mul_add(b_row[j], c_row[j]);
                }
            }
        }
        black_box(c.iter().sum())
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn gemm_avx2_fma(a: &[f32], b: &[f32], c: &mut [f32], n: usize) {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    for i in 0..n {
        let c_row = c.as_mut_ptr().add(i * n);
        for k in 0..n {
            let va = _mm256_set1_ps(*a.get_unchecked(i * n + k));
            let b_row = b.as_ptr().add(k * n);
            let mut j = 0;
            while j < n {
                let vc = _mm256_loadu_ps(c_row.add(j));
                let vb = _mm256_loadu_ps(b_row.add(j));
                let vres = _mm256_fmadd_ps(va, vb, vc);
                _mm256_storeu_ps(c_row.add(j), vres);
                j += 8;
            }
        }
    }
}

#[cfg(target_arch = "aarch64")]
unsafe fn gemm_neon(a: &[f32], b: &[f32], c: &mut [f32], n: usize) {
    use std::arch::aarch64::*;

    for i in 0..n {
        let c_row = c.as_mut_ptr().add(i * n);
        for k in 0..n {
            let va = vdupq_n_f32(*a.get_unchecked(i * n + k));
            let b_row = b.as_ptr().add(k * n);
            let mut j = 0;
            while j < n {
                let vc = vld1q_f32(c_row.add(j));
                let vb = vld1q_f32(b_row.add(j));
                let vres = vfmaq_f32(vc, va, vb);
                vst1q_f32(c_row.add(j), vres);
                j += 4;
            }
        }
    }
}

/// Real-world Creator Image Sharpen + Convolution Filter (3x3 Laplacian/Gaussian pass on 1080p RGB)
pub fn creator_image_filter_pass(width: usize, height: usize) -> u64 {
    let mut img = vec![0u8; width * height * 3];
    for (i, b) in img.iter_mut().enumerate() {
        *b = ((i * 37 + (i >> 5) * 19) & 0xFF) as u8;
    }
    let mut out = vec![0u8; width * height * 3];
    for y in 1..(height - 1) {
        for x in 1..(width - 1) {
            let idx = (y * width + x) * 3;
            for c in 0..3 {
                let center = img[idx + c] as i32 * 5;
                let n = img[((y - 1) * width + x) * 3 + c] as i32;
                let s = img[((y + 1) * width + x) * 3 + c] as i32;
                let w = img[(y * width + (x - 1)) * 3 + c] as i32;
                let e = img[(y * width + (x + 1)) * 3 + c] as i32;
                out[idx + c] = (center - n - s - w - e).clamp(0, 255) as u8;
            }
        }
    }
    black_box(out.iter().step_by(97).map(|&x| x as u64).sum())
}
