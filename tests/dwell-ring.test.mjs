import test from 'node:test';
import assert from 'node:assert/strict';
import {DwellRing,PENDING_CAP} from '../cloud/dwell-ring.mjs';

test('the dwell ring rises smoothly between sparse results and closes fully on playback',()=>{
  const ring=new DwellRing();let last=0,maxStep=0;
  for(let t=0;t<3000;t+=16){
    const sample=Math.floor(t/500)*500,v=ring.step(t,{focus:'a',progress:sample/3000,advancing:true,sinceMs:t-sample,dwellMs:3000});
    assert.ok(v>=last-1e-9,'never steps backward');if(t>100)maxStep=Math.max(maxStep,v-last);last=v;
  }
  assert.ok(maxStep<.02,'no visible jump at each result: '+maxStep);
  assert.ok(last<=PENDING_CAP&&last>.9,'waits just short of full');
  let v=0;for(let t=3000;t<3300;t+=16)v=ring.step(t,{focus:'a',progress:1,completed:true,dwellMs:3000});
  assert.equal(v,1,'confirmed playback draws a complete circle');
  assert.equal(ring.step(3600,{focus:'',dwellMs:3000}),0,'then clears');
});

test('a paused result holds the ring instead of pulling it back',()=>{
  const ring=new DwellRing();
  for(let t=0;t<=600;t+=16)ring.step(t,{focus:'a',progress:.2,advancing:true,sinceMs:t,dwellMs:3000});
  const held=ring.step(616,{focus:'a',progress:.2,advancing:false,sinceMs:800,dwellMs:3000});
  assert.ok(held>.35,'kept the locally advanced position');
  assert.ok(ring.step(632,{focus:'a',progress:.05,advancing:false,sinceMs:0,dwellMs:3000})<held,'a real server reset lowers it');
  assert.equal(ring.step(700,{focus:'b',progress:0,advancing:true,sinceMs:0,dwellMs:3000}),0,'a new focus restarts');
});
