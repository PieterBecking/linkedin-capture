// Scrapes the open LinkedIn message thread. Idempotent — safe to inject
// multiple times via chrome.scripting.executeScript.
(() => {
  function txt(el) {
    return (el?.innerText || el?.textContent || '').trim();
  }

  function threadIdFromUrl() {
    const m = location.pathname.match(/\/messaging\/thread\/([^/]+)\/?/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function findThreadTitle() {
    // The thread header is the participant name/group title.
    const sel = [
      'h2.msg-entity-lockup__entity-title',
      '.msg-thread__link-to-profile',
      '.msg-overlay-bubble-header__title',
      'header h2',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      const t = txt(el);
      if (t) return t;
    }
    return null;
  }

  function scrapeMessages() {
    const list =
      document.querySelector('.msg-s-message-list-content') ||
      document.querySelector('.msg-s-message-list') ||
      document.querySelector('ul.msg-s-message-list-content');
    if (!list) return [];

    const out = [];
    let currentSender = null;
    let currentTime = null;

    list.querySelectorAll('li, .msg-s-message-list__event').forEach((item) => {
      const nameEl = item.querySelector(
        '.msg-s-message-group__name, .msg-s-message-group__profile-link',
      );
      if (nameEl) currentSender = txt(nameEl);

      const timeEl = item.querySelector('time, .msg-s-message-group__timestamp');
      if (timeEl) {
        currentTime = timeEl.getAttribute('datetime') || txt(timeEl);
      }

      const bodyEl = item.querySelector(
        '.msg-s-event-listitem__body, [class*="event-listitem__body"]',
      );
      const body = txt(bodyEl);
      if (body) {
        out.push({
          sender: currentSender || 'Unknown',
          text: body,
          timestamp: currentTime || null,
        });
      }
    });

    return out;
  }

  const messages = scrapeMessages();
  return {
    ok: messages.length > 0,
    url: location.href,
    threadId: threadIdFromUrl(),
    threadTitle: findThreadTitle(),
    capturedAt: new Date().toISOString(),
    messages,
  };
})();
