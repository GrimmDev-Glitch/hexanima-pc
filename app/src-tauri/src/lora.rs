//! Biblioteca de LoRAs, con el mismo formato que HexAnima Android: cada LoRA puede tener
//! un `<stem>.json` al lado con `name`, `alias`, `cat`, `words`, `base`, `model_id`,
//! `version_id`, `preview`, `nsfw`, `tags`. Así los LoRAs se pueden pasar del teléfono a la PC.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const EXTS: [&str; 2] = ["safetensors", "gguf"];
/// Categorías del teléfono, en orden de prioridad para deducirlas de las etiquetas de Civitai.
pub const CATS: [&str; 7] = ["character", "clothing", "poses", "style", "concept", "background", "objects"];

pub fn dir(root: &Path) -> PathBuf {
    root.join("loras")
}

fn rel(base: &Path, p: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Nombre de archivo como en el teléfono: [^A-Za-z0-9._-]+ -> "_".
pub fn file_name(name: &str) -> String {
    let stem = name.trim().trim_end_matches(".safetensors");
    let mut out = String::new();
    let mut last_us = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() { "lora".into() } else { out.chars().take(120).collect() }
}

/// Valida que el nombre relativo quede dentro de loras/ y sea un LoRA existente.
pub fn resolve(root: &Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty() || file.contains("..") || Path::new(file).is_absolute() || file.contains(':') {
        return Err("Nombre de LoRA no válido".into());
    }
    let p = dir(root).join(file);
    let ext_ok = p.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTS.contains(&e.to_lowercase().as_str()));
    if !ext_ok || !p.is_file() {
        return Err("El LoRA no existe".into());
    }
    Ok(p)
}

pub fn sidecar(p: &Path) -> PathBuf {
    p.with_extension("json")
}

pub fn read_sidecar(p: &Path) -> Map<String, Value> {
    fs::read_to_string(sidecar(p))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn write_sidecar(p: &Path, m: &Map<String, Value>) -> Result<(), String> {
    let s = serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|e| e.to_string())?;
    fs::write(sidecar(p), s).map_err(|e| e.to_string())
}

/// Cabecera de un .safetensors (solo los primeros KB, no los pesos).
fn header(p: &Path) -> Option<Map<String, Value>> {
    let mut f = File::open(p).ok()?;
    let mut len = [0u8; 8];
    f.read_exact(&mut len).ok()?;
    let n = u64::from_le_bytes(len);
    if n == 0 || n > 64 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).ok()?;
    serde_json::from_slice::<Value>(&buf).ok()?.as_object().cloned()
}

/// Familia del LoRA por los nombres de sus tensores: SDXL (dos codificadores de texto,
/// bloques input/output) o Anima (DiT con adaLN/LLM). None si no se reconoce.
fn detect_base(h: &Map<String, Value>) -> Option<&'static str> {
    let keys: Vec<&String> = h.keys().filter(|k| *k != "__metadata__").collect();
    let any = |pat: &[&str]| keys.iter().any(|k| pat.iter().any(|p| k.contains(p)));
    if any(&["lora_te2_", "te2.", "input_blocks", "output_blocks", "down_blocks", "conditioner.embedders.1"]) {
        return Some("SDXL");
    }
    if any(&["adaln", "llm_adapter", "llm.", "t_embedder", "x_embedder", "net.blocks", "final_layer"]) {
        return Some("Anima");
    }
    if any(&["double_blocks", "single_blocks"]) {
        return Some("Flux");
    }
    None
}

/// Nombres de los tensores de un .safetensors o un .gguf (sin el prefijo model.diffusion_model.).
pub fn tensor_names(p: &Path) -> Vec<String> {
    let strip = |k: &str| k.strip_prefix("model.diffusion_model.").unwrap_or(k).to_string();
    if let Some(n) = gguf_names(p) {
        return n.iter().map(|k| strip(k)).collect();
    }
    header(p).map(|h| h.keys().filter(|k| *k != "__metadata__").map(|k| strip(k)).collect()).unwrap_or_default()
}

/// Lee la cabecera de un GGUF (v2/v3): salta los metadatos y devuelve los nombres de los tensores.
fn gguf_names(p: &Path) -> Option<Vec<String>> {
    use std::io::BufReader;
    let mut f = BufReader::with_capacity(1 << 20, File::open(p).ok()?);
    let mut b4 = [0u8; 4];
    f.read_exact(&mut b4).ok()?;
    if &b4 != b"GGUF" {
        return None;
    }
    fn u32_(f: &mut impl Read) -> Option<u32> { let mut b = [0u8; 4]; f.read_exact(&mut b).ok()?; Some(u32::from_le_bytes(b)) }
    fn u64_(f: &mut impl Read) -> Option<u64> { let mut b = [0u8; 8]; f.read_exact(&mut b).ok()?; Some(u64::from_le_bytes(b)) }
    fn skip(f: &mut impl Read, n: u64) -> Option<()> { std::io::copy(&mut f.take(n), &mut std::io::sink()).ok().filter(|c| *c == n).map(|_| ()) }
    fn string(f: &mut impl Read) -> Option<String> {
        let n = u64_(f)?;
        if n > 1 << 20 { return None; }
        let mut v = vec![0u8; n as usize];
        f.read_exact(&mut v).ok()?;
        Some(String::from_utf8_lossy(&v).into_owned())
    }
    fn skip_val(f: &mut impl Read, t: u32) -> Option<()> {
        match t {
            0 | 1 | 7 => skip(f, 1),
            2 | 3 => skip(f, 2),
            4 | 5 | 6 => skip(f, 4),
            10 | 11 | 12 => skip(f, 8),
            8 => { let n = u64_(f)?; skip(f, n) }
            9 => { let at = u32_(f)?; let n = u64_(f)?; for _ in 0..n { skip_val(f, at)?; } Some(()) }
            _ => None,
        }
    }
    let _version = u32_(&mut f)?;
    let nt = u64_(&mut f)?;
    let nkv = u64_(&mut f)?;
    if nt > 100_000 || nkv > 100_000 {
        return None;
    }
    for _ in 0..nkv {
        string(&mut f)?;
        let t = u32_(&mut f)?;
        skip_val(&mut f, t)?;
    }
    let mut names = Vec::with_capacity(nt as usize);
    for _ in 0..nt {
        names.push(string(&mut f)?);
        let nd = u32_(&mut f)?;
        skip(&mut f, 8 * nd as u64 + 4 + 8)?;
    }
    Some(names)
}

/// Familia de un modelo por sus tensores (medido con los archivos reales de cada una):
/// "lora", "sdxl" (checkpoint completo), "anima", "mage", "qwen-image" (2.1), "moss" o "unknown".
pub fn model_kind(p: &Path) -> &'static str {
    let names = tensor_names(p);
    let any = |pat: &str| names.iter().any(|k| k.contains(pat));
    if names.is_empty() {
        "unknown"
    } else if any("lora_up") || any("lora_down") || any("lora_A") || any("lora_B") || any(".hada_") || any(".lokr_") {
        "lora"
    } else if any("video_embedder") || any("shared_block_modulation") {
        "moss" // antes que Anima: MOSS también tiene t_embedder
    } else if any("llm_adapter") || any("net.blocks") || any("t_embedder") {
        "anima"
    } else if any("txt_in.in_layer") || any("img_mlp.gate_up") {
        "qwen-image"
    } else if any("txt_norm") && any("attn.add_k_proj") {
        "mage"
    } else if any("conditioner.embedders") || any("label_emb") || any("input_blocks") {
        "sdxl"
    } else {
        "unknown"
    }
}

/// Palabras activadoras declaradas dentro del archivo (no se adivinan por frecuencia).
fn embedded_words(h: &Map<String, Value>) -> Vec<String> {
    let md = h.get("__metadata__").and_then(|v| v.as_object());
    let mut out = Vec::new();
    if let Some(md) = md {
        for key in ["modelspec.trigger_phrase", "ss_trigger_words"] {
            if let Some(s) = md.get(key).and_then(|v| v.as_str()) {
                out.extend(s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()));
            }
        }
    }
    out
}

/// Categoría como en el teléfono: la del usuario (`cat`) gana; si no, la primera de CATS
/// presente en las etiquetas de Civitai (con alias).
pub fn resolve_cat(m: &Map<String, Value>) -> Option<String> {
    if let Some(c) = m.get("cat").and_then(|v| v.as_str()) {
        return if c == "none" { None } else { Some(c.to_string()) };
    }
    let tags: Vec<String> = m
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    let norm = |t: &str| -> String {
        match t {
            "pose" => "poses".into(),
            "clothes" | "outfit" => "clothing".into(),
            "characters" | "anime character" => "character".into(),
            o => o.into(),
        }
    };
    let tags: Vec<String> = tags.iter().map(|t| norm(t)).collect();
    CATS.iter().find(|c| tags.iter().any(|t| t == *c)).map(|c| c.to_string())
}

fn walk(d: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 3 {
        return;
    }
    if let Ok(rd) = fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out, depth + 1);
            } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| EXTS.contains(&x.to_lowercase().as_str())) {
                out.push(p);
            }
        }
    }
}

const PREVIEW_EXTS: [&str; 8] = [
    "preview.jpeg", "preview.jpg", "preview.png", "preview.webp", "png", "jpg", "jpeg", "webp",
];

/// Imagen de vista previa local: `<stem>.preview.jpeg`, `<stem>.png`… (como los loaders de ComfyUI).
pub fn local_preview(p: &Path) -> Option<PathBuf> {
    let stem = p.file_stem()?.to_string_lossy().into_owned();
    let parent = p.parent()?;
    PREVIEW_EXTS.iter().map(|e| parent.join(format!("{stem}.{e}"))).find(|c| c.is_file())
}

/// Subcarpetas de loras/ (relativas, con "/"), para filtrar y mover.
pub fn folders(root: &Path) -> Vec<String> {
    fn rec(base: &Path, d: &Path, out: &mut Vec<String>, depth: usize) {
        if depth > 3 {
            return;
        }
        if let Ok(rd) = fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.push(rel(base, &p));
                    rec(base, &p, out, depth + 1);
                }
            }
        }
    }
    let base = dir(root);
    let mut out = Vec::new();
    rec(&base, &base, &mut out, 0);
    out.sort_by_key(|s| s.to_lowercase());
    out
}

pub fn make_folder(root: &Path, name: &str) -> Result<String, String> {
    let clean: Vec<String> = name
        .split(['/', '\\'])
        .map(|s| file_name(s))
        .filter(|s| !s.is_empty() && s != "lora")
        .collect();
    if clean.is_empty() {
        return Err("Nombre de carpeta no válido".into());
    }
    let r = clean.join("/");
    fs::create_dir_all(dir(root).join(&r)).map_err(|e| e.to_string())?;
    Ok(r)
}

/// Mueve el LoRA (con su .json y su vista previa) a otra subcarpeta ("" = raíz).
/// El nombre del archivo no cambia, así que las etiquetas <lora:...> siguen valiendo.
pub fn move_to(root: &Path, file: &str, folder: &str) -> Result<String, String> {
    let p = resolve(root, file)?;
    if folder.contains("..") || folder.contains(':') {
        return Err("Carpeta no válida".into());
    }
    let target_dir = if folder.is_empty() { dir(root) } else { dir(root).join(folder) };
    if !target_dir.is_dir() {
        return Err("La carpeta no existe".into());
    }
    let name = p.file_name().ok_or("archivo")?;
    let dst = target_dir.join(name);
    if dst == p {
        return Ok(file.to_string());
    }
    if dst.exists() {
        return Err("Ya hay un LoRA con ese nombre en la carpeta".into());
    }
    let side = sidecar(&p);
    let prev = local_preview(&p);
    fs::rename(&p, &dst).map_err(|e| e.to_string())?;
    if side.is_file() {
        let _ = fs::rename(&side, sidecar(&dst));
    }
    if let Some(pv) = prev {
        if let Some(n) = pv.file_name() {
            let _ = fs::rename(&pv, target_dir.join(n));
        }
    }
    Ok(rel(&dir(root), &dst))
}

/// Presets (conjuntos de LoRAs con fuerza) en loras/hexanima-presets.json.
pub fn presets_get(root: &Path) -> Value {
    fs::read_to_string(dir(root).join("hexanima-presets.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_array())
        .unwrap_or_else(|| json!([]))
}

pub fn presets_set(root: &Path, v: &Value) -> Result<(), String> {
    if !v.is_array() {
        return Err("Formato de presets no válido".into());
    }
    let _ = fs::create_dir_all(dir(root));
    fs::write(dir(root).join("hexanima-presets.json"), serde_json::to_string_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// SHA256 del archivo (para buscar sus datos en Civitai).
pub fn sha256(p: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn list(root: &Path) -> Value {
    let base = dir(root);
    let _ = fs::create_dir_all(&base);
    let mut files = Vec::new();
    walk(&base, &mut files, 0);
    let mut items: Vec<Value> = files
        .iter()
        .map(|p| {
            let file = rel(&base, p);
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let m = read_sidecar(p);
            let h = header(p).unwrap_or_default();
            let mut words: Vec<String> = m
                .get("words")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if words.is_empty() && !m.contains_key("words") {
                words = embedded_words(&h);
            }
            let alias = m.get("alias").and_then(|v| v.as_str()).map(String::from);
            let name = m.get("name").and_then(|v| v.as_str()).map(String::from);
            let base_model = m
                .get("base")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| detect_base(&h).map(String::from));
            let folder = file.rsplit_once('/').map(|(f, _)| f.to_string()).unwrap_or_default();
            let modified = p
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            json!({
                "file": file,
                "stem": stem,
                "folder": folder,
                "modified": modified,
                "preview_local": local_preview(p).map(|x| x.display().to_string()),
                "fav": m.get("fav").and_then(|v| v.as_bool()).unwrap_or(false),
                "note": m.get("note"),
                "civitai_checked": m.get("civitai_checked"),
                "title": alias.clone().or(name.clone()).unwrap_or(stem.clone()),
                "alias": alias,
                "name": name,
                "cat": resolve_cat(&m),
                "words": words,
                "base": base_model,
                "bytes": p.metadata().map(|x| x.len()).unwrap_or(0),
                "model_id": m.get("model_id"),
                "version_id": m.get("version_id"),
                "preview": m.get("preview"),
                "nsfw": m.get("nsfw"),
            })
        })
        .collect();
    items.sort_by(|a, b| a["title"].as_str().unwrap_or("").to_lowercase().cmp(&b["title"].as_str().unwrap_or("").to_lowercase()));
    json!(items)
}

#[derive(Deserialize, Debug)]
pub struct MetaPatch {
    /// Nombre visible ("" lo restablece al original).
    pub alias: Option<String>,
    /// character | clothing | poses | style | concept | background | objects | none
    pub cat: Option<String>,
    pub words: Option<Vec<String>>,
    pub fav: Option<bool>,
    pub note: Option<String>,
}

pub fn set_meta(root: &Path, file: &str, patch: MetaPatch) -> Result<(), String> {
    let p = resolve(root, file)?;
    let mut m = read_sidecar(&p);
    if !m.contains_key("name") {
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        m.insert("name".into(), json!(stem));
    }
    if let Some(a) = patch.alias {
        let a = a.trim();
        let original = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if a.is_empty() || a == original { m.remove("alias"); } else { m.insert("alias".into(), json!(a)); }
    }
    if let Some(c) = patch.cat {
        if c == "none" || CATS.contains(&c.as_str()) {
            m.insert("cat".into(), json!(c));
        }
    }
    if let Some(w) = patch.words {
        let w: Vec<String> = w.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
        m.insert("words".into(), json!(w));
    }
    if let Some(f) = patch.fav {
        m.insert("fav".into(), json!(f));
    }
    if let Some(n) = patch.note {
        let n = n.trim();
        if n.is_empty() { m.remove("note"); } else { m.insert("note".into(), json!(n)); }
    }
    write_sidecar(&p, &m)
}

/// A la Papelera de reciclaje (se puede recuperar), con su .json.
pub fn trash(root: &Path, file: &str) -> Result<(), String> {
    let p = resolve(root, file)?;
    let mut targets = vec![p.clone()];
    if sidecar(&p).is_file() {
        targets.push(sidecar(&p));
    }
    if let Some(pv) = local_preview(&p) {
        targets.push(pv);
    }
    trash::delete_all(&targets).map_err(|e| format!("No se pudo enviar a la papelera: {e}"))
}

/// Importa archivos .safetensors elegidos por el usuario: comprueba la cabecera y la familia.
pub fn import(root: &Path, paths: &[PathBuf]) -> Result<Value, String> {
    let base = dir(root);
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let mut done = Vec::new();
    let mut failed = Vec::new();
    for src in paths {
        let shown = src.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext != "safetensors" {
            failed.push(json!({ "file": shown, "error": "No es un archivo .safetensors." }));
            continue;
        }
        let Some(h) = header(src) else {
            failed.push(json!({ "file": shown, "error": "No se puede leer el archivo." }));
            continue;
        };
        let stem = file_name(&src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        let mut dst = base.join(format!("{stem}.safetensors"));
        let mut i = 2;
        while dst.exists() {
            dst = base.join(format!("{stem}_{i}.safetensors"));
            i += 1;
        }
        fs::copy(src, &dst).map_err(|e| format!("{shown}: {e}"))?;
        // Si el archivo trae un .json del teléfono al lado, también se copia.
        if sidecar(src).is_file() {
            let _ = fs::copy(sidecar(src), sidecar(&dst));
        }
        done.push(json!({
            "file": rel(&base, &dst),
            "stem": dst.file_stem().map(|s| s.to_string_lossy().into_owned()),
            "base": detect_base(&h),
        }));
    }
    Ok(json!({ "imported": done, "failed": failed }))
}

/// Ids de Civitai y nombres normalizados ya presentes (para marcar "✓ Descargada").
pub fn downloaded_index(root: &Path) -> Value {
    let mut ids: BTreeMap<String, bool> = BTreeMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut files = Vec::new();
    walk(&dir(root), &mut files, 0);
    for d in ["checkpoints", "diffusion_models"] {
        walk(&root.join("models").join(d), &mut files, 0);
    }
    for p in &files {
        let m = read_sidecar(p);
        for k in ["model_id", "version_id"] {
            if let Some(v) = m.get(k) {
                ids.insert(format!("{k}:{v}"), true);
            }
        }
        if let Some(s) = p.file_stem() {
            names.push(file_name(&s.to_string_lossy()).to_lowercase());
        }
    }
    json!({ "ids": ids.keys().collect::<Vec<_>>(), "names": names })
}

#[cfg(test)]
mod kind_tests {
    /// HEXANIMA_HEADS=<carpeta con cabeceras de prueba> cargo test model_kind_real -- --ignored
    #[test]
    #[ignore]
    fn model_kind_real() {
        let d = std::path::PathBuf::from(std::env::var("HEXANIMA_HEADS").unwrap());
        for (f, want) in [("anima.safetensors", "anima"), ("mage.gguf", "mage"), ("qwen.gguf", "qwen-image"), ("moss.gguf", "moss"), ("lora.safetensors", "lora"), ("sdxl.safetensors", "sdxl")] {
            let got = super::model_kind(&d.join(f));
            println!("{f}: {got}");
            assert_eq!(got, want, "{f}");
        }
    }
}
