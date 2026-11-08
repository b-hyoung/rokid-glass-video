import { APPEARANCE_MODEL } from './appearance-format.mjs';
import { regionProposals } from './region-proposals.mjs';
import { isStrongRegion,regionOverlap } from './region-evidence.mjs';

const RUNTIME = '/cloud/ort/';
const MEAN = [.485, .456, .406], STD = [.229, .224, .225];
const SIDE = 224, PIXELS = SIDE * SIDE;

export class AppearanceMatcher {
  constructor() {
    this.refs = [];
    this.square = new OffscreenCanvas(224, 224);
    this.input = new OffscreenCanvas(256, 256);
  }

  setReferences(targets) {
    this.refs = targets.filter(target => target.appearance?.model === APPEARANCE_MODEL);
    this.photoFeatures = new Map();
  }

  async session() {
    if (!this.loading) {
      this.loading = (async () => {
        if (!self.ort) importScripts(RUNTIME + 'ort.wasm.min.js');
        self.ort.env.wasm.wasmPaths = RUNTIME;
        self.ort.env.wasm.numThreads = 1;
        return self.ort.InferenceSession.create('/cloud/appearance-v1.onnx', {executionProviders:['wasm']});
      })().catch(error => {
        this.loading = null;
        throw Error('벡터 인식 모델을 열 수 없습니다: ' + error.message);
      });
    }
    return this.loading;
  }

  async embed(crops) {
    if (!crops.length) return [];
    const session = await this.session();
    // The exported model takes three crops per call. Unused slots are ignored.
    const batchSize = 3;
    const data = new Float32Array(batchSize * 3 * PIXELS);
    const square = this.square.getContext('2d');
    const input = this.input.getContext('2d', {willReadFrequently:true});
    square.imageSmoothingQuality = input.imageSmoothingQuality = 'high';
    const embeddings = [];
    for (let start = 0; start < crops.length; start += batchSize) {
      const batch = crops.slice(start, start + batchSize);
      for (const [index, {image,x,y,width,height}] of batch.entries()) {
        square.drawImage(image, x, y, width, height, 0, 0, SIDE, SIDE);
        input.drawImage(this.square, 0, 0, 256, 256);
        const rgba = input.getImageData(16, 16, SIDE, SIDE).data;
        for (let ch = 0; ch < 3; ch++) {
          const offset = (index * 3 + ch) * PIXELS;
          for (let pixel = 0; pixel < PIXELS; pixel++) {
            data[offset + pixel] = (rgba[pixel * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
          }
        }
      }
      const output = await session.run({image: new self.ort.Tensor('float32', data, [batchSize, 3, SIDE, SIDE])});
      const features = output.features.data;
      const length = features.length / batchSize;
      for (let index = 0; index < batch.length; index++) {
        embeddings.push(features.slice(index * length, (index + 1) * length));
      }
    }
    return embeddings;
  }

  rank(embedding) {
    return this.refs.map(ref=>({ref,score:bestSimilarity(embedding,ref.appearance.vectors)}))
      .sort((a,b)=>b.score-a.score);
  }

  async confirm(canvas, detections) {
    const crops = detections.map(detection=>{
      const xs = detection.corners.map(([x])=>x*canvas.width);
      const ys = detection.corners.map(([,y])=>y*canvas.height);
      const x=Math.floor(Math.min(...xs)), y=Math.floor(Math.min(...ys));
      return {image:canvas,x,y,width:Math.ceil(Math.max(...xs))-x,height:Math.ceil(Math.max(...ys))-y};
    });
    const confirmed = new Set();
    const embeddings = await this.embed(crops);
    for (const [index, embedding] of embeddings.entries()) {
      const [first, second] = this.rank(embedding);
      if (first?.ref.id===detections[index].id && passes(first,second,.70,.045)) confirmed.add(first.ref.id);
    }
    return confirmed;
  }

  async photoEmbeddings(ref) {
    if (this.photoFeatures.has(ref.id)) return this.photoFeatures.get(ref.id);
    // Spread a bounded number of comparisons across the saved views.
    const photos=ref.images??[];
    const count=Math.min(8,photos.length);
    const images=[];
    try {
      for(let i=0;i<count;i++){
        const photo=photos[Math.round(i*(photos.length-1)/Math.max(1,count-1))];
        const bitmap=await createImageBitmap(await (await fetch(photo.image)).blob());
        images.push(bitmap);
      }
      const embeddings=await this.embed(images.map(image=>({image,x:0,y:0,width:image.width,height:image.height})));
      this.photoFeatures.set(ref.id,embeddings);
      return embeddings;
    } finally {
      for(const image of images)image.close();
    }
  }

  async atAim(canvas,aim,located) {
    if (!this.refs.some(ref=>ref.images?.length&&!located.has(ref.id))) return null;
    const crops=[.35,.55,.75].map(scale=>{
      const x=Math.round(canvas.width*Math.max(0,aim.cx-scale/2));
      const y=Math.round(canvas.height*Math.max(0,aim.cy-scale/2));
      const right=Math.round(canvas.width*Math.min(1,aim.cx+scale/2));
      const bottom=Math.round(canvas.height*Math.min(1,aim.cy+scale/2));
      return {image:canvas,x,y,width:right-x,height:bottom-y};
    });
    let best=null;
    for(const embedding of await this.embed(crops)){
      const [first,second]=this.rank(embedding);
      if(!passes(first,second)||located.has(first.ref.id)||!first.ref.images?.length)continue;
      const photoScore=bestSimilarity(embedding,await this.photoEmbeddings(first.ref));
      if(photoScore>=.72&&(!best||first.score>best.score))best=first;
    }
    return best?.ref.id??null;
  }

  async locate(canvas,located,hints=new Map(),flowed=new Set(),scanScene=true) {
    if(!this.refs.some(ref=>ref.images?.length&&!located.has(ref.id)))return [];
    this.proposalCanvas??=new OffscreenCanvas(144,144);
    const small=this.proposalCanvas;
    small.height=Math.max(1,Math.round(144*canvas.height/canvas.width));
    const ctx=small.getContext('2d',{willReadFrequently:true});
    const candidates=[];
    for(const id of flowed){
      if(located.has(id)||!hints.has(id))continue;
      const corners=hints.get(id),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
      candidates.push({left:Math.min(...xs),top:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys),expected:id});
      if(candidates.length===3)break;
    }
    if(scanScene){
      ctx.drawImage(canvas,0,0,small.width,small.height);
      for(const box of regionProposals(ctx.getImageData(0,0,small.width,small.height))){
        if(candidates.some(other=>!other.expected&&overlaps(box,other)))continue;
        candidates.push(box);
        if(candidates.length===9)break;
      }
    }
    const crops=candidates.map(({left,top,right,bottom})=>({
      image:canvas,x:left*canvas.width,y:top*canvas.height,
      width:(right-left)*canvas.width,height:(bottom-top)*canvas.height
    }));
    const best=new Map();
    const retry=new Map();
    const accept=async(i,embedding,expected)=>{
      const [first,second]=this.rank(embedding);
      if(!first||(expected&&first.ref.id!==expected)||located.has(first.ref.id)||!first.ref.images?.length)return;
      const standard=passes(first,second,.68,.045);
      // Edge-derived crops can exclude a small part of the object. Accept a
      // weaker vector score only with greater separation and photo agreement.
      const separated=passes(first,second,.65,.12);
      if(!standard&&!separated){
        if(!expected&&first.score>=.58&&(!second||first.score-second.score>=.05)&&
            first.score>(retry.get(first.ref.id)?.score??0))retry.set(first.ref.id,{i,score:first.score});
        return;
      }
      const photoScore=bestSimilarity(embedding,await this.photoEmbeddings(first.ref));
      const {left,top,right,bottom}=candidates[i];
      const corners=[[left,top],[right,top],[right,bottom],[left,bottom]];
      const hint=hints.get(first.ref.id);
      const score=(first.score+photoScore)/2+(hint?regionOverlap(corners,hint)*.035:0);
      if(photoScore<(standard ? .68 : .72)){
        if(!expected&&first.score>(retry.get(first.ref.id)?.score??0))retry.set(first.ref.id,{i,score:first.score});
        return;
      }
      if((best.get(first.ref.id)?.score??0)>=score)return;
      const strong=!expected&&isStrongRegion(first.score,photoScore,first.score-(second?.score??-1),corners);
      best.set(first.ref.id,{id:first.ref.id,corners,score,inliers:0,region:true,strong});
    };
    for(const [i,embedding] of (await this.embed(crops)).entries())await accept(i,embedding,candidates[i].expected);
    const uncertain=[...retry].filter(([id])=>!best.has(id)).map(([id,entry])=>({id,...entry}))
      .sort((a,b)=>b.score-a.score).slice(0,3);
    const contextCrops=uncertain.map(({i})=>{
      const {x,y,width,height}=crops[i];
      const left=Math.max(0,x-width*.13),top=Math.max(0,y-height*.13);
      const right=Math.min(canvas.width,x+width*1.13),bottom=Math.min(canvas.height,y+height*1.13);
      return {image:canvas,x:left,y:top,width:right-left,height:bottom-top};
    });
    for(const [j,embedding] of (await this.embed(contextCrops)).entries()){
      await accept(uncertain[j].i,embedding,uncertain[j].id);
    }
    return [...best.values()];
  }
}

function overlaps(a,b){
  const shared=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
    Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  return shared>.65*Math.max((a.right-a.left)*(a.bottom-a.top),(b.right-b.left)*(b.bottom-b.top));
}

function bestSimilarity(embedding, vectors){
  let best=-Infinity;
  for(const vector of vectors){
    let score=0;
    for(let j=0;j<vector.length;j++)score+=embedding[j]*vector[j];
    best=Math.max(best,score);
  }
  return best;
}

function passes(first,second,minScore=.72,minMargin=.05){
  return first?.score>=minScore&&(!second||first.score-second.score>=minMargin);
}
