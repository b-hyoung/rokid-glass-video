// One analysis request at a time; the caller samples the newest displayed frame.
// Recognition never queues video or runs OpenCV on the presentation thread.
export class VisionClient {
  constructor(){
    this.worker=new Worker('/cloud/vision-worker.js');this.pending=new Map();this.next=0;this.refs=[];
    this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject});
    this.worker.onmessage=({data:d})=>{if(d.ready){this.resolve();return}const p=this.pending.get(d.id);if(!p){if(d.error)this.reject(Error(d.error));return}this.pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.result)};
    this.worker.onerror=e=>{const error=Error('인식 엔진: '+e.message);this.reject(error);for(const p of this.pending.values())p.reject(error);this.pending.clear()};
  }
  async call(type,data={},transfer=[]){await this.ready;const id=++this.next;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,type,...data},transfer)})}
  async references(targets){const result=await this.call('references',{targets});this.refs=targets.flatMap(t=>t.images||[]);return result}
  reset(){return this.call('reset')}
  async process(canvas,options){const bitmap=await createImageBitmap(canvas);return this.call('frame',{bitmap,options},[bitmap])}
}
