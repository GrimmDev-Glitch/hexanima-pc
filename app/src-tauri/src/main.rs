// HexAnima PC: ventana Tauri + motor stable-diffusion.cpp local (sd-server.exe).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod civitai;
mod engine_dl;
mod gallery;
mod hw;
mod lora;
mod server;
mod yolo;

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
    // Motores instalados (la app usa CUDA para Anima si está, y el de la gráfica para el resto).
    let engines: Vec<&str> = ["torch", "vulkan", "cuda", "cpu"]
        .into_iter()
        .filter(|e| server::engine_installed(&state.root, e))
        .collect();
    json!({
        "root": state.root.display().to_string(),
        "hardware": hw.clone(),
        "version": env!("CARGO_PKG_VERSION"),
        "engines": engines,
        "torch_cuda": engine_dl::installed_cuda(&state.root),
        "debug": cfg!(debug_assertions),
    })
}

#[tauri::command]
fn memory() -> hw::Memory {
    hw::memory()
}

/// Arranca (o reinicia) el motor. Devuelve el puerto local.
#[tauri::command]
fn start_server(state: State<AppState>, opts: Option<server::ServerOpts>, engine: Option<String>) -> Result<serde_json::Value, String> {
    let hw = {
        let mut g = state.hw.lock().unwrap();
        if g.is_none() {
            *g = Some(hw::detect(&state.root));
        }
        g.clone().unwrap()
    };
    // Motor pedido (p. ej. CUDA para Anima: su VAE es mucho más rápido ahí) si está instalado;
    // si no, el detectado para la gráfica.
    let wanted = engine.filter(|e| server::engine_installed(&state.root, e));
    let (eng, device) = match wanted {
        Some(e) if e == "torch" => (e, None),
        Some(e) if e != hw.engine => {
            let d = hw::engine_device(&state.root, &e, hw.gpu.as_ref());
            (e, d)
        }
        _ => (hw.engine.clone(), hw.backend_device.clone()),
    };
    let mut srv = state.server.lock().unwrap();
    if let Some(mut s) = srv.take() {
        s.stop();
    }
    let s = server::Server::start(&state.root, &eng, device.as_deref(), &opts.unwrap_or_default())?;
    let port = s.port;
    *srv = Some(s);
    Ok(json!({ "port": port, "engine": eng, "device": device }))
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
fn save_image(state: State<AppState>, b64: String, prefix: Option<String>, meta: Option<serde_json::Value>) -> Result<String, String> {
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
    // Ajustes completos al lado (como la galería del teléfono): permiten "Usar estos ajustes".
    if let Some(serde_json::Value::Object(m)) = meta {
        let _ = gallery::write_json(&path, &m);
    }
    Ok(path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
}

#[tauri::command]
fn gallery_list(state: State<AppState>) -> Result<serde_json::Value, String> {
    gallery::list(&state.root)
}

#[tauri::command]
fn gallery_fav(state: State<AppState>, name: String, fav: bool) -> Result<(), String> {
    gallery::set_fav(&state.root, &name, fav)
}

#[tauri::command]
fn gallery_trash(state: State<AppState>, names: Vec<String>) -> Result<usize, String> {
    gallery::trash(&state.root, &names)
}

/// Exportar imágenes del historial a un .zip (PNG + su .json de ajustes). Devuelve la ruta o None si se cancela.
#[tauri::command]
async fn gallery_zip(app: tauri::AppHandle, state: State<'_, AppState>, names: Vec<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if names.is_empty() {
        return Err("No hay imágenes seleccionadas".into());
    }
    let default = format!("HexAnima-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M"));
    let Some(f) = app.dialog().file().set_title("Exportar imágenes en ZIP").set_file_name(&default).add_filter("ZIP", &["zip"]).blocking_save_file() else {
        return Ok(None);
    };
    let dest = f.into_path().map_err(|e| e.to_string())?;
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || gallery::zip(&root, &names, &dest).map(|_| Some(dest.to_string_lossy().into_owned())))
        .await
        .map_err(|e| e.to_string())?
}

/// "Cargar ajustes desde un PNG": selector de archivos y lectura de sus metadatos.
#[tauri::command]
async fn png_pick_settings(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(f) = app.dialog().file().set_title("Cargar ajustes desde un PNG").add_filter("PNG", &["png"]).blocking_pick_file() else {
        return Ok(None);
    };
    let p = f.into_path().map_err(|e| e.to_string())?;
    gallery::settings_from_png(&p).map(Some)
}

/// Pequeños almacenes JSON de la app en config/ (plantillas, etc.). Solo nombres conocidos.
fn store_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    const KEYS: [&str; 5] = ["config-templates", "negatives", "model-names", "settings", "civitai-collections"];
    if !KEYS.contains(&key) {
        return Err("Clave no permitida".into());
    }
    let d = root.join("config");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join(format!("{key}.json")))
}

#[tauri::command]
fn store_get(state: State<AppState>, key: String) -> Result<serde_json::Value, String> {
    let p = store_path(&state.root, &key)?;
    Ok(std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn store_set(state: State<AppState>, key: String, value: serde_json::Value) -> Result<(), String> {
    let p = store_path(&state.root, &key)?;
    std::fs::write(p, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Tamaño de los archivos de models/ (para las tarjetas del selector de modelo).
#[tauri::command]
fn model_sizes(state: State<AppState>) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for d in ["checkpoints", "diffusion_models", "text_encoders", "vae"] {
        if let Ok(rd) = std::fs::read_dir(state.root.join("models").join(d)) {
            for e in rd.flatten() {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        out.insert(format!("{d}/{}", e.file_name().to_string_lossy()), json!(m.len()));
                    }
                }
            }
        }
    }
    serde_json::Value::Object(out)
}

/// ＋ Importar modelo, paso 1: elegir el archivo y detectar su familia por los tensores.
#[tauri::command]
async fn model_pick(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(f) = app.dialog().file().set_title("Importar un modelo").add_filter("Modelo", &["safetensors", "gguf"]).blocking_pick_file() else {
        return Ok(None);
    };
    let src = f.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let kind = lora::model_kind(&src);
        Ok(Some(json!({
            "path": src.display().to_string(),
            "name": src.file_name().map(|n| n.to_string_lossy().to_string()),
            "bytes": std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0),
            "kind": kind,
        })))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ＋ Importar modelo, paso 2: copia a models/checkpoints (SDXL) o models/diffusion_models (el resto).
/// El nombre lleva la familia (anima, mage, qwen-image, moss) porque la app agrupa los modelos por él.
#[tauri::command]
async fn model_import(app: tauri::AppHandle, path: String, kind: String) -> Result<String, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::PathBuf::from(&path);
        let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !src.is_file() || !(ext == "safetensors" || ext == "gguf") {
            return Err("El archivo no es un .safetensors ni un .gguf".into());
        }
        let (folder, tag) = match kind.as_str() {
            "sdxl" => ("checkpoints", ""),
            "anima" => ("diffusion_models", "anima"),
            "mage" => ("diffusion_models", "mage"),
            "qwen-image" => ("diffusion_models", "qwen-image"),
            "moss" => ("diffusion_models", "moss"),
            _ => return Err("Familia desconocida".into()),
        };
        let dir = root.join("models").join(folder);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut name = src.file_name().ok_or("archivo")?.to_string_lossy().to_string();
        let low = name.to_lowercase().replace('_', "-");
        if !tag.is_empty() && !low.contains(tag) {
            name = format!("{tag}-{name}");
        }
        let dst = dir.join(&name);
        if dst.exists() {
            return Err("Ya hay un modelo con ese nombre".into());
        }
        let part = dir.join(format!("{name}.part"));
        std::fs::copy(&src, &part).map_err(|e| { let _ = std::fs::remove_file(&part); e.to_string() })?;
        std::fs::rename(&part, &dst).map_err(|e| e.to_string())?;
        Ok(format!("{folder}/{name}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Importar un VAE (.safetensors) a models/vae.
#[tauri::command]
async fn vae_import(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(f) = app.dialog().file().set_title("Importar un VAE").add_filter("VAE", &["safetensors", "pt", "ckpt"]).blocking_pick_file() else {
        return Ok(None);
    };
    let src = f.into_path().map_err(|e| e.to_string())?;
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root.join("models").join("vae");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = src.file_name().ok_or("archivo")?.to_owned();
        let dst = dir.join(&name);
        if dst.exists() {
            return Err("Ya hay un VAE con ese nombre".into());
        }
        // mismo disco: enlace duro (no ocupa espacio extra); si no, copia
        if std::fs::hard_link(&src, &dst).is_err() {
            std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
        Ok(Some(format!("vae/{}", name.to_string_lossy())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn asset_status(state: State<AppState>) -> serde_json::Value {
    civitai::asset_status(&state.root)
}

#[tauri::command]
async fn asset_download(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || civitai::asset_download(&app, &root, &kind))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Motor PyTorch: descarga desde Hugging Face (bienvenida / Ajustes) ----------
#[tauri::command]
async fn engine_dl_info(app: tauri::AppHandle, cu128: Option<bool>) -> serde_json::Value {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let remote = engine_dl::remote(cu128.unwrap_or(false));
        json!({
            "installed": engine_dl::installed(&root),
            "installed_cuda": engine_dl::installed_cuda(&root),
            "remote": remote.as_ref().ok(),
            "error": remote.as_ref().err(),
            "free_bytes": engine_dl::free_bytes(&root),
            "partial_bytes": std::fs::metadata(root.join("engine").join("torch-download.zip.part")).map(|m| m.len()).unwrap_or(0),
        })
    })
    .await
    .unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

#[tauri::command]
async fn engine_download(app: tauri::AppHandle, cu128: Option<bool>) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let m = engine_dl::remote(cu128.unwrap_or(false))?;
        let a2 = app.clone();
        engine_dl::install(&root, &m, &mut |stage, done, total| {
            let _ = app.emit("dl-progress", json!({ "id": "engine-torch", "stage": stage, "done": done, "total": total }));
        }, &mut || {
            // el motor PyTorch abierto tiene sus archivos en uso: pararlo antes de cambiar la carpeta
            if let Some(mut s) = a2.state::<AppState>().server.lock().unwrap().take() { s.stop(); }
        })?;
        Ok(json!({ "version": m.version }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn pack_status(state: State<AppState>) -> serde_json::Value {
    engine_dl::pack_status(&state.root)
}

#[tauri::command]
async fn pack_download(app: tauri::AppHandle, pack: String) -> Result<(), String> {
    use tauri::Emitter;
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = format!("pack-{pack}");
        engine_dl::pack_download(&root, &pack, &mut |done, total| {
            let _ = app.emit("dl-progress", json!({ "id": id, "stage": "download", "done": done, "total": total }));
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn engine_dl_cancel() {
    engine_dl::CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn upscaler_status(state: State<AppState>) -> serde_json::Value {
    civitai::upscaler_status(&state.root)
}

#[tauri::command]
async fn upscaler_download(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || civitai::upscaler_download(&app, &root, &kind))
        .await
        .map_err(|e| e.to_string())?
}

/// Cajas que encontró el detector de ADetailer en el último trabajo (se leen del registro del motor).
/// `seq` cuenta las detecciones del registro: si no cambia, el trabajo no detectó nada nuevo.
#[tauri::command]
fn ad_detections(state: State<AppState>) -> serde_json::Value {
    let log = state.server.lock().unwrap().as_ref().map(|s| s.log_path.clone());
    let text = log.and_then(|p| std::fs::read(p).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let seq = lines.iter().filter(|l| l.contains("ADetailer detected")).count();
    let start = lines.iter().rposition(|l| l.contains("ADetailer detected")).unwrap_or(lines.len());
    let num = |l: &str, k: &str| -> Option<f64> {
        let i = l.find(k)? + k.len();
        let rest = &l[i..];
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(rest.len());
        rest[..end].parse().ok()
    };
    let items: Vec<serde_json::Value> = lines[start..]
        .iter()
        .filter(|l| l.contains("ADetailer detection "))
        .filter_map(|l| {
            let obj = l.split("object=").nth(1)?.split(',').next()?.to_string();
            Some(json!({ "object": obj, "confidence": num(l, "confidence=")?, "x1": num(l, "x1=")?, "y1": num(l, "y1=")?, "x2": num(l, "x2=")?, "y2": num(l, "y2=")? }))
        })
        .collect();
    json!({ "seq": seq, "items": items })
}

/// Detectores de ADetailer (caras / manos) instalados.
#[tauri::command]
fn detector_status(state: State<AppState>) -> serde_json::Value {
    yolo::status(&state.root)
}

/// Descarga el detector YOLOv8 y lo convierte al formato del motor (unos 6 MB).
#[tauri::command]
async fn detector_install(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || yolo::install(&app, &root, &kind))
        .await
        .map_err(|e| e.to_string())?
}

/// Muestra la imagen seleccionada en el Explorador.
#[tauri::command]
fn gallery_reveal(state: State<AppState>, name: String) -> Result<(), String> {
    let p = gallery::resolve(&state.root, &name)?;
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", p.display()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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

// ---------- LoRAs ----------

#[tauri::command]
fn lora_list(state: State<AppState>) -> serde_json::Value {
    lora::list(&state.root)
}

#[tauri::command]
fn lora_set_meta(state: State<AppState>, file: String, patch: lora::MetaPatch) -> Result<(), String> {
    lora::set_meta(&state.root, &file, patch)
}

#[tauri::command]
fn lora_trash(state: State<AppState>, file: String) -> Result<(), String> {
    lora::trash(&state.root, &file)
}

#[tauri::command]
fn lora_folders(state: State<AppState>) -> Vec<String> {
    lora::folders(&state.root)
}

#[tauri::command]
fn lora_make_folder(state: State<AppState>, name: String) -> Result<String, String> {
    lora::make_folder(&state.root, &name)
}

#[tauri::command]
fn lora_move(state: State<AppState>, file: String, folder: String) -> Result<String, String> {
    lora::move_to(&state.root, &file, &folder)
}

#[tauri::command]
fn lora_presets_get(state: State<AppState>) -> serde_json::Value {
    lora::presets_get(&state.root)
}

#[tauri::command]
fn lora_presets_set(state: State<AppState>, presets: serde_json::Value) -> Result<(), String> {
    lora::presets_set(&state.root, &presets)
}

/// Datos de Civitai por SHA256 para un LoRA local (en un hilo aparte).
#[tauri::command]
async fn lora_fetch_info(app: tauri::AppHandle, file: String, key: Option<String>) -> Result<serde_json::Value, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || civitai::fetch_info(&root, &file, key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Selector de archivos de Windows para importar LoRAs (async: el diálogo no bloquea la ventana).
#[tauri::command]
async fn lora_import(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Importar LoRAs")
        .add_filter("LoRA", &["safetensors", "gguf"])
        .blocking_pick_files();
    let Some(files) = picked else { return Ok(serde_json::json!({ "imported": [], "failed": [] })) };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || lora::import(&root, &paths))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn downloaded_index(state: State<AppState>) -> serde_json::Value {
    lora::downloaded_index(&state.root)
}

// ---------- Civitai (red en hilos aparte para no congelar la ventana) ----------

#[tauri::command]
async fn civitai_search(params: civitai::SearchParams, key: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || civitai::search(&params, key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn civitai_model(id: u64, key: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || civitai::model(id, key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn civitai_download(app: tauri::AppHandle, req: civitai::DownloadReq, key: Option<String>) -> Result<String, String> {
    let root = app.state::<AppState>().root.clone();
    tauri::async_runtime::spawn_blocking(move || civitai::download(&app, &root, req, key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn civitai_cancel(id: String) {
    civitai::cancel(&id);
}

/// Abre un enlace de Civitai en el navegador del sistema (solo civitai.com / civitai.red).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let allowed_host = ["https://civitai.com/", "https://civitai.red/"].iter().any(|p| url.starts_with(p));
    let safe_chars = url.chars().all(|c| c.is_ascii_alphanumeric() || "/:._-?=&%".contains(c));
    if !allowed_host || !safe_chars || url.len() > 300 {
        return Err("Enlace no permitido".into());
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre una carpeta de la app en el Explorador (outputs, models, loras, logs).
#[tauri::command]
fn open_folder(state: State<AppState>, which: String) -> Result<(), String> {
    let p = safe_path(&state.root, &which)?;
    let _ = std::fs::create_dir_all(&p);
    std::process::Command::new("explorer").arg(p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Ruta dentro de las carpetas de la app ("loras/Personajes", "models/checkpoints"…), sin salirse de ellas.
fn safe_path(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let ok_root = ["outputs", "models", "loras", "logs", "config"];
    if parts.is_empty() || !ok_root.contains(&parts[0]) {
        return Err("Carpeta no permitida".into());
    }
    if parts.iter().any(|s| *s == ".." || *s == "." || s.contains(':')) {
        return Err("Ruta no válida".into());
    }
    Ok(parts.iter().fold(root.to_path_buf(), |p, s| p.join(s)))
}

/// Muestra un archivo de models/ o loras/ seleccionado en el Explorador.
#[tauri::command]
fn reveal_file(state: State<AppState>, path: String) -> Result<(), String> {
    let p = safe_path(&state.root, &path)?;
    if !p.is_file() {
        return Err("El archivo no existe".into());
    }
    std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { root: find_root(), hw: Mutex::new(None), server: Mutex::new(None) })
        .setup(|app| {
            // Miniaturas del Historial servidas directamente desde outputs/ (solo esa carpeta).
            let out = app.state::<AppState>().root.join("outputs");
            let _ = std::fs::create_dir_all(&out);
            let _ = app.asset_protocol_scope().allow_directory(&out, false);
            // Vistas previas de los LoRAs (imágenes junto a cada archivo, en subcarpetas también).
            let loras = app.state::<AppState>().root.join("loras");
            let _ = std::fs::create_dir_all(&loras);
            let _ = app.asset_protocol_scope().allow_directory(&loras, true);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gallery_list,
            gallery_fav,
            gallery_trash,
            gallery_zip,
            gallery_reveal,
            png_pick_settings,
            store_get,
            store_set,
            model_sizes,
            model_pick,
            model_import,
            upscaler_status,
            vae_import,
            asset_status,
            asset_download,
            engine_dl_info,
            engine_download,
            engine_dl_cancel,
            pack_status,
            pack_download,
            upscaler_download,
            detector_status,
            ad_detections,
            detector_install,
            lora_list,
            lora_set_meta,
            lora_trash,
            lora_import,
            lora_folders,
            lora_make_folder,
            lora_move,
            lora_presets_get,
            lora_presets_set,
            lora_fetch_info,
            downloaded_index,
            civitai_search,
            civitai_model,
            civitai_download,
            civitai_cancel,
            open_url,
            app_info,
            memory,
            start_server,
            server_status,
            save_image,
            output_files,
            read_output,
            set_console_visible,
            open_folder,
            reveal_file
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
