// Open the side panel whenever the user clicks the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior failed:', err));

// ── Servo7 extension API proxy ──────────────────────────────────────────────
// The recruitment endpoints send no CORS headers, so every fetch happens here
// in the worker (host_permissions is what makes them legal) — never in a
// content script. Extension pages send:
//   { type: 'brainApi', path, method?, body?, overrides?: { baseUrl, token } }
// and get back { ok, status, data } or { ok: false, status: 0, error }.
// `overrides` lets the options page test unsaved field values.

const DEFAULT_BRAIN_URL = 'https://brain.servo7.com';

async function brainSettings() {
  const { extBaseUrl, extensionToken } = await chrome.storage.sync.get([
    'extBaseUrl',
    'extensionToken',
  ]);
  return {
    baseUrl: (extBaseUrl || DEFAULT_BRAIN_URL).replace(/\/+$/, ''),
    token: extensionToken || '',
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'brainApi' || sender.id !== chrome.runtime.id) return;
  (async () => {
    const stored = await brainSettings();
    const baseUrl = (msg.overrides?.baseUrl || stored.baseUrl).replace(/\/+$/, '');
    const token = msg.overrides?.token ?? stored.token;
    if (!token) {
      sendResponse({
        ok: false,
        status: 0,
        error: 'No extension token set. Add it in settings.',
      });
      return;
    }
    try {
      const r = await fetch(baseUrl + msg.path, {
        method: msg.method || 'GET',
        headers: {
          'X-Extension-Token': token,
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
