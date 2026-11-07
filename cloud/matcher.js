export class Matcher {
  constructor(cv){this.cv=cv;this.orb=new cv.ORB();this.bf=new cv.BFMatcher(cv.NORM_HAMMING,false);this.refs=[];}
  async references(targets){
    const next=[];
    try {
      for(const t of targets){
        const images=t.images ?? (t.image?[{id:t.id,image:t.image}]:[]);
        for(const ref of images){
          const bitmap=await createImageBitmap(await (await fetch(ref.image)).blob());
          const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);bitmap.close();
          const mat=this.cv.matFromImageData(context.getImageData(0,0,canvas.width,canvas.height)),g=new this.cv.Mat(),kp=new this.cv.KeyPointVector(),des=new this.cv.Mat(),mask=new this.cv.Mat();
          try {
            this.cv.cvtColor(mat,g,this.cv.COLOR_RGBA2GRAY);this.orb.detectAndCompute(g,mask,kp,des);
            next.push({id:t.id,referenceId:ref.id,w:mat.cols,h:mat.rows,kp,des});
          } catch(e){kp.delete();des.delete();throw e}
          finally{mat.delete();g.delete();mask.delete()}
        }
      }
    } catch(e){for(const ref of next){ref.kp.delete();ref.des.delete()}throw e}
    for(const ref of this.refs){ref.kp.delete();ref.des.delete()}this.refs=next;
  }
  detect(canvas){const cv=this.cv,m=cv.matFromImageData(canvas.getContext?canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height):canvas),g=new cv.Mat(),kp=new cv.KeyPointVector(),des=new cv.Mat(),empty=new cv.Mat(),out=[];try{cv.cvtColor(m,g,cv.COLOR_RGBA2GRAY);this.orb.detectAndCompute(g,empty,kp,des);if(des.rows<12)return out;
    for(const t of this.refs){if(t.des.rows<12)continue;const pairs=new cv.DMatchVectorVector();let src,dst,H,mask,corners,warped;try{this.bf.knnMatch(t.des,des,pairs,2);const a=[],b=[];for(let i=0;i<pairs.size();i++){const row=pairs.get(i);if(row.size()>=2){const x=row.get(0),y=row.get(1);if(x.distance<.72*y.distance){const p=t.kp.get(x.queryIdx).pt,q=kp.get(x.trainIdx).pt;a.push(p.x,p.y);b.push(q.x,q.y)}}row.delete()}if(a.length<24)continue;src=cv.matFromArray(a.length/2,1,cv.CV_32FC2,a);dst=cv.matFromArray(b.length/2,1,cv.CV_32FC2,b);mask=new cv.Mat();H=cv.findHomography(src,dst,cv.RANSAC,4,mask);const inliers=cv.countNonZero(mask);if(H.empty()||inliers<10||inliers/(a.length/2)<.45)continue;corners=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,t.w,0,t.w,t.h,0,t.h]);warped=new cv.Mat();cv.perspectiveTransform(corners,warped,H);const p=[];for(let i=0;i<8;i+=2)p.push([warped.data32F[i]/canvas.width,warped.data32F[i+1]/canvas.height]);if(!p.flat().every(x=>Number.isFinite(x)&&x>=-.5&&x<=1.5))continue;let area=0,sign=0,convex=true;for(let i=0;i<4;i++){const a=p[i],b=p[(i+1)%4],c=p[(i+2)%4];area+=a[0]*b[1]-b[0]*a[1];const s=Math.sign((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]));if(sign&&s!==sign)convex=false;sign=s}if(!convex||Math.abs(area)/2<.003||Math.abs(area)/2>1.5)continue;out.push({id:t.id,corners:p,inliers})}finally{pairs.delete();for(const x of [src,dst,H,mask,corners,warped])if(x)x.delete()}}
    const best=new Map();for(const result of out){if(!best.has(result.id)||best.get(result.id).inliers<result.inliers)best.set(result.id,result)}
    return [...best.values()];}finally{for(const x of [m,g,kp,des,empty])x.delete()}}
}
