importScripts('/cloud/opencv.js');
const ready=new Promise((resolve,reject)=>{
  // Emscripten's legacy cv object is itself a thenable; never resolve a Promise with it.
  const started=Date.now();const check=()=>{if(self.cv?.Mat)resolve();else if(Date.now()-started>60000)reject(Error('OpenCV 로딩 시간이 초과됐습니다. 새로고침해 주세요.'));else setTimeout(check,50)};check();
}).then(async()=>{const {VisionEngine}=await import('./vision-engine.js');const engine=new VisionEngine(self.cv);postMessage({ready:true,version:'region-v14-fast-photo'});return engine});
ready.catch(e=>postMessage({error:String(e.message||e)}));
const appearanceReady = import('./appearance-matcher.js').then(({AppearanceMatcher}) => new AppearanceMatcher());
let sequence=Promise.resolve();
let pairedTargets=new Set();
let aimMatch=null,lastAimAt=-Infinity;
let lastLocateAt=-Infinity,lastSceneAt=-Infinity;
function resetSearch(){aimMatch=null;lastAimAt=lastLocateAt=lastSceneAt=-Infinity}
onmessage=({data:d})=>{sequence=sequence.then(async()=>{
  try{const engine=await ready, appearance=await appearanceReady;let result;if(d.type==='references'){await engine.matcher.references(d.targets);appearance.setReferences(d.targets);pairedTargets=new Set(d.targets.filter(target=>target.appearance).map(target=>target.id));if(pairedTargets.size)appearance.session().catch(()=>{});engine.reset();resetSearch();result={count:engine.matcher.refs.length}}
    else if(d.type==='reset'){engine.reset();resetSearch();result={ok:true}}
    else if(d.type==='frame'){
      let appearanceError;
      const localized=new Set();
      const {aim,at}=d.options;
      let ranLocationSearch=false;
      const confirm=d.options.mode==='recognize'?async(canvas,found)=>{
        let passed=new Set();
        let located=[];
        // Photo matches already passed geometric identity checks. Return a new
        // photo immediately; the next scan resumes the unchanged vector search.
        if(engine.deferAppearance)return {required:pairedTargets,passed,located};
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
      result=await engine.process(d.bitmap,d.options,confirm);
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
