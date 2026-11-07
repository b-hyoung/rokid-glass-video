// Replay measured packet arrival times without a server, decoder or wall-clock delay.
// This isolates display pacing; results are not capture-to-display latency.
// node tools/check_display_queue.mjs trace.json [previous-frame-player.js]
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const [tracePath,baselinePath]=process.argv.slice(2);
if(!tracePath)throw Error('Expected a JSON file containing packets: [{clientAt, frames}]');
const packets=JSON.parse(fs.readFileSync(tracePath)).packets;
assert.ok(packets.length>1);
const current=fs.readFileSync(new URL('../cloud/frame-player.js',import.meta.url),'utf8');
const policies=[['current-200ms',current],['candidate-150ms',current.replace('MAX_WAIT_MS=200','MAX_WAIT_MS=150')]];
if(baselinePath)policies.unshift(['previous-800ms-start250',fs.readFileSync(baselinePath,'utf8')]);
function replay(source,hz){
  let now=0,id=0,index=0,nextTick=0;const waits=[],displayTimes=[],closed=new Set();
  const Player=vm.runInNewContext(source.replace('export class FramePlayer','class FramePlayer')+'\nFramePlayer;', {performance:{now:()=>now}});
  const player=new Player(f=>{waits.push(now-f.received);displayTimes.push(now)});
  const start=packets[0].clientAt,end=packets.at(-1).clientAt-start+1200;
  while(nextTick<=end){
    if(index<packets.length&&packets[index].clientAt-start<=nextTick){
      const packet=packets[index++];now=packet.clientAt-start;
      assert.ok(Number.isInteger(packet.frames)&&packet.frames>0);
      for(let i=0;i<packet.frames;i++){
        const frameId=id++,received=now;
        player.push({clone:()=>({received,close:()=>{assert.ok(!closed.has(frameId));closed.add(frameId)}})},0,60);
      }
    }else{now=nextTick;const before=player.shown;player.tick(now);assert.ok(player.shown-before<=1);nextTick+=1000/hz}
  }
  assert.equal(player.decoded,player.shown+player.dropped+player.queue.length);
  assert.equal(closed.size,id);assert.equal(player.queue.length,0);
  waits.sort((a,b)=>a-b);
  const pct=p=>Math.round(waits[Math.floor((waits.length-1)*p)]*10)/10;
  return {hz,received:id,shown:player.shown,dropped:player.dropped,drops:player.drops,maxQueue:player.maxQueue,
    displayFps:Number(((displayTimes.length-1)*1000/(displayTimes.at(-1)-displayTimes[0])).toFixed(2)),
    decodedToDisplayWaitMs:{p50:pct(.5),p95:pct(.95),max:pct(1)}};
}
console.log(JSON.stringify({description:'Actual packet timing replay; display queue only, no network or decoding.',results:policies.flatMap(([policy,source])=>[60,144].map(hz=>({policy,...replay(source,hz)})))},null,2));
