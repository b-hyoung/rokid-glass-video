importScripts('/cloud/opencv.js');
const ready=new Promise((resolve,reject)=>{
  // Emscripten's legacy cv object is itself a thenable; never resolve a Promise with it.
  const started=Date.now();const check=()=>{if(self.cv?.Mat)resolve();else if(Date.now()-started>60000)reject(Error('OpenCV 로딩 시간이 초과됐습니다. 새로고침해 주세요.'));else setTimeout(check,50)};check();
}).then(async()=>{const {VisionEngine}=await import('./vision-engine.js');const engine=new VisionEngine(self.cv);postMessage({ready:true});return engine});
ready.catch(e=>postMessage({error:String(e.message||e)}));
const appearanceReady = import('./appearance-matcher.js').then(({AppearanceMatcher}) => new AppearanceMatcher());
let sequence=Promise.resolve();
onmessage=({data:d})=>{sequence=sequence.then(async()=>{
  try{const engine=await ready, appearance=await appearanceReady;let result;if(d.type==='references'){await engine.matcher.references(d.targets);appearance.setReferences(d.targets);engine.reset();result={count:engine.matcher.refs.length}}
    else if(d.type==='reset'){engine.reset();result={ok:true}}
    else if(d.type==='frame'){
      result=await engine.process(d.bitmap,d.options);
      if(d.options.mode==='recognize'){
        const vectorIds=new Set(appearance.refs.map(t=>t.id));
        result.found=result.found.filter(target=>!vectorIds.has(target.id));
        try{result.vectorTarget=await appearance.detect(engine.canvas,d.options.aim)}
        catch(error){result.appearanceError=error.message}
      }
    }
    postMessage({id:d.id,result});
  }catch(e){d.bitmap?.close();postMessage({id:d.id,error:String(e.message||e)})}
})};
