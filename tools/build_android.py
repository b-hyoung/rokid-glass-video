"""Build the existing Android app on macOS or Windows without changing source resources."""
import os
import argparse
import json
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from android_deps import dependencies
from release_assets import contract, sha256

ROOT = Path(__file__).resolve().parent.parent
sdk_default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'Library'))) / ('Android/Sdk' if os.name == 'nt' else 'Android/sdk')
sdk = Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', sdk_default)))
bt = sdk / 'build-tools/36.0.0'
jar = sdk / 'platforms/android-36/android.jar'

def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

def tool(name):
    return bt / (name + ('.bat' if os.name == 'nt' and name in ['d8', 'apksigner'] else '.exe' if os.name == 'nt' else ''))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release',action='store_true',help='Require an explicitly configured release certificate and key')
    parser.add_argument('--candidate-output', type=Path, help='Use a separate filename for a candidate APK')
    args=parser.parse_args()
    if args.candidate_output and (args.release or args.candidate_output.suffix != '.apk'):
        parser.error('--candidate-output requires a candidate build and an .apk path')
    if not jar.exists():
        raise SystemExit('Set ANDROID_HOME to an SDK containing android-36 and build-tools 36.0.0')
    output = ROOT / 'build'
    output.mkdir(exist_ok=True)
    version = ET.parse(ROOT/'AndroidManifest.xml').getroot().get('{http://schemas.android.com/apk/res/android}versionName')
    release=contract()
    version_code=int(ET.parse(ROOT/'AndroidManifest.xml').getroot().get('{http://schemas.android.com/apk/res/android}versionCode'))
    if version!=release['app']['version'] or version_code!=release['app']['versionCode']:
        raise SystemExit('AndroidManifest.xml differs from release.json')
    if args.release and (not release['app']['certificateSha256'] or not os.environ.get('ANDROID_KEYSTORE') or not os.environ.get('ANDROID_KEYSTORE_PASSWORD')):
        raise SystemExit('Verified certificate in release.json and explicit signing key/password environment required')
    apk = (args.candidate_output or output / f'glass-video-{version}{"" if args.release else "-candidate"}.apk').resolve()
    if not apk.parent.is_dir():
        parser.error('APK output directory must already exist')
    if args.release and apk.exists():
        raise SystemExit('Existing release APK preserved. Increment the version for a new release.')
    with tempfile.TemporaryDirectory(prefix='android-', dir=output) as work:
        w = Path(work)
        jars = dependencies(output, w)
        for d in ['gen', 'classes', 'dex']:
            (w / d).mkdir()
        shutil.copytree(ROOT / 'res', w / 'res')
        strings = w / 'res/values/strings.xml'
        tree = ET.parse(strings)
        if 'SERVER' in os.environ:
            tree.find('.//string[@name="default_server"]').text=os.environ['SERVER']
        tree.write(strings, encoding='utf-8', xml_declaration=True)
        shutil.copy2(ROOT/'AndroidManifest.xml', w)
        # Windows SDK native tools can fail on non-ASCII absolute workspace paths.
        run([tool('aapt2'), 'compile', '--dir', 'res', '-o', 'res.zip'], cwd=w)
        run([tool('aapt2'), 'link', '-o', 'unsigned.apk', '-I', jar, '--manifest', 'AndroidManifest.xml', '--java', 'gen', '--min-sdk-version', '29', '--target-sdk-version', '32', '-0', 'mp4', 'res.zip'], cwd=w)
        generated=w/'gen/com/hoonartis/glassvideo/BuildInfo.java'
        generated.write_text('package com.hoonartis.glassvideo; final class BuildInfo { static final String VERSION='+json.dumps(version)+'; static final int PROTOCOL='+str(release['protocol'])+'; }',encoding='utf-8')
        sources = list((ROOT/'src').rglob('*.java')) + list((w/'gen').rglob('*.java'))
        run(['javac','-encoding','UTF-8','--release','11','-classpath',os.pathsep.join(str(x) for x in [jar,*jars]),'-d',w/'classes',*sources])
        run([tool('d8'),'--release','--min-api','29','--lib',jar,'--output',w/'dex',*list((w/'classes').rglob('*.class')),*jars])
        run(['jar','uf',w/'unsigned.apk',*[p.name for p in (w/'dex').glob('classes*.dex')]], cwd=w/'dex')
        run(['jar','uf',w/'unsigned.apk','lib'], cwd=w)
        run(['jar','uf',w/'unsigned.apk','THIRD_PARTY_NOTICES.txt'], cwd=ROOT)
        run([tool('zipalign'),'-f','-p','4','unsigned.apk','aligned.apk'], cwd=w)
        key = Path(os.environ.get('ANDROID_KEYSTORE', str(Path.home()/'.android/debug.keystore')))
        if not key.exists():
            raise SystemExit('Existing signing keystore required; set ANDROID_KEYSTORE')
        signing_env={**os.environ}
        if not args.release:
            signing_env.setdefault('ANDROID_KEYSTORE_PASSWORD','android')
        signing_env.setdefault('ANDROID_KEY_PASSWORD',signing_env['ANDROID_KEYSTORE_PASSWORD'])
        signing=[tool('apksigner'),'sign','--ks',key,'--ks-pass','env:ANDROID_KEYSTORE_PASSWORD','--key-pass','env:ANDROID_KEY_PASSWORD']
        if os.environ.get('ANDROID_KEY_ALIAS'):signing+=['--ks-key-alias',os.environ['ANDROID_KEY_ALIAS']]
        signed=w/'signed.apk'
        run([*signing,'--out',signed,w/'aligned.apk'],env=signing_env)
        verification=subprocess.check_output([str(tool('apksigner')),'verify','--print-certs',str(signed)],text=True,encoding='utf-8')
        fingerprint=re.search(r'certificate SHA-256 digest: ([0-9a-fA-F]+)',verification)
        if not fingerprint:raise SystemExit('Could not verify signing certificate')
        fingerprint=fingerprint.group(1).lower()
        if args.release and fingerprint!=release['app']['certificateSha256']:
            raise SystemExit('Signing certificate differs from the approved release certificate')
        os.replace(signed,apk)
        apk.with_suffix('.json').write_text(json.dumps({'version':version,'versionCode':version_code,'protocol':release['protocol'],'sha256':sha256(apk),'certificateSha256':fingerprint,'signatureVerified':True,'candidate':not args.release,'defaultServer':tree.find('.//string[@name="default_server"]').text},indent=2),encoding='utf-8')
        print(apk)

if __name__ == '__main__':
    main()
