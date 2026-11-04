"""긴 카메라 시험(60초 넘는 것)이 끝날 때까지 기다렸다가 1분 단위로 정리한다.

    python tools/watch_long_test.py        (최대 30분 기다림)

1분마다 받은 장 수(그 1분의 실제 초당), 배터리 %, 배터리 온도, 발열 단계를 표로 찍는다.
"""
import json
import sys
import time
import urllib.request

S = 'http://localhost:8787'
TH = ['정상', '약간', '보통', '심함', '위험', '비상', '꺼짐']


def stats():
    return json.load(urllib.request.urlopen(S + '/cam/stats', timeout=5))


def main():
    deadline = time.time() + 30 * 60
    no, samples, start = None, [], None
    while time.time() < deadline:
        d = stats()
        t = d['test']
        if t and not t['done'] and (t['sec'] == 0 or t['sec'] > 60):
            if no != t['no']:
                no, samples, start = t['no'], [], time.time()
                print(f"{no}번 시험 감시 시작: {'동영상' if t['mode'] == 'video' else '사진'} 초당 {t['fps']}장, "
                      f"{t['sec'] // 60 if t['sec'] else '끌 때까지'}{'분' if t['sec'] else ''}", flush=True)
            tele = d['tele'] or {}
            samples.append((t['elapsed'], t['frames'], tele.get('bat'), tele.get('temp'), tele.get('th')))  # 시험 시작 기준 시간(서버 값)
        elif no is not None and (not t or t['no'] != no or t['done']):
            break
        time.sleep(5)
    if no is None:
        print('긴 시험이 시작되지 않았습니다.')
        return
    r = next((x for x in stats()['results'] if x['no'] == no), None)
    print('\n분 | 그 1분 받은 장 | 실제 초당 | 배터리 | 온도 | 발열')
    last_f, last_s = 0, 0
    for m in range(1, int(samples[-1][0] // 60) + 2):
        rows = [x for x in samples if x[0] <= m * 60]
        if not rows:
            continue
        s, f, bat, temp, th = rows[-1]
        span = max(1, s - last_s)
        print(f"{m:>2} | {f - last_f:>5} | {(f - last_f) / span:>5.1f} | {bat}% | {temp / 10 if temp and temp >= 0 else '-'}°C | {TH[th] if th is not None and th >= 0 else '-'}")
        last_f, last_s = f, s
    if r:
        print(f"\n전체: 받은 장 {r['frames']} · 실제 초당 {r['real']} · 배터리 {r['bat0']}→{r['bat1']}% · "
              f"온도 {(r['temp0'] or 0) / 10}→{(r['temp1'] or 0) / 10}°C · 발열 최고 {TH[r['maxTh'] or 0]}"
              + (f" · 안전 멈춤({r['why']})" if r.get('why') else ''))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
