import test from 'node:test';
import assert from 'node:assert/strict';
import {FramePlayer} from '../cloud/frame-player.js';
function frame(id,closed){return {id,clone(){return {id,close(){closed.push(id)}}}}}
test('a six-frame network burst starts immediately and presents six distinct pictures',t=>{
 const now=100;t.mock.method(performance,'now',()=>now);
 const shown=[],closed=[],player=new FramePlayer(f=>shown.push(f.id));
 for(let i=0;i<6;i++)player.push(frame(i,closed),0,60);
 for(let i=0;i<6;i++)player.tick(now+i*1000/60);
 assert.deepEqual(shown,[0,1,2,3,4,5]);assert.equal(player.dropped,0);assert.equal(closed.length,6);
});
test('a slow or background viewer drops stale pictures and releases every frame',()=>{
 const shown=[],closed=[],player=new FramePlayer(f=>shown.push(f.id));
 for(let i=0;i<60;i++)player.push(frame(i,closed),0,60);
 assert.equal(player.queue.length,12);assert.equal(player.dropped,48);
 player.tick(performance.now()+1500);assert.equal(shown.length,0);assert.equal(closed.length,60);
 player.push(frame(60,closed),0,60);player.clear();assert.equal(closed.length,61);assert.equal(player.queue.length,0);
 assert.deepEqual(player.drops,{overflow:48,stale:12,clear:1});assert.equal(player.decoded,player.shown+player.dropped+player.queue.length);
});
test('a short main-thread stall discards expired pictures before resuming live',t=>{
 let now=100;t.mock.method(performance,'now',()=>now);
 const shown=[],closed=[],player=new FramePlayer(f=>shown.push(f.id));
 for(let i=0;i<6;i++)player.push(frame(i,closed),0,60);
 now+=250;player.tick(now);
 assert.deepEqual(shown,[]);assert.equal(player.drops.stale,6);
 player.push(frame(6,closed),0,60);player.tick(now);
 assert.deepEqual(shown,[6]);assert.equal(player.lastWaitMs,0);assert.equal(closed.length,7);
});
for(const fps of [30,40,60])test(`${fps}fps bursts stay paced on a 144Hz display with bounded waiting`,t=>{
 let now=100;t.mock.method(performance,'now',()=>now);
 const shown=[],closed=[],waits=[],player=new FramePlayer(f=>{shown.push(f.id);waits.push(player.lastWaitMs)});
 let nextPacket=100,id=0;
 for(let tick=0;tick<144*3;tick++){
   now=100+tick*1000/144;
   if(now+1e-6>=nextPacket&&id<fps*2){for(let i=0;i<fps/10;i++)player.push(frame(id++,closed),0,fps);nextPacket+=100}
   const before=player.shown;player.tick(now);assert.ok(player.shown-before<=1);
 }
 assert.equal(shown.length,fps*2);assert.equal(player.dropped,0);assert.equal(closed.length,fps*2);
 assert.ok(Math.max(...waits)<=200);assert.ok(player.maxQueue<=Math.ceil(fps*.2));
});
