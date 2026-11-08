import {json} from '../request-policy.mjs';
import {MAX_IMAGES} from '../target-store.mjs';
import {validateVectors} from '../appearance-format.mjs';

export async function handleLibrary(req,u){
  const p=u.pathname,q=u.searchParams;
    if(p==='/recognition/guide'){
      if(req.method==='GET')return json(this.guide.read());
      if(req.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
      try{const text=await req.text();if(text.length>4096)throw Error('가이드 설정이 너무 큽니다.');const d=JSON.parse(text);const before=this.guide.read().enabled;const guide=this.guide.update(d);if(guide.enabled&&!before){this.active=false;this.reset()}return json(guide)}catch(e){return json({error:e.message},400)}
    }
    if(p==='/recognition/images/batch'&&req.method==='POST'){
      try{
        const text=await req.text();if(text.length>8*1024*1024)throw Error('한 번에 저장할 이미지 용량이 너무 큽니다.');const d=JSON.parse(text);
        if(!Array.isArray(d.images)||!d.images.length||d.images.length>MAX_IMAGES)throw Error('저장할 이미지를 1~60장 선택하세요.');
        if(typeof d.batchId!=='string'||d.batchId.length<8||d.batchId.length>80)throw Error('잘못된 등록 묶음입니다.');
        if(!d.targetId&&(typeof d.name!=='string'||!d.name.trim()||!(await this.videos(req))[d.key]))throw Error('대상 이름과 연결 영상을 선택하세요.');
        const images=d.images.map(item=>{
          if(typeof item.image!=='string'||item.image.length>700000||!/^data:image\/jpeg;base64,/.test(item.image))throw Error('선택한 장면의 이미지가 필요합니다.');
          const raw=item.capture||{},capture=raw.source==='photo'
            ?{source:'photo',filename:String(raw.filename||'').slice(0,255)}
            :{source:'video',atMs:Math.max(0,Math.min(120000,Number(raw.atMs)||0)),sharpness:Math.max(0,Math.min(1e6,Number(raw.sharpness)||0)),features:Math.max(0,Math.min(10000,Number(raw.features)||0))};
          return {image:item.image,capture};
        });
        const result=this.store.addBatch({targetId:d.targetId,name:d.name?.trim().slice(0,60),key:d.key,images,batchId:d.batchId});this.changed();return json(result);
      }catch(e){return json({error:e.message},400)}
    }
    if (p === '/recognition/vectors' && req.method === 'POST') {
      try {
        const text = await req.text();
        if (text.length > 8*1024*1024) return json({error:'등록 묶음이 너무 큽니다.'}, 413);
        const {targetId, name, key, pack, images=[]} = JSON.parse(text);
        if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(image =>
          typeof image !== 'string' || image.length > 700000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image))) {
          throw Error('등록 사진 형식이나 용량을 확인하세요.');
        }
        if (!targetId && (typeof name !== 'string' || !name.trim() ||
            !Object.hasOwn(await this.videos(req), key))) {
          throw Error('대상 이름과 연결 영상을 선택하세요.');
        }
        const id = this.store.saveVectors({targetId, name:name?.trim().slice(0,60), key, pack:validateVectors(pack), images});
        this.changed();
        return json({ok:true, targetId:id});
      } catch (error) { return json({error:error.message}, 400); }
    }
    if (p === '/recognition/vectors' && req.method === 'DELETE') {
      this.store.deleteVectors(q.get('targetId'));
      this.changed();
      return json({ok:true});
    }
    if(p==='/recognition/targets'&&req.method==='GET')return json({version:this.version,maxImages:MAX_IMAGES,targets:this.targets(true)});
    if((p==='/recognition/targets'||p==='/recognition/images')&&req.method==='POST'){
      const text=await req.text();if(text.length>700000)return json({error:'등록 이미지를 더 작게 선택하세요'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'잘못된 등록 요청'},400)}
      if(!/^data:image\/jpeg;base64,/.test(d.image||''))return json({error:'선택한 영역의 이미지가 필요합니다.'},400);
      try {
        let targetId=d.targetId, imageId;
        if(p==='/recognition/targets'){
          if(typeof d.name!=='string'||!d.name.trim()||!(await this.videos(req))[d.key])return json({error:'대상 이름과 연결할 영상이 필요합니다.'},400);
          targetId=this.store.create(d.name.trim().slice(0,60),d.key,d.image);
        } else imageId=this.store.addImage(targetId,d.image);
        this.changed();return json({ok:true,targetId,imageId});
      } catch(e){return json({error:e.message},400)}
    }
    if(p==='/recognition/targets'&&req.method==='DELETE'){this.store.deleteTarget(q.get('id'));this.changed();return json({ok:true})}
    if(p==='/recognition/images'&&req.method==='DELETE'){this.store.deleteImage(q.get('targetId'),q.get('id'));this.changed();return json({ok:true})}
}
