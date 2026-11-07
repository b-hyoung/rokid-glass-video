import {trackingSeed} from './tracking-seed.mjs';
import {Matcher} from './matcher.js';

const dispose=(...items)=>items.forEach(x=>x?.delete());
const area=p=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1]},0))/2;
function validQuad(p){
  if(p.length!==4||!p.flat().every(x=>Number.isFinite(x)&&x>=0&&x<=1))return false;
  const crosses=p.map((a,i)=>{const b=p[(i+1)%4],c=p[(i+2)%4];return Math.sign((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]))});
  return crosses.every(s=>s===crosses[0]&&s!==0)&&area(p)>.003;
}

// Short-lived optical flow bridges full feature matches. It cannot establish identity.
class FlowTrack {
  constructor(cv,gray,corners){this.cv=cv;this.corners=corners;this.points=null;this.seed(gray)}
  seed(gray){
    const cv=this.cv,mask=cv.Mat.zeros(gray.rows,gray.cols,cv.CV_8UC1),poly=cv.matFromArray(4,1,cv.CV_32SC2,this.corners.flatMap(([x,y])=>[Math.round(x*gray.cols),Math.round(y*gray.rows)]));
    const points=new cv.Mat();
    try{cv.fillConvexPoly(mask,poly,new cv.Scalar(255));cv.goodFeaturesToTrack(gray,points,100,.015,6,mask,3,false,.04);this.points?.delete();this.points=points}catch(e){points.delete();throw e}finally{dispose(mask,poly)}
  }
  update(previous,gray){
    if(!this.points||this.points.rows<10)return false;
    const cv=this.cv,next=new cv.Mat(),back=new cv.Mat(),status=new cv.Mat(),reverse=new cv.Mat(),err=new cv.Mat(),backErr=new cv.Mat();let src,dst,H,inlierMask,input,output;
    try{
      const win=new cv.Size(21,21),criteria=new cv.TermCriteria(cv.TermCriteria_COUNT|cv.TermCriteria_EPS,20,.03);
      cv.calcOpticalFlowPyrLK(previous,gray,this.points,next,status,err,win,3,criteria);
      cv.calcOpticalFlowPyrLK(gray,previous,next,back,reverse,backErr,win,3,criteria);
      const a=[],b=[];
      for(let i=0;i<this.points.rows;i++)if(status.data[i]&&reverse.data[i]&&err.data32F[i]<35){const x=this.points.data32F[2*i],y=this.points.data32F[2*i+1];if(Math.hypot(x-back.data32F[2*i],y-back.data32F[2*i+1])<1.5){a.push(x,y);b.push(next.data32F[2*i],next.data32F[2*i+1])}}
      if(a.length<20||a.length/2<this.points.rows*.45)return false;
      src=cv.matFromArray(a.length/2,1,cv.CV_32FC2,a);dst=cv.matFromArray(b.length/2,1,cv.CV_32FC2,b);inlierMask=new cv.Mat();H=cv.findHomography(src,dst,cv.RANSAC,3,inlierMask);
      if(H.empty()||cv.countNonZero(inlierMask)<10||cv.countNonZero(inlierMask)/(a.length/2)<.65)return false;
      input=cv.matFromArray(4,1,cv.CV_32FC2,this.corners.flatMap(([x,y])=>[x*gray.cols,y*gray.rows]));output=new cv.Mat();cv.perspectiveTransform(input,output,H);
      const p=Array.from({length:4},(_,i)=>[output.data32F[i*2]/gray.cols,output.data32F[i*2+1]/gray.rows]);
      const ratio=area(p)/area(this.corners);
      if(!validQuad(p)||ratio<.65||ratio>1.5||p.some((q,i)=>Math.hypot(q[0]-this.corners[i][0],q[1]-this.corners[i][1])>.14))return false;
      this.corners=p;this.seed(gray);return this.points.rows>=10;
    }finally{dispose(next,back,status,reverse,err,backErr,src,dst,H,inlierMask,input,output)}
  }
  close(){this.points?.delete();this.points=null}
}

export class VisionEngine {
  constructor(cv){this.cv=cv;this.matcher=new Matcher(cv);this.canvas=new OffscreenCanvas(1,1);this.ctx=this.canvas.getContext('2d',{willReadFrequently:true});this.tracks=new Map();this.reset()}
  reset(){this.previous?.delete();this.previous=null;for(const t of this.tracks.values())t.flow.close();this.tracks.clear();this.capture?.close();this.capture=null;this.signatures=[];this.lastSample=-Infinity;this.lastDetect=-Infinity;this.captureId=null;this.lost=false;this.previousAt=0}
  async process(bitmap,o={}){
    const began=performance.now(),cv=this.cv;this.canvas.width=bitmap.width;this.canvas.height=bitmap.height;this.ctx.drawImage(bitmap,0,0);bitmap.close();
    const pixels=this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height),rgba=cv.matFromImageData(pixels),gray=new cv.Mat();cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);rgba.delete();
    try{
      const gap=!this.previous||gray.rows!==this.previous.rows||gray.cols!==this.previous.cols||o.at-this.previousAt>600;
      let result;
      if(o.mode==='capture')result=await this.collect(gray,o,gap);
      else{
        for(const [id,t] of this.tracks){if(gap||o.at-t.identified>1800||!t.flow.update(this.previous,gray)){t.flow.close();this.tracks.delete(id)}}
        if(o.at-this.lastDetect>=700||o.mode==='verify'){
          const found=this.matcher.detect(pixels);this.lastDetect=o.at;
          for(const d of found){if(!validQuad(d.corners))continue;this.tracks.get(d.id)?.flow.close();this.tracks.set(d.id,{flow:new FlowTrack(cv,gray,d.corners),identified:o.at,inliers:d.inliers})}
        }
        result={found:[...this.tracks].map(([id,t])=>({id,corners:t.flow.corners,inliers:t.inliers,matchedAt:t.identified,tracked:t.identified!==o.at,seed:trackingSeed(cv,gray,t.flow.corners)}))};
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
