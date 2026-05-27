// LinkedIn → CRM side panel.
//
// 1. Capture the open LinkedIn thread (via chrome.scripting.executeScript).
// 2. Let the user name the meeting with #company / @person mentions (popover
//    powered by GET {CRM_URL}/api/manifest).
// 3. POST to {CRM_URL}/api/notes with X-Internal-Token auth.

const DEFAULT_CRM_URL = 'https://crm.becking.dev';
const LINKEDIN_THREAD_RE = /^https:\/\/www\.linkedin\.com\/messaging\/thread\//;

// ── settings ────────────────────────────────────────────────────────────────
async function getSettings() {
  const { crmUrl, internalToken } = await chrome.storage.local.get([
    'crmUrl',
    'internalToken',
  ]);
  return {
    crmUrl: (crmUrl || DEFAULT_CRM_URL).replace(/\/+$/, ''),
    internalToken: internalToken || '',
  };
}

// ── state ──────────────────────────────────────────────────────────────────
let captured = null;        // { url, threadId, threadTitle, messages, capturedAt }
let manifest = null;        // { companies, team, people_ranked, ... }
let pendingCompany = null;  // { slug | null, title }
let pendingAttendees = [];  // [string]
let saving = false;

// mention popover state
let inMention = false;
let mentionSpan = null;
let mentionMode = null;     // 'company' | 'person'
let suggestItems = [];
let suggestActive = 0;
let suggestVisible = false;

// ── elements ───────────────────────────────────────────────────────────────
const statusEl   = document.getElementById('status');
const captureBtn = document.getElementById('captureBtn');
const captureMeta= document.getElementById('captureMeta');
const formCard   = document.getElementById('formCard');
const titleEl    = document.getElementById('meetingTitle');
const pillsEl    = document.getElementById('pills');
const dateEl     = document.getElementById('meetingDate');
const previewEl  = document.getElementById('preview');
const saveBtn    = document.getElementById('saveBtn');
const saveResult = document.getElementById('saveResult');
const popoverEl  = document.getElementById('suggestPopover');
const openOpts   = document.getElementById('openOptions');

// ── helpers ────────────────────────────────────────────────────────────────
function setStatus(msg, level) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden', 'ok', 'err', 'warn');
  if (level) statusEl.classList.add(level);
  if (!msg) statusEl.classList.add('hidden');
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getTitleText() {
  const clone = titleEl.cloneNode(true);
  clone.querySelectorAll('.mention-draft').forEach((s) => s.remove());
  return clone.textContent.trim();
}

function formatConversation(cap) {
  if (!cap?.messages?.length) return '(no messages found)';
  return cap.messages
    .map((m) => {
      const time = m.timestamp ? ` (${m.timestamp})` : '';
      return `[${m.sender}]${time}\n${m.text}`;
    })
    .join('\n\n');
}

// ── manifest ───────────────────────────────────────────────────────────────
async function loadManifest() {
  const { crmUrl, internalToken } = await getSettings();
  if (!internalToken) {
    setStatus('Set the CRM internal token in settings to enable # / @ lookup.', 'warn');
    return null;
  }
  try {
    const r = await fetch(`${crmUrl}/api/manifest`, {
      headers: {
        'X-Internal-Token': internalToken,
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      setStatus(`Manifest fetch failed: HTTP ${r.status}`, 'err');
      return null;
    }
    manifest = await r.json();
    return manifest;
  } catch (e) {
    setStatus(`Manifest fetch error: ${e.message}`, 'err');
    return null;
  }
}

// ── pills ──────────────────────────────────────────────────────────────────
function renderPills() {
  pillsEl.innerHTML = '';
  if (pendingCompany) {
    const chip = document.createElement('span');
    chip.className = 'attendee-pill company removable';
    chip.textContent = pendingCompany.title;
    chip.title = 'Click to remove';
    chip.addEventListener('click', () => {
      pendingCompany = null;
      renderPills();
    });
    pillsEl.appendChild(chip);
  }
  pendingAttendees.forEach((name) => {
    const pill = document.createElement('span');
    pill.className = 'attendee-pill removable';
    pill.textContent = name;
    pill.title = 'Click to remove';
    pill.addEventListener('click', () => {
      pendingAttendees = pendingAttendees.filter((n) => n !== name);
      renderPills();
    });
    pillsEl.appendChild(pill);
  });
}

// ── mentions ──────────────────────────────────────────────────────────────
function insertMentionSpan(mode) {
  const span = document.createElement('span');
  span.className = 'mention-draft' + (mode === 'company' ? ' company' : '');
  span.textContent = mode === 'company' ? '#' : '@';
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(span);
  } else {
    titleEl.appendChild(span);
  }
  const r = document.createRange();
  r.setStart(span.firstChild, 1);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  mentionSpan = span;
  mentionMode = mode;
  inMention = true;
}

function finalizeMention(picked) {
  const mode = mentionMode;
  const raw = (mentionSpan?.textContent || '').slice(1).trim();
  const span = mentionSpan;
  mentionSpan = null;
  inMention = false;
  mentionMode = null;
  hideSuggest();

  if (mode === 'company') {
    if (picked)    pendingCompany = { slug: picked.slug, title: picked.title };
    else if (raw)  pendingCompany = { slug: null, title: raw };
    if (pendingCompany && span) {
      const textNode = document.createTextNode(pendingCompany.title);
      span.replaceWith(textNode);
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(textNode, textNode.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      span?.remove();
    }
  } else {
    span?.remove();
    const name = picked ? picked.name : raw;
    if (name && !pendingAttendees.includes(name)) pendingAttendees.push(name);
  }
  renderPills();
  titleEl.focus();
}

function cancelMention() {
  mentionSpan?.remove();
  mentionSpan = null;
  inMention = false;
  mentionMode = null;
  hideSuggest();
}

function hideSuggest() {
  popoverEl.classList.add('hidden');
  popoverEl.innerHTML = '';
  suggestItems = [];
  suggestActive = 0;
  suggestVisible = false;
}

function positionPopover() {
  if (!mentionSpan) return;
  const r = mentionSpan.getBoundingClientRect();
  popoverEl.style.top = r.bottom + 4 + 'px';
  popoverEl.style.left = r.left + 'px';
}

function renderSuggest() {
  if (suggestItems.length === 0) {
    popoverEl.innerHTML = '<div class="suggest-empty">No matches — Enter to use as-is</div>';
    suggestActive = 0;
  } else {
    if (suggestActive >= suggestItems.length) suggestActive = 0;
    popoverEl.innerHTML = suggestItems
      .map(
        (it, i) => `
          <div class="suggest-item${i === suggestActive ? ' active' : ''}" data-idx="${i}">
            <div>${escHtml(it.name)}</div>
            ${it.sub ? `<div class="suggest-item-sub">${escHtml(it.sub)}</div>` : ''}
          </div>`,
      )
      .join('');
    popoverEl.querySelectorAll('.suggest-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const i = Number(el.getAttribute('data-idx'));
        finalizeMention(suggestItems[i].payload);
      });
    });
  }
  popoverEl.classList.remove('hidden');
  suggestVisible = true;
  positionPopover();
}

function computeSuggest(query) {
  if (!manifest) return [];
  const q = (query || '').toLowerCase().trim();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const companies = manifest.companies || [];
  const team = manifest.team || [];
  const ranked = manifest.people_ranked || [];

  if (mentionMode === 'company') {
    return companies
      .filter((c) => match(c.title))
      .slice(0, 20)
      .map((c) => ({
        name: c.title,
        sub: [c.stage, c.priority].filter(Boolean).join(' · '),
        payload: c,
      }));
  }

  let scopedNames = [];
  if (pendingCompany?.slug) {
    const co = companies.find((c) => c.slug === pendingCompany.slug);
    if (co) scopedNames = (co.people || []).map((p) => p.name);
  }
  const seen = new Set();
  const out = [];
  const push = (name, sub) => {
    const key = (name || '').toLowerCase();
    if (!key || seen.has(key)) return;
    if (!match(name)) return;
    seen.add(key);
    out.push({ name, sub, payload: { name } });
  };
  scopedNames.forEach((n) => push(n, pendingCompany.title));
  team.forEach((n) => push(n, 'Servo7'));
  if (q || out.length < 6) ranked.forEach((n) => push(n));
  return out.slice(0, 20);
}

function refreshSuggest() {
  if (!inMention || !mentionSpan) return;
  const query = (mentionSpan.textContent || '').slice(1);
  suggestItems = computeSuggest(query);
  suggestActive = 0;
  renderSuggest();
}

// ── title input ────────────────────────────────────────────────────────────
titleEl.addEventListener('input', () => {
  if (!inMention) return;
  // If the mention span got merged/destroyed, bail.
  if (!mentionSpan || !titleEl.contains(mentionSpan)) {
    cancelMention();
    return;
  }
  refreshSuggest();
});

titleEl.addEventListener('keydown', (e) => {
  if (!inMention) {
    if (e.key === '#' || e.key === '@') {
      e.preventDefault();
      insertMentionSpan(e.key === '#' ? 'company' : 'person');
      // Defer to next tick so the empty mention span is in the DOM.
      setTimeout(refreshSuggest, 0);
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelMention();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (suggestItems.length) {
      suggestActive = (suggestActive + 1) % suggestItems.length;
      renderSuggest();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (suggestItems.length) {
      suggestActive = (suggestActive - 1 + suggestItems.length) % suggestItems.length;
      renderSuggest();
    }
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const picked = suggestItems[suggestActive]?.payload || null;
    finalizeMention(picked);
  } else if (
    e.key === 'Backspace' &&
    (mentionSpan?.textContent === '@' || mentionSpan?.textContent === '#')
  ) {
    e.preventDefault();
    cancelMention();
  }
});

window.addEventListener('resize', () => suggestVisible && positionPopover());
window.addEventListener('scroll', () => suggestVisible && positionPopover(), true);

// ── capture ────────────────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function captureCurrentTab() {
  setStatus('');
  saveResult.classList.add('hidden');
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus('No active tab.', 'err');
    return;
  }
  if (!LINKEDIN_THREAD_RE.test(tab.url || '')) {
    setStatus('Open a LinkedIn message thread first (URL must contain /messaging/thread/).', 'warn');
    return;
  }

  let result;
  try {
    const [{ result: r }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    result = r;
  } catch (e) {
    setStatus(`Could not inject content script: ${e.message}`, 'err');
    return;
  }

  if (!result?.messages?.length) {
    setStatus('No messages found on this page. Scroll the thread to load history, then try again.', 'warn');
    return;
  }

  captured = result;
  captureMeta.textContent = `${result.messages.length} message${
    result.messages.length === 1 ? '' : 's'
  } captured from “${result.threadTitle || 'thread'}”.`;
  captureMeta.classList.remove('hidden');
  previewEl.textContent = formatConversation(result);

  if (!titleEl.textContent.trim() && result.threadTitle) {
    titleEl.textContent = `LinkedIn chat — ${result.threadTitle}`;
  }
  if (!dateEl.value) dateEl.value = todayStr();

  formCard.classList.remove('hidden');
  setStatus(`Captured ${result.messages.length} messages.`, 'ok');
}

captureBtn.addEventListener('click', captureCurrentTab);

// ── save ──────────────────────────────────────────────────────────────────
async function saveToCrm() {
  if (saving) return;
  if (!captured) {
    setStatus('Capture the thread first.', 'warn');
    return;
  }
  const title = getTitleText();
  if (!title && !pendingCompany) {
    setStatus('Give the note a name or pick a #company.', 'warn');
    return;
  }
  const { crmUrl, internalToken } = await getSettings();
  if (!internalToken) {
    setStatus('Add your CRM internal token in settings.', 'err');
    return;
  }

  const conversation = formatConversation(captured);
  const bodyText =
    `Source: ${captured.url}\n` +
    `Captured: ${captured.capturedAt}\n\n` +
    conversation;

  const payload = {
    title: title || pendingCompany?.title || 'LinkedIn chat',
    body_text: bodyText,
    date: dateEl.value || todayStr(),
    source: 'linkedin-capture',
    source_subject: captured.threadTitle || null,
    external_id: captured.threadId ? `linkedin:${captured.threadId}` : null,
    companies: pendingCompany
      ? [{ slug: pendingCompany.slug, title: pendingCompany.title }]
      : [],
    attendees: pendingAttendees,
  };

  saving = true;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  setStatus('');
  try {
    const r = await fetch(`${crmUrl}/api/notes`, {
      method: 'POST',
      headers: {
        'X-Internal-Token': internalToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(`Save failed (HTTP ${r.status}): ${data?.detail || ''}`, 'err');
      return;
    }
    const matchedC = (data.matched_companies || []).filter((c) => c.company_id).length;
    const matchedP = (data.matched_people || []).filter((p) => p.person_id).length;
    saveResult.textContent =
      `${data.created ? 'Created' : 'Updated'} note ${data.id} · ` +
      `companies ${matchedC}/${data.matched_companies?.length || 0} matched · ` +
      `people ${matchedP}/${data.matched_people?.length || 0} matched · ` +
      `tasks ${data.tasks_created || 0}`;
    saveResult.classList.remove('hidden');
    setStatus(data.created ? 'Note created in CRM.' : 'Note updated in CRM.', 'ok');
  } catch (e) {
    setStatus(`Save error: ${e.message}`, 'err');
  } finally {
    saving = false;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Add note to CRM';
  }
}

saveBtn.addEventListener('click', saveToCrm);

// ── options link ──────────────────────────────────────────────────────────
openOpts.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── boot ───────────────────────────────────────────────────────────────────
(async function init() {
  dateEl.value = todayStr();
  const { internalToken } = await getSettings();
  if (!internalToken) {
    setStatus('Open settings and add your CRM internal token.', 'warn');
  } else {
    loadManifest(); // fire and forget; popover falls back to freeform
  }

  const tab = await getActiveTab();
  if (tab && !LINKEDIN_THREAD_RE.test(tab.url || '')) {
    captureMeta.textContent = 'Open a LinkedIn message thread to capture.';
    captureMeta.classList.remove('hidden');
  }
})();
