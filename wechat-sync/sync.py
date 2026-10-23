#!/usr/bin/env python3
"""Deterministic WeChat -> Brain transcript sync. Python standard library only."""
import argparse
import datetime as dt
import fcntl
import getpass
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP_DIR = Path.home() / 'Library/Application Support/Servo7 WeChat Sync'
SERVICE = 'com.servo7.wechat-brain'


class SyncError(Exception):
    pass


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(encode(value) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def row_key(row):
    return (row['kind'], row['text'])


def merge_pages(pages):
    """Join newest-first viewports using sequence overlap, preserving repeats."""
    if not pages:
        raise SyncError('No conversation pages were captured.')
    joined = []
    for page in pages:
        clean = [{k: v for k, v in row.items() if k != 'y'} for row in page]
        if not joined:
            joined = clean
            continue
        a, b = [row_key(r) for r in clean], [row_key(r) for r in joined]
        overlaps = [n for n in range(1, min(len(a), len(b)) + 1) if a[-n:] == b[:n]]
        if not overlaps:
            raise SyncError('History pages do not overlap. Nothing imported; retry with a smaller scroll step.')
        joined = clean[:-max(overlaps)] + joined
    return joined


def messages_from_rows(rows):
    stamp = None
    out = []
    for row in rows:
        if row['kind'] == 'timestamp':
            stamp = row['text']
        elif row['kind'] == 'message':
            out.append({'text': row['text'], 'sender': row.get('sender', 'unknown'), 'displayed_time': stamp})
    if not out:
        raise SyncError('There are no readable messages to import.')
    return out


def message_key(message):
    # Displayed dates are relative/localized and may change from Today to Yesterday.
    return (message.get('sender', 'unknown'), message['text'])


def new_messages(previous, current):
    """Find a unique previous tail in the new window. A gap never advances state."""
    if not previous:
        return current
    old = [message_key(m) for m in previous]
    new = [message_key(m) for m in current]
    if old == new:
        return []
    for size in range(min(len(old), len(new)), 0, -1):
        anchor = old[-size:]
        positions = [i for i in range(len(new) - size + 1) if new[i:i + size] == anchor]
        if not positions:
            continue
        if len(positions) != 1:
            raise SyncError('Repeated messages make the sync boundary ambiguous. Increase --pages and retry.')
        # One generic "OK" is not enough evidence to identify an old message.
        if size < 3 and sum(len(text) for _, text in anchor) < 40:
            raise SyncError('Not enough distinctive overlap to identify new messages. Increase --pages and retry.')
        return current[positions[0] + size:]
    raise SyncError('The last imported messages are missing from the captured history. Increase --pages; state was kept.')


class Store:
    def __init__(self, directory):
        self.db = sqlite3.connect(directory / 'state.sqlite3')
        os.chmod(directory / 'state.sqlite3', 0o600)
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS cursors(chat_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS batches(
                external_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, day TEXT NOT NULL,
                messages TEXT NOT NULL, captured_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox(external_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts(external_id TEXT PRIMARY KEY, note_id TEXT NOT NULL);
        ''')

    def previous(self, chat_id):
        row = self.db.execute('SELECT snapshot FROM cursors WHERE chat_id=?', (chat_id,)).fetchone()
        return json.loads(row[0]) if row else []

    def enqueue(self, namespace, chat, snapshot, captured_at):
        added = new_messages(self.previous(chat['id']), snapshot)
        if not added:
            return 0
        day = dt.datetime.fromisoformat(captured_at.replace('Z', '+00:00')).astimezone().date().isoformat()
        external_id = f"wechat:{namespace}:{chat['id']}:{day}"
        row = self.db.execute('SELECT messages FROM batches WHERE external_id=?', (external_id,)).fetchone()
        messages = (json.loads(row[0]) if row else []) + added
        payload = make_note(external_id, chat, messages, day, captured_at)
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO batches VALUES(?,?,?,?,?)',
                            (external_id, chat['id'], day, encode(messages), captured_at))
            self.db.execute('INSERT OR REPLACE INTO outbox VALUES(?,?)', (external_id, encode(payload)))
            self.db.execute('INSERT OR REPLACE INTO cursors VALUES(?,?)', (chat['id'], encode(snapshot)))
        return len(added)

    def flush(self, client):
        sent = 0
        for external_id, payload in self.db.execute('SELECT external_id,payload FROM outbox ORDER BY rowid').fetchall():
            value = json.loads(payload)
            result = client.request('/api/notes', value)
            matched = result.get('matched_companies', [])
            if not result.get('id') or not any(c.get('company_id') and c.get('slug') == value['companies'][0]['slug'] for c in matched):
                raise SyncError('Brain did not confirm the supplier link. Upload kept for retry.')
            if result.get('tasks_created') != 0:
                raise SyncError('Brain unexpectedly created follow-ups. Sync stopped; inspect this note before retrying.')
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO receipts VALUES(?,?)', (external_id, str(result['id'])))
                self.db.execute('DELETE FROM outbox WHERE external_id=?', (external_id,))
            sent += 1
        return sent


def make_note(external_id, chat, messages, day, captured_at):
    lines = [f"WeChat conversation: {chat['name']}", f"Captured through: {captured_at}",
             f"Messages added to this capture-day record: {len(messages)}",
             'Original displayed time labels are retained; the note date is the import date.',
             'This transcript contains messages available in the desktop capture, not a full account export.',
             'Sender identity is not exposed by this reader. Messages may be from any participant.',
             'Images, voice messages and files are represented only by their displayed labels.', '']
    for i, message in enumerate(messages, 1):
        stamp = message.get('displayed_time') or 'time not shown'
        lines.extend([f"Message {i} · {stamp}", *('> ' + line for line in message['text'].splitlines()), ''])
    return {'title': f"WeChat · {chat['company_title']} · {chat['name']} · {day}",
            'body_text': '\n'.join(lines), 'date': day, 'source': 'wechat-sync',
            'source_subject': chat['name'], 'external_id': external_id,
            'companies': [{'slug': chat['company_slug'], 'title': chat['company_title']}],
            'attendees': chat.get('attendees', []), 'extract_tasks': False}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError('Brain redirected the request. Check the configured HTTPS URL; credentials were not forwarded.')


class Brain:
    def __init__(self, url, token):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise SyncError('Brain URL must be an HTTPS URL without credentials, query, or fragment.')
        self.url = url.rstrip('/')
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, path, payload=None):
        request = urllib.request.Request(self.url + path,
            data=encode(payload).encode() if payload is not None else None,
            headers={'X-Internal-Token': self.token, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise SyncError(f'Brain returned HTTP {error.code}. Check the token and server; the upload remains queued.') from None
        except (OSError, ValueError) as error:
            raise SyncError(f'Brain request failed ({type(error).__name__}); the upload remains queued.') from None

    def preflight(self):
        manifest = self.request('/api/manifest')
        capabilities = manifest.get('note_ingest_capabilities', {})
        if capabilities.get('task_extraction_opt_out') is not True or capabilities.get('external_id_upsert') is not True:
            raise SyncError('Brain does not support deterministic note ingestion. No chat data was sent.')
        return manifest


def reader(directory, *args):
    application = directory / 'WeChat Brain Reader.app'
    try:
        # Launch as the authorized app, including from launchd, rather than
        # inheriting whichever terminal happened to start the Python process.
        with tempfile.TemporaryDirectory(prefix='reader-', dir=directory) as temp:
            output, errors = Path(temp) / 'output.json', Path(temp) / 'error.log'
            result = subprocess.run(['/usr/bin/open', '-n', '-g', '-W', '--stdout', str(output),
                '--stderr', str(errors), str(application), '--args', *args],
                capture_output=True, text=True, timeout=300)
            value = json.loads(output.read_text())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise SyncError(f'WeChat reader failed ({type(error).__name__}). Run install.sh, then doctor.') from None
    if result.returncode or (value.get('ok') is False and args[0] != 'doctor'):
        raise SyncError(value.get('message', 'The WeChat reader failed.'))
    return value


def token(directory):
    if os.environ.get('BRAIN_INTERNAL_TOKEN'):
        return os.environ['BRAIN_INTERNAL_TOKEN'].strip()
    binary = directory / 'WeChat Brain Reader.app/Contents/MacOS/wechat-reader'
    try:
        result = subprocess.run([str(binary), 'token-get'], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        raise SyncError('Brain credential is unavailable. Unlock Keychain and allow access for the installed reader.') from None
    if result.returncode:
        raise SyncError('Brain credentials are missing or the Keychain is locked. Run configure.')
    return result.stdout.decode().strip()


def configuration(directory):
    path = directory / 'config.json'
    if not path.exists():
        atomic_json(path, {'version': 1, 'namespace': str(uuid.uuid4()), 'brain_url': 'https://brain.servo7.com',
                          'interval_seconds': 900, 'idle_seconds': 60, 'pages': 30, 'chats': []})
    return json.loads(path.read_text())


def validate_config(config):
    chats = config.get('chats', [])
    if not config.get('namespace') or not isinstance(chats, list):
        raise SyncError('Invalid sync configuration.')
    for key in ('id', 'name'):
        values = [chat.get(key) for chat in chats]
        if any(not isinstance(v, str) or not v.strip() for v in values) or len(values) != len(set(values)):
            raise SyncError(f'Every configured chat needs a unique {key}.')
    for chat in chats:
        if not chat.get('company_slug') or not chat.get('company_title'):
            raise SyncError('Every chat must be linked to a Brain company.')


def run_sync(directory, config, dry_run=False, scheduled=False, pages=None):
    validate_config(config)
    if not config['chats']:
        raise SyncError('No supplier chats are linked. Run chats, companies, then link.')
    status = reader(directory, 'doctor')
    if scheduled and (not status['ok'] or status['idle_seconds'] < config['idle_seconds']):
        return {'status': 'skipped', 'reason': 'Mac busy, locked, or WeChat unavailable'}
    if not status['ok']:
        raise SyncError('WeChat is not readable. Run doctor and enable Accessibility for the reader.')
    brain = None if dry_run else Brain(config['brain_url'], token(directory))
    store = Store(directory)
    if brain:
        manifest = brain.preflight()
        valid = {c['slug'] for c in manifest.get('companies', [])}
        if any(c['company_slug'] not in valid for c in config['chats']):
            raise SyncError('A linked supplier is missing from Brain. Relink it before syncing.')
        store.flush(brain)
    results = []
    for chat in config['chats']:
        capture = reader(directory, 'read', chat['name'], str(pages or config['pages']))
        if capture.get('chat') != chat['name']:
            raise SyncError('The reader returned the wrong conversation. Nothing imported.')
        snapshot = messages_from_rows(merge_pages(capture['pages']))
        if dry_run:
            added = new_messages(store.previous(chat['id']), snapshot)
            results.append({'chat': chat['name'], 'captured_messages': len(snapshot), 'new_messages': len(added),
                            'history_start_reached': capture['reached_start']})
        else:
            count = store.enqueue(config['namespace'], chat, snapshot, capture['captured_at'])
            store.flush(brain)
            note_ids = [r[0] for r in store.db.execute('''
                SELECT receipts.note_id FROM receipts JOIN batches USING(external_id)
                WHERE batches.chat_id=? ORDER BY batches.day
            ''', (chat['id'],)).fetchall()]
            results.append({'chat': chat['name'], 'new_messages': count, 'note_ids': note_ids,
                            'captured_messages': len(snapshot), 'history_start_reached': capture['reached_start']})
    return {'status': 'preview' if dry_run else 'synced', 'chats': results}


def schedule(directory, config, remove=False):
    destination = Path.home() / 'Library/LaunchAgents' / (SERVICE + '.plist')
    target = f'gui/{os.getuid()}'
    if remove:
        subprocess.run(['launchctl', 'bootout', target + '/' + SERVICE], capture_output=True)
        destination.unlink(missing_ok=True)
        return {'status': 'schedule_removed'}
    validate_config(config)
    if not config['chats']:
        raise SyncError('Link and successfully sync at least one supplier before scheduling.')
    if not (directory / 'last-success.json').exists():
        raise SyncError('Run a successful sync before enabling the schedule.')
    interval = config.get('interval_seconds', 900)
    if not isinstance(interval, int) or interval < 300:
        raise SyncError('The schedule interval must be at least 300 seconds.')
    subprocess.run(['launchctl', 'bootout', target + '/' + SERVICE], capture_output=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {'Label': SERVICE, 'ProgramArguments': [sys.executable, str(directory / 'sync.py'),
               '--state-dir', str(directory), 'sync', '--scheduled'], 'StartInterval': interval,
               'ProcessType': 'Background', 'StandardOutPath': str(directory / 'sync.log'),
               'StandardErrorPath': str(directory / 'sync.log'), 'Umask': 63,
               'EnvironmentVariables': {'PYTHONUNBUFFERED': '1'}}
    with destination.open('wb') as handle:
        plistlib.dump(payload, handle)
    os.chmod(destination, 0o600)
    subprocess.run(['launchctl', 'bootstrap', target, str(destination)], check=True)
    return {'status': 'scheduled', 'interval_seconds': interval}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=APP_DIR)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('doctor', 'chats', 'companies', 'configure', 'status', 'schedule', 'unschedule'):
        commands.add_parser(name)
    link = commands.add_parser('link')
    link.add_argument('chat')
    link.add_argument('--company', required=True, help='Exact Brain company slug')
    link.add_argument('--person', action='append', default=[])
    unlink = commands.add_parser('unlink')
    unlink.add_argument('chat')
    sync = commands.add_parser('sync')
    sync.add_argument('--dry-run', action='store_true')
    sync.add_argument('--scheduled', action='store_true')
    sync.add_argument('--pages', type=int)
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.state_dir.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    with (directory / 'sync.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError('Another sync is already running.') from None
        config = configuration(directory)
        if args.command == 'doctor':
            result = reader(directory, 'doctor')
            result['reader_app'] = str(directory / 'WeChat Brain Reader.app')
            try:
                client = Brain(config['brain_url'], token(directory))
                client.preflight()
                result['brain'] = 'ready'
            except SyncError as error:
                result['brain'] = str(error)
        elif args.command == 'configure':
            credential = getpass.getpass('Brain internal API token: ').strip()
            client = Brain(config['brain_url'], credential)
            client.preflight()
            binary = directory / 'WeChat Brain Reader.app/Contents/MacOS/wechat-reader'
            subprocess.run([str(binary), 'token-set'], input=credential.encode(), check=True, capture_output=True)
            result = {'status': 'credentials_saved_in_keychain'}
        elif args.command == 'chats':
            result = reader(directory, 'chats')
        elif args.command in ('companies', 'link'):
            client = Brain(config['brain_url'], token(directory))
            manifest = client.request('/api/manifest')
            companies = manifest.get('companies', [])
            if args.command == 'companies':
                result = {'companies': [{'slug': c['slug'], 'title': c['title']} for c in companies]}
            else:
                company = next((c for c in companies if c['slug'] == args.company), None)
                if not company:
                    raise SyncError('Company slug not found in Brain.')
                people = set(manifest.get('people_ranked', [])) | set(manifest.get('team', []))
                people |= {p['name'] for c in companies for p in c.get('people', [])}
                if any(person not in people for person in args.person):
                    raise SyncError('An attendee name does not exactly match a person in Brain.')
                visible = reader(directory, 'chats')['chats']
                if sum(c['name'] == args.chat for c in visible) != 1:
                    raise SyncError('Pin this chat in WeChat and give it a unique remark name, then retry.')
                old = next((c for c in config['chats'] if c['name'] == args.chat), None)
                if old:
                    raise SyncError('This chat is already linked. Unlink it explicitly before changing its supplier.')
                config['chats'].append({'id': str(uuid.uuid4()), 'name': args.chat, 'company_slug': company['slug'],
                                       'company_title': company['title'], 'attendees': args.person})
                atomic_json(directory / 'config.json', config)
                result = {'status': 'linked', 'chat': args.chat, 'company': company['title']}
        elif args.command == 'unlink':
            store = Store(directory)
            old = next((c for c in config['chats'] if c['name'] == args.chat), None)
            if not old:
                raise SyncError('Chat is not linked.')
            with store.db:
                for (external_id,) in store.db.execute('SELECT external_id FROM batches WHERE chat_id=?', (old['id'],)).fetchall():
                    store.db.execute('DELETE FROM outbox WHERE external_id=?', (external_id,))
            config['chats'] = [c for c in config['chats'] if c['id'] != old['id']]
            atomic_json(directory / 'config.json', config)
            result = {'status': 'unlinked', 'chat': args.chat}
        elif args.command == 'sync':
            result = run_sync(directory, config, args.dry_run, args.scheduled, args.pages)
            if result['status'] == 'synced':
                atomic_json(directory / 'last-success.json', {'at': dt.datetime.now(dt.timezone.utc).isoformat(), **result})
        elif args.command == 'status':
            store = Store(directory)
            result = {'chats': config['chats'], 'queued_uploads': store.db.execute('SELECT count(*) FROM outbox').fetchone()[0]}
            success = directory / 'last-success.json'
            result['last_success'] = json.loads(success.read_text()) if success.exists() else None
        else:
            result = schedule(directory, config, args.command == 'unschedule')
        print(encode(result))


if __name__ == '__main__':
    try:
        main()
    except (SyncError, subprocess.SubprocessError, OSError, ValueError) as error:
        print(encode({'status': 'error', 'message': str(error)}), file=sys.stderr)
        sys.exit(1)
