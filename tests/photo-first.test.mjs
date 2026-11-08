import test from 'node:test';
import assert from 'node:assert/strict';
import {VisionEngine} from '../cloud/vision-engine.js';

const corners=[[.2,.2],[.8,.2],[.8,.8],[.2,.8]];
function scene(){
  const calls=[],tracks=new Map();
  const state={tile:0,photoScan:0,lastPhotoFirst:-Infinity,tracks,ctx:{getImageData:(x,y,width,height)=>({width,height})}};
  state.matcher={refs:[{id:'photo',photoOnly:true},{id:'object',photoOnly:false}],detect(pixels,options){calls.push([...options.targetIds]);return options.targetIds.has('photo')?[{id:'photo',corners,inliers:20}]:[{id:'object',corners,inliers:15}]}};
  const scan=(at,recognize=true)=>VisionEngine.prototype.detectScene.call(state,{width:1000,height:800},recognize,at);
  return {state,tracks,calls,scan};
}

test('a new geometric photo match is published before unrelated object searches',()=>{
  const {state,calls,scan}=scene();
  const first=scan(1000);
  assert.deepEqual(first.map(d=>d.id),['photo']);
  assert.deepEqual(calls,[['photo']]);assert.equal(state.deferAppearance,true);
  assert.ok(first[0].corners.every(([x,y])=>x>=0&&x<=1&&y>=0&&y<=1));
});

test('the next scan resumes background objects and never defers them continuously',()=>{
  const {state,tracks,calls,scan}=scene();scan(1000);
  tracks.set('photo',{held:false});calls.length=0;
  assert.deepEqual(scan(1650).map(d=>d.id),['photo','object']);
  assert.equal(state.deferAppearance,false);assert.equal(calls.filter(c=>c.includes('object')).length,2);
  tracks.clear();calls.length=0;scan(1900);
  assert.equal(state.deferAppearance,false);assert.ok(calls.some(c=>c.includes('object')));
});

test('a failed photo search does not delay other registered targets',()=>{
  const {state,calls,scan}=scene();
  state.matcher.detect=(pixels,options)=>{calls.push([...options.targetIds]);return options.targetIds.has('photo')?[]:[{id:'object',corners,inliers:15}]};
  assert.deepEqual(scan(1000).map(d=>d.id),['object']);
  assert.equal(state.deferAppearance,false);assert.ok(calls.some(c=>c.includes('object')));
});

test('registration verification searches all identities in the same scan',()=>{
  const {state,scan}=scene();
  assert.deepEqual(scan(1000,false).map(d=>d.id),['photo','object']);
  assert.equal(state.deferAppearance,false);
});
