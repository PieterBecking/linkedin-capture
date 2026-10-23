// Shared, read-only DOM snapshot for reply suggestions and CRM capture.
// The final expression is returned by chrome.scripting.executeScript.
(() => {
  const txt = (el) => (el?.innerText || el?.textContent || '').trim();
  const visible = (el) => el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden';
  const headerSelector = 'h2.msg-entity-lockup__entity-title, .msg-thread__link-to-profile, .msg-overlay-bubble-header__title';

  function findThread() {
    const lists = [...document.querySelectorAll('.msg-s-message-list-content, .msg-s-message-list')]
      .filter(visible)
      .filter((el) => !el.querySelector('.msg-s-message-list-content'));
    // Ignore floating chats when the main messaging conversation is open.
    const main = lists.filter((el) => !el.closest('.msg-overlay-conversation-bubble'));
    const candidates = main.length ? main : lists;
    if (candidates.length !== 1) return { root: null, list: null };
    const list = candidates[0];
    const containers = [list.closest('.msg-thread'), list.closest('.msg-convo-wrapper'),
      list.closest('.msg-overlay-conversation-bubble'), list.closest('main')].filter(Boolean);
    // On some builds the header is a sibling of .msg-thread, inside its wrapper.
    const root = containers.find((el) => el.querySelector(headerSelector)) || containers[0];
    return { root, list: root ? list : null };
  }

  function read() {
    const { root, list } = findThread();
    const header = root?.querySelector(headerSelector);
    const threadTitle = txt(header) || null;
    const viewerName = document.querySelector(
      '.global-nav__me-photo[alt], .global-nav__me img[alt]',
    )?.getAttribute('alt')?.trim() || null;
    const messages = [];
    const seen = new Set();
    let sender = null;
    let timestamp = null;
    let isOutgoing = false;
    // Some builds nest event items in group <li>s. Track body nodes to avoid
    // reading the first message twice while retaining grouped sender metadata.
    list?.querySelectorAll('li, .msg-s-message-list__event').forEach((item) => {
      const nameEl = item.querySelector('.msg-s-message-group__name, .msg-s-message-group__profile-link');
      if (nameEl && txt(nameEl)) {
        sender = txt(nameEl);
        isOutgoing = !!item.closest('.msg-s-message-group--me, .msg-s-message-group--self')
          || !!item.querySelector('.msg-s-message-group--me, .msg-s-message-group--self');
      }
      const timeEl = item.querySelector('time, .msg-s-message-group__timestamp');
      if (timeEl) timestamp = timeEl.getAttribute('datetime') || txt(timeEl);
      const bodyEl = item.querySelector('.msg-s-event-listitem__body, [class*="event-listitem__body"]');
      if (!bodyEl || seen.has(bodyEl)) return;
      seen.add(bodyEl);
      const body = txt(bodyEl);
      if (body) messages.push({ sender: sender || 'Unknown', text: body, timestamp, isOutgoing });
    });
    const match = location.pathname.match(/\/messaging\/thread\/([^/]+)/);
    const params = new URLSearchParams(location.search);
    const recipient = params.get('recipient') || params.get('profileUrn')?.split(':').pop();
    const threadId = match ? decodeURIComponent(match[1])
      : /\/messaging\/compose\b/.test(location.pathname) && recipient ? `compose:${recipient}` : null;
    return {
      ok: messages.length > 0,
      url: location.href,
      threadId,
      threadTitle,
      viewerName,
      isGroup: !!root?.querySelector('.msg-thread__group-info, .msg-thread__group-title'),
      capturedAt: new Date().toISOString(),
      messages,
    };
  }

  globalThis.LinkedInThreadReader = { read, findThread };
  return read();
})();
