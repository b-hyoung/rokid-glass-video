// Local development only. The live room uses the production protocol, while
// file replay has a separate namespace so it cannot command connected glasses.
import cloudWorker,{GlassRoom} from '../cloud/worker.mjs';
import {MAX_IMAGES,MAX_TARGETS} from '../cloud/target-store.mjs';
import {validateVectors} from '../cloud/appearance-format.mjs';
import {guideConfig} from '../cloud/registration-guide.mjs';

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

export function localTargets(data,videos){
  if(!Array.isArray(data.targets)||data.targets.length>MAX_TARGETS)throw Error('등록 대상 목록을 확인하세요.');
  const ids=new Set();
  const targets=data.targets.map(target=>{
    if(typeof target.id!=='string'||!target.id||target.id.length>80||ids.has(target.id))throw Error('대상 ID가 잘못됐거나 중복됐습니다.');
    ids.add(target.id);
    if(typeof target.name!=='string'||!target.name.trim()||!Object.hasOwn(videos,target.key))throw Error('대상 이름과 연결 영상을 확인하세요.');
    if(!Array.isArray(target.images)||target.images.length>MAX_IMAGES)throw Error('대상당 사진은 최대 60장입니다.');
    const appearance=target.appearance?validateVectors(target.appearance):null;
    if(!target.images.length&&!appearance)throw Error('사진이나 벡터가 없는 대상은 가져올 수 없습니다.');
    const images=target.images.map(image=>{
      if(typeof image.image!=='string'||image.image.length>700000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image.image))throw Error('등록 사진 형식이나 용량을 확인하세요.');
      return {image:image.image,capture:image.capture??null};
    });
    return {id:target.id,name:target.name.trim().slice(0,60),key:target.key,images,appearance};
  });
  return {targets,guide:data.guide?guideConfig(data.guide):null};
}

export class LocalGlassRoom extends GlassRoom {
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/status'){const response=await super.fetch(request);return json({...await response.json(),hosting:'local'})}
    if(url.pathname!=='/local/import')return super.fetch(request);
    if(request.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
    try{
      const text=await request.text();if(text.length>32*1024*1024)throw Error('가져올 등록 데이터가 너무 큽니다.');
      const data=localTargets(JSON.parse(text),await this.videos(request));
      if(!this.previewOnly&&this.store.list().length)return json({ok:true,skipped:true,reason:'기존 로컬 등록 데이터를 유지했습니다.'});
      this.ctx.storage.transactionSync(()=>{
        if(this.previewOnly)for(const table of ['target_batches','target_image_info','target_images','target_vectors','targets'])this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
        for(const target of data.targets){
          this.ctx.storage.sql.exec('INSERT INTO targets VALUES (?,?,?,NULL)',target.id,target.name,target.key);
          for(const image of target.images){const id=this.store.addImage(target.id,image.image);if(image.capture)this.ctx.storage.sql.exec('INSERT INTO target_image_info VALUES (?,?)',id,JSON.stringify(image.capture))}
          if(target.appearance)this.ctx.storage.sql.exec('INSERT INTO target_vectors VALUES (?,?)',target.id,JSON.stringify(target.appearance));
        }
        if(data.guide)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO registration_settings VALUES (1,?)',JSON.stringify(data.guide));
      });
      if(data.guide)this.guide.config=data.guide;
      this.playback.stop();this.active=false;this.changed();
      return json({ok:true,count:data.targets.length,images:data.targets.reduce((n,t)=>n+t.images.length,0)});
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
