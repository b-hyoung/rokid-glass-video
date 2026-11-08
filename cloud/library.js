const $=s=>document.querySelector(s);
export class TargetLibrary {
  constructor({api,crop,onSaved}) {
    this.api=api;this.crop=crop;this.onSaved=onSaved;this.targets=[];this.version=0;this.maxImages=60;this.videos={};this.activeId=null;this.previewId=null;this.saving=false;
    try{this.activeId=localStorage.getItem('rokid.target')}catch{}
    $('#new-target').onclick=()=>{this.select(null);$('#name').value='';$('#name').focus()};
    $('#target-picker').onchange=()=>this.select($('#target-picker').value||null);
    $('#add').onclick=()=>this.add();
    $('#delete-image').onclick=()=>this.removeImage();
    $('#vector-import').onclick=()=>this.importVectors();
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
    $('#target-count').textContent=this.targets.length+'개';
    $('#targets').replaceChildren(...this.targets.map(t=>{
      const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='target-choice';button.setAttribute('aria-expanded',String(t.id===this.activeId));button.setAttribute('aria-controls','target-detail');
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
    $('#images-note').textContent=`등록 ${images.length} / ${this.maxImages}장 · 모든 각도는 같은 이름과 영상으로 인식합니다.`;
    const image=images.find(i=>i.id===this.previewId)||images[0];this.previewId=image?.id||null;
    $('#image-gallery').replaceChildren(...images.map((ref,index)=>{
      const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',`${current.name} 등록 이미지 ${index+1} 보기`);button.setAttribute('aria-pressed',String(ref.id===this.previewId));
      const img=document.createElement('img');img.src=ref.image;img.alt='';button.append(img,document.createTextNode(`${index+1}번`));button.onclick=()=>{this.previewId=ref.id;this.render()};return button;
    }));
    $('#image-preview').hidden=!image;if(image){$('#preview-image').src=image.image;$('#preview-image').alt=current.name+' 등록 이미지';$('#preview-caption').textContent=`${images.indexOf(image)+1}번 이미지 · 눌러서 선택한 등록 장면`}
  }
  async importVectors(){
    if(this.saving)return;
    const file=$('#vector-file').files[0], target=this.current();
    if(!file||file.size>230000){$('#vector-status').textContent='230KB 이하 벡터 JSON을 선택하세요.';return;}
    this.saving=true;this.render();
    try{
      const pack=JSON.parse(await file.text());
      const result=await this.api('/recognition/vectors',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({targetId:target?.id,name:$('#name').value,key:$('#video-key').value,pack})});
      this.select(result.targetId);
      await this.reload();
      $('#vector-file').value='';
      $('#vector-status').textContent='벡터를 저장했습니다.';
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
