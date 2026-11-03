"""마주봄(비접촉 낙상 예방)을 위·아래 레이아웃 480x640 영상으로 굽는다.
위: 이미지 칸(480x300)에 캡처를 통째로 정지 화면으로, 아래: 지금 장면 + 작품 정보.

    python tools/render_majubom.py   → server/videos/majubom_layout.mp4

캡처 원본: tools/majubom_src/ (b-hyoung/Majubom docs/captures/2026-10-11)
"""
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'tools', 'majubom_src')
OUT = os.path.join(ROOT, 'server', 'videos', 'majubom_layout.mp4')
W, H, FPS = 480, 640, 24
IMG_Y, IMG_H = 60, 300   # 이미지 칸
SCENE = 5.0   # 장면 하나 길이(초)
FADE = 0.4    # 장면이 바뀔 때 이미지·문구가 사라졌다 나타나는 시간

G, G2, G3 = (0x3d, 0xff, 0x5a), (0x1f, 0xae, 0x35), (0x0f, 0x6a, 0x20)
REG = 'C:/Windows/Fonts/malgun.ttf'
BOLD = 'C:/Windows/Fonts/malgunbd.ttf'

# (파일, 보여 줄 영역(왼, 위, 오른, 아래), 지금 장면 문구). 'TITLE'은 표지를 직접 그린다.
SCENES = [
    ('TITLE', None, '몸에 아무것도 붙이지 않는다'),
    ('00_system_architecture.png', (68, 428, 720, 836), '침대 옆 센서 두 종류'),
    ('03a_raw_tof_grid.png', (24, 470, 712, 900), 'ToF가 몸의 위치를 읽고'),
    ('06_dashboard_mobile_web.png', (30, 1160, 794, 1490), '자세·침상 이탈을 바로 판정'),
    ('06_dashboard_mobile_web.png', (16, 190, 808, 680), '평소와 다르면 위험도 4단계로'),
    ('05b_dashboard_fall_alert_sim.png', (514, 352, 926, 550), '간호사 화면에 바로 알림'),
]
HEADER = '비접촉 낙상 예방 〈마주봄〉'
INFO = [  # 출처: PPT-List/majubom, Majubom README
    ('작품', '치매 환자를 위한 비접촉 낙상 예방'),
    ('측정', 'ToF · mmWave 센서, 카메라 없음'),
    ('판정', '평소 대비 z-score, 위험도 4단계'),
    ('대회', '2026 글로벌 피우다 프로젝트 본선'),
    ('만든 팀', '팀 마주봄'),
]


def font(path, size):
    return ImageFont.truetype(path, size)


def green(img):
    """흑백 → 밝은 바탕이면 뒤집어 검정 바탕(안경에서 투명)으로 → 대비 → 초록."""
    g = ImageOps.grayscale(img)
    if sum(g.histogram()[128:]) > g.width * g.height / 2:
        g = ImageOps.invert(g)
    g = ImageOps.autocontrast(g, cutoff=1)
    g = g.point(lambda v: int(255 * (v / 255) ** 0.8))
    z = Image.new('L', g.size, 0)
    return Image.merge('RGB', (z, g, z))


def title_card():
    img = Image.new('RGB', (W, IMG_H), 'black')
    d = ImageDraw.Draw(img)
    d.text((32, 40), 'MAJUBOM · 글로벌 피우다 프로젝트 2026', font=font(REG, 14), fill=G3)
    d.text((32, 66), '마주봄.', font=font(BOLD, 56), fill=G)
    d.text((32, 146), '치매 환자를 위한 비접촉', font=font(BOLD, 28), fill=G2)
    d.text((32, 184), '낙상 예방 모니터링', font=font(BOLD, 28), fill=G2)
    d.text((32, 238), '침대 옆 센서가 일어서려는 순간을 읽고,', font=font(REG, 16), fill=G2)
    d.text((32, 262), '넘어지기 전에 간호사를 부른다.', font=font(REG, 16), fill=G2)
    return img


def picture(name, box):
    """이미지 칸에 통째로 맞춰 넣는다(잘라 내지 않고, 남는 곳은 검정)."""
    if name == 'TITLE':
        return title_card()
    src = green(Image.open(os.path.join(SRC_DIR, name)).convert('RGB').crop(box))
    s = min(W / src.width, IMG_H / src.height)
    src = src.resize((round(src.width * s), round(src.height * s)), Image.LANCZOS)
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
    d.text((24, IMG_Y + IMG_H + 14), '지금 장면', font=font(REG, 14), fill=G2)
    y = IMG_Y + IMG_H + 78
    d.rectangle((24, y, W - 24, y), fill=G3)
    y += 14
    for tag, body in INFO:
        d.text((24, y + 2), tag, font=font(REG, 14), fill=G2)
        d.text((92, y), body, font=font(REG, 17), fill=G)
        y += 30
    dots = ' '.join('●' if k == i else '○' for k in range(len(SCENES)))
    center(d, 606, dots, font(REG, 14), G)
    return img


def layer(name, box, cue):
    """장면마다 바뀌어 페이드되는 부분(이미지·지금 장면 문구)."""
    img = Image.new('RGB', (W, H), 'black')
    img.paste(picture(name, box), (0, IMG_Y))
    ImageDraw.Draw(img).text((24, IMG_Y + IMG_H + 34), cue, font=font(BOLD, 24), fill=G)
    return img


def main():
    p = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', OUT,
    ], stdin=subprocess.PIPE)
    n = round(SCENE * FPS)
    for i, (name, box, cue) in enumerate(SCENES):
        b, top = base(i), layer(name, box, cue)
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
