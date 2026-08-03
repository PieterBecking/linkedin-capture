# LinkedIn → CRM capture

Chrome extension (MV3, side panel) with two modes, picked automatically from the active tab's URL:

- **Chat capture** (`linkedin.com/messaging/…`) — captures the open message thread and saves it as a meeting note in the [Servo7 CRM](https://brain.servo7.com), reusing the same `#company` / `@person` mention model as [the notes app](https://notes.becking.dev).
- **Recruitment export** (`linkedin.com/in/<slug>`, any subdomain) — scrapes the candidate profile and exports it to the CRM recruitment pipeline with a role, stage and notes.

Anywhere else on the web the panel says there's nothing to capture and offers nothing.

## How it works

1. Click the toolbar icon while a LinkedIn thread is open (URL contains `/messaging/thread/…`). The side panel opens.
2. Click **Capture this thread** — a content script reads the message list out of the page DOM.
3. Type a meeting name. `#` brings up a company picker, `@` brings up a person picker, both backed by the CRM's `/api/manifest` endpoint. Pick a known entity, or just type a new name to create one.
4. Click **Add note to CRM**. The extension POSTs to `/api/notes` with your captured conversation as `body_text` plus the chosen company/people. The CRM auto-extracts any "Todo Follow-up task" lines into tasks.

The note is upserted by `external_id = linkedin:<threadId>`, so re-capturing the same thread updates the existing note instead of duplicating it.

## Recruitment export

Open a profile (`/in/<slug>`) and the side panel switches to profile mode:

1. `profile.js` is injected and scrapes everything readable off the page — name, headline, location, about, experience, education, skills, languages, certifications, open-to-work, connection degree, followers, avatar, … Missing DOM pieces become missing keys, never errors.
2. The panel loads roles + stages from `GET /api/extension/recruitment/roles` (default role preselected when the server sets one, closed roles marked "(closed)") and checks `GET /api/extension/recruitment/candidates/lookup?linkedin_url=…`. A candidate already in the pipeline gets a banner linking to their application(s).
3. **Export to pipeline** POSTs the full scrape plus `role_id` / `stage` / `notes` to `POST /api/extension/recruitment/candidates`. Mapped columns (name, headline, location, current title/company, …) land in the candidate record; every other key is stored verbatim and shown on the candidate page.

All recruitment calls run in the background service worker (the API sends no CORS headers; `host_permissions` is what makes worker fetches legal and cookie-bearing) and authenticate with the Brain session cookie (`credentials: "include"`) — the extension holds no credential of its own. A 401 means you're signed out of brain.servo7.com in this browser; a 403 means the signed-in account lacks the `recruitment` permission.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this directory.
4. Open the extension's **Options** page (right-click the toolbar icon → Options, or `chrome://extensions` → Details → Extension options).
5. Set:
   - **CRM base URL** — `https://brain.servo7.com` by default.
   - **Internal API token** — the value of `INTERNAL_API_TOKEN` from the CRM `.env`. Click **Test connection** to verify.
   - **Recruitment export** section: **Server base URL** (same default). No token — auth is your Brain sign-in session. Its **Test connection** button hits `GET /api/extension/ping` and reports signed-in / signed-out / unreachable.

Chat-capture settings are stored via `chrome.storage.local`; the recruitment base URL via `chrome.storage.sync`.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Declares `sidePanel`, `scripting`, `storage`, `tabs`, plus host permissions for `*.linkedin.com` and `brain.servo7.com` (and legacy `crm.becking.dev` during the migration). |
| `background.js` | Service worker. Sets `openPanelOnActionClick`, and proxies all recruitment API calls (`{ type: 'brainApi' }` messages) with `credentials: "include"` so the Brain session cookie rides along. |
| `sidepanel.html` / `sidepanel.css` / `sidepanel.js` | Side panel UI. Chat mode: capture button, meeting-name input with `#` / `@` mentions, conversation preview, save button. Profile mode: scraped name/headline, role + stage dropdowns, notes, export button, already-in-pipeline banner. |
| `content.js` | Injected on demand into a messaging tab. Scrapes `.msg-s-message-list-content` and returns `{ url, threadId, threadTitle, messages: [{sender, text, timestamp}] }`. |
| `profile.js` | Injected on demand into a profile tab. Waits for the profile to render, then merges the visible DOM with LinkedIn's embedded Voyager JSON (matched to the URL slug) and returns `{ ok, profile }`; unreadable fields are omitted. |
| `options.html` / `options.js` | Settings page: CRM URL + internal token (chat capture) and server URL + extension token (recruitment export). |

## Notes on the LinkedIn DOM

LinkedIn ships UI churn, so `content.js` queries on the stable-ish class prefixes (`msg-s-message-list-content`, `msg-s-message-group__name`, `msg-s-event-listitem__body`). If LinkedIn renames these, the scraper returns zero messages and the side panel surfaces a warning — fix the selectors in `content.js` and reload the extension.

`profile.js` reads two sources and merges them: the visible DOM (`main h1`, the section anchor ids `about` / `experience` / `education` / `skills` / `languages` / `licenses_and_certifications`, and the `t-bold` / `t-14 t-normal` / `t-black--light` text classes) and the Voyager JSON payloads LinkedIn embeds in `<code>` elements, matched to the URL slug so SPA navigation can't attribute a previous profile's data. It waits up to ~4s for the top card to render before scraping; the side panel retries once and offers a manual **rescan** link. Every read is wrapped, so churn degrades to missing keys in the export rather than a failure.

Only messages currently rendered in the DOM are captured. Scroll the thread up to load earlier history before clicking **Capture**.
