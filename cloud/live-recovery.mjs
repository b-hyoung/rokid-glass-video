// Receiving an H.264 packet is not proof that a fresh picture was presented.
// The renderer can reject every picture while packets keep the receive watchdog alive.
export function displayStalled({now,connectedAt,packetAt,presentedAt,active,visible}){
  return !!(active&&visible&&connectedAt&&packetAt>=connectedAt&&now-packetAt<2500&&now-Math.max(presentedAt,connectedAt)>1200);
}

export class LiveRecovery {
  constructor(){this.failures=[]}
  transport(current,now,pinned=false){
    this.failures=this.failures.filter(at=>now-at<30000);this.failures.push(now);
    // Keep the alternate connection for this page session. Do not oscillate or
    // force an explicitly requested diagnostic transport to change.
    return current==='websocket'&&!pinned&&this.failures.length>=2?'http':current;
  }
}
