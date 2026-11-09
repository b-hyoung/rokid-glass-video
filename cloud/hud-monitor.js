const summary=document.querySelector('#hud-summary'),preview=document.querySelector('#hud-preview'),labels=document.querySelector('#hud-labels'),names=document.querySelector('#hud-names'),video=document.querySelector('#hud-video-state');
const player=document.querySelector('#hud-player'),playerStatus=document.querySelector('#hud-player-status');
const playbackPane=document.querySelector('#hud-playback'),display=document.querySelector('#hud-display'),scene=document.querySelector('#monitor-scene'),monitor=document.querySelector('#hud-monitor'),resume=document.querySelector('#hud-resume');
let socket,timer,lastAt=0,lastText='',revision='',connected=false;
let playbackId='',displayAspect=16/9;
function layout(){
  // MainActivity.fit() centers a contained video in the glasses' full display.
  // Fit that display in the camera monitor without stretching either image.
  const width=Math.min(scene.clientWidth,scene.clientHeight*displayAspect);
  display.style.width=width+'px';display.style.height=(width/displayAspect)+'px';
}
new ResizeObserver(layout).observe(scene);
function text(value){if(value!==lastText){summary.textContent=value;lastText=value}}
function stopPreview(){
  if(!playbackId)return;
  playbackId='';
  player.pause();player.removeAttribute('src');player.load();player.hidden=true;playerStatus.textContent='';resume.hidden=true;
}
function startPreview(id){player.play().catch(error=>{
  if(playbackId===id&&error.name==='NotAllowedError'){playerStatus.textContent='모니터링 영상을 보려면 화면의 버튼을 눌러 주세요.';resume.hidden=false;}
});}
function playPreview(state){
  const media=state.media;
  if(!state.playbackId||typeof media?.url!=='string'||!/^\/v\/[\w.-]+\.mp4$/i.test(media.url))return false;
  if(playbackId===state.playbackId)return true;
  stopPreview();
  const id=playbackId=state.playbackId;
  player.hidden=false;player.loop=!!media.loop;player.muted=true;player.src=media.url;
  startPreview(id);
  return true;
}
player.addEventListener('error',()=>{if(playbackId)playerStatus.textContent='안경은 재생 중이지만 웹에서 영상을 불러오지 못했습니다.'});
player.addEventListener('playing',()=>{playerStatus.textContent='';resume.hidden=true});
resume.onclick=()=>{if(playbackId)startPreview(playbackId)};
function clear(message){lastAt=0;revision='';stopPreview();labels.replaceChildren();names.replaceChildren();video.replaceChildren();video.hidden=true;playbackPane.hidden=true;monitor.dataset.mode=preview.dataset.mode='idle';text(message)}
function draw(state){
  // This module has no camera frames and cannot originate a recognition result.
  lastAt=performance.now();const objects=state.visible?state.objects:[];
  const mode=state.visible?state.mode:'idle';monitor.dataset.mode=preview.dataset.mode=mode;
  displayAspect=state.width/state.height;layout();
  preview.style.aspectRatio=state.width+'/'+state.height;
  const signature=JSON.stringify([objects,mode,state.title,state.tracking,state.playbackId,state.media]);
  if(signature===revision)return;revision=signature;
  playbackPane.hidden=mode!=='playback'&&mode!=='loading';
  labels.replaceChildren();names.replaceChildren();video.replaceChildren();video.hidden=true;
  if(mode==='playback'&&playPreview(state)){
    text('안경 영상 재생 중 · '+(state.media.title||state.title||'연결 영상'));return;
  }
  stopPreview();
  if(mode==='playback'||mode==='loading'){
    const title=document.createElement('strong');title.textContent=state.title||'연결 영상';
    const status=document.createElement('span');status.textContent=mode==='playback'?'영상 재생 중':'영상 불러오는 중';
    video.append(status,title);video.hidden=false;text('안경 '+status.textContent+' · 다른 대상 자동 재생 잠금');return;
  }
  if(mode==='guide'){text('안경에 등록 가이드 표시 중');return}
  if(mode==='idle'){text(state.visible?'안경 연결됨 · 인식 표시 대기':'안경 화면 표시 정보 대기');return}
  text('안경에 표시 중 · 스캔 가능한 대상 '+objects.length+'개 · '+(state.tracking?'안경 내부 추적':'서버 위치 표시'));
  const svgNS='http://www.w3.org/2000/svg';
  const outlines=document.createElementNS(svgNS,'svg');
  outlines.setAttribute('viewBox','0 0 100 100');
  outlines.setAttribute('preserveAspectRatio','none');
  outlines.setAttribute('aria-hidden','true');
  outlines.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  labels.append(outlines);
  for(const object of objects){
    if(object.corners&&!object.approximate){
      const polygon=document.createElementNS(svgNS,'polygon');
      polygon.setAttribute('points',object.corners.map(([x,y])=>[x*100,y*100].join(',')).join(' '));
      polygon.setAttribute('fill','none');
      polygon.setAttribute('stroke','currentColor');
      polygon.setAttribute('vector-effect','non-scaling-stroke');
      polygon.setAttribute('stroke-dasharray','5 4');
      outlines.append(polygon);
    }
    const label=document.createElement('span');label.textContent=(object.playBadge?'▶ ':'')+object.name;label.style.left=(object.x*100)+'%';label.style.top=(object.y*100)+'%';labels.append(label);
    const item=document.createElement('li');item.textContent=object.name;names.append(item);
  }
}
function connect(){
  clearTimeout(timer);if(document.hidden)return;
  const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/recognition/hud');socket=ws;
  ws.onopen=()=>{if(socket===ws){connected=true;text('안경 표시 정보 연결됨 · 첫 상태 대기')}};
  ws.onmessage=event=>{if(socket!==ws)return;try{const state=JSON.parse(event.data);if(!Number.isSafeInteger(state.seq)||!Array.isArray(state.objects))return;ws.send(JSON.stringify({ack:state.seq}));draw(state)}catch{}};
  ws.onclose=()=>{if(socket!==ws)return;connected=false;clear('안경 표시 정보 연결 중');timer=setTimeout(connect,1500)};
  ws.onerror=()=>ws.close();
}
setInterval(()=>{if(lastAt&&performance.now()-lastAt>2200)clear('안경 표시 갱신이 멈췄습니다 · 최근 대상 표시를 지웠습니다.');else if(!lastAt&&connected&&!revision)text('안경 앱의 표시 정보를 기다리고 있습니다.')},500);
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);const old=socket;socket=null;old?.close();clear('화면을 다시 열면 최신 표시를 받습니다.')}else connect()});
connect();
