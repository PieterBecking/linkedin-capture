// Drafts stay in this panel. Only the Copy button writes to the clipboard.
(() => {
  const el = (id) => document.getElementById(id);
  const card = el('replyCard');
  const contextEl = el('replyContext');
  const status = el('replyStatus');
  const source = el('replySource');
  const sourceText = el('replySourceText');
  const kindEl = el('replyKind');
  const draftEl = el('replyDraft');
  const copyBtn = el('copyReplyBtn');
  const resetBtn = el('resetReplyBtn');
  const readBtn = el('readReplyBtn');
  const drafts = new Map();
  let target = null;
  let generation = 0;
  let reading = false;
  let state = null;
  let savedTemplates = {};
  let previousFingerprint = '';
  let pollTimer;

  const fingerprint = (thread) => JSON.stringify([
    thread.threadTitle, thread.viewerName, thread.isGroup, thread.messages,
  ]);
  const keyFor = (tab) => `${tab.id}:${tab.url}`;
  const activeTarget = (tab) => target && tab?.id === target.id && tab.url === target.url;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('reply-error', error);
  }

  function updateButtons() {
    const ready = !!state?.thread;
    kindEl.disabled = !ready;
    draftEl.disabled = !ready;
    resetBtn.disabled = !ready || !kindEl.value;
    copyBtn.disabled = !ready || !draftEl.value.trim();
  }

  function render() {
    const analysis = state?.analysis;
    contextEl.textContent = analysis?.sender ? `Reply to ${analysis.sender}` : 'Reply to this conversation';
    kindEl.value = state?.kind || '';
    draftEl.value = state?.draft || '';
    source.classList.toggle('hidden', !analysis?.message);
    sourceText.textContent = analysis?.message || '';
    updateButtons();
  }

  function explain() {
    const a = state?.analysis;
    if (!a) return;
    if (state.edited) message('Your edited draft is kept for this conversation.');
    else if (a.kind) message(`${ReplyTemplates.labels[a.kind]} outreach detected. Review your reply below.`);
    else if (a.reason === 'replied') message('You sent the latest message. Choose a reply type if you want to follow up.');
    else if (a.reason === 'group') message('Could not confirm a one-to-one conversation. Choose a reply type to draft manually.');
    else if (a.reason === 'unknown-sender') message('Could not identify the sender. Choose a reply type and check the greeting.');
    else message('No clear match. Choose a reply type to use your saved wording.');
  }

  async function read() {
    if (!target || reading || document.hidden) return;
    const token = generation;
    reading = true;
    readBtn.disabled = true;
    try {
      const [before] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (token !== generation || !activeTarget(before)) return;
      const [{ result: thread } = {}] = await chrome.scripting.executeScript({
        target: { tabId: target.id }, files: ['thread-reader.js'],
      });
      const [after] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (token !== generation || !activeTarget(after) || thread?.url !== target.url) return;
      if (!thread?.ok) {
        // Disable an old draft if the conversation disappears or is still loading.
        state = null;
        render();
        message('Open a conversation and wait for its messages to load, then click Read again.');
        return;
      }
      const nextFingerprint = fingerprint(thread);
      // LinkedIn can update its URL before painting the next conversation.
      if (previousFingerprint && nextFingerprint === previousFingerprint) {
        message('Waiting for the selected conversation to load…');
        return;
      }
      previousFingerprint = '';
      if (state?.fingerprint === nextFingerprint) return;
      const analysis = ReplyTemplates.analyze(thread);
      // The inbox can replace the selected conversation without changing its
      // URL. Never carry a draft across different participant headers.
      const conversationKey = `${keyFor(target)}:${thread.threadTitle || ''}`;
      const cached = state?.conversationKey === conversationKey ? state : drafts.get(conversationKey);
      const keepEdits = cached?.edited;
      state = {
        thread, analysis, fingerprint: nextFingerprint, conversationKey,
        kind: keepEdits ? cached.kind : analysis.kind || '',
        draft: keepEdits ? cached.draft : ReplyTemplates.draft(analysis.kind, analysis.sender, savedTemplates),
        edited: !!keepEdits,
      };
      drafts.set(conversationKey, state);
      // Bound memory while retaining recent edits when switching conversations.
      if (drafts.size > 30) drafts.delete(drafts.keys().next().value);
      render();
      if (keepEdits && cached.fingerprint !== nextFingerprint) {
        message('The conversation changed. Your edits are kept; review the latest message or use Reset draft.');
      } else explain();
    } catch {
      if (token !== generation) return;
      state = null;
      render();
      message('Could not read this conversation. Refresh LinkedIn, then click Read again.', true);
    } finally {
      reading = false;
      readBtn.disabled = false;
      clearTimeout(pollTimer);
      if (target) pollTimer = setTimeout(read, 2000);
    }
  }

  function setTab(tab, enabled) {
    const next = enabled && tab?.id ? { id: tab.id, url: tab.url } : null;
    card.classList.toggle('hidden', !next);
    if (next && target && keyFor(next) === keyFor(target)) return;
    const oldTarget = target;
    const oldFingerprint = state?.fingerprint;
    generation++;
    target = next;
    state = null;
    previousFingerprint = oldTarget?.id === next?.id && oldTarget?.url !== next?.url ? oldFingerprint || '' : '';
    clearTimeout(pollTimer);
    render();
    message('Reading the open conversation…');
    if (target) read();
  }

  function generate() {
    if (!state) return;
    state.kind = kindEl.value;
    state.draft = ReplyTemplates.draft(state.kind, state.analysis.sender, savedTemplates);
    state.edited = true; // Explicit choices survive automatic refreshes.
    render();
    message('Draft ready. You can edit it before copying.');
  }

  kindEl.addEventListener('change', generate);
  resetBtn.addEventListener('click', generate);
  readBtn.addEventListener('click', () => { clearTimeout(pollTimer); read(); });
  draftEl.addEventListener('input', () => {
    if (!state) return;
    state.draft = draftEl.value;
    state.edited = true;
    message('Draft edited.');
    updateButtons();
  });
  copyBtn.addEventListener('click', async () => {
    const text = draftEl.value.trim();
    if (!state || !text) return;
    const token = generation;
    try {
      await navigator.clipboard.writeText(text);
      if (token === generation) message('Copied. Paste it into LinkedIn when you’re ready.');
    } catch {
      if (token !== generation) return;
      draftEl.focus();
      draftEl.select();
      message('Copy was blocked. Your draft is selected; press ⌘C or Ctrl+C to copy.', true);
    }
  });
  el('replySettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) read();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.replyTemplates) {
      savedTemplates = changes.replyTemplates.newValue || {};
      if (state && !state.edited) {
        state.draft = ReplyTemplates.draft(state.kind, state.analysis.sender, savedTemplates);
        render();
      }
    }
  });
  const ready = chrome.storage.local.get('replyTemplates').then((stored) => {
    savedTemplates = stored.replyTemplates || {};
  }).catch(() => {});
  globalThis.ReplyPanel = { setTab: async (tab, enabled) => { await ready; setTab(tab, enabled); } };
})();
