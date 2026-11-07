// HUD geometry and camera geometry are independent: a manual alignment at the
// intended working distance is required. This is not a world-locked AR transform.
export const DEFAULT_GUIDE={shape:'rect',hud:{cx:.5,cy:.5,width:.6,height:.35},camera:{cx:.5,cy:.5,width:.6,height:.35},calibrated:false};
export function guideConfig(value={}){
  if(!['rect','circle'].includes(value.shape??'rect'))throw Error('원 또는 네모를 선택하세요.');
  const rect=(r={})=>{const out={};for(const k of ['cx','cy','width','height']){const n=r[k]??DEFAULT_GUIDE.hud[k];if(!Number.isFinite(n)||n<.05||n>.95)throw Error('가이드 위치와 크기 범위를 확인하세요.');out[k]=n}if(out.cx-out.width/2<0||out.cx+out.width/2>1||out.cy-out.height/2<0||out.cy+out.height/2>1)throw Error('가이드가 화면 밖으로 나가지 않게 조절하세요.');return out};
  return {shape:value.shape??'rect',hud:rect(value.hud),camera:rect(value.camera),calibrated:value.calibrated===true};
}
export class RegistrationGuide {
  constructor(storage){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS registration_settings (id INTEGER PRIMARY KEY,data TEXT NOT NULL)');const saved=this.sql.exec('SELECT data FROM registration_settings WHERE id=1').toArray()[0];this.config=structuredClone(DEFAULT_GUIDE);if(saved)try{this.config=guideConfig(JSON.parse(saved.data))}catch{}this.lease=null;this.device=null}
  read(now=Date.now()){return {...this.config,...(this.lease?.expiresAt>now?this.lease:{enabled:false}),device:this.device&&now-this.device.at<10000?this.device:null}}
  update(d,now=Date.now()){
    if(typeof d.owner!=='string'||!d.owner.trim()||d.owner.length>80)throw Error('등록 화면을 새로 열어 주세요.');
    if(this.lease?.expiresAt>now&&this.lease.owner!==d.owner)throw Error('다른 화면에서 등록 가이드를 사용 중입니다.');
    const config=d.config?guideConfig(d.config):this.config;
    if(d.save){this.sql.exec('INSERT OR REPLACE INTO registration_settings VALUES (1,?)',JSON.stringify(config))}
    this.config=config;
    this.lease=d.enabled?{enabled:true,owner:d.owner,expiresAt:now+5000,phase:['align','capture','review','verify'].includes(d.phase)?d.phase:'align',message:String(d.message||'테두리 안에 물체를 맞춰 주세요').slice(0,70),progress:Math.max(0,Math.min(1,Number(d.progress)||0)),count:Math.max(0,Math.min(60,Number(d.count)||0))}:null;
    return this.read(now);
  }
}
