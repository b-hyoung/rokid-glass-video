import test from 'node:test';
import assert from 'node:assert/strict';
import {GlassDecoder} from '../cloud/decoder.js';

test('decoder accounts for missing configuration and keyframe waits after a lost packet',()=>{
 const priorDecoder=globalThis.VideoDecoder,priorChunk=globalThis.EncodedVideoChunk;
 const frames=[];
 globalThis.EncodedVideoChunk=class{constructor(value){Object.assign(this,value)}};
 globalThis.VideoDecoder=class{
  state='unconfigured';decodeQueueSize=0;
  constructor(callbacks){this.callbacks=callbacks}
  configure(){this.state='configured'}
  decode(chunk){this.callbacks.output({timestamp:chunk.timestamp,close(){}})}
  close(){this.state='closed'}
 };
 try{
  const decoder=new GlassDecoder(f=>frames.push(f.timestamp),e=>assert.fail(e.message));
  const send=(seg,units)=>decoder.push({test:1,seg,fps:60,at:Date.now(),complete:true,bytes:new Uint8Array(units.flatMap(n=>[0,0,0,1,...n]))});
  send(0,[[0x41,0x80]]); // No codec configuration yet.
  send(1,[[0x67,0x42,0,31],[0x68,0],[0x65,0x80]]);
  send(3,[[0x41,0x80],[0x41,0x80]]); // Missing segment 2 loses references.
  send(4,[[0x65,0x80],[0x41,0x80]]);
  assert.equal(frames.length,3);assert.equal(decoder.counters.submitted,3);
  assert.equal(decoder.counters.output,3);assert.equal(decoder.counters.segmentGaps,1);
  assert.equal(decoder.counters.skippedNoConfig,1);assert.equal(decoder.counters.skippedUntilKey,2);
  assert.equal(decoder.counters.errors,0);decoder.reset();
 }finally{globalThis.VideoDecoder=priorDecoder;globalThis.EncodedVideoChunk=priorChunk}
});
