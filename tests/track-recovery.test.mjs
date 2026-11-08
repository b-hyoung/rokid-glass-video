import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackRecovery} from '../cloud/track-recovery.mjs';

const box=[[.3,.3],[.6,.3],[.6,.6],[.3,.6]];
function frame(dx=0,replace=false){
  const cols=160,rows=160,data=new Uint8Array(cols*rows).fill(200);
  for(let y=48;y<96;y++)for(let x=48;x<96;x++){
    data[y*cols+x+dx]=replace?100:(x*73+y*97+(x*y)%43)%190+20;
  }
  return {cols,rows,data};
}
test('local recovery follows the confirmed texture and rejects a replacement',()=>{
  const recovery=new TrackRecovery(frame(),box);
  const found=recovery.locate(frame(6),box);
  assert.ok(found);
  assert.ok(Math.abs(found[0][0]-(.3+6/160))<.015);
  assert.equal(recovery.locate(frame(0,true),box),null);
  assert.equal(new TrackRecovery({cols:160,rows:160,data:new Uint8Array(25600).fill(20)},box).locate(frame(),box),null);
});
