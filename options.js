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
// Separate settings namespace: chrome.storage.sync, X-Extension-Token auth.
// All requests go through the background worker (the API sends no CORS
// headers); `overrides` lets Test connection use unsaved field values.

const extBaseUrlEl = document.getElementById('extBaseUrl');
const extTokenEl   = document.getElementById('extensionToken');
const extSaveBtn   = document.getElementById('extSaveBtn');
const extTestBtn   = document.getElementById('extTestBtn');
const extMsgEl     = document.getElementById('extMsg');

function setExtMsg(text, color) {
  extMsgEl.textContent = text;
  extMsgEl.style.color = color || '#8e8e93';
}

async function loadExt() {
  const { extBaseUrl, extensionToken } = await chrome.storage.sync.get([
    'extBaseUrl',
    'extensionToken',
  ]);
  extBaseUrlEl.value = extBaseUrl || DEFAULT_CRM_URL;
  extTokenEl.value = extensionToken || '';
}

async function saveExt() {
  const extBaseUrl =
    extBaseUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  const extensionToken = extTokenEl.value.trim();
  await chrome.storage.sync.set({ extBaseUrl, extensionToken });
  setExtMsg('Saved.', '#30d158');
}

async function testExt() {
  const baseUrl = extBaseUrlEl.value.trim().replace(/\/+$/, '') || DEFAULT_CRM_URL;
  const token = extTokenEl.value.trim();
  if (!token) {
    setExtMsg('Add a token first.', '#ff453a');
    return;
  }
  setExtMsg('Testing…');
  const resp = await chrome.runtime
    .sendMessage({
      type: 'brainApi',
      path: '/api/extension/ping',
      overrides: { baseUrl, token },
    })
    .catch((e) => ({ ok: false, status: 0, error: e.message }));
  if (!resp) {
    setExtMsg('No response from background worker.', '#ff453a');
  } else if (resp.ok) {
    setExtMsg('OK — token accepted.', '#30d158');
  } else {
    setExtMsg(
      resp.error || `HTTP ${resp.status}: ${resp.data?.detail || 'request failed'}`,
      '#ff453a',
    );
  }
}

extSaveBtn.addEventListener('click', saveExt);
extTestBtn.addEventListener('click', testExt);
loadExt();
