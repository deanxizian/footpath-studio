import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/stryd'))
from auth import AUTH_TAG, StateStore, decrypt, encrypt, new_key
from client import Reply, Stryd, SyncError, UTC
from sync import synchronize
from transform import pack_run, digest

SESSION = dict(user_id='test-user', access_token='test-access', refresh_token='test-refresh', client_id='test-client')
NOW = dt.datetime(2026, 9, 16, tzinfo=UTC)


def activity(identifier=1, days=0):
    return dict(id=identifier, foot_data_id=identifier + 100,
                timestamp=(NOW - dt.timedelta(days=days)).timestamp(), name='Test run')


def raw(act, speed=3):
    return json.dumps({'timestamp': act['timestamp'], 'foot_data_list': [
        {'side': 1, 'timestamp': act['timestamp'], 'speed': speed,
         'positions': [{'x': -0.0, 'y': 0.2, 'z': 1}, {'x': 1, 'y': 0, 'z': 0}]}]}).encode()


def reply(value, status=200):
    return Reply(status, json.dumps(value).encode(), {})


class FakeHTTP:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class FakeStryd:
    def __init__(self, activities, responses=None):
        self.activities, self.responses, self.calls = activities, responses or {}, []

    def calendar(self):
        return self.activities

    def footpath(self, act, etag=None):
        self.calls.append((act['id'], etag))
        result = self.responses.get(act['id'], Reply(200, raw(act), {'ETag': 'test-etag'}))
        if isinstance(result, Exception):
            raise result
        return result


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.sleep = patch('sync.time.sleep')
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def test_late_old_upload_and_no_change_dedup(self):
        source, state = FakeStryd([activity(days=200)]), {}
        result = synchronize(source, state, {'runs': []}, self.directory, now=NOW)
        self.assertEqual((result['new'], result['total']), (1, 1))
        from sync import read_history
        history = read_history(self.directory)
        self.assertEqual(history['runs'][0]['id'], '101')
        result = synchronize(source, state, history, self.directory, now=NOW)
        self.assertEqual((result['new'], len(source.calls)), (0, 1))

    def test_recent_etag_recheck_and_metadata_update(self):
        from sync import read_history
        act, state = activity(), {}
        source = FakeStryd([act])
        synchronize(source, state, {'runs': []}, self.directory, now=NOW)
        history = read_history(self.directory)
        source.responses[1] = 'unchanged'
        result = synchronize(source, state, history, self.directory, now=NOW + dt.timedelta(days=1))
        self.assertEqual(result['unchanged'], 1)
        self.assertEqual(source.calls[-1], (1, 'test-etag'))
        act['name'] = 'Renamed run'
        source.responses[1] = Reply(200, raw(act), {})
        result = synchronize(source, state, history, self.directory, now=NOW + dt.timedelta(days=2))
        self.assertEqual(result['revised'], 1)
        self.assertIn('Renamed run', read_history(self.directory)['runs'][0]['title'])

    def test_unpublished_revision_is_retried_same_day(self):
        from sync import read_history
        act, state = activity(), {}
        source = FakeStryd([act])
        synchronize(source, state, {'runs': []}, self.directory, now=NOW)
        baseline = read_history(self.directory)
        state['checks']['101']['checked'] = ''
        source.responses[1] = Reply(200, raw(act, speed=4), {'ETag': 'revised'})
        synchronize(source, state, baseline, self.directory, now=NOW)
        # Simulate failure before the new data was published; the baseline is old.
        again = synchronize(source, state, baseline, self.directory, now=NOW)
        self.assertEqual(again['revised'], 1)
        self.assertEqual(source.calls[-1], (1, None))

    def test_pending_record_does_not_starve_new_records(self):
        source, state = FakeStryd([activity(1), activity(2)], {1: None}), {}
        first = synchronize(source, state, {'runs': []}, self.directory, maximum=1, now=NOW)
        second = synchronize(source, state, {'runs': []}, self.directory, maximum=1, now=NOW + dt.timedelta(days=1))
        self.assertEqual((first['pending'], first['remaining'], second['new']), (1, 1, 1))
        self.assertEqual(source.calls[-1][0], 2)

    def test_access_denied_stops_before_more_downloads(self):
        source = FakeStryd([activity(1), activity(2)], {1: SyncError('Stryd access denied')})
        result = synchronize(source, {}, {'runs': []}, self.directory, now=NOW)
        self.assertEqual(len(result['failed']), 1)
        self.assertEqual(len(source.calls), 1)

    def test_refresh_network_or_storage_failure_stops_the_whole_scan(self):
        rotated = reply({'access_token': 'rotated', 'refresh_token': {'token': 'r', 'client': {'id': 'c'}}})
        for refresh_reply in [SyncError('Network request failed'), rotated]:
            http = FakeHTTP([Reply(401, b'', {}), refresh_reply])
            def fail(_):
                raise SyncError('GitHub asset upload returned HTTP 503')
            source = Stryd(SESSION, fail, http)
            source.calendar = lambda: [activity(1), activity(2)]
            result = synchronize(source, {}, {'runs': []}, self.directory, now=NOW)
            self.assertEqual(len(result['failed']), 1)
            self.assertIn('session', result['failed'][0]['reason'])
            # Do not try another refresh via the next activity after an uncertain
            # POST, or use the rotated token before persistence has succeeded.
            self.assertEqual(len(http.calls), 2)

    def test_geometry_rejects_mismatched_run_and_preserves_coordinates(self):
        act = activity()
        content = raw(act)
        result = pack_run({'raw_sha256': digest(content), 'activity': act, 'foot_data_id': 101}, content, self.directory)
        self.assertEqual(result['rows'][0][4:7], [1, .2, 1])
        act['timestamp'] += 120
        with self.assertRaisesRegex(SyncError, 'timestamps'):
            pack_run({'raw_sha256': digest(content), 'activity': act, 'foot_data_id': 101}, content, self.directory)


class SessionTests(unittest.TestCase):
    def test_refresh_persists_before_authenticated_retry(self):
        http = FakeHTTP([Reply(401, b'', {}), reply({'access_token': 'rotated',
            'refresh_token': {'token': 'new-refresh', 'client': {'id': 'new-client'}}}), reply({'ok': True})])
        def save(session):
            self.assertEqual(len(http.calls), 2)
            self.assertEqual(session['refresh_token'], 'new-refresh')
        Stryd(SESSION, save, http).get('/test')
        self.assertFalse(http.calls[1][1]['retry'])
        self.assertEqual(http.calls[2][0][2]['Authorization'], 'Bearer: rotated')

    def test_refresh_failure_does_not_log_body_or_retry(self):
        http = FakeHTTP([Reply(403, b'secret-refresh-value', {})])
        with self.assertRaisesRegex(SyncError, 'no longer refresh') as result:
            Stryd(SESSION, lambda _: None, http).refresh()
        self.assertNotIn('secret-refresh-value', str(result.exception))
        self.assertEqual(len(http.calls), 1)

    def test_persist_failure_stops_before_retry(self):
        http = FakeHTTP([Reply(401, b'', {}), reply({'access_token': 'rotated',
            'refresh_token': {'token': 'r', 'client': {'id': 'c'}}})])
        def fail(_):
            raise SyncError('session persistence failed')
        with self.assertRaisesRegex(SyncError, 'persistence'):
            Stryd(SESSION, fail, http).get('/test')
        self.assertEqual(len(http.calls), 2)

    def test_authenticated_encryption_and_no_plaintext(self):
        key, state = new_key(), {'session': SESSION, 'checks': {}}
        envelope = encrypt(state, key)
        self.assertNotIn(SESSION['access_token'].encode(), envelope)
        self.assertEqual(decrypt(envelope, key), state)
        self.assertNotEqual(envelope, encrypt(state, key))
        with self.assertRaises(SyncError):
            decrypt(envelope, new_key())

    def test_public_or_wrong_release_is_never_used(self):
        class Git:
            def call(self, *args):
                return dict(draft=False, tag_name=AUTH_TAG)
        store = StateStore(Git(), 123, new_key())
        for operation in [store.load, lambda: store.save({'session': SESSION})]:
            with self.assertRaisesRegex(SyncError, 'unpublished draft'):
                operation()

    def test_newest_incomplete_state_never_falls_back(self):
        class Git:
            def call(self, *args):
                return dict(draft=True, tag_name=AUTH_TAG)
            def pages(self, *args):
                return [dict(id=1, name='state-1.enc.json', state='uploaded'),
                        dict(id=2, name='state-2.enc.json', state='starter')]
        with self.assertRaisesRegex(SyncError, 'incomplete'):
            StateStore(Git(), 123, new_key()).load()

    def test_state_retention_only_prunes_after_successful_readback(self):
        key = new_key()
        old_state = {'session': SESSION, 'checks': {}}
        new_state = {'session': {**SESSION, 'access_token': 'rotated'}, 'checks': {}}
        class Git:
            def __init__(self, corrupt=False):
                self.data = {i: encrypt(old_state, key) for i in range(1, 26)}
                self.deleted, self.corrupt = [], corrupt
            def call(self, method, path, **kwargs):
                if method == 'DELETE':
                    # The newest state must already be durable when deletion begins.
                    self.assert_latest = decrypt(self.data[max(self.data)], key)
                    identifier = int(path.rsplit('/', 1)[1])
                    self.deleted.append(identifier)
                    del self.data[identifier]
                    return None
                return dict(draft=True, tag_name=AUTH_TAG)
            def pages(self, path):
                return [dict(id=i, name=f'state-{i}.enc.json', state='uploaded') for i in self.data]
            def upload(self, release_id, name, content, content_type):
                self.data[max(self.data) + 1] = content
            def asset(self, identifier):
                return b'invalid encrypted state' if self.corrupt else self.data[identifier]
        github = Git()
        StateStore(github, 123, key).save(new_state)
        self.assertEqual(len(github.data), 20)
        self.assertEqual(github.deleted, [6, 5, 4, 3, 2, 1])
        self.assertEqual(github.assert_latest, new_state)
        self.assertEqual(decrypt(github.data[26], key), new_state)
        broken = Git(corrupt=True)
        with self.assertRaises(SyncError):
            StateStore(broken, 123, key).save(new_state)
        self.assertEqual(broken.deleted, [])

    def test_calendar_cursor_and_late_pages(self):
        older, newer = activity(1, days=200), activity(2)
        http = FakeHTTP([reply({'activities': [newer]}), reply({'activities': [newer]}),
                         reply({'activities': [older]}), reply({'activities': [older]}), reply({'activities': None})])
        runs = Stryd(SESSION, lambda _: None, http).calendar()
        self.assertEqual([a['id'] for a in runs], [1, 2])
        self.assertIn('from=1&to=', http.calls[2][0][1])



if __name__ == "__main__":
    unittest.main()
