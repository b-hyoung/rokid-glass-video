"""Shared release contract for builders and local launchers."""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def contract(root=ROOT):
    return json.loads((Path(root) / 'release.json').read_text(encoding='utf-8'))


def sha256(path):
    sha = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(data)
    return sha.hexdigest()


def validate_assets(root=ROOT, mode='web'):
    root = Path(root)
    release = contract(root)
    manifest = ET.parse(root / 'AndroidManifest.xml').getroot()
    android = '{http://schemas.android.com/apk/res/android}'
    if (manifest.get(android + 'versionName'), int(manifest.get(android + 'versionCode'))) != (release['app']['version'], release['app']['versionCode']):
        raise ValueError('Android version differs from release.json')
    required = release['assets']
    for asset in required:
        path = root / asset['source']
        if not path.is_file():
            raise ValueError('Required asset missing: ' + asset['source'])
        if sha256(path) != asset['sha256']:
            raise ValueError('Asset checksum mismatch: ' + asset['source'])
    videos = json.loads((root / 'server/videos.json').read_text(encoding='utf-8'))
    declared = {asset['destination'] for asset in required}
    for item in videos.values():
        if Path(item['file']).name != item['file'] or 'v/' + item['file'] not in declared:
            raise ValueError('Video is not locked in release.json: ' + item['file'])
    if mode == 'release':
        apk = root / release['app']['apk']
        metadata_path = apk.with_suffix('.json')
        if not apk.is_file() or not metadata_path.is_file():
            raise ValueError('Release APK and verified signing metadata required: ' + str(apk))
        metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
        for key in ('version', 'versionCode', 'protocol'):
            expected = release['protocol'] if key == 'protocol' else release['app'][key]
            if metadata.get(key) != expected:
                raise ValueError('APK metadata mismatch: ' + key)
        fingerprint = release['app'].get('certificateSha256')
        if not fingerprint or metadata.get('certificateSha256') != fingerprint:
            raise ValueError('Release signing certificate has not been approved in release.json')
        if metadata.get('sha256') != sha256(apk) or not metadata.get('signatureVerified'):
            raise ValueError('APK checksum/signature metadata mismatch')
    return release


def runtime_config(release, mode='cloud', downloads=False):
    return {'mode': mode, 'protocol': release['protocol'], 'appVersion': release['app']['version'],
            'engine': release['engine'], 'downloadUrl': '/downloads/glass-video.apk' if downloads else None}
