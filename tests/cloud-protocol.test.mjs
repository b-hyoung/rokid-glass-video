import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {TargetStore,MAX_IMAGES} from '../cloud/target-store.mjs';
import {GlassRoom} from '../cloud/worker.mjs';
import {pack,unpack} from '../cloud/stream-protocol.mjs';
function room(){
 const db=new DatabaseSync(':memory:');
 const storage={sql:{exec(query,...args){const statement=db.prepare(query);if(/^SELECT|RETURNING/i.test(query))return {toArray:()=>statement.all(...args)};statement.run(...args);return {toArray:()=>[]}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const ctx={storage,getWebSockets:()=>[]};const env={ASSETS:{fetch:async()=>Response.json({e:{title:'마주봄',file:'majubom_box.mp4'},v:{title:'VR',file:'visionpro_scan.mp4'}})}};
 const r=new GlassRoom(ctx,env);const request=async(path,data,method)=>{const response=await r.fetch(new Request('https://example.test'+path,{method:method||(data?'POST':'GET'),body:data?JSON.stringify(data):undefined}));return response.json()};return {r,request,storage,db};
}
test('existing app long polling receives camera and playback commands in order',async()=>{const {request}=room();const first=await request('/next?id=test');const waiting=request('/next?id=test&after='+first.seq);await request('/cam/set?mode=video&fps=30&sec=0');const camera=await waiting;assert.equal(camera.cmd,'cam');assert.equal(camera.mode,'video');await request('/play?key=e');const play=await request('/next?id=test&after='+camera.seq);assert.equal(play.key,'e');assert.equal(play.url,'/v/majubom_box.mp4')});
test('two visible targets, center dwell, switch, stale result and deletion',async()=>{const {r,request}=room();const image='data:image/jpeg;base64,/9j/';await request('/recognition/targets',{name:'판넬',key:'e',image});await request('/recognition/targets',{name:'VR',key:'v',image});let status=await request('/recognition/status');const [a,b]=status.targets;
await request('/recognition/control?enabled=1',{},'POST');status=await request('/recognition/status');const center=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],side=[[.05,.1],[.2,.1],[.2,.3],[.05,.3]];
let found=[{id:a.id,corners:center,inliers:25},{id:b.id,corners:side,inliers:20}];await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.state.detections.length,2);assert.equal(r.state.focused,a.id);assert.equal(r.commands.length,0);
r.focusAt-=1600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'e');const n=r.commands.length;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.length,n);
found=[{id:a.id,corners:side,inliers:25},{id:b.id,corners:center,inliers:20}];await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=1600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'e');assert.equal(r.commands.length,n);
const playing=r.playback.current();await request('/recognition/playback',{id:playing.id,event:'stopped'});
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=1600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.length,0);
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found:[]});
await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});r.focusAt-=1600;await request('/recognition/detections',{epoch:status.epoch,at:Date.now(),found});assert.equal(r.commands.at(-1).key,'v');
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
 r.focusAt-=1600;await post([{id:a.targetId,corners,inliers:18}]);assert.equal(r.commands.length,1);
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
 const found=[{id:target.targetId,inliers:20,corners:[[.65,.2],[.85,.2],[.85,.4],[.65,.4]]}];await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found});assert.equal(r.state.focused,target.targetId);r.focusAt-=1600;await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found});assert.equal(r.commands.at(-1).key,'e');
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

test('optical flow without a recent identity match cannot trigger playback',async()=>{
 const {r,request}=room(),image='data:image/jpeg;base64,/9j/';const target=await request('/recognition/targets',{name:'상자',key:'e',image});await request('/recognition/control?enabled=1',{});
 const detection={id:target.targetId,inliers:20,corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],matchedAt:Date.now()-1400};
 await request('/recognition/detections',{at:Date.now(),epoch:r.epoch,found:[detection]});r.focusAt-=1600;
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
 await request('/recognition/detections',payload());r.focusAt-=1600;
 await Promise.all([request('/recognition/detections',payload()),request('/recognition/detections',payload())]);assert.equal(r.commands.filter(x=>x.cmd==='play').length,1);
 await request('/stop');await request('/recognition/detections',{epoch:r.epoch,at:Date.now(),found:[]});r.locked=null;
 await request('/recognition/detections',payload());r.focusAt-=1600;
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
});

test('server trace retains metadata without video and exposes cursor loss and epoch reset',async()=>{
 const {r,request}=room();await request('/cam/set?fps=60');const frame=new Uint8Array([0,0,0,1,0x65,0x80]);r.stream(frame,{test:r.test.test,seg:7,sentAt:1200,transport:'websocket'});
 const initial=await request('/cam/diagnostics');assert.equal(initial.reset,true);const p=initial.events.find(x=>x.type==='camera_packet');assert.equal(p.segment,7);assert.equal(p.sourceSentAt,1200);assert.equal(p.bytes,frame.length);assert.equal('data' in p,false);assert.equal('body' in p,false);
 const empty=await request('/cam/diagnostics?epoch='+initial.epoch+'&after='+initial.latest);assert.equal(empty.events.length,0);assert.equal(empty.reset,false);
 for(let i=0;i<4100;i++)r.trace('test');const overwritten=await request('/cam/diagnostics?epoch='+initial.epoch+'&after='+initial.latest);assert.equal(overwritten.lost,true);assert.equal(overwritten.events.length,4096);assert.equal(overwritten.events.at(-1).seq,overwritten.latest);
});
