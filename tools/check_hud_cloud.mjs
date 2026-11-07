// Writes synthetic metadata only to the dedicated, isolated Cloudflare test room.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base='https://rokid-delivery-check.youqlrqod.workers.dev';
const request=async(path,body,method)=>{const response=await fetch(base+path,{method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error(path+': '+response.status);return response.json()};
const open=path=>new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('https:','wss:')+path),timeout=setTimeout(()=>{ws.close();reject(Error('WebSocket timeout'))},10000);ws.onopen=()=>{clearTimeout(timeout);resolve(ws)};ws.onerror=()=>{clearTimeout(timeout);reject(Error('WebSocket error'))}});
const next=(ws,accept)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.removeEventListener('message',listener);reject(Error('Message timeout'))},10000);function listener(e){let value;try{value=JSON.parse(e.data)}catch{return}if(accept&&!accept(value))return;clearTimeout(timer);ws.removeEventListener('message',listener);resolve(value)}ws.addEventListener('message',listener)});
const ids=[];let viewer,device;
try{
 const before=await request('/cam/stats');
 for(const name of ['HUD 시험 상자','HUD 시험 VR']){const target=await request('/recognition/targets',{name,key:'e',image:'data:image/jpeg;base64,/9j/'});ids.push(target.targetId)}
 viewer=await open('/recognition/hud');viewer.addEventListener('message',e=>{const m=JSON.parse(e.data);viewer.send(JSON.stringify({ack:m.seq}))});device=await open('/recognition/device');
 const displayed=next(viewer,s=>s.seq===1),ack=next(device,s=>s.ack===1);
 device.send(JSON.stringify({seq:1,mode:'recognition',visible:true,tracking:true,width:640,height:360,objects:ids.map((id,i)=>({id,x:.2+i*.4,y:.5}))}));
 const shown=await displayed;await ack;assert.equal(shown.objects.length,2);
 const playing=next(viewer,s=>s.seq===2);device.send(JSON.stringify({seq:2,mode:'playback',visible:true,title:'시험 영상',objects:[]}));assert.equal((await playing).title,'시험 영상');
 await request('/play?key=e');const state=await request('/recognition/status');assert.equal(state.playback.state,'loading');assert.equal(state.deviceHud.mode,'playback');
 await request('/recognition/playback',{id:state.playback.id,event:'playing'});assert.equal((await request('/recognition/status')).playback.state,'playing');
 await request('/recognition/playback',{id:state.playback.id,event:'stopped'});assert.equal((await request('/recognition/status')).playback,null);
 const after=await request('/cam/stats');assert.equal(after.bytes,before.bytes);
 const result={base,targets:shown.objects.map(o=>o.name),cameraBytesBefore:before.bytes,cameraBytesAfter:after.bytes,metadataOnly:true,playbackEvents:'loading → playing → stopped'};
 await fs.writeFile('results/native-tracking-0.2.10/cloud-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 device?.close();viewer?.close();for(const id of ids)await request('/recognition/targets?id='+id,null,'DELETE');
}
