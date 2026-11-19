//! ⋯ → Almacenamiento (como el del teléfono) y Exportar registros.
//! Cuánto ocupa cada carpeta de la app; solo se pueden vaciar cosas que se rehacen solas
//! (caché, registros, descargas a medias y la copia del motor anterior). Modelos, LoRAs e
//! imágenes se gestionan en sus pantallas o abriendo su carpeta.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn size(p: &Path) -> u64 {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_file() => m.len(),
        Ok(m) if m.is_dir() => fs::read_dir(p).map(|rd| rd.flatten().map(|e| size(&e.path())).sum()).unwrap_or(0),
        _ => 0,
    }
}

/// Nombre legible de las subcarpetas de models/ y engine/.
fn label(dir: &str, name: &str) -> (String, String) {
    let (t, s) = match (dir, name) {
        ("models", "checkpoints") => ("Checkpoints", "Modelos SDXL / Illustrious / Pony completos"),
        ("models", "diffusion_models") => ("Modelos de difusión", "Anima, Mage, Qwen-Image, MOSS…"),
        ("models", "text_encoders") => ("Codificadores de texto", "Qwen3, Qwen3-VL…; los comparten los modelos de una familia"),
        ("models", "vae") => ("VAE", "Decodificadores de imagen"),
        ("models", "vae_approx") => ("Vista previa", "TAESD / Approx NN para ver la imagen mientras se genera"),
        ("models", "upscalers") => ("Ampliadores", "Real-ESRGAN, UltraSharp"),
        ("models", "detectors") => ("Detectores", "Caras y manos para ADetailer y Correcciones"),
        ("models", "tokenizers") => ("Tokenizers", "Vocabulario de los codificadores (MOSS-Image)"),
        ("models", "pose") => ("Detector de pose", "OpenPose para «🧍 Pose»"),
        ("models", "controlnet") => ("ControlNet", "OpenPose para «🧍 Pose» (SDXL / Illustrious / Pony)"),
        ("models", "tagger") => ("Leer rasgos", "WD Tagger (Prompt desde una imagen)"),
        ("models", "ipadapter") | ("models", "clip_vision") => ("Personaje de referencia", "IP-Adapter y su codificador de imagen"),
        ("engine", "torch") => ("Motor rápido (PyTorch)", "Se puede volver a descargar en Ajustes"),
        ("engine", "cuda") => ("Motor CUDA", "stable-diffusion.cpp para NVIDIA"),
        ("engine", "vulkan") => ("Motor Vulkan", "stable-diffusion.cpp para cualquier gráfica"),
        ("engine", "cpu") => ("Motor CPU", "stable-diffusion.cpp sin gráfica"),
        _ => (name, ""),
    };
    (t.to_string(), s.to_string())
}

fn subdirs(root: &Path, dir: &str) -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = fs::read_dir(root.join(dir))
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().to_string(), e.path())).collect())
        .unwrap_or_default();
    v.sort();
    v
}

pub fn info(root: &Path) -> Value {
    let item = |id: &str, title: &str, sub: &str, p: &Path, action: &str| {
        json!({ "id": id, "title": title, "sub": sub, "bytes": size(p), "action": action })
    };
    let mut models = Vec::new();
    for (name, p) in subdirs(root, "models") {
        let (t, s) = label("models", &name);
        models.push(item(&format!("models/{name}"), &t, &s, &p, "open"));
    }
    models.push(item("loras", "LoRAs", "Se gestionan en LoRAs", &root.join("loras"), "open"));

    let mut engines = Vec::new();
    for (name, p) in subdirs(root, "engine") {
        if name == "torch.old" || name == "torch.new" {
            continue;
        }
        let (t, s) = label("engine", &name);
        engines.push(item(&format!("engine/{name}"), &t, &s, &p, ""));
    }
    let e = root.join("engine");
    let leftovers: Vec<PathBuf> = ["torch.old", "torch.new", "torch-download.zip.part"].iter().map(|n| e.join(n)).filter(|p| p.exists()).collect();
    if !leftovers.is_empty() {
        let b: u64 = leftovers.iter().map(|p| size(p)).sum();
        engines.push(json!({ "id": "engine-leftovers", "title": "Restos del motor rápido", "sub": "Descarga a medias o copia del motor anterior", "bytes": b, "action": "clear" }));
    }

    let caches = vec![
        item("cache", "Caché", "Archivos temporales; se rehacen cuando hacen falta", &root.join("cache"), "clear"),
        item("logs", "Registros", "Lo que escribe el motor; útil para avisar de un error", &root.join("logs"), "clear"),
    ];
    let pics = vec![item("outputs", "Imágenes", "Tus imágenes; se gestionan en el Historial (lo borrado va a la Papelera de Windows)", &root.join("outputs"), "open")];

    json!({
        "free": crate::engine_dl::free_bytes(root),
        "groups": [
            { "title": "MODELOS", "items": models },
            { "title": "MOTORES", "items": engines },
            { "title": "CACHÉS", "items": caches },
            { "title": "IMÁGENES", "items": pics },
        ],
    })
}

/// Vacía una de las cosas que se rehacen solas. Devuelve los bytes liberados.
pub fn clear(root: &Path, id: &str) -> Result<u64, String> {
    let targets: Vec<PathBuf> = match id {
        "cache" | "logs" => fs::read_dir(root.join(id)).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default(),
        "engine-leftovers" => ["torch.old", "torch.new", "torch-download.zip.part"].iter().map(|n| root.join("engine").join(n)).filter(|p| p.exists()).collect(),
        _ => return Err("No se puede vaciar".into()),
    };
    let mut freed = 0;
    for p in targets {
        let b = size(&p);
        let r = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        if r.is_ok() {
            freed += b;
        } // un registro abierto por el motor se queda: no es un error
    }
    Ok(freed)
}

/// ZIP con logs/ y un info.json (versión, equipo y motores). No incluye config/ (clave de Civitai, ajustes).
pub fn export_logs(root: &Path, dest: &Path, info: Value) -> Result<usize, String> {
    use std::io::Write;
    let f = fs::File::create(dest).map_err(|e| format!("No se pudo crear el ZIP: {e}"))?;
    let mut z = zip::ZipWriter::new(f);
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    z.start_file("info.json", opt).map_err(|e| e.to_string())?;
    z.write_all(serde_json::to_string_pretty(&info).unwrap_or_default().as_bytes()).map_err(|e| e.to_string())?;
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(root.join("logs")) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            // el motor puede tenerlo abierto: se lee lo que haya
            if let Ok(data) = fs::read(&p) {
                z.start_file(format!("logs/{}", e.file_name().to_string_lossy()), opt).map_err(|e| e.to_string())?;
                z.write_all(&data).map_err(|e| e.to_string())?;
                n += 1;
            }
        }
    }
    z.finish().map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_and_clear() {
        let root = std::env::temp_dir().join(format!("hx-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::create_dir_all(root.join("cache/sub")).unwrap();
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::write(root.join("logs/server.log"), b"hola motor").unwrap();
        std::fs::write(root.join("cache/sub/a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(root.join("config/settings.json"), b"{\"civitai_key\":\"secreta\"}").unwrap();
        let zip = root.join("r.zip");
        assert_eq!(super::export_logs(&root, &zip, serde_json::json!({"v": 1})).unwrap(), 1);
        let mut z = zip::ZipArchive::new(std::fs::File::open(&zip).unwrap()).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"logs/server.log".to_string()) && names.contains(&"info.json".to_string()));
        assert!(!names.iter().any(|n| n.contains("config")), "no debe llevar config/");
        assert_eq!(super::clear(&root, "cache").unwrap(), 1000);
        assert!(root.join("cache").is_dir() && std::fs::read_dir(root.join("cache")).unwrap().next().is_none());
        assert!(super::clear(&root, "outputs").is_err());
        let info = super::info(&root);
        assert!(info["groups"].as_array().unwrap().len() == 4);
        let _ = std::fs::remove_dir_all(&root);
    }
}
