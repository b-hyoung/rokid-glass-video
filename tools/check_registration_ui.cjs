const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/bobs/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const {spawn}=require('node:child_process'),fs=require('node:fs'),assert=require('node:assert/strict');
const base='https://rokid-delivery-check.youqlrqod.workers.dev';
(async()=>{
 const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],samples=[];let source,deviceTimer,savedId;
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await fetch(base+'/recognition/control?enabled=0',{method:'POST'});
  await page.goto(base+'/recognition');await page.waitForFunction(()=>document.querySelector('#state').textContent!=='인식 엔진 준비 중',{timeout:60000});
  const cfg=await(await fetch(base+'/cam/set?mode=video&fps=60&kbps=2000')).json();
  source=spawn('java',['-cp','/private/tmp/rokid-live-check:build/deps/*:build/test-deps/*','com.hoonartis.glassvideo.LiveSocketCheck',base,String(cfg.test),'/private/tmp/rokid-2mbps.h264','650']);source.stdout.on('data',d=>process.stdout.write(d));source.stderr.on('data',d=>process.stderr.write(d));
  deviceTimer=setInterval(()=>fetch(base+'/recognition/status?hud=2&app=0.2.9-test').catch(()=>{}),1500);
  await page.waitForTimeout(3000);await page.locator('#new-target').click();await page.locator('#name').fill('영상 등록 자동 시험');await page.locator('#video-key').selectOption('e');
  await page.locator('#guide-open').click();await page.waitForFunction(()=>document.querySelector('#guide-device').textContent.includes('0.2.9-test'));
  await page.locator('#guide-shape').selectOption('circle');
  for(const [id,val] of [['hud-cx','45'],['camera-width','80'],['camera-height','80']])await page.locator('#'+id).evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}))},val);
  await page.waitForTimeout(500);await page.locator('#guide-save').click();await page.waitForFunction(()=>!document.querySelector('#video-register').disabled);
  await page.locator('#video-register').click();
  for(let i=0;i<8;i++){await page.waitForTimeout(2000);const text=await page.locator('#stream-stats').textContent();const note=await page.locator('#registration-note').textContent();samples.push({text,note});console.log(text+' | '+note);if(await page.locator('#capture-reseed').isEnabled())await page.locator('#capture-reseed').click()}
  await page.locator('#capture-finish').click();const count=await page.locator('#capture-samples button').count();assert.ok(count>0,'real recording must produce registration candidates');
  await page.screenshot({path:'results/pipeline-validation-20261106/registration-review.png',fullPage:true});
  await page.locator('#samples-save').click();await page.waitForFunction(()=>document.querySelector('#registration-step').textContent.includes('새 시야'),{timeout:30000});
  savedId=await page.locator('#target-picker').inputValue();const library=await(await fetch(base+'/recognition/targets')).json();const saved=library.targets.find(t=>t.id===savedId);assert.equal(saved.images.length,count);assert.ok(saved.images.every(x=>x.capture?.source==='video'));assert.equal((await(await fetch(base+'/recognition/status')).json()).enabled,false);
  await page.locator('#guide-close').click();await page.locator('#start').click();
  for(let i=0;i<16;i++){await page.waitForTimeout(2000);const text=await page.locator('#stream-stats').textContent();samples.push({text});console.log(text)}
  const stats=await(await fetch(base+'/cam/stats')).json();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'results/pipeline-validation-20261106/registration-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  assert.deepEqual(errors,[]);fs.writeFileSync('results/pipeline-validation-20261106/registration-ui-performance.json',JSON.stringify({count,savedId,errors,samples,stats},null,2));console.log(JSON.stringify({count,errors,metrics:stats.viewers.map(v=>v.metrics)}));
 }finally{clearInterval(deviceTimer);source?.kill('SIGTERM');await fetch(base+'/cam/set?fps=0');await fetch(base+'/recognition/control?enabled=0',{method:'POST'});if(savedId)await fetch(base+'/recognition/targets?id='+savedId,{method:'DELETE'});await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
