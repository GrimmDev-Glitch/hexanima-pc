//! ⬆ Actualizar la app sin bajar el zip entero: mira la última versión en GitHub (GrimmDev-Glitch/hexanima-pc)
//! y, si es más nueva, baja solo su `HexAnima.exe` (unos 6 MB), comprueba tamaño y sha256, lo cambia por el que
//! está abierto y reinicia. Windows no deja sobrescribir un .exe en uso pero sí renombrarlo: el viejo queda como
//! HexAnima.old.exe y se borra en el siguiente arranque. Modelos, LoRAs, imágenes y ajustes no se tocan.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const LATEST: &str = "https://api.github.com/repos/GrimmDev-Glitch/hexanima-pc/releases/latest";
const ASSET: &str = "HexAnima.exe";

fn version_tuple(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn newer(latest: &str, current: &str) -> bool {
    version_tuple(latest) > version_tuple(current)
}

/// Última versión publicada y si trae el .exe suelto (las anteriores a la 0.2.3 solo traen el zip).
pub fn check() -> Result<Value, String> {
    let c = reqwest::blocking::Client::builder()
        .user_agent("HexAnima")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let r = c.get(LATEST).header("Accept", "application/vnd.github+json").send().map_err(|e| format!("Sin conexión con GitHub: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GitHub respondió {}", r.status().as_u16()));
    }
    let v: Value = r.json().map_err(|e| e.to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("").to_string();
    let current = env!("CARGO_PKG_VERSION");
    let exe = v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str() == Some(ASSET)));
    Ok(json!({
        "current": current,
        "latest": tag.trim_start_matches('v'),
        "newer": newer(&tag, current),
        "notes": v["body"].as_str().unwrap_or(""),
        "page": v["html_url"].as_str().unwrap_or(""),
        "exe": exe.map(|x| json!({
            "url": x["browser_download_url"],
            "size": x["size"],
            // GitHub da el sha256 de cada archivo («sha256:…»); si no viniera, se comprueba solo el tamaño
            "sha256": x["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")),
        })),
    }))
}

fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", h.finalize()))
}

pub fn old_path(exe: &Path) -> PathBuf {
    exe.with_file_name("HexAnima.old.exe")
}

/// Baja el .exe nuevo y lo pone en lugar del actual. Devuelve la ruta del exe (para reiniciarlo).
pub fn install(url: &str, size: u64, sha256: Option<&str>, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf, String> {
    if !url.starts_with("https://github.com/GrimmDev-Glitch/hexanima-pc/releases/download/") {
        return Err("Enlace de actualización no válido".into());
    }
    let cur = std::env::current_exe().map_err(|e| e.to_string())?;
    let part = cur.with_file_name("HexAnima.new.exe.part");
    crate::engine_dl::download_resumable(url, &part, size, progress)?;
    let got = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size > 0 && got != size {
        let _ = std::fs::remove_file(&part);
        return Err(format!("La descarga quedó incompleta ({got} de {size} bytes)"));
    }
    if let Some(want) = sha256 {
        if !sha256_file(&part)?.eq_ignore_ascii_case(want) {
            let _ = std::fs::remove_file(&part);
            return Err("El archivo descargado no coincide (sha256): no se instaló".into());
        }
    }
    let old = old_path(&cur);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&cur, &old).map_err(|e| format!("No se pudo apartar el exe actual: {e}"))?;
    if let Err(e) = std::fs::rename(&part, &cur) {
        let _ = std::fs::rename(&old, &cur); // dejarlo como estaba
        return Err(format!("No se pudo poner el exe nuevo: {e}"));
    }
    Ok(cur)
}

/// Al arrancar: borra el exe de la versión anterior si quedó de una actualización.
pub fn cleanup() {
    if let Ok(cur) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_path(&cur));
        let _ = std::fs::remove_file(cur.with_file_name("HexAnima.new.exe.part"));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn compare_versions() {
        assert!(super::newer("v0.2.3", "0.2.2"));
        assert!(super::newer("v0.10.0", "0.9.9"));
        assert!(!super::newer("v0.2.2", "0.2.2"));
        assert!(!super::newer("v0.2.1", "0.2.2"));
    }
}

#[cfg(test)]
mod net_tests {
    #[test]
    #[ignore]
    fn check_real() {
        let v = super::check().unwrap();
        println!("actual {} · última {} · más nueva {} · exe {}", v["current"], v["latest"], v["newer"], v["exe"]);
    }
}

#[cfg(test)]
mod install_tests {
    /// Prueba la instalación con la versión publicada: reemplaza el ejecutable de ESTA prueba (en target/), no la app.
    #[test]
    #[ignore]
    fn install_real() {
        let v = super::check().unwrap();
        let exe = &v["exe"];
        println!("última {} · exe {} bytes · sha256 {}", v["latest"], exe["size"], exe["sha256"]);
        let me = std::env::current_exe().unwrap();
        let path = super::install(exe["url"].as_str().unwrap(), exe["size"].as_u64().unwrap(), exe["sha256"].as_str(), &mut |_, _| {}).unwrap();
        assert_eq!(path, me);
        let got = super::sha256_file(&path).unwrap();
        println!("instalado en {} · sha256 {got}", path.display());
        assert!(super::old_path(&me).is_file(), "el exe anterior queda como HexAnima.old.exe");
        if let Some(want) = exe["sha256"].as_str() { assert_eq!(got, want); }
    }
}
