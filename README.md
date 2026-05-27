# LinkedIn → CRM capture

Chrome extension (MV3, side panel). Captures the currently-open LinkedIn message thread and saves it as a meeting note in the [Servo7 CRM](https://crm.becking.dev), reusing the same `#company` / `@person` mention model as [the notes app](https://notes.becking.dev).

## How it works

1. Click the toolbar icon while a LinkedIn thread is open (URL contains `/messaging/thread/…`). The side panel opens.
2. Click **Capture this thread** — a content script reads the message list out of the page DOM.
3. Type a meeting name. `#` brings up a company picker, `@` brings up a person picker, both backed by the CRM's `/api/manifest` endpoint. Pick a known entity, or just type a new name to create one.
4. Click **Add note to CRM**. The extension POSTs to `/api/notes` with your captured conversation as `body_text` plus the chosen company/people. The CRM auto-extracts any "Todo Follow-up task" lines into tasks.

The note is upserted by `external_id = linkedin:<threadId>`, so re-capturing the same thread updates the existing note instead of duplicating it.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this directory.
4. Open the extension's **Options** page (right-click the toolbar icon → Options, or `chrome://extensions` → Details → Extension options).
5. Set:
   - **CRM base URL** — `https://crm.becking.dev` by default.
   - **Internal API token** — the value of `INTERNAL_API_TOKEN` from the CRM `.env`. Click **Test connection** to verify.

Settings are stored locally via `chrome.storage.local`.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Declares `sidePanel`, `scripting`, `storage`, `tabs`, plus host permissions for `linkedin.com` and `crm.becking.dev`. |
| `background.js` | Service worker. Sets `openPanelOnActionClick` so clicking the icon opens the side panel. |
| `sidepanel.html` / `sidepanel.css` / `sidepanel.js` | Side panel UI: capture button, meeting-name input with `#` / `@` mentions, conversation preview, save button. |
| `content.js` | Injected on demand into the LinkedIn tab. Scrapes `.msg-s-message-list-content` and returns `{ url, threadId, threadTitle, messages: [{sender, text, timestamp}] }`. |
| `options.html` / `options.js` | Settings page for CRM URL + token. |

## Notes on the LinkedIn DOM

LinkedIn ships UI churn, so `content.js` queries on the stable-ish class prefixes (`msg-s-message-list-content`, `msg-s-message-group__name`, `msg-s-event-listitem__body`). If LinkedIn renames these, the scraper returns zero messages and the side panel surfaces a warning — fix the selectors in `content.js` and reload the extension.

Only messages currently rendered in the DOM are captured. Scroll the thread up to load earlier history before clicking **Capture**.
