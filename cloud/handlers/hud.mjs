import {json} from '../request-policy.mjs';

export async function handleHud(req,u){
  const p=u.pathname,q=u.searchParams;
    if((p==='/recognition/device'||p==='/recognition/hud')&&req.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const role=p==='/recognition/device'?'hud-device':'hud-viewer';
      if(role==='hud-device')for(const old of this.ctx.getWebSockets())if(old.deserializeAttachment?.()?.role===role)try{old.close(1000,'New HUD session')}catch{}
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({role,seq:0});
      if(role==='hud-viewer'&&this.deviceHud&&Date.now()-this.deviceHud.at<2000){pair[1].send(JSON.stringify(this.hudForViewer(this.deviceHud)));this.hudDelivery.set(pair[1],{seq:this.deviceHud.seq,at:Date.now()})}
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(p==='/recognition/playback'&&req.method==='POST'){
      const text=await req.text();if(text.length>1024)return json({error:'too big'},413);
      let d;try{d=JSON.parse(text)}catch{return json({error:'invalid playback event'},400)}
      const accepted=this.playback.event(d.id,d.event);
      if(accepted&&!this.playback.current())this.finishPlayback();
      return json({ok:true,accepted,seq:this.seq});
    }
}
