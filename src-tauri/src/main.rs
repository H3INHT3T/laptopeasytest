#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--self-test") {
        if let Err(e) = laptopbench_qc_lib::run_self_test() {
            eprintln!("[FAIL] {}", e);
            std::process::exit(1);
        }
        return;
    }
    if args.iter().any(|a| a == "--native-3d-bench") {
        if let Err(e) = laptopbench_qc_lib::run_native_3d_bench_cli(&args) {
            eprintln!("LAPTOPBENCH_NATIVE3D_ERR:{}", e);
            std::process::exit(1);
        }
        return;
    }
    laptopbench_qc_lib::run();
}
