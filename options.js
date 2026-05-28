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
  crmUrlEl.value = crmUrl || 'https://crm.becking.dev';
  tokenEl.value = internalToken || '';
}

async function save() {
  const crmUrl = crmUrlEl.value.trim().replace(/\/+$/, '') || 'https://crm.becking.dev';
  const internalToken = tokenEl.value.trim();
  await chrome.storage.local.set({ crmUrl, internalToken });
  setMsg('Saved.', '#30d158');
}

async function test() {
  const crmUrl = crmUrlEl.value.trim().replace(/\/+$/, '') || 'https://crm.becking.dev';
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
