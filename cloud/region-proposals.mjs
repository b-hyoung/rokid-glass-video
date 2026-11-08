// Locate compact image regions before the appearance model assigns identity.
export function regionProposals({data,width:w,height:h}){
  const size=w*h, gray=new Uint8Array(size), color=new Uint8Array(size);
  for(let i=0;i<size;i++){
    const r=data[4*i],g=data[4*i+1],b=data[4*i+2];
    gray[i]=(77*r+150*g+29*b)>>8;
    color[i]=Math.max(r,g,b)-Math.min(r,g,b);
  }
  const edges=new Uint8Array(size),softEdges=new Uint8Array(size);
  const dark=new Uint8Array(size),saturated=new Uint8Array(size),pale=new Uint8Array(size);
  for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
    const i=y*w+x;
    if(gray[i]<82&&color[i]<62)dark[i]=1;
    if(color[i]>64)saturated[i]=1;
    if(gray[i]>195&&color[i]<45)pale[i]=1;
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
  const core=opened(dark),colored=opened(saturated),light=opened(pale);
  // Letterboxing and uniformly black capture margins must not join a real
  // foreground object to an entire frame edge.
  for(const reverse of [false,true])for(let n=0;n<Math.ceil(w*.08);n++){
    const x=reverse?w-1-n:n;let sum=0,squares=0;
    for(let y=0;y<h;y++){const value=gray[y*w+x];sum+=value;squares+=value*value}
    const mean=sum/h;if(mean>35||squares/h-mean*mean>625)break;
    for(let y=0;y<h;y++)core[y*w+x]=colored[y*w+x]=0;
  }
  const edgeEvidence=edges.slice(),queue=new Int32Array(size), proposals=[];
  for(const mask of [core,colored,light,edges,softEdges])for(let i=0;i<size;i++){
    if(!mask[i])continue;
    let head=0,tail=1,left=w,right=0,top=h,bottom=0;
    queue[0]=i;mask[i]=0;
    while(head<tail){
      const j=queue[head++],x=j%w,y=(j/w)|0;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const k of [j-1,j+1,j-w,j+w])if(mask[k]){mask[k]=0;queue[tail++]=k}
    }
    const width=right-left+1,height=bottom-top+1,area=width*height/size;
    const solid=mask===core||mask===colored||mask===light;
    const boundaries=Number(left<=2)+Number(right>=w-3)+Number(top<=2)+Number(bottom>=h-3);
    if(width<(solid?7:9)||height<(solid?5:7)||area<(solid?.0012:.002)||area>.12||boundaries>1||width/height>3.5||height/width>3||tail<width+height)continue;
    const cx=(left+right+1)/(2*w),cy=(top+bottom+1)/(2*h);
    const density=tail/(width*height);
    if(density<(solid ? .34 : .18))continue;
    const score=Math.sqrt(area)*(1-.65*Math.hypot(cx-.5,cy-.55))*(solid?1:.82);
    proposals.push({left:left/w,top:top/h,right:(right+1)/w,bottom:(bottom+1)/h,score,colorBody:mask===colored});
    if((mask===core||mask===light)&&area<.02){
      // A dark handle/cap may belong to a pale body with little edge contrast.
      // These are search hypotheses only; vectors and reference photos still
      // have to establish identity and temporal evidence before display.
      const expanded=refineSmallRegion(data,w,h,{left:left/w,top:top/h,right:(right+1)/w,bottom:(bottom+1)/h});
      if(expanded)proposals.push({...expanded,refined:true,score:score*.98});
    }
    // A dark component can be one part of a brighter object. Extend the
    // candidate only where adjacent rows still contain edge evidence.
    if((mask===core||mask===colored)&&area<.03&&width>height*1.25){
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
  return proposals.filter(b=>{
    const area=(b.right-b.left)*(b.bottom-b.top),edges=Number(b.left<=2/w)+Number(b.right>=1-2/w)+Number(b.top<=2/h)+Number(b.bottom>=1-2/h);
    return area<=.12&&edges<=1;
  }).sort((a,b)=>b.score-a.score);
}

function refineSmallRegion(data,w,h,box){
  const bw=(box.right-box.left)*w,bh=(box.bottom-box.top)*h;
  const left=Math.max(0,Math.floor(box.left*w-bw*.8)),right=Math.min(w,Math.ceil(box.right*w+bw*.8));
  const top=Math.max(0,Math.floor(box.top*h-bh*.4)),bottom=Math.min(h,Math.ceil(box.bottom*h+bh*2.2));
  const width=right-left,height=bottom-top;if(width<7||height<7)return null;
  const mask=new Uint8Array(width*height),dilated=new Uint8Array(mask.length),closed=new Uint8Array(mask.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let distance=0;
    for(let c=0;c<3;c++){
      const a=(data[((top+y)*w+left)*4+c]+data[((top+y)*w+Math.min(right-1,left+1))*4+c])/2;
      const b=(data[((top+y)*w+right-1)*4+c]+data[((top+y)*w+Math.max(left,right-2))*4+c])/2;
      const background=a+(b-a)*x/(width-1);distance+=(data[((top+y)*w+left+x)*4+c]-background)**2;
    }
    if(distance>32**2)mask[y*width+x]=1;
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;if(mask[i])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)dilated[i+dy*width+dx]=1;
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    let full=true;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(!dilated[(y+dy)*width+x+dx])full=false;
    if(full)closed[y*width+x]=1;
  }
  const queue=new Int32Array(mask.length);let best=null;
  for(let i=0;i<closed.length;i++)if(closed[i]){
    let head=0,tail=1,l=width,r=0,t=height,b=0,overlap=0;queue[0]=i;closed[i]=0;
    while(head<tail){const j=queue[head++],x=j%width,y=(j/width)|0;l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);
      if(x+left>=box.left*w&&x+left<=box.right*w&&y+top>=box.top*h&&y+top<=box.bottom*h)overlap++;
      for(const k of [j-1,j+1,j-width,j+width])if(closed[k]){closed[k]=0;queue[tail++]=k}
    }
    if(overlap>=4&&tail<mask.length*.75&&overlap>(best?.overlap??0))best={left:(left+l)/w,top:(top+t)/h,right:(left+r+1)/w,bottom:(top+b+1)/h,overlap};
  }
  if(!best||(best.right-best.left)*(best.bottom-best.top)>.04)return null;
  return {...best,left:Math.max(0,best.left-1/w),top:Math.max(0,best.top-1/h),right:Math.min(1,best.right+1/w),bottom:Math.min(1,best.bottom+1/h)};
}

// Spatial diversity keeps several high-scoring views of one object from
// consuming the whole search. Rotation covers weaker candidates on later scans.
export function selectProposals(proposals,limit=18,cursor=0){
  const cells=new Map();
  for(const box of proposals){
    const cell=Math.min(2,Math.floor((box.left+box.right)*1.5))+3*Math.min(2,Math.floor((box.top+box.bottom)*1.5));
    if(!cells.has(cell))cells.set(cell,[]);
    const list=cells.get(cell);
    if(!list.some(a=>{const intersection=Math.max(0,Math.min(a.right,box.right)-Math.max(a.left,box.left))*Math.max(0,Math.min(a.bottom,box.bottom)-Math.max(a.top,box.top));const union=(a.right-a.left)*(a.bottom-a.top)+(box.right-box.left)*(box.bottom-box.top)-intersection;return intersection/Math.max(1e-9,union)>.85}))list.push(box);
  }
  const groups=[...cells.values()].sort((a,b)=>b[0].score-a[0].score).map(group=>{
    const rest=group.slice(2),offset=rest.length?cursor%rest.length:0;
    return [...group.slice(0,2),...rest.slice(offset),...rest.slice(0,offset)];
  }),result=[];
  for(let round=0;result.length<limit&&round<proposals.length;round++){
    let added=false;
    for(const group of groups){if(round>=group.length)continue;result.push(group[round]);added=true;if(result.length===limit)break}
    if(!added&&round>2)break;
  }
  return result;
}
