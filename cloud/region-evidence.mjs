function bounds(points){
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}

export function regionOverlap(a,b){
  const [al,at,ar,ab]=bounds(a),[bl,bt,br,bb]=bounds(b);
  const intersection=Math.max(0,Math.min(ar,br)-Math.max(al,bl))*
    Math.max(0,Math.min(ab,bb)-Math.max(at,bt));
  return intersection/Math.max(1e-9,(ar-al)*(ab-at)+(br-bl)*(bb-bt)-intersection);
}

// Compact boxes with strong direct appearance evidence can enter dwell immediately.
export function isStrongRegion(vector,photo,margin,corners){
  const [left,top,right,bottom]=bounds(corners);
  const width=right-left,height=bottom-top;
  return vector>=.74&&photo>=.74&&margin>=.05&&width>0&&height>0&&width*height<=.085;
}

export class RegionEvidence {
  constructor(){this.pending=new Map()}
  clear(){this.pending.clear()}
  confirm(id,corners,at,tracked,strong=false){
    if(tracked&&regionOverlap(corners,tracked)>=.52){
      this.pending.delete(id);
      return true;
    }
    const previous=this.pending.get(id);
    if(strong&&!tracked&&!previous)return true;
    this.pending.set(id,{corners,at});
    if(previous&&at>previous.at&&at-previous.at<=1800&&regionOverlap(corners,previous.corners)>=.52){
      this.pending.delete(id);
      return true;
    }
    return false;
  }
  prune(at){
    for(const [id,pending] of this.pending)if(at-pending.at>1800)this.pending.delete(id);
  }
}
