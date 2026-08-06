# CLAUDE.md

## Git Workflow

After every meaningful change, commit and push immediately using conventional commit prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, config, refactoring

When handling multiple requested changes, make an intermediate commit + push after each one — do not batch them into a single commit at the end.

Author commits as `PieterBecking <ph.becking@gmail.com>`. Never co-author as Claude.

## Project overview

MV3 Chrome extension with two side-panel modes, routed off the active tab URL (`detectMode` in `sidepanel.js`):

1. **Chat capture** (`/messaging/…`): captures an open LinkedIn message thread DOM and posts it as a meeting note to the Servo7 CRM (`/api/notes`), using the same `#company` / `@person` mention model as the notes app at `/opt/projects/notes`.
2. **Recruitment export** (`/in/<slug>`, any linkedin subdomain): scrapes the candidate profile (`profile.js`) and exports it to the recruitment pipeline.
3. **Juicebox export** (`app.juicebox.ai`, any path): same recruitment UI, but the scraper is `juicebox.js` — same `{ ok, profile, debug }` contract as `profile.js`, picked by `scrapeProfile` off the URL.

Chat capture:

- Side panel = UI (mention popover + preview + save).
- `content.js` is injected on demand via `chrome.scripting.executeScript` — it's NOT registered as a static content script in the manifest. It returns the last expression (an IIFE result) so `executeScript` resolves to the scrape result.
- Auth to CRM uses `X-Internal-Token` (the CRM's `INTERNAL_API_TOKEN`), stored in `chrome.storage.local` via the options page.
- Notes are upserted by `external_id = linkedin:<threadId>`.

Recruitment export:

- `profile.js` injected on demand, same pattern as `content.js`. Returns `{ ok, profile }`; every selector is wrapped so DOM churn yields missing keys, never a thrown error. Values that can't be read are omitted, not guessed (email/phone are behind the contact-info overlay and deliberately not scraped).
- `profile.js` merges three sources, best-first:
  1. Voyager REST API — same-origin, with `csrf-token` = the `JSESSIONID` cookie value and `accept: application/vnd.linkedin.normalized+json+2.1`. Authoritative; immune to DOM churn. Attempted newest-first: dash (`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>&decorationId=...FullProfileWithEntities-101`), dash without decoration, then legacy `profileView` — which returns **HTTP 410** on current builds (observed Aug 2026), kept only for older UIs. Legacy entities use `timePeriod{startDate,endDate}`, dash uses `dateRange{start,end}` — handle both.
- Some LinkedIn builds render the profile in a subframe: the top document has ZERO h1s/code blobs while the tab title knows the name (observed Aug 2026). `sidepanel.js` therefore injects `profile.js` with `allFrames: true` and keeps the richest frame result; `profile.js` reads slug/title off `window.top` when its own frame lacks them.
  2. Embedded Voyager payloads. GOTCHA: LinkedIn wraps these in HTML comments (`<code><!--{json}--></code>`), so `textContent` is EMPTY — read `code.firstChild.nodeValue` when it's a comment node. Profile entity matched by `publicIdentifier === slug` so SPA transitions can't leak the previous profile.
  3. Visible DOM, searched through shadow roots (only source for open-to-work, connection degree, followers, mutuals). IDENTITY SAFETY: the page is full of other people (More profiles for you, People also viewed) whose cards carry names, photos and Invite/Message buttons — NEVER take identity from a document-wide query. A DOM name is accepted only if the tab title (which always names the viewed person) vouches for it, and all per-person DOM reads stay inside that vouched h1's card; no vouched h1 → the DOM contributes nothing about the person.
  It awaits render (title-vouched `h1`, ≤4s when the API found nothing); the panel retries once, has a "rescan" link, shows the winning source in the summary line (`via api|embedded|dom-h1|tab-title`), and prints a per-layer debug string whenever the structured sources didn't produce the name.
- Auth: the Brain session cookie, nothing else — every call goes out with `credentials: 'include'`. There is NO extension token (the server-side one was deleted Aug 2026). `401` = signed out of brain.servo7.com in this browser (show a sign-in link, never call it a config problem); `403` = signed in but missing the `recruitment` permission; `400` = payload problem, show `detail` verbatim.
- Endpoints (all under `https://brain.servo7.com`, fixed server-side):
  - `GET /api/extension/ping` — options-page connection test.
  - `GET /api/extension/recruitment/roles` → `{ roles: [{id, title, is_open}], stages, default_role_id }`. `default_role_id: null` → force a manual pick; closed roles listed with "(closed)". Roles fetch failure disables export — never fall back to a hard-coded list.
  - `GET /api/extension/recruitment/candidates/lookup?linkedin_url=…` → `{ found, applications: [{url, stage_label, role_title}] }` drives the "already in pipeline" banner and demotes the export button to secondary.
  - `POST /api/extension/recruitment/candidates` — full scrape + `role_id`/`stage`/`notes`. `already_in_pipeline: true` in the response = refreshed, not newly added. 400 `detail` is shown verbatim.
- ALL recruitment fetches go through the background worker (`{ type: 'brainApi' }` message to `background.js`) — the server sends no CORS headers, and `host_permissions` on `brain.servo7.com` is what makes worker fetches legal and cookie-bearing. Never fetch from a content script.
- The only recruitment setting is the base URL (`extBaseUrl`, `chrome.storage.sync`); chat-capture settings stay in `chrome.storage.local`. Don't mix them.

Juicebox export:

- One page = a search-results list of MANY candidates plus one expanded detail panel (`?contact=<id>&expanded=true`). IDENTITY SAFETY: `juicebox.js` scopes every read to that panel, found by walking UP from `[data-tour-id="search.profile-detail"]` to the first ancestor that also contains the header's `a[href*="linkedin.com/in/"]`; the walk stops before `document.body` — no qualifying ancestor → scrape refuses rather than read a list row.
- Selector anchors are aria-labels (`Location:`, `Company:`, `Experience at …`), `id="exp<N>"`/`"edu<N>"`, and inline styles (`font-weight: 500` = entity title, `400` = company/sub, `rgb(107, 114, 128)` = muted location). Juicebox's hashed utility classes (`css-…`) are never used. Descriptions render 3 copies (visible clamped + two hidden measuring divs) — take the one without `visibility: hidden`.
- The candidate's `linkedin_url` comes from the panel-header anchor and is what keys the CRM. The Juicebox tab URL is search-state, not identity: the pipeline lookup waits for the scrape (it can't run in parallel like on LinkedIn), and export is blocked when no LinkedIn URL was scraped — the tab URL must never be sent as `linkedin_url`.
- Extra payload keys (`juicebox_match`, `juicebox_criteria`, `juicebox_url`, `total_experience`, `scrape_source`) ride along verbatim like the rest of the scrape.
- Email/phone sit behind Juicebox's "Reveal" credits and are deliberately not scraped.

## Selectors that may rot

LinkedIn's DOM class names change. The capture relies on:
- `.msg-s-message-list-content` (the list)
- `.msg-s-message-group__name` (sender header — only set once per group)
- `.msg-s-event-listitem__body` (message body)
- `h2.msg-entity-lockup__entity-title` (thread title)

When capture returns zero messages, that's the first place to look.

## Manifest endpoint

Companies/people popover data comes from `GET ${CRM_URL}/api/manifest` (defined in `/opt/projects/s7-crm/src/app/routers/manifest.py`). Shape: `{ companies: [{slug, title, people: [{name, role}], ...}], team: [string], people_ranked: [string] }`. Same shape the notes app consumes.

## Save payload

POST to `${CRM_URL}/api/notes` — see `/opt/projects/s7-crm/src/app/routers/notes.py` for the full contract. Required fields: `title`, `body_text`. We also send `companies`, `attendees`, `date`, `source: "linkedin-capture"`, `source_subject` (thread title), `external_id`.
