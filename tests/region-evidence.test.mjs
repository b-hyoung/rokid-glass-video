import test from 'node:test';
import assert from 'node:assert/strict';
import {isStrongRegion,RegionEvidence} from '../cloud/region-evidence.mjs';

const rectangle=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];

test('only compact, strongly matched boxes can be used on their first scan',()=>{
  const compact=rectangle(.2,.3,.2,.15);
  assert.equal(isStrongRegion(.8,.8,.12,compact),true);
  assert.equal(isStrongRegion(.8,.72,.12,compact),false);
  assert.equal(isStrongRegion(.8,.8,.045,compact),false);
  assert.equal(isStrongRegion(.8,.8,.12,rectangle(.2,.3,.5,.4)),false);
  const evidence=new RegionEvidence();
  assert.equal(evidence.confirm('bag',compact,1000,null,true),true);
  assert.equal(evidence.pending.has('bag'),false);
  assert.equal(evidence.confirm('bag',rectangle(.7,.7,.1,.1),1400,compact,true),false);
});

test('one match and a jump to a nearby object cannot authorize a region',()=>{
  const evidence=new RegionEvidence();
  const bag=rectangle(.2,.3,.2,.15),chair=rectangle(.2,.55,.24,.21);
  assert.equal(evidence.confirm('bag',chair,1000),false);
  assert.equal(evidence.confirm('bag',bag,1500),false);
  assert.equal(evidence.confirm('bag',bag,1500),false);
  assert.equal(evidence.confirm('bag',rectangle(.21,.3,.2,.15),2050),true);
  assert.equal(evidence.confirm('bag',chair,2500,bag),false);
  assert.equal(evidence.confirm('bag',bag,3000,bag),true);
});

test('confirmation of one target does not consume another target’s evidence',()=>{
  const evidence=new RegionEvidence();
  const car=rectangle(.2,.4,.2,.1),headset=rectangle(.6,.3,.2,.2);
  assert.equal(evidence.confirm('car',car,1000),false);
  assert.equal(evidence.confirm('headset',headset,1000),false);
  assert.equal(evidence.confirm('car',car,1500),true);
  assert.equal(evidence.confirm('headset',headset,1500),true);
});

test('a moderately shifted box can be confirmed on a second scan',()=>{
  const evidence=new RegionEvidence();
  assert.equal(evidence.confirm('bag',rectangle(.2,.3,.2,.15),1000),false);
  assert.equal(evidence.confirm('bag',rectangle(.258,.3,.2,.15),1500),true);
});
