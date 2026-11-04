// 안경 영상 서버. AI가 /play?key=a 를 부르면 연결된 안경들에 "a 영상 틀어"를 보낸다.
// 안경은 /next 로 신호를 기다리고(롱 폴링), 영상은 /v/<파일>에서 그때그때 받아 재생한다.
// SSE 대신 롱 폴링인 이유: Cloudflare 빠른 터널이 스트림 응답을 붙잡아 두어 신호가 안 갔다(11-03 실측).
//   node server/server.mjs            (PORT 기본 8787, TOKEN 을 주면 /play·/stop 에 ?token= 필요)
import http from 'node:http';
import {readFileSync, statSync, createReadStream, createWriteStream, mkdirSync} from 'node:fs';
import {join, basename, normalize, extname} from 'node:path';
import {camRoutes} from './cam.mjs';

const DIR = import.meta.dirname;
const DEMO = join(DIR, '..', 'demo'); // 2412호 3D 데모(/demo/2412/)
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json; charset=utf-8'};
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.TOKEN ?? '';
const HOLD_MS = 25000; // 신호가 없으면 이만큼 붙잡았다가 빈 답을 준다(터널 제한 100초보다 짧게)
const list = () => JSON.parse(readFileSync(join(DIR, 'videos.json'), 'utf8'));
const waiting = new Set(); // 신호를 기다리는 안경 요청
const seen = new Map();    // 안경 id → 마지막으로 물어본 시각
let seq = 0;
let now = null; // 마지막으로 보낸 신호

let cam; // 카메라 전송 시험(cam.mjs), send·json 정의 뒤에 만든다
const glasses = () => [...seen.values()].filter(t => Date.now() - t < HOLD_MS + 15000).length;

function send(msg) {
  now = {seq: ++seq, ...msg};
  for (const w of waiting) w(now);
  console.log(new Date().toLocaleTimeString('ko-KR'), JSON.stringify(now), `안경 ${glasses()}대`);
}

function json(res, code, body) {
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}

function serveVideo(req, res, file) {
  const path = join(DIR, 'videos', basename(file));
  let size;
  try { size = statSync(path).size; } catch { res.writeHead(404); return res.end(); }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (m) { // 재생기가 앞부분부터 조금씩 받아 가므로 Range 를 지원한다
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1});
    return createReadStream(path, {start, end}).pipe(res);
  }
  res.writeHead(200, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
  createReadStream(path).pipe(res);
}

const PAGE = () => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>안경 영상 신호</title><style>
body{margin:0;background:#111;color:#e8eaed;font:16px/1.5 system-ui,"Malgun Gothic",sans-serif}main{max-width:640px;margin:0 auto;padding:16px}
button{font:inherit;padding:12px 16px;margin:4px;border:0;border-radius:8px;background:#1f6f3a;color:#fff;cursor:pointer}button.stop{background:#555}
#st{color:#9aa3ad;margin:8px 0 16px}video{width:180px;background:#000;border-radius:8px}
</style></head><body><main><h1>안경 영상 신호</h1><div id="st">-</div>
${Object.entries(list()).map(([k, v]) => `<button onclick="go('${k}')">${k} · ${v.title}</button>`).join('')}
<button class="stop" onclick="fetch('stop'+q)">끄기</button>
<p><a style="color:#3dff5a" href="cam" onclick="this.href='cam'+location.search">안경 카메라 시험 →</a></p>
<p>미리보기(안경에 보내는 것과 같은 영상)</p><video id="pv" controls muted playsinline></video>
<script>const q=location.search;const L=${JSON.stringify(list())};
function go(k){fetch('play?key='+k+(q?'&'+q.slice(1):''));document.getElementById('pv').src='v/'+L[k].file;document.getElementById('pv').play();}
async function tick(){try{const s=await (await fetch('status')).json();document.getElementById('st').textContent='연결된 안경 '+s.glasses+'대 · 지금 '+(s.now?.key??'없음');}catch{}}
tick();setInterval(tick,3000);</script></main></body></html>`;

cam = camRoutes({dir: DIR, send: m => send(m), json: (res, code, body) => json(res, code, body)});

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const authed = !TOKEN || url.searchParams.get('token') === TOKEN;
  if (process.env.LOG) {
    const t0 = Date.now();
    res.on('finish', () => console.log(new Date().toLocaleTimeString('ko-KR'), req.method, req.url, res.statusCode,
      `${Date.now() - t0}ms`, req.headers.range ?? '', (req.headers['user-agent'] ?? '').slice(0, 40)));
    req.on('close', () => { if (!res.writableFinished) console.log(new Date().toLocaleTimeString('ko-KR'), '끊김', req.url, `${Date.now() - t0}ms`); });
  }

  if (p === '/cam/set' && !authed) return json(res, 403, {error: 'token'});
  if (cam(req, res, url)) return;

  // 안경: /next?id=<안경>&after=<마지막 seq>. after 없이 오면 지금 seq 만 알려 준다(켜자마자 옛 신호를 다시 틀지 않게).
  if (p === '/next') {
    seen.set(url.searchParams.get('id') ?? req.socket.remoteAddress, Date.now());
    const after = url.searchParams.get('after');
    if (after === null) return json(res, 200, {seq});
    if (now && now.seq > Number(after)) return json(res, 200, now);
    let done = false;
    const finish = msg => { if (done) return; done = true; waiting.delete(finish); clearTimeout(timer); json(res, 200, msg); };
    const timer = setTimeout(() => finish({seq}), HOLD_MS);
    waiting.add(finish);
    req.on('close', () => { if (!done) { done = true; waiting.delete(finish); clearTimeout(timer); } });
    return;
  }
  if (p === '/play') {
    if (!authed) return json(res, 403, {error: 'token'});
    const key = url.searchParams.get('key') ?? '';
    const v = list()[key];
    if (!v) return json(res, 404, {error: `없는 키: ${key}`});
    send({cmd: 'play', key, title: v.title, url: `/v/${v.file}`, loop: !!v.loop});
    return json(res, 200, {ok: true, key, glasses: glasses()});
  }
  if (p === '/stop') {
    if (!authed) return json(res, 403, {error: 'token'});
    send({cmd: 'stop'});
    return json(res, 200, {ok: true});
  }
  if (p === '/log') { // 안경 앱이 보내는 재생 상태(진단용)
    console.log(new Date().toLocaleTimeString('ko-KR'), '[안경]', url.searchParams.get('m'));
    return json(res, 200, {ok: true});
  }
  if (p === '/status') return json(res, 200, {glasses: glasses(), now});
  if (p === '/videos.json') { // 안경이 미리 받아 두도록 크기·수정시각을 붙여 준다
    const out = {};
    for (const [k, v] of Object.entries(list())) {
      try { const s = statSync(join(DIR, 'videos', basename(v.file))); out[k] = {...v, size: s.size, ver: Math.floor(s.mtimeMs)}; } catch {}
    }
    return json(res, 200, out);
  }
  if (p.startsWith('/v/')) return serveVideo(req, res, decodeURIComponent(p.slice(3)));
  if (p === '/rec' && req.method === 'POST') { // 데모 녹화 저장(이 PC에서만)
    const ip = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return json(res, 403, {error: 'local only'});
    const name = basename(url.searchParams.get('name') ?? 'rec.webm').replace(/[^\w.\-가-힣]/g, '_');
    const dir = join(DIR, '..', 'recordings');
    mkdirSync(dir, {recursive: true});
    const path = join(dir, name);
    const out = createWriteStream(path);
    req.pipe(out);
    out.on('finish', () => json(res, 200, {ok: true, path}));
    out.on('error', e => json(res, 500, {error: e.message}));
    return;
  }
  if (p === '/demo' || p.startsWith('/demo/')) {
    let rel = decodeURIComponent(p.slice(6));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(DEMO, rel));
    if (!file.startsWith(DEMO)) { res.writeHead(403); return res.end(); }
    try { statSync(file); } catch { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache'});
    return createReadStream(file).pipe(res);
  }
  if (p === '/') { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); return res.end(PAGE()); }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`안경 영상 서버 http://localhost:${PORT}`));
