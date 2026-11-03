"""미리보기 D 레이아웃(영상 왼쪽·글씨 오른쪽)을 480x640 영상 한 편으로 굽는다.
앱은 영상만 틀 줄 알면 되므로, 레이아웃을 바꿔도 앱을 다시 설치할 필요가 없다.

    python tools/render_layout.py            → server/videos/gyeon_layout.mp4

다른 작품은 render()에 왼쪽 영상(240x370)과 문구만 바꿔 넘긴다(예: render_majubom.py).
"""
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'preview', 'gyeon_left.mp4')  # 240x370 초록 영상
OUT = os.path.join(ROOT, 'server', 'videos', 'gyeon_layout.mp4')
DUR = 33.5

G, G2, G3 = '0x3dff5a', '0x1fae35', '0x0f6a20'
REG = 'C\\:/Windows/Fonts/malgun.ttf'
BOLD = 'C\\:/Windows/Fonts/malgunbd.ttf'

HEADER = '후백제 VR 〈견훤〉'
CUES = [  # (시작 초, 지금 장면 — 오른쪽 칸 210px에 맞춰 줄바꿈)
    (0, '호랑이 길잡이와\n출발'),
    (6, '리프트 타고\n성벽 위로'),
    (9.5, '후백제 군사를\n만나고'),
    (14, '눈앞에 펼쳐지는\n옛 이야기'),
    (20, '밤바다에 낚싯대를\n드리우면'),
    (25, '고래가 걸렸다?!'),
]
INFO = [
    ('작품', '후백제 왕도 전주를 담은\nVR 체험'),
    ('체험', '두 사람이 같은 세계를\n함께 걷는 체험'),
    ('전시', '제28회 김제지평선축제\nXR 체험존'),
    ('만든 팀', '훈아티스 HOONARTIS'),
    ('기술', '위치기반 XR · 언리얼 엔진 5\n무선 HMD'),
]
X = 256        # 오른쪽 칸 왼쪽 끝
VIDEO_Y = 139  # 영상 위치(가운데 줄 64~584 안에서 세로 가운데)


def render(src, out, dur, header, cues, info):
    """src: 240x370 초록 영상, cues: [(시작 초, 장면 문구)], info: [(제목, 내용)]"""
    tmp = tempfile.mkdtemp()
    n = 0

    def textfile(s):
        nonlocal n
        n += 1
        p = os.path.join(tmp, f't{n}.txt')
        with open(p, 'wb') as f:  # 윈도우 줄바꿈(\r\n)이면 drawtext 가 줄을 두 번 바꾼다
            f.write(s.encode('utf-8'))
        return p.replace('\\', '/').replace(':', '\\:')

    def text(s, x, y, size, color, font=REG, enable=None, center=False):
        xs = '(w-text_w)/2' if center else str(x)
        e = f":enable='{enable}'" if enable else ''
        return (f"drawtext=fontfile='{font}':textfile='{textfile(s)}':x={xs}:y={y}:fontsize={size}"
                f":fontcolor={color}:line_spacing=4{e}")

    f = [f"[0][1]overlay=0:{VIDEO_Y}:shortest=1"]
    f.append(text(header, 0, 18, 24, G, BOLD, center=True))
    y = 112
    f.append(text('지금 장면', X, y, 14, G2))
    for i, (t, s) in enumerate(cues):
        end = cues[i + 1][0] if i + 1 < len(cues) else dur + 1
        f.append(text(s, X, y + 22, 22, G, BOLD, enable=f'between(t,{t},{end})'))
        dots = ' '.join('●' if k == i else '○' for k in range(len(cues)))
        f.append(text(dots, 0, 606, 14, G, REG, enable=f'between(t,{t},{end})', center=True))
    y += 22 + 64
    f.append(f"drawbox=x={X}:y={y}:w=210:h=1:color={G3}:t=fill")
    y += 16
    for tag, body in info:
        lines = body.count('\n') + 1
        f.append(text(tag, X, y, 14, G2))
        f.append(text(body, X, y + 20, 17, G))
        y += 20 + lines * 24 + 12
    chain = ','.join(f)

    script = os.path.join(tmp, 'filter.txt')
    with open(script, 'w', encoding='utf-8') as fh:
        fh.write(chain + ',format=yuv420p[v]')
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', f'color=c=black:s=480x640:r=24:d={dur}',
        '-i', src,
        '-/filter_complex', script, '-map', '[v]', '-map', '1:a?',  # ffmpeg 7+ 에서 파일로 필터 읽기
        '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '22',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out,
    ], check=True)
    print(out)


def main():
    render(SRC, OUT, DUR, HEADER, CUES, INFO)


if __name__ == '__main__':
    main()
