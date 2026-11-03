"""마주봄 추억 영상용 임시 사진을 OpenAI 이미지 생성으로 만든다(AI 생성, 실제 사진 아님).
실제 사진이 생기면 tools/majubom_src/photos/ 의 같은 이름 파일을 덮어쓰면 된다.

    python tools/gen_majubom_photos.py          → 없는 사진만 생성
    python tools/gen_majubom_photos.py 06       → 06번만 다시 생성
"""
import base64
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'tools', 'majubom_src', 'photos')
MODELS = ['gpt-image-2', 'gpt-image-1']

STYLE = ('Candid documentary photo, warm nostalgic film look, soft natural light, slight grain, '
         'Korean university students in their early twenties, casual clothes, genuine smiles, '
         'shot on 35mm, shallow depth of field. No readable text, no logos, no watermarks.')
PHOTOS = {
    '01_first_meeting': 'Five students gathered around a classroom table covered with sticky notes, '
                        'laptops and coffee cups, brainstorming an idea together and laughing.',
    '02_building_sensors': 'Late evening in a university maker lab, students assembling small circuit boards, '
                           'a tiny radar sensor module and cables on a desk, one soldering, others leaning in, smiling.',
    '03_bed_experiment': 'In a lab arranged like a hospital room, one student lies on a hospital bed pretending to get up '
                         'while teammates adjust small sensors mounted on a stand beside the bed, everyone laughing.',
    '04_first_data': 'Students crowded around a laptop showing colorful live graphs, cheering and giving a high five '
                     'the moment their system works for the first time.',
    '05_rehearsal': 'Night before a competition, students rehearsing a presentation in front of a projector screen '
                    'in an empty classroom, one presenting, others giving thumbs up from the desks.',
    '06_award': 'Team of five students on a stage at a university competition award ceremony, holding a large '
                'blank award certificate together, proud and happy group photo, confetti, warm stage lights.',
}


def generate(name, prompt):
    key = os.environ['OPENAI_API_KEY']
    body = {'prompt': f'{prompt} {STYLE}', 'size': '1536x1024', 'n': 1}
    last = None
    for model in MODELS:
        req = urllib.request.Request(
            'https://api.openai.com/v1/images/generations',
            data=json.dumps({**body, 'model': model}).encode(),
            headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.load(r)['data'][0]
        except urllib.error.HTTPError as e:
            last = f'{model}: {e.code} {e.read()[:300]!r}'
            continue
        img = base64.b64decode(data['b64_json']) if data.get('b64_json') else urllib.request.urlopen(data['url']).read()
        path = os.path.join(DIR, name + '.jpg')
        Image.open(io.BytesIO(img)).convert('RGB').save(path, quality=88)
        return f'{name}: {model} → {path}'
    return f'{name}: 실패 {last}'


def main():
    os.makedirs(DIR, exist_ok=True)
    only = sys.argv[1:]
    todo = {n: p for n, p in PHOTOS.items()
            if (only and any(n.startswith(o) for o in only))
            or (not only and not any(os.path.exists(os.path.join(DIR, n + e)) for e in ('.png', '.jpg')))}
    with ThreadPoolExecutor(6) as ex:
        for line in ex.map(lambda kv: generate(*kv), todo.items()):
            print(line, flush=True)


if __name__ == '__main__':
    main()
