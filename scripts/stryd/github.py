"""Small, redacted GitHub API client. Authentication never goes in a URL."""
import hashlib
import json
import re
import time
import urllib.parse

from client import HTTP, SyncError, as_json


class GitHub:
    def __init__(self, repo, token, http=None):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo or '') or not token:
            raise SyncError('Configure GITHUB_REPOSITORY and GH_TOKEN')
        self.repo, self.token = repo, token
        self.http = http or HTTP()
        self.prefix = '/repos/' + repo

    def request(self, method, path, body=None):
        return self.http.request(method, 'https://api.github.com' + self.prefix + path,
            {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
             'X-GitHub-Api-Version': '2022-11-28'}, json_body=body, retry=method == 'GET')

    def call(self, method, path, body=None, allowed=(200,)):
        reply = self.request(method, path, body)
        if reply.status == 204 and 204 in allowed:
            return None
        return as_json(reply, 'GitHub', allowed)

    def pages(self, path):
        for page in range(1, 1001):
            data = self.call('GET', path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
            if not isinstance(data, list):
                raise SyncError('GitHub returned an unexpected list')
            yield from data
            if len(data) < 100:
                return
        raise SyncError('GitHub pagination limit exceeded')

    def read_file(self, path, ref):
        reply = self.http.request('GET', 'https://api.github.com' + self.prefix + '/contents/' + path +
            '?ref=' + urllib.parse.quote(ref, safe=''),
            {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github.raw+json'})
        if reply.status != 200:
            raise SyncError(f'GitHub file read returned HTTP {reply.status}')
        return reply.body

    def asset(self, asset_id):
        reply = self.http.request('GET', 'https://api.github.com' + self.prefix + '/releases/assets/' + str(int(asset_id)),
            {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/octet-stream'})
        if reply.status != 200:
            raise SyncError(f'GitHub asset read returned HTTP {reply.status}')
        return reply.body

    def upload(self, release_id, name, content, content_type='application/octet-stream', repair=False):
        expected = 'sha256:' + hashlib.sha256(content).hexdigest()
        # A failed response may hide a successful upload. Check before retrying,
        # and preserve every valid immutable asset. Public data publishers may
        # repair a failed upload after verifying their replacement bytes.
        for attempt in range(3):
            found = next((a for a in self.pages(f'/releases/{release_id}/assets') if a['name'] == name), None)
            if found:
                if found.get('state') == 'uploaded' and found.get('size') == len(content) and found.get('digest') == expected:
                    return found
                if not repair:
                    raise SyncError('Existing release asset does not match the expected bytes')
                self.call('DELETE', f'/releases/assets/{int(found["id"])}', allowed=(204,))
            try:
                reply = self.http.request('POST', 'https://uploads.github.com' + self.prefix +
                    f'/releases/{release_id}/assets?' + urllib.parse.urlencode({'name': name}),
                    {'Authorization': 'Bearer ' + self.token, 'Content-Type': content_type,
                     'Accept': 'application/vnd.github+json'}, payload=content, retry=False)
                uploaded = as_json(reply, 'GitHub asset upload', (201,))
                if uploaded.get('size') != len(content) or uploaded.get('digest') != expected:
                    raise SyncError('Uploaded asset checksum mismatch')
                return uploaded
            except SyncError:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise SyncError('Asset upload did not complete')
