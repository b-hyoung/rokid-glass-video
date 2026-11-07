"""Build the existing Android app on macOS or Windows without changing source resources."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from android_deps import dependencies

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
    if not jar.exists():
        raise SystemExit('Set ANDROID_HOME to an SDK containing android-36 and build-tools 36.0.0')
    output = ROOT / 'build'
    output.mkdir(exist_ok=True)
    version = ET.parse(ROOT/'AndroidManifest.xml').getroot().get('{http://schemas.android.com/apk/res/android}versionName')
    apk = output / f'glass-video-{version}.apk'
    jars = dependencies(output)
    with tempfile.TemporaryDirectory(prefix='android-', dir=output) as work:
        w = Path(work)
        for d in ['gen', 'classes', 'dex']:
            (w / d).mkdir()
        shutil.copytree(ROOT / 'res', w / 'res')
        strings = w / 'res/values/strings.xml'
        tree = ET.parse(strings)
        overrides = {'LOCAL':'local_servers','SERVER':'default_server'}
        for var, name in overrides.items():
            if var in os.environ:
                tree.find(f'.//string[@name="{name}"]').text = os.environ[var]
        tree.write(strings, encoding='utf-8', xml_declaration=True)
        run([tool('aapt2'), 'compile', '--dir', w/'res', '-o', w/'res.zip'])
        run([tool('aapt2'), 'link', '-o', w/'unsigned.apk', '-I', jar, '--manifest', ROOT/'AndroidManifest.xml', '--java', w/'gen', '--min-sdk-version', '29', '--target-sdk-version', '32', '-0', 'mp4', w/'res.zip'])
        sources = list((ROOT/'src').rglob('*.java')) + list((w/'gen').rglob('*.java'))
        run(['javac','-encoding','UTF-8','--release','11','-classpath',os.pathsep.join(str(x) for x in [jar,*jars]),'-d',w/'classes',*sources])
        run([tool('d8'),'--release','--min-api','29','--lib',jar,'--output',w/'dex',*list((w/'classes').rglob('*.class')),*jars])
        run(['jar','uf',w/'unsigned.apk','classes.dex'], cwd=w/'dex')
        run(['jar','uf',w/'unsigned.apk','THIRD_PARTY_NOTICES.txt'], cwd=ROOT)
        run([tool('zipalign'),'-f','-p','4',w/'unsigned.apk',w/'aligned.apk'])
        key = Path(os.environ.get('ANDROID_KEYSTORE', str(Path.home()/'.android/debug.keystore')))
        if not key.exists():
            raise SystemExit('Existing signing keystore required; set ANDROID_KEYSTORE')
        run([tool('apksigner'),'sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,w/'aligned.apk'])
        run([tool('apksigner'),'verify',apk])
        print(apk)

if __name__ == '__main__':
    main()
