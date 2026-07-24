// Scrapes the open LinkedIn message thread. Idempotent: safe to inject
// multiple times via chrome.scripting.executeScript.
(async () => {
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

  function normalizeProfileHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/in\/([^/]+)/);
      if (!m) return null;
      return { url: u.origin + u.pathname, slug: decodeURIComponent(m[1]) };
    } catch {
      return null;
    }
  }

  // LinkedIn's messaging header links to /in/ACoAA... (the internal member
  // id), not the public vanity slug. Detect those so we can resolve them.
  function isMemberIdSlug(slug) {
    return /^ACoAA/i.test(slug);
  }

  function findProfileCandidates(threadTitle) {
    const out = [];
    const push = (href) => {
      const p = normalizeProfileHref(href);
      if (p && !out.some((o) => o.url === p.url)) out.push(p);
    };

    // 1:1 threads: the header links to the counterparty's profile.
    [
      'a.msg-thread__link-to-profile',
      '.msg-thread__link-to-profile',
      '.msg-entity-lockup a[href*="/in/"]',
      '.msg-title-bar a[href*="/in/"]',
      '.msg-overlay-bubble-header a[href*="/in/"]',
    ].forEach((s) => push(document.querySelector(s)?.getAttribute('href')));

    // Message-group sender links sometimes carry the vanity URL. Only take
    // the counterparty's (name matches the thread title), never our own.
    if (threadTitle) {
      document
        .querySelectorAll('a.msg-s-message-group__profile-link, .msg-s-message-group__profile-link a')
        .forEach((a) => {
          if (txt(a).includes(threadTitle)) push(a.getAttribute('href'));
        });
    }
    return out;
  }

  // /in/ACoAA... redirects (or points via its canonical tag) to the public
  // /in/<vanity-slug>/ URL. Same-origin fetch, so the session cookie rides along.
  async function resolveVanityUrl(memberIdUrl) {
    try {
      const r = await fetch(memberIdUrl, { redirect: 'follow' });
      const final = normalizeProfileHref(r.url);
      if (final && !isMemberIdSlug(final.slug)) return final.url;
      const html = await r.text();
      const m =
        html.match(/rel="canonical"\s+href="(https:\/\/www\.linkedin\.com\/in\/[^"]+)"/) ||
        html.match(/"canonicalUrl":"(https:\/\/www\.linkedin\.com\/in\/[^"]+)"/);
      const canon = m && normalizeProfileHref(m[1]);
      if (canon && !isMemberIdSlug(canon.slug)) return canon.url;
    } catch {
      /* network hiccup: caller falls back to the member-id URL */
    }
    return null;
  }

  async function findProfileUrl(threadTitle) {
    const candidates = findProfileCandidates(threadTitle);
    const vanity = candidates.find((c) => !isMemberIdSlug(c.slug));
    if (vanity) return vanity.url;
    const first = candidates[0];
    if (!first) return null;
    return (await resolveVanityUrl(first.url)) || first.url;
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
  const threadTitle = findThreadTitle();
  return {
    ok: messages.length > 0,
    url: location.href,
    threadId: threadIdFromUrl(),
    threadTitle,
    profileUrl: await findProfileUrl(threadTitle),
    capturedAt: new Date().toISOString(),
    messages,
  };
})();
