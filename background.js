// Service worker mínimo: sin IA ni peticiones externas.
// Funciones: (1) insignia "FORM" en el icono cuando la pestaña es un Google Form,
// (2) abrir print.html cuando la barra flotante lo pide,
// (3) borrar los ajustes de IA que versiones anteriores dejaron guardados.

const FORMS_URL_RE = /^https:\/\/docs\.google\.com\/forms\//i;
const LEGACY_KEYS = ['geminiApiKey', 'freeLlmEndpoint', 'ollamaEndpoint', '_keepalive_ping'];

const updateBadge = (tabId, url) => {
  const isForm = FORMS_URL_RE.test(url || '');
  chrome.action.setBadgeText({ tabId, text: isForm ? 'FORM' : '' }).catch(() => {});
  if (isForm) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' }).catch(() => {});
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
});

// La barra flotante vive en la página y no puede abrir pestañas de la extensión por sí sola
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'OPEN_PRINT') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('print.html'), openerTabId: sender.tab && sender.tab.id })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // respuesta asíncrona
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch {
    // La pestaña pudo cerrarse antes de consultarla.
  }
});
