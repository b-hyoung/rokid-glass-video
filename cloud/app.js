import {LiveDiagnostics} from './live-diagnostics.mjs';
import {GlassDecoder} from './decoder.js';
import {FramePlayer} from './frame-player.js';
import {LiveTiming} from './live-timing.mjs';
import {LiveRecovery,displayStalled} from './live-recovery.mjs';
import {unpack} from './stream-protocol.mjs';
import {readVideo} from './http-video.js';
import {VisionClient} from './vision-client.js';
import {Registration} from './registration.js';
import {TargetLibrary} from './library.js';
import {RtcVideo} from './rtc-video.js';
import {loadRuntimeConfig,applyRuntimeConfig} from './runtime-config.js';
import {api} from './api-client.js';
import {StateClient,RetryDelay} from './state-client.js';
const runtime=await loadRuntimeConfig();
applyRuntimeConfig(runtime);
const $=s=>document.querySelector(s),screen=$('#screen'),g=screen.getContext('2d'),frame=document.createElement('canvas'),fg=frame.getContext('2d');
let lastSnapshot=null;
let frozen=false,selected=null,drag=null,frameAt=0,frameCount=0,matchedFrame=0,cvReady=false,matcher=new VisionClient(),registration,version=0,loading=false,state={enabled:false,detections:[]},message='',socket;
const showError=e=>{message=e.message||String(e);$('#capture-note').textContent=message};
const timing=new LiveTiming();
let rtcVideo=null,rtcStatus='',rtcFrames=0,rtcMetricAt=0,captureCommandBusy=false;
const diagnostics=new LiveDiagnostics();
let diagnosticCleared=false;
function diagState(){return {transport:useHttp?'http':'websocket',visible:document.visibilityState,frameAgeMs:frameAt?timing.age(frameAt):null,uncertaintyMs:timing.uncertainty,msSinceDisplay:frameDrawnAt?performance.now()-frameDrawnAt:null,queueFrames:player.queue.length,drops:{...player.drops},decoder:decoder?{...decoder.counters}:null}}

const recovery=new LiveRecovery();
const player=new FramePlayer((f,at)=>drawFrame(f,f.displayWidth,f.displayHeight,at),(at,now)=>timing.fresh(at,now));
let lastLiveAt=0,frameDrawnAt=0,lastPacketAt=0,recovering=false,recoveryAt=0,httpController=null,connectedAt=0;
let streamTest=null,transport='',networkFrames=0,controlsSynced=false;
const decoder=typeof VideoDecoder==='function'?new GlassDecoder((f,at,fps)=>player.push(f,at,fps),e=>showError(new Error('동영상 해석: '+e.message))):null;
function drawFrame(image,w,h,at,oriented=false){
 if(diagnosticCleared){diagnostics.record('display_resumed',diagState());diagnosticCleared=false}
 const scale=Math.min(1,960/Math.max(w,h));
 const width=Math.round((oriented?w:h)*scale),height=Math.round((oriented?h:w)*scale);
 if(frame.width!==width||frame.height!==height){frame.width=width;frame.height=height}
 if(oriented)fg.drawImage(image,0,0,width,height);
 else{fg.save();fg.translate(0,frame.height);fg.rotate(-Math.PI/2);fg.drawImage(image,0,0,height,width);fg.restore()}
 frameAt=at;frameDrawnAt=performance.now();frameCount++;
}
const requestedMedia=new URLSearchParams(location.search).get('media'),viewerId=crypto.randomUUID();
$('#diagnostic-toggle').onclick=()=>{if(diagnostics.enabled){diagnostics.stop();$('#diagnostic-toggle').textContent='진단 기록 시작';$('#diagnostic-status').textContent='기록 중지 · 로그를 내려받을 수 있습니다.'}else{diagnostics.start();diagnostics.record('state',diagState());$('#diagnostic-toggle').textContent='진단 기록 중지';$('#diagnostic-status').textContent='기록 중 · 끊김을 재현한 뒤 로그를 내려받으세요.'}$('#diagnostic-download').disabled=false};
$('#diagnostic-download').onclick=()=>{const blob=new Blob([JSON.stringify(diagnostics.export())],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='glass-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
let useHttp=requestedMedia==='http',connectTimer=null;
async function receive(m,read=null){if(m.pong){timing.pong(m);return}if(m.kind==='hello')return;if(Number.isSafeInteger(m.n)&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({ack:m.n}));if(streamTest!==m.test){streamTest=m.test;player.clear();frameAt=0}if(m.transport)transport=m.transport;if(Number.isFinite(m.frames))networkFrames+=m.frames;
if(m.kind==='h264'||m.kind==='jpeg'){
 diagnostics.packet(m,useHttp?'http':'websocket',read);
 lastPacketAt=performance.now();
 // Decode through short bursts to preserve H.264 reference frames. Display still
 // rejects stale pictures. Abandon the encoded chain only for a real backlog.
 if(!m.config&&timing.backlogged(m.at)){timing.stalePackets++;if(!recovering){recovering=true;recoveryAt=performance.now();decoder?.reset(true);player.clear();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({keyframe:true}))}return}
 if(!m.config){lastLiveAt=performance.now();recovering=false}
}
if(m.kind==='h264'){if(!decoder)throw Error('이 브라우저는 동영상 해석을 지원하지 않습니다. Chrome 또는 연속 사진을 선택하세요.');decoder.push(m)}else if(m.kind==='jpeg'){const blob=m.bytes?new Blob([m.bytes],{type:'image/jpeg'}):await (await fetch('data:image/jpeg;base64,'+m.data)).blob();const b=await createImageBitmap(blob);if(streamTest===m.test&&m.at>=frameAt)drawFrame(b,b.width,b.height,m.at);b.close()}}
function connect(){
 if(rtcVideo)return;
 diagnostics.resetPacket();diagnostics.record('connect',{transport:useHttp?'http':'websocket'});
 clearTimeout(connectTimer);connectedAt=performance.now();lastPacketAt=lastLiveAt=frameDrawnAt=0;
 if(useHttp){const controller=new AbortController();httpController=controller;fetch('/cam/live?viewer='+viewerId,{signal:controller.signal,cache:'no-store'}).then(r=>{if(!r.ok)throw Error('영상 연결 '+r.status);return readVideo(r.body,(m,read)=>{if(httpController===controller&&!controller.signal.aborted)return receive(m,read)},controller.signal,bytes=>diagnostics.read('http',bytes))}).catch(e=>{if(httpController===controller&&!controller.signal.aborted)showError(e)}).finally(()=>{if(httpController!==controller)return;httpController=null;decoder?.reset();player.clear();connectTimer=setTimeout(connect,1000)});return}
 const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/cam/ws?binary=1');socket=ws;ws.binaryType='arraybuffer';
 ws.onopen=()=>{if(socket!==ws)return;connectedAt=performance.now();ws.send(JSON.stringify(timing.ping()))};
 ws.onmessage=async e=>{if(socket!==ws)return;const read=diagnostics.read('websocket',e.data instanceof ArrayBuffer?e.data.byteLength:null);try{if(e.data instanceof ArrayBuffer){const packet=unpack(e.data);await receive({...packet.meta,bytes:packet.bytes},read)}else await receive(JSON.parse(e.data),read)}catch(e){showError(e)}};
 ws.onclose=()=>{if(socket!==ws)return;socket=null;decoder?.reset();player.clear();connectTimer=setTimeout(connect,500)};
 ws.onerror=()=>{if(socket===ws)restartConnection()};
}
function restartConnection(){
 diagnostics.record('restart',diagState());diagnostics.resetPacket();
 clearTimeout(connectTimer);
 const old=socket;socket=null;const controller=httpController;httpController=null;controller?.abort();
 // Do not wait for a close handshake behind queued media before opening a live socket.
 if(old){old.onopen=old.onmessage=old.onclose=old.onerror=null;try{old.close(1000,'Resume live')}catch{}}
 decoder?.reset();player.clear();if(!rtcVideo)connectTimer=setTimeout(connect,300);
}
function setRtcTest(test){
 if((rtcVideo?.test??null)===test)return;
 rtcVideo?.stop();
 rtcVideo=null;
 frameAt=0;
 if(test!==null){
   rtcVideo=new RtcVideo(test,(video,captureTime)=>{
     const now=performance.now();
     const at=timing.offset+Math.min(now,captureTime);
     if(timing.offset===null||!timing.fresh(at,now))return;
     rtcFrames++;
     drawFrame(video,video.videoWidth,video.videoHeight,at,true);
   },status=>{rtcStatus=status;diagnostics.record('rtc_status',{status})});
   rtcFrames=0;rtcMetricAt=performance.now();
 }
 restartConnection();
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recovering=false;if(!frozen)frameAt=0;if(!rtcVideo)restartConnection()}});
$('#mode').onchange=()=>{$('#fps-options').hidden=$('#mode').value==='photo';$('#fps').disabled=$('#mode').value==='photo'};
$('#capture-start').onclick=async()=>{
 if(captureCommandBusy)return;
 captureCommandBusy=true;
 try{
   const selectedMode=$('#mode').value;
   const rtc=selectedMode==='webrtc',mode=selectedMode==='photo'?'photo':'video';
   if(rtc&&(typeof RTCPeerConnection!=='function'||typeof HTMLVideoElement.prototype.requestVideoFrameCallback!=='function')){
     throw Error('이 브라우저는 WebRTC 영상 표시를 지원하지 않습니다.');
   }
   const fps=mode==='video'?Number($('#fps').value):5;
   const result=await api('/cam/set?mode='+mode+'&fps='+fps+'&sec=0&kbps='+$('#quality').value+(rtc?'&transport=webrtc':''));
   if(rtc)sessionStorage.setItem('rtc-test',String(result.test));else sessionStorage.removeItem('rtc-test');
   setRtcTest(rtc?result.test:null);
   $('#capture-note').textContent='안경에 '+fps+'fps 촬영 신호를 보냈습니다.';
   frameAt=0;player.clear();decoder?.reset();$('#glasses').click();
 }catch(e){showError(e)}
 finally{captureCommandBusy=false}
};
$('#capture-stop').onclick=async()=>{
 if(captureCommandBusy)return;
 captureCommandBusy=true;
 try{
   await api('/cam/set?fps=0');
   sessionStorage.removeItem('rtc-test');
   setRtcTest(null);
   $('#capture-note').textContent='촬영 중지 신호를 보냈습니다.';
 }catch(e){showError(e)}
 finally{captureCommandBusy=false}
};

function syncRtcCapture(test){
 if(captureCommandBusy)return;
 const saved=sessionStorage.getItem('rtc-test');
 if(!rtcVideo&&test&&!test.done&&test.transport==='webrtc'&&String(test.test)===saved&&
    typeof RTCPeerConnection==='function'&&typeof HTMLVideoElement.prototype.requestVideoFrameCallback==='function'){
   $('#mode').value='webrtc';
   setRtcTest(test.test);
 }else if(rtcVideo&&test&&(test.test>rtcVideo.test||test.test===rtcVideo.test&&test.done)){
   sessionStorage.removeItem('rtc-test');
   setRtcTest(null);
 }
}
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
function renderRunState(){
 $('#start').disabled=!cvReady||loading||!matcher.refs.length||registration?.enabled;
 $('#state').textContent=loading?'등록 대상 준비 중':!cvReady?'인식 엔진 준비 중':!matcher.refs.length?'대상을 먼저 등록하세요':!state.enabled?'인식 대기 중':state.focused&&state.progress>0?'재생 진행 '+Math.round(state.progress*100)+'%':state.locked?'영상 재생 신호 전송됨':'시야의 대상 찾는 중';
}
async function refresh(snapshot){lastSnapshot=snapshot;const latest=snapshot.recognition;
if(latest.instance!==state.instance||latest.epoch>state.epoch||latest.epoch===state.epoch&&latest.at>=state.at)state=latest;
registration.observe(state.guide);
if(snapshot.camera)applyCameraStats(snapshot.camera);
const status=snapshot.status;$('#connection').textContent=(runtime.mode==='local'?'로컬 PC':'Cloudflare')+' 연결 · 안경 '+status.glasses+'대 · '+(frameAt&&performance.now()-frameDrawnAt<1200&&timing.fresh(frameAt)?'영상 수신 중':'촬영 영상 대기');$('#capture-start').disabled=!status.glasses;
renderRunState();
await library.sync(state.version);
if(cvReady&&!loading&&version!==library.version){loading=true;renderRunState();try{const nextVersion=library.version;await matcher.references(library.targets);version=nextVersion}finally{loading=false;renderRunState()}}}

let refreshing=false,pendingSnapshot=null;
async function acceptSnapshot(snapshot){
 pendingSnapshot=snapshot;if(refreshing)return;refreshing=true;
 try{while(pendingSnapshot){const current=pendingSnapshot;pendingSnapshot=null;await refresh(current)}}finally{refreshing=false}
}
const stateChannel=new StateClient({onState:acceptSnapshot,onError:showError,onPing:()=>timing.ping(),onPong:m=>timing.pong(m)});
const statusRetry=new RetryDelay();
async function poll(){
 let delay=1000;
 if(document.visibilityState==='visible'&&!stateChannel.healthy){try{const sent=performance.now(),snapshot=await api('/recognition/snapshot');if(!stateChannel.healthy){timing.observe(snapshot.recognition.serverNow,sent);await acceptSnapshot(snapshot)}statusRetry.reset();delay=2000}catch(e){showError(e);delay=statusRetry.next()}}
 setTimeout(poll,delay);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')stateChannel.start();else stateChannel.pause()});
addEventListener('pagehide',()=>stateChannel.stop());
async function recognize(){
 try{
  if(document.visibilityState==='visible'&&cvReady&&!loading&&frameCount!==matchedFrame&&frameAt&&performance.now()-frameDrawnAt<1200&&timing.fresh(frameAt)){
   const options=registration.options();
   if(options||(!registration.enabled&&state.enabled)){
    matchedFrame=frameCount;const at=frameAt,epoch=state.epoch,revision=registration.revision;
    const aim=state.guide?.calibrated?state.guide.camera:{cx:.5,cy:.5};
    const result=await matcher.process(frame,{...(options||{mode:'recognize',aim}),at});
    const age=timing.age(at)??0;
    if(revision===registration.revision&&(options?timing.fresh(at):age<1450)){
     if(result.appearanceError)showError(Error(result.appearanceError));
     if(options)registration.accept(result);
     else if(!registration.enabled){
       const data={found:result.found,aimMatch:result.aimMatch,sceneStable:result.sceneStable,at,epoch,preview:true};
       const channelResult=stateChannel.detections(data);
       const response=await(channelResult||api('/recognition/detections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));
       const preview=response.preview;
       if(preview&&preview.epoch===state.epoch&&preview.at>=state.at)state={...state,...preview};
     }
    }
   }
  }
 }catch(e){showError(e);if(registration.phase==='capture'){registration.lost=true;registration.error(Error('영역 추적을 멈췄습니다. '+(e.message||e)))}}
 setTimeout(recognize,100);
}
const foundStatus=$('#found');
const monitor=$('#hud-monitor');
function draw(now){
  player.tick(now);
  if(!frozen&&frameAt&&!timing.fresh(frameAt,now)){
    diagnostics.record('screen_clear',{reason:'frame_stale',...diagState()});
    diagnosticCleared=true;frameAt=0;g.clearRect(0,0,screen.width,screen.height);
  }
  const displayPlayback=monitor.dataset.mode==='playback'||monitor.dataset.mode==='loading';
  const showRecognition=!displayPlayback&&frameAt&&!frozen&&!registration.enabled&&(timing.age(state.at,now)??Infinity)<2200;
  const showFocus=!displayPlayback&&frameAt&&!frozen&&!registration.enabled&&state.focused&&state.focused!==state.locked&&
    (state.focusExpiresAt?now+(timing.offset??0)<state.focusExpiresAt:showRecognition);
  const detections=showRecognition?state.detections.filter(target=>!target.approximate&&!target.provisional):[];
  const caption=displayPlayback?(monitor.dataset.mode==='playback'?'안경에 연결 영상 표시 중':'안경에서 연결 영상 불러오는 중'):!frameAt?'안경 카메라 영상 대기':frozen?'등록용 화면 정지':
    detections.length?'인식된 물체 · '+detections.map(target=>target.name).join(' · '):'인식된 대상 없음';
  if(foundStatus.textContent!==caption)foundStatus.textContent=caption;
  if(frameAt){
    const source=frozen?frozenFrame:frame;
    if(screen.width!==source.width||screen.height!==source.height){
      screen.width=source.width;screen.height=source.height;
    }
    g.drawImage(source,0,0);
    for(const target of detections){
      if(target.bounds){
        const {left,right,top,bottom}=target.bounds;
        g.strokeStyle='#68ff8a';g.lineWidth=3;g.setLineDash([9,6]);
        g.strokeRect(left*screen.width,top*screen.height,(right-left)*screen.width,(bottom-top)*screen.height);
        g.setLineDash([]);
      }
      g.font='bold 18px sans-serif';g.fillStyle='#68ff8a';
      const label='▶ '+target.name;
      const [x,y]=[target.bounds?.left??target.corners[0][0],target.bounds?.top??target.corners[0][1]];
      const left=x*screen.width;
      g.fillText(label,Math.max(4,Math.min(left,screen.width-g.measureText(label).width-4)),Math.max(20,y*screen.height-8));
    }
    if(!displayPlayback)registration.draw(g,screen.width,screen.height);
    if(selected&&!displayPlayback){
      g.strokeStyle='#68ff8a';g.lineWidth=2;g.strokeRect(selected.x,selected.y,selected.w,selected.h);
    }
    if(!registration.enabled&&!displayPlayback){
      const aim=state.guide?.calibrated?state.guide.camera:{cx:.5,cy:.5};
      const x=screen.width*aim.cx,y=screen.height*aim.cy;
      g.strokeStyle='#68ff8a';g.lineWidth=2;g.beginPath();
      g.arc(x,y,20,0,Math.PI*2);g.moveTo(x-6,y);g.lineTo(x+6,y);g.moveTo(x,y-6);g.lineTo(x,y+6);g.stroke();
      g.lineWidth=5;g.beginPath();
      g.arc(x,y,26,-Math.PI/2,-Math.PI/2+Math.PI*2*(showFocus?state.progress||0:0));g.stroke();
    }
  }
  requestAnimationFrame(draw);
}
matcher.ready.then(()=>{
  cvReady=true;
  const label=$('#vision-build');
  if(label)label.textContent='인식 엔진 · '+(matcher.version||'이전 버전');
  renderRunState();if(lastSnapshot)acceptSnapshot(lastSnapshot).catch(showError);
}).catch(showError);
api('/videos.json').then(data=>{library.videos=data;$('#video-key').replaceChildren(...Object.entries(data).map(([key,v])=>{const o=document.createElement('option');o.value=key;o.textContent=v.title;return o}));library.render()}).catch(showError);
setInterval(()=>{
 if(rtcVideo){$('#live-status').textContent=rtcStatus;return}
 const now=performance.now();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(timing.ping(now)));
 const active=cameraStats?.test&&!cameraStats.test.done,visible=document.visibilityState==='visible';
 const stalled=visible&&active&&cameraStats.receiveFps>0&&connectedAt&&now-Math.max(lastLiveAt,connectedAt)>2500;
 const noFreshDisplay=displayStalled({now,connectedAt,packetAt:lastPacketAt,presentedAt:frameDrawnAt,active,visible});
 if(visible&&active&&cameraStats.receiveFps>0&&((recovering&&now-recoveryAt>1500)||stalled||noFreshDisplay)){
   diagnostics.record('screen_clear',{reason:'recovery',recovering,stalled,noFreshDisplay,...diagState()});
   useHttp=recovery.transport(useHttp?'http':'websocket',now,['http','ws','websocket'].includes(requestedMedia))==='http';
   diagnosticCleared=true;timing.recoveries++;recovering=false;connectedAt=now;lastLiveAt=0;decoder?.reset();player.clear();frameAt=0;g.clearRect(0,0,screen.width,screen.height);
   restartConnection();
 }
 $('#live-status').textContent=recovering||stalled||noFreshDisplay?'영상 지연 감지 · 최신 화면에 다시 연결합니다':frameAt?(useHttp?'연속 영상 연결':'실시간 영상 연결'):'새 영상 대기 중';
},1000);
let metricAt=performance.now(),decodedAt=0,shownAt=0,networkAt=0,cameraStats=null,metricSequence=0;
setInterval(()=>{const now=performance.now(),seconds=(now-metricAt)/1000,decoded=(player.decoded-decodedAt)/seconds,shown=(player.shown-shownAt)/seconds,network=(networkFrames-networkAt)/seconds;networkAt=networkFrames;metricAt=now;decodedAt=player.decoded;shownAt=player.shown;
const metrics={stalePackets:timing.stalePackets,recoveries:timing.recoveries,relayAgeMs:frameAt?timing.age(frameAt):null,clockUncertaintyMs:timing.uncertainty,seq:++metricSequence,networkFps:network,visible:document.visibilityState==='visible',decodedFps:decoded,displayFps:frozen?0:shown,frameAgeMs:frameAt?(timing.age(frameAt)??0):0,frozen,totalReceived:networkFrames,totalDecoded:player.decoded,totalDisplayed:player.shown,displayDrops:player.dropped,queueFrames:player.queue.length,maxFrameQueue:player.maxQueue,maxRafGap:player.maxRafGap,displayWaitMs:player.lastWaitMs,maxDisplayWaitMs:player.maxWaitMs,playerDrops:player.drops,decoder:decoder?.counters};
diagnostics.record('metrics',{...metrics,transport:useHttp?'http':'websocket'});
if(document.visibilityState==='visible'&&useHttp)api('/cam/viewer-metrics?viewer='+viewerId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(metrics)}).catch(()=>{});else if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({metrics}));
const active=cameraStats?.test&&!cameraStats.test.done;
$('#stream-stats').textContent=active?'설정 '+cameraStats.test.fps+'fps · 서버 '+cameraStats.receiveFps+'fps · 웹 도착 '+network.toFixed(1)+'fps · 해석 '+decoded.toFixed(1)+'fps · 표시 '+(frozen?'정지':shown.toFixed(1)+'fps'):'촬영 대기';
if(rtcVideo){
 const fps=rtcFrames/Math.max(.001,(now-rtcMetricAt)/1000);
 $('#stream-stats').textContent='WebRTC · '+(frozen?'표시 정지':'웹 프레임 '+fps.toFixed(1)+'fps');
 rtcFrames=0;rtcMetricAt=now;
}

},2000);
function applyCameraStats(stats){cameraStats=stats;syncRtcCapture(stats.test);const active=stats.test&&!stats.test.done;if(active&&!controlsSynced){$('#fps').value=String(stats.test.fps);$('#quality').value=String(stats.test.kbps);controlsSynced=true}$('#transport-note').textContent=active?(stats.test.transport==='webrtc'?'WebRTC · 같은 Wi-Fi에서 안경과 PC 한 대 연결':stats.test.transport==='http'&&stats.test.mode==='video'?'이전 앱의 HTTP 전송 중입니다. 연결 설정에서 앱 버전을 확인하세요.':transport==='websocket'?'연속 영상 전송 연결됨':'영상 연결 대기'):''}
connect();stateChannel.start();poll();recognize();requestAnimationFrame(draw);
