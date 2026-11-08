// Local development only. The live room uses the production protocol, while
// file replay has a separate namespace so it cannot command connected glasses.
import cloudWorker,{GlassRoom} from '../cloud/worker.mjs';

const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

export function videoRange(header,length){
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||!length||!match[1]&&!match[2])return null;
  const start=match[1]?Number(match[1]):Math.max(0,length-Number(match[2]));
  const end=match[1]&&match[2]?Math.min(length-1,Number(match[2])):length-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=length||end<start||!match[1]&&Number(match[2])===0)return null;
  return {start,end};
}

async function videoAsset(request,env){
  const headers=new Headers(request.headers);headers.delete('Range');
  const response=await env.ASSETS.fetch(new Request(request.url,{headers,method:request.headers.has('Range')?'GET':request.method}));
  if(!response.ok)return response;
  if(!request.headers.has('Range')){const out=new Headers(response.headers);out.set('Accept-Ranges','bytes');return new Response(response.body,{status:response.status,headers:out})}
  const bytes=await response.arrayBuffer(),range=videoRange(request.headers.get('Range'),bytes.byteLength);
  if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.byteLength}`}});
  return new Response(request.method==='HEAD'?null:bytes.slice(range.start,range.end+1),{status:206,headers:{
    'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    'Content-Length':String(range.end-range.start+1),'Cache-Control':'no-cache'
  }});
}

export {validateSnapshot as localTargets} from '../cloud/library-snapshot.mjs';
import {validateSnapshot as localTargets,restoreSnapshot} from '../cloud/library-snapshot.mjs';

export class LocalGlassRoom extends GlassRoom {
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/status'){const response=await super.fetch(request);if(!response.ok)return response;return json({...await response.json(),hosting:'local'})}
    if(url.pathname!=='/local/import')return super.fetch(request);
    if(request.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
    try{
      const text=await request.text();if(text.length>32*1024*1024)throw Error('가져올 등록 데이터가 너무 큽니다.');
      const data=localTargets(JSON.parse(text),await this.videos(request));
      if(!this.previewOnly&&this.store.list().length)return json({ok:true,skipped:true,reason:'기존 로컬 등록 데이터를 유지했습니다.'});
      return json(restoreSnapshot(this,data,{replace:!!this.previewOnly}));
    }catch(error){return json({error:error.message},400)}
  }
}

export class LocalPreviewRoom extends LocalGlassRoom {
  constructor(ctx,env){super(ctx,env);this.previewOnly=true}
  async fetch(request){
    if(new URL(request.url).pathname==='/local/reset'&&request.method==='POST'){
      this.playback.stop();this.commands=[];this.active=false;this.rearm=false;this.reset();
      return json({ok:true,epoch:this.epoch});
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(/^\/v\/[\w.-]+\.mp4$/.test(url.pathname)&&['GET','HEAD'].includes(request.method))return videoAsset(request,env);
    if(url.pathname==='/preview/sync'&&request.method==='POST'){
      const live=env.ROOM.get(env.ROOM.idFromName('glasses-main'));
      const targets=await(await live.fetch(new Request(new URL('/recognition/targets',url)))).json();
      const status=await(await live.fetch(new Request(new URL('/recognition/guide',url)))).json();
      const guide={shape:status.shape,hud:status.hud,camera:status.camera,calibrated:status.calibrated};
      return env.PREVIEW.get(env.PREVIEW.idFromName('file-replay')).fetch(new Request(new URL('/local/import',url),{method:'POST',body:JSON.stringify({...targets,guide})}));
    }
    if(url.pathname.startsWith('/preview/')){
      url.pathname=url.pathname.slice('/preview'.length);
      return env.PREVIEW.get(env.PREVIEW.idFromName('file-replay')).fetch(new Request(url,request));
    }
    if(url.pathname==='/local/import')return env.ROOM.get(env.ROOM.idFromName('glasses-main')).fetch(request);
    return cloudWorker.fetch(request,env);
  }
};
