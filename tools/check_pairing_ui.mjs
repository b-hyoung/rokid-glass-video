import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
let [debugUrl,origin='http://localhost:8791']=process.argv.slice(2),browser;
if(debugUrl&&!debugUrl.startsWith('ws://')){origin=debugUrl;debugUrl=null;}
const port=new URL(origin).port;
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use an isolated loopback runtime');
if(!debugUrl){
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'glass-connect-check-'));
 browser=spawn(process.env.GLASS_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
 let debugPort;
 for(let n=0;n<100;n++){try{debugPort=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
 if(!debugPort){browser.kill();throw Error('Browser startup timed out')}
 debugUrl=(await(await fetch('http://127.0.0.1:'+debugPort+'/json')).json()).find(t=>t.type==='page').webSocketDebuggerUrl;
}
const credentials=JSON.parse(await fs.readFile('runtime/paired-'+port+'/check-credentials.json','utf8')).a;
const keys=JSON.parse(await fs.readFile('runtime/paired-'+port+'/secrets.json','utf8'));
const hello={installKey:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),label:'Browser check glasses',app:'0.2.22',protocol:1};
const post=async(route,data)=>{const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json()};
const device=await post('/access/hello',hello),heartbeat=setInterval(()=>post('/access/hello',hello).catch(()=>{}),3000);
const expectedEngine=JSON.parse(await fs.readFile('release.json','utf8')).engine;
const socket=new WebSocket(debugUrl);await new Promise(resolve=>socket.onopen=resolve);
let seq=0,states=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('Browser command failed')):p.resolve(m.result)}else if(m.method==='Network.webSocketFrameReceived')try{if(JSON.parse(m.params.response.payloadData).type==='state')states++}catch{}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('Page evaluation failed');return r.result.value};
const until=async expression=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('UI readiness timed out: '+JSON.stringify(await evaluate('({path:location.pathname,message:document.querySelector("#message")?.textContent,ready:document.body.dataset.ready})')))};
try{
 await send('Network.enable');
 await send('Page.navigate',{url:origin+'/connect'});await until('document.body.dataset.ready==="true"');
 await evaluate('document.querySelector("#room").value='+JSON.stringify(credentials.roomId)+';document.querySelector("#recovery").value='+JSON.stringify(credentials.recoveryKey)+';document.querySelector("#login button").click()');
 await until('document.querySelector("#signed-in")?.hidden===false');
 assert.equal(await evaluate('document.querySelector("#owner").hidden'),false);
 await evaluate('document.querySelector("#owner-key").value='+JSON.stringify(keys.SETUP_SECRET)+';document.querySelector("#owner button").click()');
 await until('document.querySelector("#owner").hidden===true');
 await until('!!document.querySelector('+JSON.stringify('button[data-device-id="'+device.deviceId+'"]')+')');
 await evaluate('document.querySelector('+JSON.stringify('button[data-device-id="'+device.deviceId+'"]')+').click()');
 await until('document.querySelector("#message").textContent.includes("승인")');
 const connected=await post('/access/hello',hello);assert.equal(connected.state,'connected');
 await fetch(origin+'/next?id=browser-check',{headers:{Authorization:'Bearer '+connected.token}});
 await until('document.querySelector("#devices").textContent.includes("연결됨")');
 await evaluate('document.querySelector("#disconnect").click()');
 await until('document.querySelector("#message").textContent.includes("해제했습니다")');
 assert.equal((await fetch(origin+'/status',{headers:{Authorization:'Bearer '+connected.token}})).status,403);
 assert.equal((await post('/access/hello',hello)).state,'pending');
 assert.equal(await evaluate('!!document.querySelector("#server-address,#pair-code,#new-code")'),false);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 const mobile=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.equal(mobile.width,mobile.scroll);
 await evaluate('document.querySelector("#room-id").style.visibility="hidden"');
 const image=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('runtime/paired-'+port+'/connect-mobile.png',Buffer.from(image.data,'base64'));
 await send('Page.navigate',{url:origin+'/recognition'});
 await until('document.querySelector("#target-count")?.textContent==="7개" && document.querySelector("#vision-build")?.textContent.includes('+JSON.stringify(expectedEngine)+')');
 assert.equal(await evaluate('document.querySelector("#connection-access").hidden'),false);
 assert.equal(await evaluate('document.querySelector("#local-setup").hidden'),true);
 if(!states)throw Error('Controller state subscription did not authenticate');
 const status={login:true,ownerOnlyDeviceManagement:true,webConnectAndDisconnect:true,noServerOrCodeInput:true,mobileOverflow:false,ownTargets:7,connectionManagementVisible:true,controllerStateSubscribed:true};
 await fs.writeFile('runtime/paired-'+port+'/ui-validation.json',JSON.stringify(status,null,2));console.log(JSON.stringify(status));
}finally{clearInterval(heartbeat);socket.close();if(browser)browser.kill()}
