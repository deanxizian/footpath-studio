"""AES-GCM encrypted state in an unpublished, access-controlled draft Release."""
import base64
import datetime as dt
import json
import os
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from client import SyncError, UTC

AUTH_TAG = 'stryd-sync-state'
AAD = b'footpath-studio/stryd-state/v1'


def new_key():
    return base64.urlsafe_b64encode(AESGCM.generate_key(bit_length=256)).decode()


def encrypt(state, key):
    nonce = os.urandom(12)
    data = json.dumps(state, separators=(',', ':'), allow_nan=False).encode()
    encrypted = AESGCM(base64.urlsafe_b64decode(key)).encrypt(nonce, data, AAD)
    return json.dumps({'version': 1, 'nonce': base64.b64encode(nonce).decode(),
        'ciphertext': base64.b64encode(encrypted).decode()}).encode()


def decrypt(data, key):
    try:
        envelope = json.loads(data)
        if envelope['version'] != 1:
            raise ValueError()
        raw = AESGCM(base64.urlsafe_b64decode(key)).decrypt(
            base64.b64decode(envelope['nonce']), base64.b64decode(envelope['ciphertext']), AAD)
        state = json.loads(raw)
        if not all(isinstance(state['session'].get(k), str) and state['session'][k]
                   for k in ('user_id', 'access_token', 'refresh_token', 'client_id')):
            raise ValueError()
        return state
    except Exception:
        raise SyncError('Cannot open Stryd session; reconnect using the setup guide') from None


class StateStore:
    def __init__(self, github, release_id, key):
        self.github = github
        try:
            self.release_id = int(release_id)
        except (ValueError, TypeError):
            raise SyncError('Configure STRYD_STATE_RELEASE_ID') from None
        if not key:
            raise SyncError('Configure the STRYD_AUTH_KEY repository secret')
        self.key = key

    def check_private(self):
        release = self.github.call('GET', f'/releases/{self.release_id}')
        if release.get('draft') is not True or release.get('tag_name') != AUTH_TAG:
            raise SyncError('Stryd credential Release must remain an unpublished draft; sync stopped')

    def load(self):
        self.check_private()
        assets = [a for a in self.github.pages(f'/releases/{self.release_id}/assets')
                  if a['name'].startswith('state-') and a['name'].endswith('.enc.json')]
        if not assets:
            raise SyncError('No encrypted Stryd session; reconnect using the setup guide')
        latest = max(assets, key=lambda a: int(a['id']))
        # Never silently fall back to a stale refresh token.
        if latest.get('state') != 'uploaded':
            raise SyncError('Latest encrypted session upload is incomplete; reconnect Stryd')
        return decrypt(self.github.asset(latest['id']), self.key)

    def save(self, state):
        self.check_private()
        name = 'state-' + dt.datetime.now(UTC).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex + '.enc.json'
        content = encrypt(state, self.key)
        self.github.upload(self.release_id, name, content, 'application/json')
        # Read back before any more Stryd requests after a token rotation.
        latest = self.load()
        if latest != state:
            raise SyncError('Rotated session verification failed; no further Stryd requests sent')
