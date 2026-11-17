// HexAnima PC: ventana Tauri + motor stable-diffusion.cpp local (sd-server.exe).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hw;
mod server;

use base64::Engine as _;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

struct AppState {
    root: PathBuf,
    hw: Mutex<Option<hw::Hardware>>,
    server: Mutex<Option<server::Server>>,
}

/// Carpeta de la app: la del .exe. En desarrollo (exe dentro de app/src-tauri/target)
/// sube hasta encontrar engine/ y models/.
fn find_root() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let mut d = Some(exe_dir.as_path());
    while let Some(p) = d {
        if p.join("engine").is_dir() && p.join("models").is_dir() {
            return p.to_path_buf();
        }
        d = p.parent();
    }
    exe_dir
}

#[tauri::command]
fn app_info(state: State<AppState>) -> serde_json::Value {
    let mut hw = state.hw.lock().unwrap();
    if hw.is_none() {
        *hw = Some(hw::detect(&state.root));
    }
    json!({
        "root": state.root.display().to_string(),
        "hardware": hw.clone(),
        "version": env!("CARGO_PKG_VERSION"),
        "debug": cfg!(debug_assertions),
    })
}

#[tauri::command]
fn memory() -> hw::Memory {
    hw::memory()
}

/// Arranca (o reinicia) el motor. Devuelve el puerto local.
#[tauri::command]
fn start_server(state: State<AppState>, opts: Option<server::ServerOpts>) -> Result<u16, String> {
    let hw = {
        let mut g = state.hw.lock().unwrap();
        if g.is_none() {
            *g = Some(hw::detect(&state.root));
        }
        g.clone().unwrap()
    };
    let mut srv = state.server.lock().unwrap();
    if let Some(mut s) = srv.take() {
        s.stop();
    }
    let s = server::Server::start(
        &state.root,
        &hw.engine,
        hw.backend_device.as_deref(),
        &opts.unwrap_or_default(),
    )?;
    let port = s.port;
    *srv = Some(s);
    Ok(port)
}

#[tauri::command]
fn server_status(state: State<AppState>) -> serde_json::Value {
    let mut srv = state.server.lock().unwrap();
    match srv.as_mut() {
        Some(s) => json!({ "running": s.alive(), "port": s.port, "log": server::log_tail(&s.log_path, 12) }),
        None => json!({ "running": false }),
    }
}

/// Guarda la imagen (PNG en base64, con metadatos ya incrustados por el motor) en outputs/.
#[tauri::command]
fn save_image(state: State<AppState>, b64: String, prefix: Option<String>) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| e.to_string())?;
    let dir = state.root.join("outputs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let p = prefix.unwrap_or_else(|| "img".into());
    let mut path = dir.join(format!("{stamp}-{p}.png"));
    let mut i = 1;
    while path.exists() {
        path = dir.join(format!("{stamp}-{p}-{i}.png"));
        i += 1;
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Lista PNG de outputs por nombre y tamaño; el contenido se carga solo al seleccionar uno.
#[tauri::command]
fn output_files(state: State<AppState>) -> Result<serde_json::Value, String> {
    let dir = state.root.join("outputs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png")) {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            files.push(json!({ "name": entry.file_name().to_string_lossy(), "bytes": meta.len() }));
        }
    }
    files.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(json!(files))
}

/// Lee solo un PNG cuyo nombre simple pertenezca a outputs/.
#[tauri::command]
fn read_output(state: State<AppState>, name: String) -> Result<String, String> {
    let relative = Path::new(&name);
    if relative.file_name().and_then(|x| x.to_str()) != Some(name.as_str())
        || !relative.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png"))
    {
        return Err("Nombre de imagen no válido".into());
    }
    let base = state.root.join("outputs").canonicalize().map_err(|e| e.to_string())?;
    let path = base.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&base) || !path.is_file() {
        return Err("La imagen no pertenece a outputs".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(windows)]
fn set_console_visibility(visible: bool, allocate: bool) {
    use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW};
    unsafe {
        let mut window = GetConsoleWindow();
        if window.is_null() && visible && allocate {
            let _ = AllocConsole();
            window = GetConsoleWindow();
        }
        if !window.is_null() {
            ShowWindow(window, if visible { SW_SHOW } else { SW_HIDE });
        }
    }
}

#[cfg(not(windows))]
fn set_console_visibility(_visible: bool, _allocate: bool) {}

/// Solo en desarrollo: el .exe final usa el subsistema "windows" y no tiene consola,
/// así que crear una (AllocConsole) abriría una ventana CMD vacía.
#[tauri::command]
fn set_console_visible(visible: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        set_console_visibility(visible, false);
    }
    Ok(())
}

/// Abre una carpeta de la app en el Explorador (outputs, models, loras, logs).
#[tauri::command]
fn open_folder(state: State<AppState>, which: String) -> Result<(), String> {
    let allowed = ["outputs", "models", "loras", "logs"];
    if !allowed.contains(&which.as_str()) {
        return Err("Carpeta no permitida".into());
    }
    let p = state.root.join(&which);
    let _ = std::fs::create_dir_all(&p);
    std::process::Command::new("explorer").arg(p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState { root: find_root(), hw: Mutex::new(None), server: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            app_info,
            memory,
            start_server,
            server_status,
            save_image,
            output_files,
            read_output,
            set_console_visible,
            open_folder
        ])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar HexAnima");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Cerrar el motor al salir (el job object lo garantiza aunque la app se cuelgue).
            if let Some(mut s) = handle.state::<AppState>().server.lock().unwrap().take() {
                s.stop();
            }
            if cfg!(debug_assertions) {
                set_console_visibility(true, false);
            }
        }
    });
}
