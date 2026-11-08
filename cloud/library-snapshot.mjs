import {MAX_IMAGES,MAX_TARGETS} from './target-store.mjs';
import {validateVectors} from './appearance-format.mjs';
import {guideConfig} from './registration-guide.mjs';
export function validateSnapshot(data,videos){
  if(!Array.isArray(data.targets)||data.targets.length>MAX_TARGETS)throw Error('등록 대상 목록을 확인하세요.');
  const ids=new Set(),imageIds=new Set();
  const targets=data.targets.map(target=>{
    if(typeof target.id!=='string'||!target.id||target.id.length>80||ids.has(target.id))throw Error('대상 ID가 잘못됐거나 중복됐습니다.');
    ids.add(target.id);
    if(typeof target.name!=='string'||!target.name.trim()||!Object.hasOwn(videos,target.key))throw Error('대상 이름과 연결 영상을 확인하세요.');
    if(!Array.isArray(target.images)||target.images.length>MAX_IMAGES)throw Error('대상당 사진은 최대 60장입니다.');
    // Validate without renormalizing a stored backup. Repeated restores must
    // preserve the original vector components exactly.
    if(target.appearance)validateVectors(target.appearance);
    const appearance=target.appearance?{model:target.appearance.model,vectors:structuredClone(target.appearance.vectors)}:null;
    if(!target.images.length&&!appearance)throw Error('사진이나 벡터가 없는 대상은 가져올 수 없습니다.');
    const images=target.images.map(image=>{
      if(typeof image.image!=='string'||image.image.length>700000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image.image))throw Error('등록 사진 형식이나 용량을 확인하세요.');
      const id=image.id??crypto.randomUUID(),created_at=image.created_at??0;
      if(typeof id!=='string'||!id||id.length>160||imageIds.has(id)||!Number.isSafeInteger(created_at)||created_at<0)throw Error('사진 ID 또는 저장 시간이 잘못됐습니다.');
      imageIds.add(id);
      return {id,created_at,image:image.image,capture:image.capture??null};
    });
    return {id:target.id,name:target.name.trim().slice(0,60),key:target.key,images,appearance};
  });
  return {targets,guide:data.guide?guideConfig(data.guide):null};
}

export function restoreSnapshot(room,data,{replace=false}={}){
  if(!replace&&room.store.list().length)throw Error('기존 등록이 있는 공간에는 덮어쓸 수 없습니다.');
  room.ctx.storage.transactionSync(()=>{
    if(replace)for(const table of ['target_batches','target_image_info','target_images','target_vectors','targets'])room.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    for(const target of data.targets){
      room.ctx.storage.sql.exec('INSERT INTO targets VALUES (?,?,?,NULL)',target.id,target.name,target.key);
      for(const image of target.images){room.ctx.storage.sql.exec('INSERT INTO target_images VALUES (?,?,?,?)',image.id,target.id,image.image,image.created_at);if(image.capture)room.ctx.storage.sql.exec('INSERT INTO target_image_info VALUES (?,?)',image.id,JSON.stringify(image.capture))}
      if(target.appearance)room.ctx.storage.sql.exec('INSERT INTO target_vectors VALUES (?,?)',target.id,JSON.stringify(target.appearance));
    }
    if(data.guide)room.ctx.storage.sql.exec('INSERT OR REPLACE INTO registration_settings VALUES (1,?)',JSON.stringify(data.guide));
  });
  if(data.guide)room.guide.config=data.guide;
  room.playback.stop();room.active=false;room.changed();
  return {ok:true,count:data.targets.length,images:data.targets.reduce((n,t)=>n+t.images.length,0)};
}
