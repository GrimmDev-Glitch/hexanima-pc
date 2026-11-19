//! Deteccion de hardware: grafica, VRAM, RAM, motor recomendado y dispositivo.
//! Equivale a tools/detect_hw.py (prototipo), sin depender de Python.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Debug)]
pub struct Gpu {
    pub name: String,
    pub vendor: String, // nvidia | amd | intel | other
    pub vram_gb: Option<f64>,
    pub driver: Option<String>,
    /// Capacidad CUDA (p. ej. 7.5 en la GTX 1650, 12.0 en la RTX 5060); None si nvidia-smi no la da.
    pub compute_cap: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Hardware {
    pub gpu: Option<Gpu>,
    pub ram_gb: f64,
    pub engine: String,           // vulkan | cuda | cpu
    pub engine_candidates: Vec<String>,
    pub backend_device: Option<String>, // p.ej. "vulkan1"
    pub profile: String,          // bajo | medio | alto
}

#[derive(Serialize, Clone, Debug)]
pub struct Memory {
    pub ram_total_gb: f64,
    pub ram_free_gb: f64,
    pub vram_total_gb: Option<f64>,
    pub vram_free_gb: Option<f64>,
    pub gpu_temp_c: Option<i64>,
    /// Portátil desenchufado (la gráfica va limitada: GTX 1650 a 20 W, ~3 veces más lento).
    pub on_battery: bool,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// RAM total y libre en GB (GlobalMemoryStatusEx).
pub fn ram() -> (f64, f64) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m: MEMORYSTATUSEX = std::mem::zeroed();
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut m) != 0 {
            let gb = 1024f64.powi(3);
            return (round1(m.ullTotalPhys as f64 / gb), round1(m.ullAvailPhys as f64 / gb));
        }
    }
    (0.0, 0.0)
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn nvidia_query(fields: &str) -> Option<Vec<String>> {
    let out = run(
        "nvidia-smi",
        &[&format!("--query-gpu={fields}"), "--format=csv,noheader,nounits"],
    )?;
    let line = out.lines().next()?;
    Some(line.split(',').map(|s| s.trim().to_string()).collect())
}

fn detect_nvidia() -> Option<Gpu> {
    let v = nvidia_query("name,memory.total,driver_version")?;
    if v.len() < 3 {
        return None;
    }
    Some(Gpu {
        name: v[0].clone(),
        vendor: "nvidia".into(),
        vram_gb: v[1].parse::<f64>().ok().map(|mb| round1(mb / 1024.0)),
        driver: Some(v[2].clone()),
        // aparte: los drivers viejos no conocen compute_cap y harían fallar toda la consulta
        compute_cap: nvidia_query("compute_cap").and_then(|c| c.first()?.parse().ok()),
    })
}

/// Respaldo para AMD/Intel: WMI. AdapterRAM se queda en 4 GB (32 bits).
fn detect_wmi() -> Option<Gpu> {
    let out = run(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.AdapterRAM)\" }",
        ],
    )?;
    let mut best: Option<Gpu> = None;
    for line in out.lines() {
        let mut it = line.splitn(2, '|');
        let name = it.next().unwrap_or("").trim().to_string();
        let low = name.to_lowercase();
        if name.is_empty() || low.contains("basic") || low.contains("virtual") || low.contains("remote") {
            continue;
        }
        let vendor = if low.contains("nvidia") {
            "nvidia"
        } else if low.contains("amd") || low.contains("radeon") {
            "amd"
        } else if low.contains("intel") {
            "intel"
        } else {
            "other"
        };
        let vram = it
            .next()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|b| *b > 0.0)
            .map(|b| round1(b / 1024f64.powi(3)));
        let g = Gpu { name, vendor: vendor.into(), vram_gb: vram, driver: None, compute_cap: None };
        // Preferir dedicada (no Intel) y con mas VRAM
        let score = |g: &Gpu| (g.vendor != "intel") as i32 * 100 + g.vram_gb.unwrap_or(0.0) as i32;
        if best.as_ref().map_or(true, |b| score(&g) > score(b)) {
            best = Some(g);
        }
    }
    best
}

/// NVIDIA sin tensor cores: GTX 9xx/10xx/16xx y MX.
pub fn is_gtx(g: &Gpu) -> bool {
    let n = g.name.to_uppercase();
    g.vendor == "nvidia" && (n.contains("GTX") || n.contains(" MX"))
}

/// Motores por orden de preferencia. Medido en GTX 1650 (SDXL q8): Vulkan 16,9 s/paso,
/// CUDA oficial 20,9 s/paso; con Anima el muestreo es igual. Vulkan pesa 28 MB.
pub fn engine_candidates(gpu: Option<&Gpu>) -> Vec<String> {
    let v: &[&str] = match gpu {
        None => &["cpu", "vulkan"],
        Some(g) if g.vendor == "nvidia" && !is_gtx(g) => &["cuda", "vulkan", "cpu"],
        Some(g) if g.vendor == "nvidia" => &["vulkan", "cuda", "cpu"],
        Some(_) => &["vulkan", "cpu"],
    };
    v.iter().map(|s| s.to_string()).collect()
}

fn profile_for(gpu: Option<&Gpu>, ram_gb: f64) -> String {
    let vram = gpu.and_then(|g| g.vram_gb).unwrap_or(0.0);
    let mut p = if gpu.is_none() || vram <= 2.5 {
        "bajo"
    } else if vram < 7.5 {
        "medio"
    } else {
        "alto"
    };
    if ram_gb > 0.0 && ram_gb < 12.0 && p == "medio" {
        p = "bajo";
    }
    p.into()
}

/// Dispositivo del motor para --backend. En laptops Vulkan numera primero la integrada.
pub fn engine_device(root: &Path, engine: &str, gpu: Option<&Gpu>) -> Option<String> {
    if engine == "cpu" {
        return Some("cpu".into());
    }
    let exe = root.join("engine").join(engine).join("sd-cli.exe");
    if !exe.exists() {
        return None;
    }
    let mut c = Command::new(&exe);
    c.arg("--list-devices").current_dir(exe.parent()?);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = c.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let devs: Vec<(String, String)> = text
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(n, _)| !n.to_uppercase().starts_with("CPU"))
        .map(|(n, d)| (n.trim().to_lowercase(), d.trim().to_string()))
        .collect();
    if devs.is_empty() {
        return None;
    }
    let want = gpu.map(|g| g.name.to_lowercase()).unwrap_or_default();
    if !want.is_empty() {
        if let Some((n, _)) = devs.iter().find(|(_, d)| {
            let d = d.to_lowercase();
            d.contains(&want) || want.contains(&d)
        }) {
            return Some(n.clone());
        }
    }
    let integrated = ["intel", "microsoft", "llvmpipe", "basic"];
    devs.iter()
        .find(|(_, d)| !integrated.iter().any(|k| d.to_lowercase().contains(k)))
        .or_else(|| devs.first())
        .map(|(n, _)| n.clone())
}

pub fn detect(root: &Path) -> Hardware {
    let (ram_total, _) = ram();
    let gpu = detect_nvidia().or_else(detect_wmi);
    let candidates = engine_candidates(gpu.as_ref());
    let engine = candidates
        .iter()
        .find(|e| root.join("engine").join(e.as_str()).join("sd-server.exe").exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    let device = engine_device(root, &engine, gpu.as_ref());
    Hardware {
        profile: profile_for(gpu.as_ref(), ram_total),
        gpu,
        ram_gb: ram_total,
        engine,
        engine_candidates: candidates,
        backend_device: device,
    }
}

/// Memoria libre ahora (para la barra lateral y el modo adaptativo).
pub fn memory() -> Memory {
    let (rt, rf) = ram();
    let nv = nvidia_query("memory.total,memory.free,temperature.gpu");
    let mb = |s: &String| s.parse::<f64>().ok().map(|v| round1(v / 1024.0));
    Memory {
        ram_total_gb: rt,
        ram_free_gb: rf,
        vram_total_gb: nv.as_ref().and_then(|v| v.first()).and_then(mb),
        vram_free_gb: nv.as_ref().and_then(|v| v.get(1)).and_then(mb),
        gpu_temp_c: nv.as_ref().and_then(|v| v.get(2)).and_then(|s| s.parse().ok()),
        on_battery: on_battery(),
    }
}

#[cfg(windows)]
fn on_battery() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // ACLineStatus 0 = sin cargador; 1 = enchufado; 255 = desconocido (PC de escritorio sin batería)
    unsafe { GetSystemPowerStatus(&mut st) != 0 && st.ACLineStatus == 0 }
}
#[cfg(not(windows))]
fn on_battery() -> bool {
    false
}
