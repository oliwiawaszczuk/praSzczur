use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

// In release CI builds (feature = pyinstaller-sidecar): use the app data dir so
// every user gets their own writable data directory.
// In local dev builds: use the compile-time project root baked in by build.rs.
fn data_root(app_handle: &tauri::AppHandle) -> PathBuf {
    #[cfg(feature = "pyinstaller-sidecar")]
    {
        app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(feature = "pyinstaller-sidecar"))]
    {
        let _ = app_handle; // suppress unused warning in dev builds
        PathBuf::from(env!("PRASZCZUR_ROOT"))
    }
}

// Kill whatever is already occupying port 7432 (best-effort, cross-platform).
fn kill_port_7432() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Ok(out) = Command::new("lsof").args(["-ti", ":7432"]).output() {
            for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
                let _ = Command::new("kill").args(["-9", pid]).status();
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // netstat → find PID listening on 7432 → taskkill
        if let Ok(out) = Command::new("cmd")
            .args([
                "/C",
                "for /f \"tokens=5\" %p in \
                  ('netstat -ano ^| findstr :7432 ^| findstr LISTENING') \
                  do taskkill /F /PID %p",
            ])
            .output()
        {
            let _ = out; // result not checked; best-effort
        }
    }
}

// Launch the sidecar as a PyInstaller-compiled binary (CI / release builds).
#[cfg(feature = "pyinstaller-sidecar")]
fn spawn_sidecar(app_handle: &tauri::AppHandle, root: &PathBuf) -> Child {
    let bin_name = if cfg!(target_os = "windows") {
        "sidecar.exe"
    } else {
        "sidecar"
    };
    let sidecar_bin = app_handle
        .path()
        .resource_dir()
        .expect("no resource dir")
        .join("sidecar")
        .join(bin_name);

    // Ensure execute permission on Unix (resources may lack it inside .app bundle)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&sidecar_bin) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&sidecar_bin, perms);
        }
    }

    Command::new(&sidecar_bin)
        .env("PRASZCZUR_ROOT", root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("cannot spawn PyInstaller sidecar")
}

// Launch the sidecar via `uv run python` (local macOS dev).
#[cfg(not(feature = "pyinstaller-sidecar"))]
fn spawn_sidecar(app_handle: &tauri::AppHandle, root: &PathBuf) -> Child {
    let script = app_handle
        .path()
        .resource_dir()
        .expect("no resource dir")
        .join("sidecar")
        .join("main.py");

    // Try common uv installation paths before falling back to PATH
    let uv = [
        "/opt/homebrew/bin/uv", // macOS Apple Silicon (Homebrew)
        "/usr/local/bin/uv",    // macOS Intel (Homebrew)
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
    .unwrap_or_else(|| PathBuf::from("uv"));

    Command::new(uv)
        .current_dir(root)
        .env("PRASZCZUR_ROOT", root)
        .args(["run", "python", script.to_str().unwrap()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("cannot spawn Python sidecar via uv")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let root = data_root(app.handle());

            kill_port_7432();
            std::thread::sleep(std::time::Duration::from_millis(200));

            let child = spawn_sidecar(app.handle(), &root);
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let child = window
                    .app_handle()
                    .state::<Sidecar>()
                    .0
                    .lock()
                    .unwrap()
                    .take();
                if let Some(mut c) = child {
                    let _ = c.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
