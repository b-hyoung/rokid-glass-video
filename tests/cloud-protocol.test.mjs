import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {TargetStore,MAX_IMAGES} from '../cloud/target-store.mjs';
import {GlassRoom} from '../cloud/worker.mjs';
import {pack,unpack} from '../cloud/stream-protocol.mjs';
import {DWELL_MS} from '../cloud/request-policy.mjs';
function room(){
 const db=new DatabaseSync(':memory:');
 const storage={sql:{exec(query,...args){const statement=db.prepare(query);if(/^SELECT|RETURNING/i.test(query))return {toArray:()=>statement.all(...args)};statement.run(...args);return {toArray:()=>[]}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const ctx={storage,getWebSockets:()=>[]};const env={ASSETS:{fetch:async()=>Response.json({e:{title:'마주봄',file:'majubom_box.mp4'},v:{title:'VR',file:'visionpro_scan.mp4'}})}};
 const r=new GlassRoom(ctx,env);const request=async(path,data,method)=>{const response=await r.fetch(new Request('https://example.test'+path,{method:method||(data?'POST':'GET'),body:data?JSON.stringify(data):undefined}));return response.json()};return {r,request,storage,db};
}
test('existing app long polling receives camera and playback commands in order',async()=>{const {request}=room();const first=await request('/next?id=test');const waiting=request('/next?id=test&after='+first.seq);await request('/cam/set?mode=video&fps=30&sec=0');const camera=await waiting;assert.equal(camera.cmd,'cam');assert.equal(camera.mode,'video');await request('/play?key=e');const play=await request('/next?id=test&after='+camera.seq);assert.equal(play.key,'e');assert.equal(play.url,'/v/majubom_box.mp4')});
test('short recognition gaps keep a box and pause dwell without transferring it to a different object',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';
 const a=await request('/recognition/targets',{name:'Bag',key:'e',image});
 const b=await request('/recognition/targets',{name:'Car',key:'v',image});
 const corners=[[.35,.35],[.65,.35],[.65,.65],[.35,.65]];
 const report=(found,sceneStable=true)=>request('/recognition/detections',{epoch:r.epoch,at:Date.now(),found,sceneStable});
 const bag={id:a.targetId,corners},car={id:b.targetId,corners};
 await request('/recognition/control?enabled=1',{},'POST');
 await report([bag]);
 r.focusAt-=1000;
 await report([bag]);
 const progress=r.state.progress;
 r.lastResult-=800;
 await report([]);
 assert.equal(r.state.detections[0].held,true);
 assert.equal(r.state.focusMissing,true);
 assert.equal(r.state.progress,progress);
 await report([bag]);
 assert.ok(Math.abs(r.state.progress-progress)<.01);
 await report([car]);
 assert.deepEqual(r.state.detections.map(t=>t.id),[b.targetId]);
 assert.equal(r.state.focused,b.targetId);
 assert.equal(r.state.progress,0);
 await report([],false);
 assert.equal(r.state.detections.length,0);
 assert.equal(r.commands.length,0);
});
test('paused dwell resumes only for the same track within its lease',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';
 const target=await request('/recognition/targets',{name:'Bag',key:'e',image});
 const bag={id:target.targetId,trackId:'track-a',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]]};
 const report=found=>request('/recognition/detections',{epoch:r.epoch,at:Date.now(),found});
 await request('/recognition/control?enabled=1',{},'POST');
 await report([bag]);
 r.focusAt-=1200;
 await report([bag]);
 const progress=r.state.progress;
 await report([]);
 r.state.focusMissingAt-=1800;
 r.lastResult-=1800;
 const status=await request('/recognition/status');
 assert.equal(status.focusMissing,true);
 assert.equal(status.focused,target.targetId);
 await report([bag]);
 assert.ok(r.state.progress>=progress&&r.state.progress<=progress+150/DWELL_MS);
 assert.equal(r.state.focusMode,'advancing');
 await report([]);
 await report([{...bag,trackId:'track-b'}]);
 assert.equal(r.state.progress,0);
 assert.equal(r.state.focusTrackId,'track-b');
 r.focusAt-=700;
 await report([{...bag,trackId:'track-b'}]);
 await report([]);
 r.state.focusMissingAt-=2600;
 await report([{...bag,trackId:'track-b'}]);
 assert.equal(r.state.progress,0);
 assert.equal(r.commands.length,0);
});

test('alternating live and held results must accumulate only short live observations',async()=>{
 const original=Date.now;
 let now=200000;
 Date.now=()=>now;
 try{
  const {r,request}=room();
  const target=await request('/recognition/targets',{name:'Bag',key:'e',image:'data:image/jpeg;base64,/9j/'});
  await request('/recognition/control?enabled=1',{},'POST');
  const bag={id:target.targetId,trackId:'stable',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]]};
  const report=held=>request('/recognition/detections',{epoch:r.epoch,at:now,found:[{...bag,held}]});
  await report(false);
  for(let i=0;i<4;i++){
   now+=200;await report(true);
   now+=200;await report(false);
  }
  assert.ok(r.state.progress>0,'every resumed result previously pinned progress back to zero');
  assert.equal(Math.round(r.state.progress*DWELL_MS),600,'credit at most 150ms per resumed observation');
  assert.equal(r.commands.length,0);
  for(let i=0;i<20&&!r.commands.length;i++){
   const previous=r.state.progress;
   now+=200;await report(true);
   assert.equal(r.state.progress,previous);
   now+=200;await report(false);
  }
  assert.equal(r.commands.at(-1)?.key,'e','intermittent confirmed observations eventually complete dwell');
 }finally{Date.now=original}
});
test('a continuously observed target plays at 1500ms but not before',async()=>{
 const realNow=Date.now;
 const started=300000;
 let now=started;
 Date.now=()=>now;
 try{
  const {r,request}=room();
  const target=await request('/recognition/targets',{name:'Bag',key:'e',image:'data:image/jpeg;base64,/9j/'});
  await request('/recognition/control?enabled=1',{},'POST');
  const found=[{id:target.targetId,trackId:'stable',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]]}];
  for(const elapsed of [0,300,600,900,1200,1499]){
   now=started+elapsed;
   await request('/recognition/detections',{epoch:r.epoch,at:now,found});
   assert.equal(r.commands.length,0);
  }
  now=started+1500;
  await request('/recognition/detections',{epoch:r.epoch,at:now,found});
  assert.equal(r.commands.at(-1)?.key,'e');
  assert.equal((await request('/recognition/status')).dwellMs,1500);
 }finally{Date.now=realNow}
});

test('650ms recognition samples with one stable track complete dwell without resetting',async()=>{
 const original=Date.now;
 let now=300000;
 Date.now=()=>now;
 try{
  const {r,request}=room();
  const target=await request('/recognition/targets',{name:'Car',key:'e',image:'data:image/jpeg;base64,/9j/'});
  await request('/recognition/control?enabled=1',{},'POST');
  const detection={id:target.targetId,trackId:'continuous',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]]};
  let progress=0;
  for(let i=0;i<12&&!r.commands.length;i++){
   await request('/recognition/detections',{epoch:r.epoch,at:now-470,found:[detection]});
   assert.ok(r.state.progress>=progress);
   progress=r.state.progress;
   now+=650;
  }
  assert.equal(r.commands.at(-1)?.key,'e');
 }finally{Date.now=original}
});

test('WebRTC capture routes signaling only within the active session and leaves video recovery to its peers',async()=>{
 const {r,request}=room();
 const first=await request('/next?id=test');
 const {test:session}=await request('/cam/set?mode=video&fps=30&transport=webrtc');
 const command=await request('/next?id=test&after='+first.seq);
 assert.equal(command.transport,'webrtc');
 const peer=(role,test=session)=>({
   readyState:1,messages:[],
   deserializeAttachment:()=>({role,test}),
   send(message){this.messages.push(JSON.parse(message))},
   close(){this.readyState=3}
 });
 const device=peer('rtc-device'),viewer=peer('rtc-viewer'),stale=peer('rtc-viewer',session-1);
 r.ctx.getWebSockets=()=>[device,viewer,stale];
 const offer={type:'offer',id:'offer-1',sdp:'v=0'};
 const answer={type:'answer',id:'offer-1',sdp:'v=0'};
 r.webSocketMessage(stale,JSON.stringify(offer));
 r.webSocketMessage(viewer,JSON.stringify(answer));
 r.webSocketMessage(viewer,new ArrayBuffer(8));
 assert.deepEqual(device.messages,[]);
 r.webSocketMessage(viewer,JSON.stringify(offer));
 r.webSocketMessage(device,JSON.stringify(answer));
 assert.deepEqual(device.messages,[offer]);
 assert.deepEqual(viewer.messages,[answer]);
 assert.equal(r.viewers().length,0);
 assert.equal(r.stream(new Uint8Array([0,0,0,1]),{test:session,transport:'http'}),false);
 r.test.cmdAt=0;
 r.recoverCamera();
 assert.equal(r.test.test,session);
 await request('/cam/set?fps=0');
 assert.equal(viewer.readyState,3);
 assert.equal(device.readyState,3);
});
test('two visible targets, center dwell, switch, stale result and deletion',async()=>{const {r,request}=room();const image='data:image/jpeg;base64,/9j/';await request('/recognition/targets',{name:'판넬',key:'e',image});await request('/recognition/targets',{name:'VR',key:'v',image});let status=await request('/recognition/status');const [a,b]=status.targets;
await request('/recognition/control?enabled=1',{},'POST');status=await request('/recognition/status');const center=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],side=[[.05,.1],[.2,.1],[.2,.3],[.05,.3]];
let found=[{id:a.id,corners:center,inliers:25},{id:b.id,corners:side,inliers:20}];await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.state.detections.length,2);assert.equal(r.state.focused,a.id);assert.equal(r.commands.length,0);
r.focusAt-=2600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'e');const n=r.commands.length;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.length,n);
found=[{id:a.id,corners:side,inliers:25},{id:b.id,corners:center,inliers:20}];await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=2600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'e');assert.equal(r.commands.length,n);
const playing=r.playback.current();await request('/recognition/playback',{id:playing.id,event:'stopped'});
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=2600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.length,0);
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found:[]});
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=2600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'v');
assert.equal((await request('/recognition/detections',{epoch:status.epoch,at:Date.now()-5000,found})).stale,true);
await request('/recognition/targets?id='+a.id,null,'DELETE');assert.equal((await request('/recognition/status')).targets.length,1);assert.equal(r.state.detections.length,0);
});
test('thermal stop and stale camera uploads do not enter the live feed',async()=>{const {r,request}=room();await request('/cam/set?mode=video&fps=30');await request('/tele?temp=460&th=0&bat=70');assert.equal(r.test.done,true);assert.equal(r.commands.at(-1).fps,0);const res=await r.fetch(new Request('https://example.test/stream?test='+r.test.test,{method:'POST',body:new Uint8Array([0,0,0,1])}));assert.equal((await res.json()).stale,true);assert.equal(r.recent.length,0)});

test('legacy image migration preserves identity and does not resurrect deleted views',()=>{
 const {storage}=room();
 storage.sql.exec('INSERT INTO targets VALUES (?,?,?,?)','legacy','Rokid 상자','e','data:image/jpeg;base64,OLD');
 let store=new TargetStore(storage);assert.equal(store.list(true)[0].id,'legacy');assert.equal(store.list(true)[0].images[0].image,'data:image/jpeg;base64,OLD');
 const oldId=store.list(true)[0].images[0].id;store.addImage('legacy','data:image/jpeg;base64,NEW');store.deleteImage('legacy',oldId);
 store=new TargetStore(storage);assert.equal(store.list(true)[0].images.length,1);assert.equal(store.list(true)[0].images[0].image,'data:image/jpeg;base64,NEW');
 assert.equal(store.list()[0].imageCount,1);assert.equal(store.list()[0].images,undefined);
});
test('multiple images belong to one target and deletion is scoped to that target',async()=>{
 const {r,request,storage}=room(),image='data:image/jpeg;base64,/9j/';
 const a=await request('/recognition/targets',{name:'상자',key:'e',image});
 const b=await request('/recognition/targets',{name:'VR',key:'v',image});
 const extra=await request('/recognition/images',{targetId:a.targetId,image});
 let all=await request('/recognition/targets');assert.equal(all.targets.length,2);assert.equal(all.targets[0].images.length,2);assert.equal(all.targets[1].images.length,1);
 await request('/recognition/images?targetId='+b.targetId+'&id='+extra.imageId,null,'DELETE');
 assert.equal(r.store.list(true)[0].images.length,2);
 await request('/recognition/images?targetId='+a.targetId+'&id='+extra.imageId,null,'DELETE');assert.equal(r.store.list(true)[0].images.length,1);
 for(let i=1;i<MAX_IMAGES;i++)await request('/recognition/images',{targetId:a.targetId,image});
 assert.match((await request('/recognition/images',{targetId:a.targetId,image})).error,/최대/);
 const first=r.store.list(true)[1].images[0].id;await request('/recognition/images?targetId='+b.targetId+'&id='+first,null,'DELETE');
 assert.equal(r.store.list(true)[1].images.length,0);new TargetStore(storage);assert.equal(r.store.list(true)[1].images.length,0);
 await request('/recognition/targets?id='+a.targetId,null,'DELETE');assert.equal(r.store.list().length,1);assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM target_images').toArray()[0].n,0);
});
test('two matched views of one object keep one box and one playback identity',async()=>{
 const {r,request}=room();const a=await request('/recognition/targets',{name:'상자',key:'e',image:'data:image/jpeg;base64,/9j/'});
 await request('/recognition/control?enabled=1',{},'POST');const epoch=r.epoch,corners=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
 const post=found=>request('/recognition/detections',{at:Date.now(),epoch,found});
 await post([{id:a.targetId,corners,inliers:12},{id:a.targetId,corners,inliers:24}]);assert.equal(r.state.detections.length,1);assert.equal(r.state.detections[0].inliers,24);
 r.focusAt-=2600;await post([{id:a.targetId,corners,inliers:18}]);assert.equal(r.commands.length,1);
 await post([{id:a.targetId,corners,inliers:35}]);assert.equal(r.commands.length,1);assert.equal(r.state.locked,a.targetId);
});

test('continuous binary upload relays every frame without waiting for acknowledgements',async()=>{
 const {r,request}=room();await request('/cam/set?mode=video&fps=60');const received=[],acks=[];
 const viewer={deserializeAttachment:()=>({role:'viewer'}),send:x=>received.push(x)};
 const camera={deserializeAttachment:()=>({role:'camera',test:r.test.test,id:'glasses'}),send:x=>acks.push(JSON.parse(x)),close:()=>assert.fail('valid camera closed')};
 r.ctx.getWebSockets=()=>[viewer,camera];
 // Three packets, each carrying six complete one-slice access units.
 const bytes=new Uint8Array(Array.from({length:6},()=>[0,0,0,1,0x65,0x80]).flat());
 for(let seg=0;seg<3;seg++)r.webSocketMessage(camera,pack({test:r.test.test,seg,sentAt:100+seg},bytes));
 assert.equal(r.test.frames,18);assert.equal(r.test.segments,3);assert.equal(received.length,3);assert.equal(acks.length,3);
 assert.deepEqual(acks.map(x=>x.ack),[0,1,2]);assert.equal(r.test.transport,'websocket');
 for(const packet of received){const meta=JSON.parse(packet);assert.equal(meta.complete,true);assert.deepEqual(new Uint8Array(Buffer.from(meta.data,'base64')),bytes)}
 const status=await request('/status');assert.equal(status.viewers,1);assert.equal(status.glasses,1);
 // A viewer cannot inject video. An old camera cannot continue after stop.
 r.webSocketMessage(viewer,pack({test:r.test.test,seg:4},bytes));assert.equal(r.test.frames,18);
 await request('/cam/set?fps=0');let closed=0;camera.close=()=>closed++;r.webSocketMessage(camera,pack({test:r.test.test,seg:4},bytes));assert.equal(closed,1);assert.equal(received.length,3);
});

test('malformed binary messages close the uploader without corrupting the live stream',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');let closed=0;
 const camera={deserializeAttachment:()=>({role:'camera',test:r.test.test}),close:()=>closed++};
 for(const bytes of [new ArrayBuffer(1),new Uint8Array([255,255,255,255]).buffer,pack({test:0,seg:0},new Uint8Array())])r.webSocketMessage(camera,bytes);
 assert.equal(closed,3);assert.equal(r.test.frames,0);
});

test('a slow viewer cannot accumulate old video and resumes only on a key frame',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const received=[];
 const viewer={deserializeAttachment:()=>({role:'viewer'}),send:x=>received.push(JSON.parse(x))};r.ctx.getWebSockets=()=>[viewer];
 const frame=type=>new Uint8Array([0,0,0,1,type,0x80]);
 for(let seg=0;seg<20;seg++)r.stream(frame(0x65),{test:r.test.test,seg,transport:'websocket'});
 assert.equal(received.length,12);assert.equal(r.delivery.get(viewer).pending.length,12);
 r.webSocketMessage(viewer,JSON.stringify({ack:received.at(-1).n}));
 r.stream(frame(0x41),{test:r.test.test,seg:20,transport:'websocket'});assert.equal(received.length,12);
 r.stream(frame(0x65),{test:r.test.test,seg:21,transport:'websocket'});assert.equal(received.length,13);assert.equal(received.at(-1).seg,21);
 assert.equal(r.delivery.get(viewer).pending.length,1);
});

test('camera state survives a worker restart and explicit stop stays stopped',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const id=r.test.test;
 let restored=new GlassRoom(r.ctx,r.env);assert.equal(restored.test.test,id);assert.equal(restored.test.fps,60);
 const hello=await (await restored.fetch(new Request('https://example.test/next?id=glasses'))).json();assert.equal(hello.cmd,undefined);
 const next=await (await restored.fetch(new Request('https://example.test/next?id=glasses&after='+hello.seq))).json();assert.equal(next.cmd,'cam');assert.equal(next.test,id);
 await restored.fetch(new Request('https://example.test/cam/set?fps=0'));restored=new GlassRoom(r.ctx,r.env);assert.equal(restored.test.done,true);
 const stopped=await (await restored.fetch(new Request('https://example.test/next?id=glasses'))).json();assert.equal(stopped.cmd,undefined);
});

test('only a connected camera with stalled frames is automatically reopened',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');r.startedAt=Date.now()-60000;r.test.cmdAt=Date.now()-60000;r.test.lastAt=Date.now()-20000;
 const before=r.commands.length;r.recoverCamera();assert.equal(r.commands.length,before);
 r.seen.set('glasses',Date.now());r.recoverCamera();assert.equal(r.commands.length,before+1);assert.equal(r.commands.at(-1).fps,60);assert.equal(r.test.retries,1);
 r.recoverCamera();assert.equal(r.commands.length,before+1);
 await request('/cam/set?fps=0');r.test.cmdAt=0;r.recoverCamera();assert.equal(r.commands.at(-1).fps,0);
});

test('700ms acknowledgement round trips sustain every 60fps packet without keyframe resets',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const received=[],acks=[];let clock=Date.now();
 const viewer={deserializeAttachment:()=>({role:'viewer'}),send:text=>{const m=JSON.parse(text);received.push(m);acks.push({at:clock+700,n:m.n})}};r.ctx.getWebSockets=()=>[viewer];
 const realNow=Date.now;Date.now=()=>clock;
 try{for(let seg=0;seg<120;seg++){
   while(acks.length&&acks[0].at<=clock)r.webSocketMessage(viewer,JSON.stringify({ack:acks.shift().n}));
   const bytes=new Uint8Array(Array.from({length:6},(_,i)=>[0,0,0,1,seg%10===0&&i===0?0x65:0x41,0x80]).flat());
   r.stream(bytes,{test:r.test.test,seg,transport:'websocket'});clock+=100;
 }}finally{Date.now=realNow}
 assert.equal(received.length,120);assert.equal(r.test.frames,720);assert.equal(r.delivery.get(viewer).dropped,0);assert.equal(r.delivery.get(viewer).window,11);
});

test('HTTP viewers receive current keyframes, then continuous packets, and are removed on cancel',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');
 const response=await r.fetch(new Request('https://example.test/cam/live?viewer=check')),reader=response.body.getReader();
 assert.equal(response.headers.get('Content-Type'),'application/octet-stream');await reader.read();assert.equal(r.httpViewers.size,1);
 r.stream(new Uint8Array([0,0,0,1,0x41,0x80]),{test:r.test.test,seg:0,transport:'websocket'});
 r.stream(new Uint8Array([0,0,0,1,0x65,0x80]),{test:r.test.test,seg:1,transport:'websocket'});
 const {value}=await reader.read(),{meta}=unpack(value.slice(4).buffer);assert.equal(meta.seg,1);assert.equal(meta.frames,1);
 await reader.cancel();assert.equal(r.httpViewers.size,0);
});

test('HTTP keyframe recovery includes cached codec config and ignores old metric reports',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');
 const response=await r.fetch(new Request('https://example.test/cam/live?viewer=check')),reader=response.body.getReader();await reader.read();
 // Legacy HTTP cameras may send SPS/PPS separately before the first key frame.
 r.stream(new Uint8Array([0,0,0,1,0x67,0x42,0,31,0,0,0,1,0x68,0]),{test:r.test.test,seg:0,transport:'http'});
 r.stream(new Uint8Array([0,0,0,1,0x65,0x80]),{test:r.test.test,seg:1,transport:'http'});
 const {value}=await reader.read(),{bytes}=unpack(value.slice(4).buffer);
 assert.deepEqual([...bytes.slice(0,8)],[0,0,0,1,0x67,0x42,0,31]);
 const metrics={seq:2,networkFps:60,decodedFps:60,displayFps:59,frameAgeMs:500};
 await request('/cam/viewer-metrics?viewer=check',metrics);
 await request('/cam/viewer-metrics?viewer=check',{...metrics,seq:1,displayFps:10});
 assert.equal(r.httpViewers.get('check').metrics.displayFps,59);await reader.cancel();
});

test('new HTTP viewers request one shared keyframe without flooding the camera',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const messages=[];
 const camera={deserializeAttachment:()=>({role:'camera'}),send:text=>messages.push(JSON.parse(text))};r.ctx.getWebSockets=()=>[camera];
 const realNow=Date.now;const now=realNow();Date.now=()=>now;
 try{
  const a=await r.fetch(new Request('https://example.test/cam/live?viewer=a'));
  const b=await r.fetch(new Request('https://example.test/cam/live?viewer=b'));
  assert.deepEqual(messages,[{keyframe:true}]);
  r.stream(new Uint8Array([0,0,0,1,0x41,0x80]),{test:r.test.test,seg:0,transport:'websocket'});
  assert.equal(r.httpViewers.get('a').droppedWaitingKey,1);assert.equal(r.httpViewers.get('a').droppedBackpressure,0);
  await a.body.cancel();await b.body.cancel();
 }finally{Date.now=realNow}
});

test('registration guide persists alignment but its lease and device capability expire',async()=>{
 const {r,request}=room();
 const config={shape:'circle',hud:{cx:.4,cy:.5,width:.4,height:.4},camera:{cx:.65,cy:.4,width:.3,height:.3},calibrated:true};
 let d=await request('/recognition/guide',{owner:'browser-a',enabled:true,config,save:true,phase:'align'});assert.equal(d.enabled,true);assert.equal(d.shape,'circle');
 assert.match((await request('/recognition/guide',{owner:'browser-b',enabled:false})).error,/다른 화면/);
 assert.match((await request('/recognition/guide',{owner:'browser-a',enabled:true,config:{...config,hud:{...config.hud,cx:.95}}})).error,/밖/);
 d=await request('/recognition/status?hud=2&app=0.2.9');assert.equal(d.guide.device.app,'0.2.9');assert.equal(r.guide.read(Date.now()+11000).device,null);assert.equal(r.guide.read(Date.now()+6000).enabled,false);
 const restored=new GlassRoom(r.ctx,r.env);assert.equal(restored.guide.read().enabled,false);assert.deepEqual(restored.guide.config,config);
});

test('guide suppresses playback and calibrated camera center drives dwell after guide closes',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';
 const target=await request('/recognition/targets',{name:'상자',key:'e',image});await request('/recognition/control?enabled=1',{});
 const config={shape:'rect',hud:{cx:.5,cy:.5,width:.4,height:.4},camera:{cx:.75,cy:.3,width:.3,height:.3},calibrated:true};
 await request('/recognition/guide',{owner:'a',enabled:true,config,save:true});assert.equal(r.state.enabled,false);
 assert.match((await request('/recognition/control?enabled=1',{})).error,/가이드/);
 assert.equal((await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found:[]})).stale,true);
 await request('/recognition/guide',{owner:'a',enabled:false});await request('/recognition/control?enabled=1',{});
 const found=[{id:target.targetId,inliers:20,corners:[[.65,.2],[.85,.2],[.85,.4],[.65,.4]]}];await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found});assert.equal(r.state.focused,target.targetId);r.focusAt-=2600;await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found});assert.equal(r.commands.at(-1).key,'e');
});

test('video batches are atomic, retry-safe, capped and preserve original images',async()=>{
 const {r,request,storage}=room(),image='data:image/jpeg;base64,/9j/';
 const old=await request('/recognition/targets',{name:'기존 상자',key:'e',image});
 const d={targetId:old.targetId,batchId:'video-batch-001',images:Array.from({length:3},()=>({image,capture:{source:'video',atMs:700,features:40,sharpness:150}}))};
 const first=await request('/recognition/images/batch',d);assert.equal(first.count,3);assert.deepEqual(await request('/recognition/images/batch',d),first);
 assert.equal(r.store.list(true)[0].images.length,4);assert.equal(r.store.list(true)[0].images.filter(i=>i.capture?.features===40).length,3);
 const tooMany=await request('/recognition/images/batch',{...d,batchId:'video-batch-002',images:Array.from({length:60},()=>({image}))});assert.match(tooMany.error,/저장할 수/);assert.equal(r.store.list(true)[0].images.length,4);
 const invalid=await request('/recognition/images/batch',{name:'잘못된 신규',key:'e',batchId:'video-batch-003',images:[{image},{image:'bad'}]});assert.ok(invalid.error);assert.equal(r.store.list().length,1);
 await request('/recognition/images?targetId='+old.targetId+'&id='+first.imageIds[0],null,'DELETE');assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM target_image_info').toArray()[0].n,2);
 new TargetStore(storage);assert.equal(r.store.list(true)[0].images.length,3);
 await request('/recognition/targets?id='+old.targetId,null,'DELETE');assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM target_image_info').toArray()[0].n,0);
 assert.equal(storage.sql.exec('SELECT COUNT(*) AS n FROM target_batches').toArray()[0].n,0);
});

test('external photos register without glasses or vectors and retry without duplicates',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';
 const batch={name:'외부 사진 대상',key:'e',batchId:'photo-batch-001',images:[
  {image,capture:{source:'photo',filename:'정면.png'}},
  {image,capture:{source:'photo',filename:'측면.webp'}}
 ]};
 const created=await request('/recognition/images/batch',batch);
 assert.equal(created.count,2);
 assert.deepEqual(await request('/recognition/images/batch',batch),created);
 let target=r.store.list(true)[0];
 assert.equal(target.name,batch.name);assert.equal(target.key,'e');
 assert.equal(target.appearance,null);assert.equal(target.images.length,2);
 assert.deepEqual(target.images.map(i=>i.capture).sort((a,b)=>a.filename.localeCompare(b.filename)),batch.images.map(i=>i.capture).sort((a,b)=>a.filename.localeCompare(b.filename)));
 await request('/recognition/images/batch',{targetId:created.targetId,batchId:'photo-batch-002',images:[batch.images[0]]});
 target=r.store.list(true)[0];
 assert.equal(target.images.length,3);assert.equal(r.store.list().length,1);
 assert.equal(r.test,null);assert.equal(r.commands.length,0);
 const invalid=await request('/recognition/images/batch',{...batch,batchId:'photo-batch-003',images:[batch.images[0],{image:'bad'}]});
 assert.ok(invalid.error);assert.equal(r.store.list(true)[0].images.length,3);
});

test('optical flow without a recent identity match cannot trigger playback',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';const target=await request('/recognition/targets',{name:'상자',key:'e',image});await request('/recognition/control?enabled=1',{});
 const detection={id:target.targetId,inliers:20,corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],matchedAt:Date.now()-1400};
 await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found:[detection]});r.focusAt-=2600;
 await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found:[detection]});assert.equal(r.commands.length,0);
 await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found:[{...detection,matchedAt:Date.now()}]});assert.equal(r.commands.at(-1).key,'e');
});

test('binary viewers receive original bytes, server-clock pongs and complete metrics',async()=>{
 const {r,request}=room();await request('/cam/set?mode=video&fps=60');const messages=[];
 const viewer={deserializeAttachment:()=>({role:'viewer',binary:true}),send:m=>messages.push(m)};r.ctx.getWebSockets=()=>[viewer];
 const bytes=new Uint8Array([0,0,0,1,0x65,0x80]);r.stream(bytes,{test:r.test.test,seg:0,transport:'websocket'});
 assert.ok(messages[0] instanceof ArrayBuffer);assert.deepEqual(unpack(messages[0]).bytes,bytes);
 r.webSocketMessage(viewer,JSON.stringify({ping:1}));assert.equal(JSON.parse(messages[1]).pong,1);assert.ok(JSON.parse(messages[1]).serverNow>0);
 const metrics={seq:1,networkFps:60,decodedFps:60,displayFps:58,frameAgeMs:200,relayAgeMs:180,stalePackets:2,recoveries:1,clockUncertaintyMs:50,visible:true,totalDisplayed:100,decoder:{errors:0},playerDrops:{overflow:2}};
 r.webSocketMessage(viewer,JSON.stringify({ack:unpack(messages[0]).meta.n,metrics}));assert.equal(r.delivery.get(viewer).pending.length,0);assert.equal(r.delivery.get(viewer).metrics.stalePackets,2);assert.equal(r.delivery.get(viewer).metrics.totalDisplayed,100);
});

test('binary viewer window survives variable round trips while remaining bounded',async()=>{
 const {r,request}=room();await request('/cam/set?mode=video&fps=60');let now=Date.now();const real=Date.now,acks=[],messages=[];
 const viewer={deserializeAttachment:()=>({role:'viewer',binary:true}),send:m=>{const p=unpack(m).meta;messages.push(p);acks.push({at:now+(p.seg%20<10?250:1100),n:p.n})}};r.ctx.getWebSockets=()=>[viewer];Date.now=()=>now;
 try{for(let seg=0;seg<120;seg++){for(let i=acks.length-1;i>=0;i--)if(acks[i].at<=now){r.webSocketMessage(viewer,JSON.stringify({ack:acks[i].n}));acks.splice(i,1)}r.stream(new Uint8Array([0,0,0,1,0x65,0x80]),{test:r.test.test,seg,transport:'websocket'});now+=100}}finally{Date.now=real}
 assert.equal(messages.length,120);assert.ok(r.delivery.get(viewer).window<=32);
});

test('a browser close without a status code receives a valid close reply',()=>{
 const {r}=room(),calls=[],ws={close:(code,reason)=>{assert.notEqual(code,1005);assert.notEqual(code,1006);calls.push({code,reason})}};
 r.delivery.set(ws,{});r.webSocketClose(ws,1005,'');assert.equal(r.delivery.has(ws),false);assert.equal(calls[0].code,1000);
 r.webSocketClose(ws,1006,'abnormal');assert.equal(calls[1].code,1000);
 r.webSocketClose(ws,1001,'going away');assert.equal(calls[2].code,1001);
});

test('loading and loop playback stay locked; stale completions cannot unlock a manual replacement',async()=>{
 const {r,request,storage}=room();await request('/play?key=e');const first=r.playback.current();
 assert.equal(first.state,'loading');assert.equal((await request('/recognition/status')).playback.id,first.id);
 await request('/recognition/playback',{id:first.id,event:'playing'});assert.equal(r.playback.current().state,'playing');
 const restarted=new GlassRoom(r.ctx,r.env);assert.equal(restarted.playback.current().id,first.id);
 await request('/play?key=v');const second=r.playback.current();assert.notEqual(first.id,second.id);
 assert.equal((await request('/recognition/playback',{id:first.id,event:'completed'})).accepted,false);assert.equal(r.playback.current().id,second.id);
 await request('/cam/set?fps=60');assert.equal(r.playback.current().id,second.id);
 await request('/stop');assert.equal(r.playback.current(),null);assert.equal(r.commands.filter(x=>x.cmd==='play').length,0);
 assert.equal((await request('/recognition/playback',{id:second.id,event:'playing'})).accepted,false);
});

test('concurrent dwell requests issue one video and a stop during video lookup cancels autoplay',async()=>{
 const {r,request}=room();const t=await request('/recognition/targets',{name:'상자',key:'e',image:'data:image/jpeg;base64,/9j/'});await request('/recognition/control?enabled=1',{});
 const payload=()=>({epoch:r.epoch,at:Date.now(),found:[{id:t.targetId,corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],inliers:25}]});
 await request('/recognition/detections',payload());r.focusAt-=2600;
 await Promise.all([request('/recognition/detections',payload()),request('/recognition/detections',payload())]);assert.equal(r.commands.filter(x=>x.cmd==='play').length,1);
 await request('/stop');await request('/recognition/detections',{epoch:r.epoch,at:Date.now(),found:[]});r.locked=null;
 await request('/recognition/detections',payload());r.focusAt-=2600;
 let release;r.env.ASSETS.fetch=()=>new Promise(resolve=>{release=()=>resolve(Response.json({e:{title:'영상',file:'e.mp4'}}))});
 const pending=request('/recognition/detections',payload());while(!release)await new Promise(resolve=>setImmediate(resolve));
 await request('/stop');release();await pending;assert.equal(r.commands.filter(x=>x.cmd==='play').length,0);
});

test('native seed transport is bounded and older frames cannot replace newer coordinates',async()=>{
 const {r,request}=room();const t=await request('/recognition/targets',{name:'상자',key:'e',image:'data:image/jpeg;base64,/9j/'});await request('/recognition/control?enabled=1',{});
 const seed={w:180,h:320,points:Array.from({length:4},(_,i)=>({x:20+i*12,y:50,patch:Buffer.alloc(49,i).toString('base64')}))};
 const at=Date.now(),found=[{id:t.targetId,seed,corners:[[.1,.1],[.4,.1],[.4,.4],[.1,.4]]}];
 await request('/recognition/detections',{at,epoch:r.epoch,found});assert.deepEqual(r.state.detections[0].seed,seed);assert.equal(r.state.frameAt,at);
 assert.equal((await request('/recognition/detections',{at:at-1,epoch:r.epoch,found:[]})).stale,true);assert.equal(r.state.detections.length,1);
 seed.points[0].patch='malformed';await request('/recognition/detections',{at,epoch:r.epoch,found});assert.equal(r.state.detections[0].seed,null);
});

test('HUD metadata is independent of camera delivery, acknowledged and bounded for a slow PC',async()=>{
 const {r,request}=room();const t=await request('/recognition/targets',{name:'상자',key:'e',image:'data:image/jpeg;base64,/9j/'});
 const make=role=>{let attachment={role,seq:0};return {messages:[],deserializeAttachment:()=>attachment,serializeAttachment:a=>{attachment=a},send(m){this.messages.push(m)},close(){}}};
 const device=make('hud-device'),hud=make('hud-viewer'),cameraViewer=make('viewer');r.ctx.getWebSockets=()=>[device,hud,cameraViewer];
 const post=seq=>r.webSocketMessage(device,JSON.stringify({seq,mode:'recognition',visible:true,tracking:true,objects:[{id:t.targetId,x:.4,y:.6},{id:'unregistered',x:.2,y:.2}]}));
 post(1);assert.equal(hud.messages.length,1);assert.equal(cameraViewer.messages.length,0);assert.equal(device.messages.length,1);assert.equal(r.viewers().length,1);
 assert.equal(JSON.parse(hud.messages[0]).objects[0].name,'상자');assert.equal(JSON.parse(hud.messages[0]).objects.length,1);
 for(let i=2;i<=20;i++)post(i);assert.equal(hud.messages.length,1);assert.equal(r.hudDelivery.size,1);
 r.webSocketMessage(hud,JSON.stringify({ack:1}));post(21);assert.equal(JSON.parse(hud.messages[1]).seq,21);
 post(20);assert.equal(r.deviceHud.seq,21);
 r.webSocketMessage(cameraViewer,JSON.stringify({seq:100,mode:'recognition',visible:true,objects:[]}));assert.equal(r.deviceHud.seq,21);
 r.deviceHud.at-=2300;assert.equal((await request('/recognition/status')).deviceHud,null);
 await request('/play?key=e');
 const playbackId=r.commands.at(-1).playbackId;
 const report=(seq,mode,id)=>r.webSocketMessage(device,JSON.stringify({seq,mode,visible:true,playbackId:id,media:{url:'/fake.mp4'}}));
 r.webSocketMessage(hud,JSON.stringify({ack:21}));
 report(22,'loading',playbackId);
 assert.equal(JSON.parse(hud.messages.at(-1)).media,undefined);
 r.webSocketMessage(hud,JSON.stringify({ack:22}));
 report(23,'playback','old-id');
 assert.equal(JSON.parse(hud.messages.at(-1)).media,undefined);
 r.webSocketMessage(hud,JSON.stringify({ack:23}));
 report(24,'playback',playbackId);
 assert.equal(JSON.parse(hud.messages.at(-1)).media.url,r.commands.at(-1).url);
 await request('/stop');
 r.webSocketMessage(hud,JSON.stringify({ack:24}));
 report(25,'playback',playbackId);
 assert.equal(JSON.parse(hud.messages.at(-1)).media,undefined);
});

test('server trace retains metadata without video and exposes cursor loss and epoch reset',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const frame=new Uint8Array([0,0,0,1,0x65,0x80]);r.stream(frame,{test:r.test.test,seg:7,sentAt:1200,transport:'websocket'});
 const initial=await request('/cam/diagnostics');assert.equal(initial.reset,true);const p=initial.events.find(x=>x.type==='camera_packet');assert.equal(p.segment,7);assert.equal(p.sourceSentAt,1200);assert.equal(p.bytes,frame.length);assert.equal('data' in p,false);assert.equal('body' in p,false);
 const empty=await request('/cam/diagnostics?epoch='+initial.epoch+'&after='+initial.latest);assert.equal(empty.events.length,0);assert.equal(empty.reset,false);
 for(let i=0;i<4100;i++)r.trace('test');const overwritten=await request('/cam/diagnostics?epoch='+initial.epoch+'&after='+initial.latest);assert.equal(overwritten.lost,true);assert.equal(overwritten.events.length,4096);assert.equal(overwritten.events.at(-1).seq,overwritten.latest);
});

test('photo and vector agreement marks off-center targets and requires centered dwell', async () => {
 const {r, request} = room();
 const vector = Array(576).fill(0); vector[0] = 1;
 const pack = {model:'mobilenet-v3-small-imagenet1k-v1', vectors:[vector]};
 const invalid = await request('/recognition/vectors',{name:'invalid',key:'e',pack:{...pack,vectors:[[1]]}});
 assert.ok(invalid.error);
 const image = 'data:image/jpeg;base64,/9j/';
 const legacy = await request('/recognition/targets',{name:'legacy',key:'v',image});
 await request('/recognition/vectors',{targetId:legacy.targetId,pack});
 await request('/recognition/vectors?targetId='+legacy.targetId,null,'DELETE');
 const preserved = (await request('/recognition/targets')).targets.find(t=>t.id===legacy.targetId);
 assert.equal(preserved.images.length,1);
 assert.equal(preserved.appearance,null);

 const combined = await request('/recognition/vectors',{name:'Combined',key:'e',pack,images:[image]});
 const saved = (await request('/recognition/targets')).targets.find(t=>t.id===combined.targetId);
 assert.equal(saved.images[0].image,image);
 assert.ok(saved.appearance);
 const corners = [[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
 await request('/recognition/control?enabled=1',{},'POST');
 await request('/recognition/detections',{epoch:r.epoch,at:Date.now(),found:[{id:combined.targetId,corners,inliers:20}]});
 assert.equal(r.state.focused,null);
 assert.equal(r.state.detections.length,0);
 const combinedDetection = (found, vectorTarget) => request('/recognition/detections',{
   epoch:r.epoch,at:Date.now(),found,vectorTarget,
 });
 const track = {id:combined.targetId,corners,inliers:20,appearanceConfirmed:true};
 const outside = {...track,corners:[[.05,.05],[.2,.05],[.2,.2],[.05,.2]]};
 await combinedDetection([outside]);
 assert.equal(r.state.detections[0].id,combined.targetId);
 assert.equal(r.state.focused,null);
 assert.equal(r.state.progress,0);
 const tilted={...track,corners:[[.65,.45],[.85,.65],[.65,.85],[.45,.65]]};
 const second={...outside,id:legacy.targetId};
 await combinedDetection([tilted,second]);
 assert.equal(r.state.detections.length,2);
 assert.deepEqual(r.state.detections[0].bounds,{left:.45,right:.85,top:.45,bottom:.85});
 assert.equal(r.state.focused,combined.targetId);
 r.focusAt -= 1000;
 await combinedDetection([track]);
 assert.equal(r.state.focused,combined.targetId);
 assert.ok(r.state.progress>=.4);
 assert.equal(r.state.focusMissing,false);
 const beforeMiss=r.state.progress;
 r.lastResult-=150;
 await combinedDetection([{...track,provisional:true}]);
 assert.equal(r.state.detections[0].held,true);
 assert.equal(r.state.detections[0].provisional,true);
 assert.equal(r.state.progress,beforeMiss);
 assert.equal(r.state.focusMissing,true);
 assert.equal(r.commands.length,0);
 r.state.focusMissingAt-=850;
 r.lastResult-=150;
 await combinedDetection([]);
 const afterDecay=r.state.progress;
 assert.equal(afterDecay,beforeMiss);
 r.lastResult-=100;
 await combinedDetection([track]);
 assert.ok(Math.abs(r.state.progress-afterDecay)<.01);
 r.focusAt -= 3000;
 await combinedDetection([outside]);
 assert.equal(r.state.focused,null);
 assert.equal(r.state.progress,0);
 assert.equal(r.commands.length,0);

 const target = await request('/recognition/vectors',{name:'VR vector',key:'e',pack});
 await request('/recognition/control?enabled=1',{},'POST');
 await combinedDetection([{...track,id:target.targetId}],target.targetId);
 assert.equal(r.state.detections.length,0);
 assert.equal(r.state.focused,null);
 assert.equal(r.commands.length,0);
 await combinedDetection([track]);
 r.focusAt -= 2600;
 await combinedDetection([track]);
 assert.equal(r.commands.at(-1).key,'e');
 await request('/recognition/vectors?targetId='+target.targetId,null,'DELETE');
 assert.equal(r.store.get(target.targetId),undefined);
});

test('confirmed aim fallback never invents a location or overrides known off-center geometry', async () => {
 const {r,request}=room();
 const vector=Array(576).fill(0);vector[0]=1;
 const pack={model:'mobilenet-v3-small-imagenet1k-v1',vectors:[vector]};
 const image='data:image/jpeg;base64,/9j/';
 const target=await request('/recognition/vectors',{name:'Headset',key:'e',pack,images:[image]});
 const vectorOnly=await request('/recognition/vectors',{name:'No photo',key:'e',pack});
 await request('/recognition/control?enabled=1',{},'POST');
 const report=(found=[],id=target.targetId,age=0)=>{
   const at=Date.now();
   return request('/recognition/detections',{epoch:r.epoch,at,found,aimMatch:{id,at:at-age}});
 };
 await report([],vectorOnly.targetId);
 assert.equal(r.state.focused,null);
 await report([],target.targetId,1500);
 assert.equal(r.state.focused,null);
 await report([{id:target.targetId,corners:[[.05,.05],[.2,.05],[.2,.2],[.05,.2]],appearanceConfirmed:true}]);
 assert.equal(r.state.focused,null);
 assert.equal(r.state.detections.length,1);
 const approximate={id:target.targetId,corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],
   appearanceConfirmed:true,approximate:true};
 await report([approximate],null);
 assert.equal(r.state.focused,null);
 assert.equal(r.state.detections[0].approximate,true);
 await report([approximate]);
 assert.equal(r.state.focused,null);
 await report();
 assert.equal(r.state.focused,null);
 assert.equal(r.state.aimTarget,'Headset');
 assert.deepEqual(r.state.detections,[]);
 assert.equal(r.commands.length,0);
 const localized={...approximate,approximate:false};
 await report([localized]);
 assert.equal(r.state.focused,target.targetId);
 r.focusAt-=2600;
 await report();
 assert.equal(r.commands.length,0);
 await report([localized]);
 r.focusAt-=2600;
 await report([localized]);
 assert.equal(r.commands.at(-1).key,'e');
});

function stateSocket(){
 let attachment;return {readyState:1,messages:[],serializeAttachment(a){attachment=structuredClone(a)},deserializeAttachment(){return structuredClone(attachment)},send(text){this.messages.push(JSON.parse(text))},close(code){this.readyState=3;this.code=code}};
}
test('expired or replaced WebSocket credentials cannot submit another message',()=>{
 const {r}=room();r.pairedDevice='current-device';
 const replaced=stateSocket();replaced.serializeAttachment({role:'state-client',side:'device',deviceId:'previous-device',expiresAt:Date.now()+10000});
 r.webSocketMessage(replaced,'{"type":"ping"}');assert.equal(replaced.code,1008);
 const expired=stateSocket();expired.serializeAttachment({role:'viewer',expiresAt:Date.now()-1});r.webSocketMessage(expired,'{"ping":1}');assert.equal(expired.code,1008);
});
test('state subscribers get one outstanding snapshot and resume at current state',async()=>{
 const {r,request}=room(),ws=stateSocket();r.ctx.getWebSockets=()=>[ws];
 await r.events.connect(ws,'viewer','pc');assert.equal(ws.messages.length,1);
 assert.equal(r.viewers().length,0);
 for(let i=0;i<50;i++){r.state.progress=i/100;await r.events.publish()}
 assert.equal(ws.messages.length,1);
 await r.events.message(ws,JSON.stringify({type:'ack',seq:ws.messages[0].seq}));
 assert.equal(ws.messages.length,2);assert.equal(ws.messages[1].recognition.progress,.49);
 const before=ws.messages.length;await r.events.message(ws,'{"type":"ack","seq":-1}');assert.equal(ws.messages.length,before);
 await r.events.message(ws,'null');await r.events.message(ws,'not JSON');
 r.events.pending.get(ws).at-=6000;await r.events.publish();assert.equal(ws.code,1013);
});
test('state-channel detections use HTTP freshness, identity and playback protections',async()=>{
 const {r,request}=room(),ws=stateSocket();r.ctx.getWebSockets=()=>[ws];
 const t=await request('/recognition/targets',{name:'Photo',key:'e',image:'data:image/jpeg;base64,/9j/'});
 await request('/recognition/control?enabled=1',{});await r.events.connect(ws,'viewer','pc');
 const submit=async(seq,override={})=>{await r.events.message(ws,JSON.stringify({type:'detections',seq,data:{epoch:r.epoch,at:Date.now(),found:[{id:t.targetId,corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]}],...override}}));return ws.messages.findLast(m=>m.type==='result')?.result};
 assert.equal((await submit(1)).ok,true);assert.equal(r.focus,t.targetId);
 r.focusAt-=2600;assert.equal((await submit(2)).ok,true);assert.equal(r.commands.filter(m=>m.cmd==='play').length,1);
 const stale=await submit(3,{epoch:r.epoch-1});assert.equal(stale.stale,true);
 await submit(3);assert.equal(r.commands.filter(m=>m.cmd==='play').length,1);
 const device=stateSocket();await r.events.connect(device,'device','glasses');
 await r.events.message(device,JSON.stringify({type:'detections',seq:1,data:{}}));assert.equal(device.messages.filter(m=>m.type==='result').length,0);
 await r.events.message(device,JSON.stringify({type:'ping',ping:9}));assert.ok(r.seen.has('glasses'));assert.equal(device.messages.find(m=>m.type==='pong').pong,9);
});

// Dwell credit follows frame time (bounded) rather than result arrival slices.
async function dwellRoom(start){
 let now=start;const original=Date.now;Date.now=()=>now;
 const {r,request}=room();
 const target=await request('/recognition/targets',{name:'Box',key:'e',image:'data:image/jpeg;base64,/9j/'});
 await request('/recognition/control?enabled=1',{},'POST');
 const found=[{id:target.targetId,trackId:'steady',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]]}];
 const report=(at,extra={})=>request('/recognition/detections',{epoch:r.epoch,at,found,...extra});
 return {r,report,id:target.targetId,set:t=>{now=t},restore:()=>{Date.now=original}};
}
test('900ms analysis cycles earn their frame time and play after 1500ms of frames',async()=>{
 const t0=400000,{r,report,set,restore}=await dwellRoom(t0);
 try{
  await report(t0-500);
  set(t0+900);await report(t0+400);
  assert.ok(Math.abs(r.state.progress-900/DWELL_MS)<.01,'a 900ms cycle previously earned only 150ms');
  assert.equal(r.commands.length,0);
  set(t0+1800);await report(t0+1300);
  assert.equal(r.commands.at(-1)?.key,'e');
 }finally{restore()}
});
test('delivery delay without new frame time earns only the base 350ms slice',async()=>{
 const t0=500000,{r,report,set,restore}=await dwellRoom(t0);
 try{
  await report(t0-50);
  set(t0+700);await report(t0+50);
  assert.ok(Math.abs(r.state.progress-350/DWELL_MS)<.01);
 }finally{restore()}
});
test('frame credit is capped at 1000ms and longer gaps resume with 150ms',async()=>{
 const t0=600000,{r,report,set,restore}=await dwellRoom(t0);
 try{
  await report(t0-100);
  set(t0+1000);await report(t0+900);
  assert.ok(Math.abs(r.state.progress-1000/DWELL_MS)<.01,'1000ms is still continuous');
  const before=r.state.progress;
  set(t0+2200);await report(t0+2100,{processMs:420});
  assert.ok(r.state.progress>before&&r.state.progress<=before+150/DWELL_MS+.01,'a 1200ms gap is a resume');
  assert.equal(r.state.analysisMs,420);
  assert.equal(r.state.frameAgeMs,100);
 }finally{restore()}
});
test('live boxes carry a clamped velocity to the glasses; held and invalid ones do not',async()=>{
 const t0=700000,{r,report,id,set,restore}=await dwellRoom(t0);
 try{
  await report(t0-50,{found:[{id,trackId:'v',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]],velocity:[.4,-9]}]});
  assert.deepEqual(r.state.detections[0].velocity,[.4,-3]);
  const status=await (await r.fetch(new Request('https://example.test/recognition/status?hud=2'))).json();
  assert.deepEqual(status.detections[0].velocity,[.4,-3],'the glasses status keeps the velocity');
  set(t0+100);await report(t0+50,{found:[{id,trackId:'v',held:true,corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]],velocity:[.4,0]}]});
  assert.equal(r.state.detections[0].velocity,null);
  set(t0+200);await report(t0+150,{found:[{id,trackId:'v',corners:[[.35,.35],[.65,.35],[.65,.65],[.35,.65]],velocity:['x',1]}]});
  assert.equal(r.state.detections[0].velocity,null);
 }finally{restore()}
});
test('WebRTC capture may use up to 8Mbps while relayed video stays capped at 4Mbps',async()=>{
 const {r,request}=room();
 await request('/cam/set?mode=video&fps=30&sec=0&kbps=6000&transport=webrtc');
 assert.equal(r.test.kbps,6000);assert.equal(r.test.transport,'webrtc');
 await request('/cam/set?mode=video&fps=30&sec=0&kbps=9000&transport=webrtc');
 assert.equal(r.test.kbps,8000);
 await request('/cam/set?mode=video&fps=30&sec=0&kbps=6000');
 assert.equal(r.test.kbps,4000);assert.equal(r.test.transport,'websocket');
});
