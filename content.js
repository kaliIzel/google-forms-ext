(() => {
  'use strict';

  // Evita listeners duplicados si el popup re-inyecta el script
  if (window.__gfExtractorLoaded) return;
  window.__gfExtractorLoaded = true;

  const TYPE = Object.freeze({
    MULTIPLE_CHOICE: 'MULTIPLE_CHOICE',
    CHECKBOX: 'CHECKBOX',
    TEXT: 'TEXT',
    PARAGRAPH: 'PARAGRAPH',
    DROPDOWN: 'DROPDOWN',
    SCALE: 'SCALE',
    FILE_UPLOAD: 'FILE_UPLOAD',
    UNKNOWN: 'UNKNOWN'
  });

  // Límites para que la extracción nunca se vuelva pesada
  const MAX_IMAGES = 60;
  const MAX_INLINE_SRC = 2048; // data: URIs más largas no se escriben en el Markdown
  const MAX_EMBED_DIM = 1400; // lado máximo (px) al convertir a Base64
  const MAX_PNG_CHARS = 900000; // si el PNG supera esto, se recodifica como JPEG
  const IMAGE_TIMEOUT_MS = 8000;
  const IMAGE_CONCURRENCY = 4;

  const OTHER_VALUE = '__other_option__';

  const CONTROLS_SELECTOR =
    'input, textarea, select, [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [role="radiogroup"]';

  const REAL_CONTROLS_SELECTOR =
    'input:not([type="hidden"]), textarea, select, [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [role="radiogroup"]';

  // Elementos que pertenecen a las opciones/controles y no al texto explicativo de una tarjeta
  const BODY_SKIP_SELECTOR =
    'input, textarea, select, label, [role="radiogroup"], [role="radio"], [role="checkbox"], [role="listbox"], [role="option"], [role="group"], [role="columnheader"], [role="grid"], [role="table"]';

  const NON_TEXT_INPUT_TYPES = new Set([
    'radio', 'checkbox', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'range'
  ]);

  // Texto de interfaz de Google Forms que no es contenido del formulario
  const BOILERPLATE_RE =
    /cambiar de cuenta|switch account|no compartido|not shared|indica que la pregunta es obligatoria|indicates required question|esta es una pregunta obligatoria|this is a required question|iniciar sesi[oó]n|sign in to google/i;
  const EMAIL_ONLY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const NOISE_OPTION_RE =
    /^(borrar selecci[oó]n|clear selection|elegir|choose|seleccionar|select|obligatoria|required|tu respuesta|your answer|agregar archivo|add file|\*+)$/i;
  const UPLOAD_BUTTON_RE = /agregar archivo|add file|subir archivo|upload/i;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const plainText = (node) => (node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '');

  const cleanQuestionText = (raw) => (raw || '').replace(/\s*\*+\s*$/u, '').trim();

  const hasControls = (item) => !!$(CONTROLS_SELECTOR, item);
  const hasRealControls = (el) => !!$(REAL_CONTROLS_SELECTOR, el);

  const withTimeout = (promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });

  // ---------------------------------------------------------------------------
  // Imágenes: metadatos (síncrono) + conversión a Base64 (asíncrona, al final)
  // ---------------------------------------------------------------------------
  let imgCache = new WeakMap(); // <img> -> info (se reinicia en cada extracción)
  const infoElement = new WeakMap(); // info -> <img> (no se serializa)

  const imgInfo = (img) => {
    if (imgCache.has(img)) return imgCache.get(img);

    const rawSrc = img.currentSrc || img.getAttribute('src') || '';
    const isData = rawSrc.startsWith('data:');
    const tooBig = isData && rawSrc.length > MAX_INLINE_SRC;

    const wAttr = parseInt(img.getAttribute('width'), 10);
    const hAttr = parseInt(img.getAttribute('height'), 10);
    const wNum = img.complete && img.naturalWidth ? img.naturalWidth : wAttr;
    const hNum = img.complete && img.naturalHeight ? img.naturalHeight : hAttr;

    const info = {
      key: tooBig ? `data:${rawSrc.length}:${rawSrc.slice(-48)}` : rawSrc,
      src: tooBig ? '' : rawSrc,
      dataUrl: isData ? rawSrc : null, // se completa después para las URLs remotas
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || '',
      width: Number.isFinite(wNum) ? wNum : null,
      height: Number.isFinite(hNum) ? hNum : null,
      embedded: tooBig,
      bytes: tooBig ? Math.round(rawSrc.length * 0.75) : null
    };
    imgCache.set(img, info);
    infoElement.set(info, img);
    return info;
  };

  const extractImages = (root) => {
    const images = [];
    const seen = new Set();
    for (const img of $$('img', root)) {
      if (images.length >= MAX_IMAGES) break;
      const info = imgInfo(img);
      if (!info.key || seen.has(info.key)) continue;

      // Logos de branding de Google / gstatic
      if (info.src.includes('gstatic.com') || info.src.includes('branding')) continue;
      // Píxeles de tracking / iconos diminutos
      if ((info.width && info.width <= 2) || (info.height && info.height <= 2)) continue;

      seen.add(info.key);
      images.push(info);
    }
    return images;
  };

  // Videos incrustados (YouTube / Vimeo): se conservan como enlaces
  const extractVideos = (root) => {
    const urls = [];
    for (const frame of $$('iframe', root)) {
      const src = frame.getAttribute('src') || '';
      let url = '';
      const yt = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/i);
      if (yt) url = `https://www.youtube.com/watch?v=${yt[1]}`;
      else if (/vimeo\.com\//i.test(src)) url = src;
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  };

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader'));
      reader.readAsDataURL(blob);
    });

  const loadImage = (src, crossOrigin) =>
    new Promise((resolve, reject) => {
      const im = new Image();
      if (crossOrigin) im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image load error'));
      im.src = src;
    });

  // Dibuja en un <canvas> oculto (nunca se añade al DOM) y devuelve data:image/...;base64
  const drawToDataUrl = (source, w, h) => {
    if (!w || !h) throw new Error('sin dimensiones');
    const scale = Math.min(1, MAX_EMBED_DIM / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, cw, ch);

    const png = canvas.toDataURL('image/png'); // lanza SecurityError si el canvas quedó contaminado
    if (png.length <= MAX_PNG_CHARS) return png;

    // Fotos grandes: JPEG con fondo blanco para no inflar el resultado
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  // Descarga con la sesión del navegador (cookies de Google) y reescala vía canvas
  const viaFetch = async (src) => {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!/^image\//i.test(blob.type)) throw new Error('la respuesta no es una imagen');

    const objectUrl = URL.createObjectURL(blob);
    try {
      const im = await loadImage(objectUrl, false);
      return drawToDataUrl(im, im.naturalWidth, im.naturalHeight);
    } catch {
      return await blobToDataUrl(blob); // p. ej. SVG sin dimensiones o CSP que bloquea blob:
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const fetchDataUrl = async (src, el) => {
    const attempts = [
      // 1. La propia <img> del DOM, ya cargada con la sesión activa
      async () => {
        if (!el) throw new Error('sin elemento');
        if (!el.complete) await el.decode();
        return drawToDataUrl(el, el.naturalWidth, el.naturalHeight);
      },
      // 2. fetch con credenciales -> blob -> canvas
      () => viaFetch(src),
      // 3. Nueva <img> con CORS anónimo (hosts como lh3.googleusercontent.com)
      async () => {
        const im = await loadImage(src, true);
        return drawToDataUrl(im, im.naturalWidth, im.naturalHeight);
      }
    ];

    for (const attempt of attempts) {
      try {
        const url = await withTimeout(attempt(), IMAGE_TIMEOUT_MS);
        if (url) return url;
      } catch {
        // se prueba la siguiente estrategia
      }
    }
    return null;
  };

  const embedImages = async (groups) => {
    const queue = [...groups.values()];
    const worker = async () => {
      while (queue.length) {
        const group = queue.shift();
        const already = group.infos.find((i) => i.dataUrl);
        const url = already ? already.dataUrl : group.src ? await fetchDataUrl(group.src, group.el) : null;
        for (const info of group.infos) info.dataUrl = url;
      }
    };
    await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
  };

  const mdImage = (img, fallbackAlt) => {
    if (img.embedded) {
      const kb = img.bytes ? ` (~${Math.round(img.bytes / 1024)} KB)` : '';
      return `_[Imagen embebida omitida${kb}${img.alt ? `: ${img.alt}` : ''}]_`;
    }
    if (!img.src) return '';
    return `![${img.alt || fallbackAlt}](${img.src})`;
  };

  // ---------------------------------------------------------------------------
  // Texto enriquecido: conserva saltos de línea, listas, negritas y enlaces
  // ---------------------------------------------------------------------------
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE'
  ]);
  const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IMG', 'BUTTON', 'IFRAME']);

  const unwrapGoogleUrl = (href) => {
    try {
      const u = new URL(href, location.href);
      if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/url') {
        return u.searchParams.get('q') || u.searchParams.get('url') || u.href;
      }
      return u.href;
    } catch {
      return href;
    }
  };

  const isHiddenEl = (el) => {
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };

  // Normaliza líneas: quita espacios sobrantes y conserva la sangría de listas anidadas
  const tidy = (text) =>
    text
      .split('\n')
      .map((line) => {
        const trimmedEnd = line.replace(/[ \t]+$/, '');
        const m = trimmedEnd.match(/^( *)(.*)$/);
        const rest = m[2].replace(/^(-|\d+\.)\s+/, '$1 ');
        const isList = /^(-|\d+\.) /.test(rest);
        const indent = isList ? '  '.repeat(Math.floor(m[1].length / 2)) : '';
        return indent + rest;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const richText = (root, skip = () => false) => {
    let out = '';
    const lists = []; // pila de listas { ordered, n }
    const nl = () => {
      if (out && !out.endsWith('\n')) out += '\n';
    };

    const wrapInline = (start, mark) => {
      const seg = out.slice(start);
      const m = seg.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (m[2] && !m[2].includes('\n')) out = `${out.slice(0, start)}${m[1]}${mark}${m[2]}${mark}${m[3]}`;
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += (node.nodeValue || '').replace(/\s+/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (skip(node)) return;

      const tag = node.tagName.toUpperCase();
      if (IGNORED_TAGS.has(tag)) return;
      if (node.getAttribute('role') === 'button') return;
      if (isHiddenEl(node)) return;

      if (tag === 'BR') {
        out += '\n';
        return;
      }

      if (tag === 'A' && node.getAttribute('href')) {
        const label = plainText(node);
        if (label) {
          const url = unwrapGoogleUrl(node.getAttribute('href'));
          out += label === url ? url : `[${label}](${url})`;
        }
        return;
      }

      if (tag === 'UL' || tag === 'OL') {
        lists.push({ ordered: tag === 'OL', n: 0 });
        nl();
        for (const child of node.childNodes) walk(child);
        lists.pop();
        nl();
        return;
      }

      if (tag === 'LI') {
        nl();
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (list && list.ordered) {
          list.n += 1;
          out += `${indent}${list.n}. `;
        } else {
          out += `${indent}- `;
        }
        for (const child of node.childNodes) walk(child);
        nl();
        return;
      }

      if (tag === 'B' || tag === 'STRONG' || tag === 'I' || tag === 'EM') {
        const start = out.length;
        for (const child of node.childNodes) walk(child);
        wrapInline(start, tag === 'B' || tag === 'STRONG' ? '**' : '*');
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) nl();
      for (const child of node.childNodes) walk(child);
      if (isBlock) nl();
    };

    walk(root);
    return tidy(out);
  };

  const cleanHeaderLines = (text) => {
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line && line.length < 160 && BOILERPLATE_RE.test(line)) {
        // El correo de la cuenta suele ir justo antes de "Cambiar de cuenta"
        if (out.length && EMAIL_ONLY_RE.test(out[out.length - 1].trim())) out.pop();
        continue;
      }
      out.push(raw.replace(/\s+$/, ''));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // Sube desde el título hasta el ancestro más alto que aún no contiene
  // la lista de preguntas ni controles: esa es la "tarjeta de cabecera".
  const findHeaderCard = (mainHeading) => {
    if (!mainHeading) return null;
    let card = mainHeading;
    for (
      let cur = mainHeading.parentElement;
      cur && cur !== document.body && cur !== document.documentElement;
      cur = cur.parentElement
    ) {
      if (cur.tagName === 'FORM') break;
      if ($('[role="listitem"], [role="list"]', cur)) break;
      if (hasRealControls(cur)) break;
      card = cur;
    }
    return card;
  };

  const extractHeaderDescription = (card, mainHeading) => {
    if (!card) return '';
    const skip = (el) => el === mainHeading;
    let text = cleanHeaderLines(richText(card, skip));

    // Si el título aparece repetido al inicio, se descarta
    const titleText = plainText(mainHeading);
    if (titleText && text.startsWith(titleText)) text = text.slice(titleText.length).trim();
    return text;
  };

  // ---------------------------------------------------------------------------
  // Etiquetas de opciones: cadena de fallbacks
  // ---------------------------------------------------------------------------
  const nodeLabel = (node) => {
    const dv = node.getAttribute('data-value');
    if (dv && dv !== OTHER_VALUE) return dv.trim();

    const own = plainText(node);
    if (own) return own;

    const aria = (node.getAttribute('aria-label') || '').trim();
    if (aria) return dv === OTHER_VALUE ? aria.replace(/\s*:\s*$/, '') : aria;

    const label = node.closest('label');
    if (label) {
      const t = plainText(label);
      if (t) return t;
    }

    // Ancestros cercanos que contengan SOLO este control: su texto es la etiqueta
    const role = node.getAttribute('role');
    let cur = node.parentElement;
    for (let i = 0; i < 3 && cur; i += 1, cur = cur.parentElement) {
      if (role && $$(`[role="${role}"]`, cur).length > 1) break;
      const t = plainText(cur);
      if (t) return t;
    }

    return dv === OTHER_VALUE ? 'Otro' : '';
  };

  const isNoiseOption = (text) => !text || NOISE_OPTION_RE.test(text) || /^indica que/i.test(text);

  const isScale = (item) => {
    const headers = $$('[role="columnheader"]', item);
    if (headers.length >= 2) {
      const numeric = headers.filter((h) => /^\d+$/u.test(plainText(h).trim()));
      if (numeric.length >= 2) return true;
    }

    const radios = $$('[role="radio"]', item);
    if (radios.length >= 3) {
      const numeric = radios.filter((r) => /^\d+$/u.test(nodeLabel(r)));
      return numeric.length > 0 && numeric.length === radios.length;
    }

    return false;
  };

  const detectRequired = (item) => {
    if ($('[aria-required="true"], [data-required="true"], [required]', item)) return true;

    for (const span of $$('span', item)) {
      if (!span.querySelector('*') && /^\*+$/u.test(span.textContent.trim())) return true;
    }

    for (const el of $$('[title]', item)) {
      const t = el.getAttribute('title') || '';
      if (t === '*' || /obligator/i.test(t)) return true;
    }

    if (/obligator|required/i.test(item.getAttribute('aria-label') || '')) return true;

    return false;
  };

  const detectType = (item) => {
    if ($('textarea', item)) return TYPE.PARAGRAPH;

    const textInput = $$('input', item).find(
      (i) => !NON_TEXT_INPUT_TYPES.has((i.getAttribute('type') || 'text').toLowerCase())
    );
    if (
      textInput &&
      !$('[role="radiogroup"], [role="radio"], [role="checkbox"], [role="listbox"]', item)
    ) {
      return TYPE.TEXT;
    }

    if (isScale(item)) return TYPE.SCALE;
    if ($('[role="radiogroup"], [role="radio"]', item)) return TYPE.MULTIPLE_CHOICE;
    if ($('[role="checkbox"]', item)) return TYPE.CHECKBOX;
    if ($('[role="listbox"], [role="option"]', item)) return TYPE.DROPDOWN;

    return TYPE.UNKNOWN;
  };

  const isUploadItem = (item) =>
    !!$('input[type="file"]', item) ||
    $$('[role="button"], button', item).some((b) => UPLOAD_BUTTON_RE.test(plainText(b)));

  const isSectionItem = (item) => {
    const heading = $('[role="heading"]', item);
    if (!heading || !plainText(heading)) return false;
    if (hasControls(item)) return false;
    if ($('[role="button"], button', item)) return true;
    return heading.getAttribute('aria-level') === '2';
  };

  // ---------------------------------------------------------------------------
  // Cuerpo completo de una tarjeta: instrucciones, listas, enlaces, párrafos...
  // Recorre TODO el árbol del bloque (no solo el primer [dir="auto"]) y excluye
  // únicamente el título y los controles/opciones.
  // ---------------------------------------------------------------------------
  const extractBody = (item, headingEl, excludeTexts = new Set()) => {
    const skip = (el) =>
      (headingEl && (el === headingEl || headingEl.contains(el))) || el.matches(BODY_SKIP_SELECTOR);

    const raw = cleanHeaderLines(richText(item, skip));
    const kept = raw.split('\n').filter((line) => {
      const t = line.trim();
      if (!t) return true; // se conservan los párrafos en blanco
      if (/^\*+$/.test(t) || isNoiseOption(t) || excludeTexts.has(t)) return false;
      return true;
    });
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // Último recurso: recorre los nodos de texto más internos (label / [dir=auto] / span)
  const fallbackTextOptions = (item, headingEl, push) => {
    const cands = $$('label, [dir="auto"], span', item).filter((el) => {
      if (headingEl && (el === headingEl || headingEl.contains(el))) return false;
      if (el.closest('[role="heading"], [role="button"], button')) return false;
      return true;
    });
    const leaves = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    for (const el of leaves) {
      const t = plainText(el);
      if (!t || t.length > 200 || isNoiseOption(t)) continue;
      push(t, extractImages(el));
    }
  };

  const collectOptions = (item, type, headingEl) => {
    const options = [];
    const seen = new Set();

    const push = (text, images = []) => {
      const clean = (text || '').trim();
      const key = clean || images.map((i) => i.key).join('|');
      if (!clean && !images.length) return;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({ text: clean, images });
    };

    let nodes = [];

    if (type === TYPE.SCALE) {
      for (const h of $$('[role="columnheader"]', item)) {
        push(plainText(h).replace(/\s*\*+\s*$/u, ''), extractImages(h));
      }
      if (!options.length) {
        nodes = $$('[role="radio"]', item).filter((r) => /^\d+$/u.test(nodeLabel(r)));
      }
    } else if (type === TYPE.MULTIPLE_CHOICE) {
      nodes = $$('[role="radio"]', item);
    } else if (type === TYPE.CHECKBOX) {
      nodes = $$('[role="checkbox"]', item);
    } else if (type === TYPE.DROPDOWN) {
      nodes = $$('[role="option"]', item);
    }

    let expected = 0;
    for (const node of nodes) {
      if (nodes.some((other) => other !== node && other.contains(node))) continue;
      const text = nodeLabel(node);
      if (text && isNoiseOption(text)) continue; // p. ej. "Elegir" en desplegables
      expected += 1;
      push(text, extractImages(node.closest('label') || node));
    }

    if ((type === TYPE.MULTIPLE_CHOICE || type === TYPE.CHECKBOX) && !options.length) {
      for (const h of $$('[role="columnheader"], [role="gridcell"]', item)) {
        push(plainText(h), extractImages(h));
      }
    }

    const choiceType =
      type === TYPE.MULTIPLE_CHOICE || type === TYPE.CHECKBOX || type === TYPE.DROPDOWN;
    if (choiceType && (options.length === 0 || options.length < expected)) {
      fallbackTextOptions(item, headingEl, push);
    }

    return options;
  };

  const processItem = (item) => {
    const headingEl = $('[role="heading"]', item);
    const controls = hasControls(item);
    const upload = !controls && isUploadItem(item);

    const titleFromHeading = headingEl
      ? cleanQuestionText(richText(headingEl).replace(/\s*\n\s*/g, ' '))
      : '';
    const title = titleFromHeading || (controls || upload ? cleanQuestionText(plainText(item)) : '');

    const images = extractImages(item);
    const videos = extractVideos(item);

    // Bloques sin controles: secciones y bloques informativos (texto, imagen, video)
    if (!controls && !upload) {
      const description = extractBody(item, headingEl);
      return {
        kind: isSectionItem(item) ? 'section' : 'info',
        title,
        description,
        images,
        videos
      };
    }

    const type = upload ? TYPE.FILE_UPLOAD : detectType(item);
    const options = collectOptions(item, type, headingEl);

    const optionTexts = new Set(options.map((o) => o.text).filter(Boolean));
    const optionImageKeys = new Set(options.flatMap((o) => o.images.map((i) => i.key)));

    return {
      kind: 'question',
      questionText: title,
      helpText: extractBody(item, headingEl, optionTexts),
      isRequired: detectRequired(item),
      type,
      options,
      images: images.filter((i) => !optionImageKeys.has(i.key)),
      videos
    };
  };

  // ---------------------------------------------------------------------------
  // Markdown
  // ---------------------------------------------------------------------------
  const quote = (text) =>
    text
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');

  const pushMedia = (lines, images = [], videos = [], fallbackAlt = 'imagen') => {
    for (const img of images) {
      const md = mdImage(img, fallbackAlt);
      if (md) lines.push('', md);
    }
    for (const url of videos) lines.push('', `[Video](${url})`);
  };

  const toMarkdown = (data) => {
    const lines = [`# ${data.title || '(Formulario sin título)'}`];

    if (data.description) lines.push('', data.description);
    pushMedia(lines, data.images, [], 'imagen del formulario');

    for (const item of data.items) {
      if (item.kind === 'section') {
        lines.push('', `## ${item.title || 'Sección'}`);
        if (item.description) lines.push('', item.description);
        pushMedia(lines, item.images, item.videos, 'imagen de la sección');
        continue;
      }

      if (item.kind === 'info') {
        lines.push('', item.title ? `#### ${item.title}` : '');
        if (item.description) lines.push('', item.description);
        pushMedia(lines, item.images, item.videos, 'imagen');
        continue;
      }

      const requirement = item.isRequired ? ' **[Obligatoria]**' : '';
      lines.push(
        '',
        `### ${item.number}. ${item.questionText || '(sin enunciado)'} [${item.type}]${requirement}`
      );

      if (item.helpText) lines.push('', quote(item.helpText));
      pushMedia(lines, item.images, item.videos, `Imagen ${item.number}`);

      if (item.options.length) {
        lines.push('', 'Opciones:');
        for (const opt of item.options) {
          let label = opt.text || '(opción con imagen)';
          for (const img of opt.images) {
            const md = mdImage(img, 'imagen');
            if (md) label += ` - ${md}`;
          }
          lines.push(`- ${label}`);
        }
      }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // ---------------------------------------------------------------------------
  // Extracción principal
  // ---------------------------------------------------------------------------
  const extractForm = async () => {
    imgCache = new WeakMap();

    const list = $('[role="list"]');
    const roots = list ? [list] : [document.body];
    const listItems = [];
    const headingNodes = [];

    for (const root of roots) {
      listItems.push(...$$('[role="listitem"]', root));
      headingNodes.push(...$$('[role="heading"]', root));
    }

    const dedupedItems = listItems.filter(
      (item, i, arr) => !arr.some((other, j) => i !== j && other !== item && other.contains(item))
    );

    const outsideItems = headingNodes.filter((h) => !dedupedItems.some((it) => it.contains(h)));

    // 1. TÍTULO
    const mainHeading = $('[role="heading"][aria-level="1"]') || outsideItems[0] || $('[role="heading"]');
    let title = cleanQuestionText(plainText(mainHeading));
    if (title.toLowerCase().includes('correo electrónico') && outsideItems[1]) {
      title = cleanQuestionText(plainText(outsideItems[1]));
    }

    // 2. DESCRIPCIÓN: toda la tarjeta de cabecera, sin depender de clases CSS dinámicas
    const headerCard = findHeaderCard(mainHeading);
    let description = extractHeaderDescription(headerCard, mainHeading);

    if (!description) {
      const descEl = $('.F92AHe') || $('[role="heading"][aria-level="1"] ~ div') || $('[role="heading"] + div');
      if (descEl) description = cleanHeaderLines(richText(descEl));
    }

    // Si la cabecera vive dentro de un [role="listitem"], no debe procesarse como pregunta
    const items = dedupedItems.filter(
      (it) => !(mainHeading && it.contains(mainHeading) && !hasRealControls(it))
    );

    // 3. BLOQUES EN ORDEN DE APARICIÓN
    let sectionCounter = 0;
    let questionCounter = 0;
    let currentSectionIndex = null;
    const ordered = [];

    for (const item of items) {
      const info = processItem(item);

      if (info.kind === 'section') {
        currentSectionIndex = sectionCounter;
        sectionCounter += 1;
        ordered.push({ ...info, index: currentSectionIndex });
        continue;
      }

      if (info.kind === 'info') {
        // Bloques completamente vacíos (separadores) no aportan nada
        if (!info.title && !info.description && !info.images.length && !info.videos.length) continue;
        ordered.push({ ...info, sectionIndex: currentSectionIndex });
        continue;
      }

      questionCounter += 1;
      ordered.push({ ...info, number: questionCounter, sectionIndex: currentSectionIndex });
    }

    // 4. IMÁGENES DE CABECERA (solo de la tarjeta si se encontró; evita avatares de cuenta)
    const itemImageKeys = new Set();
    for (const it of ordered) {
      for (const img of it.images || []) itemImageKeys.add(img.key);
      for (const opt of it.options || []) for (const img of opt.images) itemImageKeys.add(img.key);
    }
    const headerSource = headerCard && headerCard !== mainHeading ? headerCard : document.body;
    const headerImages = extractImages(headerSource).filter((img) => !itemImageKeys.has(img.key));

    // 5. CONVERSIÓN A BASE64 (una sola vez por URL, con la sesión del navegador)
    const groups = new Map();
    const register = (info) => {
      if (!groups.has(info.key)) {
        groups.set(info.key, { infos: [], src: info.src, el: infoElement.get(info) });
      }
      groups.get(info.key).infos.push(info);
    };
    headerImages.forEach(register);
    for (const it of ordered) {
      (it.images || []).forEach(register);
      for (const opt of it.options || []) opt.images.forEach(register);
    }
    await embedImages(groups);

    const embeddedCount = [...groups.values()].filter((g) => g.infos[0].dataUrl).length;

    const data = {
      url: location.href,
      extractedAt: new Date().toISOString(),
      title,
      description,
      images: headerImages,
      sectionCount: ordered.filter((i) => i.kind === 'section').length,
      questionCount: ordered.filter((i) => i.kind === 'question').length,
      infoCount: ordered.filter((i) => i.kind === 'info').length,
      imageCount: groups.size,
      imagesEmbedded: embeddedCount,
      items: ordered
    };

    return { success: true, data, markdown: toMarkdown(data) };
  };

  const handleMessage = (message, _sender, sendResponse) => {
    if (!message || message.action !== 'EXTRACT_FORM') return false;
    extractForm()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err && err.message ? err.message : String(err) }));
    return true; // respuesta asíncrona
  };

  chrome.runtime.onMessage.addListener(handleMessage);
})();