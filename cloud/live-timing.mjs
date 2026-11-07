// Map the server clock to the browser's monotonic clock. A delayed frame must
// not acquire a new lifetime just because it has only now finished decoding.
export class LiveTiming {
  constructor(){this.samples=[];this.pending=new Map();this.seq=0;this.offset=null;this.uncertainty=0;this.stalePackets=0;this.recoveries=0}
  observe(serverNow,start,end=performance.now()){
    if(!Number.isFinite(serverNow)||end<start||end-start>2000)return;
    this.samples.push({rtt:end-start,offset:serverNow-(start+end)/2,at:end});
    this.samples=this.samples.filter(s=>end-s.at<60000).slice(-30);
    const best=this.samples.reduce((a,b)=>a.rtt<b.rtt?a:b);this.offset=best.offset;this.uncertainty=best.rtt/2;
  }
  ping(now=performance.now()){const ping=++this.seq;this.pending.set(ping,now);for(const [id,at] of this.pending)if(now-at>10000)this.pending.delete(id);return {ping}}
  pong(m,now=performance.now()){const start=this.pending.get(m.pong);if(start===undefined)return;this.pending.delete(m.pong);this.observe(m.serverNow,start,now)}
  age(at,now=performance.now()){return this.offset===null||!Number.isFinite(at)?null:Math.max(0,now+this.offset-at)}
  fresh(at,now=performance.now()){const age=this.age(at,now);return age===null||age-this.uncertainty<=700}
  backlogged(at,now=performance.now()){const age=this.age(at,now);return age!==null&&age-this.uncertainty>1800}
}
