import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsBounds,featureBounds,affineProjection} from '../cloud/matcher.js';

const corners=[[.2,.1],[.8,.1],[.8,.9],[.2,.9]];
test('photo-only matches accept flat OpenCV coordinates spread over the object',()=>{
  assert.equal(supportsBounds(corners,[300,200,700,200,700,400,300,400],new Uint8Array([1,1,1,1]),1000,600),true);
});
test('a tiny matched patch cannot claim a large object rectangle',()=>{
  assert.equal(supportBounds([480,280,520,280,520,320,480,320],[1,1,1,1]),false);
});
test('outlier features do not expand the matched object coverage',()=>{
  assert.equal(supportBounds([480,280,520,280,520,320,480,320,300,200,700,400],[1,1,1,1,0,0]),false);
});
function supportBounds(points,mask){return supportsBounds(corners,points,new Uint8Array(mask),1000,600)}

test('centered title matches use its feature footprint instead of empty photo margins',()=>{
  const points=Array.from({length:30},(_,i)=>[210+i%6*40,136+Math.floor(i/6)*20]).flat();
  const [l,t,r,b]=featureBounds(points,640,360),support=[[l/640,t/360],[r/640,t/360],[r/640,b/360],[l/640,b/360]];
  const mask=new Uint8Array(30).fill(1);
  assert.equal(supportsBounds([[0,0],[1,0],[1,1],[0,1]],points,mask,640,360),false);
  assert.equal(supportsBounds(support,points,mask,640,360),true);
  const small=points.map((v,i)=>i%2?180+(v-180)*.1:320+(v-320)*.1);
  assert.equal(supportsBounds(support,small,mask,640,360),false);
});

test('empty, degenerate, and masked-out feature evidence never authorizes a photo',()=>{
  assert.deepEqual(featureBounds([],640,360),[0,0,640,360]);
  assert.equal(supportsBounds([[.5,.5],[.5,.5],[.5,.5],[.5,.5]],[500,300],new Uint8Array([1]),1000,600),false);
  assert.equal(supportBounds([300,200,700,400],[0,0]),false);
});

test('a compact title uses a consistent affine fit to stabilize blank image corners',()=>{
  const source=Array.from({length:20},(_,i)=>[200+i%5*40,140+Math.floor(i/5)*20]).flat();
  const transform=(x,y)=>[x*.5+y*.02+90,-x*.01+y*.5+400];
  const target=source.flatMap((x,i)=>i%2?[]:transform(x,source[i+1]));
  const vertices=[0,0,640,0,640,360,0,360];
  const projected=affineProjection(source,target,new Uint8Array(20).fill(1),vertices);
  const expected=vertices.flatMap((x,i)=>i%2?[]:transform(x,vertices[i+1]));
  assert.ok(projected.every((n,i)=>Math.abs(n-expected[i])<1e-8));
  const wrong=[...target];wrong[0]+=40;
  assert.equal(affineProjection(source,wrong,new Uint8Array(20).fill(1),vertices),null);
  const mask=new Uint8Array(20).fill(1);mask[0]=0;
  assert.ok(affineProjection(source,wrong,mask,vertices));
});

test('collinear title strokes cannot establish an affine object rectangle',()=>{
  const points=Array.from({length:20},(_,i)=>[i*3,100]).flat();
  assert.equal(affineProjection(points,points,new Uint8Array(20).fill(1),[0,0,640,360]),null);
});
