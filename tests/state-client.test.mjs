import test from 'node:test';
import assert from 'node:assert/strict';
import {StateClient,RetryDelay} from '../cloud/state-client.js';
test('retry backoff doubles, caps and resets after success',()=>{
  const retry=new RetryDelay(()=>.5);assert.deepEqual(Array.from({length:8},()=>retry.next()),[1000,2000,4000,8000,16000,30000,30000,30000]);retry.reset();assert.equal(retry.next(),1000);
});
test('a hidden page opens no state socket and only one detection can be outstanding',async()=>{
  let socket,visible=false;const received=[];
  class FakeSocket{constructor(){socket=this;this.readyState=1;this.sent=[]}send(text){this.sent.push(JSON.parse(text))}close(){this.readyState=3}}
  const client=new StateClient({onState:s=>received.push(s),WebSocketClass:FakeSocket,base:'http://test/',visible:()=>visible});
  client.start();assert.equal(socket,undefined);visible=true;client.start();socket.onopen();assert.equal(client.healthy,false);
  socket.onmessage({data:JSON.stringify({type:'state',seq:4,recognition:{}})});assert.equal(received.length,1);assert.equal(client.healthy,true);
  const result=client.detections({epoch:4});assert.equal(client.detections({epoch:4}),null);
  const message=socket.sent.find(m=>m.type==='detections');socket.onmessage({data:JSON.stringify({type:'result',seq:message.seq,result:{ok:true}})});
  assert.deepEqual(await result,{ok:true});
  const old=socket;client.pause();old.onmessage({data:'{"type":"state","seq":5}'});assert.equal(received.length,1);client.stop();
});
