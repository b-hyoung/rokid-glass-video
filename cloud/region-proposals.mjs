// Locate compact image regions before the appearance model assigns identity.
export function regionProposals({data,width:w,height:h}){
  const size=w*h, gray=new Uint8Array(size), color=new Uint8Array(size);
  for(let i=0;i<size;i++){
    const r=data[4*i],g=data[4*i+1],b=data[4*i+2];
    gray[i]=(77*r+150*g+29*b)>>8;
    color[i]=Math.max(r,g,b)-Math.min(r,g,b);
  }
  const edges=new Uint8Array(size),softEdges=new Uint8Array(size);
  const dark=new Uint8Array(size),saturated=new Uint8Array(size);
  for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
    const i=y*w+x;
    if(gray[i]<82&&color[i]<62)dark[i]=1;
    if(color[i]>64)saturated[i]=1;
    const gradient=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+w]-gray[i-w]);
    if(gradient>=27)softEdges[i]=softEdges[i-1]=softEdges[i+1]=softEdges[i-w]=softEdges[i+w]=1;
    if(gradient<39)continue;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)edges[i+dy*w+dx]=1;
  }
  // Remove thin connections such as straps touching the edge of the frame.
  const opened=mask=>{
    const core=new Uint8Array(size);
    for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
      const i=y*w+x;
      if(mask[i]&&mask[i-1]&&mask[i+1]&&mask[i-w]&&mask[i+w]){
        core[i]=core[i-1]=core[i+1]=core[i-w]=core[i+w]=1;
      }
    }
    return core;
  };
  const core=opened(dark),colored=opened(saturated);
  const edgeEvidence=edges.slice(),queue=new Int32Array(size), proposals=[];
  for(const mask of [core,colored,edges,softEdges])for(let i=0;i<size;i++){
    if(!mask[i])continue;
    let head=0,tail=1,left=w,right=0,top=h,bottom=0;
    queue[0]=i;mask[i]=0;
    while(head<tail){
      const j=queue[head++],x=j%w,y=(j/w)|0;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const k of [j-1,j+1,j-w,j+w])if(mask[k]){mask[k]=0;queue[tail++]=k}
    }
    const width=right-left+1,height=bottom-top+1,area=width*height/size;
    if(width<9||height<7||area<.002||area>.12||width/height>3.5||height/width>3||
        left<=2||top<=2||right>=w-3||bottom>=h-3||tail<width+height)continue;
    const cx=(left+right+1)/(2*w),cy=(top+bottom+1)/(2*h);
    const density=tail/(width*height);
    const solid=mask===core||mask===colored;
    if(density<(solid ? .34 : .18))continue;
    const score=Math.sqrt(area)*(1-.65*Math.hypot(cx-.5,cy-.55))*(solid?1:.82);
    proposals.push({left:left/w,top:top/h,right:(right+1)/w,bottom:(bottom+1)/h,score});
    // A dark component can be one part of a brighter object. Extend the
    // candidate only where adjacent rows still contain edge evidence.
    if((mask===core||mask===colored)&&width>height*1.25){
      const expansion=mask===colored ? .12 : .3;
      const x0=Math.max(3,left-Math.ceil(width*expansion)),x1=Math.min(w-4,right+Math.ceil(width*expansion));
      let last=bottom,gaps=0,extendedLeft=left,extendedRight=right;
      const depth=mask===colored ? .5 : 1.3;
      for(let y=bottom+1;y<=Math.min(h-4,bottom+width*depth);y++){
        let a=x1,b=x0,count=0;
        for(let x=x0;x<=x1;x++)if(edgeEvidence[y*w+x]){a=Math.min(a,x);b=Math.max(b,x);count++}
        if(count>=3&&b-a>=width*.48){
          gaps=0;last=y;extendedLeft=Math.min(extendedLeft,a);extendedRight=Math.max(extendedRight,b);
        }else if(++gaps>5)break;
      }
      if(last-bottom>=height*(mask===colored ? .2 : .65))proposals.push({left:extendedLeft/w,top:top/h,
        right:(extendedRight+1)/w,bottom:(last+1)/h,score:score*.96});
    }
  }
  return proposals.sort((a,b)=>b.score-a.score);
}
