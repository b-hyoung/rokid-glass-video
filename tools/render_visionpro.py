"""애플 비전 프로 체험 미리보기(임시) 영상을 굽는다. 안경 화면용 480x640 초록 단색, 검정 = 투명.

    python tools/render_visionpro.py   → server/videos/visionpro_layout.mp4 (16초, 반복 재생용)

비전 프로를 쓰면 보이는 장면(공중에 뜬 앱 창 → 눈으로 고르기 → 손가락 집기 → 몰입 모드)을
직접 그린 모션 그래픽이다. 애플 공식 영상·화면은 쓰지 않았다. 실제 체험 촬영본이 생기면 교체한다.
"""
import math
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'server', 'videos', 'visionpro_layout.mp4')
W, H, FPS = 480, 640, 24
IMG_Y, IMG_H = 56, 320
BEAT = 4.0
G, G2, G3 = (0x3d, 0xff, 0x5a), (0x1f, 0xae, 0x35), (0x0f, 0x6a, 0x20)
REG = 'C:/Windows/Fonts/malgun.ttf'
BOLD = 'C:/Windows/Fonts/malgunbd.ttf'
HEADER = '애플 비전 프로 · 공간 컴퓨팅'
CUES = ['공중에 앱 창 띄우기', '눈으로 바라보면 선택', '손가락을 모으면 실행', '몰입 모드로 전환']
INFO = [('기기', 'Apple Vision Pro'), ('조작', '눈 · 손 · 목소리'), ('화면', '양쪽 눈 고해상도 디스플레이'), ('안내', '임시 영상 · 실제 체험으로 교체 예정')]
_f = {}


def font(path, size):
    if (path, size) not in _f:
        _f[path, size] = ImageFont.truetype(path, size)
    return _f[path, size]


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def shade(c, k):
    return tuple(int(v * max(0.0, min(1.0, k))) for v in c)


def center(d, y, text, f, color, cx=W / 2):
    d.text((cx - d.textlength(text, font=f) / 2, y), text, font=f, fill=color)


def room(d, k):  # 방 바닥 격자(원근) — 현실이 비쳐 보이는 느낌
    hy, vx = 150, W / 2
    for i in range(-8, 9):
        d.line((vx + i * 18, hy, vx + i * 120, IMG_H), fill=shade(G3, 0.55 * k))
    for j in range(1, 7):
        y = hy + (IMG_H - hy) * (j / 6) ** 1.8
        d.line((0, y, W, y), fill=shade(G3, 0.55 * k))
    d.line((0, hy, W, hy), fill=shade(G3, 0.8 * k))


def window(d, cx, cy, w, h, title, k, hot=False, kind='lines'):
    if k <= 0:
        return
    s = 0.6 + 0.4 * ease(k)
    w, h = w * s, h * s
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    edge = G if hot else G2
    d.rounded_rectangle((x0, y0, x1, y1), radius=12 * s, fill=shade((6, 40, 14), k), outline=shade(edge, k), width=3 if hot else 2)
    d.text((x0 + 10 * s, y0 + 6 * s), title, font=font(BOLD, max(10, int(15 * s))), fill=shade(edge, k))
    if kind == 'lines':
        for i in range(3):
            d.rounded_rectangle((x0 + 10 * s, y0 + (32 + i * 16) * s, x1 - (10 + i * 22) * s, y0 + (40 + i * 16) * s), radius=3, fill=shade(G3, k))
    elif kind == 'photo':
        d.polygon([(x0 + 12 * s, y1 - 12 * s), (cx - 6 * s, y0 + 40 * s), (cx + 18 * s, y1 - 30 * s), (x1 - 12 * s, y1 - 12 * s)], fill=shade(G3, k))
        d.ellipse((x1 - 34 * s, y0 + 32 * s, x1 - 18 * s, y0 + 48 * s), fill=shade(G2, k))
    elif kind == 'video':
        tx, ty = cx, cy + 6 * s
        d.polygon([(tx - 10 * s, ty - 14 * s), (tx - 10 * s, ty + 14 * s), (tx + 16 * s, ty)], fill=shade(G, k))
    d.rounded_rectangle((cx - 18 * s, y1 + 6 * s, cx + 18 * s, y1 + 10 * s), radius=2, fill=shade(G2, k))  # 창 아래 손잡이


def pinch(d, x, y, t, k):  # 손가락 두 개가 모였다 벌어짐
    gap = 16 * (1 - abs(math.sin(t * math.pi * 1.5)))
    for dx in (-gap, gap):
        d.ellipse((x + dx - 7, y - 7, x + dx + 7, y + 7), outline=shade(G, k), width=2)
    if gap < 4:
        d.ellipse((x - 18, y - 18, x + 18, y + 18), outline=shade(G2, k), width=2)


def scene(t, stars):
    img = Image.new('RGB', (W, IMG_H), 'black')
    d = ImageDraw.Draw(img)
    beat, u = int(t // BEAT), (t % BEAT) / BEAT
    immersive = ease((u - 0.15) / 0.5) if beat == 3 else 0.0
    room(d, 1 - immersive)
    if immersive > 0:  # 몰입 모드: 별 + 산 능선
        for x, y, r in stars:
            d.ellipse((x - r, y - r, x + r, y + r), fill=shade(G2, immersive))
        pts = [(0, 260)] + [(x, 230 - 40 * math.sin(x / 70) - 25 * math.sin(x / 23)) for x in range(0, W + 1, 12)] + [(W, IMG_H), (0, IMG_H)]
        d.polygon(pts, fill=shade((5, 30, 10), immersive), outline=shade(G2, immersive))
    wins = [(110, 120, 120, 90, '사진', 'photo'), (W / 2, 110, 150, 110, '영상', 'video'), (372, 125, 116, 86, '메시지', 'lines')]
    appear = [ease((t - 0.3 - i * 0.5) / 0.6) for i in range(3)]
    gaze = None
    order = [1, 2, 0] if beat == 2 else [0, 1, 2]  # 커지는 사진 창은 맨 앞에
    for i in order:
        x, y, w, h, title, kind = wins[i]
        k = appear[i] * (1 - immersive)
        hot = beat >= 1 and i == 0 and beat < 3
        if beat == 2 and i == 0:  # 집기 → 사진 창이 앞으로 커짐
            g = ease((u - 0.35) / 0.4)
            x, y, w, h = x + (W / 2 - x) * g, y + (150 - y) * g, w + 170 * g, h + 110 * g
        if beat == 2 and i != 0:
            k *= 1 - 0.7 * ease((u - 0.35) / 0.4)
        if beat == 3:
            hot = False
        window(d, x, y, w, h, title, k, hot, kind)
    if beat == 1:  # 시선 점이 사진 창으로 이동
        g = ease(u / 0.5)
        gaze = (W / 2 + (110 - W / 2) * g, 260 + (130 - 260) * g)
    elif beat == 2:
        gaze = (W / 2, 150)
    if gaze:
        x, y = gaze
        d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=G)
        d.ellipse((x - 14, y - 14, x + 14, y + 14), outline=G2, width=1)
    if beat == 2:
        pinch(d, 400, 270, u, 1.0)
        d.text((360, 290), '집기', font=font(REG, 13), fill=G2)
    if beat == 3:  # 디지털 크라운 돌리기 표시
        a = u * 2 * math.pi
        d.arc((410, 250, 450, 290), math.degrees(a), math.degrees(a) + 260, fill=G, width=3)
        d.text((396, 294), '크라운', font=font(REG, 13), fill=G2)
    return img


def base(beat):
    img = Image.new('RGB', (W, H), 'black')
    d = ImageDraw.Draw(img)
    center(d, 16, HEADER, font(BOLD, 24), G)
    y = IMG_Y + IMG_H + 72
    d.rectangle((24, y, W - 24, y), fill=G3)
    y += 14
    for tag, body in INFO:
        d.text((24, y + 2), tag, font=font(REG, 14), fill=G2)
        d.text((92, y), body, font=font(REG, 17), fill=G)
        y += 30
    center(d, 606, ' '.join('●' if k == beat else '○' for k in range(len(CUES))), font(REG, 14), G)
    return img


def main():
    rnd = random.Random(7)
    stars = [(rnd.uniform(0, W), rnd.uniform(0, 200), rnd.choice((1, 1, 1.5, 2))) for _ in range(90)]
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT],
                         stdin=subprocess.PIPE)
    total = round(BEAT * len(CUES) * FPS)
    bases = [base(b) for b in range(len(CUES))]
    for n in range(total):
        t = n / FPS
        beat = int(t // BEAT)
        f = bases[beat].copy()
        f.paste(scene(t, stars), (0, IMG_Y))
        d = ImageDraw.Draw(f)
        u = (t % BEAT) / BEAT
        k = min(1.0, u / 0.1, (1 - u) / 0.08)
        d.text((24, IMG_Y + IMG_H + 10), '비전 프로 안에서 보이는 장면', font=font(REG, 14), fill=G2)
        d.text((24, IMG_Y + IMG_H + 28), CUES[beat], font=font(BOLD, 24), fill=shade(G, k))
        p.stdin.write(f.tobytes())
    p.stdin.close()
    if p.wait():
        raise SystemExit('굽기 실패')
    print(OUT)


if __name__ == '__main__':
    main()
