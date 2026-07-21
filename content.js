// Scrapes the open LinkedIn message thread. Idempotent: safe to inject
// multiple times via chrome.scripting.executeScript.
(() => {
  function txt(el) {
    return (el?.innerText || el?.textContent || '').trim();
  }

  function threadIdFromUrl() {
    // Normal thread: /messaging/thread/<id>/
    const m = location.pathname.match(/\/messaging\/thread\/([^/]+)\/?/);
    if (m) return decodeURIComponent(m[1]);

    // Compose overlay opened from a profile: /messaging/compose/?recipient=...
    // No thread id exists yet, so key off the recipient (fsd_profile id) so the
    // CRM upsert (external_id = linkedin:<threadId>) stays stable per person.
    if (/\/messaging\/compose\b/.test(location.pathname)) {
      const params = new URLSearchParams(location.search);
      const recipient = params.get('recipient');
      if (recipient) return `compose:${recipient}`;
      const urn = params.get('profileUrn'); // urn:li:fsd_profile:ACoAA...
      if (urn) {
        const id = urn.split(':').pop();
        if (id) return `compose:${id}`;
      }
    }
    return null;
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

  function findProfileUrl() {
    // 1:1 threads: the header links to the counterparty's profile.
    const sel = [
      'a.msg-thread__link-to-profile',
      '.msg-thread__link-to-profile',
      '.msg-entity-lockup a[href*="/in/"]',
      '.msg-title-bar a[href*="/in/"]',
      '.msg-overlay-bubble-header a[href*="/in/"]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      const href = el?.getAttribute('href');
      if (!href) continue;
      try {
        const u = new URL(href, location.origin);
        if (/\/in\//.test(u.pathname)) return u.origin + u.pathname;
      } catch {
        /* ignore malformed hrefs */
      }
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
    profileUrl: findProfileUrl(),
    capturedAt: new Date().toISOString(),
    messages,
  };
})();
