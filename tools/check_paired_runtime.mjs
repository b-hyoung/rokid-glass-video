// Integration against a disposable local paired runtime, with real SQLite,
// authenticated cookies and the APK's native WebSocket implementation.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const origin=process.argv[2]||'http://localhost:8791';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Only an isolated loopback runtime is allowed');
const folder=path.resolve('runtime/paired-'+new URL(origin).port),keys=JSON.parse(fs.readFileSync(path.join(folder,'secrets.json'),'utf8'));
async function request(route,{data,cookie,token,method,headers={}}={}){
 const response=await fetch(origin+route,{method:method||(data?'POST':'GET'),headers:{...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined,redirect:'manual'});
 const result=response.headers.get('Content-Type')?.includes('json')?await response.json():null;
 return {status:response.status,data:result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function create(){const response=await request('/access/create',{data:{setupKey:keys.SETUP_SECRET}});assert.equal(response.status,200);return {...response.data,cookie:response.cookie}}
assert.equal((await request('/recognition/targets')).status,401);
const a=await create(),b=await create();
const snapshot=JSON.parse(fs.readFileSync('runtime/local-targets-import.json','utf8').replace(/^\uFEFF/,''));
assert.equal((await request('/recognition/import',{data:snapshot,cookie:a.cookie})).status,200);
const restored=(await request('/recognition/backup',a)).data;
const normalize=targets=>targets.map(t=>({id:t.id,name:t.name,key:t.key,appearance:t.appearance??null,images:t.images.map(i=>({id:i.id,image:i.image,created_at:i.created_at,capture:i.capture??null})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id));
assert.deepEqual(normalize(restored.targets),normalize(snapshot.targets));assert.deepEqual(restored.guide,snapshot.guide);
assert.equal((await request('/recognition/targets?room='+a.roomId,{...b,headers:{'X-Glass-Room':a.roomId}})).data.targets.length,0);
await request('/recognition/targets?id='+snapshot.targets[0].id,{...b,method:'DELETE'});
assert.equal((await request('/recognition/targets',a)).data.targets.length,snapshot.targets.length);
const code=(await request('/access/code',{...a,data:{}})).data.code;
const device=await request('/access/pair',{data:{code,protocol:1}});assert.equal(device.status,200);
assert.equal((await request('/access/pair',{data:{code,protocol:1}})).status,403);
assert.equal((await request('/recognition/targets',{token:device.data.token})).status,403);
assert.equal((await request('/play?key=e',{token:device.data.token,data:{}})).status,403);
assert.equal((await request('/stop',{...a,data:{},headers:{Origin:'http://other.test'}})).status,403);
await request('/preview/sync',{...a,data:{}});
assert.equal((await request('/preview/recognition/targets',a)).data.targets.length,snapshot.targets.length);
assert.equal((await request('/preview/recognition/targets',b)).data.targets.length,0);
assert.equal((await request('/status',a)).data.now,null);
const privateCredentials={a,b,device:device.data};fs.writeFileSync(path.join(folder,'check-credentials.json'),JSON.stringify(privateCredentials),{mode:0o600});
const release=JSON.parse(fs.readFileSync('release.json','utf8')),native=path.join(folder,'native-check');fs.mkdirSync(native,{recursive:true});
fs.writeFileSync(path.join(native,'BuildInfo.java'),'package com.hoonartis.glassvideo; final class BuildInfo { static final String VERSION='+JSON.stringify(release.app.version)+'; }');
const javaHome=process.env.JAVA_HOME||(process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Eclipse Adoptium',fs.readdirSync(path.join(process.env.ProgramFiles||'C:/Program Files','Eclipse Adoptium')).find(n=>n.startsWith('jdk-25'))):null);
const java=name=>javaHome?path.join(javaHome,'bin',name):name;
const jars=['Java-WebSocket-1.6.0.jar','slf4j-api-2.0.13.jar'].map(f=>path.resolve('build/deps',f)),classpath=jars.join(path.delimiter);
execFileSync(java('javac'),['-encoding','UTF-8','-cp',classpath,'-d',native,path.join(native,'BuildInfo.java'),'src/com/hoonartis/glassvideo/DeviceAccess.java','tests/native/PairingTransportProbe.java'],{stdio:'pipe',windowsHide:true});
execFileSync(java('java'),['-cp',[native,...jars].join(path.delimiter),'com.hoonartis.glassvideo.PairingTransportProbe'],{input:origin+'\n'+device.data.token+'\n',stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:20000});
const replacementCode=(await request('/access/code',{...a,data:{}})).data.code;
const replacement=await request('/access/pair',{data:{code:replacementCode,protocol:1}});assert.equal(replacement.status,200);
assert.equal((await request('/status',{token:device.data.token})).status,403);assert.equal((await request('/videos.json',{token:device.data.token})).status,403);
assert.equal((await request('/videos.json',{token:replacement.data.token})).status,200);
fs.writeFileSync(path.join(folder,'check-credentials.json'),JSON.stringify({a,b,device:replacement.data}),{mode:0o600});
const report={anonymousRejected:true,workspacesIsolated:true,restoreTargets:restored.targets.length,restoreImages:restored.targets.reduce((n,t)=>n+t.images.length,0),idsPhotosVectorsCalibrationExact:true,deviceReadAndControlRestricted:true,crossOriginRejected:true,codeSingleUse:true,previewIsolated:true,nativeAuthenticatedHttpAndWebSocket:true,previousDeviceRevoked:true,actualAndroidHardwareValidated:false};
fs.writeFileSync(path.join(folder,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
