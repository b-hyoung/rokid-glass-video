// 안경 카메라 전송 시험(서버 쪽). 웹 /cam 에서 버튼 → /cam/set → 안경에 {"cmd":"cam"} 신호 →
// 안경이 사진(/frame) 또는 동영상(/stream, ffmpeg로 풂)과 배터리·발열(/tele)을 보낸다.
// 시험마다 "설정 초당 N장 → 실제로 받은 장 수"를 recordings/cam_tests.csv, 2초마다 상태를 cam_tele.csv 에 남긴다.
import {spawn} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const THERMAL = ['정상', '약간', '보통', '심함', '위험', '비상', '꺼짐'];

export function camRoutes({dir, send, json}) {
  const rec = join(dir, '..', 'recordings');
  mkdirSync(rec, {recursive: true});
  const testsCsv = join(rec, 'cam_tests.csv'), teleCsv = join(rec, 'cam_tele.csv');
  if (!existsSync(testsCsv)) appendFileSync(testsCsv, '﻿시각,번호,방식,설정장초,시간초,받은장,실제장초,첫장까지ms,장당KB,kbps,버림,실패,배터리시작,배터리끝,온도시작,온도끝,발열최고\n');
  if (!existsSync(teleCsv)) appendFileSync(teleCsv, '﻿시각,시험,방식,설정장초,배터리,온도,발열\n');

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
      drop: t.drop, fail: t.fail, w: t.w, h: t.h,
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
    appendFileSync(testsCsv, [stamp(), s.no, s.mode === 'video' ? '동영상' : '사진', s.fps, s.sec || '계속', s.frames, s.real, c(s.first), s.kb, s.rate,
      s.drop, s.fail, c(s.bat0), c(s.bat1), c(s.temp0 >= 0 ? s.temp0 / 10 : ''), c(s.temp1 >= 0 ? s.temp1 / 10 : ''), c(THERMAL[s.maxTh])].join(',') + '\n');
  }

  function note(q) { // 안경이 함께 보낸 배터리·발열·카운터
    const t = test;
    const bat = +q.get('bat'), temp = +q.get('temp'), th = +q.get('th');
    tele = {at: now(), bat, temp, th, mode: q.get('mode'), fps: +q.get('fps')};
    if (!t || String(t.no) !== q.get('test')) return null;
    if (t.bat0 == null && bat >= 0) { t.bat0 = bat; t.temp0 = temp; }
    if (bat >= 0) { t.bat1 = bat; t.temp1 = temp; }
    if (th >= 0) t.maxTh = Math.max(t.maxTh ?? 0, th);
    t.drop = +q.get('drop') || t.drop; t.fail = +q.get('fail') || t.fail;
    return t;
  }

  function frame(t, buf, w, h) {
    const at = now();
    latest = {buf, at, n: (latest?.n ?? 0) + 1};
    if (!t || t.done) return;
    if (!t.firstAt) t.firstAt = at;
    t.lastAt = at;
    t.frames++;
    if (w) { t.w = w; t.h = h; }
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
        json(res, 200, {ok: true});
      });
      return true;
    }
    if (p === '/stream' && req.method === 'POST') { // 동영상 방식: H.264 한 줄 → ffmpeg로 풀어 장면마다 센다
      const t = note(q);
      // nobuffer·low_delay 를 넣으면 장면을 버린다(150장 중 120장, 11-04 실측) → 쓰지 않음
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-probesize', '32', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1']);
      let acc = Buffer.alloc(0);
      ff.stdout.on('data', d => {
        acc = Buffer.concat([acc, d]);
        for (;;) {
          const s = acc.indexOf(SOI);
          if (s < 0) { acc = Buffer.alloc(0); break; }
          const e = acc.indexOf(EOI, s + 2);
          if (e < 0) { acc = acc.subarray(s); break; }
          frame(t, Buffer.from(acc.subarray(s, e + 2)), +q.get('w'), +q.get('h'));
          acc = acc.subarray(e + 2);
        }
      });
      ff.stderr.on('data', d => console.log('[ffmpeg]', String(d).trim()));
      ff.stdin.on('error', () => {});
      req.on('data', d => { if (t) t.bytes += d.length; ff.stdin.write(d); });
      req.on('end', () => { ff.stdin.end(); json(res, 200, {ok: true}); });
      req.on('close', () => ff.stdin.end());
      return true;
    }
    if (p === '/tele') { // 2초마다 배터리·발열
      note(q);
      teleHist.push({...tele, test: +q.get('test')});
      if (teleHist.length > 3000) teleHist.splice(0, teleHist.length - 3000);
      appendFileSync(teleCsv, [stamp(), q.get('test'), q.get('mode'), q.get('fps'), tele.bat, tele.temp >= 0 ? tele.temp / 10 : '', THERMAL[tele.th] ?? ''].join(',') + '\n');
      json(res, 200, {ok: true});
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
