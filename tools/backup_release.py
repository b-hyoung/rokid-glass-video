"""Create a local recovery bundle without changing the deployed application."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def read_json(origin, route):
    request = urllib.request.Request(origin.rstrip('/') + route, headers={'User-Agent': 'Glass-Recovery/1', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def capture(origin):
    # Never mix pictures from one library revision with another revision.
    for _ in range(3):
        before = read_json(origin, '/recognition/guide')
        library = read_json(origin, '/recognition/targets')
        after = read_json(origin, '/recognition/targets')
        guide = read_json(origin, '/recognition/guide')
        fields = ('shape', 'hud', 'camera', 'calibrated')
        if library == after and all(before.get(key) == guide.get(key) for key in fields):
            return {**library, 'guide': {key: guide[key] for key in fields}}
    raise RuntimeError('Registration data changed during backup. Retry when registration is idle.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True, help='Complete, previously deployed dist directory')
    parser.add_argument('--origin', help='Read-only live snapshot source; fails rather than silently using old data')
    parser.add_argument('--snapshot', type=Path, help='Existing snapshot (its source time is recorded)')
    parser.add_argument('--output', type=Path, default=ROOT / 'runtime/backups')
    args = parser.parse_args()
    if not args.assets.is_dir() or not (args.assets / 'cloud/app.js').is_file():
        raise SystemExit('A complete deployed assets directory is required.')
    if not args.origin and not args.snapshot:
        raise SystemExit('Specify --origin or --snapshot for registration backup.')
    snapshot = capture(args.origin) if args.origin else json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
    if not isinstance(snapshot.get('targets'), list) or not snapshot.get('guide'):
        raise SystemExit('Snapshot must contain registration targets and calibration.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = args.output.resolve() / stamp
    destination.mkdir(parents=True, exist_ok=False)
    # Copy first: all paths are explicit and no existing recovery bundle is removed.
    shutil.copytree(args.assets, destination / 'assets')
    (destination / 'registrations.json').write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
    subprocess.run(['git', 'bundle', 'create', str(destination / 'source.bundle'), 'HEAD'], cwd=ROOT, check=True)
    for name in ('wrangler.jsonc', 'wrangler.local.jsonc', 'AndroidManifest.xml'):
        shutil.copy2(ROOT / name, destination / name)
    manifest = {
        'schema': 1, 'createdAt': stamp,
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'snapshotOrigin': args.origin,
        'snapshotFile': str(args.snapshot.resolve()) if args.snapshot else None,
        'snapshotFileModifiedAt': args.snapshot.stat().st_mtime if args.snapshot else None,
        'targets': len(snapshot['targets']),
        'images': sum(len(t.get('images', [])) for t in snapshot['targets']),
        'files': {str(p.relative_to(destination)).replace('\\', '/'): digest(p)
                  for p in sorted(destination.rglob('*')) if p.is_file()}
    }
    (destination / 'backup.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    for name, expected in manifest['files'].items():
        if digest(destination / name) != expected:
            raise RuntimeError('Backup verification failed: ' + name)
    print(json.dumps({'backup': str(destination), 'targets': manifest['targets'], 'images': manifest['images'], 'verified': True}))


if __name__ == '__main__':
    main()
