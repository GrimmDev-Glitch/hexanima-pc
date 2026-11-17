//! Civitai: búsqueda, ficha de modelo y descarga con progreso (igual que HexAnima Android).
//! La clave API solo se envía a hosts *.civitai.com; las redirecciones se siguen a mano
//! para que el servidor de almacenamiento nunca reciba credenciales.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::lora;

const API: &str = "https://civitai.com/api/v1";
static CANCEL: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("HexAnima")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())
}

fn is_civitai(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|h| h == "civitai.com" || h.ends_with(".civitai.com"))
}

/// GET siguiendo hasta 6 redirecciones; Authorization solo para civitai.com.
fn get(url: &str, key: Option<&str>) -> Result<reqwest::blocking::Response, String> {
    let c = client()?;
    let mut url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    for _ in 0..6 {
        let mut req = c.get(url.clone());
        if let (Some(k), true) = (key.filter(|k| !k.is_empty()), is_civitai(&url)) {
            req = req.bearer_auth(k);
        }
        let resp = req.send().map_err(|e| format!("Sin conexión con Civitai: {e}"))?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("Redirección sin destino")?;
            url = url.join(loc).map_err(|e| e.to_string())?;
            continue;
        }
        let st = resp.status().as_u16();
        if st == 401 || st == 403 {
            return Err(if key.is_some_and(|k| !k.is_empty()) {
                "Civitai denegó el acceso (revisa la clave API)".into()
            } else {
                "Este archivo requiere iniciar sesión: añade tu clave API de Civitai en Ajustes".into()
            });
        }
        if !resp.status().is_success() {
            return Err(format!("Civitai respondió {st}"));
        }
        let html = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"));
        if html {
            return Err("Civitai devolvió una página de inicio de sesión: se necesita una clave API".into());
        }
        return Ok(resp);
    }
    Err("Demasiadas redirecciones".into())
}

#[derive(Deserialize, Debug, Default)]
pub struct SearchParams {
    pub query: Option<String>,
    pub tag: Option<String>,
    pub types: Vec<String>,
    pub base_models: Vec<String>,
    pub sort: Option<String>,
    pub nsfw: bool,
    pub cursor: Option<String>,
}

pub fn search(p: &SearchParams, key: Option<&str>) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(&format!("{API}/models")).unwrap();
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("limit", "20");
        let text = p.query.as_deref().map(str::trim).unwrap_or("");
        if !text.is_empty() {
            q.append_pair("query", text);
        } else if let Some(s) = p.sort.as_deref().filter(|s| !s.is_empty()) {
            // Civitai solo ordena cuando no hay texto (como en el teléfono).
            q.append_pair("sort", s);
        }
        if let Some(t) = p.tag.as_deref().filter(|t| !t.is_empty()) {
            q.append_pair("tag", t);
        }
        for t in &p.types {
            q.append_pair("types", t);
        }
        for b in &p.base_models {
            q.append_pair("baseModels", b);
        }
        q.append_pair("nsfw", if p.nsfw { "true" } else { "false" });
        if let Some(c) = p.cursor.as_deref().filter(|c| !c.is_empty()) {
            q.append_pair("cursor", c);
        }
    }
    get(url.as_str(), key)?.json::<Value>().map_err(|e| format!("Respuesta no válida: {e}"))
}

pub fn model(id: u64, key: Option<&str>) -> Result<Value, String> {
    get(&format!("{API}/models/{id}"), key)?.json::<Value>().map_err(|e| format!("Respuesta no válida: {e}"))
}

#[derive(Deserialize, Debug)]
pub struct DownloadReq {
    /// Identificador para el progreso y la cancelación (p. ej. el id de la versión).
    pub id: String,
    pub url: String,
    /// "lora" | "checkpoint" | "diffusion_model"
    pub kind: String,
    /// Nombre del archivo (se normaliza como en el teléfono).
    pub file_name: String,
    /// Datos para el .json: name, version, model_id, version_id, type, base, words, preview, nsfw, tags
    pub meta: Map<String, Value>,
}

/// Guarda la imagen de vista previa como `<stem>.preview.jpeg` junto al modelo (450 px).
fn save_preview(model_path: &Path, url: &str) {
    if url.is_empty() || url.ends_with(".mp4") || url.ends_with(".webm") {
        return;
    }
    let small = regex_width(url);
    let Some(stem) = model_path.file_stem() else { return };
    let dst = model_path.with_file_name(format!("{}.preview.jpeg", stem.to_string_lossy()));
    if let Ok(mut r) = get(&small, None) {
        let mut buf = Vec::new();
        if r.read_to_end(&mut buf).is_ok() && buf.len() > 512 {
            let _ = fs::write(dst, buf);
        }
    }
}

/// /width=N/ u /original=true/ -> /width=450/ (miniatura liviana).
fn regex_width(url: &str) -> String {
    for pat in ["/original=true/"] {
        if let Some(i) = url.find(pat) {
            return format!("{}/width=450/{}", &url[..i], &url[i + pat.len()..]);
        }
    }
    if let Some(i) = url.find("/width=") {
        if let Some(j) = url[i + 1..].find('/') {
            return format!("{}/width=450{}", &url[..i], &url[i + 1 + j..]);
        }
    }
    url.to_string()
}

/// Busca un LoRA local en Civitai por su SHA256 y completa su .json y su vista previa.
/// No pisa lo que el usuario editó (nombre visible, categoría, activadoras propias).
pub fn fetch_info(root: &Path, file: &str, key: Option<&str>) -> Result<Value, String> {
    let p = lora::resolve(root, file)?;
    let hash = lora::sha256(&p)?;
    let mut m = lora::read_sidecar(&p);
    let resp = get(&format!("{API}/model-versions/by-hash/{hash}"), key);
    let v: Value = match resp {
        Ok(r) => r.json().map_err(|e| e.to_string())?,
        Err(e) if e.contains("404") => {
            m.insert("civitai_checked".into(), json!("not_found"));
            m.insert("sha256".into(), json!(hash));
            lora::write_sidecar(&p, &m)?;
            return Ok(json!({ "found": false }));
        }
        Err(e) => return Err(e),
    };
    let model = v.get("model").cloned().unwrap_or(Value::Null);
    let set = |m: &mut Map<String, Value>, k: &str, val: Value| {
        if !val.is_null() {
            m.insert(k.into(), val);
        }
    };
    set(&mut m, "name", model.get("name").cloned().unwrap_or(Value::Null));
    set(&mut m, "type", model.get("type").cloned().unwrap_or(Value::Null));
    set(&mut m, "nsfw", model.get("nsfw").cloned().unwrap_or(Value::Null));
    set(&mut m, "version", v.get("name").cloned().unwrap_or(Value::Null));
    set(&mut m, "model_id", v.get("modelId").cloned().unwrap_or(Value::Null));
    set(&mut m, "version_id", v.get("id").cloned().unwrap_or(Value::Null));
    set(&mut m, "base", v.get("baseModel").cloned().unwrap_or(Value::Null));
    let has_words = m.get("words").and_then(|w| w.as_array()).is_some_and(|a| !a.is_empty());
    if !has_words {
        set(&mut m, "words", v.get("trainedWords").cloned().unwrap_or(Value::Null));
    }
    let img = v
        .get("images")
        .and_then(|a| a.as_array())
        .and_then(|a| a.iter().find(|i| i.get("type").and_then(|t| t.as_str()) != Some("video")))
        .and_then(|i| i.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    if !img.is_empty() {
        m.insert("preview".into(), json!(img));
    }
    // Etiquetas del modelo (para deducir la categoría como el teléfono)
    if let Some(id) = v.get("modelId").and_then(|x| x.as_u64()) {
        if let Ok(full) = model_info(id, key) {
            set(&mut m, "tags", full.get("tags").cloned().unwrap_or(Value::Null));
        }
    }
    m.insert("civitai_checked".into(), json!("ok"));
    m.insert("sha256".into(), json!(hash));
    lora::write_sidecar(&p, &m)?;
    if lora::local_preview(&p).is_none() {
        save_preview(&p, &img);
    }
    Ok(json!({ "found": true, "name": m.get("name") }))
}

fn model_info(id: u64, key: Option<&str>) -> Result<Value, String> {
    model(id, key)
}

/// Modelos para "Ampliar" (como el teléfono: Rápido / Detallado). Solo estos enlaces fijos.
pub const UPSCALERS: [(&str, &str, &str); 2] = [
    ("fast", "RealESRGAN_x4plus_anime_6B.pth", "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth"),
    ("detail", "4x-UltraSharp.pth", "https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth"),
];

pub fn upscaler_status(root: &Path) -> Value {
    let d = root.join("models").join("upscalers");
    json!(UPSCALERS.iter().map(|(k, f, _)| json!({ "kind": k, "file": f, "stem": f.trim_end_matches(".pth"), "installed": d.join(f).is_file() })).collect::<Vec<_>>())
}

pub fn upscaler_download(app: &AppHandle, root: &Path, kind: &str) -> Result<String, String> {
    let (_, file, url) = UPSCALERS.iter().find(|(k, _, _)| *k == kind).ok_or("Ampliador desconocido")?;
    let d = root.join("models").join("upscalers");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let part = d.join(format!("{file}.part"));
    let id = format!("up-{kind}");
    let mut resp = get(url, None)?;
    let total = resp.content_length().unwrap_or(0);
    let mut out = File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    let mut last = Instant::now();
    loop {
        let n = resp.read(&mut buf).map_err(|e| { let _ = fs::remove_file(&part); format!("Falló la descarga: {e}") })?;
        if n == 0 { break; }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            let _ = app.emit("dl-progress", json!({ "id": id, "done": done, "total": total, "state": "downloading" }));
            last = Instant::now();
        }
    }
    drop(out);
    if total > 0 && done < total {
        let _ = fs::remove_file(&part);
        return Err("La descarga se cortó antes de terminar".into());
    }
    fs::rename(&part, d.join(file)).map_err(|e| e.to_string())?;
    let _ = app.emit("dl-progress", json!({ "id": id, "done": done, "total": total, "state": "done" }));
    Ok(file.to_string())
}

fn dest_dir(root: &Path, kind: &str) -> PathBuf {
    match kind {
        "checkpoint" => root.join("models").join("checkpoints"),
        "diffusion_model" => root.join("models").join("diffusion_models"),
        _ => lora::dir(root),
    }
}

fn cancelled(id: &str) -> bool {
    CANCEL.lock().unwrap().as_ref().is_some_and(|s| s.contains(id))
}

pub fn cancel(id: &str) {
    CANCEL.lock().unwrap().get_or_insert_with(HashSet::new).insert(id.to_string());
}

/// Descarga a `<destino>/<nombre>.part`, emite "dl-progress" y renombra al terminar.
pub fn download(app: &AppHandle, root: &Path, req: DownloadReq, key: Option<String>) -> Result<String, String> {
    CANCEL.lock().unwrap().get_or_insert_with(HashSet::new).remove(&req.id);
    let dir = dest_dir(root, &req.kind);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = if req.file_name.to_lowercase().ends_with(".gguf") { "gguf" } else { "safetensors" };
    let stem = lora::file_name(req.file_name.trim_end_matches(".gguf").trim_end_matches(".safetensors"));
    let final_path = dir.join(format!("{stem}.{ext}"));
    let part = dir.join(format!("{stem}.{ext}.part"));

    let emit = |done: u64, total: u64, state: &str, extra: Value| {
        let _ = app.emit("dl-progress", json!({ "id": req.id, "done": done, "total": total, "state": state, "extra": extra }));
    };

    let mut resp = get(&req.url, key.as_deref())?;
    let total = resp.content_length().unwrap_or(0);
    let mut out = File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    let mut last = Instant::now();
    emit(0, total, "downloading", Value::Null);
    loop {
        if cancelled(&req.id) {
            drop(out);
            let _ = fs::remove_file(&part);
            emit(done, total, "cancelled", Value::Null);
            return Err("Descarga cancelada".into());
        }
        let n = match resp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                drop(out);
                let _ = fs::remove_file(&part);
                emit(done, total, "failed", Value::Null);
                return Err(format!("Falló la descarga: {e}"));
            }
        };
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            emit(done, total, "downloading", Value::Null);
            last = Instant::now();
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && done < total {
        let _ = fs::remove_file(&part);
        emit(done, total, "failed", Value::Null);
        return Err("La descarga se cortó antes de terminar".into());
    }
    if final_path.exists() {
        let _ = fs::remove_file(&final_path);
    }
    fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
    let mut meta = req.meta.clone();
    meta.retain(|_, v| !v.is_null());
    lora::write_sidecar(&final_path, &meta)?;
    if let Some(u) = meta.get("preview").and_then(|v| v.as_str()) {
        save_preview(&final_path, u);
    }
    let rel = final_path.strip_prefix(&dir).unwrap_or(&final_path).to_string_lossy().replace('\\', "/");
    emit(done, total.max(done), "done", json!({ "file": rel, "stem": stem, "kind": req.kind }));
    Ok(rel)
}
