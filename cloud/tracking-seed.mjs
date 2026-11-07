// Small appearance patches let the glasses verify a delayed web result against
// their current camera image, instead of drawing old coordinates as if current.
export function validSeed(seed) {
  if(!seed||seed.w!==180||!Number.isInteger(seed.h)||seed.h<180||seed.h>320||!Array.isArray(seed.points)||seed.points.length<4||seed.points.length>12)return null;
  if(!seed.points.every(p=>p&&Number.isInteger(p.x)&&Number.isInteger(p.y)&&p.x>=3&&p.y>=3&&p.x<seed.w-3&&p.y<seed.h-3&&typeof p.patch==='string'&&/^[A-Za-z0-9+/]{66}==$/.test(p.patch)))return null;
  return {w:seed.w,h:seed.h,points:seed.points.map(({x,y,patch})=>({x,y,patch}))};
}

export function trackingSeed(cv,gray,corners) {
  const w=180,h=Math.round(gray.rows*w/gray.cols);
  if(h<180||h>320)return null;
  const small=new cv.Mat(),mask=cv.Mat.zeros(h,w,cv.CV_8UC1),poly=cv.matFromArray(4,1,cv.CV_32SC2,corners.flatMap(([x,y])=>[Math.round(x*w),Math.round(y*h)])),features=new cv.Mat();
  try {
    cv.resize(gray,small,new cv.Size(w,h),0,0,cv.INTER_AREA);
    cv.fillConvexPoly(mask,poly,new cv.Scalar(255));
    cv.goodFeaturesToTrack(small,features,12,.025,10,mask,3,false,.04);
    const points=[];
    for(let i=0;i<features.rows;i++){
      const x=Math.round(features.data32F[2*i]),y=Math.round(features.data32F[2*i+1]);
      if(x<3||y<3||x>=w-3||y>=h-3)continue;
      let bytes='';for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)bytes+=String.fromCharCode(small.data[(y+dy)*w+x+dx]);
      points.push({x,y,patch:btoa(bytes)});
    }
    return points.length>=4?{w,h,points}:null;
  }finally{small.delete();mask.delete();poly.delete();features.delete()}
}
