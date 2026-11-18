// HexAnima PC: descarga e instala el motor PyTorch (engine/torch) desde Hugging Face.
// motor.json (versión, tamaño, sha256) + un zip. Se reanuda si se corta, se comprueba el sha256 y se
// extrae en engine/torch.new; solo al terminar bien sustituye a engine/torch.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Repositorio público de Hugging Face con motor.json y el zip (tools/package_torch_engine.py).
/// Para probar con otro servidor: variable de entorno HEXANIMA_ENGINE_URL.
pub const ENGINE_BASE: &str = "https://huggingface.co/GrimmDev-Glitch/hexanima-packs/resolve/main/pc_torch";

pub static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub version: u32,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    pub unpacked_bytes: u64,
    #[serde(default)]
    pub files: u64,
}

fn base() -> String {
    std::env::var("HEXANIMA_ENGINE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| ENGINE_BASE.to_string())
}

/// GET siguiendo redirecciones (Hugging Face manda al CDN) y pidiendo desde `from` si se reanuda.
fn get(url: &str, from: u64) -> Result<reqwest::blocking::Response, String> {
    let c = crate::civitai::client()?;
    let mut url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    for _ in 0..8 {
        let mut req = c.get(url.clone());
        if from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        let resp = req.send().map_err(|e| format!("Sin conexión con Hugging Face: {e}"))?;
        if resp.status().is_redirection() {
            let loc = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or("Redirección sin destino")?;
            url = url.join(loc).map_err(|e| e.to_string())?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("El servidor respondió {} ({})", resp.status().as_u16(), url.host_str().unwrap_or("")));
        }
        return Ok(resp);
    }
    Err("Demasiadas redirecciones".into())
}

pub fn remote() -> Result<Manifest, String> {
    let text = get(&format!("{}/motor.json", base()), 0)?.text().map_err(|e| e.to_string())?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("motor.json no válido: {e}"))?;
    if m.file.contains(['/', '\\']) || m.file.contains("..") {
        return Err("motor.json no válido".into());
    }
    Ok(m)
}

/// Versión instalada: la de engine/torch/motor.json (0 si se armó a mano sin él), None si no hay motor.
pub fn installed(root: &Path) -> Option<u32> {
    if !crate::server::engine_installed(root, "torch") {
        return None;
    }
    let p = root.join("engine").join("torch").join("motor.json");
    Some(fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Manifest>(&s).ok()).map_or(0, |m| m.version))
}

#[cfg(windows)]
pub fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}
#[cfg(not(windows))]
pub fn free_bytes(_: &Path) -> Option<u64> {
    None
}

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) { Err("Descarga cancelada".into()) } else { Ok(()) }
}

/// Descarga, comprueba y extrae. `progress(etapa, hecho, total)` con etapa download / verify / extract.
/// `before_swap` se llama justo antes de sustituir engine/torch (para parar el motor que esté abierto).
pub fn install(root: &Path, m: &Manifest, progress: &mut dyn FnMut(&str, u64, u64), before_swap: &mut dyn FnMut()) -> Result<(), String> {
    CANCEL.store(false, Ordering::Relaxed);
    let edir = root.join("engine");
    fs::create_dir_all(&edir).map_err(|e| e.to_string())?;
    let part = edir.join("torch-download.zip.part");
    let have = fs::metadata(&part).map(|x| x.len()).unwrap_or(0);
    let need = (m.bytes.saturating_sub(have)) + m.unpacked_bytes + (200 << 20);
    if let Some(free) = free_bytes(&edir) {
        if free < need {
            return Err(format!("Falta espacio en el disco: hacen falta {:.1} GB libres y hay {:.1} GB", need as f64 / 1e9, free as f64 / 1e9));
        }
    }

    // 1) descargar (reanudando)
    let mut done = if have > m.bytes { let _ = fs::remove_file(&part); 0 } else { have };
    if done < m.bytes {
        let mut resp = get(&format!("{}/{}", base(), m.file), done)?;
        if done > 0 && resp.status().as_u16() != 206 {
            done = 0; // el servidor no admite reanudar: empezar de cero
        }
        let mut out = OpenOptions::new().create(true).write(true).truncate(done == 0).open(&part).map_err(|e| e.to_string())?;
        out.seek(SeekFrom::Start(done)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        let mut last = Instant::now();
        loop {
            cancelled()?;
            let n = resp.read(&mut buf).map_err(|e| format!("Se cortó la descarga ({e}). Vuelve a intentarlo: seguirá donde se quedó."))?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if last.elapsed() > Duration::from_millis(250) {
                progress("download", done, m.bytes);
                last = Instant::now();
            }
        }
        out.flush().map_err(|e| e.to_string())?;
    }
    progress("download", done, m.bytes);
    if done != m.bytes {
        return Err("La descarga se cortó antes de terminar. Vuelve a intentarlo: seguirá donde se quedó.".into());
    }

    // 2) comprobar
    let mut h = Sha256::new();
    let mut f = BufReader::with_capacity(1 << 22, File::open(&part).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; 1 << 22];
    let (mut n_read, mut last) = (0u64, Instant::now());
    loop {
        cancelled()?;
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        h.update(&buf[..n]);
        n_read += n as u64;
        if last.elapsed() > Duration::from_millis(250) { progress("verify", n_read, m.bytes); last = Instant::now(); }
    }
    let got: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(&m.sha256) {
        let _ = fs::remove_file(&part);
        return Err("El archivo descargado está dañado (no coincide el sha256). Vuelve a descargarlo.".into());
    }

    // 3) extraer en engine/torch.new
    let new = edir.join("torch.new");
    if new.exists() { fs::remove_dir_all(&new).map_err(|e| format!("No se pudo limpiar {}: {e}", new.display()))?; }
    fs::create_dir_all(&new).map_err(|e| e.to_string())?;
    extract(&part, &new, m.unpacked_bytes, progress)?;
    fs::write(new.join("motor.json"), serde_json::to_vec_pretty(m).unwrap()).map_err(|e| e.to_string())?;

    // 4) sustituir
    before_swap();
    let cur = edir.join("torch");
    let old = edir.join("torch.old");
    if old.exists() { let _ = fs::remove_dir_all(&old); }
    if cur.exists() {
        rename_retry(&cur, &old).map_err(|e| format!("No se pudo reemplazar el motor anterior (¿está abierto?): {e}"))?;
    }
    if let Err(e) = rename_retry(&new, &cur) {
        if old.exists() { let _ = fs::rename(&old, &cur); }
        return Err(format!("No se pudo instalar el motor: {e}"));
    }
    if old.exists() { let _ = fs::remove_dir_all(&old); }
    let _ = fs::remove_file(&part);
    Ok(())
}

/// Windows tarda en soltar los archivos de un proceso recién cerrado, y el antivirus abre los recién
/// extraídos para analizarlos: mientras tanto la carpeta no se puede renombrar (hasta ~1 min).
fn rename_retry(a: &Path, b: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..240 {
        match fs::rename(a, b) {
            Ok(()) => return Ok(()),
            Err(e) => { last = Some(e); std::thread::sleep(Duration::from_millis(250)); }
        }
    }
    Err(last.unwrap())
}

fn extract(zip_path: &Path, dest: &Path, total: u64, progress: &mut dyn FnMut(&str, u64, u64)) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(BufReader::new(File::open(zip_path).map_err(|e| e.to_string())?)).map_err(|e| format!("Zip dañado: {e}"))?;
    let (mut done, mut last) = (0u64, Instant::now());
    let mut buf = vec![0u8; 1 << 20];
    for i in 0..z.len() {
        cancelled()?;
        let mut e = z.by_index(i).map_err(|e| format!("Zip dañado: {e}"))?;
        // enclosed_name: rechaza rutas que salgan de la carpeta (../, absolutas)
        let rel: PathBuf = e.enclosed_name().ok_or_else(|| format!("Ruta no permitida en el zip: {}", e.name()))?;
        let out = dest.join(rel);
        if e.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut f = std::io::BufWriter::with_capacity(1 << 20, File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?);
        loop {
            let n = e.read(&mut buf).map_err(|e| format!("Zip dañado: {e}"))?;
            if n == 0 { break; }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if last.elapsed() > Duration::from_millis(250) { progress("extract", done, total); last = Instant::now(); }
        }
        f.flush().map_err(|e| e.to_string())?;
    }
    progress("extract", total, total);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prueba completa contra un servidor local: HEXANIMA_ENGINE_URL=http://127.0.0.1:PUERTO HEXANIMA_TEST_ROOT=carpeta
    #[test]
    #[ignore]
    fn install_from_local_server() {
        let root = PathBuf::from(std::env::var("HEXANIMA_TEST_ROOT").expect("HEXANIMA_TEST_ROOT"));
        let m = remote().expect("motor.json");
        let mut last = String::new();
        let t = Instant::now();
        install(&root, &m, &mut |s, d, tot| {
            let line = format!("{s} {}%", if tot > 0 { d * 100 / tot } else { 0 });
            if line != last { println!("{:>5.1}s {line}", t.elapsed().as_secs_f32()); last = line; }
        }, &mut || println!("cambiando la carpeta del motor")).expect("install");
        assert!(crate::server::engine_installed(&root, "torch"));
        assert_eq!(installed(&root), Some(m.version));
    }
}
