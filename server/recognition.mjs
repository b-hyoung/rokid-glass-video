import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

export function recognition({dir, send, list, json}) {
  const folder = join(dir, 'targets'), catalog = join(folder, 'targets.json');
  mkdirSync(folder, {recursive: true});
  let targets = [];
  try { targets = JSON.parse(readFileSync(catalog)); } catch {}
  let child = null, busy = false, serial = 0, epoch = 0, active = false, source = 'glasses';
  let status = {enabled: false, detections: [], progress: 0, focused: null, error: null, at: 0};
  let focus = null, focusAt = 0, locked = null, lostAt = 0, lastSubmit = 0, lastResult = 0;
  const dwell = 1500;
  function reset() { epoch++; focus = null; focusAt = 0; locked = null; lostAt = 0; status = {...status, detections: [], progress: 0, focused: null, at: 0}; }
  function save() { writeFileSync(catalog, JSON.stringify(targets, null, 2)); }
  function worker() {
    if (child) return child;
    const localPython = join(dir, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const p = spawn(process.env.VISION_PYTHON || (existsSync(localPython) ? localPython : 'python3'), ['-u', join(dir, 'recognize.py')]);
    child = p;
    p.stdin.on('error', () => { busy=false; });
    p.on('error', e => { status.error = '인식 엔진 실행 실패: ' + e.message; busy = false; child = null; });
    p.stderr.on('data', b => { status.error = String(b).trim().slice(-500); });
    p.on('exit', () => { if (child === p) child = null; busy = false; if (active && !status.error) status.error = '인식 엔진이 종료됐습니다. Python OpenCV 설치를 확인하세요.'; });
    createInterface({input: p.stdout}).on('line', line => {
      busy = false;
      let result; try { result = JSON.parse(line); } catch { return; }
      if (result.error) { status.error = result.error; return; }
      if (!active || result.id !== serial || result.epoch !== epoch) return;
      status.error = null;
      lastResult = Date.now();
      const detected = result.found.filter(d => targets.some(t => t.id === d.id));
      // Center is inside the convex quadrilateral, rather than just its bounding box.
      const inside = d => { const p = d.corners; let sign = 0; for (let i=0;i<4;i++) { const a=p[i], b=p[(i+1)%4]; const c=(b[0]-a[0])*(.5-a[1])-(b[1]-a[1])*(.5-a[0]); if (Math.abs(c)<1e-8) continue; const s=Math.sign(c); if (sign && s!==sign) return false; sign=s; } return true; };
      const choice = detected.filter(inside).sort((a,b) => b.inliers-a.inliers)[0];
      const now = Date.now();
      if (locked && !detected.some(d => d.id === locked)) { if (!lostAt) lostAt=now; if (now-lostAt > 2000) { locked=null; lostAt=0; } } else lostAt=0;
      if (!choice || choice.id !== focus) { focus = choice?.id ?? null; focusAt = now; }
      const progress = choice && choice.id !== locked ? Math.min(1, (now-focusAt)/dwell) : 0;
      if (choice && progress >= 1 && choice.id !== locked) {
        const v = list()[choice.key];
        if (v) { send({cmd:'play', key:choice.key, title:v.title, url:`/v/${v.file}`, loop:!!v.loop}); locked = choice.id; }
      }
      status = {enabled: active, source, detections: detected, focused: focus, progress, locked, error:null, at:now};
    });
    return p;
  }
  function submit(buf, rotate, from) {
    if (!active || source !== from || busy || !targets.length || Date.now()-lastSubmit < 250 || buf.length > 4*1024*1024) return;
    lastSubmit = Date.now(); busy=true;
    const p=worker();
    const id=++serial;
    const payload={id, epoch, rotate, frame:buf.toString('base64'), targets:targets.map(t=>({...t,path:join(folder,t.id+'.jpg')}))};
    p.stdin.write(JSON.stringify(payload)+'\n');
  }
  setInterval(() => { if (active && lastResult && Date.now()-lastResult > 2200 && status.detections.length) { focus=null; focusAt=0; locked=null; lostAt=0; status={...status,detections:[],focused:null,progress:0,locked:null,at:0}; } }, 500).unref();
  function body(req, limit, cb) { let n=0, parts=[]; req.on('data', b => { n+=b.length; if(n<=limit) parts.push(b); }); req.on('end',()=>cb(n<=limit?Buffer.concat(parts):null)); }
  function route(req,res,url,authed) {
    const p=url.pathname;
    if (p === '/recognition/status') { json(res,200,{...status, targets}); return true; }
    if (!p.startsWith('/recognition/')) return false;
    if (!authed) { json(res,403,{error:'token'}); return true; }
    if (p === '/recognition/control' && req.method === 'POST') {
      active=url.searchParams.get('enabled')==='1'; source=url.searchParams.get('source')==='video'?'video':'glasses'; reset(); status.enabled=active; status.source=source; status.error=null; if(active) worker(); json(res,200,{ok:true}); return true;
    }
    if (p === '/recognition/frame' && req.method === 'POST') { body(req,4*1024*1024,b=>{ if(!b) return json(res,413,{error:'이미지가 너무 큽니다'}); submit(b,false,'video'); json(res,200,{ok:true}); }); return true; }
    if (p === '/recognition/targets' && req.method === 'POST') { body(req,4*1024*1024,b=>{ try {
      const data=JSON.parse(b?.toString() ?? ''); const name=String(data.name ?? '').trim().slice(0,60), key=String(data.key ?? '');
      if(!name || !list()[key] || !/^data:image\/jpeg;base64,/.test(data.image ?? '')) throw Error('이름, 영상과 JPEG 이미지가 필요합니다');
      const image=Buffer.from(data.image.split(',')[1],'base64'); if(image.length<100 || image.length>2*1024*1024 || image[0]!==255 || image[1]!==216) throw Error('올바른 JPEG 이미지가 필요합니다');
      const id=randomUUID(); writeFileSync(join(folder,id+'.jpg'),image); targets.push({id,name,key}); save(); reset(); json(res,200,{ok:true});
    } catch(e) { json(res,400,{error:e.message}); } }); return true; }
    if (p === '/recognition/targets' && req.method === 'DELETE') { const id=url.searchParams.get('id'); if(!targets.some(t=>t.id===id)) { json(res,404,{error:'대상 없음'}); return true; } targets=targets.filter(t=>t.id!==id); const f=join(folder,id+'.jpg'); if(existsSync(f)) unlinkSync(f); save(); reset(); json(res,200,{ok:true}); return true; }
    json(res,404,{error:'없는 요청'}); return true;
  }
  return {route, frame: buf=>submit(buf,true,'glasses')};
}
