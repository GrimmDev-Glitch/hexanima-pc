// HexAnima PC: 🧍 Pose (como la caja POSE del teléfono). Se elige una foto y el motor rápido saca su
// esqueleto (OpenPose), o se carga un esqueleto ya hecho (OpenPose Editor, PoseMy.Art, Magic Poser…).
// Al generar, el ControlNet OpenPose SDXL (xinsir) hace que la imagen siga esa postura; el aspecto lo
// decide el prompt (y «Personaje de referencia», si está activo: se pueden combinar).
// Por ahora: motor rápido (PyTorch) y modelos SDXL / Illustrious / Pony. Qwen y Mage copian poses con
// «🧍 Copiar pose» y una imagen de referencia.
"use strict";

const Pose = {
  skel: null, // { src, w, h, people, from: "foto" | "esqueleto" }

  supported(opt) { return state.engine === "torch" && opt?.family === "sdxl"; },
  on() { return !!this.skel && $("poseOn").checked; },

  img(src) { return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("imagen no válida")); i.src = src; }); },

  /** ¿Ya es un esqueleto? Fondo casi todo negro con trazos de color. */
  isSkeleton(im) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"); x.drawImage(im, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    let dark = 0, colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx < 24) dark++; else if (mx - mn > 80) colored++;
    }
    const n = d.length / 4;
    return dark / n > 0.7 && colored / n > 0.005;
  },

  async pick() {
    if (state.busy) return;
    const src = await pickImage();
    if (!src) return;
    try {
      const im = await this.img(src);
      if (this.isSkeleton(im)) {
        this.skel = { src, w: im.width, h: im.height, people: null, from: "esqueleto" };
      } else {
        if (state.engine !== "torch") {
          const has = (state.engines || []).includes("torch");
          return toast(has
            ? "La pose usa el motor rápido, que se activa con modelos SDXL, Illustrious o Pony: elige uno de esos en Modelo y vuelve a elegir la foto. Con Qwen o Mage usa «🧍 Copiar pose» en Editar una foto."
            : "Para sacar la pose de una foto hace falta el motor rápido (NVIDIA): descárgalo en Ajustes → Motor rápido (PyTorch). También puedes cargar un esqueleto ya hecho (OpenPose Editor, PoseMy.Art…).", 9000);
        }
        if (!(await downloadAssets(["pose"], "Detector de pose", "Saca el esqueleto (cabeza, hombros, brazos y piernas) de una foto con OpenPose. Los pesos son de CMU, de uso no comercial.", (t) => { $("poseInfo").textContent = t; }))) return this.render();
        $("poseInfo").textContent = "Buscando la pose…";
        const r = await api("/hexanima/v1/pose", { method: "POST", body: JSON.stringify({ image: src }) });
        if (!r.people) { toast("No se encontró a nadie en la foto: prueba con otra en la que se vea el cuerpo entero o medio cuerpo.", 6000); return this.render(); }
        this.skel = { src: "data:image/png;base64," + r.image, w: r.width, h: r.height, people: r.people, from: "foto" };
      }
      $("poseOn").checked = true;
      Acc.open("pose");
      await this.ensure();
    } catch (e) {
      // un motor rápido de antes de la 🧍 Pose no tiene /hexanima/v1/pose
      const msg = String(e.message || e);
      toast(/no existe|404/i.test(msg) ? "Tu motor rápido es de una versión anterior: actualízalo en Ajustes → Motor rápido para usar la Pose." : "No se pudo leer la pose: " + msg, 7000);
    }
    this.render();
  },

  /** El ControlNet (2,4 GB) se descarga la primera vez que se usa. */
  async ensure() {
    if (!this.on() || !this.supported(currentOption())) return true;
    return downloadAssets(["openpose"], "ControlNet de pose", "Hace que la imagen siga el esqueleto: ControlNet OpenPose SDXL de xinsir (Apache-2.0). Funciona con SDXL, Illustrious y Pony.", (t) => { $("poseInfo").textContent = t; });
  },

  /** Añade el esqueleto a la petición si la pose está activa y el modelo la admite. */
  apply(body, opt) {
    if (!this.on() || !this.supported(opt)) return null;
    body.control_image = this.skel.src;
    body.control_strength = clampNum($("poseStrength"), 0.9);
    return { strength: body.control_strength };
  },

  /** Tamaño de la imagen con la forma del esqueleto (≈ 1 megapíxel, múltiplos de 64). */
  fitSize() {
    if (!this.skel) return;
    const a = this.skel.w / this.skel.h, px = 1024 * 1024;
    $("customW").value = align64(Math.sqrt(px * a)); $("customH").value = align64(Math.sqrt(px / a));
    document.querySelector('#aspect button[data-a="c"]').click();
    toast(`Tamaño: ${$("customW").value} × ${$("customH").value}`);
  },

  clear() { this.skel = null; $("poseOn").checked = false; this.render(); },

  render() {
    const s = this.skel, opt = currentOption();
    $("posePrev").classList.toggle("on", !!s);
    if (s) $("posePrev").src = s.src; else $("posePrev").removeAttribute("src");
    for (const id of ["poseClear", "poseFit", "poseOn", "poseStrength"]) $(id).disabled = !s;
    $("poseEmpty").classList.toggle("hidden", !!s);
    let info;
    if (!s) info = "Elige una foto para copiar su postura, o un esqueleto hecho en OpenPose Editor o PoseMy.Art.";
    else if (REF_FAMILIES.includes(opt?.family)) info = "Qwen y Mage no usan esta caja: pon la foto de la pose como imagen 2 y usa «🧍 Copiar pose».";
    else if (opt?.family !== "sdxl") info = "La pose funciona con modelos SDXL, Illustrious y Pony.";
    else if (state.engine !== "torch") info = "La pose funciona con el motor rápido (PyTorch, NVIDIA). Cámbialo en Ajustes → Motor.";
    else info = (s.from === "foto" ? `Pose de la foto${s.people > 1 ? ` (${s.people} personas)` : ""}` : "Esqueleto cargado") + ` · ${s.w} × ${s.h}. Fuerza 0,6–1,0 suele ir bien; más alta la sigue al pie de la letra.`;
    $("poseInfo").textContent = info;
  },
};

$("posePick").onclick = () => Pose.pick();
$("poseClear").onclick = () => Pose.clear();
$("poseFit").onclick = () => Pose.fitSize();
$("poseOn").onchange = async () => { if ($("poseOn").checked && !(await Pose.ensure())) $("poseOn").checked = false; Pose.render(); };
$("model").addEventListener("change", () => Pose.render());
Pose.render();
