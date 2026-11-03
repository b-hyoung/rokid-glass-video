"""마주봄 발표 자료(피우다 2026 PDF) 슬라이드로 위·아래 레이아웃 480x640 영상을 굽는다.
위: 이미지 칸(480x320)에 슬라이드의 핵심 부분을 통째로 정지 화면으로, 아래: 지금 장면 + 작품 정보.

    python tools/render_majubom.py   → server/videos/majubom_layout.mp4

원본: tools/majubom_src/MAJUBOM-피우다-2026.pdf (b-hyoung.github.io/PPT-List/piuda)
슬라이드가 어두운 바탕이라 그대로 흑백→초록으로 바꾸면 검정 바탕이 안경에서 투명해진다.
"""
import os
import subprocess

import pymupdf
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'tools', 'majubom_src', 'MAJUBOM-피우다-2026.pdf')
OUT = os.path.join(ROOT, 'server', 'videos', 'majubom_layout.mp4')
W, H, FPS = 480, 640, 24
IMG_Y, IMG_H = 56, 320   # 이미지 칸
SCENE = 4.0   # 장면 하나 길이(초)
FADE = 0.4    # 장면이 바뀔 때 이미지·문구가 사라졌다 나타나는 시간

G, G2, G3 = (0x3d, 0xff, 0x5a), (0x1f, 0xae, 0x35), (0x0f, 0x6a, 0x20)
REG = 'C:/Windows/Fonts/malgun.ttf'
BOLD = 'C:/Windows/Fonts/malgunbd.ttf'

# (쪽 번호, 보여 줄 영역(왼, 위, 오른, 아래 — 960x540 슬라이드 좌표), 지금 장면 문구)
SCENES = [
    (1, (240, 170, 720, 470), '치매환자 낙상 감지·예측'),
    (2, (60, 125, 900, 420), '치매 환자 낙상, 얼마나 심각한가'),
    (5, (55, 125, 905, 420), '감지가 아니라 예측으로'),
    (6, (55, 120, 905, 445), '넘어지기 전에 예측한다'),
    (9, (55, 95, 905, 445), '센서 2개, 임무 3가지'),
    (11, (60, 125, 900, 370), '위험도에 따라 4단계 알림'),
    (12, (60, 70, 800, 485), '아침 기상·이탈 시연'),
    (13, (60, 130, 900, 400), '현장에서 달라지는 것'),
    (14, (190, 130, 850, 420), '감사합니다'),
]
HEADER = '치매환자 낙상 예측 〈마주봄〉'
INFO = [  # 출처: 피우다 2026 발표 자료
    ('작품', '비접촉 다중센서 낙상 감지·예측'),
    ('측정', 'ToF · mmWave, 몸에 붙이지 않음'),
    ('대회', '2026 글로벌 피우다 프로젝트'),
    ('만든 팀', 'Team MajuBom'),
]


def font(path, size):
    return ImageFont.truetype(path, size)


def green(img):
    """흑백 → (밝은 바탕이면 뒤집기) → 가장 흔한 밝기(=바탕)를 검정으로 → 대비 → 초록.
    슬라이드 바탕은 순검정이 아니라 짙은 회색이라, 그대로 두면 안경에 초록 판이 비친다."""
    g = ImageOps.grayscale(img)
    if sum(g.histogram()[128:]) > g.width * g.height / 2:
        g = ImageOps.invert(g)
    hist = g.histogram()
    lo = hist.index(max(hist)) + 14
    total, acc, hi = sum(hist), 0, 255
    for v in range(255, -1, -1):
        acc += hist[v]
        if acc > total * 0.003:
            hi = v
            break
    hi = max(hi, lo + 40)
    g = g.point(lambda v: 0 if v <= lo else min(255, int(255 * ((v - lo) / (hi - lo)) ** 0.8)))
    z = Image.new('L', g.size, 0)
    return Image.merge('RGB', (z, g, z))


def picture(doc, page, box):
    """슬라이드 영역을 이미지 칸에 통째로 맞춰 넣는다(남는 곳은 검정)."""
    clip = pymupdf.Rect(*box)
    s = min(W / clip.width, IMG_H / clip.height)
    pix = doc[page - 1].get_pixmap(matrix=pymupdf.Matrix(s * 3, s * 3), clip=clip)  # 3배로 그려 줄이면 글씨가 덜 뭉갠다
    src = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    src = green(src.resize((round(clip.width * s), round(clip.height * s)), Image.LANCZOS))
    img = Image.new('RGB', (W, IMG_H), 'black')
    img.paste(src, ((W - src.width) // 2, (IMG_H - src.height) // 2))
    return img


def center(d, y, text, f, color):
    d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=color)


def base(i):
    """장면이 바뀌어도 그대로인 부분(제목·정보·진행 점)."""
    img = Image.new('RGB', (W, H), 'black')
    d = ImageDraw.Draw(img)
    center(d, 16, HEADER, font(BOLD, 24), G)
    d.text((24, IMG_Y + IMG_H + 10), '지금 장면', font=font(REG, 14), fill=G2)
    y = IMG_Y + IMG_H + 72
    d.rectangle((24, y, W - 24, y), fill=G3)
    y += 14
    for tag, body in INFO:
        d.text((24, y + 2), tag, font=font(REG, 14), fill=G2)
        d.text((92, y), body, font=font(REG, 17), fill=G)
        y += 30
    dots = ' '.join('●' if k == i else '○' for k in range(len(SCENES)))
    center(d, 606, dots, font(REG, 14), G)
    return img


def layer(doc, page, box, cue):
    """장면마다 바뀌어 페이드되는 부분(이미지·지금 장면 문구)."""
    img = Image.new('RGB', (W, H), 'black')
    img.paste(picture(doc, page, box), (0, IMG_Y))
    ImageDraw.Draw(img).text((24, IMG_Y + IMG_H + 28), cue, font=font(BOLD, 24), fill=G)
    return img


def main():
    p = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', OUT,
    ], stdin=subprocess.PIPE)
    doc = pymupdf.open(PDF)
    n = round(SCENE * FPS)
    for i, (page, box, cue) in enumerate(SCENES):
        b, top = base(i), layer(doc, page, box, cue)
        cache = {}
        for j in range(n):
            k = round(min(1.0, j / (FADE * FPS), (n - 1 - j) / (FADE * FPS)), 2)
            if k not in cache:
                faded = top if k >= 1 else Image.eval(top, lambda v, k=k: int(v * k))
                cache[k] = Image.composite(faded, b, top.convert('L').point(lambda v: 255 if v else 0)).tobytes()
            p.stdin.write(cache[k])
    p.stdin.close()
    if p.wait():
        raise SystemExit('굽기 실패')
    print(OUT)


if __name__ == '__main__':
    main()
