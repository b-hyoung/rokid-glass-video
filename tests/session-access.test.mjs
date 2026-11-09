import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {secureFetch,PairingRegistry,signCredential,verifyCredential,roleAllows} from '../cloud/session-access.mjs';
import localWorker,{LocalGlassRoom,LocalPreviewRoom} from '../tools/local-worker.mjs';
function storage(){const db=new DatabaseSync(':memory:');return {sql:{exec(q,...args){const s=db.prepare(q);if(/^SELECT/i.test(q))return {toArray:()=>s.all(...args)};s.run(...args);return {toArray:()=>[]}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}}
function setup(){
 const env={ACCESS_MODE:'paired',SESSION_SECRET:'session-secret-for-tests-000000000000000',SETUP_SECRET:'owner-setup-for-tests-00000000000000000',ASSETS:{fetch:async request=>new URL(request.url).pathname==='/videos.json'?Response.json({e:{title:'E',file:'e.mp4'}}):Response.json({mode:'local',protocol:1})}};
 const namespace=Class=>{const rooms=new Map();return {idFromName:name=>name,get(id){if(!rooms.has(id))rooms.set(id,new Class({storage:storage(),getWebSockets:()=>[]},env));return rooms.get(id)}}};
 env.ROOM=namespace(LocalGlassRoom);env.PREVIEW=namespace(LocalPreviewRoom);env.ACCESS=namespace(PairingRegistry);
 const request=async(path,data,{token,cookie,method,headers={}}={})=>{
  const response=await secureFetch(new Request('http://localhost'+path,{method:method||(data?'POST':'GET'),body:data?JSON.stringify(data):undefined,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...headers}}),env,(r,e)=>localWorker.fetch(r,e));
  return {status:response.status,headers:response.headers,data:response.headers.get('Content-Type')?.includes('json')?await response.json():null};
 };
 const create=async()=>{const r=await request('/access/create',{setupKey:env.SETUP_SECRET});assert.equal(r.status,200);return {...r.data,cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')}};
 return {env,request,create};
}
test('credentials reject expiry, signature changes, wrong key and changed roles',async()=>{
 const key='test-signing-secret-00000000000000000',room=crypto.randomUUID(),token=await signCredential(key,room,'device',1000);
 assert.equal((await verifyCredential(key,token,2000)).room,room);
 assert.equal(await verifyCredential(key,token,8*86400000),null);
 assert.equal(await verifyCredential(key+'wrong',token,2000),null);
 const parts=token.split('.'),payload=JSON.parse(Buffer.from(parts[0],'base64url'));payload.role='controller';
 assert.equal(await verifyCredential(key,Buffer.from(JSON.stringify(payload)).toString('base64url')+'.'+parts[1],2000),null);
 assert.equal(await verifyCredential(key,'invalid'),null);
});
const installKey=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
async function discover(request,key=installKey()){
 const data={installKey:key,protocol:1,label:'Test glasses',app:'0.2.22'};
 const pending=await request('/access/hello',data);assert.equal(pending.status,200);return {data,...pending.data};
}
async function connect(request,owner){
 const device=await discover(request);
 assert.equal((await request('/access/claim',{deviceId:device.deviceId},owner)).status,200);
 return (await request('/access/hello',device.data)).data;
}
test('automatic discovery waits for web owner approval and devices have restricted permissions',async()=>{
 const {env,request,create}=setup(),owner=await create(),pending=await discover(request);
 assert.match(owner.cookie,/glass_session=/);assert.match(owner.cookie,/glass_owner=/);
 assert.equal(pending.state,'pending');assert.equal(pending.token,undefined);
 assert.equal((await request('/access/devices',{})).status,403);
 const list=await request('/access/devices',{},owner);assert.equal(list.data.devices[0].id,pending.deviceId);
 assert.equal(JSON.stringify(list.data).includes(pending.data.installKey),false);
 assert.equal(JSON.stringify(list.data).includes('secret_hash'),false);
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},owner)).status,200);
 const paired=await request('/access/hello',pending.data);assert.equal(paired.status,200);assert.equal(paired.data.state,'connected');
 const device={token:paired.data.token};
 for(const path of ['/recognition/targets','/recognition/backup','/preview/recognition/targets'])assert.equal((await request(path,null,device)).status,403);
 assert.equal((await request('/play?key=e',{},device)).status,403);
 assert.equal((await request('/cam/rtc?role=viewer',null,device)).status,403);
 assert.equal((await request('/recognition/events?role=viewer',null,device)).status,403);
 assert.equal((await request('/recognition/events?role=device',null,owner)).status,403);
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},device)).status,403);
 assert.equal((await request('/status',null,device)).status,200);
 assert.equal(await verifyCredential(env.SESSION_SECRET,paired.data.token).then(c=>c.role),'device');
 assert.equal((await request('/access/pair',{code:'12345678',protocol:1})).status,404);
});

test('workspace scope isolates photos, deletion, playback and file preview despite forged headers',async()=>{
 const {request,create}=setup(),a=await create(),b=await create();
 const image='data:image/jpeg;base64,/9j/',id='original-target';
 const original={targets:[{id,name:'A photo',key:'e',images:[{id:'original-image',image,created_at:10,capture:{source:'photo'}}]}]};
 assert.equal((await request('/recognition/import',original,a)).status,200);
 assert.equal((await request('/recognition/import',original,a)).status,400);
 assert.equal((await request('/recognition/targets',null,a)).data.targets[0].id,id);
 assert.equal((await request('/recognition/targets?room='+a.roomId,null,{...b,headers:{'X-Glass-Room':a.roomId,'X-Glass-Role':'controller'}})).data.targets.length,0);
 await request('/recognition/targets?id='+id,null,{...b,method:'DELETE'});
 assert.equal((await request('/recognition/targets',null,a)).data.targets.length,1);
 await request('/play?key=e',{},a);assert.equal((await request('/status',null,b)).data.now,null);
 await request('/preview/sync',{},a);assert.equal((await request('/preview/recognition/targets',null,a)).data.targets.length,1);
 assert.equal((await request('/preview/recognition/targets',null,b)).data.targets.length,0);
 await request('/preview/play?key=e',{},a);assert.equal((await request('/status',null,b)).data.now,null);
});
test('anonymous access, cross-origin requests, GET mutations and missing configuration fail closed',async()=>{
 const {request,create,env}=setup();
 assert.equal((await request('/recognition/targets')).status,401);
 assert.equal((await request('/recognition')).status,303);
 assert.equal((await request('/videos.json')).status,401);
 const owner=await create();assert.equal((await request('/play?key=e',null,owner)).status,405);
 assert.equal((await request('/stop',{}, {...owner,headers:{Origin:'http://another.test'}})).status,403);
 assert.equal((await request('/access/create',{setupKey:env.SETUP_SECRET},{headers:{Origin:'http://another.test'}})).status,403);
 assert.equal((await request('/recognition/import',{}, {headers:{'X-Glass-Role':'controller'}})).status,401);
 env.SESSION_SECRET='';assert.equal((await request('/status',null,owner)).status,503);
});

test('web replacement and disconnect revoke the previous device without allowing it to rebind itself',async()=>{
 const {request,create}=setup(),owner=await create(),old=await discover(request);
 await request('/access/claim',{deviceId:old.deviceId},owner);
 const previous=(await request('/access/hello',old.data)).data.token;
 assert.equal((await request('/status',null,{token:previous})).status,200);
 const next=await connect(request,owner);
 assert.equal((await request('/status',null,{token:previous})).status,403);assert.equal((await request('/status',null,{token:next.token})).status,200);
 assert.equal((await request('/videos.json',null,{token:previous})).status,403);assert.equal((await request('/videos.json',null,{token:next.token})).status,200);
 const retry=await request('/access/hello',old.data);assert.equal(retry.data.state,'pending');assert.equal(retry.data.token,undefined);
 assert.equal((await request('/recognition/device-bind',{deviceId:crypto.randomUUID()},{...owner,headers:{'X-Glass-Role':'pairing-service'}})).status,403);
 await request('/access/unclaim',{},owner);assert.equal((await request('/status',null,{token:next.token})).status,403);
 assert.equal((await request('/recognition/targets',null,owner)).status,200);
});

test('workspace recovery alone cannot claim devices; owner cookies never authorize data APIs',async()=>{
 const {env,request,create}=setup(),a=await create(),b=await create(),pending=await discover(request);
 const recovered=await request('/access/login',{roomId:a.roomId,recoveryKey:a.recoveryKey});
 const controller={cookie:recovered.headers.getSetCookie()[0].split(';')[0]};
 assert.equal((await request('/access/session',null,controller)).data.owner,false);
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},controller)).status,403);
 assert.equal((await request('/access/owner',{setupKey:'bad'},controller)).status,403);
 const unlock=await request('/access/owner',{setupKey:env.SETUP_SECRET},controller);
 const ownerCookie=unlock.headers.getSetCookie()[0].split(';')[0];
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},{cookie:controller.cookie+'; '+ownerCookie})).status,200);
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},b)).status,409);
 assert.equal((await request('/recognition/targets',null,{token:ownerCookie.split('=')[1]})).status,403);
 assert.equal(roleAllows('owner',new URL('https://example.test/status'),'GET'),false);
});

test('stale discovery and repeated public guesses stay bounded after registry recreation',async()=>{
 const {env,request,create}=setup(),owner=await create(),pending=await discover(request),registry=env.ACCESS.get('pairing-registry');
 // Known devices may poll without exhausting the public registration budget.
 for(let i=0;i<30;i++)assert.equal((await request('/access/hello',pending.data)).status,200);
 registry.sql.exec('UPDATE discovered_devices SET last_seen=0');
 assert.equal((await request('/access/claim',{deviceId:pending.deviceId},owner)).status,409);
 for(let i=0;i<20;i++)await request('/access/login',{roomId:owner.roomId,recoveryKey:'bad'});
 assert.equal((await request('/access/login',{roomId:owner.roomId,recoveryKey:'bad'})).status,429);
 const restarted=new PairingRegistry({storage:registry.storage},env);
 assert.equal((await restarted.fetch(new Request('http://registry/access/login',{method:'POST',body:'{}',headers:{'X-Client':'local'}}))).status,429);
});
