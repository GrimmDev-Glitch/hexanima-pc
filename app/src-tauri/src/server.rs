//! Arranca y vigila sd-server.exe (stable-diffusion.cpp) en 127.0.0.1.
//! Todo es local: no usa internet ni la nube.

use serde::Deserialize;
use std::fs::{self, File};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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
}

pub struct Server {
    child: Child,
    pub port: u16,
    pub log_path: PathBuf,
    #[cfg(windows)]
    _job: Job,
}

/// ¿Está instalado el motor? "torch" = motor PyTorch portátil (engine/torch); el resto = sd-server.exe.
pub fn engine_installed(root: &Path, engine: &str) -> bool {
    let d = root.join("engine").join(engine);
    if engine == "torch" {
        d.join("python").join("python.exe").is_file() && d.join("hexanima").join("server.py").is_file()
    } else {
        d.join("sd-server.exe").is_file()
    }
}

impl Server {
    pub fn start(root: &Path, engine: &str, device: Option<&str>, opts: &ServerOpts) -> Result<Server, String> {
        let torch = engine == "torch";
        let exe = if torch {
            root.join("engine").join("torch").join("python").join("python.exe")
        } else {
            root.join("engine").join(engine).join("sd-server.exe")
        };
        if !engine_installed(root, engine) {
            return Err(format!("Falta el motor: {}", exe.display()));
        }
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
        let log = File::create(&log_path).map_err(|e| e.to_string())?;
        let log2 = log.try_clone().map_err(|e| e.to_string())?;

        let mut args: Vec<String> = vec![
            "--listen-ip".into(), "127.0.0.1".into(),
            "--listen-port".into(), port.to_string(),
            "--model-dir".into(), models.display().to_string(),
            "--lora-model-dir".into(), loras.display().to_string(),
            // Real-ESRGAN / 4x-UltraSharp para "Ampliar" y hires fix (se buscan en el primer nivel).
            "--hires-upscalers-dir".into(), upscalers.display().to_string(),
            "--flash-attn".into(), "on".into(),
        ];
        if let Some(d) = device {
            args.push("--backend".into());
            args.push(d.into());
        }
        if opts.offload_to_cpu.unwrap_or(true) {
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
        if let Some(extra) = &opts.extra_args {
            args.extend(extra.split_whitespace().map(String::from));
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
        }
        let mut cmd = Command::new(&exe);
        cmd.args(&args)
            .current_dir(exe.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2));
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        let child = cmd.spawn().map_err(|e| format!("No se pudo iniciar el motor: {e}"))?;

        #[cfg(windows)]
        let job = Job::new_kill_on_close(&child)?;

        Ok(Server {
            child,
            port,
            log_path,
            #[cfg(windows)]
            _job: job,
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
impl Job {
    fn new_kill_on_close(child: &Child) -> Result<Job, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err("CreateJobObject fallo".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            AssignProcessToJobObject(h, child.as_raw_handle() as _);
            Ok(Job(h))
        }
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
