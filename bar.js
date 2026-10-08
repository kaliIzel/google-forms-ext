/*
 * bar.js — barra flotante anclable (content script).
 * Se dibuja dentro de un Shadow DOM para que los estilos de Google Forms no la afecten
 * ni ella a ellos. Se arrastra con el dedo o el ratón y recuerda su posición.
 * Depende de render.js (window.GFRender) y content.js (window.__gfExtract).
 */
(() => {
  'use strict';

  if (window.__gfBarLoaded) return;
  window.__gfBarLoaded = true;

  const STATE_KEY = 'gf_bar_state';
  const EDGE = 6; // margen mínimo al borde de la pantalla (px)

  // La barra aparece sola en la vista de respuesta; en otras páginas de Forms, solo desde el popup
  const isFormView = () => /\/(viewform|formResponse)/.test(location.pathname);

  const model = { data: null, markdown: '', busy: false };
  const saved = { hidden: false, left: null, top: null };

  let host = null;
  let shadow = null;
  let bar = null;
  let toast = null;
  let toastTimer = 0;
  let shown = false;

  const CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; }
    * { box-sizing: border-box; }
    .bar {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px 8px 6px;
      background: rgba(32, 33, 40, .96); border-radius: 18px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .35), 0 0 0 1px rgba(255, 255, 255, .06);
      font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      touch-action: none; user-select: none; -webkit-user-select: none;
    }
    .grip { width: 18px; align-self: stretch; display: flex; align-items: center; justify-content: center;
      color: #8d8f9a; font-size: 16px; line-height: 1; letter-spacing: -2px; cursor: grab; }
    .bar.dragging .grip { cursor: grabbing; }
    button {
      all: unset; box-sizing: border-box; width: 48px; height: 48px; border-radius: 12px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      background: rgba(255, 255, 255, .10); color: #e8eaed; cursor: pointer;
      transition: background .15s, transform .1s; -webkit-tap-highlight-color: transparent;
    }
    button:hover { background: rgba(255, 255, 255, .20); }
    button:active { transform: scale(.94); }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    button[disabled] { opacity: .45; cursor: progress; }
    button svg { width: 20px; height: 20px; fill: currentColor; }
    button .glyph { font-size: 14px; font-weight: 700; line-height: 20px; height: 20px; font-family: ui-monospace, Menlo, Consolas, monospace; }
    button small { font-size: 9px; line-height: 1; letter-spacing: .2px; color: #bdc1c6; }
    button[data-act="close"] { width: 40px; }
    .spin svg { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toast {
      position: absolute; left: 0; bottom: calc(100% + 8px); max-width: min(86vw, 340px); width: max-content;
      padding: 8px 12px; border-radius: 10px; background: #202128; color: #fff; font: 12.5px/1.35 Inter, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .35); pointer-events: none;
    }
    .toast.below { bottom: auto; top: calc(100% + 8px); }
    .toast.ok { background: #137333; }
    .toast.error { background: #b31412; }
    .toast[hidden] { display: none; }
    @media (max-width: 420px) { button { width: 44px; height: 46px; } button[data-act="close"] { width: 36px; } }
  `;

  const ICON = {
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
  };

  // ---------------------------------------------------------------------------
  // Persistencia (tolerante a "Extension context invalidated" tras recargar la extensión)
  // ---------------------------------------------------------------------------
  const loadState = async () => {
    try {
      const stored = await chrome.storage.local.get(STATE_KEY);
      Object.assign(saved, stored[STATE_KEY] || {});
    } catch {
      // se usan los valores por defecto
    }
  };

  const saveState = () => {
    try {
      chrome.storage.local.set({ [STATE_KEY]: { ...saved } }).catch(() => {});
    } catch {
      // contexto invalidado: se ignora
    }
  };

  // ---------------------------------------------------------------------------
  // Posición y arrastre
  // ---------------------------------------------------------------------------
  const place = (left, top) => {
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const maxLeft = Math.max(EDGE, window.innerWidth - w - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - h - EDGE);
    host.style.left = `${Math.min(Math.max(EDGE, left), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(EDGE, top), maxTop)}px`;
  };

  const currentPos = () => {
    const r = bar.getBoundingClientRect();
    return { left: r.left, top: r.top };
  };

  const initialPlace = () => {
    if (saved.left !== null && saved.top !== null) {
      place(saved.left, saved.top);
    } else {
      place(window.innerWidth - bar.offsetWidth - 14, window.innerHeight - bar.offsetHeight - 90);
    }
  };

  const enableDrag = () => {
    let drag = null;

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = bar.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      e.preventDefault();
    });

    bar.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) place(e.clientX - drag.dx, e.clientY - drag.dy);
    });

    const end = () => {
      if (!drag) return;
      drag = null;
      bar.classList.remove('dragging');
      const pos = currentPos();
      saved.left = Math.round(pos.left);
      saved.top = Math.round(pos.top);
      saveState();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    // Rotar el móvil o redimensionar la ventana no debe dejar la barra fuera de pantalla
    window.addEventListener('resize', () => {
      if (!shown) return;
      const pos = currentPos();
      place(pos.left, pos.top);
    });
  };

  // ---------------------------------------------------------------------------
  // Avisos
  // ---------------------------------------------------------------------------
  const showToast = (text, kind = '', ms = 2800) => {
    toast.textContent = text;
    toast.className = `toast${kind ? ` ${kind}` : ''}${bar.getBoundingClientRect().top < 64 ? ' below' : ''}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => (toast.hidden = true), ms);
  };

  const setBusy = (busy) => {
    model.busy = busy;
    for (const btn of shadow.querySelectorAll('button')) {
      if (btn.dataset.act !== 'close') btn.disabled = busy;
    }
    shadow.querySelector('[data-act="extract"]').classList.toggle('spin', busy);
  };

  // ---------------------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------------------
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  };

  const doExtract = async () => {
    if (model.busy) return false;
    if (typeof window.__gfExtract !== 'function') {
      showToast('El extractor no está cargado. Recarga la página.', 'error');
      return false;
    }
    setBusy(true);
    showToast('Extrayendo formulario e imágenes…', '', 0);
    try {
      const res = await window.__gfExtract();
      if (!res || !res.success) throw new Error((res && res.error) || 'No se pudo extraer el formulario.');
      model.data = res.data;
      model.markdown = res.markdown;
      const d = res.data;
      showToast(`✓ ${d.questionCount} preguntas · ${d.sectionCount} secciones · ${d.imageCount} imágenes`, 'ok');
      return true;
    } catch (err) {
      showToast(err.message || String(err), 'error', 4500);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ensureData = async () => (model.data ? true : doExtract());

  const actions = {
    extract: () => doExtract(),

    async markdown() {
      if (!(await ensureData())) return;
      const ok = await copyText(model.markdown);
      showToast(ok ? 'Markdown copiado al portapapeles' : 'No se pudo copiar', ok ? 'ok' : 'error');
    },

    async json() {
      if (!(await ensureData())) return;
      const blob = new Blob([JSON.stringify(model.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `google-form-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('JSON descargado', 'ok');
    },

    async pdf() {
      if (!(await ensureData())) return;
      try {
        await chrome.storage.local.set({ [window.GFRender.PRINT_JOB_KEY]: window.GFRender.buildPrintJob(model.data) });
        const res = await chrome.runtime.sendMessage({ action: 'OPEN_PRINT' });
        if (res && res.ok === false) throw new Error(res.error);
        showToast('Abriendo vista de impresión…', 'ok');
      } catch (err) {
        showToast(`No se pudo preparar el PDF: ${err.message || err}`, 'error', 4500);
      }
    },

    close() {
      hide();
      saved.hidden = true;
      saveState();
    }
  };

  // ---------------------------------------------------------------------------
  // Construcción / mostrar / ocultar
  // ---------------------------------------------------------------------------
  const build = () => {
    host = document.createElement('div');
    host.id = 'gf-extractor-bar-host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="bar" role="toolbar" aria-label="Google Forms Extractor">
        <div class="grip" title="Arrastrar">⋮⋮</div>
        <button type="button" data-act="extract" title="Extraer / actualizar">${ICON.refresh}<small>Extraer</small></button>
        <button type="button" data-act="markdown" title="Copiar Markdown"><span class="glyph">M↓</span><small>Copiar</small></button>
        <button type="button" data-act="json" title="Descargar JSON"><span class="glyph">{ }</span><small>JSON</small></button>
        <button type="button" data-act="pdf" title="Exportar PDF">${ICON.pdf}<small>PDF</small></button>
        <button type="button" data-act="close" title="Ocultar barra" aria-label="Ocultar barra">${ICON.close}</button>
        <div class="toast" hidden role="status"></div>
      </div>`;
    bar = shadow.querySelector('.bar');
    toast = shadow.querySelector('.toast');

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const run = actions[btn.dataset.act];
      if (run) run();
    });
    enableDrag();
  };

  const show = () => {
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
    host.style.display = '';
    shown = true;
    requestAnimationFrame(initialPlace);
  };

  const hide = () => {
    if (host) host.style.display = 'none';
    shown = false;
  };

  const toggle = () => {
    if (shown) {
      actions.close();
    } else {
      saved.hidden = false;
      saveState();
      show();
    }
    return shown;
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.action === 'TOGGLE_BAR') {
      sendResponse({ shown: toggle() });
    } else if (message.action === 'GET_BAR_STATE') {
      sendResponse({ shown });
    }
    return false;
  });

  (async () => {
    await loadState();
    if (isFormView() && !saved.hidden) show();
  })();
})();
