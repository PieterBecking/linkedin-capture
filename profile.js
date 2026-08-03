// Scrapes the open LinkedIn profile page (/in/<slug>) for the recruitment
// export. Injected on demand via chrome.scripting.executeScript — the IIFE
// result is the scrape payload. Idempotent; safe to inject repeatedly.
//
// Every read is wrapped so a LinkedIn DOM change yields a missing key, never
// a thrown error that kills the export. Values that can't be read are
// omitted, not guessed — email/phone live behind the contact-info overlay and
// are deliberately not scraped.
(() => {
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

  function parseSkills() {
    const seen = new Set();
    const out = [];
    for (const li of sectionItems('skills')) {
      const s = vis(safe(() => li.querySelector('.t-bold')));
      const key = (s || '').toLowerCase();
      if (s && !seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    }
    return out;
  }

  function parseLanguages() {
    return sectionItems('languages')
      .map((li) => {
        const { bold, normals, lights } = entityParts(li);
        if (!bold) return null;
        const proficiency = lights[0] || normals[0];
        return proficiency ? `${bold} — ${proficiency}` : bold;
      })
      .filter(Boolean);
  }

  function parseCertifications() {
    return sectionItems('licenses_and_certifications')
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
  }

  // ── top card ──────────────────────────────────────────────────────────────
  const name = clean(safe(() => document.querySelector('main h1')?.textContent));
  const headline = clean(
    safe(() => topCard.querySelector('.text-body-medium.break-words')?.textContent),
  );
  const locationText = clean(
    safe(
      () =>
        topCard.querySelector(
          'span.text-body-small.inline.t-black--light.break-words',
        )?.textContent,
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

  // First/last from a plain "First Rest…" split; skipped for single-word names.
  let first_name;
  let last_name;
  if (name && name.includes(' ')) {
    const parts = name.split(' ');
    first_name = parts[0];
    last_name = parts.slice(1).join(' ');
  }

  const experience = safe(parseExperience) || [];
  // Only call the top entry "current" when its dates say so.
  const top = experience[0];
  const isCurrent = top && /present|heden/i.test(top.date_range || '');
  const current_title = isCurrent ? top.title : undefined;
  const current_company = isCurrent ? top.company : undefined;

  const profile = strip({
    name,
    first_name,
    last_name,
    linkedin_url: window.location.href,
    headline,
    location: locationText,
    current_title,
    current_company,
    about: vis(safe(() => sectionFor('about')?.querySelector('.inline-show-more-text'))),
    experience,
    education: safe(parseEducation) || [],
    skills: safe(parseSkills) || [],
    languages: safe(parseLanguages) || [],
    certifications: safe(parseCertifications) || [],
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
