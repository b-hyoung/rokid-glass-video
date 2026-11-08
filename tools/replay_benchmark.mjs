// Browser/Worker benchmark with hash-locked private fixtures. No cloud API or
// device commands. Missing detections remain failures in the aggregate.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]};
const datasetPath=path.resolve(arg('--dataset','runtime/benchmark/dataset.json'));
const source=path.resolve(arg('--source',root)),dataset=JSON.parse(await fs.readFile(datasetPath,'utf8'));
const assetRoot=path.resolve(arg('--asset-root',root));
const files=new Map(),digest=buffer=>createHash('sha256').update(buffer).digest('hex');
async function fixture(entry){
  const filename=path.resolve(path.dirname(datasetPath),entry.path),bytes=await fs.readFile(filename);
  if(digest(bytes)!==entry.sha256)throw Error('Fixture checksum mismatch: '+entry.path);
  const url='/fixture/'+files.size;files.set(url,bytes);return url;
}
const targets=JSON.parse((await fs.readFile(path.resolve(path.dirname(datasetPath),dataset.targets.path),'utf8')).replace(/^\uFEFF/,''));
if(digest(await fs.readFile(path.resolve(path.dirname(datasetPath),dataset.targets.path)))!==dataset.targets.sha256)throw Error('Targets checksum mismatch');
const cases=[];
for(const scene of dataset.cases){const frames=[];for(const f of scene.frames)frames.push({...f,url:await fixture(f)});cases.push({...scene,frames})}
const release=JSON.parse(await fs.readFile(path.join(assetRoot,'release.json'),'utf8'));
const assets=new Map(release.assets.map(a=>['/'+a.destination,path.join(assetRoot,a.source)]));
for(const asset of release.assets)if(digest(await fs.readFile(path.join(assetRoot,asset.source)))!==asset.sha256)throw Error('Asset checksum mismatch: '+asset.source);
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<title>Offline recognition benchmark</title>');return}
    if(url.pathname==='/dataset'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({targets:targets.targets,cases}));return}
    if(url.pathname==='/runtime-probe.js'){
      res.setHeader('Content-Type','text/javascript');
      res.end(`importScripts('/cloud/ort/ort.wasm.min.js');ort.env.wasm.wasmPaths='/cloud/ort/';ort.env.wasm.numThreads=1;(async()=>{const session=await ort.InferenceSession.create('/cloud/appearance-v1.onnx',{executionProviders:['wasm']});const output=await session.run({image:new ort.Tensor('float32',new Float32Array(3*3*224*224),[3,3,224,224])});postMessage({features:output.features.data.length,finite:output.features.data.every(Number.isFinite)})})().catch(e=>postMessage({error:e.message}));`);return;
    }
    if(files.has(url.pathname)){res.setHeader('Content-Type','image/jpeg');res.end(files.get(url.pathname));return}
    const filename=assets.get(url.pathname)||(url.pathname.startsWith('/cloud/')&&path.resolve(source,'.'+url.pathname));
    if(!filename||!assets.has(url.pathname)&&!filename.startsWith(path.join(source,'cloud')+path.sep)){res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',filename.endsWith('.wasm')?'application/wasm':filename.endsWith('.onnx')?'application/octet-stream':'text/javascript');res.end(await fs.readFile(filename));
  }catch{res.writeHead(404);res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'glass-benchmark-'));
const chrome=arg('--chrome',process.env.GLASS_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe');
const browser=spawn(chrome,['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'http://127.0.0.1:'+server.address().port],{stdio:'ignore',windowsHide:true});
let socket,browserError;browser.on('error',e=>browserError=e);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  let port;
  for(let n=0;n<100;n++){if(browserError)throw browserError;try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break}catch{await delay(100)}}
  if(!port)throw Error('Chrome startup timed out');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json(),tab=tabs.find(t=>t.type==='page');
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}};
  const send=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  const pageUrl='http://127.0.0.1:'+server.address().port+'/';
  await send('Page.navigate',{url:pageUrl});
  for(let n=0;n<100;n++){
    const loaded=await send('Runtime.evaluate',{expression:'location.href === '+JSON.stringify(pageUrl)+' && document.readyState === "complete"',returnByValue:true});
    if(loaded.result?.value===true)break;
    if(n===99)throw Error('Benchmark page load timed out');
    await delay(50);
  }
  const expression=`(async()=>{
    const {VisionClient}=await import('/cloud/vision-client.js');
    const vision=new VisionClient();await vision.ready;
    const data=await(await fetch('/dataset')).json();await vision.references(data.targets);const results=[];
    for(const scene of data.cases){const trials=[];
      for(let trial=0;trial<(scene.repeats||1);trial++){
        await vision.reset();let at=10000,first=new Map();const frames=[];let total=0;
        for(const frame of scene.frames){
          const bitmap=await createImageBitmap(await(await fetch(frame.url)).blob()),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
          canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
          const start=performance.now(),result=await vision.process(canvas,{mode:'recognize',at,aim:scene.aim||{cx:.5,cy:.5}}),wallMs=performance.now()-start;
          total+=wallMs;const ids=result.found.filter(f=>!f.held&&!f.approximate).map(f=>f.id);
          for(const id of ids)if(!first.has(id))first.set(id,total);
          frames.push({ms:result.ms,wallMs,ids,expected:frame.expected||scene.expected||[],corners:result.found.map(f=>({id:f.id,corners:f.corners}))});at+=scene.intervalMs||650;
        }
        const expected=scene.expected||[],missed=expected.filter(id=>!first.has(id));
        const unexpected=(scene.checkUnexpected===true||!expected.length)?[...new Set(frames.flatMap(f=>f.ids).filter(id=>!expected.includes(id)))]:[];
        trials.push({frames,first:Object.fromEntries(first),missed,unexpected,success:!missed.length&&!unexpected.length});
      }
      results.push({name:scene.name,expected:scene.expected||[],trials});
    }
    vision.worker.terminate();
    const model=${process.argv.includes('--verify-model')}?await new Promise((resolve,reject)=>{const worker=new Worker('/runtime-probe.js');worker.onmessage=({data})=>{worker.terminate();data.error?reject(Error(data.error)):resolve(data)};worker.onerror=e=>reject(Error(e.message))}):null;
    return {engine:vision.version,cases:results,model};
  })()`;
  const timeout=setTimeout(()=>{for(const p of pending.values())p.reject(Error('Benchmark timed out'))},180000);
  let evaluated;try{evaluated=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})}finally{clearTimeout(timeout)}
  if(evaluated.exceptionDetails)throw Error(JSON.stringify(evaluated.exceptionDetails));
  const result=evaluated.result.value;
  const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
  result.summary=result.cases.map(c=>{const times=c.trials.flatMap(t=>c.expected.map(id=>t.first[id]??null));const misses=times.filter(t=>t===null).length;const known=times.filter(t=>t!==null),unexpected=c.trials.reduce((n,t)=>n+t.unexpected.length,0);return {name:c.name,attempts:times.length,misses,unexpected,successfulMedianMs:percentile(known,.5),successfulP95Ms:percentile(known,.95),allPassed:!misses&&!unexpected}});
  result.datasetSha256=digest(await fs.readFile(datasetPath));result.hardwareValidated=false;result.source=source;
  const report=path.resolve(arg('--report','runtime/benchmark/latest.json'));await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify(result,null,2));
  console.log(JSON.stringify({report,engine:result.engine,summary:result.summary,model:result.model}));
  if(result.model&&(!result.model.finite||result.model.features!==1728))throw Error('Appearance model smoke check failed');
  if(process.argv.includes('--require-all')&&result.summary.some(c=>!c.allPassed))process.exitCode=1;
}finally{
  socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));
  // Profile is deliberately left under OS temp if Chrome still holds files.
}
