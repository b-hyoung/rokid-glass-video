// Isolated delivery experiment. Never bind this Worker to the production namespace.
import fixture from './build/fixture.h264';
import {pack} from '../../cloud/stream-protocol.mjs';
import {GlassRoom} from '../../cloud/worker.mjs';
export {GlassRoom};

const bytes=new Uint8Array(fixture),starts=[];
for(let i=0;i<bytes.length-4;i++)if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1&&(bytes[i+3]&31)===9)starts.push(i>0&&bytes[i-1]===0?i-1:i);
const packets=Array.from({length:30},(_,i)=>bytes.subarray(starts[i*6],starts[i*6+6]));
function paced(request){
  const url=new URL(request.url),count=Math.min(600,Math.max(100,Number(url.searchParams.get('packets'))||200));
  const test=Date.now();let timer,stopped=false,seg=0;
  const stream=new ReadableStream({start(controller){
    const stop=()=>{if(stopped)return;stopped=true;clearInterval(timer);try{controller.close()}catch{}};
    request.signal.addEventListener('abort',stop,{once:true});
    timer=setInterval(()=>{
      if(stopped)return;
      if(seg===count){stop();return}
      // Backpressure stops this synthetic test, never silently drops a packet.
      if(controller.desiredSize<=0){clearInterval(timer);stopped=true;controller.error(Error('Benchmark client stopped reading'));return}
      const meta={kind:'h264',test,seg,n:seg+1,at:Date.now(),fps:60,frames:6,complete:true};
      const inner=new Uint8Array(pack(meta,packets[seg%30])),data=new Uint8Array(inner.length+4);
      new DataView(data.buffer).setUint32(0,inner.length);data.set(inner,4);
      try{controller.enqueue(data);seg++}catch{stop()}
    },100);
  },cancel(){stopped=true;clearInterval(timer)}},new ByteLengthQueuingStrategy({highWaterMark:128*1024}));
  return new Response(stream,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store, no-transform','Content-Encoding':'identity','X-Test-Route':url.pathname,'X-Ingress-Colo':request.cf?.colo||'unknown'}});
}
export class Pacer {fetch(request){return paced(request)}}
export default {
  fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    if(path==='/paced/edge')return paced(request);
    if(path==='/paced/do-default'||path==='/paced/do-apac'){
      const apac=path.endsWith('apac'),id=env.PACER.idFromName(apac?'pacer-apac':'pacer-default');
      return env.PACER.get(id,apac?{locationHint:'apac-ne'}:{}).fetch(request);
    }
    if(path==='/health')return Response.json({fixtureBytes:bytes.length,accessUnits:starts.length,colo:request.cf?.colo});
    if(path==='/'||path==='/recognition')return env.ASSETS.fetch(new Request(new URL('/cloud/index.html',url),request));
    if(path.startsWith('/cloud/')||path.startsWith('/v/')||path==='/videos.json')return env.ASSETS.fetch(request);
    return env.ROOM.get(env.ROOM.idFromName('isolated-upload-check')).fetch(request);
  }
};
