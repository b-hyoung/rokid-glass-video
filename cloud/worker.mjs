import {validateVectors} from './appearance-format.mjs';
import {deviceHud} from './hud-status.mjs';
import {regionOverlap} from './region-evidence.mjs';
import {PlaybackLock} from './playback-lock.mjs';
import {validSeed} from './tracking-seed.mjs';
import {TargetStore, MAX_IMAGES} from './target-store.mjs';
import {RegistrationGuide} from './registration-guide.mjs';
import {pack,unpack,inspect,nals} from './stream-protocol.mjs';
const json = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
const DWELL_MS = 2500;
const FOCUS_RESUME_MS = 2500;
const DISPLAY_HOLD_MS = 850;
const DYNAMIC = new Set(['/status','/next','/play','/stop','/log','/frame','/stream','/tele']);
export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    if (p === '/server.txt') return new Response(url.origin+'\n',{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
    if (['/','/control','/control/','/cam','/recognition','/recognition/'].includes(p)) {
      return env.ASSETS.fetch(new Request(new URL('/cloud/index.html',url),request));
    }
    if (DYNAMIC.has(p) || p.startsWith('/cam/') || p.startsWith('/recognition/')) {
      return env.ROOM.get(env.ROOM.idFromName('glasses-main')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
const encode = bytes => {let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s)};
export class GlassRoom {
  constructor(ctx,env) {
    this.ctx=ctx;this.env=env;this.seq=Date.now();this.commands=[];this.waiters=new Set();this.seen=new Map();
    this.test=null;this.tele=null;this.latest=null;this.first=null;this.recent=[];this.bytes=0;this.frameNo=0;this.focus=null;this.focusAt=0;this.locked=null;this.lastVisible=0;this.lastResult=0;this.active=false;this.epoch=0;
    this.state={enabled:false,detections:[],progress:0,focused:null,at:0};this.version=Date.now();
    this.displayHistory=new Map();this.focusCorners=null;
    this.store=new TargetStore(ctx.storage);
    this.playback=new PlaybackLock(ctx.storage);this.rearm=false;this.deviceHud=null;this.hudDelivery=new Map();
    this.guide=new RegistrationGuide(ctx.storage);
    this.config=new Map();this.rate=[];this.logs=[];this.delivery=new Map();this.httpViewers=new Map();this.lastKeyRequestAt=0;this.keyRequests=0;
    this.traceEpoch=crypto.randomUUID();this.traceSequence=0;this.traceBuffer=new Array(4096);this.traceCount=0;
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS camera_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const saved=this.ctx.storage.sql.exec('SELECT data FROM camera_state WHERE id=1').toArray()[0];
    if(saved){try{this.test={...JSON.parse(saved.data),frames:0,segments:0};}catch{}}
    this.startedAt=Date.now();
  }
  saveCamera(){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO camera_state VALUES (1,?)',JSON.stringify(this.test))}
  trace(type,data={}){const seq=++this.traceSequence;this.traceBuffer[(seq-1)%this.traceBuffer.length]={seq,at:Date.now(),type,...data};this.traceCount=Math.min(this.traceCount+1,this.traceBuffer.length)}
  traceSince(epoch,after){const first=this.traceSequence-this.traceCount+1;const reset=epoch!==this.traceEpoch;const cursor=reset?first-1:Math.max(0,after);const events=[];for(let n=Math.max(first,cursor+1);n<=this.traceSequence;n++)events.push(this.traceBuffer[(n-1)%this.traceBuffer.length]);return {epoch:this.traceEpoch,reset,lost:!reset&&cursor<first-1,first,latest:this.traceSequence,events}}
  cameraCommand(){const {mode,fps,sec,crop,q,kbps,test,transport}=this.test;return {cmd:'cam',mode,fps,sec,crop,q,kbps,test,transport}}
  recoverCamera(){
    const now=Date.now(),t=this.test;
    if(t?.transport==='webrtc')return;
    if(!t||t.done||now-Math.max(this.startedAt,t.lastAt||t.cmdAt)<(t.lastAt?12000:30000)||![...this.seen.values()].some(at=>now-at<25000)||(t.retries||0)>=3)return;
    const cfg={...this.cameraCommand(),test:now};this.test={...cfg,frames:0,segments:0,cmdAt:now,done:false,retries:(t.retries||0)+1};
    this.config.clear();this.rate=[];this.delivery.clear();this.saveCamera();this.send(cfg);
    this.trace('camera_recovery',{previousTest:t.test,test:this.test.test,retries:this.test.retries,lastReceivedAt:t.lastAt??null});this.logs.push({at:now,message:'영상 수신 중단 감지 · 카메라 자동 재연결 '+this.test.retries});this.logs=this.logs.slice(-20);
  }
  targets(images=false){return this.store.list(images)}
  changed(){this.version=Math.max(Date.now(),this.version+1);this.reset()}
  send(data){const msg={seq:++this.seq,...data};this.commands.push(msg);if(this.commands.length>50)this.commands.shift();for(const f of [...this.waiters])f(msg);return msg}
  finishPlayback(){
    this.commands=this.commands.filter(m=>m.cmd!=='play');
    this.rearm=true;this.focus=null;this.focusAt=0;
    this.state={...this.state,focused:null,progress:0};
  }
  startPlayback(v,key,source,targetId=null){
    this.commands=this.commands.filter(m=>m.cmd!=='play');
    const media={title:v.title,url:'/v/'+v.file,loop:!!v.loop};
    const playback=this.playback.begin(source,targetId,media);
    return this.send({cmd:'play',key,...media,source,targetId,playbackId:playback.id});
  }
  hudForViewer(state){
    const playback=this.playback.current();
    if(state.mode==='playback'&&state.playbackId===playback?.id&&playback.media){
      return {...state,media:playback.media};
    }
    return state;
  }
  viewers(){return this.ctx.getWebSockets().filter(ws=>!['camera','hud-device','hud-viewer','rtc-device','rtc-viewer'].includes(ws.deserializeAttachment?.()?.role))}
  rtcSocket(role,test){
    return this.ctx.getWebSockets().find(ws=>{
      const attachment=ws.deserializeAttachment?.();
      return ws.readyState===1&&attachment?.role===role&&attachment.test===test;
    });
  }
  closeRtcSockets(){
    for(const ws of this.ctx.getWebSockets()){
      if(ws.deserializeAttachment?.()?.role?.startsWith('rtc-'))try{ws.close(1008,'Capture ended')}catch{}
    }
  }
  broadcast(msg){const s=msg instanceof ArrayBuffer?msg:JSON.stringify(msg);for(const ws of this.viewers()){try{ws.send(s)}catch{}}}
  requestKey(){
    const now=Date.now();if(now-this.lastKeyRequestAt<1000)return;
    let requested=false;for(const ws of this.ctx.getWebSockets())if(ws.deserializeAttachment?.()?.role==='camera')try{ws.send(JSON.stringify({keyframe:true}));requested=true}catch{}
    if(requested){this.lastKeyRequestAt=now;this.keyRequests++}
  }
  httpPacket(meta,bytes){const packet=new Uint8Array(pack(meta,bytes)),framed=new Uint8Array(packet.length+4);new DataView(framed.buffer).setUint32(0,packet.length);framed.set(packet,4);return framed}
  withConfig(bytes,key){
    if(!key||this.config.size!==2||nals(bytes).some(n=>(n[0]&31)===7))return bytes;
    const prefix=[...this.config.values()],out=new Uint8Array(bytes.length+prefix.reduce((n,c)=>n+c.length+4,0));let offset=0;
    for(const c of prefix){out.set([0,0,0,1],offset);out.set(c,offset+4);offset+=c.length+4}out.set(bytes,offset);return out;
  }
  relayHttp(meta,bytes,key){
    let packet;
    for(const [id,viewer] of this.httpViewers){
      if(viewer.controller.desiredSize<=0){viewer.waitingKey=true;viewer.dropped++;viewer.droppedBackpressure++;continue}
      if(viewer.waitingKey&&!key){viewer.dropped++;viewer.droppedWaitingKey++;continue}
      packet??=this.httpPacket(meta,bytes);
      try{viewer.controller.enqueue(packet);viewer.waitingKey=false}catch{this.httpViewers.delete(id)}
    }
  }
  relay(meta,bytes,key){
    let encoded,binary;
    for(const ws of this.viewers()){
      let state=this.delivery.get(ws);if(!state){state={pending:[],waitingKey:true,dropped:0,minRtt:Infinity,rtts:[],window:ws.deserializeAttachment?.()?.binary?16:12,metrics:null};this.delivery.set(ws,state)}
      // Bound data in flight to each browser, not just already-decoded pictures.
      // Otherwise a slow browser receives seconds of old video from the network.
      // Cover the measured round trip. Four packets capped normal WAN links at
      // 24fps and repeatedly discarded reference frames. Do not request extra
      // key frames on every overflow: that increases bandwidth exactly when busy.
      if(state.pending.length>=state.window){state.waitingKey=true;state.dropped++;continue}
      if(state.waitingKey&&!key){state.dropped++;continue}
      const useBinary=ws.deserializeAttachment?.()?.binary;
      if(useBinary)binary??=pack(meta,bytes);else encoded??=JSON.stringify({...meta,data:encode(bytes)});
      try{ws.send(useBinary?binary:encoded);state.pending.push({n:meta.n,at:Date.now()});state.waitingKey=false}catch{this.delivery.delete(ws)}
    }
  }
  stream(body,meta){
    if(!this.test||String(this.test.test)!==String(meta.test)||this.test.done||this.test.transport==='webrtc')return false;
    const at=Date.now(),video=meta.kind!=='jpeg',info=video?inspect(body):{frames:1};
    this.test.frames+=info.frames;this.test.segments=(this.test.segments||0)+1;this.test.transport=meta.transport;this.bytes+=body.length;
    this.test.retries=0;
    this.rate.push({at,frames:info.frames});this.rate=this.rate.filter(x=>at-x.at<2000);
    if(!this.test.firstAt)this.test.firstAt=at;this.test.lastAt=at;
    const m={kind:video?'h264':'jpeg',test:this.test.test,seg:meta.seg,fps:this.test.fps,at,sourceSentAt:Number.isFinite(meta.sentAt)?meta.sentAt:null,n:++this.frameNo,frames:info.frames,complete:true,transport:meta.transport};
    this.trace('camera_packet',{test:m.test,segment:m.seg,sourceSentAt:m.sourceSentAt,serverAt:at,frames:m.frames,bytes:body.length,transport:m.transport});
    if(video){for(const nal of nals(body)){const type=nal[0]&31;if(type===7||type===8)this.config.set(type,nal.slice())}if(body.length){body=this.withConfig(body,info.key);this.relay(m,body,info.key);this.relayHttp(m,body,info.key)}}
    else {this.latest={...m,data:encode(body)};this.broadcast(this.latest);this.relayHttp(m,body,true)}
    return true;
  }
  async videos(request){return (await this.env.ASSETS.fetch(new Request(new URL('/videos.json',request.url)))).json()}
  reset(){this.epoch++;this.focus=null;this.focusAt=0;this.focusCorners=null;this.displayHistory.clear();this.locked=null;this.lastVisible=0;this.lastResult=0;this.state={enabled:this.active,detections:[],progress:0,focused:null,locked:null,at:0}}
  note(q){if(q.has('test')&&this.test&&String(this.test.test)!==q.get('test'))return;this.tele={at:Date.now(),bat:+q.get('bat'),temp:+q.get('temp'),th:+q.get('th'),zmax:+(q.get('zmax')||-1),head:+(q.get('head')||-1),tracking:q.get('tracking')==='1',trackMs:Math.max(0,Number(q.get('trackMs'))||0),tracks:Math.max(0,Math.min(4,Number(q.get('tracks'))||0)),cap:+q.get('cap'),sent:+q.get('sent'),drop:+q.get('drop'),fail:+q.get('fail')};
    if(this.test && !this.test.done && (this.tele.th>=3||this.tele.temp>=450||this.tele.head>=100)){this.test.done=true;this.test.why='발열 자동 중지';this.saveCamera();this.send({cmd:'cam',fps:0});this.active=false;this.reset()}}
  updateMetrics(viewer,m){
    if(!m||!Number.isSafeInteger(m.seq)||m.seq<=(viewer.metrics?.seq??-1)||!['networkFps','decodedFps','displayFps','frameAgeMs'].every(k=>Number.isFinite(m[k])))return;
        viewer.metrics={seq:m.seq,visible:!!m.visible,frozen:!!m.frozen,at:Date.now()};
        for(const k of ['networkFps','decodedFps','displayFps'])viewer.metrics[k]=Math.max(0,Math.min(240,m[k]));
        for(const k of ['frameAgeMs','totalReceived','totalDecoded','totalDisplayed','displayDrops','stalePackets','recoveries','relayAgeMs','clockUncertaintyMs'])viewer.metrics[k]=Number.isFinite(m[k])?Math.max(0,m[k]):null;
        for(const k of ['queueFrames','maxFrameQueue','maxRafGap','displayWaitMs','maxDisplayWaitMs'])viewer.metrics[k]=Number.isFinite(m[k])?Math.max(0,m[k]):null;
        for(const [group,keys] of [['decoder',['submitted','output','skippedUntilKey','skippedNoConfig','segmentGaps','queueResets','pendingDiscarded','errors','maxDecodeQueue']],['playerDrops',['overflow','stale','clear']]]){
          if(m[group]&&typeof m[group]==='object')viewer.metrics[group]=Object.fromEntries(keys.filter(k=>Number.isFinite(m[group][k])).map(k=>[k,Math.max(0,m[group][k])]));
        }
  }
  async fetch(req) {
    const u=new URL(req.url),p=u.pathname,q=u.searchParams;
    if(p==='/status'){this.recoverCamera();return json({glasses:[...this.seen.values()].filter(t=>Date.now()-t<45000).length,now:this.commands.at(-1)||null,hosting:'cloudflare',viewers:this.viewers().length+this.httpViewers.size})}
    if(p==='/next'){
      this.seen.set(q.get('id')||'glasses',Date.now());
      const after=q.get('after');if(after===null){const seq=this.seq;if(this.test&&!this.test.done&&Date.now()-(this.test.lastAt||0)>3000){this.test.cmdAt=Date.now();this.saveCamera();this.send(this.cameraCommand())}return json({seq})}
      const msg=this.commands.find(m=>m.seq>+after);if(msg)return json(msg);
      return new Promise(resolve=>{let done=false;const finish=m=>{if(done)return;done=true;clearTimeout(timer);this.waiters.delete(finish);resolve(json(m))};const timer=setTimeout(()=>finish({seq:this.seq}),20000);this.waiters.add(finish);req.signal.addEventListener('abort',()=>finish({seq:this.seq}),{once:true})});
    }
    if(p==='/play') {const key=q.get('key'),v=(await this.videos(req))[key];if(!v)return json({error:'없는 영상'},404);this.startPlayback(v,key,'manual');return json({ok:true})}
    if(p==='/stop'){this.playback.stop();this.finishPlayback();this.send({cmd:'stop'});return json({ok:true})}
    if(p==='/log'){this.logs.push({at:Date.now(),message:(q.get('m')||'').slice(0,1000)});this.logs=this.logs.slice(-20);return json({ok:true})}
    if(p==='/cam/set'){
      const fps=Math.max(0,Math.min(60,+q.get('fps')||0));
      this.closeRtcSockets();
      if(!fps){this.trace('camera_stop',{test:this.test?.test??null});if(this.test){this.test.done=true;this.saveCamera()}this.send({cmd:'cam',fps:0});this.active=false;this.reset();return json({ok:true,stop:true})}
      const mode=q.get('mode')==='photo'?'photo':'video';
      const transport=mode==='video'&&q.get('transport')==='webrtc'?'webrtc':'websocket';
      const cfg={cmd:'cam',mode,fps,sec:Math.max(0,Math.min(3600,+q.get('sec')||0)),crop:1,q:80,kbps:Math.max(500,Math.min(4000,+q.get('kbps')||2000)),test:Math.max(Date.now(),(this.test?.test||0)+1),transport};
      this.test={...cfg,frames:0,cmdAt:Date.now(),done:false};this.trace('camera_start',{test:cfg.test,fps:cfg.fps,kbps:cfg.kbps,mode:cfg.mode});this.saveCamera();this.latest=null;this.first=null;this.recent=[];this.bytes=0;this.config.clear();this.rate=[];this.delivery.clear();this.reset();this.send(cfg);return json({ok:true,test:cfg.test});
    }
    if(p==='/cam/rtc'&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const test=this.test?.test, side=q.get('role');
      if(this.test?.done||this.test?.transport!=='webrtc'||String(test)!==q.get('test')||!['device','viewer'].includes(side)){
        return json({error:'WebRTC 촬영을 다시 시작하세요'},409);
      }
      const role='rtc-'+side;
      const old=this.rtcSocket(role,test);
      if(old)try{old.close(1008,'Replaced by new connection')}catch{}
      const pair=new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({role,test});
      const device=this.rtcSocket('rtc-device',test);
      const viewer=this.rtcSocket('rtc-viewer',test);
      if(device&&viewer)try{viewer.send('{"type":"ready"}')}catch{}
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(p==='/cam/upload' && req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      if(!this.test||this.test.done||this.test.transport==='webrtc'||String(this.test.test)!==q.get('test'))return json({error:'촬영을 다시 시작하세요'},409);
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({role:'camera',test:this.test.test,id:q.get('id')||'glasses'});
      this.trace('camera_socket_open',{test:this.test.test});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(p==='/cam/live'){
      const id=q.get('viewer')||crypto.randomUUID(),owner=this;
      const old=this.httpViewers.get(id);if(old)try{old.controller.close()}catch{}
      let viewer;
      const stream=new ReadableStream({start(controller){
        viewer={controller,waitingKey:true,dropped:0,droppedBackpressure:0,droppedWaitingKey:0,metrics:null};owner.httpViewers.set(id,viewer);
        controller.enqueue(owner.httpPacket({kind:'hello'},new Uint8Array()));
        if(owner.test&&!owner.test.done&&owner.config.size){const chunks=[...owner.config.values()],bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length+4,0));let offset=0;for(const c of chunks){bytes.set([0,0,0,1],offset);bytes.set(c,offset+4);offset+=c.length+4}controller.enqueue(owner.httpPacket({kind:'h264',config:true,test:owner.test.test,fps:owner.test.fps},bytes))}
        owner.requestKey();
      },cancel(){if(owner.httpViewers.get(id)===viewer)owner.httpViewers.delete(id)}},new ByteLengthQueuingStrategy({highWaterMark:128*1024}));
      req.signal.addEventListener('abort',()=>{if(this.httpViewers.get(id)===viewer)this.httpViewers.delete(id);try{viewer.controller.close()}catch{}},{once:true});
      return new Response(stream,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store, no-transform','Content-Encoding':'identity','X-Content-Type-Options':'nosniff'}});
    }
    if(p==='/cam/viewer-metrics'&&req.method==='POST'){
      const viewer=this.httpViewers.get(q.get('viewer'));if(!viewer)return json({ok:true});
      const text=await req.text();if(text.length>2048)return json({error:'metrics too large'},413);
      let m;try{m=JSON.parse(text)}catch{return json({error:'invalid metrics'},400)}
      if(m&&Number.isSafeInteger(m.seq)&&m.seq>(viewer.metrics?.seq??-1)&&['networkFps','decodedFps','displayFps','frameAgeMs'].every(k=>Number.isFinite(m[k]))){
        this.updateMetrics(viewer,m);
      }return json({ok:true});
    }
    if(p==='/cam/ws' && req.headers.get('Upgrade')?.toLowerCase()==='websocket') {
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({role:'viewer',binary:q.get('binary')==='1'});
      // Bootstrap only the codec settings. Replaying an old GOP adds seconds of delay.
      if(this.test&&!this.test.done&&this.config.size){const chunks=[...this.config.values()],bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length+4,0));let offset=0;for(const c of chunks){bytes.set([0,0,0,1],offset);bytes.set(c,offset+4);offset+=c.length+4}pair[1].send(pack({kind:'h264',config:true,test:this.test.test,fps:this.test.fps},bytes))}
      this.requestKey();
      if(this.latest&&Date.now()-this.latest.at<3000)pair[1].send(JSON.stringify(this.latest));
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if((p==='/stream'||p==='/frame')&&req.method==='POST'){
      const body=new Uint8Array(await req.arrayBuffer());if(body.length>4*1024*1024)return json({error:'too big'},413);
      // Only frames from a camera session explicitly started in this control room.
      if(!this.test||String(this.test.test)!==q.get('test')||this.test.done)return json({ok:false,stale:true});
      this.note(q);if(this.test.done)return json({ok:false,stopped:true});
      this.stream(body,{kind:p==='/stream'?'h264':'jpeg',test:q.get('test'),seg:+q.get('seg'),transport:'http'});return json({ok:true});
    }
    if(p==='/tele'){this.note(q);return json({ok:true})}
    if(p==='/cam/diagnostics'){const raw=q.get('after'),after=raw&&/^\d+$/.test(raw)?Number(raw):0;return json(this.traceSince(q.get('epoch'),Number.isSafeInteger(after)?after:0))}
    if(p==='/cam/stats'){const r=this.rate.filter(x=>Date.now()-x.at<2000),span=r.length>1?(r.at(-1).at-r[0].at)/1000:0;return json({test:this.test,keyRequests:this.keyRequests,tele:this.tele,latest:this.latest?{n:this.latest.n,at:this.latest.at}:null,bytes:this.bytes,receiveFps:span>0?Math.round(r.slice(1).reduce((n,x)=>n+x.frames,0)/span*10)/10:0,viewers:[...[...this.delivery.values()].map(x=>({media:'websocket',pending:x.pending.length,window:x.window,rtt:Number.isFinite(x.minRtt)?x.minRtt:null,dropped:x.dropped,metrics:x.metrics})),...[...this.httpViewers.values()].map(x=>({media:'http',dropped:x.dropped,droppedBackpressure:x.droppedBackpressure,droppedWaitingKey:x.droppedWaitingKey,metrics:x.metrics}))],logs:this.logs})}
    if((p==='/recognition/device'||p==='/recognition/hud')&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const role=p==='/recognition/device'?'hud-device':'hud-viewer';
      if(role==='hud-device')for(const old of this.ctx.getWebSockets())if(old.deserializeAttachment?.()?.role===role)try{old.close(1000,'New HUD session')}catch{}
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({role,seq:0});
      if(role==='hud-viewer'&&this.deviceHud&&Date.now()-this.deviceHud.at<2000){pair[1].send(JSON.stringify(this.hudForViewer(this.deviceHud)));this.hudDelivery.set(pair[1],{seq:this.deviceHud.seq,at:Date.now()})}
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(p==='/recognition/playback'&&req.method==='POST'){
      const text=await req.text();if(text.length>1024)return json({error:'too big'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'invalid playback event'},400)}
      const accepted=this.playback.event(d.id,d.event);
      if(accepted&&!this.playback.current())this.finishPlayback();
      return json({ok:true,accepted,seq:this.seq});
    }
    if(p==='/recognition/status'){
      if(q.get('hud')==='2')this.guide.device={at:Date.now(),app:String(q.get('app')||'').slice(0,20),hud:2};
      const gap=Date.now()-this.lastResult;
      if(gap>(this.focus?FOCUS_RESUME_MS:2200) && (this.state.detections.length||this.focus)){this.reset()}
      // Older glasses draw every detection's four corners as an outline.
      const forGlasses=q.get('hud')==='2';
      const detections=forGlasses
        ?this.state.detections.filter(target=>!target.approximate&&!target.provisional)
        :this.state.detections;
      return json({...this.state,detections,focusMissing:this.state.focusMissing||!!this.focus&&gap>750,dwellMs:DWELL_MS,epoch:this.epoch,version:this.version,targets:this.targets(),source:'glasses',playback:this.playback.current(),deviceHud:this.deviceHud&&Date.now()-this.deviceHud.at<2000?this.deviceHud:null,serverNow:Date.now(),guide:this.guide.read()});
    }
    if(p==='/recognition/guide'){
      if(req.method==='GET')return json(this.guide.read());
      if(req.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
      try{const text=await req.text();if(text.length>4096)throw Error('가이드 설정이 너무 큽니다.');const d=JSON.parse(text);const before=this.guide.read().enabled;const guide=this.guide.update(d);if(guide.enabled&&!before){this.active=false;this.reset()}return json(guide)}catch(e){return json({error:e.message},400)}
    }
    if(p==='/recognition/images/batch'&&req.method==='POST'){
      try{
        const text=await req.text();if(text.length>8*1024*1024)throw Error('한 번에 저장할 이미지 용량이 너무 큽니다.');const d=JSON.parse(text);
        if(!Array.isArray(d.images)||!d.images.length||d.images.length>MAX_IMAGES)throw Error('저장할 이미지를 1~60장 선택하세요.');
        if(typeof d.batchId!=='string'||d.batchId.length<8||d.batchId.length>80)throw Error('잘못된 등록 묶음입니다.');
        if(!d.targetId&&(typeof d.name!=='string'||!d.name.trim()||!(await this.videos(req))[d.key]))throw Error('대상 이름과 연결 영상을 선택하세요.');
        const images=d.images.map(item=>{
          if(typeof item.image!=='string'||item.image.length>700000||!/^data:image\/jpeg;base64,/.test(item.image))throw Error('선택한 장면의 이미지가 필요합니다.');
          const raw=item.capture||{},capture=raw.source==='photo'
            ?{source:'photo',filename:String(raw.filename||'').slice(0,255)}
            :{source:'video',atMs:Math.max(0,Math.min(120000,Number(raw.atMs)||0)),sharpness:Math.max(0,Math.min(1e6,Number(raw.sharpness)||0)),features:Math.max(0,Math.min(10000,Number(raw.features)||0))};
          return {image:item.image,capture};
        });
        const result=this.store.addBatch({targetId:d.targetId,name:d.name?.trim().slice(0,60),key:d.key,images,batchId:d.batchId});this.changed();return json(result);
      }catch(e){return json({error:e.message},400)}
    }
    if (p === '/recognition/vectors' && req.method === 'POST') {
      try {
        const text = await req.text();
        if (text.length > 8*1024*1024) return json({error:'등록 묶음이 너무 큽니다.'}, 413);
        const {targetId, name, key, pack, images=[]} = JSON.parse(text);
        if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(image =>
          typeof image !== 'string' || image.length > 700000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image))) {
          throw Error('등록 사진 형식이나 용량을 확인하세요.');
        }
        if (!targetId && (typeof name !== 'string' || !name.trim() ||
            !Object.hasOwn(await this.videos(req), key))) {
          throw Error('대상 이름과 연결 영상을 선택하세요.');
        }
        const id = this.store.saveVectors({targetId, name:name?.trim().slice(0,60), key, pack:validateVectors(pack), images});
        this.changed();
        return json({ok:true, targetId:id});
      } catch (error) { return json({error:error.message}, 400); }
    }
    if (p === '/recognition/vectors' && req.method === 'DELETE') {
      this.store.deleteVectors(q.get('targetId'));
      this.changed();
      return json({ok:true});
    }
    if(p==='/recognition/targets'&&req.method==='GET')return json({version:this.version,maxImages:MAX_IMAGES,targets:this.targets(true)});
    if((p==='/recognition/targets'||p==='/recognition/images')&&req.method==='POST'){
      const text=await req.text();if(text.length>700000)return json({error:'등록 이미지를 더 작게 선택하세요'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'잘못된 등록 요청'},400)}
      if(!/^data:image\/jpeg;base64,/.test(d.image||''))return json({error:'선택한 영역의 이미지가 필요합니다.'},400);
      try {
        let targetId=d.targetId, imageId;
        if(p==='/recognition/targets'){
          if(typeof d.name!=='string'||!d.name.trim()||!(await this.videos(req))[d.key])return json({error:'대상 이름과 연결할 영상이 필요합니다.'},400);
          targetId=this.store.create(d.name.trim().slice(0,60),d.key,d.image);
        } else imageId=this.store.addImage(targetId,d.image);
        this.changed();return json({ok:true,targetId,imageId});
      } catch(e){return json({error:e.message},400)}
    }
    if(p==='/recognition/targets'&&req.method==='DELETE'){this.store.deleteTarget(q.get('id'));this.changed();return json({ok:true})}
    if(p==='/recognition/images'&&req.method==='DELETE'){this.store.deleteImage(q.get('targetId'),q.get('id'));this.changed();return json({ok:true})}
    if(p==='/recognition/control'&&req.method==='POST'){if(q.get('enabled')==='1'&&this.guide.read().enabled)return json({error:'등록 가이드를 끈 뒤 인식을 시작하세요.'},409);this.active=q.get('enabled')==='1';this.reset();return json({ok:true})}
    if(p==='/recognition/detections'&&req.method==='POST'){
      const text=await req.text();if(text.length>60000)return json({error:'too big'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'invalid detections'},400)}
      const now=Date.now();if(!Number.isFinite(d.at)||this.guide.read().enabled||!this.active||d.epoch!==this.epoch||d.at<(this.state.frameAt||0)||now-d.at>1500||d.at>now+500)return json({ok:false,stale:true});
      const elapsed=this.lastResult?now-this.lastResult:0;
      if(elapsed>FOCUS_RESUME_MS){this.focus=null;this.focusAt=0;this.focusCorners=null}
      const targets=this.targets();
      const found=(Array.isArray(d.found)?d.found:[]).slice(0,12).flatMap(f=>{
        const t=targets.find(t=>t.id===f?.id);
        if(!t?.imageCount||(t.hasVectors&&f.appearanceConfirmed!==true))return [];
        if(!Array.isArray(f.corners)||f.corners.length!==4||!f.corners.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=-.5&&n<=1.5)))return [];
        const matchedAt=Number.isFinite(f.matchedAt)?Math.min(f.matchedAt,d.at):d.at;
        const approximate=f.approximate===true;
        const provisional=f.provisional===true;
        if(approximate&&(!t.hasVectors||now-matchedAt>1100))return [];
        if(provisional&&(!t.hasVectors||now-matchedAt>1100))return [];
        const xs=f.corners.map(p=>p[0]),ys=f.corners.map(p=>p[1]);
        const bounds={left:Math.max(0,Math.min(...xs)),right:Math.min(1,Math.max(...xs)),
          top:Math.max(0,Math.min(...ys)),bottom:Math.min(1,Math.max(...ys))};
        if(bounds.left>=bounds.right||bounds.top>=bounds.bottom)return [];
        const held=provisional||f.held===true;
        const trackId=typeof f.trackId==='string'&&f.trackId.length<=80?f.trackId:'';
        return [{...t,trackId,corners:f.corners,bounds,inliers:approximate?0:Number(f.inliers)||0,matchedAt,
          approximate,provisional,held,seed:approximate||held?null:validSeed(f.seed)}];
      });
      const unique=new Map();for(const f of found){if(!unique.has(f.id)||unique.get(f.id).inliers<f.inliers)unique.set(f.id,f)}found.splice(0,found.length,...unique.values());
      // Retain only previously confirmed boxes, without refreshing their age.
      // A moving camera or conflicting identity clears the remembered box.
      const observed=found.filter(target=>!target.held&&!target.approximate);
      const contradicted=previous=>observed.some(target=>target.id!==previous.id&&regionOverlap(target.corners,previous.corners)>.28);
      for(let i=found.length-1;i>=0;i--)if(found[i].held&&contradicted(found[i]))found.splice(i,1);
      for(const [id,previous] of this.displayHistory){
        if(now-previous.at>DISPLAY_HOLD_MS||d.sceneStable!==true||contradicted(previous.target)){
          this.displayHistory.delete(id);
        }else if(!unique.has(id)&&found.length<12){
          found.push({...previous.target,held:true,seed:null});
        }
      }
      for(const target of observed)this.displayHistory.set(target.id,{at:now,target});
      const guide=this.guide.read(),aim=guide.calibrated?guide.camera:{cx:.5,cy:.5};
      const inside=({bounds:b})=>aim.cx>=b.left&&aim.cx<=b.right&&aim.cy>=b.top&&aim.cy<=b.bottom;
      const near=({bounds:b})=>{
        const dx=Math.min(.015,(b.right-b.left)*.12),dy=Math.min(.015,(b.bottom-b.top)*.12);
        return aim.cx>=b.left-dx&&aim.cx<=b.right+dx&&aim.cy>=b.top-dy&&aim.cy<=b.bottom+dy;
      };
      const localized=found.filter(t=>!t.approximate);
      const focusedTrack = localized.find(t=>t.id===this.focus);
      const liveTargets=now-d.at<=750?localized.filter(t=>!t.held):[];
      const aimAt=d.aimMatch?.at;
      const aimTarget=Number.isFinite(aimAt)&&aimAt<=d.at&&now-aimAt<1200
        ? targets.find(t=>t.id===d.aimMatch.id&&t.hasVectors&&t.imageCount&&!localized.some(match=>match.id===t.id))
        : null;
      const choice = focusedTrack&&liveTargets.includes(focusedTrack)&&inside(focusedTrack)
        ? focusedTrack
        : liveTargets.filter(inside).sort((a,b)=>b.inliers-a.inliers)[0]??null;
      if(this.locked&&(aimTarget?.id===this.locked||localized.some(f=>f.id===this.locked)))this.lastVisible=now;
      if(this.locked&&now-this.lastVisible>2000)this.locked=null;
      const busy=!!this.playback.current();
      if(this.rearm&&!choice&&!localized.some(inside))this.rearm=false;
      if(busy||this.rearm){this.focus=null;this.focusAt=now}
      const resuming=this.state.focusMissing||elapsed>750;
      const trackChanged=choice?.trackId&&this.state.focusTrackId&&choice.trackId!==this.state.focusTrackId;
      const sameFocus=!!this.focus&&choice?.id===this.focus&&!trackChanged&&(!resuming||
        (!!this.focusCorners&&(!this.state.focusMissingAt||now-this.state.focusMissingAt<=FOCUS_RESUME_MS)&&
          regionOverlap(this.focusCorners,choice.corners)>=.25));
      if(!busy&&!this.rearm&&choice&&!sameFocus){this.focus=choice.id;this.focusAt=now}
      let progress=0;
      let focusMissingAt=0;
      if(!busy&&!this.rearm&&this.focus&&this.focus!==this.locked){
        if(choice){
          if(sameFocus&&resuming){
            // Credit only a bounded fresh observation, not the missing interval.
            const observedMs=Math.min(150,Math.max(0,d.at-(this.state.frameAt||d.at)),elapsed);
            this.focusAt=now-this.state.progress*DWELL_MS-observedMs;
          }
          else if(sameFocus&&elapsed>350)this.focusAt+=elapsed-350;
          progress=Math.min(1,(now-this.focusAt)/DWELL_MS);
          this.focusCorners=choice.corners;
        }else{
          focusMissingAt=this.state.focusMissingAt || this.lastResult || now;
          // Near-edge jitter can pause dwell, but only a live box containing
          // the aim can advance it. A clear exit ends the attempt.
          const outside=focusedTrack&&liveTargets.includes(focusedTrack)&&!near(focusedTrack);
          progress=outside||now-focusMissingAt>FOCUS_RESUME_MS?0:this.state.progress;
          this.focusAt=now-progress*DWELL_MS;
          if(outside||now-focusMissingAt>FOCUS_RESUME_MS)this.focus=null;
        }
      }
      if(choice&&progress>=1&&now-d.at<=750&&now-choice.matchedAt<1200){
        const revision=this.playback.revision,epoch=this.epoch,focus=this.focus;
        const v=(await this.videos(req))[choice.key];
        if(v&&revision===this.playback.revision&&epoch===this.epoch&&focus===this.focus&&!this.playback.current()&&!this.rearm){this.startPlayback(v,choice.key,'recognition',choice.id);this.locked=choice.id;this.lastVisible=now}
      }
      if(!this.active||this.epoch!==d.epoch)return json({ok:false,stale:true});
      const focusStartedAt=this.focus?(sameFocus||!choice?this.state.focusStartedAt:now):0;
      const focusMissing=!!this.focus&&!choice;
      const focusExpiresAt=this.focus?(focusMissing?focusMissingAt:now)+FOCUS_RESUME_MS:0;
      const focusTrackId=this.focus?(choice?.trackId||this.state.focusTrackId||''):'';
      const focusReason=busy?'playback':this.rearm?'rearm':now-d.at>750?'frame_delayed':
        choice?'observed':focusedTrack?.held?'tracking_paused':focusedTrack?'aim_outside':
        found.length?'no_centered_target':'no_detections';
      if(focusReason!==this.state.focusReason)this.trace('recognition_focus',{reason:focusReason,
        focused:this.focus,progress,frameAgeMs:Math.max(0,now-d.at),detections:found.length});
      this.lastResult=now;this.state={enabled:true,detections:found,aimTarget:aimTarget?.name??null,progress,focused:this.focus,
        focusTrackId,focusReason,focusMode:this.focus?(focusMissing?'paused':'advancing'):'idle',focusExpiresAt,
        focusStartedAt,focusMissing,focusMissingAt:this.focus?focusMissingAt:0,locked:this.locked,frameAt:d.at,at:now};
      if(d.preview===true){
        const detections=found.map(({id,trackId,name,corners,bounds,approximate,provisional,held})=>({id,trackId,name,corners,bounds,approximate,provisional,held}));
        return json({ok:true,preview:{...this.state,detections,epoch:this.epoch}});
      }
      return json({ok:true});
    }
    return json({error:'없는 요청'},404);
  }
  webSocketMessage(ws,message){
    const camera=ws.deserializeAttachment?.();
    if(camera?.role==='rtc-device'||camera?.role==='rtc-viewer'){
      if(this.test?.done||this.test?.transport!=='webrtc'||camera.test!==this.test.test)return;
      if(typeof message!=='string'||message.length>32768||this.rtcSocket(camera.role,camera.test)!==ws)return;
      try{
        const signal=JSON.parse(message);
        const device=camera.role==='rtc-device';
        const description=signal.type===(device?'answer':'offer')&&typeof signal.sdp==='string'&&
          typeof signal.id==='string'&&signal.id.length<=64;
        const error=device&&signal.type==='error'&&typeof signal.message==='string'&&signal.message.length<=512;
        if(description||error)this.rtcSocket(device?'rtc-viewer':'rtc-device',camera.test)?.send(message);
      }catch{}
      return;
    }
    if(camera?.role==='hud-viewer'){
      if(typeof message==='string'&&message.length<100)try{const {ack}=JSON.parse(message);if(this.hudDelivery.get(ws)?.seq===ack)this.hudDelivery.delete(ws)}catch{}
      return;
    }
    if(camera?.role==='hud-device'){
      if(typeof message!=='string'||message.length>8192)return;
      try{
        const state=deviceHud(JSON.parse(message),this.targets());if(!state||state.seq<=camera.seq)return;
        camera.seq=state.seq;ws.serializeAttachment(camera);this.deviceHud=state;
        ws.send(JSON.stringify({ack:state.seq}));
        const payload=JSON.stringify(this.hudForViewer(state));
        for(const viewer of this.ctx.getWebSockets())if(viewer.deserializeAttachment?.()?.role==='hud-viewer'){
          const pending=this.hudDelivery.get(viewer);
          if(pending){if(Date.now()-pending.at>2000){try{viewer.close(1000,'Resume latest HUD')}catch{}this.hudDelivery.delete(viewer)}continue;}
          try{viewer.send(payload);this.hudDelivery.set(viewer,{seq:state.seq,at:Date.now()})}catch{this.hudDelivery.delete(viewer)}
        }
      }catch{}return;
    }
    if(camera?.role==='viewer'&&typeof message==='string'){
      try{const m=JSON.parse(message),{ack,metrics}=m,state=this.delivery.get(ws);
        if(Number.isSafeInteger(m.ping))ws.send(JSON.stringify({pong:m.ping,serverNow:Date.now()}));
        if(m.keyframe)this.requestKey();
        if(state){
          if(Number.isSafeInteger(ack)){
            const packet=state.pending.find(x=>x.n===ack);
            if(packet){const rtt=Date.now()-packet.at;state.minRtt=Math.min(state.minRtt,rtt);
              if(camera.binary){state.rtts??=[];state.rtts.push(rtt);state.rtts=state.rtts.slice(-30);const sorted=[...state.rtts].sort((a,b)=>a-b),p90=sorted[Math.floor((sorted.length-1)*.9)];state.window=Math.max(16,Math.min(32,Math.ceil(p90/100)+6))}
              else state.window=Math.max(8,Math.min(24,Math.ceil(state.minRtt/100)+4));
            }
            state.pending=state.pending.filter(x=>x.n>ack);
          }
          if(metrics){if(Number.isSafeInteger(metrics.seq))this.updateMetrics(state,metrics);else if(['decodedFps','displayFps','frameAgeMs'].every(k=>Number.isFinite(metrics[k])))state.metrics={at:Date.now(),...metrics}}
        }
      }catch{}return;
    }

    if(camera?.role!=='camera'||typeof message==='string')return;
    try{const {meta,bytes}=unpack(message);if(meta.test!==camera.test||!Number.isSafeInteger(meta.seg))throw Error('Invalid camera session');
      if(!this.stream(bytes,{...meta,kind:'h264',transport:'websocket'})){ws.close(1008,'Start a new capture');return}
      this.seen.set(camera.id,Date.now());ws.send(JSON.stringify({ack:meta.seg,sentAt:meta.sentAt}));
    }catch{ws.close(1008,'Invalid stream packet')}
  }
  webSocketClose(ws,code,reason){
    const attachment=ws.deserializeAttachment?.();if(attachment?.role==='camera')this.trace('camera_socket_close',{test:attachment.test,code,reason:String(reason||'').slice(0,120)});
    if(attachment?.role==='rtc-viewer'&&!this.rtcSocket('rtc-viewer',attachment.test)){
      try{this.rtcSocket('rtc-device',attachment.test)?.send('{"type":"viewer-left"}')}catch{}
    }
    this.delivery.delete(ws);this.hudDelivery.delete(ws);
    // 1005/1006/1015 are local event codes, never valid codes for a close frame.
    // Echoing them threw before the close reply, leaving browsers waiting ~30s.
    const sendable=code>=1000&&code<=1014&&![1004,1005,1006].includes(code)||code>=3000&&code<=4999;
    try{ws.close(sendable?code:1000,reason)}catch{try{ws.close(1000,'')}catch{}}
  }
  webSocketError(ws){const attachment=ws.deserializeAttachment?.();if(attachment?.role==='camera')this.trace('camera_socket_error',{test:attachment.test});this.delivery.delete(ws);try{ws.close(1011,'stream error')}catch{}}
}
