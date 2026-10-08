(() => {
  'use strict';

  const FORMS_URL_RE = /^https:\/\/docs\.google\.com\/forms\//i;
  const PRINT_JOB_KEY = 'gf_print_job';

  const TYPE_LABELS = Object.freeze({
    MULTIPLE_CHOICE: 'Opción múltiple',
    CHECKBOX: 'Casillas',
    TEXT: 'Texto corto',
    PARAGRAPH: 'Texto largo',
    DROPDOWN: 'Desplegable',
    SCALE: 'Escala',
    FILE_UPLOAD: 'Carga de archivo',
    UNKNOWN: 'Otro'
  });

  const OPTION_MARKS = Object.freeze({
    MULTIPLE_CHOICE: '○',
    CHECKBOX: '☐',
    DROPDOWN: '▾',
    SCALE: '○'
  });

  const $ = (sel) => document.querySelector(sel);

  const state = {
    data: null,
    markdown: '',
    view: 'preview'
  };

  const els = {
    statusChip: $('#statusChip'),
    btnExtract: $('#btnExtract'),
    resultBox: $('#resultBox'),
    summary: $('#summary'),
    preview: $('#preview'),
    viewer: $('#viewer'),
    viewPreview: $('#viewPreview'),
    viewMarkdown: $('#viewMarkdown'),
    viewJson: $('#viewJson'),
    btnCopy: $('#btnCopy'),
    btnDownload: $('#btnDownload'),
    btnPdf: $('#btnPdf')
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  const isValidFormsUrl = (url) => !!url && FORMS_URL_RE.test(url);

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);

  const getActiveTab = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  };

  const sendExtract = async (tabId) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_FORM' });
    } catch {
      return null;
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    }
  };

  const setStatus = (kind, text) => {
    els.statusChip.className = `status-chip status-${kind}`;
    els.statusChip.textContent = text;
    els.statusChip.title = text;
  };

  const setExtracting = (isLoading) => {
    els.btnExtract.disabled = isLoading;
    els.btnExtract.querySelector('.spinner').hidden = !isLoading;
    els.btnExtract.classList.toggle('loading', isLoading);
  };

  const setToolbarState = (enabled) => {
    els.btnCopy.disabled = !enabled;
    els.btnDownload.disabled = !enabled;
    els.btnPdf.disabled = !enabled;
  };

  const flashButton = (btn, label) => {
    const span = btn.querySelector('.btn-label');
    const original = span.textContent;
    span.textContent = label;
    btn.classList.add('done');
    window.setTimeout(() => {
      span.textContent = original;
      btn.classList.remove('done');
    }, 1500);
  };

  // ---------------------------------------------------------------------------
  // Generador de HTML (vista previa del popup y documento de impresión)
  // ---------------------------------------------------------------------------
  const DOC_CSS = `
    .doc { font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2328; line-height: 1.55; font-size: 13px; }
    .doc * { box-sizing: border-box; }
    .doc h1 { font-size: 1.7em; line-height: 1.25; margin: 0 0 .5em; color: #174ea6; border-bottom: 2px solid #e0e0e0; padding-bottom: .3em; }
    .doc h2 { font-size: 1.3em; margin: 1.5em 0 .5em; color: #202124; border-bottom: 1px solid #e8eaed; padding-bottom: .25em; break-after: avoid; page-break-after: avoid; }
    .doc h3.info-title { font-size: 1.05em; margin: 0 0 .4em; color: #174ea6; }
    .doc p { margin: .35em 0; }
    .doc a { color: #1a73e8; text-decoration: underline; word-break: break-word; }
    .doc ul, .doc ol { margin: .4em 0; padding-left: 1.6em; }
    .doc li { margin: .15em 0; }
    .doc .meta { color: #5f6368; font-size: .85em; margin: -.2em 0 1em; word-break: break-all; }
    .doc .card { border: 1px solid #dadce0; border-radius: 8px; padding: .8em 1em; margin: .8em 0; background: #fff; break-inside: avoid; page-break-inside: avoid; }
    .doc .card.info { background: #f8f9fa; border-left: 4px solid #1a73e8; break-inside: auto; page-break-inside: auto; }
    .doc .q-title { font-weight: 600; font-size: 1.05em; margin: 0 0 .3em; }
    .doc .q-num { color: #1a73e8; margin-right: .2em; }
    .doc .badges { margin: 0 0 .4em; }
    .doc .badge { display: inline-block; font-size: .75em; padding: .1em .6em; border-radius: 999px; background: #e8f0fe; color: #174ea6; margin-right: .4em; }
    .doc .badge.req { background: #fce8e6; color: #b31412; }
    .doc .help { background: #f1f3f4; border-left: 4px solid #9aa0a6; border-radius: 4px; padding: .4em .8em; margin: .4em 0; color: #3c4043; }
    .doc ul.opts { list-style: none; padding-left: .2em; margin: .5em 0 0; }
    .doc ul.opts li { display: flex; gap: .5em; align-items: flex-start; margin: .25em 0; }
    .doc ul.opts.inline { display: flex; flex-wrap: wrap; gap: .4em 1.2em; }
    .doc .mark { color: #5f6368; flex: none; }
    .doc figure { margin: .7em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
    .doc img { max-width: 100%; height: auto; border: 1px solid #dadce0; border-radius: 6px; display: inline-block; }
    .doc .opt-body figure { margin: .3em 0; text-align: left; }
    .doc .opt-body img { max-height: 160px; }
    .doc .img-missing { border: 1px dashed #9aa0a6; border-radius: 6px; padding: .5em .8em; margin: .6em 0; color: #5f6368; font-size: .9em; }
    .doc .video { margin: .4em 0; }
  `;

  const PRINT_CSS = `
    .doc.print { font-size: 11.5pt; }
    .doc.print img { max-height: 230mm; }
    @media print {
      .doc.print a { color: #1a73e8; }
      .doc.print { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;

  const SAFE_SRC_RE = /^(data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,|https?:\/\/)/i;

  const fmt = (s) =>
    escapeHtml(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');

  const linkHtml = (url, labelHtml) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;

  // Texto con [etiqueta](url), URLs sueltas, **negrita** y *cursiva* -> HTML seguro
  const inlineHtml = (text) => {
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;
    const src = String(text || '');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += fmt(src.slice(last, m.index));
      out += m[2] ? linkHtml(m[2], fmt(m[1])) : linkHtml(m[3], escapeHtml(m[3]));
      last = re.lastIndex;
    }
    return out + fmt(src.slice(last));
  };

  const LIST_LINE_RE = /^( *)(?:([-•])|(\d+)[.)])\s+(.*)$/;

  // Bloques de texto del extractor (párrafos, "- viñetas", "1. numeración") -> HTML
  const richHtml = (text) => {
    let html = '';
    let open = null;
    const close = () => {
      if (open) {
        html += `</${open}>`;
        open = null;
      }
    };

    for (const line of String(text || '').split('\n')) {
      if (!line.trim()) {
        close();
        continue;
      }
      const m = line.match(LIST_LINE_RE);
      if (!m) {
        close();
        html += `<p>${inlineHtml(line.trim())}</p>`;
        continue;
      }
      const tag = m[3] ? 'ol' : 'ul';
      if (open !== tag) {
        close();
        html += `<${tag}>`;
        open = tag;
      }
      const level = Math.floor(m[1].length / 2);
      const style = level ? ` style="margin-left:${level * 1.2}em"` : '';
      const value = m[3] ? ` value="${Number(m[3])}"` : '';
      html += `<li${value}${style}>${inlineHtml(m[4])}</li>`;
    }
    close();
    return html;
  };

  const imageSrc = (img) => [img.dataUrl, img.src].find((s) => s && SAFE_SRC_RE.test(s)) || '';

  const imageHtml = (img, fallbackAlt = '') => {
    const alt = img.alt || fallbackAlt;
    const src = imageSrc(img);
    if (!src) {
      return `<div class="img-missing">Imagen no disponible${alt ? `: ${escapeHtml(alt)}` : ''}</div>`;
    }
    // Las data: URLs (Base64) no contienen caracteres que escapar
    const safe = src.startsWith('data:') ? src : escapeHtml(src);
    return `<figure><img src="${safe}" alt="${escapeHtml(alt)}" decoding="async"></figure>`;
  };

  const mediaHtml = (images = [], videos = [], fallbackAlt = '') =>
    images.map((img) => imageHtml(img, fallbackAlt)).join('') +
    videos.map((url) => `<p class="video">▶ ${linkHtml(url, escapeHtml(url))}</p>`).join('');

  const questionHtml = (q) => {
    const mark = OPTION_MARKS[q.type] || '•';
    const typeLabel = TYPE_LABELS[q.type] || TYPE_LABELS.UNKNOWN;

    let html = '<div class="card question">';
    html += `<div class="q-title"><span class="q-num">${q.number}.</span>${inlineHtml(q.questionText || '(sin enunciado)')}</div>`;
    html += `<div class="badges"><span class="badge">${escapeHtml(typeLabel)}</span>${
      q.isRequired ? '<span class="badge req">Obligatoria</span>' : ''
    }</div>`;
    if (q.helpText) html += `<div class="help">${richHtml(q.helpText)}</div>`;
    html += mediaHtml(q.images, q.videos, `Imagen de la pregunta ${q.number}`);

    if (q.options.length) {
      html += `<ul class="opts${q.type === 'SCALE' ? ' inline' : ''}">`;
      for (const opt of q.options) {
        html +=
          `<li><span class="mark">${mark}</span><span class="opt-body">` +
          `${inlineHtml(opt.text || '(opción con imagen)')}` +
          `${opt.images.map((img) => imageHtml(img, 'opción')).join('')}</span></li>`;
      }
      html += '</ul>';
    }
    return `${html}</div>`;
  };

  // HTML del contenido completo, construido desde los datos estructurados
  // (no desde el Markdown) para no perder listas, párrafos ni imágenes.
  const buildBodyHtml = (data, { print = false } = {}) => {
    let html = `<h1>${inlineHtml(data.title || '(Formulario sin título)')}</h1>`;
    if (print) {
      const date = data.extractedAt ? new Date(data.extractedAt).toLocaleString() : '';
      html += `<p class="meta">${escapeHtml(data.url || '')}${date ? ` · ${escapeHtml(date)}` : ''}</p>`;
    }

    if (data.description) html += `<div class="card info">${richHtml(data.description)}</div>`;
    html += mediaHtml(data.images, [], 'Imagen del formulario');

    for (const item of data.items || []) {
      if (item.kind === 'section') {
        html += `<h2>${inlineHtml(item.title || 'Sección')}</h2>`;
        if (item.description) html += richHtml(item.description);
        html += mediaHtml(item.images, item.videos, 'Imagen de la sección');
      } else if (item.kind === 'info') {
        html += '<div class="card info">';
        if (item.title) html += `<h3 class="info-title">${inlineHtml(item.title)}</h3>`;
        if (item.description) html += richHtml(item.description);
        html += mediaHtml(item.images, item.videos, 'Imagen');
        html += '</div>';
      } else {
        html += questionHtml(item);
      }
    }
    return html;
  };

  const attachImageFallbacks = (root) => {
    for (const img of root.querySelectorAll('img')) {
      img.addEventListener(
        'error',
        () => {
          const box = document.createElement('div');
          box.className = 'img-missing';
          box.textContent = `Imagen no disponible${img.alt ? `: ${img.alt}` : ''}`;
          img.replaceWith(box);
        },
        { once: true }
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Resumen y visores
  // ---------------------------------------------------------------------------
  const renderSummary = (data) => {
    const typeCounts = data.items
      .filter((i) => i.kind === 'question')
      .reduce((acc, q) => {
        const label = TYPE_LABELS[q.type] || TYPE_LABELS.UNKNOWN;
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {});

    const chips = Object.entries(typeCounts)
      .map(([label, count]) => `<span class="type-chip">${escapeHtml(label)}: ${count}</span>`)
      .join('');

    const failed = data.imageCount - data.imagesEmbedded;
    const warn = failed > 0
      ? `<div class="summary-warn">${failed} imagen(es) no se pudieron convertir a Base64; se usará su URL original.</div>`
      : '';

    els.summary.innerHTML =
      `<div class="summary-title">${escapeHtml(data.title || '(Formulario sin título)')}</div>` +
      '<div class="summary-stats">' +
      `<div class="stat"><span class="stat-num">${data.questionCount}</span><span class="stat-label">Preguntas</span></div>` +
      `<div class="stat"><span class="stat-num">${data.sectionCount}</span><span class="stat-label">Secciones</span></div>` +
      `<div class="stat"><span class="stat-num">${data.imageCount}</span><span class="stat-label">Imágenes</span></div>` +
      '</div>' +
      (chips ? `<div class="summary-types">${chips}</div>` : '') +
      warn;
  };

  // En la pestaña JSON las imágenes Base64 se abrevian; la descarga las incluye completas
  const jsonPreviewReplacer = (key, value) =>
    key === 'dataUrl' && typeof value === 'string' && value.length > 120
      ? `${value.slice(0, 40)}…[${Math.round(value.length / 1024)} KB]`
      : value;

  const switchView = (view) => {
    state.view = view;
    const buttons = { preview: els.viewPreview, markdown: els.viewMarkdown, json: els.viewJson };
    for (const [name, btn] of Object.entries(buttons)) {
      btn.classList.toggle('active', name === view);
      btn.setAttribute('aria-selected', String(name === view));
    }

    els.preview.classList.toggle('hidden', view !== 'preview');
    els.viewer.classList.toggle('hidden', view === 'preview');

    if (!state.data) return;
    if (view === 'markdown') els.viewer.textContent = state.markdown;
    if (view === 'json') els.viewer.textContent = JSON.stringify(state.data, jsonPreviewReplacer, 2);
  };

  const showResult = (data, markdown) => {
    state.data = data;
    state.markdown = markdown;
    renderSummary(data);

    els.preview.innerHTML = `<div class="doc">${buildBodyHtml(data)}</div>`;
    attachImageFallbacks(els.preview);

    els.resultBox.classList.remove('hidden');
    setToolbarState(true);
    switchView(state.view);
  };

  // ---------------------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------------------
  const handleExtract = async () => {
    setStatus('extracting', 'Extrayendo...');
    setExtracting(true);
    els.resultBox.classList.add('hidden');
    setToolbarState(false);

    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('No se pudo obtener la pestaña activa.');
      if (!isValidFormsUrl(tab.url)) throw new Error('No estás en un Google Form.');

      let response = await sendExtract(tab.id);
      if (!response) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        response = await sendExtract(tab.id);
      }

      if (!response || !response.success) {
        throw new Error((response && response.error) || 'No se recibió respuesta del extractor.');
      }

      showResult(response.data, response.markdown);
      setStatus(
        'success',
        `Éxito - ${response.data.questionCount} preguntas` +
          (response.data.sectionCount ? ` en ${response.data.sectionCount} secciones` : '')
      );
    } catch (err) {
      setStatus('error', err.message);
    } finally {
      setExtracting(false);
    }
  };

  const copyMarkdown = async () => {
    if (!state.markdown) return;
    const ok = await copyToClipboard(state.markdown);
    flashButton(els.btnCopy, ok ? 'Copiado' : 'Error');
  };

  const downloadJson = () => {
    if (!state.data) return;
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `google-form-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    flashButton(els.btnDownload, 'Descargado');
  };

  // El popup se cierra en cuanto otra pestaña toma el foco, así que no puede esperar las
  // imágenes ni llamar a window.print() por sí mismo. Se guarda el HTML y se abre print.html,
  // que lo pinta, espera a que carguen todas las <img> e invoca la impresión.
  const exportPdf = async () => {
    if (!state.data) return;
    try {
      const job = {
        title: state.data.title || 'Formulario',
        css: DOC_CSS + PRINT_CSS,
        html: `<div class="doc print">${buildBodyHtml(state.data, { print: true })}</div>`,
        createdAt: Date.now()
      };
      await chrome.storage.local.set({ [PRINT_JOB_KEY]: job });
      await chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
    } catch (err) {
      setStatus('error', `No se pudo preparar el PDF: ${err.message}`);
    }
  };

  const bindEvents = () => {
    els.btnExtract.addEventListener('click', handleExtract);
    els.viewPreview.addEventListener('click', () => switchView('preview'));
    els.viewMarkdown.addEventListener('click', () => switchView('markdown'));
    els.viewJson.addEventListener('click', () => switchView('json'));
    els.btnCopy.addEventListener('click', copyMarkdown);
    els.btnDownload.addEventListener('click', downloadJson);
    els.btnPdf.addEventListener('click', exportPdf);
  };

  const init = () => {
    const style = document.createElement('style');
    style.textContent = DOC_CSS;
    document.head.appendChild(style);

    bindEvents();
    setExtracting(false);
    setToolbarState(false);
  };

  init();
})();