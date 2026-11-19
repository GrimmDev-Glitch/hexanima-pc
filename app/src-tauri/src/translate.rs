//! 🌐 ES→EN: traduce trozos del prompt de español a inglés sin internet.
//! Usa el Python del motor rápido (engine/torch/python, que ya trae transformers y sentencepiece) con
//! OPUS-MT es-en (models/translate/opus-mt-es-en). El proceso se queda abierto entre peticiones (cargar
//! PyTorch y el modelo tarda; traducir, menos de un segundo) y corre en la CPU, aparte del generador.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

const SCRIPT: &str = include_str!("translate_es_en.py");
/// Copia corregida del tagger del motor (canales BGR): así funciona bien aunque el motor instalado sea anterior.
const TAGGER: &str = include_str!("../../../torch_engine/tagger.py");
pub const MODEL_DIR: &str = "translate/opus-mt-es-en";

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static WORKER: Mutex<Option<Worker>> = Mutex::new(None);

fn start(root: &Path) -> Result<Worker, String> {
    let py = root.join("engine").join("torch").join("python").join("python.exe");
    if !py.is_file() {
        return Err("Esto usa el Python del motor rápido: descárgalo en Ajustes → Motor rápido (solo NVIDIA)".into());
    }
    let model = root.join("models").join(MODEL_DIR);
    let code = root.join("cache"); // tagger.py corregido (ver TAGGER)
    let dir = root.join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("translate_es_en.py");
    std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tagger.py"), TAGGER).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(py);
    cmd.arg("-I").arg(&script).arg(&model).arg(&code).arg(root.join("models")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sin ventana de consola
    }
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo abrir el traductor: {e}"))?;
    let stdin = child.stdin.take().ok_or("sin stdin")?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("sin stdout")?);
    let mut line = String::new();
    stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    if !line.contains("\"ready\"") {
        let _ = child.kill();
        return Err("El traductor no arrancó".into());
    }
    Ok(Worker { child, stdin, stdout })
}

/// Traduce una lista de textos (en el mismo orden). Arranca el ayudante la primera vez.
pub fn translate(root: &Path, texts: &[String]) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    if !root.join("models").join(MODEL_DIR).join("pytorch_model.bin").is_file() {
        return Err("Falta el traductor (OPUS-MT español → inglés)".into());
    }
    let v = request(root, &json!({ "texts": texts }))?;
    Ok(v["out"].as_array().map(|a| a.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default())
}

/// Etiquetas de una imagen con WD Tagger (👗 / 🧍 Copiar ropa o pose con Qwen y Mage), sin el motor rápido abierto.
pub fn tag(root: &Path, image: &str, general: f64) -> Result<Value, String> {
    if !root.join("models").join("tagger").join("wd-vit-tagger-v3.safetensors").is_file() {
        return Err("Falta el lector de rasgos (WD Tagger)".into());
    }
    let v = request(root, &json!({ "op": "tag", "image": image, "general": general }))?;
    Ok(v["tags"].clone())
}

fn request(root: &Path, req: &Value) -> Result<Value, String> {
    let mut g = WORKER.lock().unwrap();
    for attempt in 0..2 {
        if g.is_none() {
            *g = Some(start(root)?);
        }
        let w = g.as_mut().unwrap();
        let ok = (|| -> Result<Value, String> {
            writeln!(w.stdin, "{}", req).map_err(|e| e.to_string())?;
            w.stdin.flush().map_err(|e| e.to_string())?;
            let mut line = String::new();
            if w.stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("el traductor se cerró".into());
            }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                return Err(e.to_string());
            }
            Ok(v)
        })();
        match ok {
            Ok(out) => return Ok(out),
            Err(e) if attempt == 0 => {
                // proceso muerto: se vuelve a abrir una vez
                if let Some(mut w) = g.take() { let _ = w.child.kill(); }
                eprintln!("traductor: {e}; se reinicia");
            }
            Err(e) => return Err(e),
        }
    }
    Err("El ayudante no respondió".into())
}

/// Cierra el traductor (al salir de la app).
pub fn stop() {
    if let Some(mut w) = WORKER.lock().unwrap().take() {
        let _ = w.child.kill();
    }
}

#[cfg(test)]
mod tests {
    /// HEXANIMA_ROOT=<carpeta de la app con engine/torch y el modelo> cargo test translate_real -- --ignored
    #[test]
    #[ignore]
    fn translate_real() {
        let root = std::path::PathBuf::from(std::env::var("HEXANIMA_ROOT").unwrap());
        let t = std::time::Instant::now();
        let a = super::translate(&root, &["pelo largo plateado".into(), "ciudad de noche con lluvia".into()]).unwrap();
        println!("primera: {:?} en {:.1} s", a, t.elapsed().as_secs_f32());
        let t = std::time::Instant::now();
        let b = super::translate(&root, &["chica con un vestido azul sentada en un banco".into()]).unwrap();
        println!("segunda: {:?} en {:.2} s", b, t.elapsed().as_secs_f32());
        assert_eq!(a.len(), 2);
        assert!(b[0].to_lowercase().contains("blue"));
        super::stop();
    }
}

#[cfg(test)]
mod tag_tests {
    /// HEXANIMA_ROOT=… HEXANIMA_IMG=<png> cargo test tag_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn tag_real() {
        use base64::Engine as _;
        let root = std::path::PathBuf::from(std::env::var("HEXANIMA_ROOT").unwrap());
        let png = std::fs::read(std::env::var("HEXANIMA_IMG").unwrap()).unwrap();
        let src = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
        let t = std::time::Instant::now();
        let tags = super::tag(&root, &src, 0.25).unwrap();
        let names: Vec<String> = tags.as_array().unwrap().iter().take(25).map(|t| t[0].as_str().unwrap().to_string()).collect();
        println!("{} etiquetas en {:.1} s: {:?}", tags.as_array().unwrap().len(), t.elapsed().as_secs_f32(), names);
        let tr = super::translate(&root, &["sombrero rojo".into()]).unwrap();
        println!("y traduce en el mismo proceso: {tr:?}");
        super::stop();
    }
}
