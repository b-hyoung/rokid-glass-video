import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import localWorker,{LocalGlassRoom,LocalPreviewRoom,localTargets,videoRange} from '../tools/local-worker.mjs';
import {DWELL_MS} from '../cloud/request-policy.mjs';

const videos={e:{title:'마주봄',file:'majubom_box.mp4'}},image='data:image/jpeg;base64,/9j/';
const snapshot={targets:[{id:'saved-photo-id',name:'등록 사진',key:'e',images:[{image,capture:{source:'photo',filename:'사진.jpg'}}]}]};

test('local video playback supports bounded and suffix byte ranges',()=>{
  assert.deepEqual(videoRange('bytes=0-15',100),{start:0,end:15});
  assert.deepEqual(videoRange('bytes=80-',100),{start:80,end:99});
  assert.deepEqual(videoRange('bytes=-20',100),{start:80,end:99});
  assert.deepEqual(videoRange('bytes=80-200',100),{start:80,end:99});
  for(const value of ['bytes=100-','bytes=40-20','bytes=-0','bytes=-','bytes=0-10,20-30'])assert.equal(videoRange(value,100),null);
});
function createRoom(Class,env){
  const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(query,...args){const statement=db.prepare(query);if(/^SELECT|RETURNING/i.test(query))return {toArray:()=>statement.all(...args)};statement.run(...args);return {toArray:()=>[]}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
  return new Class({storage,getWebSockets:()=>[]},env);
}
function environment(){
  const env={ASSETS:{fetch:async request=>new URL(request.url).pathname==='/videos.json'?Response.json(videos):Response.json({error:'not found'},{status:404})}};
  const live=createRoom(LocalGlassRoom,env),preview=createRoom(LocalPreviewRoom,env);
  env.ROOM={idFromName:name=>name,get:()=>live};env.PREVIEW={idFromName:name=>name,get:()=>preview};
  const request=async(path,data)=>{const response=await localWorker.fetch(new Request('http://localhost:8787'+path,{method:data?'POST':'GET',body:data?JSON.stringify(data):undefined}),env);return {status:response.status,body:await response.json()}};
  return {live,preview,request};
}

test('local snapshot validation rejects bad photos, video keys and duplicate IDs',()=>{
  assert.equal(localTargets(snapshot,videos).targets[0].id,'saved-photo-id');
  assert.throws(()=>localTargets({targets:[...snapshot.targets,...snapshot.targets]},videos),/중복/);
  assert.throws(()=>localTargets({targets:[{...snapshot.targets[0],key:'missing'}]},videos),/영상/);
  assert.throws(()=>localTargets({targets:[{...snapshot.targets[0],images:[{image:'bad'}]}]},videos),/사진/);
});

test('local import preserves target identity, photo metadata and existing local edits',async()=>{
  const {live,request}=environment();
  assert.equal((await request('/status')).body.hosting,'local');
  const imported=await request('/local/import',snapshot);assert.equal(imported.status,200);assert.equal(imported.body.images,1);
  live.store.addImage('saved-photo-id',image);
  const repeated=await request('/local/import',snapshot);assert.equal(repeated.body.skipped,true);
  const target=live.targets(true)[0];assert.equal(target.id,'saved-photo-id');assert.equal(target.images.length,2);assert.equal(target.images.find(i=>i.capture)?.capture.source,'photo');
});

test('backup restore preserves original image IDs, timestamps and vector components exactly',async()=>{
  const {live,request}=environment();
  const vector=Array(576).fill(0);vector[0]=.6;vector[1]=.800000000000001;
  const appearance={model:'mobilenet-v3-small-imagenet1k-v1',vectors:[vector]};
  const original={...snapshot.targets[0],appearance,images:[{id:'original-image',created_at:1234,image,capture:{source:'photo',filename:'original.jpg'}}]};
  assert.equal((await request('/local/import',{targets:[original]})).status,200);
  const restored=live.targets(true)[0];assert.deepEqual(restored.appearance,appearance);assert.deepEqual(restored.images,original.images);
});

test('preview synchronization copies the current library without replacing live data',async()=>{
  const {live,preview,request}=environment();await request('/local/import',snapshot);
  assert.equal((await request('/preview/sync',{})).status,200);
  assert.equal(preview.targets(true)[0].id,live.targets(true)[0].id);
  live.store.addImage('saved-photo-id',image);await request('/preview/sync',{});
  assert.equal(preview.targets(true)[0].images.length,2);assert.equal(live.targets(true)[0].images.length,2);
  const failed=await request('/preview/local/import',{targets:[{...snapshot.targets[0],images:[{image:'bad'}]}]});
  assert.equal(failed.status,400);assert.equal(preview.targets(true)[0].images.length,2);
});

test('recorded-file dwell sends playback only to the preview room and can restart',async()=>{
  const {live,preview,request}=environment();await request('/local/import',snapshot);await request('/preview/sync',{});
  const found=[{id:'saved-photo-id',trackId:'test-track',corners:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]}];
  for(let run=0;run<2;run++){
    await request('/preview/local/reset',{});await request('/preview/recognition/control?enabled=1',{});
    await request('/preview/recognition/detections',{epoch:preview.epoch,at:Date.now(),found});
    preview.focusAt-=DWELL_MS+1100;
    await request('/preview/recognition/detections',{epoch:preview.epoch,at:Date.now(),found});
    assert.equal(preview.commands.filter(c=>c.cmd==='play').length,1);
    assert.equal(preview.playback.current().media.url,'/v/majubom_box.mp4');
    assert.equal(live.commands.length,0);assert.equal(live.playback.current(),null);
    await request('/preview/stop',{});
  }
  assert.equal((await request('/local/reset',{})).status,404);
});
