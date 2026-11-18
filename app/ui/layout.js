// HexAnima PC: pantalla Generar. Secciones plegables con resumen, Ctrl+Enter para generar
// y altura de los cuadros de prompt recordada.
"use strict";

const Acc = {
  defaults: { sampling: true, size: true, loras: true, hires: false, ad: false, edit: false },
  el(key) { return document.querySelector(`.acc[data-acc="${key}"]`); },
  set(key, open, save = true) {
    const e = this.el(key); if (!e) return;
    e.classList.toggle("open", open);
    e.querySelector(".acc-head").setAttribute("aria-expanded", String(open));
    if (save) store.set("acc:" + key, open);
  },
  open(key) { this.set(key, true); },
  init() {
    for (const e of document.querySelectorAll(".acc")) {
      const key = e.dataset.acc;
      let open = store.get("acc:" + key, this.defaults[key]);
      // lo que está activo se abre aunque se haya dejado cerrado
      if ((key === "hires" && $("hiresOn").checked) || (key === "ad" && Ad.mode !== "off") || (key === "edit" && state.editImage)) open = true;
      this.set(key, open, false);
      e.querySelector(".acc-head").addEventListener("click", (ev) => {
        if (ev.target.closest("button:not(.acc-head), input, select")) return;
        this.set(key, !e.classList.contains("open"));
      });
    }
    this.summaries();
  },
  /** Resumen a la derecha del título (sirve sobre todo con la sección cerrada). */
  summaries() {
    const put = (key, txt, on) => { const s = $("sum-" + key); if (s && s.textContent !== txt) s.textContent = txt; s?.classList.toggle("on", !!on); };
    const opt = (sel) => sel.options[sel.selectedIndex]?.text || "";
    put("sampling", `${opt($("sampler"))} · ${$("steps").value} pasos · CFG ${$("cfg").value}`);
    const [w, h] = state.mode === "edit" && state.editImage ? [state.editImage.w, state.editImage.h] : currentSize();
    put("size", `${w} × ${h}`);
    const n = Loras.tags().size;
    put("loras", n ? `${n} activo${n > 1 ? "s" : ""}` : "ninguno", n);
    const hon = $("hiresOn").checked;
    put("hires", hon ? `×${$("hiresScale").value} · denoise ${$("hiresDen").value}` : "apagado", hon);
    put("ad", Ad.mode === "face" ? "caras" : Ad.mode === "hand" ? "manos" : "apagado", Ad.mode !== "off");
    put("edit", state.editImage ? (state.editMask ? "con zona pintada" : "con foto") : "sin foto", state.editImage);
  },
};

// Resúmenes al cambiar cualquier cosa de la columna (y cada segundo por cambios hechos por código).
$("page-gen").addEventListener("input", () => Acc.summaries());
$("page-gen").addEventListener("change", () => Acc.summaries());
$("page-gen").addEventListener("click", () => setTimeout(() => Acc.summaries(), 0));
setInterval(() => { if ($("page-gen").classList.contains("on")) Acc.summaries(); }, 1000);

// Ctrl+Enter en los prompts = Generar
for (const id of ["prompt", "neg"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$("genBtn").disabled) $("genBtn").click(); }
  });
}

// Altura de los cuadros de prompt: se arrastra la esquina y se recuerda.
for (const id of ["prompt", "neg"]) {
  const t = $(id), h = store.get("h:" + id, null);
  if (h) t.style.height = h + "px";
  new ResizeObserver(() => { if (t.offsetHeight) store.set("h:" + id, t.offsetHeight); }).observe(t);
}

Acc.init();
