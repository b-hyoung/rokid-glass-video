import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveTiming} from '../cloud/live-timing.mjs';
import {FramePlayer} from '../cloud/frame-player.js';

test('server age uses monotonic clock synchronization, not client wall clock',()=>{
 const clock=new LiveTiming();const ping=clock.ping(100);clock.pong({pong:ping.ping,serverNow:1000000},300);
 assert.equal(clock.age(1000000,400),200);assert.equal(clock.uncertainty,100);
 assert.equal(clock.fresh(1000000,950),true);assert.equal(clock.fresh(1000000,1050),false);assert.equal(clock.backlogged(1000000,1050),false);assert.equal(clock.backlogged(1000000,2200),true);
 // A slow status request must not replace the lower-latency WebSocket estimate.
 clock.observe(1005000,300,1800);assert.equal(clock.age(1000000,400),200);
});

test('a newly decoded frame which was delayed in transport is discarded before display',t=>{
 let now=100;t.mock.method(performance,'now',()=>now);const clock=new LiveTiming();clock.observe(1000000,0,100);
 const shown=[],closed=[],player=new FramePlayer(f=>shown.push(f.id),(at,n)=>clock.fresh(at,n));
 const frame=id=>({id,clone(){return {id,close(){closed.push(id)}}}});
 // Old frame decoded now: it has no local queue delay, but is already stale upstream.
 player.push(frame('old'),998000,60);player.tick(now);assert.deepEqual(shown,[]);assert.equal(player.drops.stale,1);
 player.push(frame('live'),1000050,60);player.tick(now);assert.deepEqual(shown,['live']);assert.deepEqual(closed,['old','live']);
});
