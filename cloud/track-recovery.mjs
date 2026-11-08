// Search around a track using an immutable, last-confirmed grayscale patch.
export class TrackRecovery {
  constructor(gray,corners){
    const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
    this.width=Math.max(...xs)-Math.min(...xs);
    this.height=Math.max(...ys)-Math.min(...ys);
    this.reference=this.sample(gray,Math.min(...xs),Math.min(...ys),this.width,this.height);
  }
  sample(gray,left,top,width,height){
    const values=new Float32Array(576);
    let sum=0;
    for(let y=0;y<24;y++)for(let x=0;x<24;x++){
      const px=Math.max(0,Math.min(gray.cols-1,Math.round((left+(x+.5)*width/24)*gray.cols)));
      const py=Math.max(0,Math.min(gray.rows-1,Math.round((top+(y+.5)*height/24)*gray.rows)));
      const value=gray.data[py*gray.cols+px];
      values[y*24+x]=value;sum+=value;
    }
    const mean=sum/values.length;
    let norm=0;
    for(let i=0;i<values.length;i++){values[i]-=mean;norm+=values[i]*values[i]}
    if(norm/values.length<45)return null;
    norm=Math.sqrt(norm);
    for(let i=0;i<values.length;i++)values[i]/=norm;
    return values;
  }
  locate(gray,corners){
    if(!this.reference)return null;
    const cx=corners.reduce((s,p)=>s+p[0]/4,0),cy=corners.reduce((s,p)=>s+p[1]/4,0);
    let best=null;
    for(const scale of [.9,1,1.1])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const w=this.width*scale,h=this.height*scale;
      const left=cx-w/2+dx*this.width*.12,top=cy-h/2+dy*this.height*.12;
      if(left<0||top<0||left+w>1||top+h>1)continue;
      const patch=this.sample(gray,left,top,w,h);
      if(!patch)continue;
      let score=0;
      for(let i=0;i<patch.length;i++)score+=patch[i]*this.reference[i];
      if(score>=.84&&(!best||score>best.score)){
        best={score,corners:[[left,top],[left+w,top],[left+w,top+h],[left,top+h]]};
      }
    }
    return best?.corners??null;
  }
}
