"""One command for deterministic, offline checks; never sends device commands."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'runtime/checks/latest.json')
    args = parser.parse_args()
    checks = [
        ['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('*.test.mjs'))]],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
    ]
    results = []
    for command in checks:
        start = time.monotonic()
        completed = subprocess.run(command, cwd=ROOT)
        results.append({'command': command, 'exitCode': completed.returncode, 'seconds': time.monotonic() - start})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({'checks': results, 'hardwareValidated': False}, indent=2), encoding='utf-8')
    sys.exit(any(result['exitCode'] for result in results))


if __name__ == '__main__':
    main()
