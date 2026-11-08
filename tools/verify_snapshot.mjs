// Restore a private backup into disposable SQLite only. Never contacts glasses.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {LocalGlassRoom,localTargets} from './local-worker.mjs';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
const videos=JSON.parse(fs.readFileSync(new URL('../server/videos.json',import.meta.url),'utf8'));
const validated=localTargets(snapshot,videos),db=new DatabaseSync(':memory:');
const storage={sql:{exec(query,...args){const s=db.prepare(query);if(/^SELECT/i.test(query))return {toArray:()=>s.all(...args)};s.run(...args);return {toArray:()=>[]}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
const env={ASSETS:{fetch:async()=>Response.json(videos)}},room=new LocalGlassRoom({storage,getWebSockets:()=>[]},env);
const response=await room.fetch(new Request('http://restore.test/local/import',{method:'POST',body:JSON.stringify(snapshot)}));
assert.equal(response.status,200);
const normalize=targets=>targets.map(t=>({id:t.id,name:t.name,key:t.key,appearance:t.appearance??null,
  images:t.images.map(i=>({id:i.id,image:i.image,created_at:i.created_at,capture:i.capture??null})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id));
assert.deepEqual(normalize(room.targets(true)),normalize(validated.targets));
for(const original of snapshot.targets)assert.deepEqual(room.targets(true).find(t=>t.id===original.id).appearance,original.appearance??null);
assert.deepEqual(room.guide.config,validated.guide);
const restarted=new LocalGlassRoom({storage,getWebSockets:()=>[]},env);
assert.deepEqual(normalize(restarted.targets(true)),normalize(validated.targets));
assert.deepEqual(restarted.guide.config,validated.guide);
console.log(JSON.stringify({restored:true,restartPreserved:true,targets:validated.targets.length,images:validated.targets.reduce((n,t)=>n+t.images.length,0),idsPhotosVectorsCalibrationEqual:true}));
db.close();
