#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--self-test") {
        if let Err(e) = laptopbench_qc_lib::run_self_test() {
            eprintln!("[FAIL] {}", e);
            std::process::exit(1);
        }
        return;
    }
    laptopbench_qc_lib::run();
}
