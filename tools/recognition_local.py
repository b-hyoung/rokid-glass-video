"""Run the local vector registration and playback trial."""
import base64
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from threading import Lock

from PIL import Image
import torch

from recognition_appearance import Appearance


ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / 'build' / 'appearance-local.pt'
VIDEOS = json.loads((ROOT / 'server' / 'videos.json').read_text(encoding='utf-8'))
MAX_BODY = 12 * 1024 * 1024


def decode_image(encoded):
    with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as image:
        if image.width * image.height > 2_000_000:
            raise ValueError('이미지가 너무 큽니다.')
        return image.convert('RGB')


class Handler(SimpleHTTPRequestHandler):
    def respond(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/videos':
            return self.respond(VIDEOS)
        if self.path == '/':
            self.path = '/tools/recognition_local.html'
        elif self.path.startswith('/video/'):
            video = VIDEOS.get(self.path.removeprefix('/video/'))
            if video is None:
                return self.send_error(404)
            self.path = '/server/videos/' + video['file']
        elif self.path not in ('/cloud/decoder.js', '/cloud/stream-protocol.mjs'):
            return self.send_error(404)
        super().do_GET()

    def do_POST(self):
        if self.path not in ('/register', '/score'):
            return self.send_error(404)
        if self.headers.get_content_type() != 'application/json':
            return self.send_error(415)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BODY:
                return self.send_error(413)
            data = json.loads(self.rfile.read(size))
            with self.server.inference_lock:
                result = self.register(data) if self.path == '/register' else self.score(data)
            self.respond(result)
        except (TypeError, KeyError, ValueError, OSError) as error:
            self.respond({'error': str(error)}, 400)

    def register(self, data):
        name = data['name'].strip()
        key = data['key']
        images = data['images']
        if not name or len(name) > 60 or key not in VIDEOS or not 1 <= len(images) <= 12:
            raise ValueError('이름, 연결 영상, 참조 이미지 1~12장을 지정하세요.')
        vectors = self.server.model.extract([decode_image(image) for image in images])
        updated = dict(self.server.targets)
        updated[name] = {'key': key, 'vectors': vectors}
        BANK.parent.mkdir(exist_ok=True)
        temporary = BANK.with_suffix('.tmp')
        torch.save(updated, temporary)
        temporary.replace(BANK)
        self.server.targets = updated
        return {'name': name, 'references': len(images)}

    def score(self, data):
        image = decode_image(data['image'])
        width, height = image.size
        crops = [image.crop((round(width*(1-s)/2), round(height*(1-s)/2),
                             round(width*(1+s)/2), round(height*(1+s)/2)))
                 for s in (.35, .55, .75)]
        query = self.server.model.extract(crops)
        ranked = sorted(
            ({'name': name, 'key': target['key'],
              'score': (query @ target['vectors'].T).max().item()}
             for name, target in self.server.targets.items()),
            key=lambda result: result['score'], reverse=True)
        # Provisional values for the local trial. Calibrate on held-out positives and negatives.
        winner = ranked[0] if ranked else None
        if winner and (winner['score'] < .72 or
                       (len(ranked) > 1 and winner['score'] - ranked[1]['score'] < .05)):
            winner = None
        return {'winner': winner, 'scores': ranked}


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8790), lambda *a, **kw: Handler(*a, directory=ROOT, **kw))
    server.model = Appearance()
    server.targets = torch.load(BANK, weights_only=True, map_location='cpu') if BANK.exists() else {}
    server.inference_lock = Lock()
    print('http://127.0.0.1:8790', flush=True)
    server.serve_forever()
