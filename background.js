// Service worker mínimo: sin IA ni peticiones externas.
// Solo marca el icono con una insignia cuando la pestaña es un Google Form
// y limpia los ajustes de IA que versiones anteriores dejaron guardados.

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