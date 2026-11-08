import {registrationPhoto} from './photo-import.mjs';
const $=s=>document.querySelector(s);
export class TargetLibrary {
  constructor({api,crop,onSaved}) {
    this.api=api;this.crop=crop;this.onSaved=onSaved;this.targets=[];this.version=0;this.maxImages=60;this.videos={};this.activeId=null;this.previewId=null;this.saving=false;
    this.photos=[];this.photoBatch=null;
    try{this.activeId=localStorage.getItem('rokid.target')}catch{}
    $('#new-target').onclick=()=>{this.select(null);$('#name').value='';$('#name').focus()};
    $('#target-picker').onchange=()=>this.select($('#target-picker').value||null);
    $('#add').onclick=()=>this.add();
    $('#photo-files').onchange=()=>this.choosePhotos();
    $('#photo-import').onclick=()=>this.importPhotos();
    $('#delete-image').onclick=()=>this.removeImage();
    $('#vector-import').onclick=()=>this.importVectors();
    $('#vector-folder').onchange=()=>{
      $('#vector-file').value='';
      $('#vector-images').value='';
    };
    $('#vector-file').onchange=$('#vector-images').onchange=()=>{$('#vector-folder').value=''};
    $('#vector-remove').onclick=()=>this.removeVectors();
    $('#delete-target').onclick=()=>this.removeTarget();
  }
  current(){return this.targets.find(t=>t.id===this.activeId)}
  select(id){this.activeId=id;this.previewId=null;try{if(id)localStorage.setItem('rokid.target',id);else localStorage.removeItem('rokid.target')}catch{}this.render()}
  async sync(version){if(version!==this.version)await this.reload()}
  async reload(){if(this.inflight)await this.inflight;this.inflight=this.api('/recognition/targets').then(r=>{this.targets=r.targets;this.version=r.version;this.maxImages=r.maxImages||60;if(this.activeId&&!this.current())this.activeId=null;this.render()});try{await this.inflight}finally{this.inflight=null}}
  render(){
    const current=this.current();
    const createOption=new Option('＋ 새 대상 만들기','');
    $('#target-picker').replaceChildren(createOption,...this.targets.map(t=>new Option(t.name+' · '+t.images.length+'장',t.id)));
    $('#target-picker').value=current?.id||'';
    for(const id of ['new-target','target-picker','name','video-key','photo-files','delete-image','delete-target'])$('#'+id).disabled=this.saving;
    $('#target-count').textContent=this.targets.length+'개';
    $('#targets').replaceChildren(...this.targets.map(t=>{
      const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='target-choice';button.setAttribute('aria-expanded',String(t.id===this.activeId));button.setAttribute('aria-controls','target-detail');
      button.disabled=this.saving;
      const first=t.images?.[0];if(first){const img=document.createElement('img');img.src=first.image;img.alt='';button.append(img)}
      const text=document.createElement('span');text.className='target-copy';const name=document.createElement('strong');name.textContent=t.name;const count=document.createElement('small');count.textContent='등록 이미지 '+(t.images?.length||0)+'장';text.append(name,count);button.append(text);button.onclick=()=>this.select(t.id);li.append(button);return li;
    }));
    $('#library-empty').hidden=!!this.targets.length;$('#new-target-fields').hidden=!!current;
    $('#add').disabled=this.saving||!!(current&&current.images.length>=this.maxImages);
    $('#add').textContent=this.saving?'저장 중…':current?'「'+current.name+'」에 이미지 추가':'새 대상과 첫 이미지 등록';
    $('#add-guide').textContent=current?`「${current.name}」의 다른 각도를 안경으로 보고, 화면에서 영역을 선택한 뒤 추가하세요.`:'안경 화면에서 물건 영역을 선택하고 이름과 영상을 정해 등록하세요.';
    const images=current?.images||[];
    $('#target-name').textContent=current?.name||'새 대상';
    $('#target-video').textContent=current?'재생 영상 · '+(this.videos[current.key]?.title||current.key):'이름과 연결 영상을 정하고 첫 이미지를 등록하세요.';
    $('#image-count').textContent=images.length+'장';
    $('#gallery-empty').hidden=!!images.length;
    $('#delete-target').hidden=!current;
    $('#vector-remove').hidden=!current?.appearance;
    $('#vector-import').disabled=this.saving;
    $('#vector-remove').disabled=this.saving;
    const remaining=this.maxImages-images.length;
    $('#photo-import').disabled=this.saving||!this.photos.length||this.photos.length>remaining;
    $('#photo-import').textContent=this.importingPhotos?'사진 저장 중…':current?'선택한 사진을 이 대상에 추가':'선택한 사진으로 새 대상 등록';
    $('#photo-note').textContent=`${this.photos.length}장 선택 · ${current?'「'+current.name+'」에':'새 대상에'} 최대 ${remaining}장 추가 가능`;
    $('#images-note').textContent=`등록 ${images.length} / ${this.maxImages}장 · 모든 각도는 같은 이름과 영상으로 인식합니다.`;
    const image=images.find(i=>i.id===this.previewId)||images[0];this.previewId=image?.id||null;
    $('#image-gallery').replaceChildren(...images.map((ref,index)=>{
      const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',`${current.name} 등록 이미지 ${index+1} 보기`);button.setAttribute('aria-pressed',String(ref.id===this.previewId));
      const img=document.createElement('img');img.src=ref.image;img.alt='';button.append(img,document.createTextNode(`${index+1}번`));button.onclick=()=>{this.previewId=ref.id;this.render()};return button;
    }));
    $('#image-preview').hidden=!image;if(image){$('#preview-image').src=image.image;$('#preview-image').alt=current.name+' 등록 이미지';$('#preview-caption').textContent=`${images.indexOf(image)+1}번 이미지 · 눌러서 선택한 등록 장면`}
  }
  choosePhotos(){
    for(const photo of this.photos)URL.revokeObjectURL(photo.url);
    this.photos=[];this.photoBatch=null;
    const files=Array.from($('#photo-files').files);
    if(files.length>this.maxImages||files.some(file=>!/^image\/(jpeg|png|webp)$/.test(file.type))){
      $('#photo-files').value='';$('#photo-status').textContent=`JPG·PNG·WebP 사진을 최대 ${this.maxImages}장 선택하세요.`;
    }else{
      this.photos=files.map(file=>({file,url:URL.createObjectURL(file)}));
      $('#photo-status').textContent='';
    }
    $('#photo-previews').replaceChildren(...this.photos.map(({file,url})=>{
      const item=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');
      image.src=url;image.alt=file.name;caption.textContent=file.name;item.append(image,caption);return item;
    }));
    this.render();
  }
  async importPhotos(){
    if(this.saving)return;
    const current=this.current(),target={targetId:current?.id,name:current?.name||$('#name').value.trim(),key:current?.key||$('#video-key').value};
    if(!this.photos.length){$('#photo-status').textContent='등록할 사진을 선택하세요.';return;}
    if(!target.name||!target.key){$('#photo-status').textContent='새 대상 이름과 연결할 영상을 선택하세요.';return;}
    if(this.photos.length+(current?.images.length||0)>this.maxImages){$('#photo-status').textContent=`이 대상에 추가할 수 있는 사진은 ${this.maxImages-(current?.images.length||0)}장입니다.`;return;}
    const identity=JSON.stringify(target);
    if(this.photoBatch?.identity!==identity)this.photoBatch={identity,batchId:crypto.randomUUID()};
    this.saving=true;this.importingPhotos=true;this.render();
    try{
      const images=[];
      for(const {file} of this.photos){
        $('#photo-status').textContent=`사진 준비 중 · ${images.length+1} / ${this.photos.length}장`;
        images.push({image:await registrationPhoto(file),capture:{source:'photo',filename:file.name}});
      }
      $('#photo-status').textContent=`사진 ${images.length}장 저장 중…`;
      const result=await this.api('/recognition/images/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...target,images,batchId:this.photoBatch.batchId})});
      this.select(result.targetId);this.previewId=result.imageIds?.[0]||null;
      $('#photo-files').value='';this.choosePhotos();
      $('#photo-status').textContent=`「${target.name}」에 사진 ${result.count}장을 등록했습니다.`;
      await this.reload();
    }catch(error){$('#photo-status').textContent=error.message}
    finally{this.saving=false;this.importingPhotos=false;this.render()}
  }
  async importVectors(){
    if(this.saving)return;
    const folder=Array.from($('#vector-folder').files);
    const jsonFiles=folder.filter(file=>/\.json$/i.test(file.name));
    const target=this.current();
    const file=folder.length?jsonFiles[0]:$('#vector-file').files[0];
    if(folder.length && jsonFiles.length!==1){$('#vector-status').textContent='대상 하나의 벡터 JSON만 들어 있는 폴더를 선택하세요.';return;}
    const photos=folder.length?folder.filter(file=>/\.(jpe?g|png|webp)$/i.test(file.name)):Array.from($('#vector-images').files);
    if(!photos.length&&!target?.images.length){$('#vector-status').textContent='벡터와 같은 물체의 참조 사진을 함께 등록하세요.';return;}
    if(photos.length+(target?.images.length||0)>this.maxImages){$('#vector-status').textContent='대상당 사진을 최대 '+this.maxImages+'장 등록할 수 있습니다.';return;}
    if(!file||file.size>230000){$('#vector-status').textContent='230KB 이하 벡터 JSON을 선택하세요.';return;}
    this.saving=true;this.render();
    try{
      const pack=JSON.parse(await file.text());
      const images=[];
      for(const photo of photos){
        const bitmap=await createImageBitmap(photo);
        try{
          const canvas=document.createElement('canvas');
          const scale=Math.min(1,640/Math.max(bitmap.width,bitmap.height));
          canvas.width=Math.max(1,Math.round(bitmap.width*scale));
          canvas.height=Math.max(1,Math.round(bitmap.height*scale));
          canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
          images.push(canvas.toDataURL('image/jpeg',.85));
        }finally{bitmap.close()}
      }
      const result=await this.api('/recognition/vectors',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({targetId:target?.id,name:$('#name').value||pack.target,key:$('#video-key').value,pack,images})});
      this.select(result.targetId);
      await this.reload();
      $('#vector-file').value='';
      $('#vector-images').value='';
      $('#vector-folder').value='';
      $('#vector-status').textContent=images.length?`벡터와 사진 ${images.length}장을 같은 대상에 저장했습니다.`:'벡터를 저장했습니다.';
    }catch(error){$('#vector-status').textContent=error.message}
    finally{this.saving=false;this.render()}
  }
  async removeVectors(){
    const target=this.current();
    if(!target?.appearance||this.saving)return;
    if(!confirm('벡터를 제거할까요? 이미지가 없는 대상은 목록에서도 삭제됩니다.'))return;
    this.saving=true;this.render();
    try{
      await this.api('/recognition/vectors?targetId='+encodeURIComponent(target.id),{method:'DELETE'});
      await this.reload();
      $('#vector-status').textContent='벡터를 제거했습니다.';
    }catch(error){$('#vector-status').textContent=error.message}
    finally{this.saving=false;this.render()}
  }
  async add(){
    if(this.saving)return;this.saving=true;this.render();
    try{
      const image=this.crop(),current=this.current();let data;
      if(current)data=await this.api('/recognition/images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetId:current.id,image})});
      else data=await this.api('/recognition/targets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#name').value,key:$('#video-key').value,image})});
      this.activeId=data.targetId;this.previewId=data.imageId||null;try{localStorage.setItem('rokid.target',data.targetId)}catch{}
      this.onSaved();await this.reload();$('#selection').textContent='이미지를 저장했습니다. 다른 각도도 같은 대상에 추가할 수 있습니다.';
    }catch(e){$('#selection').textContent=e.message}finally{this.saving=false;this.render()}
  }
  async removeImage(){
    const t=this.current();if(!t||!this.previewId)return;
    if(!confirm('선택한 등록 이미지 한 장을 삭제할까요?'))return;
    try{await this.api('/recognition/images?targetId='+encodeURIComponent(t.id)+'&id='+encodeURIComponent(this.previewId),{method:'DELETE'});await this.reload()}catch(e){$('#selection').textContent=e.message}
  }
  async removeTarget(){
    const t=this.current();if(!t||!confirm(`「${t.name}」과 등록 이미지 ${t.images.length}장을 모두 삭제할까요?`))return;
    try{await this.api('/recognition/targets?id='+encodeURIComponent(t.id),{method:'DELETE'});this.select(null);await this.reload()}catch(e){$('#selection').textContent=e.message}
  }
}
