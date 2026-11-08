import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {TargetStore} from '../cloud/target-store.mjs';

test('target metadata is one cached aggregate and full library needs two selects',()=>{
  const db=new DatabaseSync(':memory:');let selects=0,depth=0;
  const storage={sql:{exec(q,...a){const s=db.prepare(q);if(/^SELECT/i.test(q)){selects++;return {toArray:()=>s.all(...a)}}s.run(...a);return {toArray:()=>[]}}},transactionSync(fn){const outer=depth++===0;if(outer)db.exec('BEGIN');try{const r=fn();if(outer)db.exec('COMMIT');return r}catch(e){if(outer)db.exec('ROLLBACK');throw e}finally{depth--}}};
  const store=new TargetStore(storage),a=store.create('A','a','photo-a'),b=store.create('B','b','photo-b');
  selects=0;const first=store.list();assert.equal(selects,1);store.list();assert.equal(selects,1);
  first[0].imageCount=900;assert.equal(store.list()[0].imageCount,1);
  selects=0;const full=store.list(true);assert.equal(selects,2);assert.deepEqual(full.map(t=>t.images.length),[1,1]);
  store.addImage(a,'another');assert.equal(store.list()[0].imageCount,2);
  store.deleteImage(a,store.list(true)[0].images[0].id);assert.equal(store.list()[0].imageCount,1);
  store.deleteTarget(b);assert.equal(store.list().length,1);
  const before=store.list(true);
  assert.throws(()=>store.saveVectors({name:'C',key:'a',pack:{},images:[null]}));
  assert.deepEqual(store.list(true),before);assert.equal(store.list().length,1);
  db.close();
});
