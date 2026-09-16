import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/stryd'))
from checkpoints import FORMAT, load_checks, save_checks
from sync import synchronize
from test_sync import FakeStryd, activity


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'checks.json'

    def test_missing_invalid_and_future_cache_can_be_rebuilt(self):
        self.assertEqual(load_checks(self.path), {'checks': {}})
        for content in [b'broken JSON', b'[]', b'{"format":"old-format"}',
                        json.dumps({'format': FORMAT, 'checks': []}).encode()]:
            self.path.write_bytes(content)
            self.assertEqual(load_checks(self.path), {'checks': {}})
        future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)).isoformat()
        self.path.write_text(json.dumps({'format': FORMAT, 'checks': {
            '101': {'attempted': future, 'checked': future, 'sourceHash': 'invalid', 'etag': '\ninvalid'},
            '../outside': {'etag': 'invalid'},
        }}))
        self.assertEqual(load_checks(self.path), {'checks': {}})

    def test_only_fetch_progress_is_serialized_never_sessions_or_secrets(self):
        stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).isoformat()
        expected = {'attempted': stamp, 'checked': stamp, 'etag': '"verified-object-etag"', 'sourceHash': 'a' * 64}
        state = {'session': {'access_token': 'secret-access', 'refresh_token': 'secret-refresh'},
                 'password': 'secret-password', 'checks': {'101': {**expected, 'password': 'secret-nested'}}}
        save_checks(self.path, state)
        content = self.path.read_bytes()
        self.assertNotIn(b'secret-', content)
        self.assertNotIn(b'session', content)
        self.assertNotIn(b'password', content)
        self.assertEqual(load_checks(self.path), {'checks': {'101': expected}})

    def test_restored_progress_preserves_fairness_and_missing_cache_still_fetches(self):
        now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=2)
        source = FakeStryd([activity(1), activity(2)], {1: None})
        state = load_checks(self.path)
        with patch('sync.time.sleep'):
            first = synchronize(source, state, {'runs': []}, Path(self.temp.name), maximum=1, now=now)
            save_checks(self.path, state)
            second = synchronize(source, load_checks(self.path), {'runs': []}, Path(self.temp.name), maximum=1,
                                 now=now + dt.timedelta(minutes=1))
            self.assertEqual((first['pending'], second['new']), (1, 1))
            self.assertEqual(source.calls[-1][0], 2)
            self.path.unlink()
            source = FakeStryd([activity(3)])
            rebuilt = synchronize(source, load_checks(self.path), {'runs': []}, Path(self.temp.name), now=now)
            self.assertEqual(rebuilt['new'], 1)


if __name__ == '__main__':
    unittest.main()
