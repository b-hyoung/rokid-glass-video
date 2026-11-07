import test from 'node:test';
import assert from 'node:assert/strict';
import {displayStalled,LiveRecovery} from '../cloud/live-recovery.mjs';

test('continuous stale packets cannot mask a frozen display',()=>{
  const s={now:3000,connectedAt:100,packetAt:2990,presentedAt:1500,active:true,visible:true};
  assert.equal(displayStalled(s),true);
  assert.equal(displayStalled({...s,presentedAt:2900}),false);
  assert.equal(displayStalled({...s,connectedAt:2500}),false);
});
test('hidden, stopped and idle views do not trigger display recovery',()=>{
  const s={now:3000,connectedAt:100,packetAt:2990,presentedAt:1500,active:true,visible:true};
  for(const change of [{visible:false},{active:false},{packetAt:0}])assert.equal(displayStalled({...s,...change}),false);
});
test('repeated WebSocket stalls switch once to HTTP and retain explicit selection',()=>{
  const recovery=new LiveRecovery();
  assert.equal(recovery.transport('websocket',1000),'websocket');
  assert.equal(recovery.transport('websocket',5000),'http');
  assert.equal(recovery.transport('http',9000),'http');
  const pinned=new LiveRecovery();
  for(const now of [1000,5000,9000])assert.equal(pinned.transport('websocket',now,true),'websocket');
  const occasional=new LiveRecovery();
  assert.equal(occasional.transport('websocket',1000),'websocket');
  assert.equal(occasional.transport('websocket',40000),'websocket');
});
