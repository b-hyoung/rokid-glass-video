// Opaque pairing codes are stored only as hashes. Signed credentials carry the
// workspace and role; epoch/test remain timing fields, never authentication.
const encoder=new TextEncoder(),COOKIE='glass_session';
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const bytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const base64=value=>btoa(String.fromCharCode(...value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const random=()=>base64(crypto.getRandomValues(new Uint8Array(32)));
const digest=async value=>base64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
const signingKeys=new Map();
function signingKey(secret){
  if(typeof secret!=='string'||secret.length<32)throw Error('SESSION_SECRET is not configured');
  if(!signingKeys.has(secret)){if(signingKeys.size>=2)signingKeys.clear();signingKeys.set(secret,crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']))}
  return signingKeys.get(secret);
}
export async function signCredential(secret,room,role,now=Date.now(),deviceId=crypto.randomUUID()){
  const payload=base64(encoder.encode(JSON.stringify({v:1,protocol:1,room,role,...(role==='device'?{deviceId}:{}),exp:now+(role==='device'?7*86400000:12*3600000)})));
  const signature=await crypto.subtle.sign('HMAC',await signingKey(secret),encoder.encode(payload));
  return payload+'.'+base64(new Uint8Array(signature));
}
export async function verifyCredential(secret,token,now=Date.now()){
  try{
    if(typeof token!=='string'||token.length>2048)return null;
    const parts=token.split('.');if(parts.length!==2)return null;
    if(!await crypto.subtle.verify('HMAC',await signingKey(secret),bytes(parts[1]),encoder.encode(parts[0])))return null;
    const claims=JSON.parse(new TextDecoder().decode(bytes(parts[0])));
    if(claims.v!==1||claims.protocol!==1||!['controller','device'].includes(claims.role)||
       !/^[0-9a-f-]{36}$/.test(claims.room)||claims.role==='device'&&!/^[0-9a-f-]{36}$/.test(claims.deviceId)||!Number.isSafeInteger(claims.exp)||claims.exp<=now)return null;
    return claims;
  }catch{return null}
}
function credential(request){
  const bearer=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get('Authorization')||'');
  if(bearer)return bearer[1];
  return request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
}
function cookie(request,token,clear=false){return COOKIE+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+(clear?0:43200)+(new URL(request.url).protocol==='https:'?'; Secure':'')}
const devicePaths=new Set(['/status','/next','/log','/tele','/frame','/stream','/cam/upload','/recognition/device','/recognition/playback','/recognition/status']);
export function roleAllows(role,url,method){
  const path=url.pathname;
  if(role==='controller'){
    if(['/next','/frame','/stream','/tele','/log','/cam/upload','/recognition/device'].includes(path))return false;
    if(path==='/cam/rtc'||path==='/recognition/events')return url.searchParams.get('role')==='viewer';
    return true;
  }
  if(path.startsWith('/preview/')||path==='/local/import')return false;
  if(path==='/cam/rtc'||path==='/recognition/events')return url.searchParams.get('role')==='device';
  if(path==='/videos.json'||/^\/v\/[\w.-]+\.mp4$/.test(path))return ['GET','HEAD'].includes(method);
  return devicePaths.has(path);
}
function scopedNamespace(namespace,room,kind){return {idFromName:()=>namespace.idFromName(kind+':'+room),get:id=>namespace.get(id)}}
export function scopeEnvironment(env,claims){return {...env,SESSION_SCOPED:true,
  ROOM:scopedNamespace(env.ROOM,claims.room,'workspace'),
  ...(env.PREVIEW?{PREVIEW:scopedNamespace(env.PREVIEW,claims.room,'preview')}:{})};}
const mutationGets=new Set(['/play','/stop','/cam/set']);
function dynamic(path){return path.startsWith('/recognition/')||path.startsWith('/cam/')||path.startsWith('/preview/')||path==='/local/import'||
  ['/status','/next','/play','/stop','/log','/frame','/stream','/tele','/videos.json'].includes(path)||path.startsWith('/v/');}
const protectedPages=new Set(['/','/control','/control/','/cam','/recognition','/recognition/','/local-check.html']);
export async function secureFetch(request,env,next){
  if(env.SESSION_SCOPED)return next(request,env);
  const headers=new Headers(request.headers);for(const name of ['X-Glass-Role','X-Glass-Room','X-Glass-Device','X-Glass-Expires'])headers.delete(name);
  request=new Request(request,{headers});
  if(env.ACCESS_MODE!=='paired')return next(request,env);
  const url=new URL(request.url),path=url.pathname;
  if(!env.SESSION_SECRET||!env.SETUP_SECRET||!env.ACCESS)return json({error:'페어링 서버 설정이 필요합니다.'},503);
  if(path==='/connect')return env.ASSETS.fetch(new Request(new URL('/cloud/connect.html',url),request));
  if(path==='/runtime-config.json'){
    const response=await env.ASSETS.fetch(request);if(!response.ok)return response;
    return json({...await response.json(),accessMode:'paired'});
  }
  const claims=await verifyCredential(env.SESSION_SECRET,credential(request));
  if(path.startsWith('/access/')){
    if(path==='/access/session')return claims?json({roomId:claims.room,role:claims.role,protocol:claims.protocol,expiresAt:claims.exp}):json({error:'로그인이 필요합니다.'},401);
    if(request.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
    if(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'다른 사이트의 요청입니다.'},403);
    if(path==='/access/logout')return json({ok:true},200,{'Set-Cookie':cookie(request,'',true)});
    if(!['/access/create','/access/login','/access/pair','/access/code'].includes(path))return json({error:'없는 요청'},404);
    if(path==='/access/code'&&claims?.role!=='controller')return json({error:'제어 권한이 필요합니다.'},403);
    const text=await request.text();if(text.length>4096)return json({error:'요청이 너무 큽니다.'},413);
    let data;try{data=JSON.parse(text);if(!data||typeof data!=='object')throw Error()}catch{return json({error:'잘못된 요청입니다.'},400)}
    const internal=new Request('https://registry'+path,{method:'POST',body:JSON.stringify({...data,roomId:path==='/access/code'?claims.room:data.roomId}),headers:{'X-Client':env.TRUST_CF_IP==='1'?(request.headers.get('CF-Connecting-IP')||'unknown'):'local'}});
    const response=await env.ACCESS.get(env.ACCESS.idFromName('pairing-registry')).fetch(internal);
    if(!response.ok)return response;
    const result=await response.json();
    if(result.token&&result.role==='device'){
      const device=await verifyCredential(env.SESSION_SECRET,result.token);
      if(!device)return json({error:'기기 자격 발급에 실패했습니다.'},503);
      const bound=await env.ROOM.get(env.ROOM.idFromName('workspace:'+device.room)).fetch(new Request('https://internal/recognition/device-bind',{method:'POST',body:JSON.stringify({deviceId:device.deviceId}),headers:{'X-Glass-Role':'pairing-service'}}));
      if(!bound.ok)return json({error:'기기 연결에 실패했습니다. 새 코드를 만드세요.'},503);
    }
    if(result.token&&result.role==='controller'){
      const {token,...publicResult}=result;return json(publicResult,200,{'Set-Cookie':cookie(request,token)});
    }
    return json(result);
  }
  if(!dynamic(path)&&!protectedPages.has(path))return next(request,env);
  if(!claims)return protectedPages.has(path)?new Response(null,{status:303,headers:{Location:'/connect','Cache-Control':'no-store'}}):json({error:'페어링 또는 로그인이 필요합니다.'},401);
  if(!roleAllows(claims.role,url,request.method))return json({error:'이 기능에 대한 권한이 없습니다.'},403);
  if(claims.role==='controller'&&mutationGets.has(path)&&request.method!=='POST')return json({error:'POST 요청이 필요합니다.'},405);
  if(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'다른 사이트의 요청입니다.'},403);
  const authorized=new Headers(request.headers);authorized.set('X-Glass-Role',claims.role);authorized.set('X-Glass-Room',claims.room);authorized.set('X-Glass-Expires',String(claims.exp));
  if(claims.role==='device')authorized.set('X-Glass-Device',claims.deviceId);
  const scoped=scopeEnvironment(env,claims);
  if(claims.role==='device'&&(path==='/videos.json'||path.startsWith('/v/'))){
    const allowed=await scoped.ROOM.get(scoped.ROOM.idFromName('glasses-main')).fetch(new Request('https://internal/recognition/device-access',{headers:authorized}));
    if(!allowed.ok)return allowed;
  }
  return next(new Request(request,{headers:authorized}),scoped);
}

export class PairingRegistry{
  constructor(ctx,env){this.storage=ctx.storage;this.sql=ctx.storage.sql;this.env=env;
    this.sql.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY,key_hash TEXT NOT NULL,created_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pair_codes (code_hash TEXT PRIMARY KEY,room_id TEXT NOT NULL,expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS access_limits (id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,count INTEGER NOT NULL)');
  }
  async fetch(request){
    const path=new URL(request.url).pathname,now=Date.now();let data;
    try{data=await request.json()}catch{return json({error:'잘못된 요청입니다.'},400)}
    const client=await digest(request.headers.get('X-Client')||'local');
    const limit=this.sql.exec('SELECT * FROM access_limits WHERE id=?',client).toArray()[0];
    if(limit&&now-limit.started_at<300000&&limit.count>=15)return json({error:'시도가 많습니다. 5분 후 다시 시도하세요.'},429);
    if(!limit||now-limit.started_at>=300000)this.sql.exec('INSERT OR REPLACE INTO access_limits VALUES (?,?,1)',client,now);
    else this.sql.exec('UPDATE access_limits SET count=count+1 WHERE id=?',client);
    this.sql.exec('DELETE FROM access_limits WHERE started_at<?',now-600000);
    this.sql.exec('DELETE FROM pair_codes WHERE expires_at<=?',now);
    if(path==='/access/create'){
      if(typeof data.setupKey!=='string'||await digest(data.setupKey)!==await digest(this.env.SETUP_SECRET))return json({error:'설정 키를 확인하세요.'},403);
      const roomId=crypto.randomUUID(),recoveryKey=random(),hash=await digest(recoveryKey);
      this.sql.exec('INSERT INTO workspaces VALUES (?,?,?)',roomId,hash,now);
      return json({roomId,recoveryKey,role:'controller',token:await signCredential(this.env.SESSION_SECRET,roomId,'controller',now)});
    }
    if(path==='/access/login'){
      const room=typeof data.roomId==='string'?this.sql.exec('SELECT * FROM workspaces WHERE id=?',data.roomId).toArray()[0]:null;
      if(!room||typeof data.recoveryKey!=='string'||await digest(data.recoveryKey)!==room.key_hash)return json({error:'운용 공간과 복구 키를 확인하세요.'},403);
      return json({roomId:room.id,role:'controller',token:await signCredential(this.env.SESSION_SECRET,room.id,'controller',now)});
    }
    if(path==='/access/code'){
      if(!this.sql.exec('SELECT 1 FROM workspaces WHERE id=?',data.roomId).toArray().length)return json({error:'운용 공간을 찾지 못했습니다.'},404);
      const values=new Uint32Array(1);let code,hash;
      do{crypto.getRandomValues(values);code=String(values[0]%100000000).padStart(8,'0');hash=await digest(code)}while(this.sql.exec('SELECT 1 FROM pair_codes WHERE code_hash=?',hash).toArray().length);
      this.sql.exec('DELETE FROM pair_codes WHERE room_id=?',data.roomId);
      this.sql.exec('INSERT INTO pair_codes VALUES (?,?,?)',hash,data.roomId,now+120000);
      return json({code,expiresAt:now+120000});
    }
    if(path==='/access/pair'){
      if(!/^\d{8}$/.test(data.code||'')||data.protocol!==1)return json({error:'8자리 코드와 앱 버전을 확인하세요.'},400);
      const hash=await digest(data.code);
      // Consume atomically before awaiting token signing: two devices cannot
      // redeem the same code while the crypto operation yields.
      const room=this.storage.transactionSync(()=>{
        const code=this.sql.exec('SELECT room_id FROM pair_codes WHERE code_hash=? AND expires_at>?',hash,Date.now()).toArray()[0];
        if(code)this.sql.exec('DELETE FROM pair_codes WHERE code_hash=?',hash);return code;
      });
      if(!room)return json({error:'코드가 만료됐거나 이미 사용됐습니다.'},403);
      return json({roomId:room.room_id,role:'device',protocol:1,token:await signCredential(this.env.SESSION_SECRET,room.room_id,'device',now)});
    }
    return json({error:'없는 요청'},404);
  }
}
