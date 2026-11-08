import {deviceHud} from './hud-status.mjs';
import {PlaybackLock} from './playback-lock.mjs';
import {TargetStore} from './target-store.mjs';
import {RegistrationGuide} from './registration-guide.mjs';
import {pack,unpack,inspect,nals} from './stream-protocol.mjs';
import {json} from './request-policy.mjs';
import {handleConnection} from './handlers/connection.mjs';
import {handleHud} from './handlers/hud.mjs';
import {handleLibrary} from './handlers/library.mjs';
import {handleRecognition} from './handlers/recognition.mjs';
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
  changed(){this.store.invalidate();this.version=Math.max(Date.now(),this.version+1);this.reset()}
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
    for(const handler of [handleConnection,handleHud,handleLibrary,handleRecognition]){
      const response=await handler.call(this,req,u);
      if(response)return response;
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
