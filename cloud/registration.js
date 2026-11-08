import {DEFAULT_GUIDE} from './registration-guide.mjs';
const $=s=>document.querySelector(s);
const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});

export class Registration {
  constructor({api,library,vision,live,unfreeze}){
    Object.assign(this,{api,library,vision,live,unfreeze});this.owner=crypto.randomUUID();this.config=structuredClone(DEFAULT_GUIDE);this.enabled=false;this.phase='align';this.samples=[];this.server=null;this.queue=Promise.resolve();this.revision=0;
    for(const plane of ['hud','camera'])for(const key of ['cx','cy','width','height']){
      const input=$(`#${plane}-${key}`);input.oninput=()=>{const r=this.config[plane];r[key]=+input.value/100;r.cx=Math.max(r.width/2,Math.min(1-r.width/2,r.cx));r.cy=Math.max(r.height/2,Math.min(1-r.height/2,r.cy));this.config.calibrated=false;this.renderControls();clearTimeout(this.debounce);if(this.enabled)this.debounce=setTimeout(()=>this.publish().catch(e=>this.error(e)),180)};
    }
    $('#guide-shape').onchange=()=>{this.config.shape=$('#guide-shape').value;this.config.calibrated=false;this.renderControls();if(this.enabled)this.publish().catch(e=>this.error(e))};
    $('#guide-open').onclick=()=>this.open().catch(e=>this.error(e));
    $('#guide-close').onclick=()=>this.close().catch(e=>this.error(e));
    $('#guide-save').onclick=()=>this.saveAlignment().catch(e=>this.error(e));
    $('#video-register').onclick=()=>this.begin().catch(e=>this.error(e));
    $('#capture-reseed').onclick=()=>{this.seed=true;this.lost=false;this.note='테두리 안의 물체를 다시 잡습니다.';this.render()};
    $('#capture-finish').onclick=()=>this.review();
    $('#samples-save').onclick=()=>this.save().catch(e=>this.error(e));
    $('#samples-discard').onclick=()=>{this.revision++;this.samples=[];this.phase='align';this.render();this.publish().catch(e=>this.error(e))};
    this.api('/recognition/guide').then(d=>{if(!this.enabled){this.config={shape:d.shape,hud:d.hud,camera:d.camera,calibrated:d.calibrated};this.server=d;this.renderControls();this.render()}}).catch(e=>this.error(e));
    setInterval(()=>{if(this.enabled&&this.phase==='capture'&&performance.now()-this.started>=30000)this.review();if(this.enabled&&!this.sending)this.publish().catch(e=>this.error(e));this.render()},1200);
    addEventListener('pagehide',()=>{if(this.enabled)fetch('/recognition/guide',{...post({owner:this.owner,enabled:false}),keepalive:true}).catch(()=>{})});
    this.renderControls();this.render();
  }
  error(e){this.note=e.message||String(e);this.render()}
  observe(d){this.server=d;$('#guide-device').textContent=d?.device?'안경 앱 '+d.device.app+' · 가이드 수신 연결됨':'가이드 지원 앱 대기 · 안경에 0.2.9를 설치하고 앱을 켜 주세요.';if(this.enabled&&d?.enabled&&d.owner!==this.owner){this.enabled=false;this.revision++;this.note='다른 화면이 가이드를 사용 중입니다.';this.render()}}
  publish(save=false){
    const data={owner:this.owner,enabled:this.enabled,phase:this.phase,config:structuredClone(this.config),save,message:this.hudMessage(),progress:this.phase==='capture'?Math.min(1,(performance.now()-this.started)/30000):this.phase==='verify'&&this.verified?1:0,count:this.samples.filter(s=>s.keep).length};
    const result=this.queue.catch(()=>{}).then(async()=>{this.sending=true;try{const d=await this.api('/recognition/guide',{...post(data),signal:AbortSignal.timeout(4000)});this.server=d;this.ackAt=performance.now();return d}finally{this.sending=false}});this.queue=result;return result;
  }
  hudMessage(){if(this.phase==='capture')return this.lost?'추적 끊김 · 테두리에 맞추고 PC에서 다시 잡기':`${this.samples.length}장 수집 · 천천히 각도를 바꿔 주세요`;if(this.phase==='review')return '촬영 완료 · PC에서 저장할 장면을 확인하세요';if(this.phase==='verify')return this.verified?'다시 찾기 확인됨 · PC에서 인식을 시작하세요':this.exited?'물체를 다시 바라봐 주세요':'물체를 시야 밖으로 옮긴 뒤 다시 보여 주세요';return '보정 중 · 물체의 같은 모서리를 맞춰 주세요'}
  async open(){await this.api('/stop');this.enabled=true;this.phase='align';this.note='실제 등록할 거리에서 안경 테두리와 웹 저장 영역을 같은 물체에 맞춰 주세요.';try{await this.publish()}catch(e){this.enabled=false;throw e}this.unfreeze();this.render()}
  async close(){if(this.saving)return;this.revision++;this.enabled=false;this.phase='align';this.samples=[];this.corners=null;await this.publish();this.note='가이드를 껐습니다. 인식 시작을 누르면 대상을 찾습니다.';await this.vision.reset();this.render()}
  async saveAlignment(){if(!this.enabled)throw Error('먼저 안경에 가이드를 켜 주세요.');if(!this.server?.device)throw Error('안경 앱 0.2.9의 가이드 연결을 확인해 주세요.');this.config.calibrated=true;try{await this.publish(true)}catch(e){this.config.calibrated=false;throw e}this.note='이 거리의 보정을 저장했습니다. 물체가 저장 영역에 차도록 맞추고 영상 등록을 시작하세요.';this.renderControls();this.render()}
  async begin(){
    if(!this.enabled||!this.config.calibrated)throw Error('가이드를 켜고 테두리 보정을 먼저 저장하세요.');
    if(!this.server?.device)throw Error('안경 앱 0.2.9를 켜 주세요.');
    if(!this.live())throw Error('안경 촬영을 시작하고 실시간 영상이 들어오는지 확인하세요.');
    const current=this.library.current();this.target={targetId:current?.id,name:current?.name||$('#name').value.trim(),key:current?.key||$('#video-key').value};
    if(!this.target.name||!this.target.key)throw Error('대상을 선택하거나 새 대상 이름과 연결 영상을 입력하세요.');
    this.limit=Math.min(45,this.library.maxImages-(current?.images.length||0));if(this.limit<1)throw Error('이 대상의 등록 이미지가 가득 찼습니다. 불필요한 이미지를 먼저 삭제하세요.');
    await this.vision.reset();this.unfreeze();this.revision++;this.samples=[];this.session=crypto.randomUUID();this.batchId=crypto.randomUUID();this.phase='capture';this.started=performance.now();this.seed=true;this.lost=false;this.corners=null;this.note='물체가 테두리를 채우도록 유지하고 천천히 각도를 바꿔 주세요.';await this.publish();this.render();
  }
  options(){
    if(!this.enabled)return null;
    if(this.phase==='capture'){
      if(performance.now()-this.started>=30000||this.samples.length>=this.limit){this.review();return null}
      if(!this.ackAt||performance.now()-this.ackAt>4500){this.lost=true;this.note='가이드 연결이 지연되어 수집을 멈췄습니다. 연결 후 다시 잡기를 누르세요.';this.render();return null}
      if(this.lost&&!this.seed)return null;
      const seed=this.seed;this.seed=false;return {mode:'capture',session:this.session,seed,roi:this.config.camera,elapsed:performance.now()-this.started};
    }
    if(this.phase==='verify'&&!this.verified)return {mode:'verify'};
    return null;
  }
  accept(result){
    if(this.phase==='capture'){
      if(result.lost)this.lost=true;if(result.corners)this.corners=result.corners;if(result.note)this.note=result.note;
      if(result.sample&&this.samples.length<this.limit)this.samples.push({...result.sample,keep:true});this.render();
    }else if(this.phase==='verify'){
      // Only fresh feature matches can pass verification. Optical-flow carryover is insufficient.
      const found=result.found.some(d=>d.id===this.savedId&&!d.tracked);
      if(!found){this.missingAt??=performance.now();this.hits=0;if(performance.now()-this.missingAt>1600)this.exited=true}else{this.missingAt=null;if(this.exited&&++this.hits>=3){this.verified=true;this.note='시야 밖으로 나갔다가 돌아온 대상을 다시 찾았습니다. 가이드 종료 후 인식을 시작해 보세요.'}}
      this.render();
    }
  }
  review(){this.revision++;this.phase='review';this.corners=null;this.note=this.samples.length?'저장할 장면을 확인하세요. 배경이나 다른 물체가 잡힌 장면은 눌러 제외하세요.':'저장할 장면을 얻지 못했습니다. 조명·거리·영역을 조절하고 다시 시작하세요.';this.renderSamples();this.render();this.publish().catch(e=>this.error(e))}
  renderSamples(){
    $('#capture-samples').replaceChildren(...this.samples.map((s,i)=>{const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed',String(s.keep));b.setAttribute('aria-label',`${i+1}번 장면 저장 ${s.keep?'포함':'제외'}`);const img=document.createElement('img');img.src=s.image;img.alt='';b.append(img,document.createTextNode(`${i+1} · ${s.keep?'저장':'제외'}`));b.onclick=()=>{if(this.saving)return;s.keep=!s.keep;this.renderSamples();this.render()};return b}));
  }
  async save(){
    if(this.saving)return;const images=this.samples.filter(s=>s.keep).map(({image,capture})=>({image,capture}));if(!images.length)throw Error('저장할 장면을 한 장 이상 선택하세요.');this.saving=true;this.render();
    try{const d=await this.api('/recognition/images/batch',post({...this.target,images,batchId:this.batchId}));this.savedId=d.targetId;await this.library.reload();this.library.select(d.targetId);await this.vision.references(this.library.targets);this.phase='verify';this.revision++;this.exited=false;this.verified=false;this.missingAt=null;this.hits=0;this.note='저장했습니다. 물체를 시야 밖으로 옮겼다가 다시 보여 주세요. 아직 다시 찾기 검증 전입니다.';await this.publish()}finally{this.saving=false;this.render()}
  }
  renderControls(){for(const plane of ['hud','camera'])for(const key of ['cx','cy','width','height']){const id=`${plane}-${key}`;$(`#${id}`).value=Math.round(this.config[plane][key]*100);$(`#${id}-value`).value=Math.round(this.config[plane][key]*100)+'%'}$('#guide-shape').value=this.config.shape;$('#calibration-state').textContent=this.config.calibrated?'보정 저장됨 · 거리나 안경 착용 위치가 바뀌면 다시 맞춰 주세요.':'보정 전 · 안경 테두리와 카메라 영상은 자동으로 일치하지 않습니다.'}
  render(){
    const active=this.enabled,phase=this.phase,selected=this.samples.filter(s=>s.keep).length;document.body.classList.toggle('registering',active);
    $('#guide-open').disabled=active;$('#guide-close').disabled=!active||this.saving;$('#guide-settings').disabled=active&&phase!=='align';$('#guide-save').disabled=!active||phase!=='align';$('#video-register').disabled=!active||phase!=='align'||!this.config.calibrated;
    $('#capture-actions').hidden=!active||phase!=='capture';$('#capture-reseed').disabled=!this.lost;$('#capture-review').hidden=!active||phase!=='review';$('#capture-samples').hidden=!active||phase!=='review';$('#samples-save').disabled=this.saving||!selected;$('#samples-discard').disabled=this.saving;$('#samples-save').textContent=this.saving?'서버에 저장 중…':`${selected}장 저장하고 다시 찾기 확인`;
    $('#registration-step').textContent=!active?'가이드 준비':phase==='align'?'1 · 테두리 보정':phase==='capture'?'2 · 영상에서 장면 수집':phase==='review'?'3 · 저장할 장면 확인':this.verified?'4 · 다시 찾기 확인됨':'4 · 새 시야에서 다시 찾기';
    $('#registration-note').textContent=this.note||'안경에 가이드를 켜고 실제 등록할 거리에서 테두리를 맞춰 주세요.';
    $('#capture-count').textContent=phase==='capture'?`${Math.min(30,Math.floor((performance.now()-this.started)/1000))} / 30초 · ${this.samples.length}장 수집`:'';
  }
  draw(g,w,h){
    if(!this.enabled)return;
    const r=this.config.camera;g.save();g.strokeStyle='#80ef97';g.lineWidth=2;g.setLineDash([10,6]);g.strokeRect((r.cx-r.width/2)*w,(r.cy-r.height/2)*h,r.width*w,r.height*h);g.setLineDash([]);g.fillStyle='#80ef97';g.font='14px sans-serif';g.fillText('저장 시작 영역',Math.max(4,(r.cx-r.width/2)*w),Math.max(18,(r.cy-r.height/2)*h-8));
    if(this.phase==='align'){
      const x=r.cx*w,y=r.cy*h,rw=r.width*w,rh=r.height*h;
      g.fillText('1',x+5,y-rh/2+15);
      g.fillText('2',x+rw/2-13,y-5);
      g.fillText('3',x+5,y+rh/2-5);
      g.fillText('4',x-rw/2+5,y-5);
    }
    if(this.phase==='capture'&&this.corners&&!this.lost){g.lineWidth=3;g.beginPath();this.corners.forEach(([x,y],i)=>i?g.lineTo(x*w,y*h):g.moveTo(x*w,y*h));g.closePath();g.stroke()}g.restore();
  }
}
