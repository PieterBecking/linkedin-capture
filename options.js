const DEFAULT_CRM_URL = 'https://brain.servo7.com';
// The CRM moved from crm.becking.dev to brain.servo7.com. A stored legacy URL
// is treated as unset so existing installs migrate without re-saving.
const LEGACY_CRM_URL = 'https://crm.becking.dev';

const crmUrlEl = document.getElementById('crmUrl');
const tokenEl  = document.getElementById('internalToken');
const saveBtn  = document.getElementById('saveBtn');
const testBtn  = document.getElementById('testBtn');
const msgEl    = document.getElementById('msg');

function setMsg(text, color) {
  msgEl.textContent = text;
  msgEl.style.color = color || '#8e8e93';
}

async function load() {
  const { crmUrl, internalToken } = await chrome.storage.local.get([
    'crmUrl',
    'internalToken',
  ]);
  crmUrlEl.value = !crmUrl || crmUrl === LEGACY_CRM_URL ? DEFAULT_CRM_URL : crmUrl;
  tokenEl.value = internalToken || '';
}

async function save() {
  const crmUrl = crmUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  const internalToken = tokenEl.value.trim();
  await chrome.storage.local.set({ crmUrl, internalToken });
  setMsg('Saved.', '#30d158');
}

async function test() {
  const crmUrl = crmUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  const internalToken = tokenEl.value.trim();
  if (!internalToken) {
    setMsg('Add a token first.', '#ff453a');
    return;
  }
  setMsg('Testing…');
  try {
    const r = await fetch(`${crmUrl}/api/manifest`, {
      headers: {
        'X-Internal-Token': internalToken,
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      setMsg(`HTTP ${r.status}`, '#ff453a');
      return;
    }
    const data = await r.json();
    const companies = (data.companies || []).length;
    setMsg(`OK. ${companies} companies in manifest.`, '#30d158');
  } catch (e) {
    setMsg(`Error: ${e.message}`, '#ff453a');
  }
}

saveBtn.addEventListener('click', save);
testBtn.addEventListener('click', test);
load();

// ── recruitment export (extension API) ─────────────────────────────────────
// Auth is the Brain session cookie — no extension-side credential. Only the
// base URL is stored (chrome.storage.sync). All requests go through the
// background worker (the API sends no CORS headers); `overrides` lets
// Test connection use an unsaved base URL.

const extBaseUrlEl = document.getElementById('extBaseUrl');
const extSaveBtn   = document.getElementById('extSaveBtn');
const extTestBtn   = document.getElementById('extTestBtn');
const extMsgEl     = document.getElementById('extMsg');

function setExtMsg(text, color) {
  extMsgEl.textContent = text;
  extMsgEl.style.color = color || '#8e8e93';
}

async function loadExt() {
  const { extBaseUrl } = await chrome.storage.sync.get(['extBaseUrl']);
  extBaseUrlEl.value = extBaseUrl || DEFAULT_CRM_URL;
  // The server-side extension token was deleted; drop any stored copy.
  chrome.storage.sync.remove('extensionToken');
}

async function saveExt() {
  const extBaseUrl =
    extBaseUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  await chrome.storage.sync.set({ extBaseUrl });
  setExtMsg('Saved.', '#30d158');
}

async function testExt() {
  const baseUrl = extBaseUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  setExtMsg('Testing…');
  const resp = await chrome.runtime
    .sendMessage({
      type: 'brainApi',
      path: '/api/extension/ping',
      overrides: { baseUrl },
    })
    .catch((e) => ({ ok: false, status: 0, error: e.message }));
  if (resp?.ok) {
    const caps = Array.isArray(resp.data?.capabilities)
      ? ` (${resp.data.capabilities.join(', ')})`
      : '';
    setExtMsg(`OK — signed in${caps}.`, '#30d158');
  } else if (resp?.status === 401) {
    setExtMsg(`Signed out — sign in at ${baseUrl} in this browser, then retry.`, '#ffd60a');
  } else {
    setExtMsg(
      `Unreachable: ${resp?.error || `HTTP ${resp?.status ?? '?'}`}`,
      '#ff453a',
    );
  }
}

extSaveBtn.addEventListener('click', saveExt);
extTestBtn.addEventListener('click', testExt);
loadExt();
