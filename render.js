/*
 * render.js — generador de HTML compartido.
 * Lo cargan el popup, la barra flotante (content script) y, indirectamente, print.html.
 * Expone window.GFRender. Todo el texto del formulario se escapa antes de convertirse en HTML.
 */
(() => {
  'use strict';

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

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);

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

  // En la vista JSON las imágenes Base64 se abrevian; la descarga las incluye completas
  const jsonPreviewReplacer = (key, value) =>
    key === 'dataUrl' && typeof value === 'string' && value.length > 120
      ? `${value.slice(0, 40)}…[${Math.round(value.length / 1024)} KB]`
      : value;

  // Trabajo de impresión que lee print.html desde chrome.storage.local
  const buildPrintJob = (data) => ({
    title: data.title || 'Formulario',
    css: DOC_CSS + PRINT_CSS,
    html: `<div class="doc print">${buildBodyHtml(data, { print: true })}</div>`,
    createdAt: Date.now()
  });

  window.GFRender = Object.freeze({
    PRINT_JOB_KEY,
    TYPE_LABELS,
    DOC_CSS,
    PRINT_CSS,
    escapeHtml,
    buildBodyHtml,
    buildPrintJob,
    attachImageFallbacks,
    jsonPreviewReplacer
  });
})();
