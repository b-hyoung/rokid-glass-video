import test from 'node:test';
import assert from 'node:assert/strict';
import {searchReferences} from '../cloud/matcher.js';
import {regionProposals,selectProposals} from '../cloud/region-proposals.mjs';
import {clipFrameQuad} from '../cloud/quad-geometry.mjs';

test('frame-edge fitting tolerates subpixel error but rejects off-screen geometry',()=>{
 assert.deepEqual(clipFrameQuad([[-.001,0],[1.001,0],[1.001,1.001],[-.001,1.001]],640,360),[[0,0],[1,0],[1,1],[0,1]]);
 assert.equal(clipFrameQuad([[-.02,0],[1,0],[1,1],[0,1]],640,360),null);
 assert.equal(clipFrameQuad([[NaN,0],[1,0],[1,1],[0,1]],640,360),null);
});

test('bounded fallback rotates across identities and views without a large bank starving others',()=>{
 const refs=Array.from({length:12},(_,id)=>Array.from({length:id===0?60:4},(_,view)=>({id:String(id),view}))).flat(),seen=new Set();
 for(let offset=0;offset<260;offset++){
  const selected=searchReferences(refs,3,offset);assert.equal(selected.length,3);
  assert.equal(new Set(selected).size,selected.length);for(const ref of selected)seen.add(ref.id+':'+ref.view);
 }
 for(const ref of refs)assert.ok(seen.has(ref.id+':'+ref.view));
 assert.equal(searchReferences(refs).length,refs.length);
});
function pixels(width,height,color){const data=new Uint8ClampedArray(width*height*4);for(let i=0;i<width*height;i++){data.set([...color,255],i*4)}return {data,width,height}}
function rect(image,x,y,width,height,color){for(let row=y;row<y+height;row++)for(let col=x;col<x+width;col++)image.data.set([...color,255],(row*image.width+col)*4)}
function overlap(a,b){const intersection=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return intersection/((a.right-a.left)*(a.bottom-a.top)+(b.right-b.left)*(b.bottom-b.top)-intersection)}
test('a dark object beside an antialiased black margin keeps its own rectangle',()=>{
 const image=pixels(144,256,[210,210,210]);rect(image,0,0,6,256,[5,5,5]);rect(image,6,0,1,256,[30,30,30]);rect(image,7,140,52,52,[60,60,60]);
 const proposals=regionProposals(image),expected={left:7/144,right:59/144,top:140/256,bottom:192/256};
 assert.ok(proposals.some(box=>overlap(box,expected)>.85));
 assert.ok(proposals.every(box=>Number(box.left<=2/144)+Number(box.right>=1-2/144)+Number(box.top<=2/256)+Number(box.bottom>=1-2/256)<=1));
});
test('pale compact objects have candidates without assigning a registered identity',()=>{
 const image=pixels(144,256,[145,145,145]);rect(image,91,112,20,18,[235,235,235]);rect(image,96,109,10,5,[25,25,25]);
 const expected={left:91/144,right:111/144,top:112/256,bottom:130/256},boxes=regionProposals(image);
 assert.ok(boxes.some(box=>overlap(box,expected)>.5));assert.ok(boxes.every(box=>!('id' in box)));
});
test('proposal selection stays bounded and covers separate image cells',()=>{
 const boxes=Array.from({length:30},(_,i)=>({left:.1+i*.0001,top:.1,right:.2+i*.0001,bottom:.2,score:10-i*.01}));
 boxes.push({left:.72,top:.7,right:.84,bottom:.82,score:.1});
 const selected=selectProposals(boxes,3,0);assert.ok(selected.length<=3);assert.ok(selected.some(b=>b.left>.7));assert.equal(new Set(selected).size,selected.length);
});
