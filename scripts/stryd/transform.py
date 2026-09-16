#!/usr/bin/env python3
"""Transform authorized Stryd Footpath into the public website data format."""
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

from client import SyncError, CHINA

ROOT = Path(__file__).resolve().parent
DATA = ROOT / '.unused'
FIELDS = ['index', 'side', 'time', 'speed', 'xSpan', 'ySpan', 'zSpan', 'groundContactTime', 'strideTime']
KEEP = ['side', 'timestamp', 'timestamp_frac', 'speed', 'power', 'ground_contact_time', 'stride_time', 'sample_freq']
TRANSFORM_VERSION = 2
SITE_FORMAT = 'footpath-studio-public-v1'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()


def compress(data):
    zipped = gzip.compress(data, compresslevel=6, mtime=0)
    return zipped[:9] + b'\xff' + zipped[10:]


def store_data(data, directory=DATA):
    name = digest(data) + '.bin'
    (directory / name).write_bytes(data)
    return name


def median(values):
    values = sorted(v for v in values if v is not None and math.isfinite(v))
    if not values:
        return None
    half = len(values) // 2
    return values[half] if len(values) % 2 else (values[half - 1] + values[half]) / 2


def positive(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


def pack_run(record, raw_bytes, directory=DATA):
    if digest(raw_bytes) != record['raw_sha256']:
        raise SyncError('Original archive checksum failed')
    raw = json.loads(raw_bytes, parse_int=lambda s: -0.0 if s == '-0' else int(s))
    activity = record['activity']
    if abs(raw['timestamp'] - activity['timestamp']) >= 60:
        raise SyncError('Activity and Footpath timestamps do not match')
    segments, rows = [], []
    for index, segment in enumerate(raw['foot_data_list']):
        points = [[p['x'], p['y'], p['z']] for p in segment['positions']]
        if segment['side'] not in (1, 2) or len(points) < 2 or not all(math.isfinite(v) for p in points for v in p):
            raise SyncError('Invalid Footpath geometry')
        spans = [max(p[i] for p in points) - min(p[i] for p in points) for i in range(3)]
        timestamp = segment['timestamp'] + segment.get('timestamp_frac', 0)
        rows.append([index, segment['side'], timestamp, positive(segment.get('speed')), *spans,
            positive(segment.get('ground_contact_time')), positive(segment.get('stride_time'))])
        segments.append({**{name: segment.get(name) for name in KEEP}, 'points': points})
    if not rows:
        raise SyncError('Empty Footpath cannot be published')
    start, end = min(r[2] for r in rows), max(r[2] for r in rows)
    title = dt.datetime.fromtimestamp(start, CHINA).strftime('%Y-%m-%d') + ' · ' + (activity.get('name') or '跑步')
    packed = compact({'format': 'footpath-studio-v1', 'title': title, 'segments': segments})
    filename = store_data(compress(packed), directory)
    return {'id': str(record['foot_data_id']), 'activity': activity, 'title': title, 'start': start, 'end': end,
        'pointCount': sum(len(s['points']) for s in segments), 'rows': rows,
        'packedUrl': '/data/' + filename, 'packedSha256': digest(packed), 'sourceHash': record['raw_sha256'], 'transformVersion': TRANSFORM_VERSION}

