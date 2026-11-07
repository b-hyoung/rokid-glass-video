import {firstMb,nals} from './stream-protocol.mjs';
// Annex-B H.264 access-unit parser for the existing CameraStreamer encoder.
export class GlassDecoder {
  constructor(output,error){this.output=output;this.error=error;this.buffer=new Uint8Array();this.au=[];this.hasSlice=false;this.sps=null;this.pps=null;this.codec=null;this.decoder=null;this.needsKey=true;this.timestamp=0;this.test=null;this.seg=-1;this.pending=new Map();this.counters={submitted:0,output:0,skippedUntilKey:0,skippedNoConfig:0,segmentGaps:0,queueResets:0,pendingDiscarded:0,errors:0,maxDecodeQueue:0};}
  reset(keepConfig=false){this.buffer=new Uint8Array();this.au=[];this.hasSlice=false;this.needsKey=true;this.counters.pendingDiscarded+=this.pending.size;this.pending.clear();if(this.decoder){if(this.decoder.state!=='closed')this.decoder.close();this.decoder=null}if(!keepConfig){this.sps=null;this.pps=null;this.codec=null}this.seg=-1;}
  push(message){if(this.test!==message.test){this.reset();this.test=message.test}if(message.config){for(const n of nals(message.bytes))this.nal(n);return}if(message.seg<=this.seg)return;if(this.seg>=0&&message.seg!==this.seg+1){this.counters.segmentGaps++;this.reset(true)}this.seg=message.seg;this.fps=message.fps||30;this.at=message.at;const bytes=message.bytes??Uint8Array.from(atob(message.data),c=>c.charCodeAt(0));const all=new Uint8Array(this.buffer.length+bytes.length);all.set(this.buffer);all.set(bytes,this.buffer.length);const starts=[];for(let i=0;i<all.length-2;i++){if(all[i]===0&&all[i+1]===0&&all[i+2]===1){starts.push({offset:i,size:3});i+=2}else if(i<all.length-3&&all[i]===0&&all[i+1]===0&&all[i+2]===0&&all[i+3]===1){starts.push({offset:i,size:4});i+=3}}
    for(let i=0;i<starts.length-1;i++)this.nal(all.slice(starts[i].offset+starts[i].size,starts[i+1].offset));
    this.buffer=starts.length?all.slice(starts.at(-1).offset):all;if(message.complete&&starts.length){this.nal(all.subarray(starts.at(-1).offset+starts.at(-1).size));this.buffer=new Uint8Array();if(this.hasSlice)this.flush()}if(this.buffer.length>4e6)this.reset(true);
  }
  nal(n){if(!n.length)return;const type=n[0]&31;
    if(type===7||type===8||type===9){if(this.hasSlice)this.flush();if(type===7){this.sps=n;this.codec='avc1.'+Array.from(n.slice(1,4),x=>x.toString(16).padStart(2,'0')).join('')}if(type===8)this.pps=n;return}
    if(type===1||type===5){if(this.hasSlice&&firstMb(n)===0)this.flush();this.hasSlice=true;this.au.push(n)}else if(type===6)this.au.push(n);
  }
  flush(){const units=this.au;this.au=[];this.hasSlice=false;const key=units.some(n=>(n[0]&31)===5);if(!this.sps||!this.pps){this.counters.skippedNoConfig++;return}if(!key&&this.needsKey){this.counters.skippedUntilKey++;return}
    if(!this.decoder){this.decoder=new VideoDecoder({output:f=>{const info=this.pending.get(f.timestamp);this.pending.delete(f.timestamp);try{if(info){this.counters.output++;this.output(f,info.at,info.fps)}}finally{f.close()}},error:e=>{this.counters.errors++;this.error(e);this.reset(true)}});this.decoder.configure({codec:this.codec,optimizeForLatency:true,hardwareAcceleration:'no-preference'})}
    // A normal 100ms packet has six frames at 60fps. Do not discard the next packet
    // just because hardware decoding has not yet delivered the previous burst.
    this.counters.maxDecodeQueue=Math.max(this.counters.maxDecodeQueue,this.decoder.decodeQueueSize);
    if(this.decoder.decodeQueueSize>Math.max(60,this.fps*2)){this.counters.queueResets++;this.reset(true);return}
    const data=key?[this.sps,this.pps,...units]:units;let size=data.reduce((s,n)=>s+n.length+4,0),b=new Uint8Array(size),o=0;for(const n of data){b.set([0,0,0,1],o);b.set(n,o+4);o+=n.length+4}
    try{this.timestamp+=Math.round(1e6/this.fps);this.pending.set(this.timestamp,{at:this.at,fps:this.fps});this.decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:this.timestamp,data:b}));this.counters.submitted++;this.needsKey=false}catch(e){this.counters.errors++;this.error(e);this.reset(true)}
  }
}
