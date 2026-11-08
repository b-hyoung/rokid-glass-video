import {json} from '../request-policy.mjs';
import {pack,inspect,nals} from '../stream-protocol.mjs';

export async function handleConnection(req,u){
  const p=u.pathname,q=u.searchParams;
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
      pair[1].serializeAttachment({expiresAt:Number(req.headers.get('X-Glass-Expires'))||null,deviceId:req.headers.get('X-Glass-Device'),role,test});
      const device=this.rtcSocket('rtc-device',test);
      const viewer=this.rtcSocket('rtc-viewer',test);
      if(device&&viewer)try{viewer.send('{"type":"ready"}')}catch{}
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(p==='/cam/upload' && req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      if(!this.test||this.test.done||this.test.transport==='webrtc'||String(this.test.test)!==q.get('test'))return json({error:'촬영을 다시 시작하세요'},409);
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({expiresAt:Number(req.headers.get('X-Glass-Expires'))||null,deviceId:req.headers.get('X-Glass-Device'),role:'camera',test:this.test.test,id:q.get('id')||'glasses'});
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
      pair[1].serializeAttachment({expiresAt:Number(req.headers.get('X-Glass-Expires'))||null,deviceId:req.headers.get('X-Glass-Device'),role:'viewer',binary:q.get('binary')==='1'});
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
}
