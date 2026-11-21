//! Arranca y vigila sd-server.exe (stable-diffusion.cpp) en 127.0.0.1.
//! Todo es local: no usa internet ni la nube.

use serde::Deserialize;
use std::fs::{self, File};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
#[cfg(windows)]
use std::thread::JoinHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ServerOpts {
    /// Pesos en RAM y subidos a la GPU por partes (perfiles bajo/medio).
    pub offload_to_cpu: Option<bool>,
    /// Tipo de peso al cargar (q8_0 por defecto: en GTX q4 es ~3,6x mas lento).
    pub weight_type: Option<String>,
    /// Opciones extra para el motor, como COMMANDLINE_ARGS de Forge.
    pub extra_args: Option<String>,
    /// Detector de ADetailer cargado en el motor: "face" | "hand" (uno a la vez).
    pub ad_model: Option<String>,
    pub cpu_recovery: Option<bool>,
    /// Mapea los pesos desde el disco cuando superan la RAM disponible sobre la reserva.
    pub disk_offload: Option<bool>,
    /// Mantiene los pesos PyTorch safetensors mapeados desde disco para sistemas con poca RAM/VRAM.
    pub torch_low_vram: Option<bool>,
    /// Memoria que Forge reserva para cálculo antes de asignar el resto a pesos de GPU.
    pub torch_inference_mb: Option<u16>,
}

pub struct Server {
    child: Child,
    pub port: u16,
    pub log_path: PathBuf,
    #[cfg(windows)]
    _job: Arc<Job>,
    #[cfg(windows)]
    _resource_guard: ResourceGuard,
    #[cfg(windows)]
    _reservation: EngineReservation,
}

#[cfg(windows)]
struct EngineReservation(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for EngineReservation {}

#[cfg(windows)]
impl EngineReservation {
    fn acquire() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let name: Vec<u16> = "Local\\HexAnimaPC.Engine".encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        let error = unsafe { GetLastError() };
        if handle.is_null() {
            return Err(format!("No se pudo reservar el motor de HexAnima: código {error}"));
        }
        let reservation = Self(handle);
        if error == ERROR_ALREADY_EXISTS {
            return Err("Otra instancia de HexAnima ya tiene reservado el motor.".into());
        }
        Ok(reservation)
    }
}

#[cfg(windows)]
impl Drop for EngineReservation {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}

/// ¿Está instalado el motor? "torch" = motor PyTorch portátil (engine/torch); el resto = sd-server.exe.
pub fn engine_installed(root: &Path, engine: &str) -> bool {
    let d = root.join("engine").join(engine);
    if engine == "torch" {
        d.join("python").join("python.exe").is_file() && d.join("hexanima").join("server.py").is_file()
    } else if engine == "cpu" {
        // Release packages include CPU backend DLLs beside CUDA/Vulkan builds,
        // but omit the separate CPU-only package to keep the download smaller.
        // Those binaries can still run with `--backend cpu`.
        [d.join("sd-server.exe"), root.join("engine/cuda/sd-server.exe"), root.join("engine/vulkan/sd-server.exe")]
            .iter().any(|path| path.is_file())
    } else {
        d.join("sd-server.exe").is_file()
    }
}

fn engine_executable(root: &Path, engine: &str) -> PathBuf {
    let direct = root.join("engine").join(engine).join("sd-server.exe");
    if engine != "cpu" || direct.is_file() { return direct; }
    for fallback in ["cuda", "vulkan"] {
        let candidate = root.join("engine").join(fallback).join("sd-server.exe");
        if candidate.is_file() { return candidate; }
    }
    direct
}

/// Resolve a requested backend without silently substituting a detected one.
pub fn resolve_engine(root: &Path, requested: Option<&str>, detected: &str, detected_device: Option<&str>, gpu: Option<&crate::hw::Gpu>) -> Result<(String, Option<String>), String> {
    if let Some(engine) = requested {
        if !["torch", "vulkan", "cuda", "cpu"].contains(&engine) { return Err(format!("Motor no reconocido: {engine}")); }
        if !engine_installed(root, engine) { return Err(format!("Falta el motor seleccionado: {engine}. Instálalo o selecciona Automático.")); }
        let device = if engine == "torch" { None }
            else if engine == detected { detected_device.map(str::to_owned) }
            else { crate::hw::engine_device(root, engine, gpu) };
        if !["torch", "cpu"].contains(&engine) && device.is_none() {
            return Err(format!("No se pudo confirmar un dispositivo para el motor {engine}. Revisa que esté instalado y que detecte una GPU compatible."));
        }
        return Ok((engine.to_owned(), device));
    }
    Ok((detected.to_owned(), detected_device.map(str::to_owned)))
}

impl Server {
    pub fn start(root: &Path, engine: &str, device: Option<&str>, opts: &ServerOpts) -> Result<Server, String> {
        let torch = engine == "torch";
        let exe = if torch {
            root.join("engine").join("torch").join("python").join("python.exe")
        } else {
            engine_executable(root, engine)
        };
        if !engine_installed(root, engine) {
            return Err(format!("Falta el motor: {}", exe.display()));
        }
        #[cfg(windows)]
        let reservation = EngineReservation::acquire()?;
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .map_err(|e| format!("Sin puerto libre: {e}"))?;

        let models = root.join("models");
        let loras = root.join("loras");
        let upscalers = models.join("upscalers");
        let _ = fs::create_dir_all(&models);
        let _ = fs::create_dir_all(&loras);
        let _ = fs::create_dir_all(&upscalers);
        let logs = root.join("logs");
        let _ = fs::create_dir_all(&logs);
        let log_path = logs.join("server.log");
        let mut log = File::create(&log_path).map_err(|e| e.to_string())?;
        writeln!(log, "[BACKEND] engine={engine} device={} cpu_limited={}", device.unwrap_or("auto"), opts.cpu_recovery.unwrap_or(false)).map_err(|e| e.to_string())?;
        let log2 = log.try_clone().map_err(|e| e.to_string())?;

        let mut args: Vec<String> = vec![
            "--listen-ip".into(), "127.0.0.1".into(),
            "--listen-port".into(), port.to_string(),
            "--model-dir".into(), models.display().to_string(),
            "--lora-model-dir".into(), loras.display().to_string(),
            // Real-ESRGAN / 4x-UltraSharp para "Ampliar" y hires fix (se buscan en el primer nivel).
            "--hires-upscalers-dir".into(), upscalers.display().to_string(),
            "--flash-attn".into(), "on".into(),
            // El TAE (taeqi2_1, taew2_1, taesdxl) solo para la vista previa: la imagen final sale con el VAE completo
            "--taesd-preview-only".into(),
        ];
        let cpu_recovery = opts.cpu_recovery.unwrap_or(false);
        if let Some(d) = device {
            args.push("--backend".into());
            args.push(d.into());
        }
        if cpu_recovery {
            args.extend(["--mmap".into(), "--params-backend".into(), "disk".into(), "--batched-cfg".into(), "off".into()]);
            args.extend(["--vae-tiling".into(), "--vae-tile-size".into(), "256".into()]);
            let threads = std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1));
            args.extend(["--threads".into(), threads.to_string()]);
        } else if opts.disk_offload.unwrap_or(false) && !torch {
            args.extend(["--mmap".into(), "--params-backend".into(), "disk".into()]);
        } else if opts.offload_to_cpu.unwrap_or(true) {
            args.push("--offload-to-cpu".into());
        }
        let wt = opts.weight_type.clone().unwrap_or_else(|| "q8_0".into());
        if wt != "f16" && !wt.is_empty() {
            args.push("--type".into());
            args.push(wt);
        }
        // ADetailer: el motor solo admite un detector; cambiar de caras a manos reinicia el motor.
        if let Some(det) = opts.ad_model.as_deref().and_then(|k| crate::yolo::path_for(root, k)) {
            args.push("--ad-model".into());
            args.push(det.display().to_string());
        }
        if let Some(extra) = opts.extra_args.as_ref().filter(|_| !cpu_recovery && !torch) {
            let extra_args: Vec<String> = extra.split_whitespace().map(String::from).collect();
            if extra_args.iter().any(|arg| arg == "--backend" || arg.starts_with("--backend=")) {
                return Err("La opción --backend se controla desde Ajustes → Motor para mantener coherentes la selección y la seguridad.".into());
            }
            args.extend(extra_args);
        }

        if torch {
            // Motor PyTorch (backend de Forge): Python portátil aislado (-s -E) con su servidor.
            // Gestiona solo la VRAM/RAM como Forge; no usa --backend, --type ni el detector de ADetailer.
            let server = root.join("engine").join("torch").join("hexanima").join("server.py");
            args = vec![
                "-s".into(), "-E".into(), "-u".into(), server.display().to_string(),
                "--listen-port".into(), port.to_string(),
                "--model-dir".into(), models.display().to_string(),
                "--lora-model-dir".into(), loras.display().to_string(),
                "--hires-upscalers-dir".into(), upscalers.display().to_string(),
            ];
            if opts.torch_low_vram.unwrap_or(false) {
                args.push("--low-vram".into());
            }
            args.extend(["--inference-mb".into(), opts.torch_inference_mb.unwrap_or(1024).to_string()]);
        }
        let mut cmd = Command::new(&exe);
        cmd.args(&args)
            .current_dir(exe.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2));
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        // Check RAM/commit and configure the Job Object before the heavy engine starts.
        #[cfg(windows)]
        let job = Arc::new(Job::prepare(cpu_recovery || (torch && opts.torch_low_vram.unwrap_or(false)))?);
        let mut child = cmd.spawn().map_err(|e| format!("No se pudo iniciar el motor: {e}"))?;

        #[cfg(windows)]
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        #[cfg(windows)]
        let resource_guard = ResourceGuard::start(job.clone(), log_path.clone());

        Ok(Server {
            child,
            port,
            log_path,
            #[cfg(windows)]
            _job: job,
            #[cfg(windows)]
            _resource_guard: resource_guard,
            #[cfg(windows)]
            _reservation: reservation,
        })
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Job object de Windows: si HexAnima se cierra o se cuelga, Windows mata el motor
/// tambien, asi nunca queda un sd-server huerfano ocupando la GPU.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn prepare(limit_cpu: bool) -> Result<Job, String> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err("CreateJobObject fallo".into());
            }
            let job = Job(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            let memory = crate::hw::memory();
            let total_gib = memory.ram_total_gb;
            let free_gib = memory.ram_free_gb;
            let reserve_gib = crate::hw::system_reserve_gb(total_gib);
            let mut budget_gib = (free_gib - reserve_gib).min(total_gib * 0.70);
            if let Some(commit_free) = memory.commit_free_gb {
                budget_gib = budget_gib.min(commit_free - reserve_gib);
            } else {
                return Err("Windows no pudo medir el margen de memoria comprometida; no es seguro iniciar el motor.".into());
            }
            if budget_gib < 0.5 {
                return Err(format!("RAM libre insuficiente para iniciar el motor: {free_gib:.1} GB. HexAnima reserva {reserve_gib:.1} GB para Windows."));
            }
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = (budget_gib * 1_073_741_824.0) as usize;
            if SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0 {
                return Err(format!("No se pudo configurar el cierre y el límite de RAM del motor: {}", std::io::Error::last_os_error()));
            }
            if limit_cpu {
                let mut rate: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = std::mem::zeroed();
                rate.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
                // Windows expresa el porcentaje en centésimas.
                rate.Anonymous.CpuRate = 2500;
                if SetInformationJobObject(
                    h,
                    JobObjectCpuRateControlInformation,
                    &rate as *const _ as *const _,
                    std::mem::size_of_val(&rate) as u32,
                ) == 0 {
                    return Err(format!("No se pudo limitar la CPU: {}", std::io::Error::last_os_error()));
                }
            }
            Ok(job)
        }
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        let ok = unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, child.as_raw_handle() as _) };
        if ok == 0 { return Err(format!("No se pudo asociar el motor a HexAnima: {}", std::io::Error::last_os_error())); }
        Ok(())
    }
}

/// Watches system-wide memory outside the inference worker, requests time for cooperative
/// cancellation, then terminates only this Job Object if pressure persists.
#[cfg(windows)]
struct ResourceGuard {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(windows)]
impl ResourceGuard {
    fn start(job: Arc<Job>, log_path: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new().name("hexanima-memory-guard".into()).spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if thread_stop.load(Ordering::Relaxed) { break; }
                let (total_gb, physical_free_gb, commit_free_gb) = crate::hw::system_memory();
                if crate::hw::under_memory_pressure_values(total_gb, physical_free_gb, commit_free_gb) {
                    let commit = commit_free_gb.map_or_else(|| "no disponible".into(), |v| format!("{v:.1} GB"));
                    let line = format!("[SAFETY] Presión crítica; solicitud de parada cooperativa con 5 s para liberar recursos: RAM física disponible {:.1}/{:.1} GB; commit disponible {}.\n", physical_free_gb, total_gb, commit);
                    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
                    for _ in 0..50 {
                        if thread_stop.load(Ordering::Relaxed) { break; }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    if thread_stop.load(Ordering::Relaxed) { break; }
                    let (total_gb, physical_free_gb, commit_free_gb) = crate::hw::system_memory();
                    if !crate::hw::under_memory_pressure_values(total_gb, physical_free_gb, commit_free_gb) { continue; }
                    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
                    unsafe { TerminateJobObject(job.0, 0xE000_0001); }
                    let line = "[SAFETY] La presión persistió; se terminó el proceso gestionado para liberar memoria.\n";
                    let _ = std::fs::OpenOptions::new().create(true).append(true).open(log_path).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
                    break;
                }
            }
        }).ok();
        Self { stop, thread }
    }
}

#[cfg(windows)]
impl Drop for ResourceGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Ultimas lineas del registro del motor (para mostrar errores en la app).
pub fn log_tail(path: &Path, lines: usize) -> String {
    let text = fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let text = text.replace('\r', "\n");
    let v: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod backend_selection_tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("hexanima-backend-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("engine/torch/python")).unwrap();
        fs::create_dir_all(root.join("engine/torch/hexanima")).unwrap();
        fs::write(root.join("engine/torch/python/python.exe"), b"fixture").unwrap();
        fs::write(root.join("engine/torch/hexanima/server.py"), b"fixture").unwrap();
        root
    }

    #[test]
    fn manual_pytorch_is_not_replaced_by_detected_vulkan() {
        let root = fixture();
        let resolved = resolve_engine(&root, Some("torch"), "vulkan", Some("vulkan1"), None).unwrap();
        assert_eq!(resolved.0, "torch");
        assert_eq!(resolved.1, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_manual_backend_returns_an_error_instead_of_falling_back() {
        let root = fixture();
        let error = resolve_engine(&root, Some("cuda"), "vulkan", Some("vulkan1"), None).unwrap_err();
        assert!(error.contains("Falta el motor seleccionado: cuda"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_mode_keeps_the_detected_backend() {
        let root = fixture();
        let resolved = resolve_engine(&root, None, "vulkan", Some("vulkan1"), None).unwrap();
        assert_eq!(resolved, ("vulkan".into(), Some("vulkan1".into())));
        fs::remove_dir_all(root).unwrap();
    }
}
