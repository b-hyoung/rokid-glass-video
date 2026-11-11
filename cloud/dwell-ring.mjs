// Smooth dwell ring shared by the monitor. Server progress arrives only with
// each recognition result, so between results the ring advances on the local
// clock (at most LEAD_MS ahead of the last sample) and never steps backward
// for the same focus. It stops just short of full until the server confirms
// playback, then closes the circle and holds it briefly.
export const LEAD_MS=750,PENDING_CAP=.98,COMPLETE_HOLD_MS=450,EASE_MS=65;

export class DwellRing{
  constructor(){this.reset()}
  reset(){this.focus='';this.value=0;this.floor=0;this.server=0;this.at=null;this.completeUntil=0}
  // sample: {focus, progress, advancing, sinceMs, dwellMs, completed}
  step(now,s){
    const dt=this.at===null?0:Math.min(50,Math.max(0,now-this.at));this.at=now;
    if(s.completed&&this.focus&&s.focus===this.focus&&!this.completeUntil)this.completeUntil=now+COMPLETE_HOLD_MS;
    let goal;
    if(this.completeUntil&&now<this.completeUntil)goal=1;
    else if(this.completeUntil||!s.focus){this.reset();this.at=now;return 0}
    else{
      if(s.focus!==this.focus){this.reset();this.at=now;this.focus=s.focus}
      const lead=s.advancing?Math.min(LEAD_MS,Math.max(0,s.sinceMs||0))/Math.max(1,s.dwellMs):0;
      const sample=Math.max(0,Math.min(PENDING_CAP,(s.progress||0)+lead));
      // Only a drop in the server's own progress (a resume with less credit) lowers the ring.
      const progress=s.progress||0;
      this.floor=progress<this.server-.05?sample:Math.max(this.floor,sample);this.server=progress;
      goal=this.floor;
    }
    this.value+=(goal-this.value)*(1-Math.exp(-dt/(goal===1?40:EASE_MS)));
    if(Math.abs(goal-this.value)<.002)this.value=goal;
    return this.value;
  }
}
