fn main() {
    // Zaszyj ścieżkę do root projektu w binarce (compile-time)
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let root = std::path::PathBuf::from(&manifest)
        .parent().unwrap() // app/
        .parent().unwrap() // praSzczur/
        .to_path_buf();
    println!("cargo:rustc-env=PRASZCZUR_ROOT={}", root.display());
    tauri_build::build()
}
