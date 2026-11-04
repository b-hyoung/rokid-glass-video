"""Cloudflare 빠른 터널을 켜고, 새 주소를 고정 주소의 server.txt 에 올린다.
안경 앱은 켤 때와 연결이 3번 연속 실패할 때 server.txt 를 읽으므로, 터널 주소가 바뀌어도 다시 설치할 필요가 없다.

    node server/server.mjs        (먼저 서버를 켜 둔다)
    python tools/tunnel.py        (터널 켜기 + server.txt 갱신, Ctrl+C 로 끔)

server.txt: https://glass-2412.youqlrqod.workers.dev/server.txt (Cloudflare Workers 정적 배포, wrangler.jsonc)
"""
import os
import re
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


def publish(url):
    if not os.path.isdir(DIST):
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build_pages.py')], check=True)
    with open(os.path.join(DIST, 'server.txt'), 'w', encoding='utf-8') as f:
        f.write(url + '\n')
    subprocess.run('npx --yes wrangler deploy', shell=True, cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)


def main():
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
