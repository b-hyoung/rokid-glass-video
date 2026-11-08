"""Restore hash-locked assets from a recovery bundle into a clean checkout.

The backup directory is private and never committed. Nothing is downloaded from
an unverified URL, and existing matching source assets are kept.
"""
import argparse
from pathlib import Path
import shutil
from release_assets import ROOT, contract, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-backup', type=Path, required=True, help='Recovery bundle assets directory')
    args = parser.parse_args()
    for asset in contract()['assets']:
        destination = ROOT / asset['source']
        if destination.is_file() and sha256(destination) == asset['sha256']:
            continue
        source = args.from_backup / asset['destination']
        if not source.is_file() or sha256(source) != asset['sha256']:
            raise SystemExit('Verified recovery asset missing: ' + asset['destination'])
        if destination.exists():
            raise SystemExit('Existing different asset preserved: ' + str(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    print('All required assets prepared and hashes verified.')


if __name__ == '__main__':
    main()
