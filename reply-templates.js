// Local reply suggestions. No conversation text leaves the browser.
// Also loaded by the options page and the Node tests.
(() => {
  const defaults = Object.freeze({
    recruiter: "Hey {firstName}, thanks for your message! We're not working with external recruiters right now, but thanks for reaching out anyway.",
    investor: "Hey {firstName}, thanks for reaching out! All my time is going into customers and product right now, but happy to keep you updated when we're planning to raise again. Would that be of interest? Let me know!",
    services: "Hey {firstName}, thanks for your message! We're not looking for external engineering support right now, but thanks for reaching out anyway.",
  });
  const labels = Object.freeze({
    recruiter: 'Recruiter',
    investor: 'Investor',
    services: 'Engineering services',
  });

  const normalize = (s) => String(s || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const nameKey = (s) => normalize(s).toLowerCase();
  const knownName = (s) => s && !/^(unknown|you|me|linkedin member)$/i.test(s);

  function templates(saved) {
    return Object.fromEntries(Object.keys(defaults).map((key) => [
      key, typeof saved?.[key] === 'string' && saved[key].trim() ? saved[key].trim() : defaults[key],
    ]));
  }

  function classify(text) {
    const t = normalize(text).toLowerCase();
    // Require intent, not just a word like "product", "team" or "growth".
    const recruiter = /\b(recruiters?|recruitment|recruiting agency|staffing|headhunt(?:er|ing)?|talent acquisition|executive search)\b/.test(t)
      || /\b(?:we|i) (?:can |could |help |speciali[sz]e in )?(?:help (?:you |companies |teams )?)?(?:hire|recruit|source candidates)\b/.test(t)
      || /\b(?:hiring|recruiting|recruitment) (?:needs|support|partner|services)\b/.test(t);
    const investor = /\b(?:we|i)\s+(?:(?:typically|actively|usually|also|often)\s+)?invest\b/.test(t)
      || /\b(?:i'm|i am|we're|we are)\s+(?:an?\s+)?(?:angel\s+)?investors?\b/.test(t)
      || /\b(?:venture capital|vc fund|investment (?:fund|team)|early[- ]stage (?:fund|investor)|seed fund)\b/.test(t)
      || /\b(?:your|next|planning (?:a|to)|considering (?:a|to))\s+(?:fundrais(?:e|ing)|funding round|raise|raising)\b/.test(t)
      || /\b(?:interested in investing|invest in (?:you|your|servo7)|participate in your (?:next )?round)\b/.test(t);
    const services = /\b(?:staff augmentation|outsourc(?:e|ed|ing)|nearshor(?:e|ing)|offshor(?:e|ing)|engineering services|development agency)\b/.test(t)
      || /\b(?:additional|extra|external|dedicated)\s+(?:engineering|technical|development|software)\s+(?:talent|capacity|support|team|resources|engineers)\b/.test(t)
      || /\b(?:we|i|[a-z]+ crew) can help\b.{0,100}\b(?:embedded systems|software development|engineering|qa)\b/.test(t);
    const matches = [recruiter && 'recruiter', investor && 'investor', services && 'services'].filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  }

  function analyze(thread) {
    const messages = (thread?.messages || []).filter((m) => normalize(m.text));
    if (!messages.length) return { kind: null, reason: 'empty', sender: '', message: '' };
    const title = normalize(thread.threadTitle);
    const viewer = nameKey(thread.viewerName);
    const isOutgoing = (m) => m.isOutgoing === true || /^(you|me)$/i.test(m.sender || '')
      || (viewer && nameKey(m.sender) === viewer);
    const latest = messages.at(-1);
    if (isOutgoing(latest)) return { kind: null, reason: 'replied', sender: '', message: latest.text };

    // Sender identity must come from the message, or a verified 1:1 header.
    const senders = [...new Set(messages.filter((m) => !isOutgoing(m) && knownName(m.sender)).map((m) => normalize(m.sender)))];
    const oneToOne = knownName(title) && !/[,\n]|\band\b|\b\d+ (?:people|others)\b/i.test(title)
      && senders.every((s) => nameKey(s) === nameKey(title));
    const sender = knownName(latest.sender) ? normalize(latest.sender) : oneToOne ? title : '';
    if (!sender) return { kind: null, reason: 'unknown-sender', sender: '', message: latest.text };
    if (thread.isGroup || !oneToOne) return { kind: null, reason: 'group', sender, message: latest.text };

    // Include consecutive incoming bubbles so a pitch split over messages works.
    // Stop at our own reply: an old pitch must not trigger a second rejection.
    const incoming = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isOutgoing(m) || (knownName(m.sender) && nameKey(m.sender) !== nameKey(sender))) break;
      incoming.unshift(m.text);
    }
    const message = incoming.join('\n\n');
    const kind = classify(message);
    return { kind, reason: kind ? 'matched' : 'unrecognized', sender, message };
  }

  function draft(kind, sender, saved) {
    if (!Object.hasOwn(defaults, kind)) return '';
    const firstName = normalize(sender).split(' ')[0] || 'there';
    return templates(saved)[kind].replace(/\{firstName\}/g, () => firstName);
  }

  globalThis.ReplyTemplates = { defaults, labels, templates, classify, analyze, draft };
})();
