"""videos.json에서 "intro"가 적힌 영상마다 전환 애니메이션을 붙여 굽고 "file"을 그 결과로 바꾼다.

    "e": {"title": "...", "src": "majubom_layout.mp4", "intro": "scan", "file": "majubom_scan.mp4", "loop": true}

    python tools/build_intros.py          → 바뀐 것만 굽기(원본·스크립트가 결과보다 새로우면 다시)
    python tools/build_intros.py --all    → 전부 다시

intro 값: box(상자) · scan(홀로그램 스캔) · envelope(편지 봉투) · iris(카메라 조리개) · tiles(타일 뒤집기)
"intro"를 지우면 원본(src)을 그대로 튼다. 서버는 목록을 요청마다 읽으므로 재시작 불필요.
"""
import json
import os
import sys

import render_intro as R
from intro_styles import STYLES

LIST = os.path.join(R.ROOT, 'server', 'videos.json')
TOOLS = [os.path.join(R.ROOT, 'tools', f) for f in ('render_intro.py', 'intro_styles.py')]


def main():
    force = '--all' in sys.argv
    with open(LIST, encoding='utf-8') as f:
        videos = json.load(f)
    for key, v in videos.items():
        src = v.get('src')
        if not src:
            continue
        style = v.get('intro')
        if not style:
            v['file'] = src
            continue
        if style not in STYLES:
            raise SystemExit(f'{key}: 모르는 intro "{style}" (가능: {", ".join(STYLES)})')
        out = R.out_name(src, style)
        dst = os.path.join(R.VID, out)
        newest = max(os.path.getmtime(p) for p in [os.path.join(R.VID, src)] + TOOLS)
        if force or not os.path.exists(dst) or os.path.getmtime(dst) < newest:
            R.make(src, style)
        else:
            print(f'{key}: {out} 그대로')
        v['file'] = out
    with open(LIST, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(videos, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
