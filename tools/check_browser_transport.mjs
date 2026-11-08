// Connect to a dedicated Chrome debugging tab. Read-only monitoring comparison;
// never presses capture/play controls or submits detections.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
const [debugUrl,origin='http://localhost:8787',report='runtime/checks/browser-transport.json']=process.argv.slice(2);
if(!debugUrl)throw Error('Usage: node tools/check_browser_transport.mjs <CDP-websocket-url> [local-origin] [report]');
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use an isolated local server');
const baseline=execFileSync('git',['show','8937a26:cloud/app.js'],{encoding:'utf8'});
const socket=new WebSocket(debugUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
const pending=new Map();let seq=0,phase=null,collect=false,override=false;
const results={before:{http:0,stateMessages:0,errors:[]},after:{http:0,stateMessages:0,errors:[]}};
const paths=new Set(['/status','/recognition/status','/recognition/snapshot','/cam/stats']);
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
socket.onmessage=({data})=>{
 const message=JSON.parse(data);if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result)}return}
 if(message.method==='Fetch.requestPaused'){
   const {requestId,request}=message.params;
   if(override&&new URL(request.url).pathname==='/cloud/app.js')send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript'}],body:Buffer.from(baseline).toString('base64')}).catch(()=>{});
   else send('Fetch.continueRequest',{requestId}).catch(()=>{});
 }
 if(!phase)return;
 if(collect&&message.method==='Network.requestWillBeSent'&&paths.has(new URL(message.params.request.url).pathname))results[phase].http++;
 if(collect&&message.method==='Network.webSocketFrameReceived')try{if(JSON.parse(message.params.response.payloadData).type==='state')results[phase].stateMessages++}catch{}
 if(message.method==='Runtime.exceptionThrown')results[phase].errors.push(message.params.exceptionDetails.text);
};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await send('Network.enable');await send('Runtime.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
 await send('Fetch.enable',{patterns:[{urlPattern:'*/cloud/app.js*',requestStage:'Request'}]});
 for(const name of ['before','after']){
   phase=name;override=name==='before';collect=false;
   await send('Page.navigate',{url:origin+'/recognition?transport-check='+name});
   for(let n=0;n<150;n++){
     const r=await send('Runtime.evaluate',{expression:'document.querySelector("#vision-build")?.textContent',returnByValue:true});
     if(r.result?.value?.includes('region-v14-fast-photo'))break;
     if(n===149)throw Error('Recognition UI did not initialize');await delay(100);
   }
   await delay(3000);collect=true;await delay(20000);collect=false;
   const r=await send('Runtime.evaluate',{expression:'document.querySelector("#connection")?.textContent',returnByValue:true});results[name].connection=r.result?.value;
 }
 results.reduction=results.before.http?1-results.after.http/results.before.http:0;
 results.secondsPerPhase=20;results.hardwareVideoValidated=false;
 await fs.mkdir(new URL('../runtime/checks/',import.meta.url),{recursive:true});await fs.writeFile(report,JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
 if(results.reduction<.8||!results.after.stateMessages||results.after.errors.length)throw Error('State subscription acceptance failed');
}finally{socket.close()}
