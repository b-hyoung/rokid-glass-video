import {VisionClient} from '/cloud/vision-client.js';
const $=id=>document.getElementById(id),source=$('source'),screen=$('screen'),g=screen.getContext('2d');
const frame=document.createElement('canvas'),analysis=document.createElement('canvas'),vision=new VisionClient();
let ready=false,loading=false,running=false,revision=0,media=null,fileUrl=null,roi=null,cropping=false,drag=null,selection=null;
let state={},targets=[],lastResult=null,started=0,firstSeen=new Map(),playerId='',analysisBusy=false;
const api=async(path,options)=>{const r=await fetch('/preview'+path,options);const d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d};
const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const note=message=>$('status').textContent=message;
function clearResults(){lastResult=null;firstSeen=new Map();$('results').replaceChildren();$('metrics').textContent='분석 대기';$('progress').value=0;$('focus').textContent='조준 대기'}
function controls(){
  $('start').disabled=!ready||loading||!media||!targets.length||running;
  $('stop').disabled=!running;$('reload').disabled=running||loading;
  $('crop').disabled=!media||running;$('full').disabled=!media||running;
  $('file').disabled=loading;$('rotation').disabled=running;
}
async function refreshTargets(){
  if(loading)return;loading=true;revision++;controls();note('등록 대상 준비 중…');
  try{
    await api('/sync',post({}));const data=await api('/recognition/targets');targets=data.targets;
    await vision.references(targets);state=await api('/recognition/status');
    $('targets').replaceChildren(...targets.map(t=>{const li=document.createElement('li');li.textContent=`${t.name} · 사진 ${t.images.length}장`;return li}));
    note(targets.length?'대상을 불러왔습니다. 파일을 선택하고 테스트를 시작하세요.':'대상·이미지 목록에서 물체를 먼저 등록하세요.');
  }catch(error){note(error.message)}finally{loading=false;controls()}
}
async function stop(){
  running=false;revision++;source.pause();clearResults();selection=null;controls();
  await api('/recognition/control?enabled=0',post({}));await api('/stop',post({}));stopPlayer();
}
async function start(){
  if(!media||!ready||loading)return;
  const token=++revision;running=false;clearResults();controls();note('테스트 준비 중…');
  try{
    await api('/local/reset',post({}));stopPlayer();await vision.reset();
    await api('/recognition/control?enabled=1',post({}));state=await api('/recognition/status');
    if(token!==revision)return;
    if(media==='video'){if(source.ended)source.currentTime=0;await source.play()}
    running=true;cropping=false;drag=null;lastResult=null;firstSeen=new Map();started=performance.now();note('로컬에서 인식 중');
  }catch(error){note(error.message)}finally{controls()}
}
$('start').onclick=start;$('stop').onclick=()=>stop().then(()=>note('테스트를 중지했습니다.')).catch(error=>note(error.message));
$('reload').onclick=refreshTargets;
$('file').onchange=async()=>{
  const file=$('file').files[0];if(!file)return;
  try{
    await stop();media=null;roi=null;cropping=false;$('crop-state').textContent='전체 화면 분석';
    if(fileUrl)URL.revokeObjectURL(fileUrl);fileUrl=URL.createObjectURL(file);
    if(/^image\/(jpeg|png|webp)$/.test(file.type)){
      const bitmap=await createImageBitmap(file);frame.width=bitmap.width;frame.height=bitmap.height;frame.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      media='image';source.hidden=true;$('video-note').hidden=true;
    }else if(file.type.startsWith('video/')){
      source.src=fileUrl;source.hidden=false;$('video-note').hidden=false;
      await new Promise((resolve,reject)=>{source.onloadeddata=resolve;source.onerror=()=>reject(Error('영상을 열 수 없습니다. MP4 영상을 선택하세요.'));source.load()});media='video';
    }else throw Error('JPG·PNG·WebP 사진이나 영상 파일을 선택하세요.');
    $('file-name').textContent=file.name;note('테스트 시작을 누르세요.');
  }catch(error){note(error.message)}finally{controls()}
};
source.addEventListener('seeking',()=>{if(running)stop().then(()=>note('시점을 옮겼습니다. 테스트 시작을 다시 누르세요.')).catch(error=>note(error.message))});
source.addEventListener('ended',()=>{if(running){running=false;revision++;controls();api('/recognition/control?enabled=0',post({})).catch(error=>note(error.message));note('녹화가 끝났습니다. 연결 영상 미리보기는 계속 재생됩니다.')}});
$('rotation').onchange=()=>{roi=null;lastResult=null;$('crop-state').textContent='전체 화면 분석'};
$('crop').onclick=()=>{cropping=!cropping;selection=null;note(cropping?'오른쪽에서 분석할 영상 영역을 드래그하세요.':'영역 선택을 마쳤습니다.')};
$('full').onclick=()=>{roi=null;selection=null;$('crop-state').textContent='전체 화면 분석'};
const point=e=>{const r=screen.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}};
screen.onpointerdown=e=>{if(!cropping||running)return;drag=point(e);selection=null;screen.setPointerCapture(e.pointerId)};
screen.onpointermove=e=>{if(!drag)return;const p=point(e);selection={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(drag.x-p.x),h:Math.abs(drag.y-p.y)}};
screen.onpointerup=()=>{drag=null;if(selection&&selection.w*screen.width>=30&&selection.h*screen.height>=30){roi=selection;cropping=false;$('crop-state').textContent='선택한 영역만 분석';note('영역을 선택했습니다. 테스트 시작을 누르세요.')}selection=null};
screen.onpointercancel=()=>{drag=null;selection=null};
function draw(){
  if(media){
    const input=media==='video'?source:frame,iw=media==='video'?source.videoWidth:frame.width,ih=media==='video'?source.videoHeight:frame.height;
    if(iw&&ih){
      const rotation=+$('rotation').value,swap=rotation%180!==0,scale=Math.min(1,960/Math.max(iw,ih));
      const w=Math.round((swap?ih:iw)*scale),h=Math.round((swap?iw:ih)*scale);
      if(screen.width!==w||screen.height!==h){screen.width=w;screen.height=h}
      g.clearRect(0,0,w,h);g.save();g.translate(w/2,h/2);g.rotate(rotation*Math.PI/180);g.drawImage(input,-iw*scale/2,-ih*scale/2,iw*scale,ih*scale);g.restore();
      const region=roi||{x:0,y:0,w:1,h:1};
      // Snapshot only source pixels before drawing HUD marks.
      analysis.width=Math.max(1,Math.round(region.w*w));analysis.height=Math.max(1,Math.round(region.h*h));
      analysis.getContext('2d').drawImage(screen,region.x*w,region.y*h,region.w*w,region.h*h,0,0,analysis.width,analysis.height);
      if(lastResult)for(const d of state.detections||[]){
        g.strokeStyle=d.held?'#9eb3a3':'#75ef91';g.lineWidth=2;g.setLineDash([8,5]);g.beginPath();
        d.corners.forEach(([u,v],i)=>{const x=(region.x+u*region.w)*w,y=(region.y+v*region.h)*h;i?g.lineTo(x,y):g.moveTo(x,y)});g.closePath();g.stroke();g.setLineDash([]);
        const [u,v]=d.corners[0];g.fillStyle='#75ef91';g.font='15px sans-serif';g.fillText('▶ '+d.name,(region.x+u*region.w)*w,Math.max(18,(region.y+v*region.h)*h-5));
      }
      const aim=state.guide?.calibrated?state.guide.camera:{cx:.5,cy:.5},x=(region.x+aim.cx*region.w)*w,y=(region.y+aim.cy*region.h)*h;
      g.strokeStyle='#75ef91';g.lineWidth=2;g.beginPath();g.arc(x,y,17,0,Math.PI*2);g.moveTo(x-6,y);g.lineTo(x+6,y);g.moveTo(x,y-6);g.lineTo(x,y+6);g.stroke();
      const box=selection||roi;if(box){g.setLineDash([5,4]);g.strokeRect(box.x*w,box.y*h,box.w*w,box.h*h);g.setLineDash([])}
    }
  }
  requestAnimationFrame(draw);
}
function stopPlayer(){playerId='';$('player').pause();$('player').removeAttribute('src');$('player').load();$('player').hidden=true;$('stop-player').hidden=true;$('playback-status').textContent='재생 대기'}
async function showPlayback(){
  const playback=state.playback;if(!playback){if(playerId)stopPlayer();return}
  if(playback.id===playerId)return;
  if(!/^\/v\/[\w.-]+\.mp4$/.test(playback.media?.url||''))return;
  playerId=playback.id;const player=$('player');player.hidden=false;player.loop=!!playback.media.loop;player.src=playback.media.url;$('stop-player').hidden=false;$('playback-status').textContent=playback.media.title;
  try{await player.play()}catch(error){$('playback-status').textContent='미리보기의 재생 버튼을 눌러 주세요.'}
}
for(const [event,name] of [['playing','playing'],['ended','completed'],['error','error']])$('player').addEventListener(event,()=>{if(playerId)api('/recognition/playback',post({id:playerId,event:name})).catch(error=>note(error.message))});
let renewedAt=0;
$('player').addEventListener('timeupdate',()=>{if(playerId&&!$('player').paused&&performance.now()-renewedAt>5000){renewedAt=performance.now();api('/recognition/playback',post({id:playerId,event:'playing'})).catch(error=>note(error.message))}});
$('stop-player').onclick=()=>api('/stop',post({})).then(stopPlayer).catch(error=>note(error.message));
async function analyze(){
  setTimeout(analyze,75);
  if(running&&media&&!analysisBusy&&analysis.width>1){
    analysisBusy=true;const token=revision,at=Date.now(),sample=performance.now(),epoch=state.epoch;
    try{
      const aim=state.guide?.calibrated?state.guide.camera:{cx:.5,cy:.5};
      const result=await vision.process(analysis,{mode:'recognize',at,aim});
      if(token!==revision||!running)return;
      await api('/recognition/detections',post({at,epoch,found:result.found,aimMatch:result.aimMatch,sceneStable:result.sceneStable}));
      if(token!==revision||!running)return;
      state=await api('/recognition/status');lastResult=result;
      for(const d of result.found)if(!d.held&&!firstSeen.has(d.id))firstSeen.set(d.id,performance.now()-started);
      $('results').replaceChildren(...(state.detections||[]).map(d=>{const li=document.createElement('li');li.textContent=`${d.name} · ${d.held?'잠시 추적 유지':'인식됨'} · 첫 인식 ${Math.round(firstSeen.get(d.id)||0)}ms`;return li}));
      $('metrics').textContent=`분석 ${Math.round(result.ms)}ms · 결과 수신 ${Math.round(performance.now()-sample)}ms · ${state.detections.length}개 표시`;
      $('progress').value=state.progress;$('focus').textContent=state.focused?`재생 진행 ${Math.round(state.progress*100)}%`:'조준 대기';
      if(result.appearanceError)note(result.appearanceError);await showPlayback();
    }catch(error){if(token===revision)note(error.message)}finally{analysisBusy=false}
  }
}
vision.ready.then(async()=>{ready=true;$('engine').textContent='인식 엔진 · '+vision.version;await refreshTargets();controls()}).catch(error=>note(error.message));
draw();analyze();
