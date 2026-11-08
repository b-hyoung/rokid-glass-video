import {trackingSeed} from './tracking-seed.mjs';
import {Matcher} from './matcher.js';
import {RegionEvidence,regionOverlap} from './region-evidence.mjs';
import {TrackRecovery} from './track-recovery.mjs';

const dispose=(...items)=>items.forEach(x=>x?.delete());
const area=p=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1]},0))/2;
function validQuad(p){
  if(p.length!==4||!p.flat().every(x=>Number.isFinite(x)&&x>=0&&x<=1))return false;
  const crosses=p.map((a,i)=>{const b=p[(i+1)%4],c=p[(i+2)%4];return Math.sign((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]))});
  return crosses.every(s=>s===crosses[0]&&s!==0)&&area(p)>.003;
}
function smoothQuad(previous,next){
  if(!previous)return next;
  const xs=next.map(p=>p[0]),ys=next.map(p=>p[1]);
  const size=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const shift=Math.max(...next.map(([x,y],i)=>Math.hypot(x-previous[i][0],y-previous[i][1])));
  if(shift>size*.18)return next;
  const mixed=next.map(([x,y],i)=>[(x+previous[i][0])/2,(y+previous[i][1])/2]);
  return validQuad(mixed)?mixed:next;
}
function boundsOf(corners){
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
}
function consistentSize(previous,next){
  const a=boundsOf(previous),b=boundsOf(next);
  const w=a.right-a.left,h=a.bottom-a.top,nw=b.right-b.left,nh=b.bottom-b.top;
  const x=Math.abs((a.left+a.right-b.left-b.right)/2);
  const y=Math.abs((a.top+a.bottom-b.top-b.bottom)/2);
  return x>w*.6||y>h*.6||(nw/w>=.72&&nw/w<=1.38&&nh/h>=.72&&nh/h<=1.38);
}
function stillScene(previous,gray){
  const a=previous.data,b=gray.data;
  let total=0,count=0;
  for(let y=8;y<gray.rows;y+=16)for(let x=8;x<gray.cols;x+=16){
    const i=y*gray.cols+x;
    total+=Math.abs(a[i]-b[i]);count++;
  }
  return count>0&&total/count<9;
}

// Short-lived optical flow bridges full feature matches. It cannot establish identity.
class FlowTrack {
  constructor(cv,gray,corners,small=false){
    this.cv=cv;this.corners=corners;this.points=null;this.small=small;this.seed(gray);
  }
  seed(gray){
    const cv=this.cv,mask=cv.Mat.zeros(gray.rows,gray.cols,cv.CV_8UC1),poly=cv.matFromArray(4,1,cv.CV_32SC2,this.corners.flatMap(([x,y])=>[Math.round(x*gray.cols),Math.round(y*gray.rows)]));
    const points=new cv.Mat();
    try{cv.fillConvexPoly(mask,poly,new cv.Scalar(255));cv.goodFeaturesToTrack(gray,points,100,.015,6,mask,3,false,.04);this.points?.delete();this.points=points}catch(e){points.delete();throw e}finally{dispose(mask,poly)}
  }
  update(previous,gray){
    const minPoints=this.small?8:10;
    if(!this.points||this.points.rows<minPoints)return false;
    const cv=this.cv,next=new cv.Mat(),back=new cv.Mat(),status=new cv.Mat(),reverse=new cv.Mat(),err=new cv.Mat(),backErr=new cv.Mat();let src,dst,H,inlierMask,input,output;
    try{
      const win=new cv.Size(21,21),criteria=new cv.TermCriteria(cv.TermCriteria_COUNT|cv.TermCriteria_EPS,20,.03);
      cv.calcOpticalFlowPyrLK(previous,gray,this.points,next,status,err,win,3,criteria);
      cv.calcOpticalFlowPyrLK(gray,previous,next,back,reverse,backErr,win,3,criteria);
      const a=[],b=[];
      for(let i=0;i<this.points.rows;i++)if(status.data[i]&&reverse.data[i]&&err.data32F[i]<35){const x=this.points.data32F[2*i],y=this.points.data32F[2*i+1];if(Math.hypot(x-back.data32F[2*i],y-back.data32F[2*i+1])<1.5){a.push(x,y);b.push(next.data32F[2*i],next.data32F[2*i+1])}}
      if(a.length<(this.small?9:20)||a.length/2<this.points.rows*.45)return false;
      if(this.small){
        // A region proposal has no reference homography. A robust translation
        // keeps its rectangle from warping between appearance confirmations.
        const offsets=[];
        for(let i=0;i<a.length;i+=2)offsets.push([b[i]-a[i],b[i+1]-a[i+1]]);
        const median=axis=>offsets.map(p=>p[axis]).sort((u,v)=>u-v)[offsets.length>>1];
        const dx=median(0),dy=median(1);
        if(offsets.filter(([x,y])=>Math.hypot(x-dx,y-dy)<=3).length<Math.max(8,offsets.length*.65))return false;
        const p=this.corners.map(([x,y])=>[x+dx/gray.cols,y+dy/gray.rows]);
        if(!validQuad(p)||Math.hypot(dx/gray.cols,dy/gray.rows)>.14)return false;
        this.corners=p;this.seed(gray);return this.points.rows>=minPoints;
      }
      src=cv.matFromArray(a.length/2,1,cv.CV_32FC2,a);dst=cv.matFromArray(b.length/2,1,cv.CV_32FC2,b);inlierMask=new cv.Mat();H=cv.findHomography(src,dst,cv.RANSAC,3,inlierMask);
      if(H.empty()||cv.countNonZero(inlierMask)<minPoints||cv.countNonZero(inlierMask)/(a.length/2)<.65)return false;
      input=cv.matFromArray(4,1,cv.CV_32FC2,this.corners.flatMap(([x,y])=>[x*gray.cols,y*gray.rows]));output=new cv.Mat();cv.perspectiveTransform(input,output,H);
      const p=Array.from({length:4},(_,i)=>[output.data32F[i*2]/gray.cols,output.data32F[i*2+1]/gray.rows]);
      const ratio=area(p)/area(this.corners);
      if(!validQuad(p)||ratio<.65||ratio>1.5||p.some((q,i)=>Math.hypot(q[0]-this.corners[i][0],q[1]-this.corners[i][1])>.14))return false;
      this.corners=p;this.seed(gray);return this.points.rows>=minPoints;
    }finally{dispose(next,back,status,reverse,err,backErr,src,dst,H,inlierMask,input,output)}
  }
  close(){this.points?.delete();this.points=null}
}

export class VisionEngine {
  constructor(cv){this.cv=cv;this.matcher=new Matcher(cv);this.canvas=new OffscreenCanvas(1,1);this.ctx=this.canvas.getContext('2d',{willReadFrequently:true});this.tracks=new Map();this.regionEvidence=new RegionEvidence();this.pendingFlows=new Map();this.reset()}
  reset(){this.previous?.delete();this.previous=null;for(const t of this.tracks.values())t.flow.close();this.tracks.clear();this.regionEvidence.clear();for(const flow of this.pendingFlows.values())flow.close();this.pendingFlows.clear();this.capture?.close();this.capture=null;this.signatures=[];this.lastSample=-Infinity;this.lastDetect=-Infinity;this.tile=0;this.photoScan=0;this.lastPhotoFirst=-Infinity;this.deferAppearance=false;this.captureId=null;this.lost=false;this.previousAt=0}

  detectScene(pixels,scanTile,at){
    this.deferAppearance=false;
    const best=new Map(),photoIds=new Set(this.matcher.refs.filter(ref=>ref.photoOnly).map(ref=>ref.id));
    const standardIds=new Set(this.matcher.refs.filter(ref=>!ref.photoOnly).map(ref=>ref.id));
    const width=Math.ceil(pixels.width*.64),height=Math.ceil(pixels.height*.64);
    const tile=this.tile,x=tile%2?pixels.width-width:0,y=tile>=2?pixels.height-height:0;
    const tilePixels=scanTile?this.ctx.getImageData(x,y,width,height):null;
    if(scanTile)this.tile=(this.tile+1)%4;
    const accept=(found,fromTile=false)=>{for(const match of found){
      const corners=fromTile?match.corners.map(([u,v])=>[(x+u*width)/pixels.width,(y+v*height)/pixels.height]):match.corners;
      if(validQuad(corners)&&(!best.has(match.id)||match.inliers>best.get(match.id).inliers))best.set(match.id,{...match,corners});
    }};
    if(photoIds.size){
      const full=!scanTile||this.photoScan++%5===4;
      accept(this.matcher.detect(full?pixels:tilePixels,{targetIds:photoIds}),!full);
      // Publish a newly identified photo before unrelated object searches.
      // Existing tracks are still updated, and the next scan includes all
      // standard targets. Never defer background work continuously.
      if(scanTile&&at-this.lastPhotoFirst>=1000&&[...best.values()].some(d=>!this.tracks.has(d.id)||this.tracks.get(d.id).held)){
        this.lastPhotoFirst=at;this.deferAppearance=true;return [...best.values()];
      }
    }
    if(standardIds.size){
      accept(this.matcher.detect(pixels,{targetIds:standardIds,photoSearch:false}));
      if(scanTile)accept(this.matcher.detect(tilePixels,{targetIds:standardIds,photoSearch:false}),true);
    }
    return [...best.values()];
  }

  async process(bitmap,o={},confirmAppearance){
    this.deferAppearance=false;
    const began=performance.now(),cv=this.cv;this.canvas.width=bitmap.width;this.canvas.height=bitmap.height;this.ctx.drawImage(bitmap,0,0);bitmap.close();
    const pixels=this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height),rgba=cv.matFromImageData(pixels),gray=new cv.Mat();cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);rgba.delete();
    try{
      const incompatible=!this.previous||gray.rows!==this.previous.rows||gray.cols!==this.previous.cols;
      const intervalMs=o.at-this.previousAt;
      const gap=incompatible||intervalMs<=0||intervalMs>1500;
      let result;
      if(o.mode==='capture')result=await this.collect(gray,o,incompatible||intervalMs<=0||intervalMs>600);
      else{
        const steady=!gap&&stillScene(this.previous,gray);
        if(!this.previous||gray.rows!==this.previous.rows||gray.cols!==this.previous.cols||o.at-this.previousAt>1500){
          this.regionEvidence.clear();
        }
        this.regionEvidence.prune(o.at);
        for(const [id,flow] of this.pendingFlows){
          const candidate=this.regionEvidence.pending.get(id);
          if(candidate&&!gap&&flow.update(this.previous,gray)){
            candidate.corners=flow.corners;
          }else{
            flow.close();
            this.pendingFlows.delete(id);
            if(!steady)this.regionEvidence.pending.delete(id);
          }
        }
        let dropped=false;
        for(const [id,t] of this.tracks){
          const identityAge=o.at-t.identified;
          if(gap||identityAge>5000){t.flow.close();this.tracks.delete(id);dropped=true;continue}
          if(!t.held&&t.flow.update(this.previous,gray)){
            t.corners=smoothQuad(t.corners,t.flow.corners);
            t.observed=o.at;
          }else{
            t.held=true;
            t.recoveryCorners=t.recovery.locate(gray,t.corners);
            // Keep the identity briefly for re-acquisition. Visibility expires
            // separately, so a lost box is not drawn indefinitely.
            if(o.at-t.observed>2500){
              t.flow.close();this.tracks.delete(id);dropped=true;
            }
          }
        }
        const recovering=dropped||[...this.tracks.values()].some(t=>t.held||o.at-t.identified>1800);
        const interval=this.pendingFlows.size?300:recovering?350:this.tracks.size?650:450;
        if(o.at-this.lastDetect>=interval||o.mode==='verify'){
          const found=this.detectScene(pixels,o.mode==='recognize',o.at);
          this.lastDetect=o.at;
          const confirmed=await confirmAppearance?.(this.canvas,found);
          for(const d of [...found,...(confirmed?.located??[])]){
            if(confirmed?.required.has(d.id)&&!confirmed.passed.has(d.id))continue;
            const previous=this.tracks.get(d.id);
            if(d.region&&!validQuad(d.corners))continue;
            this.pendingFlows.get(d.id)?.close();
            this.pendingFlows.delete(d.id);
            if(d.region&&!this.regionEvidence.confirm(d.id,d.corners,o.at,
              previous&&!previous.held?previous.corners:null,!previous&&d.strong===true)){
              this.pendingFlows.set(d.id,new FlowTrack(cv,gray,d.corners,true));
              continue;
            }
            this.regionEvidence.pending.delete(d.id);
            if(d.region&&previous&&steady&&!consistentSize(previous.corners,d.corners)){
              if(!previous.resizeCandidate||!consistentSize(previous.resizeCandidate,d.corners)){
                previous.resizeCandidate=d.corners;
                continue;
              }
            }
            const flow=new FlowTrack(cv,gray,d.corners,d.region===true);
            const continuing=previous&&o.at-previous.observed<=2500&&regionOverlap(previous.corners,d.corners)>=.25;
            previous?.flow.close();
            this.tracks.set(d.id,{flow,corners:smoothQuad(previous?.corners,d.corners),observed:o.at,identified:o.at,
              trackId:continuing?previous.trackId:crypto.randomUUID(),
              recovery:continuing&&!d.strong&&d.region?previous.recovery:new TrackRecovery(gray,d.corners),recoveryCorners:null,
              held:false,inliers:d.inliers,appearanceConfirmed:confirmed?.passed.has(d.id)===true});
          }
        }
        result={sceneStable:steady,found:[...this.tracks]
          .filter(([,t])=>!t.held||o.at-t.observed<=(steady?1200:350))
          .map(([id,t])=>{
          const held=t.held||o.at-t.identified>1800;
          return {id,trackId:t.trackId,corners:t.corners,inliers:t.inliers,matchedAt:t.identified,held,
            tracked:t.identified!==o.at,appearanceConfirmed:t.appearanceConfirmed,
            seed:held?null:trackingSeed(cv,gray,t.corners)};
        })};
      }
      this.previous?.delete();this.previous=gray.clone();this.previousAt=o.at;
      return {...result,ms:performance.now()-began};
    }finally{gray.delete()}
  }
  async collect(gray,o,gap){
    const cv=this.cv;
    if(this.captureId!==o.session){this.capture?.close();this.capture=null;this.captureId=o.session;this.signatures=[];this.lastSample=-Infinity;this.lost=false}
    if(o.seed){const r=o.roi;this.capture?.close();this.capture=new FlowTrack(cv,gray,[[r.cx-r.width/2,r.cy-r.height/2],[r.cx+r.width/2,r.cy-r.height/2],[r.cx+r.width/2,r.cy+r.height/2],[r.cx-r.width/2,r.cy+r.height/2]]);this.lost=this.capture.points.rows<10}
    else if(!this.lost&&this.capture&&(gap||!this.capture.update(this.previous,gray)))this.lost=true;
    if(this.lost||!this.capture)return {lost:true,note:'추적이 끊겼습니다. 물체를 테두리에 맞추고 다시 잡기를 누르세요.'};
    const corners=this.capture.corners;
    if(o.at-this.lastSample<650)return {corners};this.lastSample=o.at;
    const x=Math.floor(Math.min(...corners.map(p=>p[0]))*gray.cols),y=Math.floor(Math.min(...corners.map(p=>p[1]))*gray.rows);
    const w=Math.min(gray.cols-x,Math.ceil(Math.max(...corners.map(p=>p[0]))*gray.cols)-x),h=Math.min(gray.rows-y,Math.ceil(Math.max(...corners.map(p=>p[1]))*gray.rows)-y);
    if(w<80||h<60)return {corners,note:'물체가 작습니다. 더 가까이 보세요.'};
    const crop=gray.roi(new cv.Rect(x,y,w,h)),lap=new cv.Mat(),mean=new cv.Mat(),sd=new cv.Mat(),small=new cv.Mat(),kp=new cv.KeyPointVector(),des=new cv.Mat(),mask=new cv.Mat();
    try{
      cv.Laplacian(crop,lap,cv.CV_64F);cv.meanStdDev(lap,mean,sd);const sharpness=sd.data64F[0]**2;
      this.matcher.orb.detectAndCompute(crop,mask,kp,des);const features=des.rows;
      if(sharpness<45||features<20)return {corners,note:sharpness<45?'흔들립니다. 잠깐 멈춰 주세요.':'특징이 부족합니다. 로고나 무늬가 크게 보이게 해 주세요.',quality:{sharpness,features}};
      cv.resize(crop,small,new cv.Size(32,32));const signature=Array.from(small.data),average=signature.reduce((n,v)=>n+v,0)/signature.length;
      const centered=signature.map(v=>v-average);
      if(this.signatures.some(s=>s.reduce((n,v,i)=>n+Math.abs(v-centered[i]),0)/s.length<10))return {corners,note:'비슷한 장면입니다. 물체를 조금 다른 각도로 보세요.'};
      const scale=Math.min(1,640/Math.max(w,h)),out=new OffscreenCanvas(Math.round(w*scale),Math.round(h*scale));out.getContext('2d').drawImage(this.canvas,x,y,w,h,0,0,out.width,out.height);
      const blob=await out.convertToBlob({type:'image/jpeg',quality:.86}),bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      this.signatures.push(centered);
      return {corners,sample:{image:'data:image/jpeg;base64,'+btoa(binary),capture:{source:'video',atMs:o.elapsed,sharpness,features}},note:'좋습니다. 정면 → 왼쪽 → 오른쪽 → 조금 멀리 순서로 보세요.'};
    }finally{dispose(crop,lap,mean,sd,small,kp,des,mask)}
  }
}
