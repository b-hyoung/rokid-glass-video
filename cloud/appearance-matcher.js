import { APPEARANCE_MODEL } from './appearance-format.mjs';

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

  async detect(canvas, aim) {
    if (!this.refs.length) return null;
    const session = await this.session();
    const data = new Float32Array(3 * 3 * PIXELS);
    const square = this.square.getContext('2d');
    const input = this.input.getContext('2d', {willReadFrequently:true});
    square.imageSmoothingQuality = input.imageSmoothingQuality = 'high';
    for (const [index, scale] of [.35, .55, .75].entries()) {
      const x = Math.round(canvas.width * Math.max(0, aim.cx - scale / 2));
      const y = Math.round(canvas.height * Math.max(0, aim.cy - scale / 2));
      const right = Math.round(canvas.width * Math.min(1, aim.cx + scale / 2));
      const bottom = Math.round(canvas.height * Math.min(1, aim.cy + scale / 2));
      square.drawImage(canvas, x, y, right-x, bottom-y, 0, 0, SIDE, SIDE);
      input.drawImage(this.square, 0, 0, 256, 256);
      const rgba = input.getImageData(16, 16, SIDE, SIDE).data;
      for (let ch = 0; ch < 3; ch++) {
        const offset = (index * 3 + ch) * PIXELS;
        for (let pixel = 0; pixel < PIXELS; pixel++) {
          data[offset + pixel] = (rgba[pixel * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
        }
      }
    }
    const output = await session.run({image: new self.ort.Tensor('float32', data, [3, 3, SIDE, SIDE])});
    const features = output.features.data;
    const ranked = this.refs.map(ref => {
      let best = -1;
      for (const vector of ref.appearance.vectors) {
        for (let i = 0; i < 3; i++) {
          let score = 0;
          for (let j = 0; j < vector.length; j++) score += vector[j] * features[i * vector.length + j];
          best = Math.max(best, score);
        }
      }
      return {id:ref.id, score:best};
    }).sort((a,b) => b.score-a.score);
    const [first, second] = ranked;
    return first.score >= .72 && (!second || first.score - second.score >= .05) ? first.id : null;
  }
}
