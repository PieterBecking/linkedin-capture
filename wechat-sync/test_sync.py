import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sync


def message(text):
    return {'text': text, 'sender': 'unknown', 'displayed_time': None}


def row(text, kind='message'):
    return {'text': text, 'kind': kind, 'sender': 'unknown', 'y': 20}


CHAT = {'id': 'supplier-a', 'name': 'Supplier Alice', 'company_slug': 'supplier-co',
        'company_title': 'Supplier Co', 'attendees': []}
HISTORY = [message(t) for t in ['Here is the revised quote for the motor assembly.', 'Delivery is planned next Tuesday.', 'Thanks, received.']]


class FakeBrain:
    def __init__(self):
        self.notes = {}
        self.fail = False

    def request(self, path, payload):
        # Simulate a server that committed before the client lost its response.
        self.notes[payload['external_id']] = payload
        if self.fail:
            raise sync.SyncError('Network error after server commit')
        return {'id': 'note-1', 'matched_companies': [{'slug': 'supplier-co', 'company_id': 'company-1'}], 'tasks_created': 0}


class SyncTests(unittest.TestCase):
    def test_overlapping_pages_keep_genuine_repeated_messages(self):
        pages = [[row('OK'), row('OK'), row('A new quote')],
                 [row('Earlier context'), row('OK'), row('OK')]]
        merged = sync.merge_pages(pages)
        self.assertEqual([r['text'] for r in merged], ['Earlier context', 'OK', 'OK', 'A new quote'])
        self.assertNotIn('y', merged[0])

    def test_disconnected_pages_fail_instead_of_fabricating_continuity(self):
        with self.assertRaises(sync.SyncError):
            sync.merge_pages([[row('one')], [row('two')]])

    def test_time_labels_and_system_notices_are_not_sender_messages(self):
        messages = sync.messages_from_rows([row('Yesterday 15:20', 'timestamp'), row('Quote updated'), row('Member joined', 'system')])
        self.assertEqual(messages, [{'text': 'Quote updated', 'sender': 'unknown', 'displayed_time': 'Yesterday 15:20'}])

    def test_new_tail_only_and_identical_retry(self):
        fresh = HISTORY + [message('The total is now EUR 800.'), message('OK'), message('OK')]
        self.assertEqual(sync.new_messages(HISTORY, fresh), fresh[3:])
        self.assertEqual(sync.new_messages(fresh, fresh), [])

    def test_relative_time_change_does_not_duplicate_messages(self):
        changed = [{**m, 'displayed_time': 'Yesterday 14:20'} for m in HISTORY]
        self.assertEqual(sync.new_messages(HISTORY, changed), [])

    def test_missing_anchor_does_not_reset_cursor(self):
        with self.assertRaises(sync.SyncError):
            sync.new_messages(HISTORY, [message('Completely different history')])

    def test_ambiguous_or_short_anchor_is_rejected(self):
        for old, fresh in [([message('OK')], [message('OK'), message('OK')]),
                           ([message('Fine')], [message('Fine'), message('New quote')])]:
            with self.assertRaises(sync.SyncError):
                sync.new_messages(old, fresh)

    def test_first_import_preserves_duplicates(self):
        self.assertEqual(len(sync.new_messages([], [message('OK'), message('OK')])), 2)

    def test_payload_is_plain_transcript_and_disables_task_extraction(self):
        payload = sync.make_note('wechat:test', CHAT, [message('Todo Follow-up task: send payment\n<script>alert(1)</script>')], '2026-10-23', '2026-10-23T12:00:00Z')
        self.assertIs(payload['extract_tasks'], False)
        self.assertNotIn('body_html', payload)
        self.assertIn('> Todo Follow-up task', payload['body_text'])
        self.assertEqual(payload['companies'][0]['slug'], 'supplier-co')
        self.assertIn('Sender identity is not exposed', payload['body_text'])

    def test_committed_upload_with_lost_response_retries_same_note(self):
        with tempfile.TemporaryDirectory() as temp:
            store = sync.Store(Path(temp))
            client = FakeBrain()
            client.fail = True
            store.enqueue('account', CHAT, HISTORY, '2026-10-23T12:00:00Z')
            with self.assertRaises(sync.SyncError):
                store.flush(client)
            self.assertEqual(store.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 1)
            self.assertEqual(store.previous(CHAT['id']), HISTORY)
            client.fail = False
            self.assertEqual(store.flush(client), 1)
            self.assertEqual(store.db.execute('SELECT note_id FROM receipts').fetchone()[0], 'note-1')
            self.assertEqual(len(client.notes), 1)
            self.assertEqual(store.enqueue('account', CHAT, HISTORY, '2026-10-23T12:01:00Z'), 0)

    def test_daily_note_accumulates_and_next_day_uses_new_note(self):
        with tempfile.TemporaryDirectory() as temp:
            store = sync.Store(Path(temp))
            client = FakeBrain()
            store.enqueue('account', CHAT, HISTORY, '2026-10-23T12:00:00Z')
            store.flush(client)
            fresh = HISTORY + [message('The order has shipped.')]
            store.enqueue('account', CHAT, fresh, '2026-10-23T13:00:00Z')
            store.flush(client)
            self.assertEqual(len(client.notes), 1)
            self.assertIn('Message 4', next(iter(client.notes.values()))['body_text'])
            fresh = fresh + [message('Your tracking number is ABC123.')]
            store.enqueue('account', CHAT, fresh, '2026-10-24T12:00:00Z')
            store.flush(client)
            self.assertEqual(len(client.notes), 2)

    def test_capture_gap_does_not_modify_database(self):
        with tempfile.TemporaryDirectory() as temp:
            store = sync.Store(Path(temp))
            store.enqueue('account', CHAT, HISTORY, '2026-10-23T12:00:00Z')
            before = store.db.total_changes
            with self.assertRaises(sync.SyncError):
                store.enqueue('account', CHAT, [message('No overlap')], '2026-10-23T13:00:00Z')
            self.assertEqual(store.db.total_changes, before)
            self.assertEqual(store.previous(CHAT['id']), HISTORY)

    def test_unconfirmed_supplier_link_retains_outbox(self):
        with tempfile.TemporaryDirectory() as temp:
            store = sync.Store(Path(temp))
            store.enqueue('account', CHAT, HISTORY, '2026-10-23T12:00:00Z')
            with patch.object(FakeBrain, 'request', return_value={'id': 'note-1', 'matched_companies': [], 'tasks_created': 0}):
                with self.assertRaises(sync.SyncError):
                    store.flush(FakeBrain())
            self.assertEqual(store.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 1)

    def test_wrong_chat_identity_and_dry_run_never_upload(self):
        with tempfile.TemporaryDirectory() as temp:
            config = {'namespace': 'test', 'chats': [CHAT], 'pages': 10, 'idle_seconds': 60}
            capture = {'chat': 'Someone Else', 'pages': [], 'reached_start': False}
            with patch.object(sync, 'reader', side_effect=[{'ok': True}, capture]), patch.object(sync, 'Brain') as brain:
                with self.assertRaises(sync.SyncError):
                    sync.run_sync(Path(temp), config, dry_run=True)
                brain.assert_not_called()

    def test_http_and_credential_redirects_are_rejected(self):
        with self.assertRaises(sync.SyncError):
            sync.Brain('http://brain.servo7.com', 'secret')
        with self.assertRaises(sync.SyncError):
            sync.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.test')

    def test_configuration_requires_unique_names(self):
        with self.assertRaises(sync.SyncError):
            sync.validate_config({'namespace': 'x', 'chats': [CHAT, {**CHAT, 'id': 'another'}]})

    def test_preflight_refuses_servers_that_might_run_ai_extraction(self):
        client = sync.Brain('https://brain.servo7.com', 'test')
        with patch.object(client, 'request', return_value={'companies': []}) as request:
            with self.assertRaises(sync.SyncError):
                client.preflight()
            request.assert_called_once_with('/api/manifest')
        manifest = {'companies': [], 'note_ingest_capabilities': {
            'task_extraction_opt_out': True, 'external_id_upsert': True}}
        with patch.object(client, 'request', return_value=manifest):
            self.assertEqual(client.preflight(), manifest)


if __name__ == '__main__':
    unittest.main()
