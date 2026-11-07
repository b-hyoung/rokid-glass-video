// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const base=process.env.CHECK_ORIGIN||'https://rokid-delivery-check.youqlrqod.workers.dev';
const routes=process.argv.slice(2);if(!routes.length)routes.push('/paced/edge','/paced/do-default','/paced/do-apac');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const browser=await chromium.launch({channel:'chrome'}),results=[];
 try{
  for(const route of routes){
   const page=await browser.newPage(),errors=[],protocols=[];
   const relay=route.startsWith('/cam/live');let source,sourceExit,sourceOutput='';
   if(relay){
    if(new URL(base).hostname!=='rokid-delivery-check.youqlrqod.workers.dev')throw Error('Relay test is restricted to its isolated test Worker');
    const cfg=await(await fetch(base+'/cam/set?mode=video&fps=60&kbps=2000')).json();
    await page.exposeFunction('readySource',()=>{
      source=spawn('java',['-cp','/private/tmp/rokid-live-check:build/deps/*:build/test-deps/*','com.hoonartis.glassvideo.LiveSocketCheck',base,String(cfg.test),path.join(__dirname,'build/fixture.h264'),'200'],{cwd:root});
      source.stdout.on('data',d=>{sourceOutput+=d;process.stdout.write(d)});source.stderr.on('data',d=>process.stderr.write(d));
      sourceExit=new Promise((resolve,reject)=>{source.on('exit',resolve);source.on('error',reject)});
    });
   }
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('CHECK '))console.log(m.text())});
   const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');
   cdp.on('Network.responseReceived',e=>{if(e.response.url.includes('/paced/')||e.response.url.includes('/cam/live'))protocols.push({url:e.response.url,protocol:e.response.protocol})});
   await page.route(base+'/client.html',r=>r.fulfill({contentType:'text/html',body:'<canvas width="540" height="960"></canvas>'}));
   await page.route(base+'/module/**',r=>r.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'cloud',new URL(r.request().url()).pathname.split('/').pop()))}));
   await page.goto(base+'/client.html');
   const result=await page.evaluate(async route=>{
    const [{GlassDecoder},{FramePlayer},{readVideo}]=await Promise.all([import('/module/decoder.js'),import('/module/frame-player.js'),import('/module/http-video.js')]);
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),stage=document.createElement('canvas'),g=stage.getContext('2d');stage.width=540;stage.height=960;
    const received=[],decoded=[],shown=[],packetAges=[],displayAges=[],chunks=[],errors=[];let running=true;
    const player=new FramePlayer((frame,at)=>{g.save();g.translate(0,960);g.rotate(-Math.PI/2);g.drawImage(frame,0,0,960,540);g.restore();shown.push(performance.now());displayAges.push(Date.now()-at)});
    const decoder=new GlassDecoder((f,at,fps)=>{decoded.push(performance.now());player.push(f,at,fps)},e=>errors.push(e.message));
    const tick=now=>{if(!running)return;player.tick(now);ctx.drawImage(stage,0,0);requestAnimationFrame(tick)};requestAnimationFrame(tick);
    const relay=route.startsWith('/cam/live'),control=new AbortController();const timeout=setTimeout(()=>control.abort(),relay?28000:95000);
    const log=setInterval(()=>console.log('CHECK '+route+' '+JSON.stringify({received:received.length*6,decoded:player.decoded,shown:player.shown,dropped:player.dropped})),5000);
    let response;
    try{
      response=await fetch(route,{signal:control.signal});if(!response.ok)throw Error('HTTP '+response.status);
      if(relay)await window.readySource();
      const body=response.body.pipeThrough(new TransformStream({transform(chunk,c){chunks.push({at:performance.now(),bytes:chunk.length});c.enqueue(chunk)}}));
      await readVideo(body,m=>{if(m.kind!=='h264')return;if(!m.config){received.push({at:performance.now(),serverAt:m.at,seg:m.seg});packetAges.push(Date.now()-m.at)}decoder.push(m)},control.signal);
    }catch(e){if(!(relay&&control.signal.aborted))errors.push(e.message)}
    clearTimeout(timeout);clearInterval(log);await new Promise(r=>setTimeout(r,950));running=false;
    const rate=times=>times.length>1?(times.length-1)*1000/(times.at(-1)-times[0]):0;
    const percentile=(a,p)=>{const sorted=[...a].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null};
    const gaps=received.slice(1).map((v,i)=>v.at-received[i].at),serverGaps=received.slice(1).map((v,i)=>v.serverAt-received[i].serverAt);
    const result={route,ingress:response?.headers.get('X-Ingress-Colo'),receivedPackets:received.length,decoded:player.decoded,displayed:player.shown,dropped:player.dropped,maxQueue:player.maxQueue,decodeFps:rate(decoded),displayFps:rate(shown),arrivalGapMs:{median:percentile(gaps,.5),p95:percentile(gaps,.95),max:Math.max(0,...gaps)},serverGapMs:{median:percentile(serverGaps,.5),p95:percentile(serverGaps,.95),max:Math.max(0,...serverGaps)},packetAgeMs:{median:percentile(packetAges,.5),p95:percentile(packetAges,.95)},displayAgeMs:{median:percentile(displayAges,.5),p95:percentile(displayAges,.95)},errors,received,chunks};decoder.reset();player.clear();return result;
   },route);
   result.pageErrors=errors;result.protocols=protocols;results.push(result);
   if(relay){if(sourceExit)await sourceExit;result.sourceOutput=sourceOutput;result.serverStats=await(await fetch(base+'/cam/stats')).json();await fetch(base+'/cam/set?fps=0')}
   console.log(JSON.stringify({...result,received:undefined,chunks:undefined}));
   fs.mkdirSync(path.join(__dirname,'build'),{recursive:true});fs.writeFileSync(path.join(__dirname,'build','delivery-results.json'),JSON.stringify(results,null,2));await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
