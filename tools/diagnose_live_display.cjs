// Read-only comparison of the real glasses feed. Does not start/stop capture or recognition.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('node:fs');const base='https://glass-2412.youqlrqod.workers.dev';
(async()=>{const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage();try{
 await page.route(base+'/live-diagnostic',r=>r.fulfill({contentType:'text/html',body:'<title>Live receive diagnostic</title><canvas width="480" height="270"></canvas><canvas width="480" height="270"></canvas>'}));await page.goto(base+'/live-diagnostic');page.on('console',m=>{if(m.text().startsWith('LIVE '))console.log(m.text())});
 const result=await page.evaluate(async()=>{
  const [{GlassDecoder},{FramePlayer},{readVideo},{unpack}]=await Promise.all([import('/cloud/decoder.js'),import('/cloud/frame-player.js'),import('/cloud/http-video.js'),import('/cloud/stream-protocol.mjs')]);
  const paths=['http','websocket'],states=[];let running=true;const raf=[];let previous;
  for(const [i,path] of paths.entries()){
   const canvas=document.querySelectorAll('canvas')[i],ctx=canvas.getContext('2d'),s={path,packets:[],outputs:[],errors:[],samples:[],frameAge:[]};
   s.player=new FramePlayer((f,at)=>{ctx.drawImage(f,0,0,480,270);s.frameAge.push({at:performance.now(),age:Date.now()-at})});
   s.decoder=new GlassDecoder((f,at,fps)=>{s.outputs.push({at:performance.now(),serverAt:at});s.player.push(f,at,fps)},e=>s.errors.push(e.message));
   const receive=m=>{if(m.kind!=='h264')return;if(!m.config)s.packets.push({at:performance.now(),wall:Date.now(),serverAt:m.at,sourceSentAt:m.sourceSentAt,seg:m.seg,frames:m.frames,test:m.test});s.decoder.push(m)};
   if(path==='http'){s.controller=new AbortController();s.done=fetch('/cam/live?viewer=diagnostic-'+crypto.randomUUID(),{signal:s.controller.signal}).then(r=>readVideo(r.body,receive,s.controller.signal)).catch(e=>{if(!s.controller.signal.aborted)s.errors.push(e.message)})}
   else {s.ws=new WebSocket(location.origin.replace('https','wss')+'/cam/ws');s.ws.binaryType='arraybuffer';s.ws.onmessage=e=>{const m=e.data instanceof ArrayBuffer?(()=>{const p=unpack(e.data);return {...p.meta,bytes:p.bytes}})():JSON.parse(e.data);if(Number.isSafeInteger(m.n))s.ws.send(JSON.stringify({ack:m.n}));receive(m)}}
   states.push(s);
  }
  const tick=at=>{if(!running)return;if(previous)raf.push(at-previous);previous=at;for(const s of states)s.player.tick(at);requestAnimationFrame(tick)};requestAnimationFrame(tick);
  for(let i=0;i<9;i++){await new Promise(r=>setTimeout(r,5000));for(const s of states){const v={seconds:(i+1)*5,received:s.packets.reduce((n,p)=>n+p.frames,0),decoded:s.player.decoded,shown:s.player.shown,dropped:s.player.dropped,queue:s.player.queue.length,age:s.frameAge.at(-1)?.age};s.samples.push(v);console.log('LIVE '+s.path+' '+JSON.stringify(v))}}
  running=false;for(const s of states){s.controller?.abort();s.ws?.close();s.decoder.reset();s.player.clear()}await Promise.all(states.map(s=>s.done));
  return {rafMax:Math.max(...raf),states:states.map(({path,packets,outputs,errors,samples,frameAge,decoder,player})=>({path,packets,outputs,errors,samples,frameAge,decoder:decoder.counters,player:{shown:player.shown,dropped:player.dropped,maxWait:player.maxWaitMs}}))};
 });fs.writeFileSync('/private/tmp/rokid-live-http-vs-ws.json',JSON.stringify(result,null,2));console.log(JSON.stringify({rafMax:result.rafMax,states:result.states.map(s=>({path:s.path,samples:s.samples,errors:s.errors,decoder:s.decoder}))}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
