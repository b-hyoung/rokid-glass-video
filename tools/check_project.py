"""One command for deterministic, offline checks; never sends device commands."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import os
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'runtime/checks/latest.json')
    args = parser.parse_args()
    checks = [
        ['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('*.test.mjs'))]],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
    ]
    javac=shutil.which('javac')
    if not javac and os.name=='nt':
        candidates=sorted(Path(os.environ.get('ProgramFiles','C:/Program Files')).glob('Eclipse Adoptium/jdk-25*/bin/javac.exe'))
        if candidates:javac=str(candidates[-1])
    if not javac:
        raise SystemExit('JDK required for lifecycle/identity checks (javac not found).')
    java=str(Path(javac).with_name('java.exe' if os.name=='nt' else 'java'))
    work=tempfile.TemporaryDirectory(prefix='glass-native-check-')
    version=json.loads((ROOT/'release.json').read_text(encoding='utf-8'))['app']['version']
    build_info=Path(work.name)/'BuildInfo.java'
    build_info.write_text('package com.hoonartis.glassvideo; final class BuildInfo { static final String VERSION='+json.dumps(version)+'; }',encoding='utf-8')
    sources=['PlaybackReporter','SessionWorkers','DeviceAccess','PatchTracker','PlaybackGate','DwellDisplay','DwellRing','LumaFrame','BoxMotion']
    checks += [[javac,'-encoding','UTF-8','-d',work.name,str(build_info),*[str(ROOT/'src/com/hoonartis/glassvideo'/f'{name}.java') for name in sources],str(ROOT/'tests/native/SessionWorkersTest.java'),str(ROOT/'tests/native/DeviceAccessTest.java'),str(ROOT/'tests/native/NativeBehaviorTest.java'),str(ROOT/'tests/native/PlaybackReporterTest.java')],
               [java,'-cp',work.name,'com.hoonartis.glassvideo.SessionWorkersTest'],
               [java,'-cp',work.name,'com.hoonartis.glassvideo.PlaybackReporterTest'],
               [java,'-cp',work.name,'com.hoonartis.glassvideo.DeviceAccessTest'],
               [java,'-cp',work.name,'com.hoonartis.glassvideo.NativeBehaviorTest']]
    results = []
    for command in checks:
        start = time.monotonic()
        completed = subprocess.run(command, cwd=ROOT)
        results.append({'command': command, 'exitCode': completed.returncode, 'seconds': time.monotonic() - start})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({'checks': results, 'hardwareValidated': False}, indent=2), encoding='utf-8')
    work.cleanup()
    sys.exit(any(result['exitCode'] for result in results))


if __name__ == '__main__':
    main()
