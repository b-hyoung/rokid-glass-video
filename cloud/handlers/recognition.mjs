import {json,DWELL_MS,FOCUS_RESUME_MS,DISPLAY_HOLD_MS,acceptDetectionEnvelope} from '../request-policy.mjs';
import {regionOverlap} from '../region-evidence.mjs';
import {validSeed} from '../tracking-seed.mjs';

export async function handleRecognition(req,u){
  const p=u.pathname,q=u.searchParams;
    if(p==='/recognition/status'){
      if(q.get('hud')==='2')this.guide.device={at:Date.now(),app:String(q.get('app')||'').slice(0,20),hud:2};
      const gap=Date.now()-this.lastResult;
      if(gap>(this.focus?FOCUS_RESUME_MS:2200) && (this.state.detections.length||this.focus)){this.reset()}
      // Older glasses draw every detection's four corners as an outline.
      const forGlasses=q.get('hud')==='2';
      const detections=forGlasses
        ?this.state.detections.filter(target=>!target.approximate&&!target.provisional)
        :this.state.detections;
      return json({...this.state,detections,focusMissing:this.state.focusMissing||!!this.focus&&gap>750,dwellMs:DWELL_MS,epoch:this.epoch,version:this.version,targets:this.targets(),source:'glasses',playback:this.playback.current(),deviceHud:this.deviceHud&&Date.now()-this.deviceHud.at<2000?this.deviceHud:null,serverNow:Date.now(),guide:this.guide.read()});
    }
    if(p==='/recognition/control'&&req.method==='POST'){if(q.get('enabled')==='1'&&this.guide.read().enabled)return json({error:'등록 가이드를 끈 뒤 인식을 시작하세요.'},409);this.active=q.get('enabled')==='1';this.reset();return json({ok:true})}
    if(p==='/recognition/detections'&&req.method==='POST'){
      const text=await req.text();if(text.length>60000)return json({error:'too big'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'invalid detections'},400)}
      const now=Date.now();if(!acceptDetectionEnvelope(d,{now,guideEnabled:this.guide.read().enabled,active:this.active,epoch:this.epoch,frameAt:this.state.frameAt||0}))return json({ok:false,stale:true});
      const elapsed=this.lastResult?now-this.lastResult:0;
      if(elapsed>FOCUS_RESUME_MS){this.focus=null;this.focusAt=0;this.focusCorners=null}
      const targets=this.targets();
      const found=(Array.isArray(d.found)?d.found:[]).slice(0,12).flatMap(f=>{
        const t=targets.find(t=>t.id===f?.id);
        if(!t?.imageCount||(t.hasVectors&&f.appearanceConfirmed!==true))return [];
        if(!Array.isArray(f.corners)||f.corners.length!==4||!f.corners.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=-.5&&n<=1.5)))return [];
        const matchedAt=Number.isFinite(f.matchedAt)?Math.min(f.matchedAt,d.at):d.at;
        const approximate=f.approximate===true;
        const provisional=f.provisional===true;
        if(approximate&&(!t.hasVectors||now-matchedAt>1100))return [];
        if(provisional&&(!t.hasVectors||now-matchedAt>1100))return [];
        const xs=f.corners.map(p=>p[0]),ys=f.corners.map(p=>p[1]);
        const bounds={left:Math.max(0,Math.min(...xs)),right:Math.min(1,Math.max(...xs)),
          top:Math.max(0,Math.min(...ys)),bottom:Math.min(1,Math.max(...ys))};
        if(bounds.left>=bounds.right||bounds.top>=bounds.bottom)return [];
        const held=provisional||f.held===true;
        const trackId=typeof f.trackId==='string'&&f.trackId.length<=80?f.trackId:'';
        return [{...t,trackId,corners:f.corners,bounds,inliers:approximate?0:Number(f.inliers)||0,matchedAt,
          approximate,provisional,held,seed:approximate||held?null:validSeed(f.seed)}];
      });
      const unique=new Map();for(const f of found){if(!unique.has(f.id)||unique.get(f.id).inliers<f.inliers)unique.set(f.id,f)}found.splice(0,found.length,...unique.values());
      // Retain only previously confirmed boxes, without refreshing their age.
      // A moving camera or conflicting identity clears the remembered box.
      const observed=found.filter(target=>!target.held&&!target.approximate);
      const contradicted=previous=>observed.some(target=>target.id!==previous.id&&regionOverlap(target.corners,previous.corners)>.28);
      for(let i=found.length-1;i>=0;i--)if(found[i].held&&contradicted(found[i]))found.splice(i,1);
      for(const [id,previous] of this.displayHistory){
        if(now-previous.at>DISPLAY_HOLD_MS||d.sceneStable!==true||contradicted(previous.target)){
          this.displayHistory.delete(id);
        }else if(!unique.has(id)&&found.length<12){
          found.push({...previous.target,held:true,seed:null});
        }
      }
      for(const target of observed)this.displayHistory.set(target.id,{at:now,target});
      const guide=this.guide.read(),aim=guide.calibrated?guide.camera:{cx:.5,cy:.5};
      const inside=({bounds:b})=>aim.cx>=b.left&&aim.cx<=b.right&&aim.cy>=b.top&&aim.cy<=b.bottom;
      const near=({bounds:b})=>{
        const dx=Math.min(.015,(b.right-b.left)*.12),dy=Math.min(.015,(b.bottom-b.top)*.12);
        return aim.cx>=b.left-dx&&aim.cx<=b.right+dx&&aim.cy>=b.top-dy&&aim.cy<=b.bottom+dy;
      };
      const localized=found.filter(t=>!t.approximate);
      const focusedTrack = localized.find(t=>t.id===this.focus);
      const liveTargets=now-d.at<=750?localized.filter(t=>!t.held):[];
      const aimAt=d.aimMatch?.at;
      const aimTarget=Number.isFinite(aimAt)&&aimAt<=d.at&&now-aimAt<1200
        ? targets.find(t=>t.id===d.aimMatch.id&&t.hasVectors&&t.imageCount&&!localized.some(match=>match.id===t.id))
        : null;
      const choice = focusedTrack&&liveTargets.includes(focusedTrack)&&inside(focusedTrack)
        ? focusedTrack
        : liveTargets.filter(inside).sort((a,b)=>b.inliers-a.inliers)[0]??null;
      if(this.locked&&(aimTarget?.id===this.locked||localized.some(f=>f.id===this.locked)))this.lastVisible=now;
      if(this.locked&&now-this.lastVisible>2000)this.locked=null;
      const busy=!!this.playback.current();
      if(this.rearm&&!choice&&!localized.some(inside))this.rearm=false;
      if(busy||this.rearm){this.focus=null;this.focusAt=now}
      const resuming=this.state.focusMissing||elapsed>750;
      const trackChanged=choice?.trackId&&this.state.focusTrackId&&choice.trackId!==this.state.focusTrackId;
      const sameFocus=!!this.focus&&choice?.id===this.focus&&!trackChanged&&(!resuming||
        (!!this.focusCorners&&(!this.state.focusMissingAt||now-this.state.focusMissingAt<=FOCUS_RESUME_MS)&&
          regionOverlap(this.focusCorners,choice.corners)>=.25));
      if(!busy&&!this.rearm&&choice&&!sameFocus){this.focus=choice.id;this.focusAt=now}
      let progress=0;
      let focusMissingAt=0;
      if(!busy&&!this.rearm&&this.focus&&this.focus!==this.locked){
        if(choice){
          if(sameFocus&&resuming){
            // Credit only a bounded fresh observation, not the missing interval.
            const observedMs=Math.min(150,Math.max(0,d.at-(this.state.frameAt||d.at)),elapsed);
            this.focusAt=now-this.state.progress*DWELL_MS-observedMs;
          }
          else if(sameFocus&&elapsed>350)this.focusAt+=elapsed-350;
          progress=Math.min(1,(now-this.focusAt)/DWELL_MS);
          this.focusCorners=choice.corners;
        }else{
          focusMissingAt=this.state.focusMissingAt || this.lastResult || now;
          // Near-edge jitter can pause dwell, but only a live box containing
          // the aim can advance it. A clear exit ends the attempt.
          const outside=focusedTrack&&liveTargets.includes(focusedTrack)&&!near(focusedTrack);
          progress=outside||now-focusMissingAt>FOCUS_RESUME_MS?0:this.state.progress;
          this.focusAt=now-progress*DWELL_MS;
          if(outside||now-focusMissingAt>FOCUS_RESUME_MS)this.focus=null;
        }
      }
      if(choice&&progress>=1&&now-d.at<=750&&now-choice.matchedAt<1200){
        const revision=this.playback.revision,epoch=this.epoch,focus=this.focus;
        const v=(await this.videos(req))[choice.key];
        if(v&&revision===this.playback.revision&&epoch===this.epoch&&focus===this.focus&&!this.playback.current()&&!this.rearm){this.startPlayback(v,choice.key,'recognition',choice.id);this.locked=choice.id;this.lastVisible=now}
      }
      if(!this.active||this.epoch!==d.epoch)return json({ok:false,stale:true});
      const focusStartedAt=this.focus?(sameFocus||!choice?this.state.focusStartedAt:now):0;
      const focusMissing=!!this.focus&&!choice;
      const focusExpiresAt=this.focus?(focusMissing?focusMissingAt:now)+FOCUS_RESUME_MS:0;
      const focusTrackId=this.focus?(choice?.trackId||this.state.focusTrackId||''):'';
      const focusReason=busy?'playback':this.rearm?'rearm':now-d.at>750?'frame_delayed':
        choice?'observed':focusedTrack?.held?'tracking_paused':focusedTrack?'aim_outside':
        found.length?'no_centered_target':'no_detections';
      if(focusReason!==this.state.focusReason)this.trace('recognition_focus',{reason:focusReason,
        focused:this.focus,progress,frameAgeMs:Math.max(0,now-d.at),detections:found.length});
      this.lastResult=now;this.state={enabled:true,detections:found,aimTarget:aimTarget?.name??null,progress,focused:this.focus,
        focusTrackId,focusReason,focusMode:this.focus?(focusMissing?'paused':'advancing'):'idle',focusExpiresAt,
        focusStartedAt,focusMissing,focusMissingAt:this.focus?focusMissingAt:0,locked:this.locked,frameAt:d.at,at:now};
      if(d.preview===true){
        const detections=found.map(({id,trackId,name,corners,bounds,approximate,provisional,held})=>({id,trackId,name,corners,bounds,approximate,provisional,held}));
        return json({ok:true,preview:{...this.state,detections,epoch:this.epoch}});
      }
      return json({ok:true});
    }
}
