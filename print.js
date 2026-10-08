(async () => {
  'use strict';

  const PRINT_JOB_KEY = 'gf_print_job';
  const IMAGE_WAIT_MS = 15000;

  const msg = document.getElementById('msg');
  const root = document.getElementById('root');
  document.getElementById('btnPrint').addEventListener('click', () => window.print());

  const stored = await chrome.storage.local.get(PRINT_JOB_KEY);
  const job = stored[PRINT_JOB_KEY];
  if (!job) {
    msg.textContent = 'No hay contenido para imprimir. Vuelve a pulsar "Exportar PDF" desde la extensión.';
    return;
  }

  document.title = job.title;
  const style = document.createElement('style');
  style.textContent = job.css;
  document.head.appendChild(style);
  root.innerHTML = job.html; // HTML generado y escapado por popup.js

  // Una imagen rota no debe dejar un hueco ni bloquear la impresión
  const images = Array.from(root.querySelectorAll('img'));
  for (const img of images) {
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

  msg.textContent = images.length ? `Cargando ${images.length} imagen(es)…` : 'Listo para imprimir.';

  // Esperar a que TODAS las imágenes (Base64 o URL) terminen de cargar
  const loaded = Promise.all(
    images.map(
      (img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
    )
  );
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS))]);
  await Promise.all(images.filter((i) => i.isConnected).map((i) => i.decode().catch(() => {})));
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 150)));

  msg.textContent = 'Listo. Elige "Guardar como PDF" en el diálogo de impresión.';
  window.addEventListener('afterprint', () => chrome.storage.local.remove(PRINT_JOB_KEY), { once: true });
  window.print();
})();
