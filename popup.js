(() => {
  'use strict';

  const {
    TYPE_LABELS,
    DOC_CSS,
    escapeHtml,
    buildBodyHtml,
    buildPrintJob,
    attachImageFallbacks,
    jsonPreviewReplacer,
    PRINT_JOB_KEY
  } = window.GFRender;

  const FORMS_URL_RE = /^https:\/\/docs\.google\.com\/forms\//i;

  const $ = (sel) => document.querySelector(sel);

  const state = {
    data: null,
    markdown: '',
    view: 'preview'
  };

  const els = {
    statusChip: $('#statusChip'),
    btnExtract: $('#btnExtract'),
    btnToggleBar: $('#btnToggleBar'),
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

  const getActiveTab = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  };

  // Mismos archivos y orden que content_scripts en manifest.json
  const CONTENT_FILES = ['render.js', 'content.js', 'bar.js'];

  const sendToTab = async (tabId, message) => {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
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
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
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
      const job = buildPrintJob(state.data);
      await chrome.storage.local.set({ [PRINT_JOB_KEY]: job });
      await chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
    } catch (err) {
      setStatus('error', `No se pudo preparar el PDF: ${err.message}`);
    }
  };

  const toggleBar = async () => {
    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('No se pudo obtener la pestaña activa.');
      if (!isValidFormsUrl(tab.url)) throw new Error('No estás en un Google Form.');

      let response = await sendToTab(tab.id, { action: 'TOGGLE_BAR' });
      if (!response) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
        response = await sendToTab(tab.id, { action: 'TOGGLE_BAR' });
      }
      if (!response) throw new Error('No se pudo comunicar con la página.');

      setStatus('success', response.shown ? 'Barra flotante visible' : 'Barra flotante oculta');
    } catch (err) {
      setStatus('error', err.message);
    }
  };

  const bindEvents = () => {
    els.btnToggleBar.addEventListener('click', toggleBar);
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
