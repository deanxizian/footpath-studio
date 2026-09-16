"""Disposable fetch progress. Never serialize credentials or login sessions."""
import datetime as dt
import json
import os
import re
import tempfile

FORMAT = 'footpath-studio-checks-v1'
MAX_BYTES = 8 * 1024 * 1024


def clean_checks(state):
    result = {}
    checks = state.get('checks', {}) if isinstance(state, dict) else {}
    if not isinstance(checks, dict) or len(checks) > 20000:
        return result
    for identifier, check in checks.items():
        if not isinstance(identifier, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', identifier) or not isinstance(check, dict):
            continue
        item = {}
        for key in ('attempted', 'checked'):
            value = check.get(key)
            if isinstance(value, str) and len(value) <= 40:
                try:
                    stamp = dt.datetime.fromisoformat(value)
                    if stamp.tzinfo is not None and stamp <= dt.datetime.now(dt.timezone.utc):
                        item[key] = stamp.astimezone(dt.timezone.utc).isoformat()
                except ValueError:
                    pass
        value = check.get('sourceHash')
        if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value):
            item['sourceHash'] = value
        value = check.get('etag')
        if isinstance(value, str) and len(value) <= 512 and all(32 <= ord(c) < 127 for c in value):
            item['etag'] = value
        if item:
            result[identifier] = item
    return result


def load_checks(path):
    try:
        if path.stat().st_size > MAX_BYTES:
            return {'checks': {}}
        data = json.loads(path.read_bytes())
        if not isinstance(data, dict) or data.get('format') != FORMAT:
            return {'checks': {}}
        return {'checks': clean_checks(data)}
    except (OSError, ValueError):
        return {'checks': {}}


def save_checks(path, state):
    # Allowlist fields explicitly; in particular, do not serialize state itself.
    content = json.dumps({'format': FORMAT, 'checks': clean_checks(state)},
                         sort_keys=True, separators=(',', ':')).encode()
    if len(content) > MAX_BYTES:
        raise ValueError('Check cache exceeds its size limit')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='checks-', delete=False) as file:
            temporary = file.name
            file.write(content)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
