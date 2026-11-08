import {handleRecognition} from './handlers/recognition.mjs';
import {handleConnection} from './handlers/connection.mjs';

// One outstanding snapshot per subscriber. Acknowledging an older snapshot
// fetches the current state, never replays an accumulated queue.
export class StateFeed{
  constructor(room){this.room=room;this.pending=new Map();this.submitting=new Set();this.sequence=0;this.publishing=null;this.dirty=false}
  async snapshot(side='viewer',app=''){
    const url=new URL('https://internal/recognition/status');
    if(side==='device'){url.searchParams.set('hud','2');url.searchParams.set('app',app)}
    const recognition=await(await handleRecognition.call(this.room,new Request(url),url)).json();
    const request=new Request('https://internal/status');
    const status=await(await handleConnection.call(this.room,request,new URL(request.url))).json();
    const stats=new Request('https://internal/cam/stats');
    const camera=await(await handleConnection.call(this.room,stats,new URL(stats.url))).json();
    return {recognition,status,camera};
  }
  async connect(ws,side,id,app='',expiresAt=null,deviceId=null){
    ws.serializeAttachment({role:'state-client',side,id,app,expiresAt,deviceId,submission:0});
    if(side==='device')this.room.seen.set(id,Date.now());
    await this.deliver(ws);
  }
  async deliver(ws){
    if(ws.readyState!==1)return;
    const pending=this.pending.get(ws);
    if(pending){pending.dirty=true;if(Date.now()-pending.at>5000){this.pending.delete(ws);try{ws.close(1013,'State acknowledgement timed out')}catch{}}return}
    const attachment=ws.deserializeAttachment?.();if(attachment?.role!=='state-client')return;
    const entry={seq:++this.sequence,at:Date.now(),dirty:false};this.pending.set(ws,entry);
    try{const state=await this.snapshot(attachment.side,attachment.app);if(this.pending.get(ws)!==entry||ws.readyState!==1)return;ws.send(JSON.stringify({type:'state',seq:entry.seq,...state}))}
    catch{this.pending.delete(ws);try{ws.close(1011,'State unavailable')}catch{}}
  }
  publish(){
    this.dirty=true;
    if(!this.publishing)this.publishing=(async()=>{
      while(this.dirty){this.dirty=false;await Promise.all(this.room.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment?.()?.role==='state-client').map(ws=>this.deliver(ws)))}
    })().finally(()=>this.publishing=null);
    return this.publishing;
  }
  async message(ws,text){
    if(typeof text!=='string'||text.length>64000)return;
    let message;try{message=JSON.parse(text)}catch{return}
    if(!message||typeof message!=='object')return;
    const attachment=ws.deserializeAttachment?.();if(attachment?.role!=='state-client')return;
    if(message.type==='ack'){
      const pending=this.pending.get(ws);
      if(pending?.seq===message.seq){this.pending.delete(ws);if(pending.dirty)await this.deliver(ws)}
      return;
    }
    if(message.type==='ping'){
      if(attachment.side==='device')this.room.seen.set(attachment.id,Date.now());
      if(Number.isSafeInteger(message.ping))try{ws.send(JSON.stringify({type:'pong',pong:message.ping,serverNow:Date.now()}))}catch{}
      await this.deliver(ws);return;
    }
    if(message.type==='detections'&&attachment.side==='viewer'&&Number.isSafeInteger(message.seq)&&message.seq>attachment.submission){
      if(this.submitting.has(ws)){try{ws.send(JSON.stringify({type:'result',seq:message.seq,result:{ok:false,busy:true}}))}catch{}return}
      this.submitting.add(ws);
      try{
      attachment.submission=message.seq;ws.serializeAttachment(attachment);
      const request=new Request('https://internal/recognition/detections',{method:'POST',body:JSON.stringify(message.data)});
      const result=await(await handleRecognition.call(this.room,request,new URL(request.url))).json();
      try{ws.send(JSON.stringify({type:'result',seq:message.seq,result}))}catch{}
      await this.publish();
      }finally{this.submitting.delete(ws)}
    }
  }
  close(ws){this.pending.delete(ws);this.submitting.delete(ws)}
}
