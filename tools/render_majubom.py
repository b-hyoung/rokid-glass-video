"""마주봄(비접촉 낙상 예방)을 견훤 d와 같은 레이아웃으로 굽는다.
왼쪽 영상은 PPT 첫 장과 저장소(b-hyoung/Majubom) 화면 캡처를 천천히 훑는 슬라이드다.

    python tools/render_majubom.py   → preview/majubom_left.mp4, server/videos/majubom_layout.mp4

캡처 원본: tools/majubom_src/ (PPT-List/majubom/thumbnail.png, Majubom/docs/captures/2026-10-11)
"""
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont, ImageOps

from render_layout import ROOT, render

SRC_DIR = os.path.join(ROOT, 'tools', 'majubom_src')
LEFT = os.path.join(ROOT, 'preview', 'majubom_left.mp4')
OUT = os.path.join(ROOT, 'server', 'videos', 'majubom_layout.mp4')
W, H, FPS = 240, 370, 24
SCENE = 5.0   # 장면 하나 길이(초)
FADE = 0.4    # 장면 사이 검정으로 사라졌다 나타나는 시간

# (파일, 잘라 볼 영역(왼, 위, 오른, 아래), 훑는 방향, 지금 장면 문구)
# 영역의 세로를 370에 맞추고 남는 가로를 왼→오(또는 위→아래)로 천천히 훑는다.
# 'TITLE'은 캡처 대신 PPT 첫 장 문구를 안경 화면 크기에 맞춰 직접 그린다.
SCENES = [
    ('TITLE', None, None, '몸에 아무것도\n붙이지 않는다'),
    ('00_system_architecture.png', (68, 428, 720, 900), 'x', '침대 옆\n센서 두 종류'),
    ('03a_raw_tof_grid.png', (30, 470, 712, 905), 'x', 'ToF가\n몸의 위치를'),
    ('06_dashboard_mobile_web.png', (30, 1160, 794, 1830), 'x', '자세·침상 이탈을\n바로 판정'),
    ('06_dashboard_mobile_web.png', (16, 190, 516, 960), 'y', '평소와 다르면\n위험도 4단계로'),
    ('05b_dashboard_fall_alert_sim.png', (514, 352, 926, 550), 'x', '간호사 화면에\n바로 알림'),
]
FONT = 'C:/Windows/Fonts/malgun.ttf'
FONT_B = 'C:/Windows/Fonts/malgunbd.ttf'
HEADER = '비접촉 낙상 예방 〈마주봄〉'
INFO = [  # 출처: PPT-List/majubom, Majubom README
    ('작품', '치매 환자를 위한\n비접촉 낙상 예방'),
    ('측정', 'ToF · mmWave 센서\n카메라·웨어러블 없음'),
    ('판정', '평소 대비 z-score\n위험도 4단계'),
    ('대회', '2026 글로벌 피우다\n프로젝트 본선'),
    ('만든 팀', '팀 마주봄'),
]


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
    img = Image.new('RGB', (W, H), 'black')
    d = ImageDraw.Draw(img)
    hi, mid, lo = (0, 255, 90), (0, 190, 60), (0, 120, 40)
    y = 60
    for text, size, font, color, gap in [
        ('MAJUBOM · 2026', 13, FONT, lo, 14),
        ('마주봄.', 46, FONT_B, hi, 18),
        ('치매 환자를 위한', 24, FONT_B, mid, 6),
        ('비접촉', 24, FONT_B, mid, 6),
        ('낙상 예방 모니터링', 24, FONT_B, mid, 22),
        ('침대 옆 센서가', 15, FONT, mid, 4),
        ('일어서려는 순간을 읽고', 15, FONT, mid, 4),
        ('넘어지기 전에', 15, FONT, mid, 4),
        ('간호사를 부른다', 15, FONT, mid, 0),
    ]:
        f = ImageFont.truetype(font, size)
        d.text((18, y), text, font=f, fill=color)
        y += f.getbbox(text)[3] + gap
    return img


def frames(name, box, axis):
    if name == 'TITLE':
        src, axis = title_card(), 'x'
    else:
        src = green(Image.open(os.path.join(SRC_DIR, name)).convert('RGB').crop(box))
    if axis == 'x':  # 세로를 화면에 맞추고 가로로 훑기
        img = src.resize((max(W, round(src.width * H / src.height)), H), Image.LANCZOS)
    else:            # 가로를 화면에 맞추고 세로로 훑기
        img = src.resize((W, max(H, round(src.height * W / src.width))), Image.LANCZOS)
    span = (img.width - W) if axis == 'x' else (img.height - H)
    n = round(SCENE * FPS)
    for i in range(n):
        t = i / (n - 1)
        t = t * t * (3 - 2 * t)  # 처음과 끝은 천천히
        o = round(span * t)
        f = img.crop((o, 0, o + W, H) if axis == 'x' else (0, o, W, o + H))
        k = min(1.0, i / (FADE * FPS), (n - 1 - i) / (FADE * FPS))
        if k < 1:
            f = Image.eval(f, lambda v, k=k: int(v * k))
        yield f.tobytes()


def make_left():
    p = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', LEFT,
    ], stdin=subprocess.PIPE)
    for name, box, axis, _ in SCENES:
        for b in frames(name, box, axis):
            p.stdin.write(b)
    p.stdin.close()
    if p.wait():
        raise SystemExit('왼쪽 영상 굽기 실패')
    print(LEFT)


def main():
    make_left()
    cues = [(i * SCENE, s[3]) for i, s in enumerate(SCENES)]
    render(LEFT, OUT, len(SCENES) * SCENE, HEADER, cues, INFO)


if __name__ == '__main__':
    main()
