// Runs against the isolated Cloudflare deployment; never mutates production.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='https://rokid-delivery-check.youqlrqod.workers.dev';
(async()=>{
 const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route(base+'/vision-check',r=>r.fulfill({contentType:'text/html',body:'<title>isolated vision check</title>'}));await page.goto(base+'/vision-check');
  const result=await page.evaluate(async()=>{
   const {VisionClient}=await import('/cloud/vision-client.js'),vision=new VisionClient();await vision.ready;
   const object=(label,seed)=>{const c=document.createElement('canvas');c.width=260;c.height=200;const g=c.getContext('2d');g.fillStyle='#ddd';g.fillRect(0,0,260,200);for(let i=0;i<160;i++){seed=(seed*1664525+1013904223)>>>0;const x=seed%250;seed=(seed*1664525+1013904223)>>>0;const y=seed%190;g.fillStyle=i%2?'#101010':'#555';g.fillRect(x,y,3+i%8,3+i%9)}g.font='bold 32px sans-serif';g.fillStyle='#000';g.fillText(label,15,100);return c};
   const a=object('ROKID',1),b=object('VR BOX',25),c=document.createElement('canvas');c.width=800;c.height=520;const g=c.getContext('2d');
   const draw=(x=130,blank=false)=>{g.fillStyle='#222';g.fillRect(0,0,c.width,c.height);if(!blank)g.drawImage(a,x,140)};
   draw();let at=Date.now();const opts={mode:'capture',session:'registration-test',roi:{cx:260/800,cy:240/520,width:260/800,height:200/520},elapsed:0};
   const initial=await vision.process(c,{...opts,seed:true,at});
   const tracked=[];for(let i=1;i<=6;i++){draw(130+i*3);at+=120;tracked.push(await vision.process(c,{...opts,at,elapsed:i*120}))}
   draw(148);at+=120;const duplicate=await vision.process(c,{...opts,at});
   draw(0,true);at+=120;const lost=await vision.process(c,{...opts,at});draw();at+=120;const staysLost=await vision.process(c,{...opts,at});
   const reacquired=await vision.process(c,{...opts,seed:true,at:at+120});
   await vision.reset();
   await vision.references([{id:'a',images:[{id:'a1',image:a.toDataURL('image/jpeg',.9)}]},{id:'b',images:[{id:'b1',image:b.toDataURL('image/jpeg',.9)}]}]);
   g.fillStyle='#222';g.fillRect(0,0,800,520);g.drawImage(a,40,140);g.drawImage(b,460,140);
   const two=await vision.process(c,{mode:'recognize',at:at+500});
   g.fillStyle='#222';g.fillRect(0,0,800,520);g.drawImage(a,44,144);g.drawImage(b,464,144);
   const twoTracked=await vision.process(c,{mode:'recognize',at:at+620});
   const samples=[initial,...tracked].filter(r=>r.sample).map(r=>r.sample);vision.worker.terminate();
   return {initial:{...initial,sample:initial.sample?{...initial.sample,image:'JPEG '+initial.sample.image.length}:null},tracked:tracked.map(r=>({corners:r.corners,lost:r.lost,note:r.note,ms:r.ms})),duplicate:{...duplicate,sample:!!duplicate.sample},lost,staysLost,reacquired:{lost:reacquired.lost,corners:reacquired.corners},two,twoTracked,sampleCount:samples.length};
  });
  console.log(JSON.stringify(result,null,2));assert.ok(result.initial.sample);assert.equal(result.tracked.filter(x=>x.lost).length,0);assert.ok(result.tracked.at(-1).corners[0][0]>.18);assert.equal(result.duplicate.sample,false);assert.equal(result.duplicate.lost,undefined);assert.match(result.tracked.at(-1).note,/비슷한/);assert.equal(result.lost.lost,true);assert.equal(result.staysLost.lost,true);assert.ok(result.reacquired.corners);assert.equal(result.two.found.length,2);assert.equal(result.twoTracked.found.length,2);assert.ok(result.twoTracked.found.every(x=>x.tracked));assert.deepEqual(errors,[]);
  fs.mkdirSync('results/pipeline-validation-20261106',{recursive:true});fs.writeFileSync('results/pipeline-validation-20261106/guide-video-registration.json',JSON.stringify({result,errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
