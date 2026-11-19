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

/// Dos motores: motor.json (PyTorch 2.3.1 + CUDA 12.1, el de siempre) y motor-cu128.json
/// (PyTorch 2.7.1 + CUDA 12.8, para las RTX serie 50; necesita driver 570 o posterior).
fn manifest_name(cu128: bool) -> &'static str {
    if cu128 { "motor-cu128.json" } else { "motor.json" }
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

pub fn remote(cu128: bool) -> Result<Manifest, String> {
    let text = get(&format!("{}/{}", base(), manifest_name(cu128)), 0)?.text().map_err(|e| e.to_string())?;
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

/// CUDA del PyTorch instalado en engine/torch («121», «128»…), leído del nombre de torch-*.dist-info.
pub fn installed_cuda(root: &Path) -> Option<String> {
    let sp = root.join("engine").join("torch").join("python").join("Lib").join("site-packages");
    fs::read_dir(sp).ok()?.flatten().find_map(|e| {
        let n = e.file_name().to_string_lossy().to_string();
        let rest = n.strip_prefix("torch-")?.strip_suffix(".dist-info")?;
        Some(rest.split("+cu").nth(1)?.to_string())
    })
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
    download_resumable(&format!("{}/{}", base(), m.file), &part, m.bytes, &mut |d, t| progress("download", d, t))?;

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

/// Descarga `url` en `part` reanudando lo que ya haya. `total` = tamaño esperado (0 si no se sabe).
pub fn download_resumable(url: &str, part: &Path, total: u64, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    let have = fs::metadata(part).map(|x| x.len()).unwrap_or(0);
    let mut done = if total > 0 && have > total { let _ = fs::remove_file(part); 0 } else { have };
    if total == 0 || done < total {
        let mut resp = get(url, done)?;
        if done > 0 && resp.status().as_u16() != 206 {
            done = 0; // el servidor no admite reanudar: empezar de cero
        }
        let total = if total > 0 { total } else { done + resp.content_length().unwrap_or(0) };
        let mut out = OpenOptions::new().create(true).write(true).truncate(done == 0).open(part).map_err(|e| e.to_string())?;
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
                progress(done, total);
                last = Instant::now();
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        progress(done, total);
        if total > 0 && done != total {
            return Err("La descarga se cortó antes de terminar. Vuelve a intentarlo: seguirá donde se quedó.".into());
        }
    } else {
        progress(done, total);
    }
    Ok(())
}

// ---------- Paquetes de modelos para la bienvenida ----------
/// (paquete, carpeta en models/, archivo, url, bytes). Solo enlaces oficiales fijos.
pub const PACKS: &[(&str, &str, &str, &str, u64)] = &[
    ("anima", "diffusion_models", "anima-turbo-v1.1.safetensors",
     "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-turbo-v1.1.safetensors", 4_182_230_656),
    ("anima", "text_encoders", "qwen_3_06b_base.safetensors",
     "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors", 1_192_135_096),
    ("anima", "vae", "qwen_image_vae.safetensors",
     "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors", 253_806_246),
    // Codificador y VAE de Anima solos: los usan los modelos del catálogo (MiaoMiao…), que solo traen el transformador
    ("anima_base", "text_encoders", "qwen_3_06b_base.safetensors",
     "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors", 1_192_135_096),
    ("anima_base", "vae", "qwen_image_vae.safetensors",
     "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors", 253_806_246),
    // Mage-Flow Edit Turbo (Microsoft, MIT): Q6_K (por debajo de 6 bits deja una trama visible), Qwen3-VL-4B + mmproj, VAE
    ("mage", "diffusion_models", "mage-flow-edit-turbo-Q6_K.gguf",
     "https://huggingface.co/johnsor/Mage-Flow-Edit-Turbo-GGUF/resolve/main/mage-flow-edit-turbo-Q6_K.gguf", 3_387_311_156),
    ("mage", "text_encoders", "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
     "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf", 2_497_281_664),
    ("mage", "text_encoders", "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
     "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf", 453_974_304),
    ("mage", "vae", "mage_flow_vae_bf16.safetensors",
     "https://huggingface.co/Comfy-Org/Mage-Flow/resolve/main/vae/mage_flow_vae_bf16.safetensors", 345_053_056),
    // Qwen-Image 2.1 Turbo (Qwen Research License, no comercial): GGUF Q4_K_M de unsloth, Qwen3-VL-8B Q4_K_M
    // + su proyector de visión (para editar con fotos de referencia) y el VAE propio de la 2.1
    ("qwen", "diffusion_models", "qwen-image-2.1-turbo-Q4_K_M.gguf",
     "https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF/resolve/main/qwen-image-2.1-turbo-Q4_K_M.gguf", 4_199_565_120),
    ("qwen", "text_encoders", "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
     "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf", 5_027_784_800),
    ("qwen", "text_encoders", "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
     "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-8B-Instruct-F16.gguf", 1_159_029_824),
    ("qwen", "vae", "qwen_image_2.1_vae_bf16.safetensors",
     "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors", 675_509_688),
    // MOSS-Image SFT (OpenMOSS, Apache-2.0): GGUF Q4_K de leejet, Qwen3.5-9B Q4_K_M, VAE de FLUX.2 y el
    // tokenizer de Qwen3.5 (el motor lo pide aparte: otro vocabulario que el Qwen integrado)
    ("moss", "diffusion_models", "MOSS-Image-SFT-Q4_K.gguf",
     "https://huggingface.co/leejet/MOSS-Image-SFT-GGUF/resolve/main/MOSS-Image-SFT-Q4_K.gguf", 3_327_400_800),
    ("moss", "text_encoders", "Qwen3.5-9B-Q4_K_M.gguf",
     "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf", 5_680_522_464),
    ("moss", "vae", "flux2-vae.safetensors",
     "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae.safetensors", 336_211_292),
    ("moss", "tokenizers", "tokenizer_qwen3.5.json",
     "https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/resolve/main/tokenizer/tokenizer.json", 19_989_325),
    // Archivos compartidos de MOSS solos: los usan MiaoMiao RealSkin / Harem MOSS del catálogo
    ("moss_base", "text_encoders", "Qwen3.5-9B-Q4_K_M.gguf",
     "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf", 5_680_522_464),
    ("moss_base", "vae", "flux2-vae.safetensors",
     "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae.safetensors", 336_211_292),
    ("moss_base", "tokenizers", "tokenizer_qwen3.5.json",
     "https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/resolve/main/tokenizer/tokenizer.json", 19_989_325),
];

pub fn pack_status(root: &Path) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for (pack, dir, file, _, bytes) in PACKS {
        let e = out.entry(pack.to_string()).or_insert_with(|| serde_json::json!({ "bytes": 0u64, "have": 0u64, "installed": true }));
        let p = root.join("models").join(dir).join(file);
        let part = p.with_file_name(format!("{file}.part"));
        let have = if p.is_file() { *bytes } else { fs::metadata(part).map(|m| m.len()).unwrap_or(0) };
        e["bytes"] = (e["bytes"].as_u64().unwrap() + bytes).into();
        e["have"] = (e["have"].as_u64().unwrap() + have).into();
        if !p.is_file() { e["installed"] = false.into(); }
    }
    serde_json::Value::Object(out)
}

/// Descarga los archivos que falten del paquete. progress(hecho, total) del paquete entero.
pub fn pack_download(root: &Path, pack: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    CANCEL.store(false, Ordering::Relaxed);
    let files: Vec<_> = PACKS.iter().filter(|p| p.0 == pack).collect();
    if files.is_empty() { return Err("Paquete desconocido".into()); }
    let total: u64 = files.iter().map(|f| f.4).sum();
    let models = root.join("models");
    let missing: u64 = files.iter().filter(|f| !models.join(f.1).join(f.2).is_file()).map(|f| f.4).sum();
    if let Some(free) = free_bytes(&models) {
        if free < missing + (200 << 20) {
            return Err(format!("Falta espacio en el disco: hacen falta {:.1} GB libres y hay {:.1} GB", missing as f64 / 1e9, free as f64 / 1e9));
        }
    }
    let mut base = 0u64;
    for (_, dir, file, url, bytes) in files {
        let d = models.join(dir);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let dest = d.join(file);
        if !dest.is_file() {
            let part = d.join(format!("{file}.part"));
            download_resumable(url, &part, *bytes, &mut |n, _| progress(base + n, total))?;
            fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        }
        base += bytes;
        progress(base, total);
    }
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
        let m = remote(false).expect("motor.json");
        let mut last = String::new();
        let t = Instant::now();
        install(&root, &m, &mut |s, d, tot| {
            let line = format!("{s} {}%", if tot > 0 { d * 100 / tot } else { 0 });
            if line != last { println!("{:>5.1}s {line}", t.elapsed().as_secs_f32()); last = line; }
        }, &mut || println!("cambiando la carpeta del motor")).expect("install");
        assert!(crate::server::engine_installed(&root, "torch"));
        assert_eq!(installed(&root), Some(m.version));
    }

    /// Descarga real desde Hugging Face con reanudación: HEXANIMA_TEST_OUT=archivo
    #[test]
    #[ignore]
    fn resume_from_huggingface() {
        let out = PathBuf::from(std::env::var("HEXANIMA_TEST_OUT").expect("HEXANIMA_TEST_OUT"));
        let (_, _, _, url, bytes) = PACKS.iter().find(|p| p.2 == "qwen_image_vae.safetensors").unwrap();
        let _ = fs::remove_file(&out);
        download_resumable(url, &out, *bytes, &mut |_, _| {}).expect("descarga");
        assert_eq!(fs::metadata(&out).unwrap().len(), *bytes);
        // cortar a la mitad y reanudar
        let f = OpenOptions::new().write(true).open(&out).unwrap();
        f.set_len(bytes / 2).unwrap();
        drop(f);
        let mut first = None;
        download_resumable(url, &out, *bytes, &mut |d, _| { first.get_or_insert(d); }).expect("reanudar");
        assert_eq!(fs::metadata(&out).unwrap().len(), *bytes);
        println!("reanudó desde {} bytes", first.unwrap_or(0));
    }
}
