// Only metadata reported after a device draw is accepted here. The web recognizer
// cannot use its own detections to claim that the glasses displayed something.
export function deviceHud(message,targets,now=Date.now()){
  if(!message||!Number.isSafeInteger(message.seq)||message.seq<1||!['idle','recognition','guide','loading','playback'].includes(message.mode))return null;
  const names=new Map(targets.map(t=>[t.id,t.name])),seen=new Set(),objects=[];
  if(message.visible&&message.mode==='recognition')for(const object of (Array.isArray(message.objects)?message.objects:[]).slice(0,4)){
    if(!names.has(object.id)||seen.has(object.id)||![object.x,object.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))continue;
    seen.add(object.id);objects.push({id:object.id,name:names.get(object.id),x:object.x,y:object.y});
  }
  return {width:Number.isFinite(message.width)?Math.max(100,Math.min(4096,message.width)):640,height:Number.isFinite(message.height)?Math.max(100,Math.min(4096,message.height)):360,seq:message.seq,at:now,visible:!!message.visible,mode:message.visible?message.mode:'idle',objects,tracking:!!message.tracking,title:String(message.title||'').slice(0,100),playbackId:String(message.playbackId||'').slice(0,80),app:String(message.app||'').slice(0,20)};
}
