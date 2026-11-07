// One read-only camera subscription and decoder; compare display policies on identical frames.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('node:fs');
const replay=process.argv.includes('--replay'),base=replay?'https://rokid-delivery-check.youqlrqod.workers.dev':'https://glass-2412.youqlrqod.workers.dev';
const http=process.argv.includes('--http');
const kbps=Number(process.env.CHECK_KBPS||500),fixture=process.env.CHECK_FIXTURE||'/private/tmp/rokid-500kbps.h264';
const {spawn}=require('node:child_process');
(async()=>{
  const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage();
  let source;
  try {
    await page.exposeFunction('startFixture',async()=>{
      if(!replay)return;
      const cfg=await(await fetch(base+'/cam/set?mode=video&fps=60&kbps='+kbps,{signal:AbortSignal.timeout(10000)})).json();
      source=spawn('java',['-cp','/private/tmp/rokid-live-check:build/deps/*:build/test-deps/*','com.hoonartis.glassvideo.LiveSocketCheck',base,String(cfg.test),fixture,'650']);
      source.stderr.on('data',d=>process.stderr.write(d));source.stdout.on('data',d=>process.stdout.write(d));
    });
    await page.route(base+'/player-diagnostic',r=>r.fulfill({contentType:'text/html',body:'<canvas width="480" height="270"></canvas>'}));
    await page.goto(base+'/player-diagnostic');
    page.on('console',m=>{if(m.text().startsWith('PLAYERS '))console.log(m.text())});
    const result=await page.evaluate(async({http})=>{
      const [{GlassDecoder},{FramePlayer},{LiveTiming},{unpack},{readVideo}]=await Promise.all([import('/cloud/decoder.js'),import('/cloud/frame-player.js'),import('/cloud/live-timing.mjs'),import('/cloud/stream-protocol.mjs'),import('/cloud/http-video.js')]);
      const timing=new LiveTiming(),started=performance.now(),packets=[],outputs=[],samples=[],errors=[],raf=[];
      const ctx=document.querySelector('canvas').getContext('2d');
      const states=['current','local-200ms','adaptive'].map(name=>{
        const s={name,presented:[]};
        s.player=new FramePlayer((frame,at)=>{s.presented.push({now:performance.now(),age:timing.age(at)});if(name==='current')ctx.drawImage(frame,0,0,480,270)},name==='local-200ms'?()=>true:(at,now)=>timing.fresh(at,now));
        if(name==='adaptive'){
          s.player.push=function(frame,at,fps=60){this.fps=fps;this.decoded++;const now=performance.now();if(this.next===null)this.next=now;this.queue.push({frame:frame.clone(),at,received:now});while(this.queue.length>24)this.drop('overflow');this.maxQueue=Math.max(this.maxQueue,this.queue.length)};
          const original=s.player.tick.bind(s.player);
          s.player.tick=function(now){if(this.queue.length>6)this.next=Math.min(now,this.next??now);original(now)};
        }
        return s;
      });
      const decoder=new GlassDecoder((f,at,fps)=>{outputs.push({now:performance.now(),at});for(const s of states)s.player.push(f,at,fps)},e=>errors.push(e.message));
      let ws,controller,done,busy=false;
      const receive=m=>{try{
        if(m.pong){timing.pong(m);return}if(Number.isSafeInteger(m.n)&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({ack:m.n}));if(m.kind!=='h264')return;
        if(!m.config)packets.push({now:performance.now(),at:m.at,frames:m.frames,bytes:m.bytes.length,seg:m.seg,sourceSentAt:m.sourceSentAt,age:timing.age(m.at)});
        decoder.push(m);
      }catch(e){errors.push(e.message)}};
      if(http){controller=new AbortController();done=fetch('/cam/live?viewer=policy-'+crypto.randomUUID(),{signal:controller.signal}).then(r=>readVideo(r.body,receive,controller.signal)).catch(e=>{if(!controller.signal.aborted)errors.push(e.message)})}
      else{ws=new WebSocket(location.origin.replace('https','wss')+'/cam/ws?binary=1');ws.binaryType='arraybuffer';ws.onmessage=e=>receive(e.data instanceof ArrayBuffer?(()=>{const p=unpack(e.data);return {...p.meta,bytes:p.bytes}})():JSON.parse(e.data))}
      const ping=setInterval(async()=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(timing.ping()));if(http&&!busy){busy=true;const start=performance.now();try{const s=await(await fetch('/recognition/status')).json();timing.observe(s.serverNow,start)}finally{busy=false}}},1000);
      await window.startFixture();
      let running=true,last;
      function tick(now){if(!running)return;if(last)raf.push(now-last);last=now;for(const s of states)s.player.tick(now);requestAnimationFrame(tick)}requestAnimationFrame(tick);
      for(let i=0;i<12;i++){
        await new Promise(r=>setTimeout(r,5000));
        const sample={seconds:(performance.now()-started)/1000,packets:packets.length,received:packets.reduce((n,p)=>n+p.frames,0),decoded:outputs.length,uncertainty:timing.uncertainty,players:states.map(s=>({name:s.name,shown:s.player.shown,drops:{...s.player.drops},queue:s.player.queue.length,age:s.presented.at(-1)?.age}))};samples.push(sample);console.log('PLAYERS '+JSON.stringify(sample));
      }
      running=false;clearInterval(ping);ws?.close();controller?.abort();await done;decoder.reset();
      const result={duration:(performance.now()-started)/1000,samples,packets,outputs,raf,errors,decoder:decoder.counters,players:states.map(s=>({name:s.name,presented:s.presented,shown:s.player.shown,dropped:s.player.dropped,drops:s.player.drops,maxQueue:s.player.maxQueue,maxWaitMs:s.player.maxWaitMs}))};
      for(const s of states)s.player.clear();return result;
    },{http});
    const path='/private/tmp/rokid-'+(replay?'replay-'+kbps:'live')+'-'+(http?'http':'ws')+'-player-comparison.json';fs.writeFileSync(path,JSON.stringify(result,null,2));
    const pct=(xs,q)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*q))];
    console.log(JSON.stringify({path,duration:result.duration,errors:result.errors,decoder:result.decoder,rafP50:pct(result.raf,.5),rafMax:Math.max(...result.raf),packetAgeP50:pct(result.packets.map(p=>p.age).filter(x=>x!==null),.5),packetAgeP95:pct(result.packets.map(p=>p.age).filter(x=>x!==null),.95),players:result.players.map(p=>({name:p.name,shown:p.shown,drops:p.drops,ageP50:pct(p.presented.map(x=>x.age).filter(x=>x!==null),.5),ageP95:pct(p.presented.map(x=>x.age).filter(x=>x!==null),.95),gapP95:pct(p.presented.slice(1).map((x,i)=>x.now-p.presented[i].now),.95)}))}));
  } finally {source?.kill('SIGTERM');await browser.close();if(replay)await fetch(base+'/cam/set?fps=0',{signal:AbortSignal.timeout(5000)}).catch(()=>{})}
})().catch(e=>{console.error(e);process.exitCode=1});
