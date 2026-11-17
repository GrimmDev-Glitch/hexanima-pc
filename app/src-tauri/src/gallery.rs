//! Historial: imágenes de outputs/ con un `<nombre>.json` al lado (como la galería del
//! teléfono) que guarda los ajustes completos y la marca de favorita. Las imágenes sin
//! .json se leen del texto "parameters" que el motor escribe dentro del PNG.

use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn dir(root: &Path) -> PathBuf {
    root.join("outputs")
}

/// Solo nombres simples de PNG dentro de outputs/.
pub fn resolve(root: &Path, name: &str) -> Result<PathBuf, String> {
    let p = Path::new(name);
    let simple = p.file_name().and_then(|x| x.to_str()) == Some(name);
    let png = p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png"));
    if !simple || !png {
        return Err("Nombre de imagen no válido".into());
    }
    let path = dir(root).join(name);
    if !path.is_file() {
        return Err("La imagen no existe".into());
    }
    Ok(path)
}

fn sidecar(p: &Path) -> PathBuf {
    p.with_extension("json")
}

pub fn read_json(p: &Path) -> Map<String, Value> {
    fs::read_to_string(sidecar(p))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn write_json(p: &Path, m: &Map<String, Value>) -> Result<(), String> {
    fs::write(sidecar(p), serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Texto "parameters" del PNG (estilo A1111) leyendo solo los bloques de texto.
fn png_parameters(p: &Path) -> Option<String> {
    let mut f = File::open(p).ok()?;
    let mut sig = [0u8; 8];
    f.read_exact(&mut sig).ok()?;
    loop {
        let mut head = [0u8; 8];
        f.read_exact(&mut head).ok()?;
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let kind = &head[4..8];
        if kind == b"IDAT" || kind == b"IEND" || len > 8 * 1024 * 1024 {
            return None; // los textos van antes de la imagen
        }
        let mut data = vec![0u8; len];
        f.read_exact(&mut data).ok()?;
        let mut crc = [0u8; 4];
        f.read_exact(&mut crc).ok()?;
        if kind == b"tEXt" {
            if let Some(i) = data.iter().position(|b| *b == 0) {
                if &data[..i] == b"parameters" {
                    return Some(String::from_utf8_lossy(&data[i + 1..]).into_owned());
                }
            }
        }
    }
}

/// Convierte el texto A1111 en los mismos campos que guarda la app.
fn parse_parameters(text: &str) -> Map<String, Value> {
    let mut m = Map::new();
    let mut lines: Vec<&str> = text.lines().collect();
    let last = lines.iter().rposition(|l| l.contains("Steps: ")).map(|i| lines.remove(i)).unwrap_or("");
    let mut prompt = Vec::new();
    let mut negative = Vec::new();
    let mut in_neg = false;
    for l in lines {
        if let Some(r) = l.strip_prefix("Negative prompt:") {
            in_neg = true;
            negative.push(r.trim().to_string());
        } else if in_neg {
            negative.push(l.to_string());
        } else {
            prompt.push(l.to_string());
        }
    }
    m.insert("prompt".into(), json!(prompt.join("\n").trim()));
    m.insert("negative".into(), json!(negative.join("\n").trim()));
    for part in last.split(", ") {
        let Some((k, v)) = part.split_once(": ") else { continue };
        let v = v.trim();
        match k.trim() {
            "Steps" => { m.insert("steps".into(), json!(v.parse::<f64>().ok())); }
            "CFG scale" => { m.insert("cfg".into(), json!(v.parse::<f64>().ok())); }
            "Seed" => { m.insert("seed".into(), json!(v.parse::<i64>().ok())); }
            "Sampler" => { m.insert("sampler_label".into(), json!(v)); }
            "Schedule type" => { m.insert("scheduler_label".into(), json!(v)); }
            "Model" => { m.insert("model_label".into(), json!(v)); }
            "Size" => {
                if let Some((w, h)) = v.split_once('x') {
                    m.insert("width".into(), json!(w.parse::<u32>().ok()));
                    m.insert("height".into(), json!(h.parse::<u32>().ok()));
                }
            }
            _ => {}
        }
    }
    m
}

/// Metadatos de una imagen: .json de la app o, si no hay, el texto del PNG.
pub fn meta(p: &Path) -> Map<String, Value> {
    let mut m = read_json(p);
    if !m.contains_key("prompt") {
        if let Some(t) = png_parameters(p) {
            for (k, v) in parse_parameters(&t) {
                m.entry(k).or_insert(v);
            }
        }
    }
    m
}

pub fn list(root: &Path) -> Result<Value, String> {
    let d = dir(root);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if !p.is_file() || !p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png")) {
            continue;
        }
        let md = e.metadata().ok();
        let modified = md
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        items.push(json!({
            "name": e.file_name().to_string_lossy(),
            "path": p.display().to_string(),
            "bytes": md.map(|m| m.len()).unwrap_or(0),
            "modified": modified,
            "meta": Value::Object(meta(&p)),
        }));
    }
    items.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(json!(items))
}

pub fn set_fav(root: &Path, name: &str, fav: bool) -> Result<(), String> {
    let p = resolve(root, name)?;
    let mut m = read_json(&p);
    m.insert("fav".into(), json!(fav));
    write_json(&p, &m)
}

/// A la Papelera de reciclaje de Windows (se puede restaurar desde ahí), con su .json.
pub fn trash(root: &Path, names: &[String]) -> Result<usize, String> {
    let mut targets = Vec::new();
    for n in names {
        let p = resolve(root, n)?;
        if sidecar(&p).is_file() {
            targets.push(sidecar(&p));
        }
        targets.push(p);
    }
    trash::delete_all(&targets).map_err(|e| format!("No se pudo enviar a la papelera: {e}"))?;
    Ok(names.len())
}
