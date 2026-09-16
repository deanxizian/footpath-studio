#!/usr/bin/env python3
"""Incrementally archive the account's uploaded Stryd Footpath records."""
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

API = 'https://api.stryd.com'
UTC = dt.timezone.utc
CHINA = dt.timezone(dt.timedelta(hours=8))
MAX_BODY = 256 * 1024 * 1024


class SyncError(Exception):
    """Safe user-facing error. Never put response bodies, tokens or signed URLs here."""


@dataclass
class Reply:
    status: int
    body: bytes
    headers: object


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme != 'https':
            raise SyncError('HTTPS redirect required')
        forwarded = super().redirect_request(req, fp, code, msg, headers, newurl)
        if forwarded and old.netloc != new.netloc:
            for key in list(forwarded.headers):
                if key.lower() in ('authorization', 'client-id', 'cookie'):
                    del forwarded.headers[key]
        return forwarded


class HTTP:
    def __init__(self):
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, method, url, headers=None, payload=None, json_body=None, retry=True):
        if urllib.parse.urlsplit(url).scheme != 'https':
            raise SyncError('HTTPS URL required')
        h = {'User-Agent': 'footpath-studio-sync/1.0', **(headers or {})}
        if json_body is not None:
            payload = json.dumps(json_body).encode()
            h['Content-Type'] = 'application/json'
        attempts = 4 if retry else 1
        for attempt in range(attempts):
            try:
                req = urllib.request.Request(url, data=payload, headers=h, method=method)
                with self.opener.open(req, timeout=60) as response:
                    raw = response.read(MAX_BODY + 1)
                    if len(raw) > MAX_BODY:
                        raise SyncError('Response exceeds the 256 MiB safety limit')
                    return Reply(response.status, raw, response.headers)
            except urllib.error.HTTPError as error:
                status, response_headers = error.code, error.headers
                error.close()
                if status not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                    return Reply(status, b'', response_headers)
                try:
                    delay = min(30, max(1, float(response_headers.get('Retry-After', 2 ** attempt))))
                except (TypeError, ValueError):
                    delay = 2 ** attempt
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                if attempt == attempts - 1:
                    raise SyncError('Network request failed; details omitted to protect credentials') from None
                delay = 2 ** attempt
            time.sleep(delay)
        raise SyncError('Request did not complete')


def as_json(reply, service, allowed=(200,)):
    if reply.status not in allowed:
        raise SyncError(f'{service} returned HTTP {reply.status}')
    try:
        return json.loads(reply.body)
    except (ValueError, UnicodeError):
        raise SyncError(f'{service} returned invalid JSON') from None


def numeric_id(value):
    result = str(value)
    if not re.fullmatch(r'[1-9][0-9]{0,19}', result):
        raise SyncError('Invalid activity or Footpath identifier')
    return result


class Stryd:
    def __init__(self, session, on_refresh, http=None):
        self.session = dict(session)
        self.on_refresh = on_refresh
        self.http = http or HTTP()

    def refresh(self):
        if not self.session.get('refresh_token') or not self.session.get('client_id'):
            raise SyncError('Stryd session expired. Reconnect Stryd using docs/stryd-sync.md.')
        # Refresh tokens may rotate. Never retry this POST after an uncertain response.
        reply = self.http.request('POST', API + '/b/token/refresh',
            {'Authorization': 'Bearer: ' + self.session['access_token'], 'Client-ID': self.session['client_id']},
            json_body={'refresh_token': self.session['refresh_token'], 'user_id': self.session['user_id']}, retry=False)
        if reply.status in (401, 403):
            raise SyncError('Stryd session can no longer refresh. Reconnect Stryd using docs/stryd-sync.md.')
        data = as_json(reply, 'Stryd session refresh')
        try:
            updated = {**self.session, 'access_token': data['access_token'], 'refresh_token': data['refresh_token']['token'], 'client_id': data['refresh_token']['client']['id']}
            if not all(isinstance(updated[k], str) and updated[k] for k in ('access_token', 'refresh_token', 'client_id')):
                raise KeyError('invalid session')
        except (KeyError, TypeError):
            raise SyncError('Stryd returned an unrecognized session format') from None
        self.session = updated
        self.on_refresh(updated)

    def get(self, path):
        reply = self.http.request('GET', API + path, {'Authorization': 'Bearer: ' + self.session['access_token']})
        if reply.status == 401:
            self.refresh()
            reply = self.http.request('GET', API + path, {'Authorization': 'Bearer: ' + self.session['access_token']})
        if reply.status in (401, 403):
            raise SyncError(f'Stryd access denied (HTTP {reply.status}); no permission bypass attempted')
        return reply

    def page(self, **parameters):
        base = f'/b/api/v1/users/{urllib.parse.quote(self.session["user_id"], safe="")}/calendar?'
        query = {'limit': 120, 'fields': 'ua', 'include_deleted': 'false', **parameters}
        body = as_json(self.get(base + urllib.parse.urlencode(query)), 'Stryd calendar')
        activities = body.get('activities')
        if 'activities' in body and activities is None:
            return []
        if not isinstance(activities, list):
            raise SyncError('Stryd calendar format changed')
        return activities

    def calendar(self):
        cursor = None
        by_id = {}
        for _ in range(200):
            # Stryd ignores `to` unless the lower range bound is also present.
            page = self.page(**({'from': 1, 'to': cursor} if cursor is not None else {}))
            if not page:
                return sorted(by_id.values(), key=lambda a: (a['timestamp'], str(a['id'])))
            for activity in page:
                if not isinstance(activity.get('timestamp'), (int, float)):
                    raise SyncError('Calendar activity has no timestamp')
                numeric_id(activity['id'])
                by_id.setdefault(str(activity['id']), activity)
            oldest = int(min(a['timestamp'] for a in page))
            if cursor is not None and oldest > cursor:
                raise SyncError('Calendar ignored its pagination cursor')
            # A zero-length range returns no records; straddle the boundary second.
            boundary = self.page(**{'from': oldest - 1, 'to': oldest + 1})
            if len(boundary) >= 120 or any(not oldest - 1 <= a['timestamp'] <= oldest + 1 for a in boundary):
                raise SyncError('Calendar boundary could not be paginated safely')
            for activity in boundary:
                numeric_id(activity['id'])
                by_id.setdefault(str(activity['id']), activity)
            next_cursor = oldest - 1
            if cursor is not None and next_cursor >= cursor:
                raise SyncError('Calendar pagination made no progress')
            cursor = next_cursor
        raise SyncError('Calendar pagination exceeded 200 pages')

    def footpath(self, activity, etag=None):
        activity_id = numeric_id(activity['id'])
        path = f'/b/api/v1/users/{urllib.parse.quote(self.session["user_id"], safe="")}/activities/{activity_id}/footdata'
        reply = self.get(path)
        if reply.status in (404, 409, 422):
            return None
        descriptor = as_json(reply, 'Stryd Footpath link')
        url = descriptor.get('foot_data_url')
        parsed = urllib.parse.urlsplit(url or '')
        if parsed.scheme != 'https' or parsed.hostname != 'storage.googleapis.com' or parsed.username or parsed.password:
            raise SyncError('Unexpected Footpath storage host; update the allowlist only after verification')
        headers = {'If-None-Match': etag} if etag else {}
        raw = self.http.request('GET', url, headers)
        if raw.status == 304:
            return 'unchanged'
        if raw.status in (404, 409):
            return None
        if raw.status in (401, 403):
            raise SyncError('Footpath download was denied by storage')
        as_json(raw, 'Footpath storage')
        return raw

