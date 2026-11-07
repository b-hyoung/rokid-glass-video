// Pace received bursts at the camera rate. A LAN-sized 300ms cap discarded
// half of normal WAN bursts; keep a bounded jitter buffer instead.
// VideoFrames are owned here until presented/dropped; the decoder closes its own reference.
export class FramePlayer {
  constructor(present){this.present=present;this.queue=[];this.next=0;this.fps=60;this.decoded=0;this.shown=0;this.dropped=0;this.drops={overflow:0,stale:0,clear:0};this.maxQueue=0;this.lastTick=performance.now();this.maxRafGap=0}
  clear(){this.drops.clear+=this.queue.length;this.dropped+=this.queue.length;for(const x of this.queue)x.frame.close();this.queue=[];this.next=0}
  push(frame,at,fps=60){this.fps=fps;this.decoded++;const now=performance.now();if(!this.next)this.next=now+250;this.queue.push({frame:frame.clone(),at,received:now});const limit=Math.max(2,Math.ceil(fps*.8));while(this.queue.length>limit){this.queue.shift().frame.close();this.dropped++;this.drops.overflow++}this.maxQueue=Math.max(this.maxQueue,this.queue.length)}
  tick(now){this.maxRafGap=Math.max(this.maxRafGap,now-this.lastTick);if(now-this.lastTick>1000){while(this.queue.length&&now-this.queue[0].received>800){this.queue.shift().frame.close();this.dropped++;this.drops.stale++}this.next=now}this.lastTick=now;if(!this.queue.length||now+1<this.next)return;const x=this.queue.shift(),gap=1000/this.fps;this.next=Math.max(this.next+gap,now-gap/2);try{this.present(x.frame,x.at);this.shown++}finally{x.frame.close()}}
}
