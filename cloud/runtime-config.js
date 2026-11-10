// Environment is data. The local launcher never rewrites HTML or JavaScript.
export async function loadRuntimeConfig(fetcher=fetch){
  const response=await fetcher('/runtime-config.json',{cache:'no-store'});
  if(!response.ok)throw Error('실행 설정을 읽지 못했습니다. 서버 빌드를 확인하세요.');
  const config=await response.json();
  if(!['cloud','local'].includes(config.mode)||config.protocol!==1)throw Error('지원하지 않는 서버 설정입니다.');
  return config;
}

export function applyRuntimeConfig(config,root=document){
  const local=config.mode==='local';
  const link=root.querySelector('#app-download');
  if(link){
    link.hidden=!local&&!config.downloadUrl;
    link.href=local?'/local-check.html':config.downloadUrl||'#';
    link.textContent=local?'사진·녹화 테스트':config.downloadLabel||'안경 앱 '+config.appVersion+' 받기';
  }
  const setup=root.querySelector('#local-setup');if(setup)setup.hidden=!local||config.accessMode==='paired';
  const access=root.querySelector('#connection-access');if(access)access.hidden=config.accessMode!=='paired';
  const hint=root.querySelector('#capture-environment');
  if(hint)hint.textContent=(local?'이 PC':'연결 서버')+'로 촬영 영상을 전송합니다. 등록용 화면을 멈춰도 안경 촬영은 계속됩니다.';
}
