"""Cloudflare Pages 배포용 정적 폴더(dist/)를 만든다.

    python tools/build_pages.py
    npx wrangler pages deploy dist --project-name glass-2412 --branch main

담는 것: 2412호 3D 데모(/demo/2412/), 안경 영상 목록(/videos.json)과 영상(/v/…), 시연 녹화(/video/).
서버 기능(/play로 실제 안경에 보내기, /rec 녹화 저장)은 정적 호스팅이라 빠진다(데모는 그대로 동작).
"""
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
REC = os.path.join(ROOT, 'recordings', '2412_시연영상.mp4')

PLAYER = '''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2412호 · 안경 인식 시연 영상</title>
<style>
  body { margin: 0; background: #0b0d0c; color: #cfe9d4; font: 15px/1.6 "Malgun Gothic", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 20px; }
  h1 { margin: 0 0 6px; font-size: 24px; color: #3dff5a; }
  p { margin: 0 0 18px; color: #8fb39a; }
  video { width: 100%; border-radius: 8px; background: #000; }
  a { color: #3dff5a; }
</style></head><body><main>
<h1>2412호 · 안경으로 보면 뜨는 영상</h1>
<p>마주봄 → 견훤 → 애플 비전 프로 → 스마트홈 → 메타 퀘스트 순서의 시연 녹화. 직접 둘러보기: <a href="/demo/2412/">3D 데모</a></p>
<video src="2412-demo.mp4" controls playsinline preload="metadata"></video>
</main></body></html>
'''


def main():
    shutil.rmtree(DIST, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, 'demo'), os.path.join(DIST, 'demo'))
    with open(os.path.join(ROOT, 'server', 'videos.json'), encoding='utf-8') as f:
        videos = json.load(f)
    os.makedirs(os.path.join(DIST, 'v'))
    out = {}
    for key, v in videos.items():
        src = os.path.join(ROOT, 'server', 'videos', v['file'])
        shutil.copy2(src, os.path.join(DIST, 'v', v['file']))
        out[key] = {'title': v['title'], 'file': v['file'], 'loop': bool(v.get('loop'))}
    with open(os.path.join(DIST, 'videos.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    if os.path.exists(REC):
        os.makedirs(os.path.join(DIST, 'video'))
        shutil.copy2(REC, os.path.join(DIST, 'video', '2412-demo.mp4'))
        with open(os.path.join(DIST, 'video', 'index.html'), 'w', encoding='utf-8') as f:
            f.write(PLAYER)
    with open(os.path.join(DIST, '_redirects'), 'w', encoding='utf-8') as f:
        f.write('/ /demo/2412/ 302\n/demo/2412 /demo/2412/ 301\n')
    total = sum(os.path.getsize(os.path.join(d, n)) for d, _, fs in os.walk(DIST) for n in fs)
    print(DIST, f'{total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
