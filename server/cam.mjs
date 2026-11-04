// 안경 카메라 전송 시험(서버 쪽). 웹 /cam 에서 버튼 → /cam/set → 안경에 {"cmd":"cam"} 신호 →
// 안경이 사진(/frame) 또는 동영상(/stream, ffmpeg로 풂)과 배터리·발열(/tele)을 보낸다.
// 시험마다 "설정 초당 N장 → 실제로 받은 장 수"를 recordings/cam_tests.csv, 2초마다 상태를 cam_tele.csv 에 남긴다.
import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const THERMAL = ['정상', '약간', '보통', '심함', '위험', '비상', '꺼짐'];
// 시험마다 받은 장면을 바탕화면에 남긴다: 사진은 jpg 전부, 동영상은 원본 h264, 끝나면 둘 다 영상.mp4 로.
// 안경 카메라 센서가 옆으로 누워 장면이 시계 방향 90°로 오므로(11-04 실측) mp4 는 왼쪽 90°(transpose=2)로 돌려 만든다.
const SAVE = join(homedir(), 'Desktop', '안경카메라_기록');
const TURN = 'transpose=2';
// 안전 자동 멈춤: 발열 단계 3(심함) 이상 또는 배터리 온도 45°C 이상이면 시험을 끈다(긴 시험을 두고 자리를 비워도 되게).
const STOP_TH = 3, STOP_TEMP = 450, STOP_HEAD = 100; // 발열 여유 100% = 시스템이 크게 느려지는 선(안드로이드 기준)

export function camRoutes({dir, send, json}) {
  const rec = join(dir, '..', 'recordings');
  mkdirSync(rec, {recursive: true});
  const testsCsv = join(rec, 'cam_tests.csv'), teleCsv = join(rec, 'cam_tele.csv');
  if (!existsSync(testsCsv)) appendFileSync(testsCsv, '﻿시각,번호,방식,설정장초,시간초,받은장,실제장초,첫장까지ms,장당KB,kbps,버림,실패,배터리시작,배터리끝,온도시작,온도끝,발열최고\n');
  if (!existsSync(teleCsv)) appendFileSync(teleCsv, '﻿시각,시험,방식,설정장초,배터리,배터리온도,발열,칩최고온도,칩구역,발열여유%\n');

  let no = 0, test = null, latest = null, tele = null, timer = null;
  const results = [], teleHist = [];
  const now = () => Date.now();
  const stamp = () => new Date().toLocaleString('sv-SE');

  function summary(t) {
    if (!t) return null;
    const span = t.frames > 1 ? (t.lastAt - t.firstAt) / 1000 : 0;
    return {
      no: t.no, mode: t.mode, fps: t.fps, sec: t.sec, crop: t.crop, q: t.q, kbps: t.kbps,
      frames: t.frames, real: span > 0 ? +((t.frames - 1) / span).toFixed(1) : 0,
      first: t.firstAt ? t.firstAt - t.cmdAt : null,
      kb: t.frames ? +(t.bytes / t.frames / 1024).toFixed(1) : 0,
      rate: span > 0 ? Math.round(t.bytes * 8 / span / 1000) : 0,
      drop: t.drop, fail: t.fail, w: t.w, h: t.h, why: t.why ?? null, z0: t.z0 ?? null, z1: t.z1 ?? null, zTop: t.zTop ?? null, headTop: t.headTop ?? null,
      bat0: t.bat0, bat1: t.bat1, temp0: t.temp0, temp1: t.temp1, maxTh: t.maxTh,
      elapsed: Math.round((now() - t.cmdAt) / 100) / 10, done: !!t.done,
    };
  }

  function finish() {
    clearTimeout(timer);
    if (!test || test.done) return;
    test.done = true;
    const s = summary(test);
    results.unshift(s);
    results.length = Math.min(results.length, 40);
    const c = v => (v ?? '');
    if (test.dir) setTimeout(() => movie(test, s), 3000); // 동영상 마지막 조각이 늦게 올 수 있어 잠깐 뒤에
    appendFileSync(testsCsv, [stamp(), s.no, s.mode === 'video' ? '동영상' : '사진', s.fps, s.sec || '계속', s.frames, s.real, c(s.first), s.kb, s.rate,
      s.drop, s.fail, c(s.bat0), c(s.bat1), c(s.temp0 >= 0 ? s.temp0 / 10 : ''), c(s.temp1 >= 0 ? s.temp1 / 10 : ''), c(THERMAL[s.maxTh])].join(',') + '\n');
  }

  function movie(t, s) { // 받은 장면을 쓴 사람 기준 방향의 영상.mp4 로
    const rate = Math.max(1, Math.round(s.real || t.fps));
    writeFileSync(join(t.dir, '정보.txt'), [
      `${s.no}번 시험 · ${s.mode === 'video' ? '동영상' : '사진' + (s.crop < 1 ? ' 가운데' : ' 전체')} · 설정 초당 ${s.fps}장 · ${s.sec || '끌 때까지'}${s.sec ? '초' : ''}`,
      `받은 장 ${s.frames}${s.sec ? ' / ' + s.fps * s.sec : ''} · 실제 초당 ${s.real} · 첫 장까지 ${s.first ?? '-'}ms`,
      s.mode === 'video' ? `전송량 ${s.rate}kbps · 원본 ${s.w}x${s.h}` : `장당 ${s.kb}KB · ${s.w}x${s.h}`,
      `배터리 ${s.bat0 ?? '-'}→${s.bat1 ?? '-'}% · 배터리 온도 ${s.temp0 >= 0 ? s.temp0 / 10 : '-'}→${s.temp1 >= 0 ? s.temp1 / 10 : '-'}°C · 발열 최고 ${THERMAL[s.maxTh] ?? '-'}`,
      `칩 최고 온도 ${s.z0 != null ? s.z0 / 10 : '-'}→${s.z1 != null ? s.z1 / 10 : '-'}°C(최고 ${s.zTop != null ? s.zTop / 10 : '-'}) · 발열 여유 최고 ${s.headTop ?? '-'}%`,
      `영상.mp4 는 왼쪽 90° 돌림(쓴 사람 기준), 초당 ${rate}장으로 재생`, ''].join('\r\n'));
    const video = s.mode === 'video';
    if (video ? !existsSync(join(t.dir, '원본.h264')) : !readdirSync(t.dir).some(f => f.endsWith('.jpg'))) return;
    const input = video ? ['-f', 'h264', '-r', String(rate), '-i', '원본.h264'] : ['-framerate', String(rate), '-i', '%05d.jpg'];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-vf', `${TURN},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '영상.mp4'], {cwd: t.dir});
    ff.stderr.on('data', x => console.log('[ffmpeg 저장]', String(x).trim()));
  }

  function note(q) { // 안경이 함께 보낸 배터리·발열·카운터
    const t = test;
    const bat = +q.get('bat'), temp = +q.get('temp'), th = +q.get('th');
    const zmax = q.has('zmax') ? +q.get('zmax') : -1, head = q.has('head') ? +q.get('head') : -1; // 0.2.2 앱부터
    tele = {at: now(), bat, temp, th, zmax, head, zname: q.get('zname') ?? '', mode: q.get('mode'), fps: +q.get('fps')};
    if (!t || String(t.no) !== q.get('test')) return null;
    if (t.bat0 == null && bat >= 0) { t.bat0 = bat; t.temp0 = temp; }
    if (bat >= 0) { t.bat1 = bat; t.temp1 = temp; }
    if (th >= 0) t.maxTh = Math.max(t.maxTh ?? 0, th);
    if (zmax >= 0) { if (t.z0 == null) t.z0 = zmax; t.z1 = zmax; t.zTop = Math.max(t.zTop ?? 0, zmax); }
    if (head >= 0) t.headTop = Math.max(t.headTop ?? 0, head);
    if (!t.done && (th >= STOP_TH || temp >= STOP_TEMP || head >= STOP_HEAD)) {
      t.why = th >= STOP_TH ? `발열 ${THERMAL[th]}` : head >= STOP_HEAD ? `발열 여유 ${head}%` : `온도 ${temp / 10}°C`;
      send({cmd: 'cam', fps: 0});
      finish();
      console.log('[안전 멈춤]', t.no, t.why);
    }
    t.drop = +q.get('drop') || t.drop; t.fail = +q.get('fail') || t.fail;
    return t;
  }

  function frame(t, buf, w, h) {
    const at = now();
    latest = {buf, at, n: (latest?.n ?? 0) + 1};
    queue.push(buf);
    if (!t || t.done) return;
    if (!t.firstAt) t.firstAt = at;
    t.lastAt = at;
    t.frames++;
    if (w) { t.w = w; t.h = h; }
  }

  // 실시간 화면(/cam/live.mjpg): 동영상은 0.25초 조각으로 몰려 오므로, 받은 장면을 줄 세워 초당 N장 간격으로 고르게 내보낸다.
  // 줄이 0.5초 분량보다 길어지면 오래된 장면을 버려 늦어지지 않게 한다.
  const queue = [], viewers = new Set();
  let nextOut = 0;
  setInterval(() => {
    const rate = test && !test.done ? Math.max(1, test.fps) : 30, gap = 1000 / rate, t = now();
    if (queue.length > Math.ceil(rate / 2)) queue.splice(0, queue.length - Math.ceil(rate / 2));
    if (!queue.length || t < nextOut) return;
    nextOut = Math.max(nextOut + gap, t - gap);
    const buf = queue.shift();
    for (const res of viewers) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    }
  }, 5);

  const decoders = new Map(); // 시험 번호 → ffmpeg(조각을 이어 붙여 풂)
  function decoder(key, t, w, h) {
    let d = decoders.get(key);
    if (d) { d.touch(); return d; }
    // nobuffer·low_delay 를 넣으면 장면을 버린다(150장 중 120장, 11-04 실측) → 쓰지 않음
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-probesize', '32', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1']);
    let acc = Buffer.alloc(0), idle = null, closed = false;
    ff.stdout.on('data', chunk => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        const a = acc.indexOf(SOI);
        if (a < 0) { acc = Buffer.alloc(0); break; }
        const e = acc.indexOf(EOI, a + 2);
        if (e < 0) { acc = acc.subarray(a); break; }
        frame(t, Buffer.from(acc.subarray(a, e + 2)), w, h);
        acc = acc.subarray(e + 2);
      }
    });
    ff.stderr.on('data', x => console.log('[ffmpeg]', String(x).trim()));
    ff.stdin.on('error', () => {});
    const end = () => { if (closed) return; closed = true; clearTimeout(idle); ff.stdin.end(); decoders.delete(key); };
    d = {
      write: b => { if (!closed) ff.stdin.write(b); },
      end,
      touch: () => { clearTimeout(idle); idle = setTimeout(end, 8000); }, // 조각이 끊기면 정리
    };
    d.touch();
    decoders.set(key, d);
    return d;
  }

  function body(req, limit, done) {
    const parts = [];
    let size = 0;
    req.on('data', d => { size += d.length; if (size <= limit) parts.push(d); });
    req.on('end', () => done(size <= limit ? Buffer.concat(parts) : null));
  }

  return (req, res, url) => {
    const p = url.pathname, q = url.searchParams;
    if (p === '/cam') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
      res.end(readFileSync(join(dir, 'cam.html')));
      return true;
    }
    if (p === '/cam/set') {
      finish();
      const fps = Math.max(0, Math.min(60, +q.get('fps') || 0));
      if (!fps) { send({cmd: 'cam', fps: 0}); json(res, 200, {ok: true, stop: true}); return true; }
      const cfg = {mode: q.get('mode') === 'video' ? 'video' : 'photo', fps, sec: Math.max(0, +(q.get('sec') ?? 5)),
        crop: +(q.get('crop') || 0.5), q: +(q.get('q') || 80), kbps: +(q.get('kbps') || 2000)};
      test = {no: ++no, ...cfg, cmdAt: now(), frames: 0, bytes: 0, drop: 0, fail: 0, done: false};
      const d = new Date(), z = v => String(v).padStart(2, '0');
      test.dir = join(SAVE, `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
        + `_${test.no}번_${cfg.mode === 'video' ? '동영상' : '사진'}_${cfg.fps}장`);
      mkdirSync(test.dir, {recursive: true});
      send({cmd: 'cam', ...cfg, test: test.no});
      if (cfg.sec > 0) timer = setTimeout(finish, (cfg.sec + 4) * 1000); // 안경이 늦게 시작해도 받을 여유
      json(res, 200, {ok: true, test: test.no});
      return true;
    }
    if (p === '/frame' && req.method === 'POST') { // 사진 방식: 한 장씩
      body(req, 4 << 20, buf => {
        if (!buf) return json(res, 413, {error: 'too big'});
        const t = note(q);
        if (t) t.bytes += buf.length;
        frame(t, buf, +q.get('w'), +q.get('h'));
        if (t?.dir && !t.done) writeFileSync(join(t.dir, String(t.frames).padStart(5, '0') + '.jpg'), buf);
        json(res, 200, {ok: true});
      });
      return true;
    }
    if (p === '/stream' && req.method === 'POST') { // 동영상 방식: H.264 조각(약 0.25초)을 차례로 받아 한 ffmpeg에 이어 붙인다
      // 한 줄로 길게 올리면 Cloudflare 터널이 끝까지 모았다가 넘겨(5초 뒤 한꺼번에, 11-04 실측) 조각으로 나눠 받는다.
      const t = note(q);
      const dec = decoder(q.get('test'), t, +q.get('w'), +q.get('h'));
      body(req, 8 << 20, buf => {
        if (buf) {
          if (t) t.bytes += buf.length;
          dec.write(buf);
          if (t?.dir) appendFileSync(join(t.dir, '원본.h264'), buf);
        }
        if (q.get('end') === '1') dec.end();
        json(res, 200, {ok: true});
      });
      return true;
    }
    if (p === '/tele') { // 2초마다 배터리·발열
      note(q);
      teleHist.push({...tele, test: +q.get('test')});
      if (teleHist.length > 3000) teleHist.splice(0, teleHist.length - 3000);
      appendFileSync(teleCsv, [stamp(), q.get('test'), q.get('mode'), q.get('fps'), tele.bat, tele.temp >= 0 ? tele.temp / 10 : '', THERMAL[tele.th] ?? '',
        tele.zmax >= 0 ? tele.zmax / 10 : '', tele.zname, tele.head >= 0 ? tele.head : ''].join(',') + '\n');
      json(res, 200, {ok: true});
      return true;
    }
    if (p === '/cam/live.mjpg') { // 고르게 내보내는 실시간 화면(multipart JPEG)
      res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
      viewers.add(res);
      req.on('close', () => viewers.delete(res));
      return true;
    }
    if (p === '/cam/latest.jpg') {
      if (!latest) { res.writeHead(404); res.end(); return true; }
      res.writeHead(200, {'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store'});
      res.end(latest.buf);
      return true;
    }
    if (p === '/cam/stats') {
      json(res, 200, {test: summary(test), results, tele, thermal: THERMAL, latest: latest ? {n: latest.n, at: latest.at} : null,
        teleHist: teleHist.slice(-600), files: {tests: testsCsv, tele: teleCsv}});
      return true;
    }
    return false;
  };
}
