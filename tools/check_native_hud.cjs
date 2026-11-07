// Intercepted Chrome integration: no production commands or camera access.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),base='https://hud-test.invalid',output=path.join(root,'results/native-tracking-0.2.10');fs.mkdirSync(output,{recursive:true});
 const {DEFAULT_GUIDE}=await import('../cloud/registration-guide.mjs');
 const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route('**/*',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/recognition')return route.fulfill({path:path.join(root,'cloud/index.html'),contentType:'text/html'});
   if(p==='/cloud/vision-client.js')return route.fulfill({contentType:'text/javascript',body:'export class VisionClient {constructor(){this.ready=new Promise(()=>{});this.refs=[]}}'});
   if(p.startsWith('/cloud/')&&!p.includes('..'))return route.fulfill({path:path.join(root,p),contentType:'text/javascript'});
   let json={};
   if(p==='/recognition/status')json={enabled:false,detections:[],version:0,epoch:0,at:0,progress:0,serverNow:Date.now(),guide:{...DEFAULT_GUIDE,enabled:false}};
   if(p==='/recognition/guide')json={...DEFAULT_GUIDE,enabled:false};
   if(p==='/status')json={glasses:1};
   if(p==='/cam/stats')json={test:null,receiveFps:0};
   if(p==='/recognition/targets')json={version:0,targets:[]};
   return route.fulfill({json});
  });
  await page.addInitScript(()=>{
   window.hudTest={sockets:[],seq:0};
   class Socket {static OPEN=1;constructor(url){this.url=url;this.readyState=0;this.sent=[];window.hudTest.sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}send(text){this.sent.push(JSON.parse(text))}close(){this.readyState=3;this.onclose?.({})}}
   window.WebSocket=Socket;
   window.hudTest.emit=state=>window.hudTest.sockets.find(s=>s.url.endsWith('/recognition/hud')&&s.readyState===1).onmessage({data:JSON.stringify({seq:++window.hudTest.seq,visible:true,width:640,height:360,tracking:true,...state})});
  });
  await page.goto(base+'/recognition');
  await page.waitForFunction(()=>window.hudTest.sockets.some(s=>s.url.endsWith('/recognition/hud')&&s.readyState===1));
  await page.evaluate(()=>window.hudTest.emit({mode:'recognition',objects:[{id:'a',name:'Rokid 선글라스 상자',x:.12,y:.35},{id:'b',name:'VR 기기',x:.66,y:.62}]}));
  assert.match(await page.locator('#hud-summary').textContent(),/대상 2개/);assert.equal(await page.locator('#hud-labels span').count(),2);
  const channels=await page.evaluate(()=>window.hudTest.sockets.map(s=>s.url));assert.equal(channels.length,2);assert.ok(channels.some(s=>s.includes('/cam/ws')));
  await page.locator('#hud-monitor').screenshot({path:path.join(output,'hud-preview.png')});
  await page.evaluate(()=>window.hudTest.emit({mode:'playback',title:'마주봄',objects:[]}));assert.match(await page.locator('#hud-summary').textContent(),/자동 재생 잠금/);assert.equal(await page.locator('#hud-labels span').count(),0);assert.equal(await page.locator('#hud-video-state strong').textContent(),'마주봄');
  await page.waitForFunction(()=>document.querySelector('#hud-video-state').hidden,null,{timeout:4000});assert.equal(await page.locator('#hud-labels span').count(),0);
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.hudTest.emit({mode:'recognition',objects:[{id:'a',name:'Rokid 선글라스 상자',x:.12,y:.35}]}));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  await page.close();
  // Run the real browser OpenCV recognizer and serialize its exact native seeds.
  const cvPage=await browser.newPage();cvPage.on('pageerror',e=>errors.push(e.message));
  await cvPage.route('**/*',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/')return route.fulfill({contentType:'text/html',body:'<script src="/cloud/opencv.js"></script>'});
   if(p.startsWith('/cloud/'))return route.fulfill({path:path.join(root,p),contentType:'text/javascript'});
   const photos={'/a.jpg':'03_bed_experiment.jpg','/b.jpg':'01_first_meeting.jpg'};
   if(photos[p])return route.fulfill({path:path.join(root,'tools/majubom_src/photos',photos[p]),contentType:'image/jpeg'});
   return route.abort();
  });
  await cvPage.goto(base+'/');await cvPage.waitForFunction(()=>!!window.cv?.Mat,null,{timeout:60000});
  const data=await cvPage.evaluate(async()=>{
   const {VisionEngine}=await import('/cloud/vision-engine.js');
   const engine=new VisionEngine(cv),canvas=new OffscreenCanvas(540,960),ctx=canvas.getContext('2d');ctx.fillStyle='#222';ctx.fillRect(0,0,540,960);
   const refs=[];
   for(const [id,url,x,y] of [['a','/a.jpg',90,80],['b','/b.jpg',60,550]]){
    const image=await createImageBitmap(await(await fetch(url)).blob()),ref=new OffscreenCanvas(360,280);ref.getContext('2d').drawImage(image,0,0,360,280);image.close();
    const blob=await ref.convertToBlob({type:'image/jpeg',quality:.95}),bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
    refs.push({id,images:[{id,image:'data:image/jpeg;base64,'+btoa(raw)}]});ctx.drawImage(ref,x,y);
   }
   await engine.matcher.references(refs);const result=await engine.process(await createImageBitmap(canvas),{mode:'recognize',at:Date.now()});
   const rgba=cv.matFromImageData(ctx.getImageData(0,0,540,960)),gray=new cv.Mat(),small=new cv.Mat();cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);cv.resize(gray,small,new cv.Size(180,320),0,0,cv.INTER_AREA);let raw='';for(const b of small.data)raw+=String.fromCharCode(b);rgba.delete();gray.delete();small.delete();engine.reset();
   return {found:result.found,ms:result.ms,gray:btoa(raw)};
  });
  assert.equal(data.found.length,2);assert.ok(data.found.every(t=>t.seed?.points.length>=4));
  fs.writeFileSync(path.join(output,'web-native-seeds.json'),JSON.stringify(data));
  assert.deepEqual(errors,[]);const result={channels,errors,targets:data.found.map(t=>({id:t.id,inliers:t.inliers,patches:t.seed.points.length})),recognitionMs:data.ms};fs.writeFileSync(path.join(output,'browser-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
