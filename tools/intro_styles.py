"""인식 직후 전환 애니메이션 모음. 각 항목: 제목·설명·길이·frames(first)·sfx(fx).
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


def ease_back(t, s=1.7):
    t -= 1
    return t * t * ((s + 1) * t + s) + 1


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


# ───────────────────────── 2. 포털 소용돌이 ─────────────────────────
def portal_frames(first):
    for i, t, last in times(2.2):
        if last:
            yield first
            continue
        big, d = canvas()
        grow = ease_out(clamp(t / 0.6))
        u = clamp((t - 1.2) / 0.9)
        fade = 1 - u
        spin = t * (2 + t * 3)
        for k in range(6):
            r = (24 + k * 30) * grow
            a0 = math.degrees(spin * (1 if k % 2 else -1.3)) + k * 40
            for seg in range(6):
                st = a0 + seg * 60
                d.arc(P(CX - r, CY - r, CX + r, CY + r), st, st + 38, fill=mix(G if k % 2 else G2, fade), width=3 * S)
        for arm in range(3):  # 소용돌이 팔
            pts = []
            for q in range(40):
                th = q * 0.18
                rr = q * 4.4 * grow
                pts.append((CX + math.cos(th + spin * 1.6 + arm * 2.09) * rr, CY + math.sin(th + spin * 1.6 + arm * 2.09) * rr))
            d.line([v * S for xy in pts for v in xy], fill=mix(G3, fade), width=2 * S)
        r0 = 10 + 8 * math.sin(t * 20)
        d.ellipse(P(CX - r0, CY - r0, CX + r0, CY + r0), fill=mix(G, fade))
        img = down(big)
        if u > 0:
            R_ = ease_in_out(u) * 430
            mask = Image.new('L', (W, H))
            ImageDraw.Draw(mask).ellipse((CX - R_, CY - R_, CX + R_, CY + R_), fill=255)
            img = Image.composite(dim(first, 0.4 + 0.6 * u), img, mask)
            ring = ImageDraw.Draw(img)
            ring.ellipse((CX - R_, CY - R_, CX + R_, CY + R_), outline=mix(G, 1 - u * 0.7), width=4)
        yield img


def portal_sfx(fx):
    fx.whoosh(0, 1.25, 200, 1400, 0.3)
    fx.tone(0.15, 1.05, 180, 700, 0.18, 0.8)
    fx.tone(1.2, 0.3, 300, 1600, 0.5, 8)
    fx.whoosh(1.2, 1.0, 900, 3200, 0.3)


# ───────────────────────── 3. 홀로그램 스캔 ─────────────────────────
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


# ───────────────────────── 4. 워프 별빛 ─────────────────────────
def warp_frames(first):
    rnd = random.Random(11)
    stars = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.2, 1.0), rnd.uniform(0.5, 1.0)) for _ in range(160)]
    prev = {}
    for i, t, last in times(2.1):
        if last:
            yield first
            continue
        big, d = canvas()
        tw = min(t, 1.4)
        travel = 0.15 * tw + 1.6 * tw ** 3
        if t < 1.5:
            for k, (ang, z0, br) in enumerate(stars):
                z = (z0 - travel) % 1.0 + 0.02
                r = 40 / z
                x, y = CX + math.cos(ang) * r, CY + math.sin(ang) * r
                px, py = prev.get(k, (x, y))
                if math.hypot(x - px, y - py) > 400:
                    px, py = x, y
                d.line(P(px, py, x, y), fill=mix(G if br > 0.8 else G2, br * (1 - clamp((t - 1.3) / 0.2))), width=2 * S)
                prev[k] = (x, y)
        img = down(big)
        fl = clamp((t - 1.3) / 0.12) * (1 - clamp((t - 1.45) / 0.45))
        reveal = clamp((t - 1.42) / 0.5)
        if reveal > 0:
            img = ImageChops.lighter(img, dim(first, reveal))
        if fl > 0:
            r = 40 + 500 * clamp((t - 1.3) / 0.25)
            flash = Image.new('RGB', (W, H))
            ImageDraw.Draw(flash).ellipse((CX - r, CY - r, CX + r, CY + r), fill=mix(G2, fl * 0.4))
            img = ImageChops.lighter(img, flash)
        yield img


def warp_sfx(fx):
    fx.whoosh(0, 1.4, 120, 4200, 0.35)
    fx.tone(1.32, 0.45, 90, 40, 0.6, 6)
    fx.whoosh(1.35, 0.7, 3000, 500, 0.2)


# ───────────────────────── 5. 편지 봉투 ─────────────────────────
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


# ───────────────────────── 6. 캡슐 뽑기 ─────────────────────────
def capsule_frames(first):
    r0 = 70
    rnd = random.Random(3)
    burst = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(200, 420), rnd.random() < 0.5) for _ in range(22)]
    T_POP = 1.05
    for i, t, last in times(2.3):
        if last:
            yield first
            continue
        big, d = canvas()
        fall = ease_out(clamp(t / 0.45))
        y = -100 + (CY + 40 + 100) * fall
        if t > 0.45:
            y -= abs(math.sin((t - 0.45) * 12)) * 40 * math.exp(-(t - 0.45) * 6)
        wob = math.sin(t * 30) * 14 * clamp((t - 0.65) / 0.1) if t < T_POP else 0
        pu = clamp((t - T_POP) / 0.6)

        def half(cx, cy, rot, top, k):
            pts = []
            for q in range(25):
                a = math.radians(180 + q * 7.5) if top else math.radians(q * 7.5)
                pts.append((r0 * math.cos(a), r0 * math.sin(a)))
            ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
            pts = [(cx + x * ca - yy * sa, cy + x * sa + yy * ca) for x, yy in pts]
            d.polygon([v * S for xy in pts for v in xy], fill=mix(G3, k * 0.6) if top else (0, 0, 0),
                      outline=mix(G, k))
            if top:  # 반짝 하이라이트
                hx, hy = cx - 28 * ca + 30 * sa, cy - 28 * sa - 30 * ca
                d.ellipse(P(hx - 8, hy - 5, hx + 8, hy + 5), fill=mix(G, k))

        if t < T_POP:
            half(CX, y, wob, False, 1)
            half(CX, y, wob, True, 1)
        else:
            k = 1 - pu
            half(CX - 160 * pu, y - 220 * pu + 300 * pu * pu, -200 * pu, True, k)
            half(CX + 40 * pu, y + 260 * pu * pu, 60 * pu, False, k)
            for ang, sp, star in burst:
                rr = 20 + sp * ease_out(pu)
                x, yy = CX + math.cos(ang) * rr, y + math.sin(ang) * rr
                if star:
                    s = 6 * (1 - pu)
                    d.polygon(P(x, yy - s, x + s * .3, yy - s * .3, x + s, yy, x + s * .3, yy + s * .3,
                                x, yy + s, x - s * .3, yy + s * .3, x - s, yy, x - s * .3, yy - s * .3), fill=mix(G, 1 - pu))
                else:
                    d.line(P(CX + math.cos(ang) * rr * 0.7, y + math.sin(ang) * rr * 0.7, x, yy), fill=mix(G2, 1 - pu), width=2 * S)
        img = down(big)
        if t >= T_POP:
            gu = clamp((t - T_POP) / 0.9)
            k = max(0.02, ease_back(gu))
            cy = y + (H / 2 - y) * ease_out(gu)
            card = scaled(first, k, CX, cy, bright=0.5 + 0.5 * gu)
            img = Image.composite(card, img, card.convert('L').point(lambda v: 255 if v else 0))
        yield img


def capsule_sfx(fx):
    fx.whoosh(0, 0.45, 1500, 300, 0.2)
    fx.tone(0.45, 0.15, 220, 120, 0.5, 25)
    for k in range(4):
        fx.tone(0.65 + k * 0.09, 0.06, 900, 700, 0.2, 40)
    fx.tone(1.05, 0.2, 300, 1800, 0.55, 10)
    for k in range(6):
        fx.tone(1.1 + k * 0.05, 0.12, 2500 + k * 250, 2500 + k * 250, 0.12, 25)
    fx.whoosh(1.1, 0.9, 700, 2800, 0.25)


# ───────────────────────── 7. 입자 모임 ─────────────────────────
def assemble_frames(first):
    rnd = random.Random(9)
    gray = first.convert('L')
    px = gray.load()
    cand = [(x, y) for y in range(0, H, 3) for x in range(0, W, 3) if px[x, y] > 110]
    targets = rnd.sample(cand, min(900, len(cand)))
    parts = []
    for (tx, ty) in targets:
        a = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(380, 620)
        parts.append((CX + math.cos(a) * r, CY + math.sin(a) * r, tx, ty, rnd.uniform(0, 0.55), px[tx, ty]))
    for i, t, last in times(2.3):
        if last:
            yield first
            continue
        img = Image.new('RGB', (W, H))
        d = ImageDraw.Draw(img)
        pk = 1 - clamp((t - 1.55) / 0.5)
        for sx, sy, tx, ty, delay, v in parts:
            u = clamp((t - delay) / 1.0)
            if u <= 0 or pk <= 0:
                continue
            e = ease_in_out(u)
            e2 = ease_in_out(clamp(u - 0.06))
            x, y = sx + (tx - sx) * e, sy + (ty - sy) * e
            x2, y2 = sx + (tx - sx) * e2, sy + (ty - sy) * e2
            c = (0, int(v * pk), int(v * pk * 0.35))
            if u < 1:
                d.line((x2, y2, x, y), fill=c, width=1)
            d.rectangle((x - 1, y - 1, x + 1, y + 1), fill=c)
        rv = clamp((t - 1.35) / 0.7)
        if rv > 0:
            img = ImageChops.lighter(img, dim(first, rv))
        yield img


def assemble_sfx(fx):
    fx.whoosh(0, 1.5, 2500, 400, 0.25)
    for k in range(14):
        fx.tone(0.1 + k * 0.08, 0.05, 3000 - k * 90, 3000 - k * 90, 0.06, 40)
    fx.tone(1.4, 0.5, 500, 1000, 0.35, 5)


# ───────────────────────── 8. 카메라 조리개 ─────────────────────────
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


# ───────────────────────── 9. 타일 뒤집기 ─────────────────────────
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


# ───────────────────────── 10. 마법진 ─────────────────────────
def magic_frames(first):
    for i, t, last in times(2.4):
        if last:
            yield first
            continue
        big, d = canvas()
        rot = 0.6 * t + 1.6 * t * t
        burst = clamp((t - 1.45) / 0.5)
        k = 1 - burst
        R1, R2 = 170 + burst * 260, 138 + burst * 200
        draw = clamp(t / 0.6)
        d.arc(P(CX - R1, CY - R1, CX + R1, CY + R1), -90, -90 + 360 * draw, fill=mix(G, k), width=3 * S)
        d.arc(P(CX - R2, CY - R2, CX + R2, CY + R2), 90, 90 + 360 * draw, fill=mix(G2, k), width=2 * S)
        for q in range(48):  # 눈금
            if q / 48 > draw:
                break
            a = q * math.pi / 24 + rot
            r_in = R2 + 6 if q % 4 else R2 + 2
            d.line(P(CX + math.cos(a) * r_in, CY + math.sin(a) * r_in, CX + math.cos(a) * (R1 - 6), CY + math.sin(a) * (R1 - 6)),
                   fill=mix(G3 if q % 4 else G2, k), width=2 * S)
        hx = clamp((t - 0.35) / 0.55)
        for tri in range(2):  # 육망성
            pts = [(CX + math.cos(-rot * 1.5 + tri * math.pi / 3 + j * 2 * math.pi / 3 - math.pi / 2) * (R2 - 8),
                    CY + math.sin(-rot * 1.5 + tri * math.pi / 3 + j * 2 * math.pi / 3 - math.pi / 2) * (R2 - 8)) for j in range(3)]
            for j in range(3):
                seg = clamp(hx * 3 - j)
                if seg <= 0:
                    continue
                (ax, ay), (bx, by) = pts[j], pts[(j + 1) % 3]
                d.line(P(ax, ay, ax + (bx - ax) * seg, ay + (by - ay) * seg), fill=mix(G, k), width=2 * S)
        rr = 44 * clamp((t - 0.8) / 0.3)
        d.ellipse(P(CX - rr, CY - rr, CX + rr, CY + rr), outline=mix(G2, k), width=2 * S)
        glow = clamp((t - 1.1) / 0.35) * k
        if glow > 0:
            g = 30 + 30 * math.sin(t * 40)
            d.ellipse(P(CX - g, CY - g, CX + g, CY + g), fill=mix(G, glow))
        img = down(big)
        if burst > 0:
            card = scaled(first, 0.15 + 0.85 * ease_out(burst), CX, CY + (H / 2 - CY) * ease_out(burst), bright=0.4 + 0.6 * burst)
            img = Image.composite(card, img, card.convert('L').point(lambda v: 255 if v else 0))
        yield img


def magic_sfx(fx):
    fx.tone(0, 0.6, 300, 600, 0.2, 1)
    fx.tone(0.35, 0.8, 600, 1200, 0.15, 1.5)
    fx.whoosh(0.3, 1.2, 200, 1500, 0.2)
    fx.tone(1.1, 0.35, 1500, 1500, 0.15, 3)
    fx.tone(1.45, 0.5, 120, 60, 0.6, 6)
    for k in range(6):
        fx.tone(1.5 + k * 0.05, 0.15, 2800 + k * 200, 2800 + k * 200, 0.12, 20)
    fx.whoosh(1.45, 0.8, 1200, 3500, 0.25)


STYLES = {
    'box': dict(title='상자 열림', dur=R.DUR, frames=box_frames, sfx=R.box_sfx,
                desc='조준 모서리가 모이고, 상자가 통통 튀다 뚜껑이 열리며 빛과 별이 슝슝. 화면 틀이 날아올라 영상이 된다.'),
    'portal': dict(title='포털 소용돌이', dur=2.2, frames=portal_frames, sfx=portal_sfx,
                   desc='점선 고리가 엇갈려 돌며 소용돌이가 빨라지고, 가운데 원이 터지듯 넓어지며 영상이 드러난다.'),
    'scan': dict(title='홀로그램 스캔', dur=2.3, frames=scan_frames, sfx=scan_sfx,
                 desc='인식 틀이 잡히고 스캔선이 위에서 아래로 훑으며 격자·글리치와 함께 화면을 그려 낸다. "인식 중 %" 표시.'),
    'warp': dict(title='워프 별빛', dur=2.1, frames=warp_frames, sfx=warp_sfx,
                 desc='별빛이 점점 빠르게 뒤로 날아가는 초광속 이동. 번쩍하는 섬광과 함께 영상에 도착한다.'),
    'envelope': dict(title='편지 봉투', dur=2.5, frames=envelope_frames, sfx=envelope_sfx,
                     desc='하트 봉인 봉투가 올라와 열리고, 안에서 카드가 쏙 빠져나와 화면 가득 커진다.'),
    'capsule': dict(title='캡슐 뽑기', dur=2.3, frames=capsule_frames, sfx=capsule_sfx,
                    desc='뽑기 캡슐이 툭 떨어져 덜덜 흔들리다 뚜껑이 퐁 날아가고, 영상이 튀어나오듯 커진다.'),
    'assemble': dict(title='입자 모임', dur=2.3, frames=assemble_frames, sfx=assemble_sfx,
                     desc='사방에서 빛 알갱이 900개가 꼬리를 끌며 날아와 모여 영상 첫 장면의 모양을 그린다.'),
    'iris': dict(title='카메라 조리개', dur=2.0, frames=iris_frames, sfx=iris_sfx,
                 desc='렌즈 테두리와 조리개 날개가 찰칵찰칵 돌며 열리고, 그 구멍 너머로 영상이 보인다.'),
    'tiles': dict(title='타일 뒤집기', dur=2.2, frames=tiles_frames, sfx=tiles_sfx,
                  desc='화면을 덮은 타일 48장이 대각선 물결처럼 차례로 뒤집히며 영상으로 바뀐다.'),
    'magic': dict(title='마법진', dur=2.4, frames=magic_frames, sfx=magic_sfx,
                  desc='원과 눈금, 육망성이 그려지며 점점 빠르게 회전하고, 빛이 모였다가 펑 터지며 영상이 나타난다.'),
}
