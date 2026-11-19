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
        return Err("ES→EN usa el Python del motor rápido: descárgalo en Ajustes → Motor rápido (solo NVIDIA)".into());
    }
    let model = root.join("models").join(MODEL_DIR);
    if !model.join("pytorch_model.bin").is_file() {
        return Err("Falta el traductor (OPUS-MT español → inglés)".into());
    }
    let dir = root.join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("translate_es_en.py");
    std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(py);
    cmd.arg("-I").arg(&script).arg(&model).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
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

/// Traduce una lista de textos (en el mismo orden). Arranca el traductor la primera vez.
pub fn translate(root: &Path, texts: &[String]) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let mut g = WORKER.lock().unwrap();
    for attempt in 0..2 {
        if g.is_none() {
            *g = Some(start(root)?);
        }
        let w = g.as_mut().unwrap();
        let ok = (|| -> Result<Vec<String>, String> {
            writeln!(w.stdin, "{}", json!({ "texts": texts })).map_err(|e| e.to_string())?;
            w.stdin.flush().map_err(|e| e.to_string())?;
            let mut line = String::new();
            if w.stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("el traductor se cerró".into());
            }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                return Err(e.to_string());
            }
            Ok(v["out"].as_array().map(|a| a.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default())
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
    Err("No se pudo traducir".into())
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
