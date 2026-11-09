import {api} from './api-client.js';
const $=id=>document.getElementById(id),post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const show=message=>$('message').textContent=message;
let recoveryInfo=null,owner=false,refreshing=false,hasDevice=false;
const setup=new URLSearchParams(location.hash.slice(1)).get('setup');
if(setup){$('setup').value=setup;history.replaceState(null,'',location.pathname)}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function devices(){
 if(!owner||refreshing||document.hidden)return;
 refreshing=true;
 try{
  const [list,status]=await Promise.all([api('/access/devices',post({})),api('/status')]);
  $('devices').replaceChildren();
  for(const device of list.devices){
   const row=document.createElement('p'),label=document.createElement('span');
   label.textContent=device.label+' · v'+device.app+' · '+(device.connected?(status.glasses?'연결됨':'앱 접속 대기'):'연결 가능');row.append(label);
   if(!device.connected){const button=document.createElement('button');button.textContent='이 안경 연결';button.dataset.deviceId=device.id;button.onclick=()=>busy(button,async()=>{await api('/access/claim',post({deviceId:device.id}));show('연결을 승인했습니다. 안경이 자동으로 연결됩니다.');await devices()});row.append(button);}
   $('devices').append(row);
  }
  $('device-status').textContent=list.devices.length?'':'접속 중인 안경이 없습니다. 안경 앱과 네트워크를 확인하세요.';
  hasDevice=list.devices.some(d=>d.connected);$('disconnect').disabled=!hasDevice;
 }finally{refreshing=false}
}
async function refresh(){
 let session;
 try{session=await api('/access/session')}
 catch(error){if(error.status!==401)throw error;}
 owner=!!session?.owner;$('signed-out').hidden=!!session;$('signed-in').hidden=!session;
 if(session){$('room-id').textContent=session.roomId;$('owner').hidden=owner;$('refresh-devices').hidden=!owner;$('disconnect').hidden=!owner;if(owner)await devices();else{$('devices').replaceChildren();$('device-status').textContent='기기 관리 설정 키를 입력하면 안경을 선택할 수 있습니다.';}}
 const config=await api('/runtime-config.json');$('file-test').hidden=config.mode!=='local';
}
async function busy(button,action){button.disabled=true;try{await action()}catch(error){show(error.message)}finally{button.disabled=button.id==='disconnect'?!hasDevice:button.id==='import'&&!$('snapshot').files.length}}
$('create').onsubmit=event=>{event.preventDefault();busy(event.submitter,async()=>{const data=await api('/access/create',post({setupKey:$('setup').value}));$('setup').value='';recoveryInfo={roomId:data.roomId,recoveryKey:data.recoveryKey};$('recovery-info').textContent='운용 공간 ID: '+data.roomId+'\n복구 키: '+data.recoveryKey;$('new-key').hidden=false;show('운용 공간을 만들었습니다. 복구 정보를 보관하세요.');await refresh()})};
$('login').onsubmit=event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/access/login',post({roomId:$('room').value.trim(),recoveryKey:$('recovery').value.trim()}));$('recovery').value='';show('연결됐습니다.');await refresh()})};
$('save-key').onclick=()=>{if(recoveryInfo)download('glass-access-'+recoveryInfo.roomId+'.json',recoveryInfo)};
$('owner').onsubmit=event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/access/owner',post({setupKey:$('owner-key').value}));$('owner-key').value='';await refresh();show('웹에서 기기를 관리할 수 있습니다.')})};
$('refresh-devices').onclick=()=>busy($('refresh-devices'),devices);
$('disconnect').onclick=()=>busy($('disconnect'),async()=>{await api('/access/unclaim',post({}));show('안경 연결을 해제했습니다. 다시 사용하려면 목록에서 연결하세요.');await devices()});
setInterval(()=>devices().catch(error=>show(error.message)),3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)devices().catch(error=>show(error.message))});
$('snapshot').onchange=()=>$('import').disabled=!$('snapshot').files.length;
$('import').onclick=()=>busy($('import'),async()=>{const file=$('snapshot').files[0];if(!file||file.size>32*1024*1024)throw Error('32MB 이내의 등록 사본을 선택하세요.');const data=JSON.parse(await file.text());const result=await api('/recognition/import',post(data));show('대상 '+result.count+'개, 이미지 '+result.images+'장을 가져왔습니다.');$('snapshot').value='';$('import').disabled=true});
$('export').onclick=()=>busy($('export'),async()=>download('glass-registrations-'+$('room-id').textContent+'.json',await api('/recognition/backup')));
$('logout').onclick=()=>busy($('logout'),async()=>{await api('/access/logout',post({}));recoveryInfo=null;$('recovery-info').textContent='';$('new-key').hidden=true;$('devices').replaceChildren();await refresh();show('이 PC의 연결을 해제했습니다.')});
(async()=>{if(setup)await api('/access/owner',post({setupKey:setup}));await refresh()})().catch(error=>show(error.message)).finally(()=>{document.body.dataset.ready='true';for(const button of document.querySelectorAll('form button'))button.disabled=false});
