import { randomUUID } from 'node:crypto';
import { unpack } from '../cloud/stream-protocol.mjs';
import { readVideo } from '../cloud/http-video.js';

const base = 'https://glass-2412.youqlrqod.workers.dev';
const controller = new AbortController();
const samples = { websocket: [], http: [] };
const record = (transport, m) => {
  if (m.kind !== 'h264' || m.config || !Number.isSafeInteger(m.seg)) return;
  samples[transport].push({ test: m.test, seg: m.seg, serverAt: m.at, at: performance.now() });
};
const ws = new WebSocket(base.replace('https:', 'wss:') + '/cam/ws?binary=1');
ws.binaryType = 'arraybuffer';
ws.onmessage = ({ data }) => {
  if (!(data instanceof ArrayBuffer)) return;
  const { meta } = unpack(data);
  if (Number.isSafeInteger(meta.n)) ws.send(JSON.stringify({ ack: meta.n }));
  record('websocket', meta);
};
const timer = setTimeout(() => controller.abort(), 90000);
try {
  const response = await fetch(base + '/cam/live?viewer=' + randomUUID(), { signal: controller.signal });
  if (!response.ok) throw Error('HTTP ' + response.status);
  await readVideo(response.body, m => record('http', m), controller.signal);
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  clearTimeout(timer);
  ws.close();
}
const key = p => p.test + ':' + p.seg;
const http = new Map(samples.http.map(p => [key(p), p]));
const shared = samples.websocket.filter(p => http.has(key(p)));
const pairs = shared.slice(1).map((p, i) => {
  const prev = shared[i];
  return { websocket: p.at - prev.at, http: http.get(key(p)).at - http.get(key(prev)).at, server: p.serverAt - prev.serverAt };
}).filter((_, i) => shared[i].test === shared[i+1].test && shared[i+1].seg === shared[i].seg + 1);
const stats = field => {
  const values = pairs.map(p => p[field]).sort((a,b) => a-b);
  return values.length ? { p95: Math.round(values[Math.floor((values.length-1)*.95)]), max: Math.round(values.at(-1)), over500: values.filter(x => x > 500).length } : null;
};
console.log(JSON.stringify({ packets: Object.fromEntries(Object.entries(samples).map(([k,v]) => [k,v.length])), matchedConsecutivePairs: pairs.length, gapsMs: { server: stats('server'), websocket: stats('websocket'), http: stats('http') } }, null, 2));
