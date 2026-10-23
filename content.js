// Scrapes the open LinkedIn message thread. Idempotent: safe to inject
// multiple times via chrome.scripting.executeScript, after thread-reader.js.
(async () => {
  function txt(el) {
    return (el?.innerText || el?.textContent || '').trim();
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
    const { root } = globalThis.LinkedInThreadReader.findThread();
    if (!root) return [];
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
    ].forEach((s) => push(root.querySelector(s)?.getAttribute('href')));

    // Message-group sender links sometimes carry the vanity URL. Only take
    // the counterparty's (name matches the thread title), never our own.
    if (threadTitle) {
      root
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

  const snapshot = globalThis.LinkedInThreadReader.read();
  const profileUrl = await findProfileUrl(snapshot.threadTitle);
  return { ...snapshot, profileUrl };
})();
