import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from release_assets import ROOT, validate_assets, sha256
from build_pages import build


class ReleaseBuildTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.release = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
        self.release['assets'] = []
        for name in ['model.onnx', 'ort.wasm.min.js', 'ort.wasm', 'video.mp4']:
            (self.root / name).write_bytes(name.encode())
            self.release['assets'].append({'source': name, 'destination': 'v/video.mp4' if name == 'video.mp4' else 'cloud/' + name, 'sha256': sha256(self.root / name)})
        shutil.copy2(ROOT / 'AndroidManifest.xml', self.root)
        for folder in ['demo', 'cloud', 'server']:
            (self.root / folder).mkdir()
        (self.root / 'cloud/index.html').write_text('web', encoding='utf-8')
        (self.root / 'server/videos.json').write_text('{"a":{"file":"video.mp4","title":"A"}}', encoding='utf-8')
        (self.root / 'server/videos').mkdir()
        shutil.copy2(self.root / 'video.mp4', self.root / 'server/videos/video.mp4')
        self.write_release()

    def write_release(self):
        (self.root / 'release.json').write_text(json.dumps(self.release), encoding='utf-8')

    def test_missing_model_runtime_and_apk_fail_before_touching_output(self):
        destination = self.root / 'dist'
        destination.mkdir()
        sentinel = destination / 'keep.txt'
        sentinel.write_text('previous deployed assets', encoding='utf-8')
        for name in ['model.onnx', 'ort.wasm.min.js', 'ort.wasm']:
            path = self.root / name
            data = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(ValueError, 'missing'):
                build(self.root, destination, 'release')
            self.assertEqual(sentinel.read_text(), 'previous deployed assets')
            path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'APK'):
            validate_assets(self.root, 'release')

    def test_web_build_explicitly_has_no_apk_download_and_does_not_overwrite(self):
        output = self.root / 'web-output'
        build(self.root, output, 'web')
        config = json.loads((output / 'runtime-config.json').read_text())
        self.assertIsNone(config['downloadUrl'])
        self.assertTrue((output / 'cloud/model.onnx').exists())
        with self.assertRaisesRegex(ValueError, 'already exists'):
            build(self.root, output, 'web')

    def test_modified_asset_and_version_mismatch_are_rejected(self):
        (self.root / 'model.onnx').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            validate_assets(self.root)
        self.release['app']['versionCode'] += 1
        self.write_release()
        with self.assertRaisesRegex(ValueError, 'version'):
            validate_assets(self.root)

    def test_candidate_and_unapproved_certificate_cannot_enter_release_assets(self):
        self.release['app']['apk']='candidate.apk'
        self.write_release()
        apk=self.root/'candidate.apk';apk.write_bytes(b'candidate binary')
        metadata={'version':self.release['app']['version'],'versionCode':self.release['app']['versionCode'],'protocol':self.release['protocol'],'sha256':sha256(apk),'signatureVerified':True,'candidate':True,'certificateSha256':'test-certificate'}
        apk.with_suffix('.json').write_text(json.dumps(metadata),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'Candidate'):
            validate_assets(self.root,'release')
        metadata['candidate']=False;apk.with_suffix('.json').write_text(json.dumps(metadata),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'certificate'):
            validate_assets(self.root,'release')


if __name__ == '__main__':
    unittest.main()
