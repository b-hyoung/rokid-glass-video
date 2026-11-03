"""비전 인식 직후 재생할 '상자 열림' 전환 애니메이션을 영상 앞에 붙인다.

    python tools/render_intro.py majubom_layout.mp4            → server/videos/majubom_box.mp4 (원본은 그대로)
    python tools/render_intro.py --style scan majubom_layout.mp4   → majubom_scan.mp4
애니메이션 이름: box · scan · envelope · iris · tiles (intro_styles.py)
평소에는 videos.json에 "intro"를 적고 build_intros.py로 굽는다.

흐름(약 2.4초): 인식 조준 모서리가 가운데로 모임 → 상자가 통통 튀며 등장·흔들림
→ 뚜껑이 열리며 빛줄기와 입자가 슝슝 → 상자에서 화면 틀이 날아올라 커지며 영상 첫 장면으로 이어짐.
효과음(슝·뿅)은 numpy로 합성. 안경 화면이라 초록 단색, 검정은 투명.
"""
import math
import os
import random
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VID = os.path.join(ROOT, 'server', 'videos')
W, H, FPS = 480, 640, 24
S = 2                      # 2배로 그려 줄여서 선을 부드럽게
DUR = 2.4
SR = 44100
SKIP = 0.45   # 원본 첫 장면의 페이드인(검정→밝음)을 건너뛰고 이어 붙인다

G = (0x3d, 0xff, 0x5a)
G2 = (0x1f, 0xae, 0x35)
G3 = (0x0f, 0x6a, 0x20)

# 장면 시각(초)
T_LOCK = 0.45     # 조준 모서리가 다 모이는 때
T_BOX = 0.75      # 상자 착지
T_OPEN = 1.15     # 뚜껑 열리기 시작
T_FLY = 1.55      # 화면 틀이 날아오르기 시작
CX, CY = W / 2, 400   # 상자 앞면 아래 가운데
BW, BH, BD = 150, 110, 46   # 상자 너비·높이·깊이(비스듬히 보이는 윗면 크기)


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return t * t * (3 - 2 * t)


def clamp(t):
    return max(0.0, min(1.0, t))


def mix(c, k):
    return tuple(int(v * k) for v in c)


def p(*xy):
    return [v * S for v in xy]


def corners(d, t):
    """화면 네 귀퉁이에서 가운데로 모이는 인식 조준 모서리."""
    k = ease_out(clamp(t / T_LOCK))
    fade = 1 - clamp((t - T_BOX) / 0.3)
    if fade <= 0:
        return
    tx, ty, tw, th = CX, CY - BH / 2 - 10, BW + 70, BH + 90
    x0 = 20 + (tx - tw / 2 - 20) * k
    x1 = W - 20 - (W - 20 - (tx + tw / 2)) * k
    y0 = 70 + (ty - th / 2 - 70) * k
    y1 = H - 40 - (H - 40 - (ty + th / 2)) * k
    L = 26
    c = mix(G, fade)
    for (x, y, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line(p(x, y, x + L * sx, y), fill=c, width=4 * S)
        d.line(p(x, y, x, y + L * sy), fill=c, width=4 * S)
    if T_LOCK - 0.05 < t < T_LOCK + 0.25:  # 잠김 순간 번쩍이는 원
        r = 20 + 160 * clamp((t - T_LOCK + 0.05) / 0.3)
        a = 1 - clamp((t - T_LOCK + 0.05) / 0.3)
        d.ellipse(p(tx - r, ty - r, tx + r, ty + r), outline=mix(G2, a), width=2 * S)


def speed_lines(d, t, rnd):
    """가장자리에서 가운데로 빨려 드는 속도선(슝)."""
    if t > T_BOX + 0.1:
        return
    for i in range(18):
        ang = rnd[i][0] * 2 * math.pi
        spd = 0.6 + rnd[i][1]
        ph = (t * spd * 2.2 + rnd[i][2]) % 1
        r0, r1 = 420 * (1 - ph), 420 * (1 - ph) + 60 + 80 * rnd[i][1]
        a = math.sin(ph * math.pi) * (1 - clamp((t - T_BOX + 0.2) / 0.3))
        d.line(p(CX + math.cos(ang) * r0, CY - 60 + math.sin(ang) * r0,
                 CX + math.cos(ang) * r1, CY - 60 + math.sin(ang) * r1), fill=mix(G2, a), width=2 * S)


def box(d, t):
    """상자: 위에서 떨어져 통통 튀고, 흔들린 뒤 뚜껑이 열린다."""
    if t < T_LOCK - 0.1:
        return None
    u = clamp((t - (T_LOCK - 0.1)) / (T_BOX - T_LOCK + 0.1))
    drop = (1 - ease_out(u)) * -260
    bounce = -abs(math.sin((t - T_BOX) * 14)) * 22 * math.exp(-(t - T_BOX) * 7) if t > T_BOX else 0
    shake = math.sin(t * 70) * 3 * clamp((t - T_BOX - 0.1) / 0.1) * (1 - clamp((t - T_OPEN) / 0.05))
    sq = 1 + (0.12 * math.exp(-(t - T_BOX) * 12) if t > T_BOX else 0)  # 착지할 때 살짝 납작
    fade_out = 1 - clamp((t - T_FLY - 0.35) / 0.35)
    if fade_out <= 0:
        return None
    bw, bh = BW * sq, BH / sq
    x0, x1 = CX - bw / 2 + shake, CX + bw / 2 + shake
    yb = CY + drop + bounce
    yt = yb - bh
    ox, oy = BD * 0.55, -BD * 0.6     # 윗면이 비스듬히 뒤로 보이는 방향
    c, c2 = mix(G, fade_out), mix(G2, fade_out)
    # 앞면(검정으로 채워 뒤의 빛을 가림) + 옆면
    d.polygon(p(x1, yt, x1 + ox, yt + oy, x1 + ox, yb + oy, x1, yb), fill=(0, 0, 0), outline=c2)
    d.rectangle(p(x0, yt, x1, yb), fill=(0, 0, 0), outline=c, width=3 * S)
    d.line(p(CX + shake, yt, CX + shake, yb), fill=c2, width=2 * S)            # 리본
    d.line(p(x0, (yt + yb) / 2, x1, (yt + yb) / 2), fill=c2, width=2 * S)
    # 뚜껑: 뒤쪽 모서리를 축으로 열림
    open_k = ease_out(clamp((t - T_OPEN) / 0.25))
    hx0, hx1, hy = x0 + ox, x1 + ox, yt + oy      # 경첩(뒤 모서리)
    ang = open_k * math.radians(115)
    vx, vy = -ox, -oy                              # 닫힌 상태: 경첩 → 앞 모서리
    rx = vx * math.cos(ang)
    ry = vy * math.cos(ang) - math.hypot(ox, oy) * math.sin(ang)
    d.polygon(p(hx0, hy, hx1, hy, hx1 + rx, hy + ry, hx0 + rx, hy + ry),
              fill=(0, 0, 0), outline=c)
    mouth = ((x0 + x1) / 2 + ox / 2, yt + oy / 2)
    return mouth, open_k, fade_out


def rays(d, t, mouth):
    """열린 상자에서 위로 퍼지는 빛줄기."""
    k = clamp((t - T_OPEN) / 0.2) * (1 - clamp((t - T_FLY - 0.3) / 0.4))
    if k <= 0:
        return
    mx, my = mouth
    for i in range(9):
        a = math.radians(-90 + (i - 4) * 13 + math.sin(t * 6 + i) * 2)
        L = 160 + 120 * k + (i % 2) * 40
        w = 10 + 8 * (i % 3)
        ex, ey = mx + math.cos(a) * L, my + math.sin(a) * L
        nx, ny = -math.sin(a) * w / 2, math.cos(a) * w / 2
        d.polygon(p(mx, my, ex + nx, ey + ny, ex - nx, ey - ny), fill=mix(G3, k))


def particles(d, t, mouth, parts):
    """뚜껑이 열리면 슝슝 튀어나오는 별·점, 꼬리를 남김."""
    if t < T_OPEN:
        return
    mx, my = mouth
    for (delay, ang, spd, size, star) in parts:
        u = t - T_OPEN - delay
        if u <= 0:
            continue
        vx, vy = math.cos(ang) * spd, math.sin(ang) * spd
        x, y = mx + vx * u, my + vy * u + 260 * u * u
        tx, ty = mx + vx * (u - 0.06), my + vy * (u - 0.06) + 260 * (u - 0.06) ** 2
        a = 1 - clamp(u / 1.0)
        if a <= 0 or y > H:
            continue
        d.line(p(tx, ty, x, y), fill=mix(G2, a), width=2 * S)
        if star:
            r = size * (1 + 0.3 * math.sin(u * 30))
            d.polygon(p(x, y - r, x + r * .3, y - r * .3, x + r, y, x + r * .3, y + r * .3,
                        x, y + r, x - r * .3, y + r * .3, x - r, y, x - r * .3, y - r * .3), fill=mix(G, a))
        else:
            d.ellipse(p(x - size / 2, y - size / 2, x + size / 2, y + size / 2), fill=mix(G, a))


def fly(img, t, mouth, first):
    """상자 입구에서 화면 틀이 날아올라 커지며 영상 첫 장면이 된다."""
    u = clamp((t - T_FLY) / (DUR - T_FLY))
    if u <= 0:
        return img
    e = ease_in_out(u)
    mx, my = mouth
    sw, sh = 60 + (W - 60) * e, 80 + (H - 80) * e
    cx = mx + (W / 2 - mx) * e
    cy = (my - 60 * math.sin(u * math.pi)) + (H / 2 - my) * e   # 위로 솟았다가 자리 잡기
    rot = (1 - e) * -12
    frame = first.resize((max(2, round(sw)), max(2, round(sh))), Image.LANCZOS)
    frame = Image.eval(frame, lambda v: int(v * (0.35 + 0.65 * e)))
    edge = ImageDraw.Draw(frame)
    edge.rectangle((0, 0, frame.width - 1, frame.height - 1), outline=mix(G, 1 - e), width=3)
    if abs(rot) > 0.3:
        frame = frame.rotate(rot, resample=Image.BICUBIC, expand=True)
    out = img.copy()
    out.paste(frame, (round(cx - frame.width / 2), round(cy - frame.height / 2)),
              frame.convert('L').point(lambda v: 255 if v else 0) if abs(rot) > 0.3 else None)
    return out


def render_frames(first):
    random.seed(7)
    rnd = [(random.random(), random.random(), random.random()) for _ in range(18)]
    parts = [(random.random() * 0.25, math.radians(-90 + random.uniform(-70, 70)),
              random.uniform(260, 520), random.uniform(4, 9), random.random() < 0.5) for _ in range(34)]
    n = round(DUR * FPS)
    for i in range(n):
        t = i / FPS
        big = Image.new('RGB', (W * S, H * S), 'black')
        d = ImageDraw.Draw(big)
        speed_lines(d, t, rnd)
        corners(d, t)
        b = box(d, t)  # 빛을 상자보다 뒤에 그리려고 한 번 그린 뒤 위치만 얻는다
        mouth = b[0] if b else (CX, CY - BH - 27)
        if b and b[1] > 0:
            big = Image.new('RGB', (W * S, H * S), 'black')
            d = ImageDraw.Draw(big)
            rays(d, t, mouth)
            box(d, t)
            particles(d, t, mouth, parts)
        img = big.resize((W, H), Image.LANCZOS)
        if i == n - 1:
            yield first
        else:
            yield fly(img, t, mouth, first)


class Sfx:
    """효과음 조각을 더해 가는 작은 합성기. 각 애니메이션이 events(fx)로 소리를 놓는다."""

    def __init__(self, dur):
        self.n = int(dur * SR)
        self.t = np.arange(self.n) / SR
        self.out = np.zeros(self.n)
        self.rng = np.random.default_rng(3)

    def whoosh(self, t0, dur, f0, f1, amp):
        t = self.t
        m = (t >= t0) & (t < t0 + dur)
        u = (t[m] - t0) / dur
        noise = self.rng.standard_normal(m.sum())
        f = f0 + (f1 - f0) * u
        ph = 2 * np.pi * np.cumsum(f) / SR
        self.out[m] += amp * np.sin(np.pi * u) ** 2 * noise * (0.5 + 0.5 * np.sin(ph))

    def tone(self, t0, dur, f0, f1, amp, decay):
        t = self.t
        m = (t >= t0) & (t < t0 + dur)
        u = t[m] - t0
        f = f0 + (f1 - f0) * (u / dur)
        self.out[m] += amp * np.exp(-u * decay) * np.sin(2 * np.pi * np.cumsum(f) / SR)

    def save(self, path):
        out = np.convolve(self.out, np.ones(6) / 6, mode='same')  # 노이즈를 살짝 부드럽게
        out = np.clip(out / max(1e-6, np.abs(out).max()) * 0.8, -1, 1)
        with wave.open(path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((out * 32767).astype('<i2').tobytes())


def box_sfx(fx):
    """슝(속도선) → 띵(잠김) → 툭(착지) → 뿅·반짝(열림) → 휘익(날아오름)."""
    fx.whoosh(0.0, T_LOCK + 0.1, 300, 2500, 0.25)
    fx.tone(T_LOCK, 0.12, 1800, 2400, 0.25, 30)
    fx.tone(T_BOX, 0.18, 140, 60, 0.6, 25)
    fx.tone(T_OPEN, 0.25, 400, 1400, 0.45, 12)
    for k in range(6):
        fx.tone(T_OPEN + 0.08 + k * 0.06, 0.15, 2600 + k * 300, 2600 + k * 300, 0.12, 25)
    fx.whoosh(T_FLY - 0.05, DUR - T_FLY + 0.05, 600, 3500, 0.3)


def first_frame(src):
    tmp = tempfile.mkdtemp()
    png = os.path.join(tmp, 'first.png')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(SKIP), '-i', src, '-frames:v', '1', png], check=True)
    return Image.open(png).convert('RGB').resize((W, H))


def bake_intro(style, first, path):
    """애니메이션(소리 포함)만 path에 굽는다."""
    from intro_styles import STYLES
    st = STYLES[style]
    wav = path + '.wav'
    fx = Sfx(st['dur'])
    st['sfx'](fx)
    fx.save(wav)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                          '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', wav,
                          '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '18', '-pix_fmt', 'yuv420p',
                          '-c:a', 'aac', '-b:a', '96k', '-shortest', path], stdin=subprocess.PIPE)
    for f in st['frames'](first):
        p.stdin.write(f.tobytes())
    p.stdin.close()
    if p.wait():
        raise SystemExit('애니메이션 굽기 실패')
    os.remove(wav)


def join(intro, src, out, limit=None):
    """애니메이션 + 원본(첫 SKIP초 건너뜀, limit초까지)을 이어 붙인다. 원본이 무음이면 빈 소리를 깐다."""
    has_audio = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries',
                                'stream=index', '-of', 'csv=p=0', src], capture_output=True, text=True).stdout.strip()
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src],
                               capture_output=True, text=True).stdout.strip()) - SKIP
    if limit:
        dur = min(dur, limit)
    pre = '' if has_audio else f'anullsrc=r=44100:cl=mono,atrim=0:{dur}[s];'
    a1 = '[1:a]' if has_audio else '[s]'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', intro, '-ss', str(SKIP), '-t', str(dur), '-i', src,
                    '-filter_complex',
                    f'{pre}[0:v]fps={FPS},format=yuv420p[v0];[1:v]fps={FPS},scale={W}:{H},format=yuv420p[v1];'
                    f'[0:a]aformat=sample_rates=44100:channel_layouts=mono[a0];'
                    f'{a1}aformat=sample_rates=44100:channel_layouts=mono[a1];'
                    f'[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
                    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '20',
                    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], check=True)


def out_name(name, style):
    """majubom_layout.mp4 + scan → majubom_scan.mp4"""
    return name.replace('_layout', '').rsplit('.', 1)[0] + f'_{style}.mp4'


def make(name, style='box'):
    src = os.path.join(VID, name)
    out = os.path.join(VID, out_name(name, style))
    intro = os.path.join(tempfile.mkdtemp(), 'intro.mp4')
    bake_intro(style, first_frame(src), intro)
    join(intro, src, out)
    print(out)


if __name__ == '__main__':
    args = sys.argv[1:]
    style = 'box'
    if '--style' in args:
        k = args.index('--style')
        style = args[k + 1]
        del args[k:k + 2]
    for name in args or ['majubom_layout.mp4']:
        make(name, style)
