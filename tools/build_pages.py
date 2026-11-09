"""Build validated web or release assets into a new output directory.

python tools/build_pages.py --mode web --output build/web-assets
python tools/build_pages.py --mode release --output build/release-assets
Existing output directories are never removed or overwritten.
"""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
from release_assets import ROOT, validate_assets, runtime_config, sha256

PLAYER = '''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2412호 · 안경 인식 시연 영상</title>
<style>
  body { margin: 0; background: #0b0d0c; color: #cfe9d4; font: 15px/1.6 "Malgun Gothic", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 20px; }
  h1 { margin: 0 0 6px; font-size: 24px; color: #3dff5a; }
  p { margin: 0 0 18px; color: #8fb39a; }
  video { width: 100%; border-radius: 8px; background: #000; }
  a { color: #3dff5a; }
</style></head><body><main>
<h1>2412호 · 안경으로 보면 뜨는 영상</h1>
<p>마주봄 → 견훤 → 애플 비전 프로 → 스마트홈 → 메타 퀘스트 순서의 시연 녹화. 직접 둘러보기: <a href="/demo/2412/">3D 데모</a></p>
<video src="2412-demo.mp4" controls playsinline preload="metadata"></video>
</main></body></html>
'''


def build(root, output, mode='release'):
    root, output = Path(root), Path(output).resolve()
    release = validate_assets(root, mode)
    if output.exists():
        raise ValueError('Output already exists; choose a new --output directory: ' + str(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='glass-assets-', dir=output.parent) as temporary:
        stage = Path(temporary) / 'assets'
        shutil.copytree(root / 'demo', stage / 'demo')
        shutil.copytree(root / 'cloud', stage / 'cloud', ignore=shutil.ignore_patterns('worker.mjs', 'target-store.mjs', 'state-feed.mjs', 'request-policy.mjs', 'session-access.mjs', 'library-snapshot.mjs', 'handlers', 'session-*.mjs'))
        for asset in release['assets']:
            destination = stage / asset['destination']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / asset['source'], destination)
        videos = json.loads((root / 'server/videos.json').read_text(encoding='utf-8'))
        listing = {}
        for key, video in videos.items():
            source = root / 'server/videos' / video['file']
            listing[key] = {**video, 'loop': bool(video.get('loop')), 'size': source.stat().st_size, 'ver': int(source.stat().st_mtime * 1000)}
        (stage / 'videos.json').write_text(json.dumps(listing, ensure_ascii=False), encoding='utf-8')
        if mode == 'release':
            apk = root / release['app']['apk']
            (stage / 'downloads').mkdir()
            shutil.copy2(apk, stage / 'downloads/glass-video.apk')
            shutil.copy2(apk, stage / 'downloads' / apk.name)
        config = runtime_config(release, downloads=mode == 'release')
        (stage / 'runtime-config.json').write_text(json.dumps(config), encoding='utf-8')
        recording = root / 'recordings/2412_시연영상.mp4'
        if recording.exists():
            (stage / 'video').mkdir()
            shutil.copy2(recording, stage / 'video/2412-demo.mp4')
            (stage / 'video/index.html').write_text(PLAYER, encoding='utf-8')
        (stage / '_headers').write_text('/server.txt\n  Cache-Control: no-store\n/downloads/glass-video.apk\n  Cache-Control: no-store\n/runtime-config.json\n  Cache-Control: no-store\n/cloud/*\n  Cache-Control: no-cache\n', encoding='utf-8')
        (stage / '_redirects').write_text('/demo/2412 /demo/2412/index.html 302\n/demo/2412/ /demo/2412/index.html 302\n', encoding='utf-8')
        metadata={**config,'assets':[{'path':a['destination'],'sha256':a['sha256']} for a in release['assets']],
                  'files':{str(p.relative_to(stage)).replace('\\','/'):sha256(p) for p in sorted(stage.rglob('*')) if p.is_file()}}
        (stage / 'release.json').write_text(json.dumps(metadata,indent=2),encoding='utf-8')
        stage.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['web', 'release'], default='release')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    try:
        output = build(ROOT, args.output, args.mode)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    total = sum(p.stat().st_size for p in output.rglob('*') if p.is_file())
    print(str(output), f'{total / 1e6:.1f} MB ({args.mode})')


if __name__ == '__main__':
    main()
