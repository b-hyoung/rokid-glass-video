import {api} from './api-client.js';
const $=id=>document.getElementById(id),post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const show=message=>$('message').textContent=message;
let recoveryInfo=null;
const setup=new URLSearchParams(location.hash.slice(1)).get('setup');
if(setup){$('setup').value=setup;history.replaceState(null,'',location.pathname)}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function refresh(){
 try{const session=await api('/access/session');if(session.role!=='controller')throw Error('PC 제어 권한으로 연결하세요.');$('signed-out').hidden=true;$('signed-in').hidden=false;$('room-id').textContent=session.roomId;$('server-address').textContent=location.origin;}
 catch{$('signed-out').hidden=false;$('signed-in').hidden=true;}
 const config=await api('/runtime-config.json');$('file-test').hidden=config.mode!=='local';
 if(config.mode==='local'&&['localhost','127.0.0.1'].includes(location.hostname)){
   const info=await api('/local-info.json');$('server-address').textContent=info.lanUrls?.length?info.lanUrls.join(' / '):'이 PC의 Wi-Fi 주소와 포트를 입력하세요.';
 }
}
async function busy(button,action){button.disabled=true;try{await action()}catch(error){show(error.message)}finally{button.disabled=button.id==='import'&&!$('snapshot').files.length}}
$('create').onsubmit=event=>{event.preventDefault();busy(event.submitter,async()=>{const data=await api('/access/create',post({setupKey:$('setup').value}));$('setup').value='';recoveryInfo={roomId:data.roomId,recoveryKey:data.recoveryKey};$('recovery-info').textContent='운용 공간 ID: '+data.roomId+'\n복구 키: '+data.recoveryKey;$('new-key').hidden=false;show('운용 공간을 만들었습니다. 복구 정보를 보관하세요.');await refresh()})};
$('login').onsubmit=event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/access/login',post({roomId:$('room').value.trim(),recoveryKey:$('recovery').value.trim()}));$('recovery').value='';show('연결됐습니다.');await refresh()})};
$('save-key').onclick=()=>{if(recoveryInfo)download('glass-access-'+recoveryInfo.roomId+'.json',recoveryInfo)};
$('new-code').onclick=()=>busy($('new-code'),async()=>{const data=await api('/access/code',post({}));$('pair-code').textContent=data.code;$('expires').textContent='한 번만 사용할 수 있으며 2분 후 만료됩니다.';setTimeout(()=>{if($('pair-code').textContent===data.code){$('pair-code').textContent='';$('expires').textContent='코드가 만료됐습니다. 새 코드를 만드세요.'}},Math.max(0,data.expiresAt-Date.now()))});
$('snapshot').onchange=()=>$('import').disabled=!$('snapshot').files.length;
$('import').onclick=()=>busy($('import'),async()=>{const file=$('snapshot').files[0];if(!file||file.size>32*1024*1024)throw Error('32MB 이내의 등록 사본을 선택하세요.');const data=JSON.parse(await file.text());const result=await api('/recognition/import',post(data));show('대상 '+result.count+'개, 이미지 '+result.images+'장을 가져왔습니다.');$('snapshot').value='';$('import').disabled=true});
$('export').onclick=()=>busy($('export'),async()=>download('glass-registrations-'+$('room-id').textContent+'.json',await api('/recognition/backup')));
$('logout').onclick=()=>busy($('logout'),async()=>{await api('/access/logout',post({}));recoveryInfo=null;$('recovery-info').textContent='';$('new-key').hidden=true;$('pair-code').textContent='';await refresh();show('이 PC의 연결을 해제했습니다.')});
refresh().catch(error=>show(error.message)).finally(()=>{document.body.dataset.ready='true';for(const button of document.querySelectorAll('form button'))button.disabled=false});
