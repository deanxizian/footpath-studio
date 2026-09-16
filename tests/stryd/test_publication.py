import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/stryd'))
from client import Reply, SyncError
from publication import MANIFEST, deploy_site, latest_manifest, publish, replace_manifest, validate_baseline
from github import GitHub
from sync import require_current_main


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ReleaseOnlyGit:
    repo = 'owner/repo'
    def __init__(self):
        self.releases, self.assets, self.data, self.calls = {}, {}, {}, []
        self.latest, self.fail_upload = None, None
    def pages(self, path):
        if path == '/releases':
            return list(self.releases.values())
        return [a for a in self.assets.values() if a['release_id'] == int(path.split('/')[2])]
    def call(self, method, path, body=None, allowed=None):
        # Any Git/PR/Actions endpoint is forbidden, including on update/recovery.
        assert path.startswith('/releases'), (method, path)
        self.calls.append((method, path, body))
        if path == '/releases/latest':
            return self.releases[self.latest]
        if method == 'POST':
            identifier = len(self.releases) + 1
            release = dict(id=identifier, **body)
            self.releases[identifier] = release
            return release
        identifier = int(path.rsplit('/', 1)[1])
        if method == 'DELETE':
            del self.assets[identifier]
            del self.data[identifier]
            return
        if method == 'PATCH':
            self.releases[identifier].update(body)
            if body.get('make_latest') == 'true':
                self.latest = identifier
            elif body.get('make_latest') == 'false' and self.latest == identifier:
                self.latest = None
            return self.releases[identifier]
        return self.releases[identifier]
    def upload(self, release_id, name, content, content_type=None, repair=False):
        if self.fail_upload == name:
            self.fail_upload = None
            raise SyncError('upload failed')
        found = next((a for a in self.pages(f'/releases/{release_id}/assets') if a['name'] == name), None)
        if found:
            if found['state'] == 'uploaded' and found['size'] == len(content) and found['digest'] == 'sha256:' + sha(content):
                assert self.data[found['id']] == content
                return found
            assert repair
            self.call('DELETE', f'/releases/assets/{found["id"]}')
        identifier = max(self.assets, default=0) + 1
        asset = dict(id=identifier, release_id=release_id, name=name, size=len(content),
                     digest='sha256:' + sha(content), state='uploaded')
        self.assets[identifier], self.data[identifier] = asset, content
        return asset
    def asset(self, identifier):
        return self.data[identifier]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.github = ReleaseOnlyGit()
    def fixture(self, months, version='first'):
        def asset(month, name):
            content = (month + name + version).encode()
            name += '-' + sha(content) + '.tar'
            path = self.directory / ('footpath-' + month) / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(content)
            return dict(url=f'https://github.com/owner/repo/releases/download/footpath-{month}/{name}',
                        sha256=sha(content), bytes=len(content), fileCount=3)
        return dict(format='footpath-studio-monthly-history-v2', latestMonth=max(months),
                    runCount=len(months), revision=sha(version.encode()),
                    catalog=asset(max(months), 'footpath-catalog'),
                    months=[dict(month=m, runCount=1, revision=sha((m + version).encode()),
                                 **asset(m, 'footpath-' + m)) for m in months])
    def test_updates_and_month_rollover_reuse_releases_without_git_writes(self):
        first = self.fixture(['2026-08', '2026-09'])
        publish(self.github, first, self.directory, 'existing-main-sha')
        self.assertEqual(len(self.github.releases), 2)
        self.assertEqual(latest_manifest(self.github), first)
        before = len(self.github.assets)
        publish(self.github, first, self.directory, 'existing-main-sha')
        self.assertEqual(len(self.github.assets), before)
        revised = self.fixture(['2026-08', '2026-09'], 'revised')
        revised['months'][0] = first['months'][0]
        publish(self.github, revised, self.directory, 'existing-main-sha')
        self.assertEqual(len(self.github.releases), 2)
        self.assertEqual(latest_manifest(self.github), revised)
        third = self.fixture(['2026-08', '2026-09', '2026-10'], 'next')
        third['months'][:2] = revised['months']
        publish(self.github, third, self.directory, 'existing-main-sha')
        self.assertEqual(len(self.github.releases), 3)
        self.assertEqual(latest_manifest(self.github), third)
        self.assertEqual(self.github.releases[self.github.latest]['tag_name'], 'footpath-2026-10')
    def test_failed_month_upload_keeps_previous_global_manifest(self):
        first = self.fixture(['2026-09'])
        publish(self.github, first, self.directory, 'main')
        new = self.fixture(['2026-09', '2026-10'], 'next')
        new['months'][0] = first['months'][0]
        self.github.fail_upload = Path(new['months'][1]['url']).name
        with self.assertRaises(SyncError):
            publish(self.github, new, self.directory, 'main')
        self.assertEqual(latest_manifest(self.github), first)
        publish(self.github, new, self.directory, 'main')
        self.assertEqual(latest_manifest(self.github), new)
        self.assertEqual(len(self.github.releases), 2)
    def test_month_metadata_updates_preserve_latest_until_discovery_commit(self):
        first = self.fixture(['2026-08', '2026-09'])
        publish(self.github, first, self.directory, 'main')
        revised = self.fixture(['2026-08', '2026-09'], 'revised')
        def still_first():
            self.assertEqual(latest_manifest(self.github), first)
        publish(self.github, revised, self.directory, 'main', before_discovery=still_first)
        self.assertEqual(latest_manifest(self.github), revised)
        next_month = self.fixture(['2026-08', '2026-09', '2026-10'], 'next')
        def still_revised():
            self.assertEqual(latest_manifest(self.github), revised)
        publish(self.github, next_month, self.directory, 'main', before_discovery=still_revised)
        self.assertEqual(latest_manifest(self.github), next_month)
    def test_alias_failure_rolls_back_and_killed_runner_can_repair(self):
        first = self.fixture(['2026-09'])
        publish(self.github, first, self.directory, 'main')
        identifier = self.github.latest
        before = next(a for a in self.github.pages(f'/releases/{identifier}/assets') if a['name'] == MANIFEST)
        original = self.github.asset(before['id'])
        self.github.fail_upload = MANIFEST
        with self.assertRaises(SyncError):
            replace_manifest(self.github, identifier, b'new alias')
        alias = next(a for a in self.github.pages(f'/releases/{identifier}/assets') if a['name'] == MANIFEST)
        self.assertEqual(self.github.asset(alias['id']), original)
        self.github.call('DELETE', f'/releases/assets/{alias["id"]}')
        self.assertEqual(latest_manifest(self.github), first)
        self.assertTrue(any(a['name'] == MANIFEST for a in self.github.assets.values()))
    def test_incomplete_and_mismatched_month_uploads_are_repaired(self):
        manifest = self.fixture(['2026-09'])
        publish(self.github, manifest, self.directory, 'main')
        month_name = Path(manifest['months'][0]['url']).name
        for field, value in [('state', 'starter'), ('digest', 'sha256:' + '0' * 64), ('size', 1)]:
            item = next(a for a in self.github.assets.values() if a['name'] == month_name)
            item[field] = value
            publish(self.github, manifest, self.directory, 'main')
            repaired = next(a for a in self.github.assets.values() if a['name'] == month_name)
            self.assertEqual(repaired['state'], 'uploaded')
            self.assertEqual(repaired['digest'], 'sha256:' + manifest['months'][0]['sha256'])
            self.assertEqual(repaired['size'], manifest['months'][0]['bytes'])
            self.assertEqual(len(self.github.releases), 1)
        alias = next(a for a in self.github.assets.values() if a['name'] == MANIFEST)
        alias['state'] = 'starter'
        self.assertEqual(latest_manifest(self.github), manifest)
        self.assertTrue(all(a['state'] == 'uploaded' for a in self.github.assets.values()))
    def test_main_change_before_discovery_keeps_last_complete_manifest(self):
        old = self.fixture(['2026-09'])
        publish(self.github, old, self.directory, 'main')
        new = self.fixture(['2026-09'], 'updated')
        def changed():
            raise SyncError('Main changed during sync')
        with self.assertRaisesRegex(SyncError, 'Main changed'):
            publish(self.github, new, self.directory, 'old-main', before_discovery=changed)
        self.assertEqual(latest_manifest(self.github), old)
    def test_credentials_and_cross_repository_urls_cannot_be_published(self):
        manifest = self.fixture(['2026-09'])
        for url in ['https://github.com/owner/repo/releases/download/stryd-sync-state/state.enc.json',
                    manifest['catalog']['url'].replace('/owner/', '/other/')]:
            invalid = copy.deepcopy(manifest)
            invalid['catalog']['url'] = url
            with self.assertRaises(SyncError):
                publish(self.github, invalid, self.directory, 'main')
        self.assertEqual(self.github.calls, [])


class UploadRecoveryTests(unittest.TestCase):
    def test_upload_retries_incomplete_asset_without_touching_valid_assets(self):
        content = b'verified replacement'
        good = dict(id=2, name='month.tar', size=len(content), digest='sha256:' + sha(content), state='uploaded')
        bad = dict(id=1, name='month.tar', size=0, digest=None, state='starter')
        class HTTP:
            def __init__(self, values):
                self.values, self.calls = values, []
            def request(self, method, url, *args, **kwargs):
                self.calls.append((method, url))
                return self.values.pop(0)
        http = HTTP([Reply(200, json.dumps([bad]).encode(), {}), Reply(204, b'', {}), Reply(201, json.dumps(good).encode(), {})])
        self.assertEqual(GitHub('owner/repo', 'fake-token', http).upload(1, 'month.tar', content, repair=True), good)
        self.assertEqual([c[0] for c in http.calls], ['GET', 'DELETE', 'POST'])
        http = HTTP([Reply(200, json.dumps([good]).encode(), {})])
        self.assertEqual(GitHub('owner/repo', 'fake-token', http).upload(1, 'month.tar', content, repair=True), good)
        self.assertEqual([c[0] for c in http.calls], ['GET'])
    def test_main_revision_guard(self):
        class Git:
            def call(self, method, path):
                return {'object': {'sha': 'b' * 40}}
        require_current_main(Git(), 'b' * 40)
        with self.assertRaisesRegex(SyncError, 'Main changed'):
            require_current_main(Git(), 'a' * 40)
        with self.assertRaisesRegex(SyncError, 'checked-out'):
            require_current_main(Git(), None)


class DeploymentTests(unittest.TestCase):
    hook = 'https://api.vercel.com/v1/integrations/deploy/prj_example/example'
    site = 'https://example.vercel.app'
    def http(self, values):
        class Client:
            def __init__(self):
                self.calls = []
            def request(self, method, url, *args, **kwargs):
                self.calls.append((method, url, kwargs))
                value = values.pop(0)
                return Reply(200, json.dumps(value).encode(), {})
        return Client()
    def test_current_data_does_not_trigger_deployment(self):
        http = self.http([{'revision': 'new'}])
        self.assertEqual(deploy_site('new', self.hook, self.site, http=http), 'current')
        self.assertEqual([c[0] for c in http.calls], ['GET'])
    def test_failed_build_retries_on_next_run_without_new_data(self):
        http = self.http([{'revision': 'old'}, {'job': {'id': 'job'}}, {'revision': 'old'}])
        with self.assertRaisesRegex(SyncError, 'next sync will retry'):
            deploy_site('new', self.hook, self.site, http=http, pause=lambda _: None, attempts=1)
        second = self.http([{'revision': 'old'}, {'job': {'id': 'job2'}}, {'revision': 'new'}])
        self.assertEqual(deploy_site('new', self.hook, self.site, http=second, pause=lambda _: None), 'updated')
        self.assertEqual(second.calls[1][0], 'POST')
        self.assertFalse(second.calls[1][2]['retry'])
    def test_hook_errors_omit_secret_address_and_body(self):
        class HTTP:
            def request(self, method, *args, **kwargs):
                return Reply(403 if method == 'POST' else 404, b'secret response', {})
        with self.assertRaisesRegex(SyncError, '^Vercel deployment trigger returned HTTP 403$'):
            deploy_site('new', self.hook, self.site, http=HTTP())


if __name__ == '__main__':
    unittest.main()
