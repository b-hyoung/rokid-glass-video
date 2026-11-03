"""인식 직후 전환 애니메이션 모음(상자·홀로그램 스캔·편지 봉투·카메라 조리개·타일 뒤집기). 각 항목: 제목·설명·길이·frames(first)·sfx(fx).
frames는 480x640 프레임을 차례로 내고, 마지막 프레임은 반드시 영상 첫 장면(first)과 같다.
안경 화면이라 초록 단색, 검정은 투명.
"""
import math
import random

from PIL import Image, ImageChops, ImageDraw, ImageFont

import render_intro as R
from render_intro import FPS, G, G2, G3, H, S, W, clamp, ease_in_out, ease_out, mix

CX, CY = W / 2, 300


def P(*xy):
    return [v * S for v in xy]


def canvas(mode='RGB'):
    big = Image.new(mode, (W * S, H * S), (0, 0, 0, 0) if mode == 'RGBA' else 'black')
    return big, ImageDraw.Draw(big)


def down(big):
    return big.resize((W, H), Image.LANCZOS)


def dim(img, k):
    if k >= 1:
        return img
    return Image.eval(img, lambda v, k=max(0.0, k): int(v * k))


def times(dur):
    n = round(dur * FPS)
    return [(i, i / FPS, i == n - 1) for i in range(n)]


def scaled(first, k, cx=W / 2, cy=H / 2, rot=0.0, bright=1.0):
    """first를 k배로 줄여 (cx, cy)에 놓은 프레임."""
    out = Image.new('RGB', (W, H))
    if k <= 0.01:
        return out
    f = first.resize((max(2, round(W * k)), max(2, round(H * k))), Image.LANCZOS)
    f = dim(f, bright)
    if abs(rot) > 0.3:
        mask = Image.new('L', f.size, 255).rotate(rot, resample=Image.BICUBIC, expand=True)
        f = f.rotate(rot, resample=Image.BICUBIC, expand=True)
        out.paste(f, (round(cx - f.width / 2), round(cy - f.height / 2)), mask)
    else:
        out.paste(f, (round(cx - f.width / 2), round(cy - f.height / 2)))
    return out


# ───────────────────────── 1. 상자 열림(기존) ─────────────────────────
def box_frames(first):
    yield from R.render_frames(first)


# ───────────────────────── 2. 홀로그램 스캔 ─────────────────────────
def scan_frames(first):
    rnd = random.Random(5)
    f14 = ImageFont.truetype(R.REG if hasattr(R, 'REG') else 'C:/Windows/Fonts/malgun.ttf', 14)
    for i, t, last in times(2.3):
        if last:
            yield first
            continue
        u = ease_in_out(clamp((t - 0.3) / 1.5))
        y = 20 + (H - 20) * u
        img = Image.new('RGB', (W, H))
        if y > 20:
            top = dim(first.crop((0, 0, W, int(y))), 0.55 + 0.45 * clamp((t - 1.8) / 0.4))
            img.paste(top, (0, 0))
            for _ in range(5):  # 선 근처는 글리치(가로로 어긋남)
                gy = int(y - rnd.uniform(4, 40))
                if gy <= 0:
                    continue
                gh = rnd.randint(2, 6)
                strip = img.crop((0, gy, W, gy + gh))
                img.paste(strip, (rnd.randint(-14, 14), gy))
        d = ImageDraw.Draw(img)
        gk = 1 - clamp((t - 1.8) / 0.4)
        if gk > 0:
            for gx in range(0, W, 32):
                d.line((gx, 0, gx, y), fill=mix(G3, gk * 0.6))
            for gy in range(0, int(y), 32):
                d.line((0, gy, W, gy), fill=mix(G3, gk * 0.6))
        ck = clamp(t / 0.3) * gk
        L = 30
        for (x, yy, sx, sy) in [(16, 16, 1, 1), (W - 16, 16, -1, 1), (16, H - 16, 1, -1), (W - 16, H - 16, -1, -1)]:
            d.line((x, yy, x + L * sx, yy), fill=mix(G, ck), width=3)
            d.line((x, yy, x, yy + L * sy), fill=mix(G, ck), width=3)
        if 0.3 < t < 1.85:
            d.rectangle((0, y - 1, W, y + 1), fill=G)
            for k in range(1, 10):
                d.line((0, y + k, W, y + k), fill=mix(G2, (1 - k / 10) * 0.6))
            pct = int(u * 100)
            d.text((W - 120, min(H - 22, y + 8)), f'인식 중 {pct}%', font=f14, fill=G)
        yield img


def scan_sfx(fx):
    fx.tone(0.05, 0.1, 1500, 1500, 0.3, 20)
    fx.tone(0.3, 1.5, 220, 420, 0.15, 0.3)
    fx.whoosh(0.3, 1.5, 300, 900, 0.12)
    fx.tone(1.82, 0.1, 1800, 1800, 0.35, 20)
    fx.tone(1.95, 0.15, 2400, 2400, 0.35, 15)


# ───────────────────────── 3. 편지 봉투 ─────────────────────────
def envelope_frames(first):
    ew, eh = 230, 150
    for i, t, last in times(2.5):
        if last:
            yield first
            continue
        u_in = ease_out(clamp(t / 0.5))
        ey = 330 + (1 - u_in) * 420
        x0, x1, yt, yb = CX - ew / 2, CX + ew / 2, ey, ey + eh
        gone = clamp((t - 1.6) / 0.5)
        ey_drop = gone * 260
        yt, yb = yt + ey_drop, yb + ey_drop
        ek = 1 - gone
        flap = clamp((t - 0.6) / 0.3)
        tip = yt + eh * 0.55 - flap * eh * 1.1
        # 뒤판·열린 뚜껑
        back, d = canvas()
        d.rectangle(P(x0, yt, x1, yb), fill=(0, 0, 0), outline=mix(G2, ek), width=2 * S)
        if flap > 0.5:
            d.polygon(P(x0, yt, x1, yt, CX, tip), fill=(0, 0, 0), outline=mix(G, ek))
        img = down(back)
        # 카드(영상 첫 장면)가 봉투 안에서 올라와 날아감
        cu = ease_out(clamp((t - 0.85) / 0.5))
        fu = ease_in_out(clamp((t - 1.45) / 1.0))
        cw = 0.32 + (1 - 0.32) * fu
        ccy0 = yb - 60 - cu * 130
        ccy = ccy0 + (H / 2 - ccy0) * fu
        if cu > 0:
            card = scaled(first, cw, CX, ccy, rot=(1 - fu) * 6, bright=0.5 + 0.5 * fu)
            cm = card.convert('L').point(lambda v: 255 if v else 0)
            if fu < 0.3:  # 봉투 앞판 아래로는 가린다
                ImageDraw.Draw(cm).rectangle((0, yt + eh * 0.42, W, H), fill=0)
            img = Image.composite(card, img, cm)
            ImageDraw.Draw(img).rectangle(
                (CX - W * cw / 2 + (0), ccy - H * cw / 2, CX + W * cw / 2, ccy + H * cw / 2),
                outline=mix(G, (1 - fu) * min(1, cu * 2)), width=2)
        # 앞판(아래 두 날개) + 닫힌 뚜껑
        front, d = canvas('RGBA')
        mid = yt + eh * 0.42
        d.polygon(P(x0, mid, CX, yt + eh * 0.72, x1, mid, x1, yb, x0, yb), fill=(0, 0, 0, 255),
                  outline=mix(G, ek) + (255,))
        d.line(P(x0, yb, CX, yt + eh * 0.72, x1, yb), fill=mix(G2, ek) + (255,), width=2 * S)
        if flap <= 0.5:
            d.polygon(P(x0, yt, x1, yt, CX, tip), fill=(0, 0, 0, 255), outline=mix(G, ek) + (255,))
            hy = (yt + tip) / 2  # 하트 봉인
            d.ellipse(P(CX - 9, hy - 9, CX + 9, hy + 9), fill=mix(G, ek) + (255,))
        fr = down(front)
        img.paste(fr.convert('RGB'), (0, 0), fr.split()[3])
        yield img


def envelope_sfx(fx):
    fx.whoosh(0, 0.5, 400, 1500, 0.25)
    fx.tone(0.62, 0.2, 900, 1300, 0.3, 15)
    fx.whoosh(0.85, 0.5, 600, 2000, 0.2)
    for k in range(4):
        fx.tone(1.3 + k * 0.07, 0.15, 2200 + k * 350, 2200 + k * 350, 0.12, 25)
    fx.whoosh(1.45, 1.0, 800, 3000, 0.28)


# ───────────────────────── 4. 카메라 조리개 ─────────────────────────
def iris_frames(first):
    blades = 8
    for i, t, last in times(2.0):
        if last:
            yield first
            continue
        u = ease_in_out(clamp((t - 0.45) / 1.25))
        r = 2 + u * 470
        rot = t * 1.4
        hole = [(CX + math.cos(rot + k * 2 * math.pi / blades) * r, CY + math.sin(rot + k * 2 * math.pi / blades) * r)
                for k in range(blades)]
        mask = Image.new('L', (W, H))
        ImageDraw.Draw(mask).polygon(hole, fill=255)
        img = Image.composite(dim(first, 0.5 + 0.5 * u), Image.new('RGB', (W, H)), mask)
        big, d = canvas()
        lk = clamp(t / 0.35) * (1 - clamp((t - 1.4) / 0.4))
        for k in range(blades):  # 날개 경계선: 구멍 꼭짓점에서 다음 꼭짓점 방향으로 길게
            x0, y0 = hole[k]
            x1, y1 = hole[(k + 1) % blades]
            dx, dy = x1 - x0, y1 - y0
            n = math.hypot(dx, dy) or 1
            d.line(P(x0, y0, x0 + dx / n * 700, y0 + dy / n * 700), fill=mix(G2, lk), width=2 * S)
        rr = 215
        d.ellipse(P(CX - rr, CY - rr, CX + rr, CY + rr), outline=mix(G, lk), width=4 * S)
        rr2 = 228
        for k in range(36):
            a = k * math.pi / 18 - rot * 0.3
            d.line(P(CX + math.cos(a) * rr, CY + math.sin(a) * rr, CX + math.cos(a) * rr2, CY + math.sin(a) * rr2),
                   fill=mix(G3, lk), width=2 * S)
        lines = down(big)
        outside = ImageChops.invert(mask)
        img = Image.composite(lines, img, outside)
        yield img


def iris_sfx(fx):
    for k in range(5):
        fx.tone(0.05 + k * 0.08, 0.04, 1400, 1100, 0.25, 50)
    fx.tone(0.45, 0.1, 600, 300, 0.4, 25)
    fx.whoosh(0.45, 1.25, 500, 2000, 0.25)
    fx.tone(1.7, 0.08, 1200, 900, 0.3, 40)


# ───────────────────────── 5. 타일 뒤집기 ─────────────────────────
def tiles_frames(first):
    cols, rows = 6, 8
    tw, th = W // cols, H // rows
    for i, t, last in times(2.2):
        if last:
            yield first
            continue
        img = Image.new('RGB', (W, H))
        d = ImageDraw.Draw(img)
        for r in range(rows):
            for c in range(cols):
                delay = 0.3 + (c + r) / (cols + rows - 2) * 1.1
                u = clamp((t - delay) / 0.4)
                x0, y0 = c * tw, r * th
                appear = clamp((t - (c + r) * 0.02) / 0.25)
                sx = abs(math.cos(math.pi * u))
                w = max(1, int(tw * sx))
                xm = x0 + (tw - w) // 2
                if u < 0.5:
                    if appear > 0 and w > 8:
                        d.rectangle((xm + 3, y0 + 3, xm + w - 4, y0 + th - 4), outline=mix(G2, appear), width=2)
                        if w > 20:
                            cx_, cy_ = xm + w / 2, y0 + th / 2
                            d.line((cx_ - 6, cy_, cx_ + 6, cy_), fill=mix(G3, appear), width=2)
                            d.line((cx_, cy_ - 6, cx_, cy_ + 6), fill=mix(G3, appear), width=2)
                else:
                    tile = first.crop((x0, y0, x0 + tw, y0 + th)).resize((w, th))
                    img.paste(tile, (xm, y0))
        yield img


def tiles_sfx(fx):
    for k in range(13):
        fx.tone(0.35 + k * 0.085, 0.05, 1800 + k * 60, 1300 + k * 60, 0.22, 45)
    fx.whoosh(0.3, 1.5, 600, 1800, 0.1)
    fx.tone(1.85, 0.25, 900, 1400, 0.3, 10)


STYLES = {
    'box': dict(title='상자 열림', dur=R.DUR, frames=box_frames, sfx=R.box_sfx,
                desc='조준 모서리가 모이고, 상자가 통통 튀다 뚜껑이 열리며 빛과 별이 슝슝. 화면 틀이 날아올라 영상이 된다.'),
    'scan': dict(title='홀로그램 스캔', dur=2.3, frames=scan_frames, sfx=scan_sfx,
                 desc='인식 틀이 잡히고 스캔선이 위에서 아래로 훑으며 격자·글리치와 함께 화면을 그려 낸다. "인식 중 %" 표시.'),
    'envelope': dict(title='편지 봉투', dur=2.5, frames=envelope_frames, sfx=envelope_sfx,
                     desc='하트 봉인 봉투가 올라와 열리고, 안에서 카드가 쏙 빠져나와 화면 가득 커진다.'),
    'iris': dict(title='카메라 조리개', dur=2.0, frames=iris_frames, sfx=iris_sfx,
                 desc='렌즈 테두리와 조리개 날개가 찰칵찰칵 돌며 열리고, 그 구멍 너머로 영상이 보인다.'),
    'tiles': dict(title='타일 뒤집기', dur=2.2, frames=tiles_frames, sfx=tiles_sfx,
                  desc='화면을 덮은 타일 48장이 대각선 물결처럼 차례로 뒤집히며 영상으로 바뀐다.'),
}
