// Scrapes the open LinkedIn profile page (/in/<slug>) for the recruitment
// export. Injected on demand via chrome.scripting.executeScript — the async
// IIFE result is the scrape payload. Idempotent; safe to inject repeatedly.
//
// Three sources, merged best-first:
//  1. LinkedIn's own Voyager REST API, called same-origin with the user's
//     session (csrf token from the JSESSIONID cookie) — the same call the
//     page itself makes. Authoritative and immune to DOM churn.
//  2. The Voyager JSON payloads embedded in <code> elements. NOTE: LinkedIn
//     wraps these in HTML comments, so they must be read off comment nodes —
//     textContent is empty.
//  3. The visible DOM. Carries render-only signals (open-to-work, connection
//     degree, followers, mutuals, avatar) plus a fallback for everything else.
//
// Every read is wrapped so a change on LinkedIn's side yields a missing key,
// never a thrown error that kills the export. Values that can't be read are
// omitted, not guessed. Returns { ok, profile, debug } — debug says which
// layers produced data, for the day all of this rots.
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

  const vis = (el) => {
    if (!el) return undefined;
    const a = safe(() => el.querySelector(':scope span[aria-hidden="true"]'));
    return clean(a?.textContent) ?? clean(el.textContent);
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

  const slug = safe(() =>
    decodeURIComponent(location.pathname.match(/\/in\/([^/?#]+)/)[1]),
  );

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) =>
    d && (d.year || d.month)
      ? [d.month ? MONTHS[d.month - 1] : null, d.year].filter(Boolean).join(' ')
      : null;
  // Legacy entities use timePeriod{startDate,endDate}; dash uses dateRange{start,end}.
  const period = (e) => e?.dateRange || e?.timePeriod;
  const fmtRange = (e) => {
    const tp = period(e);
    if (!tp) return undefined;
    const start = fmtDate(tp.start || tp.startDate);
    if (!start) return undefined;
    return `${start} – ${fmtDate(tp.end || tp.endDate) || 'Present'}`;
  };
  const startKey = (e) => {
    const s = period(e)?.start || period(e)?.startDate || {};
    return (s.year || 0) * 12 + (s.month || 0);
  };

  const vectorImg = (pic) => {
    const v = pic?.['com.linkedin.common.VectorImage'] || pic;
    if (!v?.rootUrl || !Array.isArray(v.artifacts) || !v.artifacts.length) return undefined;
    const a = v.artifacts[v.artifacts.length - 1];
    return clean(v.rootUrl + (a.fileIdentifyingUrlPathSegment || ''));
  };

  // ── shared entity parser (API + embedded payloads) ────────────────────────
  const isType = (e, suffix) =>
    typeof e?.$type === 'string' && e.$type.endsWith(suffix);

  function parseIncluded(included, requireSlugMatch) {
    if (!Array.isArray(included) || !included.length) return {};

    // The person: a full Profile entity, or a MiniProfile carrying the slug.
    const mini = included.find((e) => e?.publicIdentifier === slug);
    let prof = included.find(
      (e) =>
        isType(e, '.identity.profile.Profile') &&
        (e.firstName || e.lastName || e.summary) &&
        (!requireSlugMatch || e.publicIdentifier === slug || !e.publicIdentifier),
    );
    // Embedded payloads can hold several people's entities; only trust a
    // profile that the slug vouches for.
    if (requireSlugMatch && !mini && !prof?.publicIdentifier) prof = undefined;
    const me = { ...(prof || {}), ...(mini || {}) };

    const experience = uniq(
      included
        .filter((e) => isType(e, '.profile.Position') && e.title)
        .sort((a, b) => startKey(b) - startKey(a))
        .map((e) =>
          strip({
            title: clean(e.title),
            company: clean(e.companyName),
            date_range: fmtRange(e),
            location: clean(e.locationName || e.geoLocationName),
            description: clean(e.description),
          }),
        ),
    );

    const education = uniq(
      included
        .filter((e) => isType(e, '.profile.Education') && e.schoolName)
        .sort((a, b) => startKey(b) - startKey(a))
        .map((e) =>
          strip({
            school: clean(e.schoolName),
            degree: clean(e.degreeName),
            field: clean(e.fieldOfStudy),
            date_range: fmtRange(e),
          }),
        ),
    );

    const skills = uniq(
      included
        .filter((e) => isType(e, '.profile.Skill'))
        .map((e) => clean(e.name))
        .filter(Boolean),
    );

    const languages = uniq(
      included
        .filter((e) => isType(e, '.profile.Language') && e.name)
        .map((e) => {
          const prof2 = clean((e.proficiency || '').toLowerCase().replace(/_/g, ' '));
          return prof2 ? `${clean(e.name)} — ${prof2}` : clean(e.name);
        }),
    );

    const certifications = uniq(
      included
        .filter((e) => isType(e, '.profile.Certification') && e.name)
        .map((e) =>
          strip({
            title: clean(e.name),
            issuer: clean(e.authority),
            date_range: fmtRange(e),
          }),
        ),
    );

    return strip({
      name:
        me.firstName || me.lastName
          ? clean(`${me.firstName || ''} ${me.lastName || ''}`)
          : undefined,
      first_name: clean(me.firstName),
      last_name: clean(me.lastName),
      headline: clean(me.headline || me.occupation),
      location: clean(me.geoLocationName || me.locationName),
      about: clean(me.summary),
      industry: clean(me.industryName),
      avatar_url: safe(() => vectorImg(me.picture || me.profilePicture?.displayImageReference)),
      experience,
      education,
      skills,
      languages,
      certifications,
    });
  }

  // ── source 1: Voyager REST API ─────────────────────────────────────────────
  const csrf = safe(() =>
    decodeURIComponent(document.cookie.match(/JSESSIONID="?([^";]+)/)[1]),
  );
  let apiStatus = csrf ? 'no-call' : 'no-csrf';

  async function voyagerGet(path) {
    const r = await fetch(`/voyager/api${path}`, {
      credentials: 'include',
      headers: {
        'csrf-token': csrf,
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  let api = {};
  let email;
  let phone;
  if (csrf && slug) {
    try {
      const view = await voyagerGet(
        `/identity/profiles/${encodeURIComponent(slug)}/profileView`,
      );
      api = parseIncluded(view?.included, false);
      apiStatus = api.name ? 'ok' : 'empty';
    } catch (e) {
      apiStatus = e.message;
    }
    // Contact info is only exposed for (some) connections; entirely optional.
    const ci = await safe(async () => {
      try {
        return await voyagerGet(
          `/identity/profiles/${encodeURIComponent(slug)}/profileContactInfo`,
        );
      } catch {
        return undefined;
      }
    });
    email = clean(ci?.data?.emailAddress);
    phone = clean(ci?.data?.phoneNumbers?.[0]?.number);
  }

  // ── wait for render (DOM signals only — the API result doesn't need it) ──
  const waitFor = async (fn, timeoutMs, stepMs = 250) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = safe(fn);
      if (v) return v;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };

  await waitFor(() => {
    const h1 = clean(document.querySelector('main h1')?.textContent);
    if (!h1) return false;
    const title = (clean(document.title) || '').toLowerCase();
    return title.includes(h1.toLowerCase()) ? h1 : false;
  }, api.name ? 1200 : 4000);

  // ── source 2: embedded Voyager payloads ───────────────────────────────────
  // LinkedIn ships these inside HTML comments: <code><!--{json}--></code>.
  function embeddedIncluded() {
    const out = [];
    for (const code of document.querySelectorAll('code')) {
      let t = code.textContent || '';
      if (!t.trim()) {
        const c = code.firstChild;
        if (c && c.nodeType === Node.COMMENT_NODE) t = c.nodeValue || '';
      }
      t = t.trim();
      if (t.length < 100 || !t.startsWith('{') || !t.includes('"included"')) continue;
      if (!/"(firstName|companyName|schoolName|publicIdentifier)"/.test(t)) continue;
      const j = safe(() => JSON.parse(t));
      if (j && Array.isArray(j.included)) out.push(...j.included);
    }
    return out;
  }
  const embedded = safe(() => parseIncluded(embeddedIncluded(), true)) || {};

  // ── source 3: visible DOM ──────────────────────────────────────────────────
  const topCard =
    safe(() => document.querySelector('main h1')?.closest('section')) ||
    document.body;

  const sectionFor = (id) =>
    safe(() => document.getElementById(id)?.closest('section')) || null;

  const sectionItems = (id) =>
    safe(() => {
      const sec = sectionFor(id);
      if (!sec) return [];
      return [...sec.querySelectorAll('li.artdeco-list__item')].filter(
        (li) => !li.parentElement?.closest('li.artdeco-list__item'),
      );
    }) || [];

  const looksLikeDates = (s) =>
    /\b(19|20)\d{2}\b|present|heden|\byrs?\b|\bmos?\b/i.test(s || '');

  const EMPLOYMENT_TYPE_RE =
    /^(full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal|temporary)$/i;

  const entityParts = (li) => ({
    bold: vis(safe(() => li.querySelector('.t-bold'))),
    normals: [
      ...(safe(() => li.querySelectorAll('span.t-14.t-normal:not(.t-black--light)')) || []),
    ]
      .map(vis)
      .filter(Boolean),
    lights: [
      ...(safe(() => li.querySelectorAll('span.t-14.t-normal.t-black--light')) || []),
    ]
      .map(vis)
      .filter(Boolean),
    description: vis(safe(() => li.querySelector('.inline-show-more-text'))),
  });

  function parseRole(li, fallbackCompany) {
    const { bold, normals, lights, description } = entityParts(li);
    if (!bold) return null;
    let company = clean((normals[0] || '').split(' · ')[0]);
    if (company && EMPLOYMENT_TYPE_RE.test(company)) company = undefined;
    return strip({
      title: bold,
      company: company ?? fallbackCompany,
      date_range: lights.find(looksLikeDates),
      location: lights.find((s) => !looksLikeDates(s)),
      description,
    });
  }

  function parseExperience() {
    const out = [];
    for (const li of sectionItems('experience')) {
      safe(() => {
        const subs = [...li.querySelectorAll(':scope li')].filter((s) =>
          safe(() => s.querySelector('.t-bold')),
        );
        if (subs.length) {
          const company = vis(li.querySelector('.t-bold'));
          subs.forEach((sub) => {
            const r = parseRole(sub, company);
            if (r?.title) out.push(r);
          });
        } else {
          const r = parseRole(li);
          if (r?.title) out.push(r);
        }
      });
    }
    return out;
  }

  function parseEducation() {
    const out = [];
    for (const li of sectionItems('education')) {
      safe(() => {
        const { bold, normals, lights } = entityParts(li);
        if (!bold) return;
        const [degree, ...rest] = (normals[0] || '').split(', ');
        out.push(
          strip({
            school: bold,
            degree: clean(degree),
            field: clean(rest.join(', ')),
            date_range: lights.find(looksLikeDates),
          }),
        );
      });
    }
    return out;
  }

  const parseSkills = () =>
    uniq(
      sectionItems('skills')
        .map((li) => vis(safe(() => li.querySelector('.t-bold'))))
        .filter(Boolean),
    );

  const parseLanguages = () =>
    sectionItems('languages')
      .map((li) => {
        const { bold, normals, lights } = entityParts(li);
        if (!bold) return null;
        const proficiency = lights[0] || normals[0];
        return proficiency ? `${bold} — ${proficiency}` : bold;
      })
      .filter(Boolean);

  const parseCertifications = () =>
    sectionItems('licenses_and_certifications')
      .map((li) => {
        const { bold, normals, lights } = entityParts(li);
        if (!bold) return null;
        return strip({
          title: bold,
          issuer: normals[0],
          date_range: lights.find(looksLikeDates),
        });
      })
      .filter(Boolean);

  // Name off the DOM, with fallbacks for markup churn: the top-card h1, any
  // first h1, the avatar's alt text, a connect/message button label, and
  // finally the tab title ("(3) Jane Doe | LinkedIn") — all displayed data.
  const domName =
    clean(safe(() => document.querySelector('main h1')?.textContent)) ||
    clean(safe(() => document.querySelector('h1')?.textContent)) ||
    clean(
      safe(() => {
        const img = document.querySelector('img[class*="profile-picture"], .pv-top-card img');
        const alt = img?.getAttribute('alt');
        return alt && !/photo|picture|logo/i.test(alt) ? alt : undefined;
      }),
    ) ||
    clean(
      safe(
        () =>
          [...document.querySelectorAll('button[aria-label]')]
            .map((b) => b.getAttribute('aria-label'))
            .map((l) => l?.match(/^(?:Message|Invite)\s+(.+?)(?:\s+to connect)?$/)?.[1])
            .find(Boolean),
      ),
    ) ||
    clean(safe(() => document.title.match(/^\(?\d*\)?\s*(.+?)\s*[|–-]\s*LinkedIn/)?.[1]));

  const domHeadline = clean(
    safe(() => topCard.querySelector('.text-body-medium.break-words')?.textContent),
  );
  const domLocation = clean(
    safe(
      () =>
        topCard.querySelector(
          'span.text-body-small.inline.t-black--light.break-words',
        )?.textContent,
    ),
  );
  const domAbout = safe(() =>
    vis(sectionFor('about')?.querySelector('.inline-show-more-text'))?.replace(
      /…?\s*see more$/i,
      '',
    ),
  );
  const domAvatar = safe(() => {
    const img =
      topCard.querySelector('img.pv-top-card-profile-picture__image--show') ||
      document.querySelector('.pv-top-card-profile-picture img') ||
      document.querySelector('img[class*="pv-top-card-profile-picture"]');
    const src = img?.currentSrc || img?.src;
    return /^https?:/.test(src || '') ? src : undefined;
  });

  const cardText = safe(() => topCard.innerText) || '';
  const followers = clean(
    safe(() => cardText.match(/([\d.,]+\s*[KM]?\+?)\s+followers/i)?.[1]),
  );
  const connections = clean(
    safe(() => cardText.match(/([\d.,]+\s*[KM]?\+?)\s+connections/i)?.[1]),
  );
  const connection_degree = safe(() => {
    const t = clean(
      document.querySelector('.distance-badge .dist-value, span.dist-value')
        ?.textContent,
    );
    return t ? t.replace(/^[^0-9]*/, '') || t : undefined;
  });
  const mutual_connections = clean(
    safe(() =>
      [...topCard.querySelectorAll('a')]
        .map((a) => clean(a.textContent))
        .find((t) => /mutual connection/i.test(t || '')),
    ),
  );
  const open_to_work =
    /open to work/i.test(cardText) || !!sectionFor('open_to_work')
      ? true
      : undefined;

  // ── merge: API > embedded > DOM ────────────────────────────────────────────
  const dom = strip({
    name: domName,
    headline: domHeadline,
    location: domLocation,
    about: domAbout,
    avatar_url: domAvatar,
    experience: safe(parseExperience) || [],
    education: safe(parseEducation) || [],
    skills: safe(parseSkills) || [],
    languages: safe(parseLanguages) || [],
    certifications: safe(parseCertifications) || [],
  });
  const sources = [api, embedded, dom];
  const pick = (key) => sources.map((s) => s[key]).find((v) => v !== undefined);
  const pickList = (key) =>
    sources
      .map((s) => s[key] || [])
      .reduce((best, cur) => (cur.length > best.length ? cur : best), []);

  const name = pick('name');
  let first_name = api.first_name || embedded.first_name;
  let last_name = api.last_name || embedded.last_name;
  if (!first_name && name && name.includes(' ')) {
    const parts = name.split(' ');
    first_name = parts[0];
    last_name = parts.slice(1).join(' ');
  }

  const experience = pickList('experience');
  const top = experience[0];
  const isCurrent = top && /present|heden/i.test(top.date_range || '');

  const profile = strip({
    name,
    first_name,
    last_name,
    email,
    phone,
    linkedin_url: window.location.href,
    headline: pick('headline'),
    location: pick('location'),
    current_title: isCurrent ? top.title : undefined,
    current_company: isCurrent ? top.company : undefined,
    about: pick('about'),
    industry: pick('industry'),
    experience,
    education: pickList('education'),
    skills: pickList('skills'),
    languages: pickList('languages'),
    certifications: pickList('certifications'),
    open_to_work,
    connection_degree,
    followers,
    connections,
    mutual_connections,
    avatar_url: pick('avatar_url'),
    captured_at: new Date().toISOString(),
  });

  const debug = {
    api: apiStatus,
    embeddedName: !!embedded.name,
    embeddedBlobs: safe(() => embeddedIncluded().length) || 0,
    domH1: !!document.querySelector('main h1'),
    h1s: document.querySelectorAll('h1').length,
    title: clean(document.title)?.slice(0, 60),
  };

  return { ok: !!profile.name, profile, debug };
})();
