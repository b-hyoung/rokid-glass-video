import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const [debugUrl,origin='http://localhost:8791']=process.argv.slice(2),port=new URL(origin).port;
const credentials=JSON.parse(await fs.readFile('runtime/paired-'+port+'/check-credentials.json','utf8')).a;
const socket=new WebSocket(debugUrl);await new Promise(resolve=>socket.onopen=resolve);
let seq=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('Browser command failed')):p.resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('Page evaluation failed');return r.result.value};
const until=async expression=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('UI readiness timed out: '+JSON.stringify(await evaluate('({path:location.pathname,message:document.querySelector("#message")?.textContent,ready:document.body.dataset.ready})')))};
try{
 await send('Page.navigate',{url:origin+'/connect'});await until('document.body.dataset.ready==="true"');
 await evaluate('document.querySelector("#room").value='+JSON.stringify(credentials.roomId)+';document.querySelector("#recovery").value='+JSON.stringify(credentials.recoveryKey)+';document.querySelector("#login button").click()');
 await until('document.querySelector("#signed-in")?.hidden===false');
 assert.equal(await evaluate('document.querySelector("#server-address").textContent.includes("localhost")'),false);
 await evaluate('document.querySelector("#new-code").click()');await until('document.querySelector("#pair-code")?.textContent.length===8');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 const mobile=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.equal(mobile.width,mobile.scroll);
 await evaluate('document.querySelector("#pair-code").style.visibility="hidden";document.querySelector("#room-id").style.visibility="hidden"');
 const image=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('runtime/paired-'+port+'/connect-mobile.png',Buffer.from(image.data,'base64'));
 await send('Page.navigate',{url:origin+'/recognition'});
 await until('document.querySelector("#target-count")?.textContent==="7개" && document.querySelector("#vision-build")?.textContent.includes("region-v14-fast-photo")');
 assert.equal(await evaluate('document.querySelector("#connection-access").hidden'),false);
 const status={login:true,pairingCodeShown:true,mobileOverflow:false,ownTargets:7,connectionManagementVisible:true};
 await fs.writeFile('runtime/paired-'+port+'/ui-validation.json',JSON.stringify(status,null,2));console.log(JSON.stringify(status));
}finally{socket.close()}
