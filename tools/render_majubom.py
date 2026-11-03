"""마주봄 추억 영상: 발표 슬라이드 사이사이에 팀 사진을 넣어 위·아래 레이아웃 480x640 영상으로 굽는다.
위: 이미지 칸(480x320), 아래: 지금 장면(슬라이드) / 우리의 기록(사진) + 작품 정보.

    python tools/render_majubom.py   → server/videos/majubom_layout.mp4

원본: tools/majubom_src/MAJUBOM-피우다-2026.pdf (b-hyoung.github.io/PPT-List/piuda)
사진: tools/majubom_src/photos/ — 지금은 AI 생성 임시 사진(gen_majubom_photos.py).
      실제 사진은 같은 이름(.jpg/.png)으로 덮어쓰고 다시 구우면 된다.
슬라이드가 어두운 바탕이라 그대로 흑백→초록으로 바꾸면 검정 바탕이 안경에서 투명해진다.
"""
import os
import subprocess

import pymupdf
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'tools', 'majubom_src', 'MAJUBOM-피우다-2026.pdf')
PHOTO_DIR = os.path.join(ROOT, 'tools', 'majubom_src', 'photos')
OUT = os.path.join(ROOT, 'server', 'videos', 'majubom_layout.mp4')
W, H, FPS = 480, 640, 24
IMG_Y, IMG_H = 56, 320   # 이미지 칸
SCENE = 4.0   # 장면 하나 길이(초)
FADE = 0.4    # 장면이 바뀔 때 이미지·문구가 사라졌다 나타나는 시간

G, G2, G3 = (0x3d, 0xff, 0x5a), (0x1f, 0xae, 0x35), (0x0f, 0x6a, 0x20)
REG = 'C:/Windows/Fonts/malgun.ttf'
BOLD = 'C:/Windows/Fonts/malgunbd.ttf'

# ('slide', 쪽 번호, 보여 줄 영역(960x540 슬라이드 좌표), 문구) / ('photo', 사진 이름, 문구)
SCENES = [
    ('slide', 1, (240, 170, 720, 470), '치매환자 낙상 감지·예측'),
    ('photo', '01_first_meeting', '처음 모인 날, 아이디어를 모으고'),
    ('slide', 2, (60, 125, 900, 420), '치매 환자 낙상, 얼마나 심각한가'),
    ('photo', '02_building_sensors', '밤늦게 센서를 붙이고'),
    ('slide', 9, (55, 95, 905, 445), '센서 2개, 임무 3가지'),
    ('photo', '03_bed_experiment', '침대 옆에서 직접 실험하고'),
    ('photo', '04_first_data', '데이터가 처음 뜬 순간'),
    ('slide', 11, (60, 125, 900, 370), '위험도에 따라 4단계 알림'),
    ('slide', 12, (60, 70, 800, 485), '아침 기상·이탈 시연'),
    ('photo', '05_rehearsal', '발표 전날 밤의 리허설'),
    ('photo', '06_award', '그리고, 무대 위에서'),
    ('slide', 14, (190, 130, 850, 420), '감사합니다'),
]
ZOOM = 1.08   # 사진은 장면 동안 천천히 이만큼 확대
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


def photo(name):
    """사진을 칸 비율(3:2)로 맞춰 자르고 초록으로. 확대할 여유를 위해 ZOOM배 크기로 돌려준다."""
    path = next(os.path.join(PHOTO_DIR, name + e) for e in ('.jpg', '.png', '.jpeg')
                if os.path.exists(os.path.join(PHOTO_DIR, name + e)))
    src = ImageOps.fit(Image.open(path).convert('RGB'), (round(W * ZOOM), round(IMG_H * ZOOM)), Image.LANCZOS)
    g = ImageOps.autocontrast(ImageOps.grayscale(src), cutoff=1).point(lambda v: int(190 * (v / 255) ** 1.15))  # 최대 75% 밝기: 안경에서 눈부시지 않게
    z = Image.new('L', g.size, 0)
    return Image.merge('RGB', (z, g, z))


def feather():
    """가장자리로 갈수록 어두워지는 틀(사진이 안경 속에서 부드럽게 사라지도록)."""
    m = Image.new('L', (W, IMG_H), 0)
    d = ImageDraw.Draw(m)
    steps = 36
    for k in range(steps):
        d.rectangle((k, k, W - 1 - k, IMG_H - 1 - k), fill=int(255 * ((k + 1) / steps) ** 1.5))
    return m


def center(d, y, text, f, color):
    d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=color)


def base(i):
    """장면이 바뀌어도 그대로인 부분(제목·정보·진행 점)."""
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
    dots = ' '.join('●' if k == i else '○' for k in range(len(SCENES)))
    center(d, 606, dots, font(REG, 14), G)
    return img


def band(pic, label, cue):
    """장면마다 바뀌어 페이드되는 띠(이미지 + 라벨 + 문구), 화면 y=IMG_Y부터."""
    img = Image.new('RGB', (W, IMG_H + 66), 'black')
    img.paste(pic, (0, 0))
    d = ImageDraw.Draw(img)
    d.text((24, IMG_H + 10), label, font=font(REG, 14), fill=G2)
    d.text((24, IMG_H + 28), cue, font=font(BOLD, 24), fill=G)
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
    mask = feather()
    for i, sc in enumerate(SCENES):
        b = base(i)
        if sc[0] == 'slide':
            still = band(picture(doc, sc[1], sc[2]), '지금 장면', sc[3])
            big = None
        else:
            big = photo(sc[1])
        for j in range(n):
            if big is None:
                top = still
            else:  # 천천히 확대
                z = ZOOM - (ZOOM - 1) * (1 - j / (n - 1))
                w, h = big.width / z, big.height / z
                x, y = (big.width - w) / 2, (big.height - h) / 2
                pic = big.resize((W, IMG_H), Image.BILINEAR, box=(x, y, x + w, y + h))
                pic = Image.composite(pic, Image.new('RGB', (W, IMG_H)), mask)
                top = band(pic, '우리의 기록', sc[2])
            k = min(1.0, j / (FADE * FPS), (n - 1 - j) / (FADE * FPS))
            if k < 1:
                top = Image.eval(top, lambda v, k=k: int(v * k))
            f = b.copy()
            f.paste(top, (0, IMG_Y))
            p.stdin.write(f.tobytes())
    p.stdin.close()
    if p.wait():
        raise SystemExit('굽기 실패')
    print(OUT)


if __name__ == '__main__':
    main()
