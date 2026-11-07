import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveDiagnostics} from '../cloud/live-diagnostics.mjs';
test('diagnostics are opt-in and retain only bounded metadata in order',()=>{
 const d=new LiveDiagnostics(3);d.packet({kind:'h264',seg:1,bytes:new Uint8Array([1])},'http');assert.equal(d.export().events.length,0);
 d.start();d.packet({kind:'h264',test:1,seg:2,frames:6,bytes:new Uint8Array([1,2])},'http');d.packet({kind:'h264',test:1,seg:3,frames:6,bytes:new Uint8Array([3])},'http');d.record('screen_clear',{reason:'frame_stale'});d.stop();
 const out=d.export();assert.equal(out.events.length,3);assert.equal(out.droppedEvents,2);assert.deepEqual(out.events.map(e=>e.type),['packet','screen_clear','stop']);assert.equal(out.events[0].segment,3);assert.ok(out.events[0].gapMs>=0);assert.equal(out.events[0].bytes,1);assert.equal(out.enabled,false);d.record('unexpected');assert.equal(d.export().events.length,3);
});
test('config packets are excluded and gap resets on reconnection',()=>{
 const d=new LiveDiagnostics();d.start();d.packet({kind:'h264',config:true},'http');d.packet({kind:'h264',seg:1},'http');d.resetPacket();d.packet({kind:'h264',seg:2},'websocket');const packets=d.export().events.filter(e=>e.type==='packet');assert.equal(packets.length,2);assert.equal(packets[1].gapMs,null);
});

test('recorded counters remain unchanged after live counters mutate',()=>{
 const d=new LiveDiagnostics();const live={playerDrops:{stale:2},decoder:{errors:1}};d.start();d.record('metrics',live);live.playerDrops.stale=8;live.decoder.errors=9;d.record('metrics',live);const m=d.export().events.filter(e=>e.type==='metrics');assert.equal(m[0].playerDrops.stale,2);assert.equal(m[0].decoder.errors,1);assert.equal(m[1].playerDrops.stale,8);
});
test('packet links to completing read and measures processing delay',()=>{
 const d=new LiveDiagnostics();assert.equal(d.read('http',20),null);d.start();const r=d.read('http',20);d.packet({kind:'h264',seg:1},'http',r);const events=d.export().events;const read=events.find(e=>e.type==='read'),packet=events.find(e=>e.type==='packet');assert.equal(read.bytes,20);assert.equal(packet.readId,read.readId);assert.ok(packet.processingDelayMs>=0);assert.equal(d.export().version,3);
});

test('packet metadata compares same-session consecutive source and server intervals only',()=>{
 const d=new LiveDiagnostics();d.start();d.packet({kind:'h264',test:4,seg:1,sourceSentAt:1000,at:90000,n:10},'http');d.packet({kind:'h264',test:4,seg:2,sourceSentAt:1100,at:90140,n:11},'http');d.packet({kind:'h264',test:4,seg:4,sourceSentAt:1300,at:90400,n:13},'http');const p=d.export().events.filter(e=>e.type==='packet');assert.equal(p[1].sourceGapMs,100);assert.equal(p[1].serverGapMs,140);assert.equal(p[1].serverSequence,11);assert.equal(p[2].sourceGapMs,null);assert.equal(p[2].serverGapMs,null);
});
