"""Publish data only to monthly Releases. Never create a Git commit or a PR."""
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse

from client import HTTP, SyncError, as_json

MANIFEST = 'published-history.json'
MONTH = r'\d{4}-(?:0[1-9]|1[0-2])'
HEX = r'[a-f0-9]{64}'


def validate_baseline(manifest, repo):
    if manifest.get('format') != 'footpath-studio-monthly-history-v2':
        raise SyncError('Expected one Release per month')
    months = manifest.get('months', [])
    names = [m.get('month', '') for m in months]
    if not names or len(set(names)) != len(names) or any(not re.fullmatch(MONTH, m) for m in names):
        raise SyncError('Invalid monthly history manifest')
    latest = max(names)
    if manifest.get('latestMonth') != latest:
        raise SyncError('Latest data Release must be the newest month')
    prefix = 'https://github.com/' + repo + '/releases/download/'
    for asset, month, name in [(manifest.get('catalog', {}), latest, 'footpath-catalog'),
                               *[(m, m['month'], 'footpath-' + m['month']) for m in months]]:
        expected = re.escape(prefix + f'footpath-{month}/{name}-') + HEX + r'\.tar'
        if not re.fullmatch(expected, asset.get('url', '')) or not re.fullmatch(HEX, asset.get('sha256', '')):
            raise SyncError('Data manifest must reference verified monthly assets in this repository')
    return manifest


def replace_manifest(github, release_id, content):
    """Replace the discovery alias only after a durable immutable copy exists."""
    existing = next((a for a in github.pages(f'/releases/{release_id}/assets') if a['name'] == MANIFEST), None)
    previous = github.asset(existing['id']) if existing and existing.get('state') == 'uploaded' else None
    if previous == content:
        return
    if existing:
        github.call('DELETE', f'/releases/assets/{existing["id"]}', allowed=(204,))
    try:
        uploaded = github.upload(release_id, MANIFEST, content, 'application/json', repair=True)
        if github.asset(uploaded['id']) != content:
            raise SyncError('Public discovery manifest readback failed')
    except Exception:
        # The immutable manifest also permits recovery after a killed runner.
        current = next((a for a in github.pages(f'/releases/{release_id}/assets') if a['name'] == MANIFEST), None)
        if current is None and previous is not None:
            github.upload(release_id, MANIFEST, previous, 'application/json')
        raise


def latest_manifest(github):
    release = github.call('GET', '/releases/latest')
    if release.get('draft') or not re.fullmatch('footpath-' + MONTH, release.get('tag_name', '')):
        raise SyncError('Latest Release must be a published Footpath month')
    assets = [a for a in github.pages(f'/releases/{release["id"]}/assets')
              if re.fullmatch(r'published-history-' + HEX + r'\.json', a['name']) and a.get('state') == 'uploaded']
    if not assets:
        raise SyncError('Latest monthly Release has no verified history manifest')
    newest = max(assets, key=lambda a: int(a['id']))
    content = github.asset(newest['id'])
    if hashlib.sha256(content).hexdigest() != newest['name'][18:-5]:
        raise SyncError('History manifest checksum failed')
    manifest = validate_baseline(json.loads(content), github.repo)
    if release['tag_name'] != 'footpath-' + manifest['latestMonth']:
        raise SyncError('History manifest and latest Release disagree')
    # This repairs an interrupted small-alias replacement before scanning Stryd.
    replace_manifest(github, release['id'], content)
    return manifest


def publish(github, manifest, directory, commit, before_discovery=lambda: None):
    validate_baseline(manifest, github.repo)
    releases = {r['tag_name']: r for r in github.pages('/releases')}
    public = {}
    for month in manifest['months']:
        tag = 'footpath-' + month['month']
        release = releases.get(tag)
        if release is None:
            release = github.call('POST', '/releases', {'tag_name': tag, 'target_commitish': commit,
                'name': f'Footpath · {month["month"]}', 'draft': True}, allowed=(201,))
        if release['tag_name'] != tag:
            raise SyncError('Refusing to publish an unexpected Release')
        public[tag] = release
        assets = [month]
        if month['month'] == manifest['latestMonth']:
            assets.append(manifest['catalog'])
        remote = {a['name']: a for a in github.pages(f'/releases/{release["id"]}/assets')}
        for asset in assets:
            name = Path(asset['url']).name
            uploaded = remote.get(name)
            matches = lambda value: value and value.get('state') == 'uploaded' and value.get('digest') == 'sha256:' + asset['sha256'] and value.get('size') == asset['bytes']
            if not matches(uploaded):
                path = directory / tag / name
                content = path.read_bytes()
                if len(content) != asset['bytes'] or hashlib.sha256(content).hexdigest() != asset['sha256']:
                    raise SyncError('Local monthly archive checksum failed')
                uploaded = github.upload(release['id'], name, content, repair=True)
            if not matches(uploaded):
                raise SyncError('Public monthly archive checksum failed')
        body = (f'## {month["month"]} · {month["runCount"]} 次跑步\n\n'
                f'[下载本月最新 Footpath 数据]({month["url"]}) · {month["bytes"] / 1024 / 1024:.1f} MiB\n\n'
                '按北京时间的跑步开始日期归档。本月的新 Footpath 和修订会更新在这个 Release 中。\n\n'
                '压缩包包含当月索引与全部三维轨迹，可独立解包分析。附件名称中的摘要用于校验及区分修订；上面的链接始终指向本月最新数据。\n\n'
                f'SHA-256: `{month["sha256"]}`\n')
        if month['month'] == manifest['latestMonth']:
            body += ('\n此月份同时保存网站的总目录 `published-history.json` 与 `footpath-catalog-…tar`。'
                     '它们用于自动汇总所有月份，不是额外的一份跑步数据。\n')
        if release.get('body') != body or release.get('draft'):
            update = {'body': body, 'name': f'Footpath · {month["month"]} · {month["runCount"]} 次跑步'}
            # Publishing a new month must not change discovery yet. Updating
            # an existing month must also preserve the current Latest marker.
            if release.get('draft'):
                update.update(draft=False, make_latest='false')
            github.call('PATCH', f'/releases/{release["id"]}', update)
        print(f'Verified monthly Release: {tag}, {month["runCount"]} runs.', flush=True)
    latest = public['footpath-' + manifest['latestMonth']]
    # Global discovery is updated last: partial uploads can never be advertised.
    before_discovery()
    content = (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode()
    immutable = 'published-history-' + hashlib.sha256(content).hexdigest() + '.json'
    github.upload(latest['id'], immutable, content, 'application/json', repair=True)
    replace_manifest(github, latest['id'], content)
    github.call('PATCH', f'/releases/{latest["id"]}', {'make_latest': 'true'})
    return f'https://github.com/{github.repo}/releases/tag/footpath-{manifest["latestMonth"]}'


def deploy_site(revision, hook, site, http=None, pause=time.sleep, attempts=60):
    """Compare production with Releases on every run so failed builds retry later."""
    if not re.fullmatch(r'https://api\.vercel\.com/v1/integrations/deploy/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+', hook or ''):
        raise SyncError('Configure the VERCEL_DEPLOY_HOOK repository secret')
    parts = urllib.parse.urlsplit(site or '')
    if parts.scheme != 'https' or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('', '/'):
        raise SyncError('Configure STRYD_SITE_URL with the HTTPS production origin')
    http = http or HTTP()
    def current():
        try:
            reply = http.request('GET', site.rstrip('/') + '/data/version.json?sync=' + str(time.time_ns()),
                                 {'Cache-Control': 'no-cache'})
            return reply.status == 200 and json.loads(reply.body).get('revision') == revision
        except (SyncError, ValueError):
            return False
    if current():
        return 'current'
    # Hook is deliberately kept out of logs and all build subprocess environments.
    reply = http.request('POST', hook + '?buildCache=false', payload=b'', retry=False)
    response = as_json(reply, 'Vercel deployment trigger', (200, 201, 202))
    if not response.get('job', {}).get('id'):
        raise SyncError('Vercel did not acknowledge the deployment request')
    for _ in range(attempts):
        pause(10)
        if current():
            return 'updated'
    raise SyncError('Production did not reach the published data revision; the next sync will retry deployment')
