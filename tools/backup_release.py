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
    parser.add_argument('--kind', choices=['deployed','candidate'], default='deployed')
    parser.add_argument('--apk', type=Path, help='Optional verified candidate APK and its JSON metadata')
    parser.add_argument('--source-ref', default='HEAD', help='Source commit matching these assets; may be an ancestor of HEAD')
    parser.add_argument('--deployment-id', help='Previously verified deployed Worker version, when backing up deployment assets')
    args = parser.parse_args()
    if not args.assets.is_dir() or not (args.assets / 'cloud/app.js').is_file():
        raise SystemExit('A complete deployed assets directory is required.')
    if not args.origin and not args.snapshot:
        raise SystemExit('Specify --origin or --snapshot for registration backup.')
    source_ref=subprocess.check_output(['git','rev-parse','--verify','--end-of-options',args.source_ref+'^{commit}'],cwd=ROOT,text=True).strip()
    if subprocess.run(['git','merge-base','--is-ancestor',source_ref,'HEAD'],cwd=ROOT).returncode:
        raise SystemExit('Source ref must be in the bundled HEAD history.')
    snapshot = capture(args.origin) if args.origin else json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
    if not isinstance(snapshot.get('targets'), list) or not snapshot.get('guide'):
        raise SystemExit('Snapshot must contain registration targets and calibration.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = args.output.resolve() / stamp
    destination.mkdir(parents=True, exist_ok=False)
    # Copy first: all paths are explicit and no existing recovery bundle is removed.
    shutil.copytree(args.assets, destination / 'assets')
    (destination / 'registrations.json').write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
    if args.apk:
        metadata=json.loads(args.apk.with_suffix('.json').read_text(encoding='utf-8'))
        if digest(args.apk)!=metadata.get('sha256') or not metadata.get('signatureVerified'):
            raise RuntimeError('APK metadata/hash validation failed')
        shutil.copy2(args.apk,destination/args.apk.name)
        shutil.copy2(args.apk.with_suffix('.json'),destination/args.apk.with_suffix('.json').name)
    subprocess.run(['git', 'bundle', 'create', str(destination / 'source.bundle'), 'HEAD'], cwd=ROOT, check=True)
    for name in ('wrangler.jsonc', 'wrangler.local.jsonc', 'wrangler.secure.jsonc', 'release.json', 'AndroidManifest.xml'):
        data=subprocess.run(['git','show',source_ref+':'+name],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if data.returncode==0:(destination/name).write_bytes(data.stdout)
    manifest = {
        'schema': 1, 'createdAt': stamp, 'kind':args.kind,
        'commit': source_ref,
        'bundleHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'deploymentId':args.deployment_id,
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
