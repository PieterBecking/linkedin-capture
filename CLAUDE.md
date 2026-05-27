# CLAUDE.md

## Git Workflow

After every meaningful change, commit and push immediately using conventional commit prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, config, refactoring

When handling multiple requested changes, make an intermediate commit + push after each one — do not batch them into a single commit at the end.

Author commits as `PieterBecking <ph.becking@gmail.com>`. Never co-author as Claude.

## Project overview

MV3 Chrome extension. Captures an open LinkedIn message thread DOM and posts it as a meeting note to the Servo7 CRM (`/api/notes`), using the same `#company` / `@person` mention model as the notes app at `/opt/projects/notes`.

- Side panel = UI (mention popover + preview + save).
- `content.js` is injected on demand via `chrome.scripting.executeScript` — it's NOT registered as a static content script in the manifest. It returns the last expression (an IIFE result) so `executeScript` resolves to the scrape result.
- Auth to CRM uses `X-Internal-Token` (the CRM's `INTERNAL_API_TOKEN`), stored in `chrome.storage.local` via the options page.
- Notes are upserted by `external_id = linkedin:<threadId>`.

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
