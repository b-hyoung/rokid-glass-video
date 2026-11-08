export class RetryDelay{
  constructor(random=Math.random){this.random=random;this.failures=0}
  reset(){this.failures=0}
  next(){const base=Math.min(30000,1000*2**Math.min(5,this.failures++));return Math.round(base*(.9+.2*this.random()))}
}

// State and detections share a bounded channel. Device commands and real HUD
// reports retain their independent channels and playback cancellation tokens.
export class StateClient{
  constructor({onState,onError=()=>{},onPing=()=>({}),onPong=()=>{},WebSocketClass=WebSocket,base=location.href,visible=()=>document.visibilityState==='visible'}){
    Object.assign(this,{onState,onError,onPing,onPong,WebSocketClass,base,visible});this.retry=new RetryDelay();this.seq=0;this.pending=null;this.stopped=false;
  }
  start(){if(!this.stopped&&this.visible()&&!this.socket&&!this.timer)this.connect()}
  connect(){
    if(this.stopped||!this.visible())return;
    const url=new URL('/recognition/events?role=viewer',this.base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=this.socket=new this.WebSocketClass(url);
    this.hasSnapshot=false;
    socket.onmessage=({data})=>{
      if(this.socket!==socket)return;
      try{const message=JSON.parse(data);
        if(message.type==='pong')this.onPong(message);
        if(message.type==='state'){
          this.hasSnapshot=true;
          this.lastAt=performance.now();this.retry.reset();
          // Receipt acknowledgement does not assert that glasses drew this HUD.
          socket.send(JSON.stringify({type:'ack',seq:message.seq}));
          Promise.resolve(this.onState(message)).catch(this.onError);
        }
        if(message.type==='result'&&this.pending?.seq===message.seq){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(message.result)}
      }catch(error){this.onError(error)}
    };
    socket.onopen=()=>{
      if(this.socket!==socket)return;
      this.lastAt=performance.now();
      socket.send(JSON.stringify({type:'ping',...this.onPing()}));
      this.heartbeat=setInterval(()=>{if(this.socket!==socket)return;if(!this.visible()||performance.now()-this.lastAt>15000){this.disconnect();this.timer=setTimeout(()=>{this.timer=null;this.start()},this.retry.next())}else socket.send(JSON.stringify({type:'ping',...this.onPing()}))},5000);
    };
    socket.onclose=()=>{if(this.socket!==socket)return;this.disconnect();this.timer=setTimeout(()=>{this.timer=null;this.start()},this.retry.next())};
    socket.onerror=()=>{};
  }
  get healthy(){return this.hasSnapshot&&this.socket?.readyState===1&&performance.now()-this.lastAt<12000}
  detections(data){
    if(!this.healthy||this.pending)return null;
    const seq=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pending?.seq===seq){this.pending=null;reject(Error('인식 결과 응답 지연'));this.disconnect();this.start()}},5000);
      this.pending={seq,resolve,reject,timer};this.socket.send(JSON.stringify({type:'detections',seq,data}));
    });
  }
  disconnect(){
    const socket=this.socket;this.socket=null;socket?.close();clearInterval(this.heartbeat);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('상태 연결이 끊겼습니다.'));this.pending=null}
  }
  pause(){clearTimeout(this.timer);this.timer=null;this.disconnect()}
  stop(){this.stopped=true;this.pause()}
}
