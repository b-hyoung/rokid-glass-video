// Exercise the committed cam.mjs byte-for-byte without starting a local web server.
// Only its home directory and request/response objects are isolated for the test.
// Usage: node --experimental-vm-modules tools/check_original_pipeline.mjs AUD.h264 [seconds] [output.json]
import vm from 'node:vm';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const ref='b321635',root=resolve(import.meta.dirname,'..');
const [file,duration='20',output]=process.argv.slice(2);
if(!file)throw Error('Supply an Annex-B H.264 file with AUD delimiters and at least 180 frames.');
const seconds=Number(duration);
if(!Number.isFinite(seconds)||seconds<3||seconds>120)throw Error('Duration must be 3–120 seconds.');
const source=execFileSync('git',['show',`${ref}:server/cam.mjs`],{cwd:root,encoding:'utf8'});
const data=readFileSync(file),starts=[];
for(let i=0;i<data.length-4;i++)if(data[i]===0&&data[i+1]===0&&data[i+2]===1&&(data[i+3]&31)===9)starts.push(i>0&&data[i-1]===0?i-1:i);
if(starts.length<181)throw Error('Need at least 181 access units (180 looping frames plus next boundary).');

const sandbox=mkdtempSync(join(tmpdir(),'rokid-original-')),timers=new Set(),children=[];
const sentAt=[],decodedAt=[],shownAt=[],jpegSizes=[],commands=[],decoderCommands=[];
let stdoutBuffer=Buffer.alloc(0),closed=false;
const makeTimer=kind=>(fn,ms,...args)=>{const timer=globalThis[kind](fn,ms,...args);timers.add(timer);return timer};
const context=vm.createContext({Buffer,console,Date,setTimeout:makeTimer('setTimeout'),setInterval:makeTimer('setInterval'),clearTimeout,clearInterval});
const module=new vm.SourceTextModule(source,{context,identifier:`git:${ref}:server/cam.mjs`});
await module.link(async specifier=>{
  const exports={...await import(specifier)};
  if(specifier==='node:os')exports.homedir=()=>sandbox;
  if(specifier==='node:child_process')exports.spawn=(cmd,args,opts)=>{
    decoderCommands.push([cmd,...args]);const child=spawn(cmd,args,opts);children.push(child);
    child.on('error',e=>{console.error(e);closed=true});
    child.stdout.on('data',part=>{
      stdoutBuffer=Buffer.concat([stdoutBuffer,part]);
      for(;;){const a=stdoutBuffer.indexOf(Buffer.from([255,216]));if(a<0){stdoutBuffer=Buffer.alloc(0);break}
        const end=stdoutBuffer.indexOf(Buffer.from([255,217]),a+2);if(end<0){stdoutBuffer=stdoutBuffer.subarray(a);break}
        decodedAt.push(performance.now());jpegSizes.push(end+2-a);stdoutBuffer=stdoutBuffer.subarray(end+2);
      }
    });return child;
  };
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context});
});
await module.evaluate();
const route=module.namespace.camRoutes({dir:join(sandbox,'server'),send:m=>commands.push(m),json:(res,code,body)=>res.end(JSON.stringify(body))});
function request(path,body){
  return new Promise((resolve,reject)=>{
    const req=new EventEmitter();req.method=body?'POST':'GET';
    const res={writeHead(){},end(text){resolve(text?JSON.parse(text):null)}};
    try{if(!route(req,res,new URL(path,'https://benchmark.invalid')))throw Error('Unmatched route');if(body){req.emit('data',body);req.emit('end')}}catch(e){reject(e)}
  });
}
const viewer=new EventEmitter();viewer.method='GET';
try{
  const cfg=await request('/cam/set?mode=video&fps=60&sec=0&kbps=2000');
  route(viewer,{writeHead(){},write(part){if(Buffer.isBuffer(part)&&part[0]===255&&part[1]===216)shownAt.push(performance.now())}},new URL('https://benchmark.invalid/cam/live.mjpg'));
  const begin=performance.now(),packets=Math.floor(seconds*10);
  for(let seg=0;seg<packets;seg++){
    if(closed)throw Error('Decoder exited unexpectedly');
    await delay(Math.max(0,begin+seg*100-performance.now()));
    const part=seg%30,bytes=data.subarray(starts[part*6],starts[part*6+6]),at=performance.now();
    for(let i=0;i<6;i++)sentAt.push(at);
    await request(`/stream?test=${cfg.test}&seg=${seg}&w=1280&h=720&mode=video&fps=60&temp=-1&th=0&bat=-1`,bytes);
  }
  await request(`/stream?test=${cfg.test}&seg=${packets}&end=1&temp=-1&th=0&bat=-1`,Buffer.alloc(0));
  await delay(900);
  const stats=await request('/cam/stats');
  const rate=times=>times.length>1?(times.length-1)*1000/(times.at(-1)-times[0]):0;
  const percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:null};
  const delays=decodedAt.map((at,i)=>at-sentAt[i]);
  const result={at:new Date().toISOString(),ref,sourceSha256:createHash('sha256').update(source).digest('hex'),fixtureSha256:createHash('sha256').update(data).digest('hex'),seconds,inputFrames:sentAt.length,decodedFrames:decodedAt.length,mjpegOutputFrames:shownAt.length,decodedFps:rate(decodedAt),mjpegOutputFps:rate(shownAt),decoderDelayMs:{median:percentile(delays,.5),p95:percentile(delays,.95)},jpegBytesPerFrame:jpegSizes.reduce((a,b)=>a+b,0)/jpegSizes.length,mjpegMbpsAt60fps:jpegSizes.reduce((a,b)=>a+b,0)/jpegSizes.length*60*8/1e6,decoderCommands,serverStats:stats.test,limitations:['No network or camera capture in this benchmark.','MJPEG output is counted at the original server response, not at browser presentation.']};
  if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{
  viewer.emit('close');for(const timer of timers){clearTimeout(timer);clearInterval(timer)}
  for(const child of children)if(child.exitCode===null)child.kill();
  rmSync(sandbox,{recursive:true,force:true});
}
