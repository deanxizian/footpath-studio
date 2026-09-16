import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/stryd'))
from client import Reply, SafeRedirect, Stryd, SyncError, UTC
from sync import synchronize, node
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

    def test_uncertain_refresh_stops_the_whole_scan(self):
        http = FakeHTTP([Reply(401, b'', {}), SyncError('Network request failed')])
        source = Stryd(SESSION, http)
        source.calendar = lambda: [activity(1), activity(2)]
        result = synchronize(source, {}, {'runs': []}, self.directory, now=NOW)
        self.assertEqual(len(result['failed']), 1)
        self.assertIn('session', result['failed'][0]['reason'])
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
    def test_redirects_never_forward_password_or_cross_host_authentication(self):
        redirect = SafeRedirect()
        request = urllib.request.Request('https://api.stryd.com/b/email/signin',
            data=b'{"password":"sensitive-password"}', method='POST',
            headers={'Authorization': 'sensitive-token', 'Client-ID': 'sensitive-client',
                     'Cookie': 'sensitive-cookie', 'Content-Type': 'application/json'})
        for status in (301, 302, 303):
            forwarded = redirect.redirect_request(request, None, status, '', {}, 'https://other.example/path')
            self.assertEqual(forwarded.get_method(), 'GET')
            self.assertIsNone(forwarded.data)
            self.assertFalse({'authorization', 'client-id', 'cookie'} &
                             {name.lower() for name in forwarded.headers})
        for status in (307, 308):
            with self.assertRaises(urllib.error.HTTPError):
                redirect.redirect_request(request, None, status, '', {}, 'https://other.example/path')
        with self.assertRaisesRegex(SyncError, 'HTTPS redirect required'):
            redirect.redirect_request(request, None, 302, '', {}, 'http://api.stryd.com/path')

    def test_password_login_uses_the_flat_response_and_preserves_password(self):
        password = '  special # $ password  '
        http = FakeHTTP([reply({'id': 'test-user', 'token': 'test-access',
            'refresh_token': 'test-refresh', 'client_id': 'test-client'})])
        source = Stryd.login(' test@example.invalid ', password, http)
        self.assertEqual(source.session, SESSION)
        args, options = http.calls[0]
        self.assertEqual(args[:2], ('POST', 'https://api.stryd.com/b/email/signin'))
        self.assertEqual(options['json_body'], {'email': 'test@example.invalid', 'password': password})
        self.assertFalse(options['retry'])
        self.assertNotIn(password, json.dumps(source.session))

    def test_missing_credentials_do_not_attempt_login(self):
        for email, password in [(None, 'password'), ('user', None), (' ', 'password'), ('user', '')]:
            http = FakeHTTP([])
            with self.assertRaisesRegex(SyncError, 'STRYD_EMAIL and STRYD_PASSWORD'):
                Stryd.login(email, password, http)
            self.assertEqual(http.calls, [])

    def test_login_errors_do_not_log_response_or_retry(self):
        for response in [Reply(401, b'sensitive-response-token', {}),
                         Reply(403, b'sensitive-response-token', {}),
                         Reply(429, b'sensitive-response-token', {}),
                         reply({'error': 'sensitive-response-token'}),
                         reply({'id': 'user', 'token': 'sensitive-response-token',
                                'refresh_token': {'token': 'unexpected-nested-format'}, 'client_id': 'client'})]:
            http = FakeHTTP([response])
            with self.assertRaises(SyncError) as error:
                Stryd.login('user@example.invalid', 'sensitive-password', http)
            self.assertNotIn('sensitive', str(error.exception))
            self.assertEqual(len(http.calls), 1)
            self.assertFalse(http.calls[0][1]['retry'])

    def test_refresh_updates_memory_before_authenticated_retry(self):
        http = FakeHTTP([Reply(401, b'', {}), reply({'access_token': 'rotated',
            'refresh_token': {'token': 'new-refresh', 'client': {'id': 'new-client'}}}), reply({'ok': True})])
        source = Stryd(SESSION, http)
        source.get('/test')
        self.assertEqual(source.session['refresh_token'], 'new-refresh')
        self.assertFalse(http.calls[1][1]['retry'])
        self.assertEqual(http.calls[2][0][2]['Authorization'], 'Bearer: rotated')

    def test_refresh_failure_does_not_log_body_or_retry(self):
        http = FakeHTTP([Reply(403, b'secret-refresh-value', {})])
        with self.assertRaisesRegex(SyncError, 'no longer refresh') as result:
            Stryd(SESSION, http).refresh()
        self.assertNotIn('secret-refresh-value', str(result.exception))
        self.assertEqual(len(http.calls), 1)

    def test_build_subprocess_never_receives_account_credentials(self):
        secrets = {'STRYD_EMAIL': 'test-email', 'STRYD_PASSWORD': 'test-password',
                   'GH_TOKEN': 'test-gh', 'GITHUB_TOKEN': 'test-github',
                   'VERCEL_DEPLOY_HOOK': 'test-hook'}
        with patch.dict(os.environ, {**secrets, 'PATH': '/test/path'}), patch('sync.subprocess.run') as run:
            run.return_value.returncode = 0
            node('scripts/pack-public-history.mjs')
            environment = run.call_args.kwargs['env']
            self.assertTrue(all(key not in environment for key in secrets))
            self.assertEqual(environment['PATH'], '/test/path')

    def test_calendar_cursor_and_late_pages(self):
        older, newer = activity(1, days=200), activity(2)
        http = FakeHTTP([reply({'activities': [newer]}), reply({'activities': [newer]}),
                         reply({'activities': [older]}), reply({'activities': [older]}), reply({'activities': None})])
        runs = Stryd(SESSION, http).calendar()
        self.assertEqual([a['id'] for a in runs], [1, 2])
        self.assertIn('from=1&to=', http.calls[2][0][1])



if __name__ == "__main__":
    unittest.main()
