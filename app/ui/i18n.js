"use strict";

const UiLanguage = (() => {
  const key = "hx.language";
  let selected = "es";
  try { if (localStorage.getItem(key) === "en") selected = "en"; } catch { /* storage unavailable */ }
  const english = selected === "en";
  const messages = english ? new Map(Object.entries(EN_UI)) : new Map();
  const translated = (source) => messages.get(source) ?? source;
  const pattern = (strings) => strings.map((part, i) => i ? `{{${i - 1}}}${part}` : part).join("");
  const interpolate = (source, args) => source.replace(/\{\{(\d+)\}\}/g, (full, i) => i < args.length ? String(args[i]) : full);

  function text(source) {
    const trimmed = source.trim();
    if (!english || !trimmed) return source;
    const result = translated(trimmed);
    return result === trimmed ? source : source.slice(0, source.indexOf(trimmed)) + result + source.slice(source.indexOf(trimmed) + trimmed.length);
  }

  function template(strings, ...args) {
    // Keep interpolation untouched, including prompt text, file names and numbers.
    return interpolate(text(pattern(strings)), args);
  }

  const backendPrefixes = new Map([
    ["No se pudo iniciar el motor: ", "Could not start the engine: "],
    ["No se pudo comprobar el tamaño de ", "Could not check the size of "],
    ["Archivo de modelo inválido: ", "Invalid model file: "],
    ["No se pudo configurar el cierre y el límite de RAM del motor: ", "Could not configure engine shutdown and its RAM limit: "],
    ["No se pudo asociar el motor a HexAnima: ", "Could not attach the engine to HexAnima: "],
    ["No se pudo limitar la CPU: ", "Could not limit CPU usage: "],
    ["No se pudo reservar el motor de HexAnima: ", "Could not reserve the HexAnima engine: "],
    ["Sin conexión con GitHub: ", "Could not connect to GitHub: "],
    ["GitHub respondió ", "GitHub returned HTTP "],
    ["Falta el motor: ", "Engine not found: "],
  ]);

  function error(source) {
    if (!english || typeof source !== "string") return source;
    if (messages.has(source.trim())) return text(source);
    const ram = /^RAM libre insuficiente para iniciar el motor: (.+) GB\. HexAnima reserva 2,5 GB para Windows\.$/.exec(source);
    if (ram) return `Not enough RAM to start the engine: ${ram[1]} GB available. HexAnima reserves 2.5 GB for Windows.`;
    for (const [prefix, translation] of backendPrefixes) {
      if (source.startsWith(prefix)) return translation + source.slice(prefix.length);
    }
    return source;
  }

  function translateMarkup(root) {
    const excluded = "script, style, body [lang]";
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      if (!node.parentElement?.closest(excluded)) node.data = text(node.data);
    }
    for (const el of root.querySelectorAll("[title], [aria-label], [placeholder], [alt]")) {
      if (el.closest(excluded)) continue;
      for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
        if (el.hasAttribute(attribute)) el.setAttribute(attribute, text(el.getAttribute(attribute)));
      }
    }
  }

  const control = document.getElementById("optLanguage");
  control.value = selected;
  if (english) translateMarkup(document.body);
  document.documentElement.lang = selected;

  return {
    selected, text, template, error,
    set(language) { localStorage.setItem(key, language); },
  };
})();
