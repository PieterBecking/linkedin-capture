// LinkedIn → CRM side panel.
//
// 1. Capture the open LinkedIn thread (via chrome.scripting.executeScript).
// 2. Let the user name the meeting with #company / @person mentions (popover
//    powered by GET {CRM_URL}/api/manifest).
// 3. POST to {CRM_URL}/api/notes with X-Internal-Token auth.

const DEFAULT_CRM_URL = 'https://brain.servo7.com';
// The CRM moved from crm.becking.dev to brain.servo7.com. A stored legacy URL
// is treated as unset so existing installs migrate without an options visit.
const LEGACY_CRM_URL = 'https://crm.becking.dev';
// Matches both a normal thread (/messaging/thread/<id>/) and the compose
// overlay opened from a profile (/messaging/compose/?profileUrn=...&recipient=...).
const LINKEDIN_THREAD_RE =
  /^https:\/\/www\.linkedin\.com\/messaging\/(thread\/|compose[/?])/;

// Mode routing: /messaging/… keeps the chat-capture UI; /in/<slug> (any
// linkedin subdomain, trailing paths like /en, ?originalSubdomain=nl) gets
// the recruitment profile-export UI; anything else gets neither.
const LINKEDIN_MESSAGING_RE =
  /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\/messaging([/?#]|$)/i;
const LINKEDIN_PROFILE_RE =
  /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\/in\/[^/?#]+/i;

const DEFAULT_BRAIN_URL = 'https://brain.servo7.com';

// ── settings ────────────────────────────────────────────────────────────────
async function getSettings() {
  const { crmUrl, internalToken } = await chrome.storage.local.get([
    'crmUrl',
    'internalToken',
  ]);
  const stored = (crmUrl || '').replace(/\/+$/, '');
  return {
    crmUrl: !stored || stored === LEGACY_CRM_URL ? DEFAULT_CRM_URL : stored,
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

// Final note title: typed text plus the #company and @person pills,
// skipping names the user already typed into the title themselves.
function buildNoteTitle(typedTitle) {
  const base = typedTitle || 'LinkedIn chat';
  const lowerBase = base.toLowerCase();
  const parts = [base];
  if (pendingCompany?.title && !lowerBase.includes(pendingCompany.title.toLowerCase())) {
    parts.push(pendingCompany.title);
  }
  const people = pendingAttendees.filter(
    (n) => n && !lowerBase.includes(n.toLowerCase()),
  );
  if (people.length) parts.push(people.join(', '));
  return parts.join(' - ');
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

function namesFromThreadTitle(threadTitle) {
  if (!threadTitle) return [];
  return threadTitle
    .split(/,| and /i)
    .map((n) => n.trim())
    .filter((n) => n.length >= 2);
}

function resolvePersonCasing(rawName) {
  if (!manifest) return rawName;
  const target = rawName.toLowerCase();
  const pool = [
    ...(manifest.people_ranked || []),
    ...(manifest.team || []),
    ...(manifest.companies || []).flatMap((c) => (c.people || []).map((p) => p.name)),
  ];
  const hit = pool.find((n) => n && n.toLowerCase() === target);
  return hit || rawName;
}

function resetToHomescreen() {
  captured = null;
  pendingCompany = null;
  pendingAttendees = [];
  titleEl.textContent = '';
  dateEl.value = todayStr();
  previewEl.textContent = '';
  formCard.classList.add('hidden');
  captureMeta.classList.add('hidden');
  saveResult.classList.add('hidden');
  renderPills();
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
    popoverEl.innerHTML = '<div class="suggest-empty">No matches. Enter to use as-is</div>';
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
    setStatus('Open a LinkedIn message thread or compose overlay first (URL must contain /messaging/thread/ or /messaging/compose/).', 'warn');
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

  // Fresh start for every capture: drop any stale pills/title from a prior thread.
  pendingCompany = null;
  pendingAttendees = [];
  titleEl.textContent = '';
  saveResult.classList.add('hidden');

  captured = result;
  captureMeta.textContent = `${result.messages.length} message${
    result.messages.length === 1 ? '' : 's'
  } captured from “${result.threadTitle || 'thread'}”.`;
  captureMeta.classList.remove('hidden');
  previewEl.textContent = formatConversation(result);

  // Seed @person attendees from the thread title (1:1 = one name, group = N).
  namesFromThreadTitle(result.threadTitle).forEach((raw) => {
    const name = resolvePersonCasing(raw);
    if (name && !pendingAttendees.includes(name)) pendingAttendees.push(name);
  });
  renderPills();

  titleEl.textContent = 'LinkedIn chat';
  dateEl.value = todayStr();

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
    (captured.profileUrl ? `Profile: ${captured.profileUrl}\n` : '') +
    `Captured: ${captured.capturedAt}\n\n` +
    conversation;

  const payload = {
    title: buildNoteTitle(title),
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
    const summary =
      `${data.created ? 'Created' : 'Updated'} note ${data.id} · ` +
      `companies ${matchedC}/${data.matched_companies?.length || 0} matched · ` +
      `people ${matchedP}/${data.matched_people?.length || 0} matched · ` +
      `tasks ${data.tasks_created || 0}`;
    resetToHomescreen();
    setStatus(`${data.created ? 'Note created' : 'Note updated'}. ${summary}`, 'ok');
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

// ═══ profile mode (recruitment export) ══════════════════════════════════════
// Chat capture above is untouched. Everything below routes the panel between
// the two modes and drives the candidate export. All API calls go through the
// background worker ({ type: 'brainApi' }) — the server sends no CORS headers,
// and worker fetches are what carry the Brain session cookie. There is no
// extension-side credential: 401 means signed out of Brain, 403 means the
// signed-in account lacks the recruitment permission.

const captureCard       = document.getElementById('captureCard');
const profileCard       = document.getElementById('profileCard');
const profileNameEl     = document.getElementById('profileName');
const profileHeadlineEl = document.getElementById('profileHeadline');
const pipelineBanner    = document.getElementById('pipelineBanner');
const roleSelect        = document.getElementById('roleSelect');
const stageSelect       = document.getElementById('stageSelect');
const notesEl           = document.getElementById('candidateNotes');
const exportBtn         = document.getElementById('exportBtn');
const exportResult      = document.getElementById('exportResult');
const scrapeSummaryEl   = document.getElementById('scrapeSummary');
const rescanLink        = document.getElementById('rescanLink');

let currentMode = null; // 'chat' | 'profile' | 'none'
let profileState = {
  url: null,       // tab URL this state belongs to
  scraped: {},     // profile payload from profile.js
  roles: [],       // roles from the API (needed to send role_id in its original type)
  base: DEFAULT_BRAIN_URL,
  rolesReady: false,
  loading: false,
  exporting: false,
};

function brainApi(path, opts = {}) {
  return chrome.runtime
    .sendMessage({ type: 'brainApi', path, ...opts })
    .then((resp) => resp || { ok: false, status: 0, error: 'No response from background worker.' })
    .catch((e) => ({ ok: false, status: 0, error: e.message }));
}

async function getBrainBase() {
  const { extBaseUrl } = await chrome.storage.sync.get(['extBaseUrl']);
  return (extBaseUrl || DEFAULT_BRAIN_URL).replace(/\/+$/, '');
}

// Like setStatus, but with a clickable link in the middle of the message.
function setStatusLink(before, level, linkText, href, after) {
  statusEl.textContent = '';
  statusEl.appendChild(document.createTextNode(before));
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = linkText;
  statusEl.appendChild(a);
  if (after) statusEl.appendChild(document.createTextNode(after));
  statusEl.classList.remove('hidden', 'ok', 'err', 'warn');
  if (level) statusEl.classList.add(level);
}

// Shared error rendering for the recruitment API. 401 = signed out of Brain
// (a sign-in fixes it, nothing else does), 403 = missing recruitment
// permission, 400 = payload problem whose detail is shown verbatim.
function showApiError(prefix, resp) {
  if (resp?.status === 401) {
    setStatusLink(`${prefix}: you're signed out of Brain. `, 'err', 'Sign in to Brain', profileState.base, ' and retry.');
    return;
  }
  if (resp?.status === 403) {
    setStatus(`${prefix}: your Brain account doesn't have the recruitment permission.`, 'err');
    return;
  }
  const detail = resp?.data?.detail;
  const detailText =
    detail == null ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (resp?.status === 400 && detailText) {
    setStatus(`${prefix}: ${detailText}`, 'err');
    return;
  }
  setStatus(
    `${prefix}: ${resp?.error || `HTTP ${resp?.status ?? '?'}${detailText ? `: ${detailText}` : ''}`}`,
    'err',
  );
}

function detectMode(url) {
  if (LINKEDIN_PROFILE_RE.test(url || '')) return 'profile';
  if (LINKEDIN_MESSAGING_RE.test(url || '')) return 'chat';
  return 'none';
}

function applyModeVisibility(mode) {
  captureCard.classList.toggle('hidden', mode !== 'chat');
  profileCard.classList.toggle('hidden', mode !== 'profile');
  if (mode === 'chat') {
    if (captured) formCard.classList.remove('hidden');
  } else {
    formCard.classList.add('hidden');
  }
}

async function refreshMode() {
  const tab = await getActiveTab();
  const url = tab?.url || '';
  const mode = detectMode(url);
  const prevMode = currentMode;
  const modeChanged = mode !== prevMode;
  currentMode = mode;
  applyModeVisibility(mode);

  if (mode === 'none') {
    if (modeChanged) {
      setStatus(
        'Nothing to capture here. Open a LinkedIn message thread (/messaging/) or a profile (/in/<name>).',
        'warn',
      );
    }
    return;
  }
  // Clear stale mode-switch messages, but keep whatever init() just said.
  if (modeChanged && prevMode !== null) setStatus('');

  if (mode === 'chat') {
    if (modeChanged && !LINKEDIN_THREAD_RE.test(url)) {
      captureMeta.textContent =
        'Open a LinkedIn message thread or compose overlay to capture.';
      captureMeta.classList.remove('hidden');
    }
    return;
  }
  await initProfileMode(tab, url);
}

// ── profile scrape ─────────────────────────────────────────────────────────
async function scrapeProfile(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['profile.js'],
    });
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// One line of truth about what the scrape actually read, so a thin export
// is visible before it happens.
function scrapeSummaryText(p) {
  const flag = (label, v) => `${label} ${v ? '✓' : '—'}`;
  return [
    flag('bio', p.about),
    flag('role', p.current_title),
    `exp ${p.experience?.length || 0}`,
    `edu ${p.education?.length || 0}`,
    `skills ${p.skills?.length || 0}`,
  ].join(' · ');
}

function renderProfileHeader() {
  const p = profileState.scraped || {};
  const slug = (profileState.url || '').match(/\/in\/([^/?#]+)/)?.[1] || '';
  profileNameEl.textContent = p.name || decodeURIComponent(slug) || 'Unknown profile';
  profileHeadlineEl.textContent =
    p.headline ||
    [p.current_title, p.current_company].filter(Boolean).join(' @ ') ||
    '';
  scrapeSummaryEl.textContent = scrapeSummaryText(p);
}

async function rescanProfile(e) {
  e?.preventDefault();
  const tab = await getActiveTab();
  if (!tab?.id || (tab.url || '') !== profileState.url) return;
  scrapeSummaryEl.textContent = 'rescanning…';
  const result = await scrapeProfile(tab.id);
  if ((tab.url || '') !== profileState.url) return;
  profileState.scraped = result?.profile || {};
  renderProfileHeader();
  setStatus(result?.ok ? 'Profile rescanned.' : 'Rescan still found no name — is the profile fully loaded?', result?.ok ? 'ok' : 'warn');
}

rescanLink.addEventListener('click', rescanProfile);

// ── profile mode init ──────────────────────────────────────────────────────
async function initProfileMode(tab, url) {
  // Re-entrancy: skip when this URL is already loading or fully loaded, but
  // retry after a failed roles fetch (e.g. token added, tab revisited).
  if (profileState.url === url && (profileState.loading || profileState.rolesReady)) return;
  profileState = {
    url,
    scraped: {},
    roles: [],
    base: await getBrainBase(),
    rolesReady: false,
    loading: true,
    exporting: false,
  };

  profileNameEl.textContent = 'Loading profile…';
  profileHeadlineEl.textContent = '';
  scrapeSummaryEl.textContent = '';
  pipelineBanner.classList.add('hidden');
  pipelineBanner.textContent = '';
  exportBtn.disabled = true;
  exportBtn.classList.add('primary');
  exportResult.classList.add('hidden');
  exportResult.textContent = '';
  notesEl.value = '';
  roleSelect.innerHTML = '';
  roleSelect.appendChild(new Option('Loading roles…', ''));
  roleSelect.disabled = true;
  stageSelect.innerHTML = '';
  stageSelect.disabled = true;

  // Scrape and both API calls run in parallel. profile.js itself waits for
  // the profile to render (LinkedIn paints lazily / navigates as an SPA).
  const scrapeP = scrapeProfile(tab.id);
  const rolesP = brainApi('/api/extension/recruitment/roles');
  const lookupP = brainApi(
    '/api/extension/recruitment/candidates/lookup?linkedin_url=' + encodeURIComponent(url),
  );

  let scraped = await scrapeP;
  if (profileState.url !== url) return; // navigated away meanwhile
  if (!scraped?.ok) {
    // One more shot after a beat — the page may have finished rendering since.
    await new Promise((r) => setTimeout(r, 1500));
    if (profileState.url !== url) return;
    scraped = await scrapeProfile(tab.id);
    if (profileState.url !== url) return;
  }
  profileState.scraped = scraped?.profile || {};
  renderProfileHeader();
  if (!scraped?.ok) {
    setStatus(
      'Could not read a name off this profile — try “rescan” once the page has fully loaded. Export sends whatever was scraped.',
      'warn',
    );
  }

  const rolesResp = await rolesP;
  if (profileState.url !== url) return;
  renderRoles(rolesResp);

  const lookupResp = await lookupP;
  if (profileState.url !== url) return;
  renderLookup(lookupResp);
  profileState.loading = false;
}

// ── roles + stages ─────────────────────────────────────────────────────────
function normStage(s) {
  if (s == null) return null;
  if (typeof s === 'string') return { value: s, label: s };
  const value = s.value ?? s.id ?? s.key ?? s.stage ?? s.name;
  if (value == null) return null;
  const label = s.label ?? s.title ?? s.name ?? String(value);
  return { value, label };
}

function renderRoles(resp) {
  const data = resp?.data;
  if (!resp?.ok || !Array.isArray(data?.roles)) {
    // Never export against a stale role list: surface the error, disable.
    roleSelect.innerHTML = '';
    roleSelect.appendChild(new Option('Roles unavailable', ''));
    roleSelect.disabled = true;
    stageSelect.disabled = true;
    exportBtn.disabled = true;
    profileState.rolesReady = false;
    profileState.loading = false;
    showApiError('Could not load roles', resp);
    return;
  }

  profileState.roles = data.roles;
  roleSelect.innerHTML = '';
  roleSelect.disabled = false;

  const defaultId = data.default_role_id;
  const hasDefault =
    defaultId != null && data.roles.some((r) => String(r.id) === String(defaultId));
  if (!hasDefault) {
    // default_role_id null (or dangling): leave unselected, require a pick.
    roleSelect.appendChild(new Option('Select a role…', ''));
  }
  for (const r of data.roles) {
    const label = r.is_open === false ? `${r.title} (closed)` : r.title;
    roleSelect.appendChild(new Option(label, String(r.id)));
  }
  if (hasDefault) roleSelect.value = String(defaultId);

  const stages = (Array.isArray(data.stages) ? data.stages : [])
    .map(normStage)
    .filter(Boolean);
  const stageList = stages.length ? stages : [{ value: 'SOURCED', label: 'SOURCED' }];
  stageSelect.innerHTML = '';
  stageSelect.disabled = false;
  for (const s of stageList) stageSelect.appendChild(new Option(s.label, String(s.value)));
  const sourced = stageList.find((s) => String(s.value).toUpperCase() === 'SOURCED');
  if (sourced) stageSelect.value = String(sourced.value);

  exportBtn.disabled = false;
  profileState.rolesReady = true;
}

// ── pipeline lookup banner ─────────────────────────────────────────────────
function renderLookup(resp) {
  if (!resp?.ok || !resp.data?.found) return; // not found / lookup failed: keep primary flow
  const apps = Array.isArray(resp.data.applications) ? resp.data.applications : [];

  pipelineBanner.textContent = '';
  apps.forEach((app, i) => {
    if (i > 0) pipelineBanner.appendChild(document.createTextNode(' · '));
    const stage = app.stage_label ?? app.stage ?? '?';
    const role = app.role_title ?? app.role?.title ?? (typeof app.role === 'string' ? app.role : '?');
    const text = `already in pipeline — ${stage} for ${role}`;
    if (app.url) {
      const a = document.createElement('a');
      a.href = /^https?:/.test(app.url) ? app.url : profileState.base + app.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = text;
      pipelineBanner.appendChild(a);
    } else {
      pipelineBanner.appendChild(document.createTextNode(text));
    }
  });
  if (!apps.length) pipelineBanner.textContent = 'Already in pipeline.';
  pipelineBanner.classList.remove('hidden');
  exportBtn.classList.remove('primary'); // demote: re-export is the secondary action
}

// ── export ─────────────────────────────────────────────────────────────────
async function exportToPipeline() {
  if (profileState.exporting) return;
  const roleValue = roleSelect.value;
  if (!roleValue) {
    setStatus('Pick a role first.', 'warn');
    return;
  }
  const role = profileState.roles.find((r) => String(r.id) === roleValue);
  const stage = stageSelect.value;
  const notes = notesEl.value.trim();

  // Full scrape payload: mapped columns + everything else as extra top-level
  // keys, stored verbatim server-side. linkedin_url goes as-is.
  const body = {
    ...profileState.scraped,
    linkedin_url: profileState.scraped.linkedin_url || profileState.url,
    role_id: role ? role.id : roleValue,
    stage,
  };
  if (notes) body.notes = notes;

  profileState.exporting = true;
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  exportResult.classList.add('hidden');
  setStatus('');
  try {
    const resp = await brainApi('/api/extension/recruitment/candidates', {
      method: 'POST',
      body,
    });
    if (!resp.ok) {
      showApiError('Export failed', resp);
      return;
    }

    const d = resp.data || {};
    const name = d.name || profileState.scraped.name || 'Candidate';
    const roleTitle = role?.title || roleSelect.selectedOptions[0]?.textContent || '';
    const stageLabel = stageSelect.selectedOptions[0]?.textContent || stage;

    exportResult.textContent = '';
    exportResult.appendChild(
      document.createTextNode(`${name} — ${roleTitle} · ${stageLabel} `),
    );
    if (d.url) {
      const a = document.createElement('a');
      a.href = /^https?:/.test(d.url) ? d.url : profileState.base + d.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = 'View candidate';
      exportResult.appendChild(a);
    }
    exportResult.classList.remove('hidden');
    setStatus(
      d.already_in_pipeline
        ? 'Candidate was already in the pipeline — details refreshed.'
        : 'Candidate added to the pipeline.',
      'ok',
    );

    // Refresh the banner so the panel reflects the new pipeline state.
    const lookup = await brainApi(
      '/api/extension/recruitment/candidates/lookup?linkedin_url=' +
        encodeURIComponent(profileState.url),
    );
    renderLookup(lookup);
  } finally {
    profileState.exporting = false;
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export to pipeline';
  }
}

exportBtn.addEventListener('click', exportToPipeline);

// Re-route when the user switches tabs or the SPA changes the URL.
chrome.tabs.onActivated.addListener(() => refreshMode());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab?.active && (changeInfo.url || changeInfo.status === 'complete')) refreshMode();
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

  await refreshMode();
})();
