"""Run the current glasses Worker and recognition UI entirely on this PC."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from release_assets import contract, validate_assets, runtime_config

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime'
ASSETS = RUNTIME / 'local-assets'


def copy_if_changed(source, destination):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists() or (source.stat().st_size, source.stat().st_mtime_ns) != (destination.stat().st_size, destination.stat().st_mtime_ns):
        shutil.copy2(source, destination)


def write_if_changed(destination, text):
    destination = Path(destination)
    if not destination.exists() or destination.read_text(encoding='utf-8') != text:
        destination.write_text(text, encoding='utf-8')


def lan_urls(port):
    addresses = {entry[4][0] for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    return [f'http://{address}:{port}' for address in sorted(addresses)
            if ipaddress.ip_address(address).is_private and not ipaddress.ip_address(address).is_loopback
            and not ipaddress.ip_address(address).is_link_local]


def prepare_assets(port):
    release = validate_assets(mode='web')
    ASSETS.mkdir(parents=True, exist_ok=True)
    for source in (ROOT / 'cloud').rglob('*'):
        if source.is_file() and source.name not in ('worker.mjs', 'target-store.mjs') and 'handlers' not in source.parts:
            copy_if_changed(source, ASSETS / 'cloud' / source.relative_to(ROOT / 'cloud'))
    model = ROOT / 'build/appearance-v1.onnx'
    ort = ROOT / 'build/appearance-web/node_modules/onnxruntime-web/dist'
    for filename in ('ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'):
        source = ort / filename
        if not source.exists():
            source = ROOT / 'dist/cloud/ort' / filename
        if not source.exists():
            raise RuntimeError(f'Browser inference runtime missing: {filename}. Prepare build/appearance-web first.')
        copy_if_changed(source, ASSETS / 'cloud/ort' / filename)
    if not model.exists():
        model = ROOT / 'dist/cloud/appearance-v1.onnx'
    if not model.exists():
        raise RuntimeError('Missing build/appearance-v1.onnx. Export the browser model before starting locally.')
    copy_if_changed(model, ASSETS / 'cloud/appearance-v1.onnx')
    videos = json.loads((ROOT / 'server/videos.json').read_text(encoding='utf-8'))
    listing = {}
    for key, video in videos.items():
        filename = video['file']
        if Path(filename).name != filename:
            raise ValueError('Video filename must not contain directories')
        source = ROOT / 'server/videos' / filename
        copy_if_changed(source, ASSETS / 'v' / filename)
        listing[key] = {'title': video['title'], 'file': filename, 'loop': bool(video.get('loop')),
                        'size': source.stat().st_size, 'ver': int(source.stat().st_mtime * 1000)}
    write_if_changed(ASSETS / 'videos.json', json.dumps(listing, ensure_ascii=False))
    write_if_changed(ASSETS / 'runtime-config.json', json.dumps(runtime_config(release, mode='local')))
    for filename in ('local-check.html', 'local-check.js', 'local-setup.html'):
        copy_if_changed(ROOT / 'tools' / filename, ASSETS / filename)
    info = {'local': True, 'service': 'rokid-glass-video-local', 'port': port, 'pcUrl': f'http://localhost:{port}', 'lanUrls': lan_urls(port)}
    write_if_changed(ASSETS / 'local-info.json', json.dumps(info))
    write_if_changed(ASSETS / '_headers', '/cloud/*\n  Cache-Control: no-cache\n/local-info.json\n  Cache-Control: no-store\n')
    return info


def wrangler_command():
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required.')
    candidates = [ROOT / 'node_modules/wrangler/bin/wrangler.js', ROOT / 'build/local-worker/node_modules/wrangler/bin/wrangler.js']
    cache = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.cache')) / 'npm-cache/_npx'
    if cache.exists():
        candidates.extend(sorted(cache.glob('*/node_modules/wrangler/bin/wrangler.js'), key=lambda p: p.stat().st_mtime, reverse=True))
    for candidate in candidates:
        package = candidate.parent.parent / 'package.json'
        if candidate.exists() and package.exists() and json.loads(package.read_text(encoding='utf-8')).get('version') == contract()['tools']['wrangler']:
            return [node, str(candidate)]
    npm = Path(node).resolve().parent / 'node_modules/npm/bin/npm-cli.js'
    if not npm.exists():
        raise RuntimeError('Install Wrangler locally with npm install --no-save --no-package-lock wrangler@4.158.0')
    print('Installing local Worker runtime (one time)...', flush=True)
    subprocess.run([node, str(npm), 'install', '--prefix', str(ROOT / 'build/local-worker'), '--no-audit', '--no-fund', '--no-package-lock', 'wrangler@4.158.0'], check=True)
    return [node, str(ROOT / 'build/local-worker/node_modules/wrangler/bin/wrangler.js')]


def api(port, path, data=None):
    # Only loopback is used for imports; this function never contacts production.
    request = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
        data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get('error', str(error))
        except (ValueError, AttributeError):
            detail = str(error)
        raise RuntimeError(detail) from error


def import_targets(port, source):
    if source and source.exists():
        data = json.loads(source.read_text(encoding='utf-8-sig'))
        result = api(port, '/local/import', data)
        if result.get('skipped'):
            print('Existing local registrations preserved.', flush=True)
        else:
            print(f"Imported {result['count']} targets / {result['images']} images to local storage.", flush=True)


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/pid', str(process.pid), '/t', '/f'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        process.terminate()
    process.wait(timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--targets', type=Path, default=RUNTIME / 'local-targets-import.json')
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    info = prepare_assets(args.port)
    print(f"Local test: {info['pcUrl']}/local-check.html", flush=True)
    print(f"Glasses control: {info['pcUrl']}/recognition", flush=True)
    for url in info['lanUrls']:
        print(f'Glasses LAN address: {url}', flush=True)
    if args.prepare_only:
        return
    with socket.socket() as probe:
        in_use = probe.connect_ex(('127.0.0.1', args.port)) == 0
    if in_use:
        try:
            if api(args.port, '/local-info.json').get('service') != 'rokid-glass-video-local':
                raise RuntimeError('Another service is using this port')
        except Exception as error:
            raise RuntimeError(f'Port {args.port} is occupied. Select another with --port.') from error
        import_targets(args.port, args.targets)
        print('Local server is already running.', flush=True)
        if not args.no_open:
            webbrowser.open(f"{info['pcUrl']}/local-check.html")
        return
    state_path = RUNTIME / ('local-state' if args.port == 8787 else f'local-state-{args.port}')
    command = wrangler_command() + ['dev', '--local', '--config', str(ROOT / 'wrangler.local.jsonc'),
        '--ip', '0.0.0.0', '--port', str(args.port), '--persist-to', str(state_path)]
    environment = {**os.environ, 'WRANGLER_SEND_METRICS': 'false', 'CI': 'true', 'NO_COLOR': '1'}
    log_path = RUNTIME / 'local-server.log'
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with log_path.open('a', encoding='utf-8') as log:
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            for _ in range(150):
                if process.poll() is not None:
                    raise RuntimeError(f'Local runtime exited. See {log_path}')
                try:
                    if api(args.port, '/local-info.json').get('local'):
                        break
                except (OSError, RuntimeError, ValueError):
                    time.sleep(.2)
            else:
                raise RuntimeError(f'Local server startup timed out. See {log_path}')
            import_targets(args.port, args.targets)
            api(args.port, '/preview/sync', {})
            print('Ready. Keep this process running; Ctrl+C stops the local server.', flush=True)
            print(f'Log: {log_path}', flush=True)
            if not args.no_open:
                webbrowser.open(f"{info['pcUrl']}/local-check.html")
            process.wait()
        except KeyboardInterrupt:
            pass
        finally:
            stop_process(process)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Local server: {error}', file=sys.stderr)
        sys.exit(1)
