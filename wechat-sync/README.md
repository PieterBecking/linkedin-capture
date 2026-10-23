# WeChat → Brain

Standalone Mac scripts that capture selected supplier conversations from regular
WeChat and save their transcripts as company-linked meeting notes in Brain.
Swift reads the desktop accessibility tree; Python handles matching, local state,
and HTTPS requests. No MCP server or language model is involved.

## Install and link a supplier

Requires macOS, signed-in desktop WeChat, Python 3.9+, and the Swift compiler
from Apple's Command Line Tools. The selectors target WeChat 4.1.x; a WeChat
update may require adapting the reader.

```sh
sh wechat-sync/install.sh
open -n "$HOME/Library/Application Support/Servo7 WeChat Sync/WeChat Brain Reader.app" --args request-access
~/.local/bin/wechat-brain doctor
~/.local/bin/wechat-brain configure
~/.local/bin/wechat-brain chats
~/.local/bin/wechat-brain companies
~/.local/bin/wechat-brain link 'Exact visible group name' --company shenzhen-yuhesen-technology
~/.local/bin/wechat-brain sync --dry-run
~/.local/bin/wechat-brain sync
```

Enable the reader in **System Settings → Privacy & Security → Accessibility**.
When running commands from a terminal, macOS may require permission for that
terminal too. Rebuilding the ad-hoc-signed reader may require granting access
again, and Keychain may ask you to approve the updated reader. Reinstalling
unchanged native source preserves the existing binary and its approvals.
No Screen Recording or Full Disk Access permission is required.

Pin the supplier group so it remains visible in the sidebar. Names must match
exactly and be unique; use a unique WeChat remark when necessary. `link` checks
both the visible conversation and the existing Brain company. Optional
`--person 'Exact Brain name'` links a known attendee; it does not identify the
authors of individual messages. `configure` prompts for Brain's internal API
token and stores it in macOS Keychain. `BRAIN_INTERNAL_TOKEN` is also supported.

Brain must advertise `note_ingest_capabilities` in `/api/manifest` and support
`extract_tasks: false` on `/api/notes`. The script checks this before sending
chat text, so imported messages do not create regex or AI-generated follow-ups.

## Repeat imports

```sh
~/.local/bin/wechat-brain sync --pages 100
~/.local/bin/wechat-brain status
~/.local/bin/wechat-brain schedule
~/.local/bin/wechat-brain unschedule
```

Scheduling is available after a successful manual import. A per-user LaunchAgent
runs every 15 minutes while logged in. It skips runs while the Mac is locked,
WeChat is closed, Accessibility is unavailable, or the user has been active in
the previous 60 seconds. The reader briefly brings WeChat forward, selects and
scrolls the configured chats, then restores the previous application. Selecting
a conversation can mark it as read. It never types into the composer or sends
messages. Switching foreground apps interrupts capture.

One note per chat per **import day** accumulates newly captured messages. The
note date is not presented as the date of a meeting or of all historical
messages. Original displayed time labels remain in the transcript. JSON results
include the Brain note IDs and whether the reader reached the start of the
available history. Check a first live import before relying on the schedule;
desktop and scheduled Accessibility permissions can differ.

The default capture covers 30 overlapping viewports (maximum 100). A first
import includes only that available history, not necessarily the entire group.
Messages present only on your phone must first become available in desktop
WeChat. `history_start_reached: true` means scrolling stopped in the desktop
view; it does not prove that all phone/cloud history is present.

Sender identities are currently unavailable, so no message is attributed to a
particular participant. Images, files, emoji, and voice messages retain only
whatever labels WeChat exposes. There is no OCR, attachment download, or voice
transcription. Notes preserve readable text rather than generate summaries.

## State and recovery

Configuration, transcript snapshots, queued uploads, upload receipts, and the
installed reader live under:

```text
~/Library/Application Support/Servo7 WeChat Sync/
```

The directory is restricted to your user; the token is in Keychain. The SQLite
database contains private chat text, so protect backups accordingly. Keep
`config.json` and `state.sqlite3` together when migrating. Do not delete them to
fix a failed run: they hold the stable identities and deduplication history.
Stop the schedule before backing up the database, including its `-wal`/`-shm`
files if present, or use SQLite's backup API.

Uploads use an on-disk outbox and stable Brain `external_id` values. A lost
response can be retried without creating another note. Every response must
confirm the requested company link and zero generated tasks. If captured
history no longer overlaps the last import, the script stops without advancing
that chat; increase `--pages` and retry. Ambiguous short/repeated overlap also
stops. The UI does not expose stable message IDs: two completely identical
captured sequences cannot be distinguished, and edits/deletions are not synced.

`unlink 'Exact visible group name'` stops importing that chat and cancels its
queued uploads; existing notes and local history remain. Relinking allocates a
new identity and can import that history again. Do not rename/relink a group
casually; check its existing notes first. Later imports update the whole daily
note, so keep manual commentary in a separate Brain note.

Scheduled status/errors go to `sync.log`; transcripts and tokens are not logged.
An unavailable Mac or an error is retried on the next interval; there are no
push notifications. Review `status` and the log periodically. To remove the
schedule run `unschedule`. Removing the application directory does not remove
previous Brain notes or the Keychain credential (`com.servo7.wechat-brain`).

## Checks

```sh
python3 -m unittest discover -s wechat-sync -p 'test_*.py' -v
```

Tests cover overlap and repeated messages, missing-history refusal, wrong-chat
refusal, retrying after a committed upload loses its response, daily note
accumulation, verified company links, and refusing servers that might run AI
extraction. The native reader additionally needs a live WeChat check with
Accessibility enabled; unit tests cannot establish that its selectors work.
