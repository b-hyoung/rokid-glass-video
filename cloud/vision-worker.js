importScripts('/cloud/opencv.js');
const ready=new Promise((resolve,reject)=>{
  // Emscripten's legacy cv object is itself a thenable; never resolve a Promise with it.
  const started=Date.now();const check=()=>{if(self.cv?.Mat)resolve();else if(Date.now()-started>60000)reject(Error('OpenCV 로딩 시간이 초과됐습니다. 새로고침해 주세요.'));else setTimeout(check,50)};check();
}).then(async()=>{const {VisionEngine}=await import('./vision-engine.js');const engine=new VisionEngine(self.cv);const config=await(await fetch('/runtime-config.json',{cache:'no-store'})).json();if(config.protocol!==1)throw Error('지원하지 않는 인식 프로토콜입니다.');postMessage({ready:true,version:config.engine});return engine});
ready.catch(e=>postMessage({error:String(e.message||e)}));
const appearanceReady = import('./appearance-matcher.js').then(({AppearanceMatcher}) => new AppearanceMatcher());
let sequence=Promise.resolve();
let pairedTargets=new Set();
let aimMatch=null,lastAimAt=-Infinity;
let lastLocateAt=-Infinity,lastSceneAt=-Infinity;
function resetSearch(){aimMatch=null;lastAimAt=lastLocateAt=lastSceneAt=-Infinity}
onmessage=({data:d})=>{sequence=sequence.then(async()=>{
  try{const engine=await ready, appearance=await appearanceReady;let result;if(d.type==='references'){await engine.matcher.references(d.targets);appearance.setReferences(d.targets);pairedTargets=new Set(d.targets.filter(target=>target.appearance).map(target=>target.id));if(pairedTargets.size){await appearance.session();for(const ref of appearance.refs)await appearance.photoEmbeddings(ref);}engine.reset();resetSearch();result={count:engine.matcher.refs.length}}
    else if(d.type==='reset'){engine.reset();resetSearch();result={ok:true}}
    else if(d.type==='frame'){
      let appearanceError;
      const localized=new Set();
      const {aim,at}=d.options;
      let ranLocationSearch=false;
      const confirm=d.options.mode==='recognize'?async(canvas,found,early)=>{
        let passed=new Set();
        let located=[];
        // Photo matches already passed geometric identity checks. Return a new
        // photo immediately; the next scan resumes the unchanged vector search.
        if(engine.deferAppearance)return {required:pairedTargets,passed,located};
        if(early){
          passed=new Set(early.passed);
          try{for(const id of await appearance.confirm(canvas,found.filter(d=>pairedTargets.has(d.id)&&!passed.has(d.id))))passed.add(id)}catch(error){appearanceError=error.message}
          return {...early,passed};
        }
        try{
          passed=await appearance.confirm(canvas,found.filter(target=>pairedTargets.has(target.id)));
          for(const target of found)if(!pairedTargets.has(target.id)||passed.has(target.id))localized.add(target.id);
          const recovering=engine.tracks.size===0||[...engine.tracks.values()].some(track=>track.held);
          const locating=engine.pendingFlows.size>0||[...engine.tracks.values()].some(track=>track.recoveryCorners);
          const scanScene=at-lastSceneAt>=(recovering?700:1000);
          if(pairedTargets.size&&(scanScene||locating&&at-lastLocateAt>=300)){
            lastLocateAt=at;
            if(scanScene)lastSceneAt=at;
            ranLocationSearch=true;
            const hints=new Map([...engine.regionEvidence.pending].map(([id,entry])=>[id,entry.corners]));
            const flowed=new Set(engine.pendingFlows.keys());
            for(const [id,track] of engine.tracks)if(!hints.has(id)){
              if(track.held&&track.recoveryCorners){
                hints.set(id,track.recoveryCorners);flowed.add(id);
              }else if(scanScene&&!track.held){
                hints.set(id,track.corners);flowed.add(id);
              }
            }
            located=await appearance.locate(canvas,localized,hints,flowed,scanScene);
            for(const match of located)passed.add(match.id);
          }
        }
        catch(error){appearanceError=error.message}
        return {required:pairedTargets,passed,located};
      }:undefined;
      if(confirm&&pairedTargets.size){
        confirm.before=async canvas=>{
          ranLocationSearch=true;lastLocateAt=at;
          const missing=[...pairedTargets].some(id=>!engine.tracks.has(id)||engine.tracks.get(id).held);
          const scanScene=missing||at-lastSceneAt>=1800;
          if(scanScene)lastSceneAt=at;
          const hints=new Map([...engine.regionEvidence.pending].map(([id,entry])=>[id,entry.corners])),flowed=new Set(engine.pendingFlows.keys());
          for(const [id,track] of engine.tracks)if(!hints.has(id)){
            const corners=track.held?track.recoveryCorners:track.corners;
            if(corners){hints.set(id,corners);flowed.add(id)}
          }
          try{const located=await appearance.locate(canvas,new Set(),hints,flowed,scanScene);return {located,required:pairedTargets,passed:new Set(located.map(d=>d.id))}}
          catch(error){appearanceError=error.message;return {located:[],required:pairedTargets,passed:new Set()}}
        };
      }
      const candidateSearchPending=d.options.mode==='recognize'&&[...pairedTargets].some(id=>!engine.tracks.has(id)||engine.tracks.get(id).held);
      result=await engine.process(d.bitmap,{...d.options,candidateSearchPending},confirm);
      if(confirm&&aim&&pairedTargets.size&&!engine.deferAppearance){
        for(const target of result.found)localized.add(target.id);
        const aimLocated=result.found.some(d=>!d.held&&aim.cx>=Math.min(...d.corners.map(p=>p[0]))&&aim.cx<=Math.max(...d.corners.map(p=>p[0]))&&aim.cy>=Math.min(...d.corners.map(p=>p[1]))&&aim.cy<=Math.max(...d.corners.map(p=>p[1])));
        if(aimLocated)aimMatch=null;
        if(at-lastAimAt>=700&&!ranLocationSearch&&!aimLocated){
          lastAimAt=at;aimMatch=null;
          try{
            const id=await appearance.atAim(engine.canvas,aim,localized);
            if(id)aimMatch={id,at};
          }catch(error){appearanceError??=error.message}
        }
        if(aimMatch&&at-aimMatch.at<750&&!localized.has(aimMatch.id))result.aimMatch=aimMatch;
      }
      if(appearanceError)result.appearanceError=appearanceError;
    }
    postMessage({id:d.id,result});
  }catch(e){d.bitmap?.close();postMessage({id:d.id,error:String(e.message||e)})}
})};
