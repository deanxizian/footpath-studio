#!/usr/bin/env python3
"""Fetch authorized Stryd uploads; publish immutable monthly assets via a data PR."""
import datetime as dt
import gzip
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from auth import AUTH_TAG, StateStore
from client import Stryd, SyncError, UTC, numeric_id
from github import GitHub
from transform import FIELDS, SITE_FORMAT, TRANSFORM_VERSION, compact, compress, digest, median, pack_run, store_data

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/stryd-sync'
BRANCH = 'sync/footpath-data'
MANIFEST = 'published-history.json'
ACTIVITY_FIELDS = ('id', 'name', 'timestamp', 'foot_data_id', 'moving_time', 'distance',
                   'average_speed', 'surface_type', 'recording_mode', 'apparel_ids')


def read_history(directory):
    version = json.loads((directory / 'version.json').read_text())
    name = version['index']
    if version.get('format') != SITE_FORMAT or not re.fullmatch(r'[a-f0-9]{64}\.bin', name):
        raise SyncError('Invalid baseline data version')
    raw = (directory / name).read_bytes()
    if digest(raw) != name[:-4]:
        raise SyncError('Baseline catalog checksum failed')
    return json.loads(gzip.decompress(raw))


def synchronize(stryd, state, history, directory, maximum=100, recheck_all=False, now=None):
    now = now or dt.datetime.now(UTC)
    stamp = now.isoformat()
    runs = {run['id']: run for run in history['runs']}
    if len(runs) != len(history['runs']):
        raise SyncError('Baseline has duplicate Footpath IDs')
    checks = state.setdefault('checks', {})
    activities = stryd.calendar()
    uploaded = [a for a in activities if a.get('foot_data_id')]
    result = dict(activities=len(activities), uploaded=len(uploaded), new=0, revised=0,
                  unchanged=0, pending=0, remaining=0, failed=[])
    candidates = []
    for activity in uploaded:
        identifier = numeric_id(activity['foot_data_id'])
        old = runs.get(identifier)
        checked = checks.get(identifier, {})
        recent = activity['timestamp'] >= now.timestamp() - 14 * 86400
        checked_current = old and checked.get('sourceHash') == old.get('sourceHash') and checked.get('checked', '').startswith(stamp[:10])
        if not old or recheck_all or recent and not checked_current:
            candidates.append((old is not None, checked.get('attempted', ''), activity, old))
    candidates.sort(key=lambda v: (v[0], v[1], v[2]['timestamp'], str(v[2]['id'])))
    result['remaining'] = max(0, len(candidates) - maximum)
    for _, _, activity, old in candidates[:maximum]:
        identifier = numeric_id(activity['foot_data_id'])
        previous_check = checks.get(identifier, {})
        check = checks[identifier] = {**previous_check, 'attempted': stamp}
        try:
            # An ETag only applies to the exact baseline version that was checked.
            etag = check.get('etag') if old and check.get('sourceHash') == old.get('sourceHash') else None
            response = stryd.footpath(activity, etag)
            if response is None:
                result['pending'] += 1
                continue
            metadata = {k: activity.get(k) for k in ACTIVITY_FIELDS}
            metadata_changed = old and old['activity'] != metadata
            if response == 'unchanged' and metadata_changed:
                response = stryd.footpath(activity)
                if response in (None, 'unchanged'):
                    raise SyncError('Cannot refresh changed activity metadata')
            if response == 'unchanged':
                if not old:
                    raise SyncError('Unexpected unchanged response for missing Footpath')
                check['checked'] = stamp
                result['unchanged'] += 1
                continue
            source_hash = digest(response.body)
            if old and source_hash == old.get('sourceHash') and not metadata_changed:
                result['unchanged'] += 1
            else:
                raw = json.loads(response.body)
                if not raw.get('foot_data_list'):
                    result['pending'] += 1
                    continue
                record = {'activity': metadata, 'foot_data_id': identifier, 'raw_sha256': source_hash}
                runs[identifier] = pack_run(record, response.body, directory)
                result['revised' if old else 'new'] += 1
            check.update(checked=stamp, etag=response.headers.get('ETag'), sourceHash=source_hash)
        except SyncError as error:
            result['failed'].append({'activity': numeric_id(activity['id']), 'reason': str(error)})
            if 'denied' in str(error) or 'session' in str(error):
                break
        finally:
            time.sleep(.15)
    result['total'] = len(runs)
    result['not_archived'] = sum(str(a['foot_data_id']) not in runs for a in uploaded)
    if result['new'] or result['revised']:
        ordered = sorted(runs.values(), key=lambda r: (r['start'], r['id']))
        revision = digest(compact({'transformVersion': TRANSFORM_VERSION,
            'records': {run['id']: {'raw': run['sourceHash'], 'activity': run['activity']} for run in ordered}}))
        speed = median([median([row[3] for row in run['rows']]) for run in ordered])
        updated = {'format': 'footpath-studio-collection-v1', 'transformVersion': TRANSFORM_VERSION,
            'rowFields': FIELDS, 'defaultSpeed': math.floor((speed or 3.5) / .05 + .5) * .05,
            'runs': ordered, 'failures': [], 'manifest': {'generated_at': stamp,
            'source': 'authorized-stryd-sync', 'revision': revision}}
        index = store_data(compress(compact(updated)), directory)
        (directory / 'version.json').write_text(json.dumps({'format': SITE_FORMAT, 'index': index, 'revision': revision}) + '\n')
    return result


def node(*args):
    # Build/pack subprocesses have no need to see account credentials.
    env = {k: v for k, v in os.environ.items() if k not in ('STRYD_AUTH_KEY', 'GH_TOKEN', 'GITHUB_TOKEN')}
    result = subprocess.run(['node', *args], cwd=ROOT, env=env)
    if result.returncode:
        raise SyncError('History verification or packaging failed')


def pending_pull(github):
    pulls = github.call('GET', '/pulls?state=open&base=main&head=' + github.repo.split('/')[0] + ':' + BRANCH)
    if len(pulls) > 1:
        raise SyncError('Multiple data update PRs exist')
    if not pulls:
        return None
    pull = pulls[0]
    if pull['head']['repo']['full_name'] != github.repo or pull['base']['ref'] != 'main':
        raise SyncError('Unexpected data PR repository or base')
    files = list(github.pages(f'/pulls/{pull["number"]}/files'))
    if not files or any(f['filename'] != MANIFEST for f in files):
        raise SyncError('Data PR contains source changes; review it before syncing again')
    comparison = github.call('GET', '/compare/main...' + pull['head']['sha'])
    original = github.read_file(MANIFEST, comparison['merge_base_commit']['sha'])
    approved = github.read_file(MANIFEST, 'main')
    if json.loads(original) != json.loads(approved):
        raise SyncError('Approved history changed while the data PR was open; reconcile the PR before syncing')
    return pull


def validate_baseline(manifest, repo):
    assets = [manifest.get('catalog', {}), *manifest.get('months', [])]
    prefix = f'https://github.com/{repo}/releases/download/history-'
    if not assets or any(not a.get('url', '').startswith(prefix) for a in assets):
        raise SyncError('Data manifest must reference public history assets in this repository')


def apply_updates(directory, updates):
    for file in updates.iterdir():
        shutil.copyfile(file, directory / file.name)
    history = read_history(directory)
    version = json.loads((directory / 'version.json').read_text())
    keep = {version['index'], 'version.json', *[Path(r['packedUrl']).name for r in history['runs']]}
    for file in directory.iterdir():
        if file.name not in keep:
            file.unlink()


def publish(github, manifest, tag, commit):
    if not re.fullmatch(r'history-\d{4}-\d{2}-\d{2}-sync-[a-zA-Z0-9.-]+', tag) or tag == AUTH_TAG:
        raise SyncError('Invalid public data Release tag')
    directory = ROOT / '.cache/history-releases' / tag
    assets = [a for a in [manifest['catalog'], *manifest['months']] if f'/download/{tag}/' in a['url']]
    filenames = [Path(a['url']).name for a in assets] + [MANIFEST]
    if any(not re.fullmatch(r'(?:footpath-(?:catalog|\d{4}-\d{2})\.tar|published-history\.json)', f) for f in filenames):
        raise SyncError('Unexpected file in public data publication')
    release = github.call('POST', '/releases', {'tag_name': tag, 'target_commitish': commit,
        'name': 'Footpath history ' + manifest['snapshotDate'], 'draft': True,
        'body': f'{manifest["runCount"]} runs across {len(manifest["months"])} months. '
                'Unchanged months reuse immutable assets from earlier releases. '
                'The website updates after the data PR is reviewed and merged.'}, allowed=(201,))
    for name in filenames:
        github.upload(release['id'], name, (directory / name).read_bytes())
    # Only this newly created history Release can be published. The credential
    # draft has a different fixed tag and ID and is never passed to this path.
    if release['tag_name'] != tag or release['id'] == int(os.environ['STRYD_STATE_RELEASE_ID']):
        raise SyncError('Refusing to publish an unexpected release')
    github.call('PATCH', f'/releases/{release["id"]}', {'draft': False, 'make_latest': 'false'})
    return release['html_url']


def update_pull(github, manifest, expected_pull, result, release_url, expected_main=None):
    current = pending_pull(github)
    if (current or {}).get('head', {}).get('sha') != (expected_pull or {}).get('head', {}).get('sha'):
        raise SyncError('Data PR changed during sync; retry to avoid overwriting it')
    main = github.call('GET', '/git/ref/heads/main')['object']['sha']
    if expected_main and main != expected_main:
        raise SyncError('Main changed during sync; retry before updating the data PR')
    base = github.call('GET', '/git/commits/' + main)
    tree = github.call('POST', '/git/trees', {'base_tree': base['tree']['sha'], 'tree': [{
        'path': MANIFEST, 'mode': '100644', 'type': 'blob', 'content': json.dumps(manifest, indent=2) + '\n'}]}, allowed=(201,))
    parents = [main]
    branch = github.request('GET', '/git/ref/heads/' + BRANCH)
    if branch.status == 200:
        old_head = json.loads(branch.body)['object']['sha']
        if current and old_head != current['head']['sha']:
            raise SyncError('Data branch changed during sync')
        if not current:
            # A merged or deliberately closed data PR must not be silently reopened.
            closed = github.call('GET', '/pulls?state=closed&base=main&head=' + github.repo.split('/')[0] + ':' + BRANCH)
            if not closed or not closed[0].get('merged_at'):
                raise SyncError('Existing data branch has no merged PR; resolve it before syncing')
        parents = list(dict.fromkeys([old_head, main]))
    elif branch.status != 404:
        raise SyncError('Cannot inspect data branch')
    commit = github.call('POST', '/git/commits', {'message': f'data: sync {manifest["runCount"]} Footpath runs',
        'tree': tree['sha'], 'parents': parents}, allowed=(201,))
    if branch.status == 404:
        github.call('POST', '/git/refs', {'ref': 'refs/heads/' + BRANCH, 'sha': commit['sha']}, allowed=(201,))
    else:
        github.call('PATCH', '/git/refs/heads/' + BRANCH, {'sha': commit['sha'], 'force': False})
    body = '\n'.join(['## Daily Stryd data update', '',
        f'- Total: {manifest["runCount"]} runs across {len(manifest["months"])} months.',
        f'- This sync: {result["new"]} new, {result["revised"]} revised; {result["pending"]} still processing.',
        f'- Immutable data assets: {release_url}',
        '- Unchanged month packages retain their existing URLs and checksums.',
        '- Only the public data manifest changes; account credentials are excluded.', '',
        'Review this PR and its Vercel Preview before merging. Production remains on the approved main snapshot.'])
    fields = {'title': f'data: update Footpath history ({manifest["runCount"]} runs)', 'body': body}
    if current:
        pull = github.call('PATCH', f'/pulls/{current["number"]}', fields)
    else:
        pull = github.call('POST', '/pulls', {**fields, 'head': BRANCH, 'base': 'main'}, allowed=(201,))
    # Explicit dispatch works with GITHUB_TOKEN, without a long-lived GitHub PAT.
    github.call('POST', '/actions/workflows/ci.yml/dispatches', {'ref': BRANCH}, allowed=(204,))
    return pull['html_url']


def main():
    if os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SyncError('Stryd credentials may only be used by the main branch')
    maximum = int(os.environ.get('MAX_DOWNLOADS', '100'))
    if not 1 <= maximum <= 500:
        raise SyncError('MAX_DOWNLOADS must be between 1 and 500')
    github = GitHub(os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GH_TOKEN'))
    store = StateStore(github, os.environ.get('STRYD_STATE_RELEASE_ID'), os.environ.get('STRYD_AUTH_KEY'))
    state = store.load()
    def persist(session):
        state['session'] = session
        store.save(state)
    stryd = Stryd(state['session'], persist)
    if os.environ.get('REFRESH_SESSION') == 'true':
        stryd.refresh()
    pull = pending_pull(github)
    main_sha = github.call('GET', '/git/ref/heads/main')['object']['sha']
    baseline = json.loads(github.read_file(MANIFEST, pull['head']['sha'] if pull else main_sha))
    validate_baseline(baseline, github.repo)
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    baseline_file = WORK / 'baseline.json'
    baseline_file.write_text(json.dumps(baseline))
    catalog = WORK / 'catalog'
    node('scripts/fetch-public-history.mjs', '--manifest', str(baseline_file), '--target', str(catalog), '--catalog-only')
    updates = WORK / 'updates'
    updates.mkdir()
    try:
        result = synchronize(stryd, state, read_history(catalog / 'data'), updates,
            maximum, os.environ.get('RECHECK_ALL') == 'true')
    finally:
        store.save(state)
    if result['new'] or result['revised']:
        history = WORK / 'history'
        node('scripts/fetch-public-history.mjs', '--manifest', str(baseline_file), '--target', str(history))
        apply_updates(history / 'data', updates)
        snapshot = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%Y-%m-%d')
        tag = f'history-{snapshot}-sync-' + os.environ.get('GITHUB_RUN_ID', 'local') + '-' + uuid.uuid4().hex[:8]
        (ROOT / MANIFEST).write_text(json.dumps(baseline, indent=2) + '\n')
        node('scripts/pack-public-history.mjs', str(history), tag, snapshot, '--reuse')
        manifest = json.loads((ROOT / MANIFEST).read_text())
        release_url = publish(github, manifest, tag, main_sha)
        result['pull_request'] = update_pull(github, manifest, pull, result, release_url, main_sha)
    else:
        result['pull_request'] = pull['html_url'] if pull else None
    safe = {k: v for k, v in result.items() if k != 'failed'}
    print(json.dumps(safe))
    summary = ['## Daily Stryd Footpath sync', '',
        f'- Calendar: {result["activities"]} activities; {result["uploaded"]} with uploaded Footpath.',
        f'- New / revised / unchanged: {result["new"]} / {result["revised"]} / {result["unchanged"]}.',
        f'- Archived total: {result["total"]}; not archived: {result["not_archived"]}.',
        f'- Pending processing: {result["pending"]}; remaining checks: {result["remaining"]}; failures: {len(result["failed"])}.',
        f'- Data PR: {result["pull_request"] or "No data change; no PR or Release created."}',
        '- Schedule: daily at 06:20 Asia/Shanghai (22:20 UTC).', '']
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        Path(os.environ['GITHUB_STEP_SUMMARY']).write_text('\n'.join(summary))
    for failure in result['failed']:
        print('Activity', failure['activity'] + ':', failure['reason'], file=sys.stderr)
    return 1 if result['failed'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SyncError as error:
        print('Sync stopped:', error, file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Sync stopped:', type(error).__name__, '(sensitive details omitted)', file=sys.stderr)
        sys.exit(1)
