#!/usr/bin/env python3
"""V01-only Docker substitute. Never forwards to Docker or executes shell payloads."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

def main():
    root = Path(os.environ['V01_ROOT']).resolve(strict=True)
    if not root.name.startswith('donote-v01-independent-'):
        raise RuntimeError('Not an owned synthetic root')
    args = sys.argv[1:]
    with (root / 'docker-events.jsonl').open('a') as stream:
        stream.write(json.dumps(args) + '\n')
    if args[:2] == ['image', 'inspect']:
        return 0
    if args[:1] == ['compose'] and args[1:] in (['stop', 'app'], ['start', 'app']):
        return 0
    if args[:1] == ['compose'] and args[1:] == ['ps', '-q', 'app']:
        print('synthetic-app')
        return 0
    if args[:1] == ['inspect']:
        print('healthy')
        return 0
    if args[:1] != ['run']:
        raise RuntimeError('Unsupported mock invocation')
    mounts = {}
    for i, arg in enumerate(args):
        if arg == '-v':
            source, target, *mode = args[i + 1].split(':')
            source = Path(source).resolve(strict=True)
            if source != root and root not in source.parents:
                raise RuntimeError('Mount escapes owned fixture root')
            mounts[target] = source
    if 'sh' in args and '-c' in args:
        command_index = args.index('-c')
        payload = args[command_index + 1]
        positional = args[command_index + 3:]
    else:
        payload, positional = args[-1], []
    if 'tar czf' in payload and '/out/$1' in payload:
        if os.environ.get('V01_ROLLBACK_FAIL') == '1':
            return 42
        if not positional or not re.fullmatch(r'data\.rollback-[0-9-]+\.tar\.gz', positional[0]):
            raise RuntimeError('Unknown rollback positional arguments')
        with tarfile.open(mounts['/out'] / positional[0], 'w:gz') as archive:
            archive.add(mounts['/data'], arcname='.')
        return 0
    if 'chown ' in payload:
        return 0
    if 'tar czf' in payload and 'rollback' in payload:
        if os.environ.get('V01_ROLLBACK_FAIL') == '1':
            return 42
        match = re.search(r"/out/(data[.]rollback-[0-9-]+[.]tar[.]gz)", payload)
        if not match:
            raise RuntimeError('Unknown rollback payload')
        with tarfile.open(mounts['/out'] / match.group(1), 'w:gz') as archive:
            archive.add(mounts['/data'], arcname='.')
        return 0
    if 'tar xzf' in payload and 'rm -rf /data/' in payload:
        # Record attempted destructive transition even for a dangerous archive.
        # Malicious entries are NEVER extracted by this verifier fixture.
        (root / 'replacement-attempted').touch()
        match = re.search(r"/in/([^']+)'", payload)
        if not match:
            raise RuntimeError('Unknown extraction payload')
        target = mounts['/data']
        if target != root / 'data':
            raise RuntimeError('Not the synthetic target')
        with tarfile.open(mounts['/in'] / match.group(1), 'r:gz') as archive:
            members = archive.getmembers()
            for item in members:
                relative = Path(item.name)
                if relative.is_absolute() or '..' in relative.parts or not (item.isdir() or item.isfile()):
                    return 86
            shutil.rmtree(target)
            target.mkdir()
            archive.extractall(target, members=members, filter='data')
        return 0
    raise RuntimeError('Unsupported container payload; no shell executed')

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('V01 mock refused: ' + str(error), file=sys.stderr)
        sys.exit(87)
