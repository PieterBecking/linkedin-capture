// Open the side panel whenever the user clicks the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior failed:', err));

// ── Servo7 extension API proxy ──────────────────────────────────────────────
// The /api/extension/* routes send no CORS headers, so every fetch happens
// here in the worker (host_permissions is what makes them legal and
// cookie-bearing) — never in a content script. Auth is the Brain session
// cookie (credentials: 'include'); there is no extension-side credential.
// A 401 therefore means "signed out of brain.servo7.com in this browser",
// not a configuration problem. Extension pages send:
//   { type: 'brainApi', path, method?, body?, overrides?: { baseUrl } }
// and get back { ok, status, data } or { ok: false, status: 0, error }.
// `overrides` lets the options page test an unsaved base URL.

const DEFAULT_BRAIN_URL = 'https://brain.servo7.com';

async function brainBaseUrl() {
  const { extBaseUrl } = await chrome.storage.sync.get(['extBaseUrl']);
  return (extBaseUrl || DEFAULT_BRAIN_URL).replace(/\/+$/, '');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'brainApi' || sender.id !== chrome.runtime.id) return;
  (async () => {
    const baseUrl = (msg.overrides?.baseUrl || (await brainBaseUrl())).replace(/\/+$/, '');
    try {
      const r = await fetch(baseUrl + msg.path, {
        method: msg.method || 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(msg.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
      });
      const data = await r.json().catch(() => null);
      sendResponse({ ok: r.ok, status: r.status, data });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
