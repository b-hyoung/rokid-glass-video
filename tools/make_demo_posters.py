"""2412호 데모의 TV 화면 그림을 만든다. 초록 안경 영상에서 한 장면을 뽑아 색을 입힌다.

    python tools/make_demo_posters.py   → demo/2412/posters/<키>.jpg
"""
import os
import subprocess

import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', '2412', 'posters')
VID = os.path.join(ROOT, 'server', 'videos')
W, H = 1024, 576
BOLD = 'C:/Windows/Fonts/malgunbd.ttf'
REG = 'C:/Windows/Fonts/malgun.ttf'

# 키: (제목, 부제, 원본, 몇 초 장면, 어두운 색, 밝은 색)
POSTERS = {
    'd': ('견훤', '후백제를 세운 왕', os.path.join(ROOT, 'preview', 'gyeon.mp4'), 3, (20, 14, 8), (236, 214, 170)),
    'e': ('마주봄', '치매환자 낙상 예측', 'pdf', 0, None, None),
    'a': ('킨텍스 고래', '2026 산학연협력 EXPO', os.path.join(VID, 'whale.mp4'), 3, (4, 14, 40), (150, 220, 255)),
    'b': ('해저놀이터', 'XR 바닷속 체험', os.path.join(VID, 'sea.mp4'), 6, (2, 24, 40), (120, 255, 230)),
    'c': ('언리얼 페스트', '2024 현장 기록', os.path.join(VID, 'fest.mp4'), 3, (24, 6, 36), (255, 170, 240)),
    'x': ('준비 중', '아직 등록되지 않은 작품', None, 0, None, None),
}


def frame(path, sec):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(sec), '-i', path, '-frames:v', '1',
                          '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True, check=True).stdout
    import io
    return Image.open(io.BytesIO(raw)).convert('RGB')


def tint(img, dark, light):
    g = np.asarray(img, dtype=np.float32)[..., 1:2] / 255.0
    rgb = np.array(dark) * (1 - g) + np.array(light) * g
    return Image.fromarray(rgb.clip(0, 255).astype(np.uint8))


def cover(img, w, h):
    s = max(w / img.width, h / img.height)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    x, y = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def poster(key, title, sub, src, sec, dark, light):
    if src == 'pdf':
        doc = pymupdf.open(os.path.join(ROOT, 'tools', 'majubom_src', 'MAJUBOM-피우다-2026.pdf'))
        pix = doc[0].get_pixmap(dpi=110)
        return cover(Image.frombytes('RGB', (pix.width, pix.height), pix.samples), W, H)
    if src is None:
        img = Image.new('RGB', (W, H), (34, 36, 40))
        d = ImageDraw.Draw(img)
        d.text((W // 2, H // 2 - 20), title, font=ImageFont.truetype(BOLD, 72), fill=(150, 154, 160), anchor='mm')
        d.text((W // 2, H // 2 + 50), sub, font=ImageFont.truetype(REG, 30), fill=(110, 114, 120), anchor='mm')
        return img
    img = cover(tint(frame(src, sec), dark, light), W, H)
    d = ImageDraw.Draw(img, 'RGBA')
    d.rectangle((0, H - 160, W, H), fill=(*dark, 215))
    d.text((48, H - 92), title, font=ImageFont.truetype(BOLD, 60), fill=light, anchor='ls')
    d.text((50, H - 40), sub, font=ImageFont.truetype(REG, 26), fill=(*light, 200), anchor='ls')
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for key, args in POSTERS.items():
        path = os.path.join(OUT, key + '.jpg')
        poster(key, *args).save(path, quality=86)
        print(path)


if __name__ == '__main__':
    main()
