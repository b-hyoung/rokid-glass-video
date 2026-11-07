// Browser regression: replay real H.264 bytes with a controlled delayed transport.
// All routes are intercepted; this never sends test images/commands to production.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),base='https://recovery-test.invalid';
 const {DEFAULT_GUIDE}=await import('../cloud/registration-guide.mjs');
 const bytes=fs.readFileSync(process.env.CHECK_FIXTURE||'/private/tmp/rokid-500kbps.h264'),starts=[];
 for(let i=0;i<bytes.length-4;i++)if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1&&(bytes[i+3]&31)===9)starts.push(i>0&&bytes[i-1]===0?i-1:i);
 const chunks=Array.from({length:30},(_,i)=>bytes.subarray(starts[i*6],starts[i*6+6]).toString('base64'));
 const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p==='/recognition')return route.fulfill({path:path.join(root,'cloud/index.html'),contentType:'text/html'});
   if(p==='/cloud/vision-client.js')return route.fulfill({contentType:'text/javascript',body:'export class VisionClient {constructor(){this.ready=new Promise(()=>{});this.refs=[]}}'});
   if(p.startsWith('/cloud/')&&!p.includes('..'))return route.fulfill({path:path.join(root,p),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
   let json={};
   if(p==='/recognition/status')json={enabled:false,detections:[],version:0,epoch:0,at:0,progress:0,serverNow:Date.now(),guide:{...DEFAULT_GUIDE,enabled:false}};
   if(p==='/recognition/guide')json={...DEFAULT_GUIDE,enabled:false};
   if(p==='/status')json={glasses:1};
   if(p==='/cam/stats')json={test:{test:1,fps:60,kbps:500,done:false,transport:'websocket'},receiveFps:60};
   if(p==='/recognition/targets')json={version:0,targets:[]};
   return route.fulfill({json});
  });
  await page.addInitScript(({chunks})=>{
   const data=chunks.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)));
   const trace=window.recoveryTrace={websocketConnections:0,closed:0,activeSockets:0,maxActiveSockets:0,httpConnections:0,activeHttp:0,maxActiveHttp:0,metrics:[]};
   function packet(seg,age){const m={kind:'h264',test:1,seg,n:seg+1,frames:6,fps:60,complete:true,at:Date.now()-age},h=new TextEncoder().encode(JSON.stringify(m)),b=data[seg%30],p=new Uint8Array(4+h.length+b.length);new DataView(p.buffer).setUint32(0,h.length);p.set(h,4);p.set(b,4+h.length);return p}
   class FakeSocket{
    static OPEN=1;
    constructor(){this.readyState=0;this.seg=0;trace.websocketConnections++;trace.maxActiveSockets=Math.max(trace.maxActiveSockets,++trace.activeSockets);setTimeout(()=>{this.readyState=1;this.onopen?.({});this.timer=setInterval(()=>this.onmessage?.({data:packet(this.seg++,1300).buffer}),100)},0)}
    send(s){const m=JSON.parse(s);if(m.ping)this.onmessage?.({data:JSON.stringify({pong:m.ping,serverNow:Date.now()})});if(m.metrics)trace.metrics.push({transport:'websocket',...m.metrics})}
    close(){if(this.readyState===3)return;clearInterval(this.timer);this.readyState=3;trace.closed++;trace.activeSockets--;this.onclose?.({})}
   }
   window.WebSocket=FakeSocket;
   const fetchOriginal=window.fetch;
   window.fetch=(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.pathname==='/cam/viewer-metrics'){trace.metrics.push({transport:'http',...JSON.parse(options.body)});return Promise.resolve(new Response('{}'))}
    if(url.pathname!=='/cam/live')return fetchOriginal(input,options);
    trace.httpConnections++;trace.maxActiveHttp=Math.max(trace.maxActiveHttp,++trace.activeHttp);
    let timer,closed=false;
    const stream=new ReadableStream({start(c){let seg=0;const stop=()=>{if(closed)return;closed=true;clearInterval(timer);trace.activeHttp--;c.close()};options.signal.addEventListener('abort',stop,{once:true});timer=setInterval(()=>{const p=packet(seg++,0),framed=new Uint8Array(p.length+4);new DataView(framed.buffer).setUint32(0,p.length);framed.set(p,4);c.enqueue(framed)},100)},cancel(){if(!closed){closed=true;clearInterval(timer);trace.activeHttp--}}});
    return Promise.resolve(new Response(stream));
   };
  },{chunks});
  await page.goto(base+'/recognition');
  await page.waitForFunction(()=>window.recoveryTrace.metrics.some(m=>m.transport==='http'&&m.displayFps>50),null,{timeout:18000});
  const trace=await page.evaluate(()=>window.recoveryTrace);
  assert.deepEqual(errors,[]);assert.equal(trace.websocketConnections,2);assert.equal(trace.closed,2);assert.equal(trace.activeSockets,0);assert.equal(trace.maxActiveSockets,1);assert.equal(trace.httpConnections,1);assert.equal(trace.maxActiveHttp,1);
  assert.ok(trace.metrics.some(m=>m.transport==='websocket'&&m.totalDecoded>0&&m.totalDisplayed===0));
  assert.ok(trace.metrics.some(m=>m.transport==='http'&&m.displayFps>50));
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForFunction(()=>window.recoveryTrace.httpConnections===2&&window.recoveryTrace.metrics.at(-1)?.displayFps>50,null,{timeout:6000});
  const resumed=await page.evaluate(()=>window.recoveryTrace);
  assert.equal(resumed.maxActiveHttp,1);assert.equal(resumed.activeHttp,1);assert.equal(resumed.activeSockets,0);assert.deepEqual(errors,[]);
  const result={description:'Controlled browser regression; no live network or glasses.',errors,initial:trace,resumed};
  fs.writeFileSync(path.join(root,'results/pipeline-validation-20261106/live-recovery-browser.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({errors,websocketConnections:trace.websocketConnections,httpConnections:trace.httpConnections,last:trace.metrics.at(-1)}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
