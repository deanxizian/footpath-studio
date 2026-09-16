#!/usr/bin/env python3
"""Prepare a local encrypted browser export and install it in Footpath Studio.

The browser command only downloads an encrypted envelope. No plaintext session,
password, GitHub token or encryption key is printed or committed.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from auth import new_key, StateStore, AUTH_TAG
from github import GitHub
from client import API, HTTP, Stryd, SyncError, as_json


def private_write(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(content)


def gh_executable():
    path = shutil.which('gh')
    if not path:
        candidate = Path.home() / '.local/bin/gh'
        if candidate.is_file():
            path = str(candidate)
    if not path:
        raise SyncError('Install GitHub CLI and run gh auth login first')
    return path


def gh_run(*args, payload=None):
    result = subprocess.run([gh_executable(), *args], input=payload, text=True, capture_output=True)
    if result.returncode:
        raise SyncError('GitHub CLI operation failed; run gh auth status to check your login')
    return result.stdout


def browser_command(public_key):
    # Only this public key goes into the DevTools command/history. Tokens remain in
    # browser memory until encrypted. Stryd's existing localStorage is not changed.
    return r'''void (async () => {
  if (location.hostname !== 'www.stryd.com') throw new Error('Open Stryd PowerCenter first');
  const token = localStorage.getItem('token');
  const refresh = localStorage.getItem('refreshToken');
  const client = localStorage.getItem('refreshClientId');
  if (!token || !refresh || !client) throw new Error('Please sign in to Stryd again first');
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
  if (!claims.ID) throw new Error('Stryd session format changed');
  const b64 = a => btoa(String.fromCharCode(...new Uint8Array(a)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rsa = await crypto.subtle.importKey('spki', unb64('PUBLIC_KEY_PLACEHOLDER'), {name:'RSA-OAEP', hash:'SHA-256'}, false, ['encrypt']);
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({user_id:claims.ID,access_token:token,refresh_token:refresh,client_id:client}));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode('stryd-footpath-bootstrap/v1')}, key, plain);
  const wrapped = await crypto.subtle.encrypt({name:'RSA-OAEP'}, rsa, await crypto.subtle.exportKey('raw',key));
  const envelope = {version:1,wrapped_key:b64(wrapped),nonce:b64(nonce),ciphertext:b64(ciphertext)};
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)],{type:'application/json'}));
  const link = document.createElement('a'); link.href=url; link.download='stryd-bootstrap.enc.json'; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
  console.log('Encrypted Stryd session downloaded. No login values were printed.');
})().catch(()=>console.error('Encrypted export failed. Verify that you are signed in to Stryd.'));
'''.replace('PUBLIC_KEY_PLACEHOLDER', public_key)


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    private_write(directory / 'bootstrap-private.pem', pem)
    private_write(directory / 'browser-export.js', browser_command(base64.b64encode(public).decode()))
    print('Prepared local bootstrap files in', directory)
    print('Run browser-export.js in Stryd PowerCenter DevTools Console to download the encrypted envelope.')


def open_envelope(path, private_path):
    envelope = json.loads(path.read_text())
    if envelope.get('version') != 1:
        raise SyncError('Unsupported bootstrap envelope version')
    private = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
    key = private.decrypt(base64.b64decode(envelope['wrapped_key']), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    plain = AESGCM(key).decrypt(base64.b64decode(envelope['nonce']), base64.b64decode(envelope['ciphertext']), b'stryd-footpath-bootstrap/v1')
    session = json.loads(plain)
    if not all(isinstance(session.get(k), str) and session[k] for k in ('user_id', 'access_token', 'refresh_token', 'client_id')):
        raise SyncError('Incomplete Stryd session; sign in again and export a new envelope')
    return session


def install(repo, envelope, private_key):
    session = open_envelope(envelope, private_key)
    github = GitHub(repo, gh_run('auth', 'token').strip())
    active = github.call('GET', '/actions/runs?per_page=100')['workflow_runs']
    if any(run.get('path') == '.github/workflows/stryd-sync.yml' and
           run['status'] != 'completed' for run in active):
        raise SyncError('Wait for active Stryd sync runs to finish before reconnecting')
    # Do not rotate until the new session can be saved durably by the workflow.
    reply = HTTP().request('GET', API + '/b/api/v1/users/' + session['user_id'] +
        '/calendar?limit=1&fields=ua&include_deleted=false',
        {'Authorization': 'Bearer: ' + session['access_token']})
    as_json(reply, 'Stryd login validation')
    gh_run('variable', 'set', 'STRYD_SYNC_ENABLED', '--repo', repo, '--body', 'false')
    github.call('PUT', '/environments/stryd-sync', {
        'deployment_branch_policy': {'protected_branches': True, 'custom_branch_policies': False}}, allowed=(200,))
    release = next((r for r in github.pages('/releases') if r['tag_name'] == AUTH_TAG), None)
    if not release:
        release = github.call('POST', '/releases', {'tag_name': AUTH_TAG, 'target_commitish': 'main',
            'name': 'Private Stryd automation state — DO NOT PUBLISH', 'draft': True,
            'body': 'Encrypted credential state for the daily workflow. Keep this release an unpublished draft. '
                    'The AES-GCM key is stored only in the protected stryd-sync Actions environment.'}, allowed=(201,))
    if release.get('draft') is not True:
        raise SyncError('Credential release is published; stop and reconnect with a new draft')
    key = new_key()
    gh_run('secret', 'set', 'STRYD_AUTH_KEY', '--repo', repo, '--env', 'stryd-sync', payload=key)
    store = StateStore(github, release['id'], key)
    state = {'session': session, 'checks': {}}
    store.save(state)
    # Confirm anonymous callers cannot retrieve the draft or its assets.
    anonymous = HTTP().request('GET', 'https://api.github.com/repos/' + repo + '/releases/' + str(release['id']))
    if anonymous.status == 403 and anonymous.headers.get('X-RateLimit-Remaining') == '0':
        anonymous = HTTP().request('GET', 'https://github.com/' + repo + '/releases/tag/' + AUTH_TAG)
    if anonymous.status != 404:
        raise SyncError('Could not verify that the credential draft is hidden from anonymous users')
    def persist(updated):
        state['session'] = updated
        store.save(state)
    client = Stryd(session, persist)
    client.refresh()
    client.page(limit=1)
    gh_run('variable', 'set', 'STRYD_STATE_RELEASE_ID', '--repo', repo, '--body', str(release['id']))
    gh_run('variable', 'set', 'STRYD_SYNC_ENABLED', '--repo', repo, '--body', 'true')
    print('Encrypted session installed; protected environment configured. No credentials were printed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('prepare')
    create.add_argument('--directory', type=Path, default=Path('.local/stryd'))
    setup = commands.add_parser('install')
    setup.add_argument('--repo', required=True)
    setup.add_argument('--envelope', type=Path, required=True)
    setup.add_argument('--private-key', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.directory)
    else:
        install(args.repo, args.envelope, args.private_key)


if __name__ == '__main__':
    try:
        main()
    except SyncError as error:
        print('Setup stopped:', error, file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Setup stopped:', type(error).__name__, '(sensitive details omitted)', file=sys.stderr)
        sys.exit(1)
