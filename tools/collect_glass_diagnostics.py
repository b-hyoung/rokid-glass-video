"""Read-only, local collector for existing /cam/stats telemetry."""
import argparse
import datetime as dt
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = 'https://glass-2412.youqlrqod.workers.dev'


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')


def fetch(url, timeout):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept': 'application/json',
                                              'User-Agent': 'Mozilla/5.0 GlassDiagnostics/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        value = json.load(response)
        if not isinstance(value, dict):
            raise ValueError('stats response is not an object')
        return value, response.headers.get('Date')


def collect(base_url, interval, duration, output_dir, timeout):
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('URL은 사용자 정보, 쿼리 및 조각이 없는 http(s) 주소여야 합니다')
    endpoint = base_url.rstrip('/') + '/cam/stats'
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    path = output_dir / f'glass-stats-{stamp}.jsonl'
    # Exclusive creation prevents two simultaneous runs from overwriting each other.
    n = 1
    while path.exists():
        path = output_dir / f'glass-stats-{stamp}-{n}.jsonl'
        n += 1
    start = time.monotonic()
    print(f'저장: {path.resolve()}', flush=True)
    print('촬영을 시작하고 끊김을 재현하세요. 종료: Ctrl+C', flush=True)
    with path.open('x', encoding='utf-8', buffering=1) as out:
        def write(row):
            out.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
        write({'type': 'start', 'time_utc': timestamp(), 'endpoint': endpoint,
               'interval_seconds': interval, 'duration_seconds': duration,
               'note': 'Read-only snapshots; viewer indices can change; metrics are cumulative and may be stale or background.'})
        count = 0
        trace_epoch, trace_cursor = None, 0
        next_at = start
        try:
            while duration is None or time.monotonic() - start < duration:
                wait = next_at - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                if duration is not None and time.monotonic() - start >= duration:
                    break
                requested = timestamp()
                before = time.monotonic()
                try:
                    stats, server_date = fetch(endpoint, timeout)
                    elapsed = round((time.monotonic() - before) * 1000, 1)
                    row = {'type': 'sample', 'requested_at_utc': requested, 'received_at_utc': timestamp(),
                           'elapsed_ms': elapsed, 'server_http_date': server_date, 'stats': stats}
                    test = stats.get('test') or {}
                    visible = [v for v in (stats.get('viewers') or []) if (v.get('metrics') or {}).get('visible')]
                    display = ', '.join(f"{v.get('media')} 표시 {(v.get('metrics') or {}).get('displayFps', 0):.1f}fps (마지막 보고값)" for v in visible)
                    print(f"{row['received_at_utc']} 서버 {stats.get('receiveFps', 0)}fps · "
                          f"안경 버림 {(stats.get('tele') or {}).get('drop', '-')} · "
                          f"{display or '보이는 뷰어 지표 없음'} · 시험 {'진행' if test and not test.get('done') else '대기'}", flush=True)
                except (OSError, ValueError, urllib.error.URLError) as exc:
                    row = {'type': 'error', 'requested_at_utc': requested, 'received_at_utc': timestamp(),
                           'elapsed_ms': round((time.monotonic()-before)*1000, 1), 'error': str(exc)}
                    print(f"조회 실패: {exc}", flush=True)
                write(row)
                # The server keeps a bounded in-memory ring. Persist every batch before
                # advancing the cursor; epoch/reset and loss markers remain in the file.
                try:
                    query = urllib.parse.urlencode({'epoch': trace_epoch or '', 'after': trace_cursor})
                    trace_requested = timestamp()
                    trace, trace_date = fetch(base_url.rstrip('/') + '/cam/diagnostics?' + query, timeout)
                    write({'type': 'server_trace', 'requested_at_utc': trace_requested,
                           'received_at_utc': timestamp(), 'server_http_date': trace_date, 'trace': trace})
                    trace_epoch, trace_cursor = trace['epoch'], trace['latest']
                except (OSError, ValueError, KeyError, urllib.error.URLError) as exc:
                    write({'type': 'server_trace_error', 'time_utc': timestamp(), 'error': str(exc)})
                    print(f'서버 상세 기록 조회 실패: {exc}', flush=True)
                count += 1
                next_at += interval
                if next_at < time.monotonic():
                    next_at = time.monotonic() + interval
        except KeyboardInterrupt:
            print('\n수집을 종료합니다.', flush=True)
        finally:
            write({'type': 'end', 'time_utc': timestamp(), 'samples': count})
    print(f'완료: {path.resolve()} ({count}회)', flush=True)
    return path


def main():
    p = argparse.ArgumentParser(description='안경 영상 진단 상태를 이 PC에 JSONL로 저장합니다.')
    p.add_argument('--url', default=DEFAULT_URL, help='서버 기본 주소')
    p.add_argument('--interval', type=float, default=1.0, help='조회 간격(초, 기본 1초, 최소 0.5초)')
    p.add_argument('--duration', type=float, default=None, help='수집 시간(초); 생략하면 Ctrl+C까지')
    p.add_argument('--timeout', type=float, default=5.0, help='HTTP 요청 제한 시간(초)')
    p.add_argument('--output', type=Path, default=Path(__file__).resolve().parent.parent / 'recordings' / 'diagnostics')
    a = p.parse_args()
    if a.interval < 0.5 or a.timeout <= 0 or (a.duration is not None and a.duration <= 0):
        p.error('간격은 0.5초 이상, 제한 시간과 수집 시간은 양수여야 합니다')
    try:
        collect(a.url, a.interval, a.duration, a.output, a.timeout)
    except (OSError, ValueError) as e:
        p.exit(1, f'시작 실패: {e}\n')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
