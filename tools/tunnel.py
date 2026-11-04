"""Cloudflare 빠른 터널을 켜고, 새 주소를 고정 주소의 server.txt 에 올린다.
안경 앱은 켤 때와 연결이 3번 연속 실패할 때 server.txt 를 읽으므로, 터널 주소가 바뀌어도 다시 설치할 필요가 없다.
server.txt 에는 같은 와이파이용 이 PC 주소들을 먼저, 터널 주소를 나중에 적는다(앱 0.2.3+ 가 차례로 시도).

    node server/server.mjs        (먼저 서버를 켜 둔다)
    python tools/tunnel.py        (터널 켜기 + server.txt 갱신, Ctrl+C 로 끔)
    python tools/tunnel.py --lan  (로컬 시험: 터널 없이 이 PC 주소만 server.txt 에 올림)

server.txt: https://glass-2412.youqlrqod.workers.dev/server.txt (Cloudflare Workers 정적 배포, wrangler.jsonc)
"""
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
LOCAL = 'http://localhost:8787'


def ok(url):
    try:
        urllib.request.urlopen(url + '/status', timeout=5).read()
        return True
    except Exception:
        return False


def lan():  # 같은 와이파이에서 안경이 직접 붙을 이 PC 주소들(사설 IPv4)
    ips = set()
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return [f'http://{ip}:8787' for ip in sorted(ips) if ip.startswith('192.168.')]  # 가상망(172.x)·별도 유선망(10.x)은 안경이 못 붙음


def publish(url=None):
    if not os.path.isdir(DIST):
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build_pages.py')], check=True)
    lines = lan() + ([url] if url else [])  # 앱 0.2.3+ 는 앞에서부터 시도(직접 먼저, 터널 나중), 0.2.2 이하는 첫 줄만 씀
    with open(os.path.join(DIST, 'server.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('server.txt:', ' / '.join(lines), flush=True)
    subprocess.run('npx --yes wrangler deploy', shell=True, cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)


def main():
    if '--lan' in sys.argv:  # 로컬만: 터널로 조용히 넘어가지 않게 터널 주소를 뺀다
        publish()
        print('로컬 전용 server.txt 올림. 안경이 PC 주소로만 붙습니다.')
        return
    if not ok(LOCAL):
        print('서버가 꺼져 있습니다. 먼저 node server/server.mjs 를 켜 주세요.')
        sys.exit(1)
    p = subprocess.Popen(['cloudflared', 'tunnel', '--no-autoupdate', '--url', LOCAL],
                         stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    url = None
    try:
        for line in p.stderr:  # 계속 읽어 줘야 터널이 멈추지 않는다
            if url:
                continue
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if not m:
                continue
            url = m.group(0)
            print('터널 주소', url, flush=True)
            for _ in range(40):
                if ok(url):
                    break
                time.sleep(1)
            publish(url)
            print('server.txt 갱신 완료 → 안경이 곧 새 주소로 붙습니다(늦어도 앱 재시작 시). Ctrl+C 로 끔', flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        p.terminate()


if __name__ == '__main__':
    main()
