//! Detectores de ADetailer: descarga los YOLOv8 (.pt de Ultralytics) y los convierte al
//! .safetensors que pide sd.cpp (`--ad-model`), sin Python.
//!
//! Igual que scripts/convert_yolov8_to_safetensors.py de stable-diffusion.cpp: fusiona cada
//! Conv+BatchNorm, descarta bn y dfl, pesos en f16 y sesgos en f32, y escribe los metadatos yolov8.*.
//! El pickle del .pt NO se ejecuta: este lector solo entiende datos (diccionarios, listas, números,
//! textos) y reconstruye tensores; cualquier clase queda como un objeto inerte.

use serde_json::{json, Value as Json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tauri::AppHandle;

/// (tipo, archivo convertido, .pt de origen). Bingsu/adetailer: los mismos que usa el teléfono.
pub const DETECTORS: [(&str, &str, &str); 2] = [
    ("face", "face_yolov8n.safetensors", "https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8n.pt"),
    ("hand", "hand_yolov8n.safetensors", "https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8n.pt"),
];

pub fn dir(root: &Path) -> PathBuf {
    root.join("models").join("detectors")
}

pub fn status(root: &Path) -> Json {
    json!(DETECTORS.iter().map(|(k, f, _)| json!({ "kind": k, "file": f, "installed": dir(root).join(f).is_file() })).collect::<Vec<_>>())
}

/// Ruta del detector instalado para `kind` ("face" | "hand").
pub fn path_for(root: &Path, kind: &str) -> Option<PathBuf> {
    let (_, f, _) = DETECTORS.iter().find(|(k, _, _)| *k == kind)?;
    let p = dir(root).join(f);
    p.is_file().then_some(p)
}

pub fn install(app: &AppHandle, root: &Path, kind: &str) -> Result<String, String> {
    let (_, file, url) = DETECTORS.iter().find(|(k, _, _)| *k == kind).ok_or("Detector desconocido")?;
    let d = dir(root);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let pt = d.join(format!("{kind}_yolov8n.pt.part"));
    crate::civitai::fetch_to(app, url, &pt, &format!("det-{kind}"))?;
    let r = convert(&pt, &d.join(file));
    let _ = fs::remove_file(&pt);
    r.map(|_| file.to_string())
}

// ---------------------------------------------------------------- pickle (solo datos)

#[derive(Clone, Debug)]
#[allow(dead_code)]
enum V {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    Tuple(Rc<Vec<V>>),
    List(Rc<RefCell<Vec<V>>>),
    Dict(Rc<RefCell<Vec<(V, V)>>>),
    Global(String, String),
    Obj(Rc<RefCell<Obj>>),
    Storage { key: String, dtype: String },
    Tensor(Rc<Tensor>),
    Mark,
}

#[derive(Debug, Default)]
struct Obj {
    class: String,
    state: Vec<(String, V)>,
}

#[derive(Debug)]
struct Tensor {
    key: String,
    dtype: String,
    offset: usize,
    size: Vec<usize>,
    stride: Vec<usize>,
}

impl V {
    fn dict() -> V {
        V::Dict(Rc::new(RefCell::new(Vec::new())))
    }
    fn as_int(&self) -> Option<i64> {
        match self {
            V::Int(i) => Some(*i),
            V::Bool(b) => Some(*b as i64),
            _ => None,
        }
    }
    fn items(&self) -> Vec<V> {
        match self {
            V::Tuple(t) => t.as_ref().clone(),
            V::List(l) => l.borrow().clone(),
            _ => vec![],
        }
    }
    /// Campo de un diccionario o de un objeto por nombre.
    fn get(&self, name: &str) -> Option<V> {
        match self {
            V::Dict(d) => d.borrow().iter().find(|(k, _)| matches!(k, V::Str(s) if s == name)).map(|(_, v)| v.clone()),
            V::Obj(o) => o.borrow().state.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()),
            _ => None,
        }
    }
    fn pairs(&self) -> Vec<(String, V)> {
        match self {
            V::Dict(d) => d
                .borrow()
                .iter()
                .map(|(k, v)| (match k { V::Str(s) => s.clone(), V::Int(i) => i.to_string(), _ => String::new() }, v.clone()))
                .collect(),
            _ => vec![],
        }
    }
}

struct Unpickler<'a> {
    b: &'a [u8],
    i: usize,
    stack: Vec<V>,
    memo: BTreeMap<u32, V>,
}

impl<'a> Unpickler<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.i..self.i + n).ok_or("pickle truncado")?;
        self.i += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn line(&mut self) -> Result<String, String> {
        let start = self.i;
        while *self.b.get(self.i).ok_or("pickle truncado")? != b'\n' {
            self.i += 1;
        }
        let s = String::from_utf8_lossy(&self.b[start..self.i]).into_owned();
        self.i += 1;
        Ok(s)
    }
    fn pop(&mut self) -> Result<V, String> {
        self.stack.pop().ok_or_else(|| "pila vacía".to_string())
    }
    fn pop_mark(&mut self) -> Result<Vec<V>, String> {
        let pos = self.stack.iter().rposition(|v| matches!(v, V::Mark)).ok_or("falta MARK")?;
        let items = self.stack.split_off(pos + 1);
        self.stack.pop();
        Ok(items)
    }
    fn top(&mut self) -> Result<&mut V, String> {
        self.stack.last_mut().ok_or_else(|| "pila vacía".to_string())
    }

    fn reduce(&mut self, f: V, args: Vec<V>) -> V {
        match f {
            V::Global(m, n) if m == "collections" && n == "OrderedDict" => V::dict(),
            V::Global(m, n) if m == "torch._utils" && n == "_rebuild_tensor_v2" => {
                let usz = |v: &V| v.items().iter().filter_map(|x| x.as_int()).map(|x| x as usize).collect::<Vec<_>>();
                match (args.first(), args.get(1).and_then(V::as_int), args.get(2), args.get(3)) {
                    (Some(V::Storage { key, dtype }), Some(off), Some(sz), Some(st)) => V::Tensor(Rc::new(Tensor {
                        key: key.clone(),
                        dtype: dtype.clone(),
                        offset: off as usize,
                        size: usz(sz),
                        stride: usz(st),
                    })),
                    _ => V::None,
                }
            }
            V::Global(m, n) if m == "torch._utils" && n == "_rebuild_parameter" => args.into_iter().next().unwrap_or(V::None),
            V::Global(m, n) => V::Obj(Rc::new(RefCell::new(Obj { class: format!("{m}.{n}"), state: vec![] }))),
            _ => V::None,
        }
    }

    fn build(obj: &V, state: V) {
        // state puede ser un dict o (dict, slots)
        let st = match &state {
            V::Tuple(t) if t.len() == 2 => {
                let mut v = t[0].pairs();
                v.extend(t[1].pairs());
                v
            }
            _ => state.pairs(),
        };
        if let V::Obj(o) = obj {
            o.borrow_mut().state.extend(st);
        }
    }

    fn run(&mut self) -> Result<V, String> {
        loop {
            let op = self.u8()?;
            match op {
                0x80 => { self.u8()?; }                                   // PROTO
                0x95 => { self.take(8)?; }                                // FRAME
                b'.' => return self.pop(),                                // STOP
                b'(' => self.stack.push(V::Mark),
                b'N' => self.stack.push(V::None),
                0x88 => self.stack.push(V::Bool(true)),
                0x89 => self.stack.push(V::Bool(false)),
                b'J' => { let v = self.u32()? as i32; self.stack.push(V::Int(v as i64)); }
                b'K' => { let v = self.u8()?; self.stack.push(V::Int(v as i64)); }
                b'M' => { let v = self.u16()?; self.stack.push(V::Int(v as i64)); }
                0x8a => {                                                 // LONG1
                    let n = self.u8()? as usize;
                    let bytes = self.take(n)?;
                    let mut v: i64 = 0;
                    for (k, b) in bytes.iter().enumerate().take(8) { v |= (*b as i64) << (8 * k); }
                    if n > 0 && n < 8 && bytes[n - 1] & 0x80 != 0 { v -= 1i64 << (8 * n); }
                    self.stack.push(V::Int(v));
                }
                b'G' => { let v = f64::from_be_bytes(self.take(8)?.try_into().unwrap()); self.stack.push(V::Float(v)); }
                b'X' => { let n = self.u32()? as usize; let s = String::from_utf8_lossy(self.take(n)?).into_owned(); self.stack.push(V::Str(s)); }
                0x8c => { let n = self.u8()? as usize; let s = String::from_utf8_lossy(self.take(n)?).into_owned(); self.stack.push(V::Str(s)); }
                b'U' => { let n = self.u8()? as usize; let s = String::from_utf8_lossy(self.take(n)?).into_owned(); self.stack.push(V::Str(s)); }
                b'T' => { let n = self.u32()? as usize; let s = String::from_utf8_lossy(self.take(n)?).into_owned(); self.stack.push(V::Str(s)); }
                b'C' => { let n = self.u8()? as usize; let s = self.take(n)?.to_vec(); self.stack.push(V::Bytes(s)); }
                b'B' => { let n = self.u32()? as usize; let s = self.take(n)?.to_vec(); self.stack.push(V::Bytes(s)); }
                b'}' => self.stack.push(V::dict()),
                b']' => self.stack.push(V::List(Rc::new(RefCell::new(vec![])))),
                b')' => self.stack.push(V::Tuple(Rc::new(vec![]))),
                0x8f => self.stack.push(V::List(Rc::new(RefCell::new(vec![])))), // EMPTY_SET (como lista)
                0x90 => { let items = self.pop_mark()?; if let V::List(l) = self.top()? { l.borrow_mut().extend(items); } } // ADDITEMS
                0x91 => { let items = self.pop_mark()?; self.stack.push(V::List(Rc::new(RefCell::new(items)))); }        // FROZENSET
                b't' => { let items = self.pop_mark()?; self.stack.push(V::Tuple(Rc::new(items))); }
                0x85 => { let a = self.pop()?; self.stack.push(V::Tuple(Rc::new(vec![a]))); }
                0x86 => { let b = self.pop()?; let a = self.pop()?; self.stack.push(V::Tuple(Rc::new(vec![a, b]))); }
                0x87 => { let c = self.pop()?; let b = self.pop()?; let a = self.pop()?; self.stack.push(V::Tuple(Rc::new(vec![a, b, c]))); }
                b'l' => { let items = self.pop_mark()?; self.stack.push(V::List(Rc::new(RefCell::new(items)))); }
                b'd' => {
                    let items = self.pop_mark()?;
                    let pairs = items.chunks(2).filter(|c| c.len() == 2).map(|c| (c[0].clone(), c[1].clone())).collect();
                    self.stack.push(V::Dict(Rc::new(RefCell::new(pairs))));
                }
                b'a' => { let v = self.pop()?; if let V::List(l) = self.top()? { l.borrow_mut().push(v); } }
                b'e' => { let items = self.pop_mark()?; if let V::List(l) = self.top()? { l.borrow_mut().extend(items); } }
                b's' => { let v = self.pop()?; let k = self.pop()?; if let V::Dict(d) = self.top()? { d.borrow_mut().push((k, v)); } }
                b'u' => {
                    let items = self.pop_mark()?;
                    if let V::Dict(d) = self.top()? {
                        let mut d = d.borrow_mut();
                        for c in items.chunks(2).filter(|c| c.len() == 2) { d.push((c[0].clone(), c[1].clone())); }
                    }
                }
                b'q' => { let k = self.u8()? as u32; let v = self.top()?.clone(); self.memo.insert(k, v); }
                b'r' => { let k = self.u32()?; let v = self.top()?.clone(); self.memo.insert(k, v); }
                0x94 => { let k = self.memo.len() as u32; let v = self.top()?.clone(); self.memo.insert(k, v); } // MEMOIZE
                b'h' => { let k = self.u8()? as u32; let v = self.memo.get(&k).cloned().ok_or("memo")?; self.stack.push(v); }
                b'j' => { let k = self.u32()?; let v = self.memo.get(&k).cloned().ok_or("memo")?; self.stack.push(v); }
                b'c' => { let m = self.line()?; let n = self.line()?; self.stack.push(V::Global(m, n)); }
                0x93 => { let n = self.pop()?; let m = self.pop()?; if let (V::Str(m), V::Str(n)) = (m, n) { self.stack.push(V::Global(m, n)); } } // STACK_GLOBAL
                b'R' => { let args = self.pop()?; let f = self.pop()?; let v = self.reduce(f, args.items()); self.stack.push(v); }
                0x81 => { let args = self.pop()?; let cls = self.pop()?; let v = self.reduce(cls, args.items()); self.stack.push(v); } // NEWOBJ
                b'b' => { let st = self.pop()?; let obj = self.top()?.clone(); Self::build(&obj, st); }
                b'Q' => {                                                 // BINPERSID
                    let pid = self.pop()?.items();
                    let key = match pid.get(2) { Some(V::Str(s)) => s.clone(), Some(V::Int(i)) => i.to_string(), _ => return Err("persistent id".into()) };
                    let dtype = match pid.get(1) { Some(V::Global(_, n)) => n.clone(), _ => String::new() };
                    self.stack.push(V::Storage { key, dtype });
                }
                o => return Err(format!("opcode de pickle no soportado: 0x{o:02x}")),
            }
        }
    }
}

// ---------------------------------------------------------------- conversión

fn f16_to_f32(h: u16) -> f32 {
    let s = ((h >> 15) & 1) as u32;
    let e = ((h >> 10) & 0x1f) as u32;
    let m = (h & 0x3ff) as u32;
    let bits = if e == 0 {
        if m == 0 { s << 31 } else {
            let mut e = 127 - 15 + 1;
            let mut m = m;
            while m & 0x400 == 0 { m <<= 1; e -= 1; }
            (s << 31) | ((e as u32) << 23) | ((m & 0x3ff) << 13)
        }
    } else if e == 31 { (s << 31) | 0x7f80_0000 | (m << 13) } else { (s << 31) | ((e + 127 - 15) << 23) | (m << 13) };
    f32::from_bits(bits)
}

fn f32_to_f16(f: f32) -> u16 {
    let x = f.to_bits();
    let s = ((x >> 16) & 0x8000) as u16;
    let e = ((x >> 23) & 0xff) as i32;
    let m = x & 0x7f_ffff;
    if e == 255 { return s | 0x7c00 | if m != 0 { 0x200 } else { 0 }; }
    let e2 = e - 127 + 15;
    if e2 >= 31 { return s | 0x7c00; }
    if e2 <= 0 {
        if e2 < -10 { return s; }
        let m = m | 0x80_0000;
        let shift = (14 - e2) as u32;
        let mut h = (m >> shift) as u16;
        if (m >> (shift - 1)) & 1 != 0 && ((m & ((1 << (shift - 1)) - 1)) != 0 || h & 1 != 0) { h += 1; }
        return s | h;
    }
    let mut h = s | ((e2 as u16) << 10) | (m >> 13) as u16;
    if m & 0x1000 != 0 && (m & 0x2fff) != 0 { h += 1; }
    h
}

struct Arr {
    shape: Vec<usize>,
    data: Vec<f64>,
}

fn load_tensor(zip: &mut zip::ZipArchive<fs::File>, prefix: &str, t: &Tensor) -> Result<Arr, String> {
    let mut raw = Vec::new();
    zip.by_name(&format!("{prefix}data/{}", t.key)).map_err(|e| e.to_string())?.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let (isz, f): (usize, fn(&[u8]) -> f64) = match t.dtype.as_str() {
        "HalfStorage" => (2, |b| f16_to_f32(u16::from_le_bytes([b[0], b[1]])) as f64),
        "FloatStorage" => (4, |b| f32::from_le_bytes(b.try_into().unwrap()) as f64),
        "DoubleStorage" => (8, |b| f64::from_le_bytes(b.try_into().unwrap())),
        "LongStorage" => (8, |b| i64::from_le_bytes(b.try_into().unwrap()) as f64),
        d => return Err(format!("tipo de tensor no soportado: {d}")),
    };
    let n: usize = t.size.iter().product();
    let mut data = Vec::with_capacity(n);
    let mut idx = vec![0usize; t.size.len()];
    for _ in 0..n {
        let off = t.offset + idx.iter().zip(&t.stride).map(|(i, s)| i * s).sum::<usize>();
        let b = raw.get(off * isz..off * isz + isz).ok_or("tensor fuera de rango")?;
        data.push(f(b));
        for d in (0..idx.len()).rev() {
            idx[d] += 1;
            if idx[d] < t.size[d] { break; }
            idx[d] = 0;
        }
    }
    Ok(Arr { shape: t.size.clone(), data })
}

fn walk(m: &V, prefix: &str, out: &mut Vec<(String, Rc<Tensor>)>) {
    for field in ["_parameters", "_buffers"] {
        if let Some(d) = m.get(field) {
            for (k, v) in d.pairs() {
                if let V::Tensor(t) = v { out.push((format!("{prefix}{k}"), t)); }
            }
        }
    }
    if let Some(d) = m.get("_modules") {
        for (k, v) in d.pairs() { walk(&v, &format!("{prefix}{k}."), out); }
    }
}

pub fn convert(src: &Path, dst: &Path) -> Result<usize, String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(src).map_err(|e| e.to_string())?).map_err(|e| format!("No es un .pt válido: {e}"))?;
    let pkl = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.ends_with("data.pkl"))
        .ok_or("El .pt no contiene data.pkl")?;
    let prefix = pkl.trim_end_matches("data.pkl").to_string();
    let mut bytes = Vec::new();
    zip.by_name(&pkl).map_err(|e| e.to_string())?.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let root = Unpickler { b: &bytes, i: 0, stack: vec![], memo: BTreeMap::new() }.run()?;

    let model = root.get("model").filter(|v| !matches!(v, V::None)).or_else(|| root.get("ema")).ok_or("El .pt no tiene modelo")?;
    let layers = model.get("_modules").and_then(|m| m.get("model")).and_then(|s| s.get("_modules")).ok_or("Estructura YOLOv8 no reconocida")?;
    let head = layers.pairs().pop().map(|(_, v)| v).ok_or("Sin capas")?;
    let head_class = match &head { V::Obj(o) => o.borrow().class.clone(), _ => String::new() };
    if !head_class.ends_with(".Detect") {
        return Err(format!("Solo detectores YOLOv8 de detección (la cabeza es {head_class})"));
    }
    let nc = head.get("nc").and_then(|v| v.as_int()).unwrap_or(1);
    let reg_max = head.get("reg_max").and_then(|v| v.as_int()).unwrap_or(16);
    let names: serde_json::Map<String, Json> = model
        .get("names")
        .map(|n| n.pairs().into_iter().map(|(k, v)| (k, json!(match v { V::Str(s) => s, _ => String::new() }))).collect())
        .unwrap_or_default();

    let mut list = Vec::new();
    walk(&model, "", &mut list);
    let mut sd: BTreeMap<String, Arr> = BTreeMap::new();
    for (name, t) in &list {
        if name.ends_with("num_batches_tracked") { continue; }
        sd.insert(name.clone(), load_tensor(&mut zip, &prefix, t)?);
    }
    // Conv + BN -> Conv con sesgo (BatchNorm2d de ultralytics: eps = 0.001)
    let convs: Vec<String> = sd.keys().filter(|k| k.ends_with(".conv.weight")).cloned().collect();
    for cw in convs {
        let base = cw.trim_end_matches(".conv.weight").to_string();
        let (Some(g), Some(b), Some(mu), Some(var)) = (
            sd.get(&format!("{base}.bn.weight")),
            sd.get(&format!("{base}.bn.bias")),
            sd.get(&format!("{base}.bn.running_mean")),
            sd.get(&format!("{base}.bn.running_var")),
        ) else { continue };
        let s: Vec<f64> = g.data.iter().zip(&var.data).map(|(g, v)| g / (v + 1e-3).sqrt()).collect();
        let cb = sd.get(&format!("{base}.conv.bias")).map(|a| a.data.clone()).unwrap_or_else(|| vec![0.0; s.len()]);
        let bias: Vec<f64> = (0..s.len()).map(|i| (cb[i] - mu.data[i]) * s[i] + b.data[i]).collect();
        let w = sd.get_mut(&cw).unwrap();
        let per = w.data.len() / s.len().max(1);
        for (i, x) in w.data.iter_mut().enumerate() { *x *= s[i / per]; }
        let n = bias.len();
        sd.insert(format!("{base}.conv.bias"), Arr { shape: vec![n], data: bias });
    }
    for req in ["model.0.conv.weight", "model.22.cv2.0.2.weight", "model.22.cv3.0.2.weight"] {
        if !sd.contains_key(req) { return Err(format!("El detector no tiene la estructura YOLOv8 esperada (falta {req})")); }
    }

    // safetensors
    let mut header = serde_json::Map::new();
    header.insert("__metadata__".into(), json!({
        "format": "pt", "yolov8.variant": "detect", "yolov8.input_size": "640",
        "yolov8.num_classes": nc.to_string(), "yolov8.reg_max": reg_max.to_string(),
        "yolov8.names": serde_json::to_string(&names).unwrap_or_default(),
    }));
    let mut blob: Vec<u8> = Vec::new();
    let mut n = 0;
    for (name, a) in &sd {
        if !name.starts_with("model.") || name.contains(".bn.") || name.ends_with("dfl.conv.weight") { continue; }
        let weight = name.ends_with(".weight");
        if !weight && !name.ends_with(".bias") { continue; }
        let start = blob.len();
        if weight { for x in &a.data { blob.extend_from_slice(&f32_to_f16(*x as f32).to_le_bytes()); } }
        else { for x in &a.data { blob.extend_from_slice(&(*x as f32).to_le_bytes()); } }
        header.insert(name.clone(), json!({ "dtype": if weight { "F16" } else { "F32" }, "shape": a.shape, "data_offsets": [start, blob.len()] }));
        n += 1;
    }
    let mut h = serde_json::to_vec(&Json::Object(header)).map_err(|e| e.to_string())?;
    while h.len() % 8 != 0 { h.push(b' '); }
    let mut out = Vec::with_capacity(8 + h.len() + blob.len());
    out.extend_from_slice(&(h.len() as u64).to_le_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(&blob);
    let tmp = dst.with_extension("safetensors.part");
    fs::write(&tmp, out).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dst).map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    /// HEXANIMA_PT=ruta.pt HEXANIMA_OUT=salida.safetensors cargo test convierte -- --nocapture
    #[test]
    fn convierte() {
        let (Ok(src), Ok(dst)) = (std::env::var("HEXANIMA_PT"), std::env::var("HEXANIMA_OUT")) else { return };
        let n = super::convert(std::path::Path::new(&src), std::path::Path::new(&dst)).unwrap();
        println!("{n} tensores");
    }
}
