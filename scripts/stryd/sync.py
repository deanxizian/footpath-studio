#!/usr/bin/env python3
"""Fetch authorized Stryd uploads; update monthly Releases without changing Git."""
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

from auth import StateStore
from client import Stryd, SyncError, UTC, numeric_id
from github import GitHub
from publication import latest_manifest, publish, deploy_site
from transform import FIELDS, SITE_FORMAT, TRANSFORM_VERSION, compact, compress, digest, median, pack_run, store_data

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/stryd-sync'
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
    env = {k: v for k, v in os.environ.items() if k not in ('STRYD_AUTH_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_DEPLOY_HOOK')}
    result = subprocess.run(['node', *args], cwd=ROOT, env=env)
    if result.returncode:
        raise SyncError('History verification or packaging failed')


def apply_updates(directory, updates):
    for file in updates.iterdir():
        shutil.copyfile(file, directory / file.name)
    history = read_history(directory)
    version = json.loads((directory / 'version.json').read_text())
    keep = {version['index'], 'version.json', *[Path(r['packedUrl']).name for r in history['runs']]}
    for file in directory.iterdir():
        if file.name not in keep:
            file.unlink()


def require_current_main(github, expected):
    if not re.fullmatch(r'[a-f0-9]{40}', expected or ''):
        raise SyncError('Cannot determine the checked-out workflow revision')
    if github.call('GET', '/git/ref/heads/main')['object']['sha'] != expected:
        raise SyncError('Main changed during sync; rerun using the current main revision')


def main():
    if os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SyncError('Stryd credentials may only be used by the main branch')
    maximum = int(os.environ.get('MAX_DOWNLOADS', '100'))
    if not 1 <= maximum <= 500:
        raise SyncError('MAX_DOWNLOADS must be between 1 and 500')
    github = GitHub(os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GH_TOKEN'))
    checkout = os.environ.get('GITHUB_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    check_main = lambda: require_current_main(github, checkout)
    check_main()
    store = StateStore(github, os.environ.get('STRYD_STATE_RELEASE_ID'), os.environ.get('STRYD_AUTH_KEY'))
    state = store.load()
    def persist(session):
        state['session'] = session
        store.save(state)
    stryd = Stryd(state['session'], persist)
    if os.environ.get('REFRESH_SESSION') == 'true':
        stryd.refresh()
    baseline = latest_manifest(github)
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
        output = WORK / 'publication'
        node('scripts/pack-public-history.mjs', '--source', str(history), '--output', str(output))
        manifest = json.loads((output / 'published-history.json').read_text())
        check_main()
        result['release'] = publish(github, manifest, output, checkout, before_discovery=check_main)
        baseline = manifest
    else:
        result['release'] = None
    deployment_failed = False
    try:
        check_main()
        result['deployment'] = deploy_site(baseline['revision'], os.environ.get('VERCEL_DEPLOY_HOOK'),
            os.environ.get('STRYD_SITE_URL'), force=os.environ.get('DEPLOY_SITE') == 'true')
    except SyncError as error:
        deployment_failed = True
        result['deployment'] = str(error)
    safe = {k: v for k, v in result.items() if k != 'failed'}
    print(json.dumps(safe))
    summary = ['## Daily Stryd Footpath sync', '',
        f'- Calendar: {result["activities"]} activities; {result["uploaded"]} with uploaded Footpath.',
        f'- New / revised / unchanged: {result["new"]} / {result["revised"]} / {result["unchanged"]}.',
        f'- Archived total: {result["total"]}; not archived: {result["not_archived"]}.',
        f'- Pending processing: {result["pending"]}; remaining checks: {result["remaining"]}; failures: {len(result["failed"])}.',
        f'- Monthly Release: {result["release"] or "No data change."}',
        f'- Website: {result["deployment"]}. No commits or pull requests created.',
        '- Schedule: daily at 06:20 Asia/Shanghai (22:20 UTC).', '']
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        Path(os.environ['GITHUB_STEP_SUMMARY']).write_text('\n'.join(summary))
    for failure in result['failed']:
        print('Activity', failure['activity'] + ':', failure['reason'], file=sys.stderr)
    return 1 if result['failed'] or deployment_failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SyncError as error:
        print('Sync stopped:', error, file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Sync stopped:', type(error).__name__, '(sensitive details omitted)', file=sys.stderr)
        sys.exit(1)
