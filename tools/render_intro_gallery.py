"""전환 애니메이션 미리보기를 굽고 비교용 HTML을 만든다.

    python tools/render_intro_gallery.py            → preview/intros/index.html (+ 01_box.mp4 …)
    python tools/render_intro_gallery.py warp iris  → 일부만 다시 굽기

미리보기 = 애니메이션 + 마주봄 영상 앞 3초. 안경에 쓸 때는 render_intro.py --style 이름.
"""
import html
import os
import sys
import tempfile

import render_intro as R
from intro_styles import STYLES

OUT_DIR = os.path.join(R.ROOT, 'preview', 'intros')
SRC = os.path.join(R.VID, 'majubom_layout.mp4')
CURRENT = 'box'   # 지금 d·e 키에 붙어 있는 것


def bake(key, n, first):
    out = os.path.join(OUT_DIR, f'{n:02d}_{key}.mp4')
    intro = os.path.join(tempfile.mkdtemp(), 'intro.mp4')
    R.bake_intro(key, first, intro)
    R.join(intro, SRC, out, limit=3.0)
    print(out, flush=True)


def page():
    cards = []
    for n, (key, st) in enumerate(STYLES.items(), 1):
        badge = '<span class="badge">지금 적용</span>' if key == CURRENT else ''
        cards.append(f'''
    <article class="card">
      <div class="screen"><video src="{n:02d}_{key}.mp4" autoplay muted loop playsinline></video></div>
      <div class="meta">
        <div class="no">{n:02d}</div>
        <h2>{html.escape(st["title"])}{badge}</h2>
        <p>{html.escape(st["desc"])}</p>
        <code>--style {key}</code> <span class="dur">{st["dur"]:.1f}초</span>
      </div>
    </article>''')
    return f'''<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>인식 전환 애니메이션</title>
<style>
  body {{ margin: 0; background: #0b0d0c; color: #cfe9d4; font-family: "Malgun Gothic", sans-serif; }}
  header {{ padding: 28px 32px 8px; display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; }}
  h1 {{ margin: 0; font-size: 24px; color: #3dff5a; }}
  header p {{ margin: 0; color: #7fa889; font-size: 14px; }}
  button {{ background: #133318; color: #3dff5a; border: 1px solid #1fae35; border-radius: 6px;
            padding: 6px 14px; font: inherit; cursor: pointer; }}
  main {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 22px; padding: 20px 32px 40px; }}
  .card {{ background: #121614; border: 1px solid #1d2a21; border-radius: 10px; overflow: hidden; }}
  .screen {{ background: #000; display: flex; justify-content: center; padding: 14px 0; }}
  video {{ width: 240px; height: 320px; background: #000; cursor: pointer; }}
  .meta {{ padding: 12px 16px 16px; position: relative; }}
  .no {{ position: absolute; right: 16px; top: 12px; color: #2f5a39; font-size: 22px; font-weight: 700; }}
  h2 {{ margin: 0 0 6px; font-size: 17px; color: #e6f7ea; }}
  .badge {{ margin-left: 8px; font-size: 11px; background: #3dff5a; color: #08200d; padding: 2px 6px; border-radius: 4px; vertical-align: middle; }}
  p {{ margin: 0 0 10px; font-size: 13px; line-height: 1.55; color: #9dbba5; }}
  code {{ font-size: 12px; color: #3dff5a; background: #0b1a0f; padding: 2px 6px; border-radius: 4px; }}
  .dur {{ font-size: 12px; color: #6f8f77; margin-left: 6px; }}
</style>
</head>
<body>
<header>
  <h1>인식 전환 애니메이션</h1>
  <p>안경 화면(480×640, 초록 단색, 검정=투명) 그대로 · 애니메이션 뒤에 마주봄 영상 앞 3초 · 화면을 누르면 처음부터 소리와 함께</p>
  <button id="all">전체 처음부터</button>
</header>
<main>{''.join(cards)}
</main>
<script>
  document.querySelectorAll('video').forEach(v => v.addEventListener('click', () => {{
    document.querySelectorAll('video').forEach(o => {{ if (o !== v) o.muted = true; }});
    v.muted = false; v.currentTime = 0; v.play();
  }}));
  document.getElementById('all').onclick = () =>
    document.querySelectorAll('video').forEach(v => {{ v.muted = true; v.currentTime = 0; v.play(); }});
</script>
</body>
</html>
'''


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    first = R.first_frame(SRC)
    only = sys.argv[1:]
    for n, key in enumerate(STYLES, 1):
        if not only or key in only:
            bake(key, n, first)
    path = os.path.join(OUT_DIR, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(page())
    print(path)


if __name__ == '__main__':
    main()
