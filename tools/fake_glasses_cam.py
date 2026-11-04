"""안경 없이 카메라 시험을 흉내 낸다(서버·웹 확인용). 안경 앱과 같은 신호를 받고 같은 형식으로 보낸다.

    python tools/fake_glasses_cam.py [서버 주소]     (기본 http://localhost:8787)

사진 방식: ffmpeg 시험 화면을 장마다 JPEG로 만들어 /frame 에 POST.
동영상 방식: ffmpeg로 H.264 를 만들어 /stream 에 한 줄로 흘려보냄.
배터리는 가짜 값(100%에서 조금씩 내려감)을 /tele 로 보낸다.
"""
import http.client
import json
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SERVER = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787').rstrip('/')
U = urllib.parse.urlparse(SERVER)
ID = 'fake-glasses'
state = {'bat': 100, 'temp': 300}


def conn(timeout):  # http/https(터널) 둘 다
    cls = http.client.HTTPSConnection if U.scheme == 'https' else http.client.HTTPConnection
    return cls(U.hostname, U.port, timeout=timeout)


def query(path, cmd, **extra):
    p = {'id': ID, 'test': cmd.get('test'), 'mode': cmd.get('mode'), 'fps': cmd.get('fps'),
         'bat': state['bat'], 'temp': state['temp'], 'th': 0, 'drop': 0, 'fail': 0, **extra}
    return path + '?' + urllib.parse.urlencode(p)


def tele_loop(cmd, stop):
    while not stop.is_set():
        state['bat'] = max(0, state['bat'] - 1)
        state['temp'] += 3
        urllib.request.urlopen(SERVER + query('/tele', cmd), timeout=3).read()
        stop.wait(2)


def frames(fps, sec):  # 시험 화면(640x480)을 JPEG 한 장씩
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=size=640x480:rate={fps}',
                          '-t', str(sec or 3600), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'], stdout=subprocess.PIPE)
    buf = b''
    while True:
        d = p.stdout.read(65536)
        if not d:
            break
        buf += d
        while (e := buf.find(b'\xff\xd9')) >= 0:
            yield buf[:e + 2]
            buf = buf[e + 2:]


def photo(cmd, stop):
    fps, sec = cmd['fps'], cmd.get('sec', 5)
    t0 = time.time()
    pool = ThreadPoolExecutor(2)  # 실제 앱처럼 전송 2줄

    def post(n, jpg):
        c = conn(10)
        c.request('POST', query('/frame', cmd, n=n, t=int(time.time() * 1000), w=640, h=480, q=80), jpg, {'Content-Type': 'image/jpeg'})
        c.getresponse().read()
    for n, jpg in enumerate(frames(fps, sec), 1):
        if stop.is_set():
            break
        wait = t0 + (n - 1) / fps - time.time()
        if wait > 0:
            time.sleep(wait)
        if pool._work_queue.qsize() < 2:  # 밀리면 버림(실제 앱과 같게)
            pool.submit(post, n, jpg)
    pool.shutdown(wait=True)


def video(cmd, stop):  # 실제 앱처럼 0.25초씩 잘라 /stream 에 차례로 POST
    fps, sec = cmd['fps'], cmd.get('sec', 5)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-re', '-f', 'lavfi', '-i', f'testsrc2=size=1280x720:rate={fps}', '-t', str(sec or 3600),
                          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', f"{cmd.get('kbps', 2000)}k",
                          '-g', str(fps), '-f', 'h264', 'pipe:1'], stdout=subprocess.PIPE, bufsize=0)
    base = query('/stream', cmd, w=1280, h=720, kbps=cmd.get('kbps', 2000))
    seg, k, at = b'', 0, time.time()
    while not stop.is_set():
        d = p.stdout.read(4096)
        if d:
            seg += d
        if seg and (time.time() - at >= 0.25 or not d):
            c = conn(10)
            c.request('POST', f'{base}&seg={k}' + ('' if d else '&end=1'), seg, {'Content-Type': 'video/h264'})
            c.getresponse().read()
            seg, k, at = b'', k + 1, time.time()
        if not d:
            break
    p.kill()


def main():
    seq = None
    run = None
    while True:
        try:
            if seq is None:
                seq = json.load(urllib.request.urlopen(f'{SERVER}/next?id={ID}', timeout=30))['seq']
                print('대기 중', SERVER, flush=True)
            m = json.load(urllib.request.urlopen(f'{SERVER}/next?id={ID}&after={seq}', timeout=40))
        except Exception as e:  # 서버를 다시 켜면 번호가 처음부터라 다시 받는다
            print('연결 끊김, 다시 연결', e, flush=True)
            seq = None
            time.sleep(1)
            continue
        seq = m.get('seq', seq)
        if m.get('cmd') != 'cam':
            continue
        if run:
            run.set()
        if m.get('fps', 0) <= 0:
            print('끔')
            continue
        print('시작', m)
        run = threading.Event()
        threading.Thread(target=tele_loop, args=(m, run), daemon=True).start()
        work = video if m.get('mode') == 'video' else photo

        def job(cmd=m, stop=run):
            work(cmd, stop)
            stop.set()
            print('끝', cmd.get('test'))
        threading.Thread(target=job, daemon=True).start()


if __name__ == '__main__':
    main()
