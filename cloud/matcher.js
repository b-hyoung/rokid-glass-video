export class Matcher {
  constructor(cv){
    this.cv=cv;this.orb=new cv.ORB();this.photoOrb=new cv.ORB(1800);
    this.bf=new cv.BFMatcher(cv.NORM_HAMMING,false);this.refs=[];this.hasPhotos=false;this.preferredRefs=new Map();
  }
  async references(targets){
    const cv=this.cv,next=[];
    try{
      for(const target of targets){
        const images=target.images??(target.image?[{id:target.id,image:target.image}]:[]);
        const photoOnly=!target.appearance&&images.some(image=>image.capture?.source==='photo');
        // Bound the additional scale bank even for targets with 60 saved views.
        const extraViews=new Set(Array.from({length:Math.min(4,images.length)},(_,i)=>Math.round(i*(images.length-1)/Math.max(1,Math.min(4,images.length)-1))));
        for(const [index,ref] of images.entries()){
          const bitmap=await createImageBitmap(await(await fetch(ref.image)).blob());
          try{
            for(const scale of photoOnly&&extraViews.has(index)?[.45,.65,1]:[1]){
              const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
              const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0,canvas.width,canvas.height);
              const rgba=cv.matFromImageData(context.getImageData(0,0,canvas.width,canvas.height)),gray=new cv.Mat(),kp=new cv.KeyPointVector(),des=new cv.Mat(),mask=new cv.Mat();
              try{
                cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);(photoOnly?this.photoOrb:this.orb).detectAndCompute(gray,mask,kp,des);
                const points=[];for(let i=0;i<kp.size();i++){const p=kp.get(i).pt;points.push(p.x,p.y)}
                next.push({id:target.id,referenceId:ref.id,w:canvas.width,h:canvas.height,kp,des,photoOnly,support:featureBounds(points,canvas.width,canvas.height)});
              }catch(error){kp.delete();des.delete();throw error}
              finally{rgba.delete();gray.delete();mask.delete()}
            }
          }finally{bitmap.close()}
        }
      }
    }catch(error){for(const ref of next){ref.kp.delete();ref.des.delete()}throw error}
    for(const ref of this.refs){ref.kp.delete();ref.des.delete()}
    this.refs=next;this.hasPhotos=next.some(ref=>ref.photoOnly);this.preferredRefs.clear();
  }
  detect(canvas,{targetIds,photoSearch=true}={}){
    const cv=this.cv,pixels=canvas.getContext?canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height):canvas;
    const rgba=cv.matFromImageData(pixels),gray=new cv.Mat(),kp=new cv.KeyPointVector(),des=new cv.Mat(),photoKp=new cv.KeyPointVector(),photoDes=new cv.Mat(),empty=new cv.Mat(),best=new Map();
    try{
      cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);
      const selected=this.refs.filter(ref=>(!ref.photoOnly||photoSearch)&&(!targetIds||targetIds.has(ref.id)));
      if(selected.some(ref=>!ref.photoOnly))this.orb.detectAndCompute(gray,empty,kp,des);
      if(selected.some(ref=>ref.photoOnly))this.photoOrb.detectAndCompute(gray,empty,photoKp,photoDes);
      const preferred=new Set(this.preferredRefs.values());
      const ordered=[...selected.filter(ref=>preferred.has(ref)),...selected.filter(ref=>!preferred.has(ref))];
      for(const ref of ordered){
        if(ref.des.rows<12||ref.photoOnly&&!photoSearch||targetIds&&!targetIds.has(ref.id))continue;
        const sceneKp=ref.photoOnly?photoKp:kp,sceneDes=ref.photoOnly?photoDes:des;
        if(sceneDes.rows<12)continue;
        if((best.get(ref.id)?.inliers||0)>=(ref.photoOnly?10:30))continue;
        const pairs=new cv.DMatchVectorVector(),allocated=[];
        try{
          this.bf.knnMatch(ref.des,sceneDes,pairs,2);
          // Repeated letters must not count the same scene point many times.
          const unique=new Map();
          for(let i=0;i<pairs.size();i++){
            const row=pairs.get(i);
            try{if(row.size()>=2){const a=row.get(0),b=row.get(1);if(a.distance<.72*b.distance&&(!unique.has(a.trainIdx)||unique.get(a.trainIdx).distance>a.distance))unique.set(a.trainIdx,{queryIdx:a.queryIdx,trainIdx:a.trainIdx,distance:a.distance})}}
            finally{row.delete()}
          }
          if(unique.size<12)continue;
          const a=[],b=[];
          for(const match of unique.values()){const p=ref.kp.get(match.queryIdx).pt,q=sceneKp.get(match.trainIdx).pt;a.push(p.x,p.y);b.push(q.x,q.y)}
          const src=cv.matFromArray(a.length/2,1,cv.CV_32FC2,a),dst=cv.matFromArray(b.length/2,1,cv.CV_32FC2,b),mask=new cv.Mat();allocated.push(src,dst,mask);
          const H=cv.findHomography(src,dst,cv.RANSAC,4,mask);allocated.push(H);
          const inliers=cv.countNonZero(mask);
          if(H.empty()||inliers<10||inliers/(a.length/2)<.45)continue;
          // Blank margins must neither require nonexistent matches nor create support.
          const [left,top,right,bottom]=ref.support;
          const vertices=[0,0,ref.w,0,ref.w,ref.h,0,ref.h,left,top,right,top,right,bottom,left,bottom];
          const corners=cv.matFromArray(8,1,cv.CV_32FC2,vertices),warped=new cv.Mat();allocated.push(corners,warped);
          cv.perspectiveTransform(corners,warped,H);
          let projected=warped.data32F;
          // Extrapolating perspective from a small title makes distant blank
          // corners wobble. Prefer a supported affine fit when it explains all
          // inliers; keep perspective for genuinely tilted photographs.
          if(ref.photoOnly&&(right-left)*(bottom-top)<ref.w*ref.h*.3)projected=affineProjection(a,b,mask.data,vertices)??projected;
          const normalize=(n,size)=>Math.abs(n/size)<1e-6?0:Math.abs(n/size-1)<1e-6?1:n/size;
          const p=Array.from({length:4},(_,i)=>[normalize(projected[2*i],pixels.width),normalize(projected[2*i+1],pixels.height)]);
          if(!validMatchQuad(p))continue;
          const support=Array.from({length:4},(_,i)=>[projected[8+2*i]/pixels.width,projected[9+2*i]/pixels.height]);
          if(!supportsBounds(support,b,mask.data,pixels.width,pixels.height))continue;
          // A tiny word patch must also cover the reference feature footprint.
          const referenceSupport=[[left/ref.w,top/ref.h],[right/ref.w,top/ref.h],[right/ref.w,bottom/ref.h],[left/ref.w,bottom/ref.h]];
          if(!supportsBounds(referenceSupport,a,mask.data,ref.w,ref.h))continue;
          if(!best.has(ref.id)||best.get(ref.id).inliers<inliers){best.set(ref.id,{id:ref.id,corners:p,inliers});if(ref.photoOnly)this.preferredRefs.set(ref.id,ref)}
        }finally{pairs.delete();for(const item of allocated)item.delete()}
      }
      return [...best.values()];
    }finally{rgba.delete();gray.delete();kp.delete();des.delete();photoKp.delete();photoDes.delete();empty.delete()}
  }
}

export function featureBounds(points,width,height){
  if(points.length<24)return [0,0,width,height];
  const xs=[],ys=[];for(let i=0;i<points.length;i+=2){xs.push(points[i]);ys.push(points[i+1])}
  xs.sort((a,b)=>a-b);ys.sort((a,b)=>a-b);
  const low=Math.floor(xs.length*.02),high=Math.min(xs.length-1,Math.ceil(xs.length*.98)-1);
  return [xs[low],ys[low],xs[high],ys[high]];
}

export function affineProjection(source,target,mask,vertices){
  const points=[];for(let i=0;i<mask.length;i++)if(mask[i])points.push([source[i*2],source[i*2+1],target[i*2],target[i*2+1]]);
  if(points.length<10)return null;
  const mean=[0,0,0,0];for(const p of points)for(let j=0;j<4;j++)mean[j]+=p[j]/points.length;
  let xx=0,xy=0,yy=0,xu=0,yu=0,xv=0,yv=0;
  for(const p of points){const x=p[0]-mean[0],y=p[1]-mean[1],u=p[2]-mean[2],v=p[3]-mean[3];xx+=x*x;xy+=x*y;yy+=y*y;xu+=x*u;yu+=y*u;xv+=x*v;yv+=y*v}
  const determinant=xx*yy-xy*xy;
  if(determinant<=Math.max(1e-6,xx*yy*.001))return null;
  const a=(xu*yy-yu*xy)/determinant,b=(yu*xx-xu*xy)/determinant,c=(xv*yy-yv*xy)/determinant,d=(yv*xx-xv*xy)/determinant;
  const apply=(x,y)=>[mean[2]+a*(x-mean[0])+b*(y-mean[1]),mean[3]+c*(x-mean[0])+d*(y-mean[1])];
  let error=0;for(const p of points){const q=apply(p[0],p[1]),e=Math.hypot(q[0]-p[2],q[1]-p[3]);if(e>6)return null;error+=e*e}
  if(error/points.length>9)return null;
  const result=[];for(let i=0;i<vertices.length;i+=2)result.push(...apply(vertices[i],vertices[i+1]));
  return result.every(Number.isFinite)?result:null;
}

function validMatchQuad(p){
  if(!p.flat().every(n=>Number.isFinite(n)&&n>=-.5&&n<=1.5))return false;
  let area=0,sign=0;
  for(let i=0;i<4;i++){
    const a=p[i],b=p[(i+1)%4],c=p[(i+2)%4];area+=a[0]*b[1]-b[0]*a[1];
    const turn=Math.sign((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]));
    if(!turn||sign&&turn!==sign)return false;sign=turn;
  }
  return Math.abs(area)/2>=.003&&Math.abs(area)/2<=1.5;
}

export function supportsBounds(corners,points,inlierMask,width,height){
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  const left=Math.min(...xs),top=Math.min(...ys),w=Math.max(...xs)-left,h=Math.max(...ys)-top;
  if(!Number.isFinite(w)||!Number.isFinite(h)||w*width<4||h*height<4)return false;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(let i=0;i<points.length/2;i++)if(inlierMask[i]){
    const x=(points[i*2]/width-left)/w,y=(points[i*2+1]/height-top)/h;
    x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
  }
  return x1-x0>=.32&&y1-y0>=.32&&x0<.65&&x1>.35&&y0<.65&&y1>.35;
}
