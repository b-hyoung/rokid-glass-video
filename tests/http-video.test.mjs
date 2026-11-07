import test from 'node:test';
import assert from 'node:assert/strict';
import {readVideo} from '../cloud/http-video.js';
import {pack} from '../cloud/stream-protocol.mjs';
function packet(meta,bytes){const inner=new Uint8Array(pack(meta,bytes)),out=new Uint8Array(inner.length+4);new DataView(out.buffer).setUint32(0,inner.length);out.set(inner,4);return out}
test('HTTP transport accepts arbitrary network boundaries without losing or merging frames',async()=>{
 const data=new Uint8Array([0,0,0,1,0x65,0x80]),packets=Array.from({length:20},(_,seg)=>packet({test:1,seg,frames:6,complete:true},data));
 const all=new Uint8Array(packets.reduce((n,b)=>n+b.length,0));let at=0;for(const p of packets){all.set(p,at);at+=p.length}
 let offset=0;const stream=new ReadableStream({pull(controller){if(offset===all.length){controller.close();return}const n=Math.min(all.length-offset,1+(offset*17)%117);controller.enqueue(all.slice(offset,offset+n));offset+=n}}),received=[];
 await readVideo(stream,m=>received.push(m),new AbortController().signal);
 assert.equal(received.length,20);assert.deepEqual(received.map(m=>m.seg),Array.from({length:20},(_,n)=>n));assert.equal(received.reduce((n,m)=>n+m.frames,0),120);for(const m of received)assert.deepEqual(m.bytes,data);
});
test('HTTP packet parser rejects oversized lengths and cancels the reader',async()=>{
 let canceled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array([255,255,255,255]))},cancel(){canceled=true}});
 await assert.rejects(readVideo(stream,()=>{},new AbortController().signal),/영상 패킷/);assert.equal(canceled,true);
});
test('HTTP reader reports an incomplete final packet instead of silently accepting it',async()=>{
 const data=packet({seg:1},new Uint8Array([1,2,3]));
 const stream=new ReadableStream({start(c){c.enqueue(data.slice(0,-1));c.close()}});
 await assert.rejects(readVideo(stream,()=>assert.fail('partial packet delivered'),new AbortController().signal),/중간에 끊겼습니다/);
});
