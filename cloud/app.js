import {GlassDecoder} from './decoder.js';
import {FramePlayer} from './frame-player.js';
import {LiveTiming} from './live-timing.mjs';
import {LiveRecovery,displayStalled} from './live-recovery.mjs';
import {unpack} from './stream-protocol.mjs';
import {readVideo} from './http-video.js';
import {VisionClient} from './vision-client.js';
import {Registration} from './registration.js';
import {TargetLibrary} from './library.js';
const $=s=>document.querySelector(s),screen=$('#screen'),g=screen.getContext('2d'),frame=document.createElement('canvas'),fg=frame.getContext('2d');
let frozen=false,selected=null,drag=null,frameAt=0,frameCount=0,matchedFrame=0,cvReady=false,matcher=new VisionClient(),registration,version=0,loading=false,state={enabled:false,detections:[]},lastSeq=null,message='',socket;
const api=async(path,options)=>{const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j};
const showError=e=>{message=e.message||String(e);$('#capture-note').textContent=message};
const timing=new LiveTiming();
const recovery=new LiveRecovery();
const player=new FramePlayer((f,at)=>drawFrame(f,f.displayWidth,f.displayHeight,at),(at,now)=>timing.fresh(at,now));
let lastLiveAt=0,frameDrawnAt=0,lastPacketAt=0,recovering=false,recoveryAt=0,httpController=null,connectedAt=0;
let streamTest=null,transport='',networkFrames=0,controlsSynced=false;
const decoder=typeof VideoDecoder==='function'?new GlassDecoder((f,at,fps)=>player.push(f,at,fps),e=>showError(new Error('동영상 해석: '+e.message))):null;
function drawFrame(image,w,h,at){const scale=Math.min(1,960/Math.max(w,h));const width=Math.round(h*scale),height=Math.round(w*scale);if(frame.width!==width||frame.height!==height){frame.width=width;frame.height=height}fg.save();fg.translate(0,frame.height);fg.rotate(-Math.PI/2);fg.drawImage(image,0,0,frame.height,frame.width);fg.restore();frameAt=at;frameDrawnAt=performance.now();frameCount++}
const requestedMedia=new URLSearchParams(location.search).get('media'),viewerId=crypto.randomUUID();
let useHttp=requestedMedia==='http',connectTimer=null;
async function receive(m){if(m.pong){timing.pong(m);return}if(m.kind==='hello')return;if(Number.isSafeInteger(m.n)&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({ack:m.n}));if(streamTest!==m.test){streamTest=m.test;player.clear();frameAt=0}if(m.transport)transport=m.transport;if(Number.isFinite(m.frames))networkFrames+=m.frames;
if(m.kind==='h264'||m.kind==='jpeg'){
 lastPacketAt=performance.now();
 // Decode through short bursts to preserve H.264 reference frames. Display still
 // rejects stale pictures. Abandon the encoded chain only for a real backlog.
 if(!m.config&&timing.backlogged(m.at)){timing.stalePackets++;if(!recovering){recovering=true;recoveryAt=performance.now();decoder?.reset(true);player.clear();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({keyframe:true}))}return}
 if(!m.config){lastLiveAt=performance.now();recovering=false}
}
if(m.kind==='h264'){if(!decoder)throw Error('이 브라우저는 동영상 해석을 지원하지 않습니다. Chrome 또는 연속 사진을 선택하세요.');decoder.push(m)}else if(m.kind==='jpeg'){const blob=m.bytes?new Blob([m.bytes],{type:'image/jpeg'}):await (await fetch('data:image/jpeg;base64,'+m.data)).blob();const b=await createImageBitmap(blob);if(streamTest===m.test&&m.at>=frameAt)drawFrame(b,b.width,b.height,m.at);b.close()}}
function connect(){
 clearTimeout(connectTimer);connectedAt=performance.now();lastPacketAt=lastLiveAt=frameDrawnAt=0;
 if(useHttp){const controller=new AbortController();httpController=controller;fetch('/cam/live?viewer='+viewerId,{signal:controller.signal,cache:'no-store'}).then(r=>{if(!r.ok)throw Error('영상 연결 '+r.status);return readVideo(r.body,m=>{if(httpController===controller&&!controller.signal.aborted)return receive(m)},controller.signal)}).catch(e=>{if(httpController===controller&&!controller.signal.aborted)showError(e)}).finally(()=>{if(httpController!==controller)return;httpController=null;decoder?.reset();player.clear();connectTimer=setTimeout(connect,1000)});return}
 const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/cam/ws?binary=1');socket=ws;ws.binaryType='arraybuffer';
 ws.onopen=()=>{if(socket!==ws)return;connectedAt=performance.now();ws.send(JSON.stringify(timing.ping()))};
 ws.onmessage=async e=>{if(socket!==ws)return;try{if(e.data instanceof ArrayBuffer){const packet=unpack(e.data);await receive({...packet.meta,bytes:packet.bytes})}else await receive(JSON.parse(e.data))}catch(e){showError(e)}};
 ws.onclose=()=>{if(socket!==ws)return;socket=null;decoder?.reset();player.clear();connectTimer=setTimeout(connect,500)};
 ws.onerror=()=>{if(socket===ws)restartConnection()};
}
function restartConnection(){
 clearTimeout(connectTimer);
 const old=socket;socket=null;const controller=httpController;httpController=null;controller?.abort();
 // Do not wait for a close handshake behind queued media before opening a live socket.
 if(old){old.onopen=old.onmessage=old.onclose=old.onerror=null;try{old.close(1000,'Resume live')}catch{}}
 decoder?.reset();player.clear();connectTimer=setTimeout(connect,300);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recovering=false;if(!frozen)frameAt=0;restartConnection()}});
$('#mode').onchange=()=>{$('#fps-options').hidden=$('#mode').value!=='video';$('#fps').disabled=$('#mode').value!=='video'};
$('#capture-start').onclick=async()=>{try{const mode=$('#mode').value;const fps=mode==='video'?Number($('#fps').value):5;await api('/cam/set?mode='+mode+'&fps='+fps+'&sec=0&kbps='+$('#quality').value);$('#capture-note').textContent='안경에 '+fps+'fps 촬영 신호를 보냈습니다.';frameAt=0;player.clear();decoder?.reset();frozen=false;selected=null}catch(e){showError(e)}};
$('#capture-stop').onclick=async()=>{try{await api('/cam/set?fps=0');$('#capture-note').textContent='촬영 중지 신호를 보냈습니다.'}catch(e){showError(e)}};
const frozenFrame=document.createElement('canvas');
$('#freeze').onclick=()=>{if(!frameAt)return showError(Error('안경 영상이 도착한 뒤 멈춰 주세요.'));frozen=!frozen;if(frozen){frozenFrame.width=frame.width;frozenFrame.height=frame.height;frozenFrame.getContext('2d').drawImage(frame,0,0)}selected=null;$('#freeze').textContent=frozen?'실시간으로 돌아가기':'등록할 화면 멈추기'};
$('#glasses').onclick=()=>{frozen=false;selected=null;$('#freeze').textContent='등록할 화면 멈추기'};
$('#start').onclick=async()=>{try{if(!cvReady)throw Error('인식 엔진을 준비 중입니다. 잠시 후 다시 눌러 주세요.');if(!matcher.refs.length)throw Error('대상을 먼저 등록하세요.');if(registration.enabled)throw Error('가이드를 종료한 뒤 인식을 시작하세요.');if(frozen)$('#glasses').click();await api('/recognition/control?enabled=1',{method:'POST'})}catch(e){showError(e)}};
$('#stop').onclick=()=>api('/recognition/control?enabled=0',{method:'POST'}).catch(showError);
function position(e){const r=screen.getBoundingClientRect();return {x:Math.max(0,Math.min(screen.width,(e.clientX-r.left)*screen.width/r.width)),y:Math.max(0,Math.min(screen.height,(e.clientY-r.top)*screen.height/r.height))}}
screen.onpointerdown=e=>{if(registration?.enabled)return;if(!frozen)$('#freeze').click();if(!frozen)return;drag=position(e);selected=null;screen.setPointerCapture(e.pointerId)};
screen.onpointermove=e=>{if(drag){const p=position(e);selected={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(drag.x-p.x),h:Math.abs(drag.y-p.y)}}};
screen.onpointerup=()=>{drag=null;$('#selection').textContent=selected?'선택 영역을 등록하세요':'대상 외곽을 드래그하세요'};
screen.onpointercancel=()=>drag=null;
const library=new TargetLibrary({api,crop:()=>{
  if(!frozen||!selected||selected.w<30||selected.h<30)throw Error('안경 화면에서 물건 영역을 30px 이상 선택하세요.');
  const c=document.createElement('canvas'),scale=Math.min(1,640/Math.max(selected.w,selected.h));c.width=Math.round(selected.w*scale);c.height=Math.round(selected.h*scale);
  c.getContext('2d').drawImage(frozenFrame,selected.x,selected.y,selected.w,selected.h,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.85);
},onSaved:()=>{selected=null}});
registration=new Registration({api,library,vision:matcher,live:()=>frameAt&&performance.now()-frameDrawnAt<1200&&timing.fresh(frameAt),unfreeze:()=>$('#glasses').click()});
async function refresh(){const sent=performance.now();state=await api('/recognition/status');timing.observe(state.serverNow,sent);registration.observe(state.guide);const status=await api('/status');$('#connection').textContent='Cloudflare 연결 · 안경 '+status.glasses+'대 · '+(frameAt&&performance.now()-frameDrawnAt<1200&&timing.fresh(frameAt)?'영상 수신 중':'촬영 영상 대기');$('#capture-start').disabled=!status.glasses;
if(lastSeq===null)lastSeq=status.now?.seq||0;if(status.now?.seq!==lastSeq){lastSeq=status.now?.seq;if(status.now?.cmd==='play'){$('#result').src=status.now.url;$('#result').loop=!!status.now.loop;$('#result').muted=true;$('#result').play().catch(()=>{})}else if(status.now?.cmd==='stop')$('#result').pause()}
$('#state').textContent=!cvReady?'인식 엔진 준비 중':!state.enabled?'인식 대기 중':state.focused&&state.progress>0?'중앙 대상 확인 '+Math.round(state.progress*100)+'%':state.locked?'영상 재생 신호 전송됨':'시야의 대상 찾는 중';
$('#found').textContent=state.detections.length?'인식 대상: '+state.detections.map(t=>t.name).join(' · '):'인식된 대상 없음';
await library.sync(state.version);
if(cvReady&&!loading&&version!==library.version){loading=true;try{const nextVersion=library.version;await matcher.references(library.targets);version=nextVersion}finally{loading=false}}}

async function poll(){try{await refresh()}catch(e){showError(e)}setTimeout(poll,600)}
async function recognize(){
 try{
  if(cvReady&&!loading&&frameCount!==matchedFrame&&frameAt&&performance.now()-frameDrawnAt<1200&&timing.fresh(frameAt)){
   const options=registration.options();
   if(options||(!registration.enabled&&state.enabled)){
    matchedFrame=frameCount;const at=frameAt,epoch=state.epoch,revision=registration.revision;
    const result=await matcher.process(frame,{...(options||{mode:'recognize'}),at});
    if(revision===registration.revision&&timing.fresh(at)){
     if(options)registration.accept(result);
     else if(!registration.enabled)await api('/recognition/detections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({found:result.found,at,epoch})});
    }
   }
  }
 }catch(e){showError(e);if(registration.phase==='capture'){registration.lost=true;registration.error(Error('영역 추적을 멈췄습니다. '+(e.message||e)))}}
 setTimeout(recognize,100);
}
function draw(now){player.tick(now);if(!frozen&&frameAt&&!timing.fresh(frameAt,now)){frameAt=0;g.clearRect(0,0,screen.width,screen.height)}const f=frozen?frozenFrame:frame;if(frameAt){if(screen.width!==f.width||screen.height!==f.height){screen.width=f.width;screen.height=f.height}g.drawImage(f,0,0);if(!frozen&&(timing.age(state.at)??Infinity)<2200){for(const d of state.detections){g.strokeStyle='#68ff8a';g.lineWidth=3;g.beginPath();d.corners.forEach(([x,y],i)=>i?g.lineTo(x*screen.width,y*screen.height):g.moveTo(x*screen.width,y*screen.height));g.closePath();g.stroke();g.font='bold 18px sans-serif';g.fillStyle='#68ff8a';g.fillText(d.name,Math.max(4,d.corners[0][0]*screen.width),Math.max(20,d.corners[0][1]*screen.height-8))}}
registration.draw(g,screen.width,screen.height);if(selected){g.strokeStyle='#68ff8a';g.lineWidth=2;g.strokeRect(selected.x,selected.y,selected.w,selected.h)}if(!registration.enabled){const aim=state.guide?.calibrated?state.guide.camera:{cx:.5,cy:.5};const x=screen.width*aim.cx,y=screen.height*aim.cy;g.strokeStyle='#68ff8a';g.lineWidth=2;g.beginPath();g.arc(x,y,20,0,Math.PI*2);g.moveTo(x-6,y);g.lineTo(x+6,y);g.moveTo(x,y-6);g.lineTo(x,y+6);g.stroke();g.lineWidth=5;g.beginPath();g.arc(x,y,26,-Math.PI/2,-Math.PI/2+Math.PI*2*(frozen?0:state.progress||0));g.stroke()}}requestAnimationFrame(draw)}
matcher.ready.then(()=>{cvReady=true}).catch(showError);
api('/videos.json').then(data=>{library.videos=data;$('#video-key').replaceChildren(...Object.entries(data).map(([key,v])=>{const o=document.createElement('option');o.value=key;o.textContent=v.title;return o}));library.render()}).catch(showError);
setInterval(()=>{
 const now=performance.now();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(timing.ping(now)));
 const active=cameraStats?.test&&!cameraStats.test.done,visible=document.visibilityState==='visible';
 const stalled=visible&&active&&cameraStats.receiveFps>0&&connectedAt&&now-Math.max(lastLiveAt,connectedAt)>2500;
 const noFreshDisplay=displayStalled({now,connectedAt,packetAt:lastPacketAt,presentedAt:frameDrawnAt,active,visible});
 if(visible&&((recovering&&now-recoveryAt>1500)||stalled||noFreshDisplay)){
   useHttp=recovery.transport(useHttp?'http':'websocket',now,['http','ws','websocket'].includes(requestedMedia))==='http';
   timing.recoveries++;recovering=false;connectedAt=now;lastLiveAt=0;decoder?.reset();player.clear();frameAt=0;g.clearRect(0,0,screen.width,screen.height);
   restartConnection();
 }
 $('#live-status').textContent=recovering||stalled||noFreshDisplay?'영상 지연 감지 · 최신 화면에 다시 연결합니다':frameAt?(useHttp?'연속 영상 연결':'실시간 영상 연결'):'새 영상 대기 중';
},1000);
let metricAt=performance.now(),decodedAt=0,shownAt=0,networkAt=0,cameraStats=null,statsBusy=false,metricSequence=0;
setInterval(()=>{const now=performance.now(),seconds=(now-metricAt)/1000,decoded=(player.decoded-decodedAt)/seconds,shown=(player.shown-shownAt)/seconds,network=(networkFrames-networkAt)/seconds;networkAt=networkFrames;metricAt=now;decodedAt=player.decoded;shownAt=player.shown;
const metrics={stalePackets:timing.stalePackets,recoveries:timing.recoveries,relayAgeMs:frameAt?timing.age(frameAt):null,clockUncertaintyMs:timing.uncertainty,seq:++metricSequence,networkFps:network,visible:document.visibilityState==='visible',decodedFps:decoded,displayFps:frozen?0:shown,frameAgeMs:frameAt?(timing.age(frameAt)??0):0,frozen,totalReceived:networkFrames,totalDecoded:player.decoded,totalDisplayed:player.shown,displayDrops:player.dropped,queueFrames:player.queue.length,maxFrameQueue:player.maxQueue,maxRafGap:player.maxRafGap,displayWaitMs:player.lastWaitMs,maxDisplayWaitMs:player.maxWaitMs,playerDrops:player.drops,decoder:decoder?.counters};
if(useHttp)api('/cam/viewer-metrics?viewer='+viewerId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(metrics)}).catch(()=>{});else if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({metrics}));
const active=cameraStats?.test&&!cameraStats.test.done;
$('#stream-stats').textContent=active?'설정 '+cameraStats.test.fps+'fps · 서버 '+cameraStats.receiveFps+'fps · 웹 도착 '+network.toFixed(1)+'fps · 해석 '+decoded.toFixed(1)+'fps · 표시 '+(frozen?'정지':shown.toFixed(1)+'fps'):'촬영 대기';
if(!statsBusy){statsBusy=true;api('/cam/stats').then(stats=>{cameraStats=stats;const active=stats.test&&!stats.test.done;if(active&&!controlsSynced){$('#fps').value=String(stats.test.fps);$('#quality').value=String(stats.test.kbps);controlsSynced=true}$('#transport-note').textContent=active?(stats.test.transport==='http'&&stats.test.mode==='video'?'이전 APK의 HTTP 전송 중입니다. 앱 0.2.8로 업데이트하면 연속 전송을 사용합니다.':transport==='websocket'?'연속 영상 전송 연결됨':'영상 연결 대기'):''}).catch(()=>{}).finally(()=>statsBusy=false)}
},2000);
connect();poll();recognize();requestAnimationFrame(draw);
