// Scrapes the expanded candidate panel on app.juicebox.ai for the recruitment
// export. Injected on demand via chrome.scripting.executeScript — the async
// IIFE result is the scrape payload. Idempotent; safe to inject repeatedly.
// Returns the same { ok, profile, debug } contract as profile.js so the side
// panel treats both sources identically.
//
// The page is a search-results list (many candidates) plus one expanded detail
// panel (?contact=<id>&expanded=true). IDENTITY SAFETY: every read is scoped
// to that panel — found by walking UP from the [data-tour-id=
// "search.profile-detail"] marker to the first ancestor that also contains the
// header's LinkedIn anchor. The walk stops before document.body: if no panel
// ancestor qualifies, we return nothing rather than risk reading a list row.
//
// Juicebox's utility classes (css-l3f8vc etc.) are build hashes and will rot;
// the anchors used here are aria-labels, data-tour-id, id="exp<N>"/"edu<N>",
// and inline styles (font-weight: 500 = entity title) which are part of the
// rendering logic and churn less. Every read is wrapped so churn yields a
// missing key, never a thrown error.
(async () => {
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  const clean = (s) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t || undefined;
  };

  const strip = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  };

  const uniq = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = typeof x === 'string' ? x.toLowerCase() : JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // ── locate the expanded candidate panel ────────────────────────────────────
  const LINKEDIN_A = 'a[href*="linkedin.com/in/"]';

  function panelFrom(marker) {
    let el = marker;
    while (el && el !== document.body) {
      if (safe(() => el.querySelector(LINKEDIN_A))) return el;
      el = el.parentElement;
    }
    return null; // reached the page shell — refuse rather than scrape list rows
  }

  const findPanel = () =>
    panelFrom(safe(() => document.querySelector('[data-tour-id="search.profile-detail"]'))) ||
    panelFrom(safe(() => document.querySelector('div.experience[aria-label="Experience"]')));

  // The panel renders lazily after the contact is expanded; wait for it to
  // carry both the LinkedIn anchor and a name before scraping.
  const nameIn = (panel) =>
    clean(safe(() => panel.querySelector('span.font-medium.truncate')?.textContent));

  const waitFor = async (fn, timeoutMs, stepMs = 300) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = safe(fn);
      if (v) return v;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };

  const panel = await waitFor(() => {
    const p = findPanel();
    return p && nameIn(p) ? p : undefined;
  }, 4000);

  if (!panel) {
    return {
      ok: false,
      profile: {},
      debug: {
        source: 'juicebox',
        panel: false,
        marker: !!safe(() => document.querySelector('[data-tour-id="search.profile-detail"]')),
        title: (clean(document.title) || '').slice(0, 60),
      },
    };
  }

  const q = (sel) => safe(() => panel.querySelector(sel));
  const qa = (sel) => safe(() => [...panel.querySelectorAll(sel)]) || [];

  // ── header: name, linkedin url, location, current company ────────────────
  const name = nameIn(panel);
  const linkedin_url = clean(q(LINKEDIN_A)?.href);
  const personLocation = clean(q('span[aria-label^="Location:"]')?.textContent);
  const headerCompany = clean(q('[aria-label^="Company:"]')?.textContent);

  let first_name;
  let last_name;
  if (name && name.includes(' ')) {
    const parts = name.split(' ');
    first_name = parts[0];
    last_name = parts.slice(1).join(' ');
  }

  // ── shared entity readers ─────────────────────────────────────────────────
  // Entity titles carry inline font-weight: 500; secondary lines 400; the
  // muted location line uses color rgb(107, 114, 128).
  const entityTitle = (el) =>
    clean(safe(() => el.querySelector('span[style*="font-weight: 500"]')?.textContent));
  const entitySub = (el) =>
    clean(safe(() => el.querySelector('span[style*="font-weight: 400"]')?.textContent));
  const entityLocation = (el) =>
    clean(safe(() => el.querySelector('span[style*="rgb(107, 114, 128)"]')?.textContent));
  // Descriptions render three copies (visible clamped + two hidden measuring
  // divs); take the one that isn't visibility: hidden.
  const entityDescription = (el) =>
    clean(
      safe(() =>
        [...el.querySelectorAll('div[style*="-webkit-line-clamp"]')].find(
          (d) => !(d.getAttribute('style') || '').includes('visibility: hidden'),
        )?.textContent,
      ),
    );

  const looksLikeDates = (s) => /\b(19|20)\d{2}\b|present/i.test(s || '');

  // ── experience ────────────────────────────────────────────────────────────
  const experience = uniq(
    qa('[id^="exp"][aria-label^="Experience at"]')
      .map((item) =>
        safe(() => {
          const title = entityTitle(item);
          if (!title) return null;
          const grays = [...item.querySelectorAll('span.text-gray-500')]
            .map((s) => clean(s.textContent))
            .filter(Boolean);
          return strip({
            title,
            company: entitySub(item),
            date_range: grays.find(looksLikeDates),
            location: entityLocation(item),
            description: entityDescription(item),
          });
        }),
      )
      .filter(Boolean),
  );

  // ── education ─────────────────────────────────────────────────────────────
  const education = uniq(
    qa('[id^="edu"]')
      .map((item) =>
        safe(() => {
          const school = entityTitle(item);
          if (!school) return null;
          // "Master of Science, Mechanical Engineering" → degree + field.
          const sub =
            clean(item.querySelector('span[style*="font-size: 13px"]')?.textContent) || '';
          const [degree, ...rest] = sub.split(', ');
          const grays = [...item.querySelectorAll('span.text-gray-500')]
            .map((s) => clean(s.textContent))
            .filter(Boolean);
          return strip({
            school,
            degree: clean(degree),
            field: clean(rest.join(', ')),
            date_range: grays.find(looksLikeDates),
            description: entityDescription(item),
          });
        }),
      )
      .filter(Boolean),
  );

  // ── skills ────────────────────────────────────────────────────────────────
  // Skill chips are buttons with an inner span; the "+11" expander button has
  // bare text and no span, so it self-excludes.
  const skills = uniq(
    qa('.skill-map button span')
      .map((s) => clean(s.textContent))
      .filter((t) => t && !/^\+\d+$/.test(t)),
  );

  // ── juicebox extras: criteria match + tenure stats ────────────────────────
  const critHeader = qa('span').find((s) =>
    /criteria\s*·\s*\d+%\s*match/i.test(s.textContent || ''),
  );
  const juicebox_match = clean(critHeader?.textContent);
  const juicebox_criteria = uniq(
    (safe(() => [
      ...critHeader.closest('.rounded-lg').querySelectorAll('button[aria-label]'),
    ]) || [])
      .map((b) => clean(b.getAttribute('aria-label')))
      .filter(Boolean),
  );

  const stat = (label) =>
    clean(
      safe(
        () =>
          q(`span[aria-label="${label}"]`)?.parentElement?.querySelector('span.font-medium')
            ?.textContent,
      ),
    );
  const total_experience = stat('Total experience');

  // ── current role ──────────────────────────────────────────────────────────
  const top = experience[0];
  const isCurrent = top && /present/i.test(top.date_range || '');

  const profile = strip({
    name,
    first_name,
    last_name,
    linkedin_url,
    location: personLocation,
    current_title: isCurrent ? top.title : undefined,
    current_company: (isCurrent ? top.company : undefined) ?? headerCompany,
    experience,
    education,
    skills,
    total_experience,
    juicebox_match,
    juicebox_criteria,
    juicebox_url: window.location.href,
    scrape_source: 'juicebox',
    captured_at: new Date().toISOString(),
  });

  const debug = {
    source: 'juicebox',
    nameSource: name ? 'panel' : 'none',
    panel: true,
    linkedin: !!linkedin_url,
    exp: experience.length,
    edu: education.length,
    skills: skills.length,
    title: (clean(document.title) || '').slice(0, 60),
  };

  return { ok: !!name, profile, debug };
})();
