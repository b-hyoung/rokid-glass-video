// Homography fitting can place a frame-filling reference a fraction of a pixel
// outside the raster. Clip only bounded fitting error, never an off-screen object.
export function clipFrameQuad(points,width,height){
  if(!Array.isArray(points)||points.length!==4||width<=0||height<=0)return null;
  // The .45-scale reference bank quantizes fitted corners by about 2.2px.
  const xTolerance=3/width,yTolerance=3/height;
  if(!points.every(p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[0]>=-xTolerance&&p[0]<=1+xTolerance&&p[1]>=-yTolerance&&p[1]<=1+yTolerance))return null;
  return points.map(([x,y])=>[Math.max(0,Math.min(1,x)),Math.max(0,Math.min(1,y))]);
}
