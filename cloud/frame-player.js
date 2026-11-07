// The camera sends ~100ms bursts. Pace distinct pictures across display refreshes,
// starting immediately. Bound both queue depth and residence time so an early stall
// cannot leave the live view permanently behind. This is not an end-to-end latency bound.
// VideoFrames are owned here until presented/dropped; the decoder closes its reference.
const MAX_WAIT_MS=200;
export class FramePlayer {
  constructor(present,isFresh=()=>true){this.present=present;this.isFresh=isFresh;this.queue=[];this.next=null;this.fps=60;this.decoded=0;this.shown=0;this.dropped=0;this.drops={overflow:0,stale:0,clear:0};this.maxQueue=0;this.lastTick=performance.now();this.maxRafGap=0;this.lastWaitMs=0;this.maxWaitMs=0}
  clear(){this.drops.clear+=this.queue.length;this.dropped+=this.queue.length;for(const x of this.queue)x.frame.close();this.queue=[];this.next=null;this.lastWaitMs=0}
  drop(reason){this.queue.shift().frame.close();this.dropped++;this.drops[reason]++}
  push(frame,at,fps=60){
    this.fps=fps;this.decoded++;
    const now=performance.now();if(this.next===null)this.next=now;
    this.queue.push({frame:frame.clone(),at,received:now});
    const limit=Math.max(2,Math.ceil(fps*MAX_WAIT_MS/1000));
    while(this.queue.length>limit)this.drop('overflow');
    this.maxQueue=Math.max(this.maxQueue,this.queue.length);
  }
  tick(now){
    this.maxRafGap=Math.max(this.maxRafGap,now-this.lastTick);this.lastTick=now;
    while(this.queue.length&&(now-this.queue[0].received>MAX_WAIT_MS||!this.isFresh(this.queue[0].at,now)))this.drop('stale');
    if(!this.queue.length){this.next=null;return}
    if(now+1<this.next)return;
    const x=this.queue.shift(),gap=1000/this.fps;
    this.next=Math.max(this.next+gap,now-gap/2);
    this.lastWaitMs=Math.max(0,now-x.received);this.maxWaitMs=Math.max(this.maxWaitMs,this.lastWaitMs);
    try{this.present(x.frame,x.at);this.shown++}finally{x.frame.close()}
  }
}
