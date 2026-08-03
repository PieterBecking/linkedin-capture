// Scrapes the open LinkedIn profile page (/in/<slug>) for the recruitment
// export. Injected on demand via chrome.scripting.executeScript — the async
// IIFE result is the scrape payload. Idempotent; safe to inject repeatedly.
//
// Two sources, merged:
//  1. The visible DOM (top card + section cards). Carries render-only signals
//     like open-to-work, connection degree, followers, avatar.
//  2. LinkedIn's embedded Voyager JSON — the raw API payloads the page ships
//     in <code> elements. Cleaner and fuller (proper first/last name, full
//     about text, dated positions), and matched to the URL slug so an SPA
//     transition can never attribute the previous profile's data.
//
// Every read is wrapped so a LinkedIn DOM change yields a missing key, never
// a thrown error that kills the export. Values that can't be read are
// omitted, not guessed — email/phone live behind the contact-info overlay and
// are deliberately not scraped.
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

  // LinkedIn duplicates most text for screen readers; the visible copy sits
  // in span[aria-hidden="true"].
  const vis = (el) => {
    if (!el) return undefined;
    const a = safe(() => el.querySelector(':scope span[aria-hidden="true"]'));
    return clean(a?.textContent) ?? clean(el.textContent);
  };

  // Drop empty values so the payload only carries what was actually read.
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

  // ── wait for render ────────────────────────────────────────────────────────
  // LinkedIn paints the profile lazily, and SPA navigations change the URL
  // well before the DOM. The tab title flips to the new person immediately,
  // so wait until the top-card h1 agrees with it (or time out and take what's
  // there — the Voyager slug match below still guards the structured fields).
  const waitFor = async (fn, timeoutMs = 4000, stepMs = 250) => {
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
  });

  // ── Voyager JSON (embedded API payloads) ──────────────────────────────────
  function voyagerIncluded() {
    const out = [];
    for (const code of document.querySelectorAll('code')) {
      const t = code.textContent || '';
      if (t.length < 100 || !t.includes('"included"')) continue;
      if (!/"(firstName|companyName|schoolName|publicIdentifier)"/.test(t)) continue;
      const j = safe(() => JSON.parse(t));
      if (j && Array.isArray(j.included)) out.push(...j.included);
    }
    return out;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) =>
    d && (d.year || d.month)
      ? [d.month ? MONTHS[d.month - 1] : null, d.year].filter(Boolean).join(' ')
      : null;
  const fmtRange = (dr) => {
    if (!dr) return undefined;
    const start = fmtDate(dr.start);
    if (!start) return undefined;
    return `${start} – ${fmtDate(dr.end) || 'Present'}`;
  };
  const startKey = (e) =>
    (e.dateRange?.start?.year || 0) * 12 + (e.dateRange?.start?.month || 0);

  function voyagerScrape() {
    const included = safe(voyagerIncluded) || [];
    if (!included.length || !slug) return {};
    const isType = (e, suffix) =>
      typeof e?.$type === 'string' && e.$type.endsWith(suffix);

    // The profile entity for THIS page, matched by URL slug — entities from a
    // previously viewed profile can't leak in.
    const me = included.find(
      (e) => e?.publicIdentifier === slug && (e.firstName || e.lastName),
    );

    const experience = uniq(
      included
        .filter((e) => isType(e, '.profile.Position') && e.title)
        .sort((a, b) => startKey(b) - startKey(a))
        .map((e) =>
          strip({
            title: clean(e.title),
            company: clean(e.companyName),
            date_range: fmtRange(e.dateRange),
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
            date_range: fmtRange(e.dateRange),
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
          const prof = clean((e.proficiency || '').toLowerCase().replace(/_/g, ' '));
          return prof ? `${clean(e.name)} — ${prof}` : clean(e.name);
        }),
    );

    const certifications = uniq(
      included
        .filter((e) => isType(e, '.profile.Certification') && e.name)
        .map((e) =>
          strip({
            title: clean(e.name),
            issuer: clean(e.authority),
            date_range: fmtRange(e.dateRange),
          }),
        ),
    );

    return strip({
      name:
        me && (me.firstName || me.lastName)
          ? clean(`${me.firstName || ''} ${me.lastName || ''}`)
          : undefined,
      first_name: clean(me?.firstName),
      last_name: clean(me?.lastName),
      headline: clean(me?.headline),
      location: clean(me?.geoLocationName || me?.locationName),
      about: clean(me?.summary),
      industry: clean(me?.industryName),
      experience,
      education,
      skills,
      languages,
      certifications,
    });
  }

  // ── DOM scrape ────────────────────────────────────────────────────────────
  const topCard =
    safe(() => document.querySelector('main h1')?.closest('section')) ||
    document.body;

  // Profile cards carry an empty anchor div whose id names the section
  // (about, experience, education, skills, …).
  const sectionFor = (id) =>
    safe(() => document.getElementById(id)?.closest('section')) || null;

  const sectionItems = (id) =>
    safe(() => {
      const sec = sectionFor(id);
      if (!sec) return [];
      // Top-level entries only; nested positions are handled per item.
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
    // Company line reads "Servo7 · Full-time"; nested roles under a grouped
    // company often show only the employment type there.
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
        // Grouped entry: one company with several roles nested underneath.
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
        // Degree line reads "Master's degree, Computer Science".
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

  const domName = clean(safe(() => document.querySelector('main h1')?.textContent));
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
  const avatar_url = safe(() => {
    const img =
      topCard.querySelector('img.pv-top-card-profile-picture__image--show') ||
      topCard.querySelector('.pv-top-card-profile-picture__container img') ||
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

  // ── merge ─────────────────────────────────────────────────────────────────
  // Voyager wins on identity/text fields (clean names, untruncated about);
  // for lists, take whichever source read more entries (Voyager on ties —
  // its entries carry proper dates).
  const voy = safe(voyagerScrape) || {};
  const pickList = (voyList, domFn) => {
    const dom = safe(domFn) || [];
    return (voy[voyList]?.length || 0) >= dom.length ? voy[voyList] || [] : dom;
  };

  const experience = pickList('experience', parseExperience);
  const name = voy.name || domName;
  let { first_name, last_name } = voy;
  if (!first_name && name && name.includes(' ')) {
    const parts = name.split(' ');
    first_name = parts[0];
    last_name = parts.slice(1).join(' ');
  }

  // Only call the top entry "current" when its dates say so.
  const top = experience[0];
  const isCurrent = top && /present|heden/i.test(top.date_range || '');

  const profile = strip({
    name,
    first_name,
    last_name,
    linkedin_url: window.location.href,
    headline: voy.headline || domHeadline,
    location: voy.location || domLocation,
    current_title: isCurrent ? top.title : undefined,
    current_company: isCurrent ? top.company : undefined,
    about: voy.about || domAbout,
    industry: voy.industry,
    experience,
    education: pickList('education', parseEducation),
    skills: pickList('skills', parseSkills),
    languages: pickList('languages', parseLanguages),
    certifications: pickList('certifications', parseCertifications),
    open_to_work,
    connection_degree,
    followers,
    connections,
    mutual_connections,
    avatar_url,
    captured_at: new Date().toISOString(),
  });

  return { ok: !!profile.name, profile };
})();
