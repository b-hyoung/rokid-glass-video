// 2412호 데모: 안경 카메라가 본 것을 인식 → 하나 고르기 → 확정 → /play → 안경 화면.
// 좌표는 블렌더(미터, Z 위)로 적고 B()로 three.js(Y 위)로 바꾼다. 방 배치는 jvision-vr-tour 4층 모델(가정 배치) 기준.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const $ = s => document.querySelector(s);
const B = (x, y, z) => new THREE.Vector3(x, z, -y);
const GREEN = '#3dff5a';
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') ? '&token=' + encodeURIComponent(qs.get('token')) : '';

// 판단 기준(현장에서 조정할 값)
const RULE = {
  dwell: 1.0,        // 아무것도 안 나올 때 확정까지 머무는 시간(초)
  switchDwell: 2.0,  // 이미 재생 중일 때 다른 대상으로 바꾸는 시간(초)
  aimR: 0.14,        // 조준점에서 이 거리(화면 높이 비율) 안의 대상만 후보
  tie: 0.05,         // 1등과 2등의 조준 거리 차가 이보다 작으면 애매함
  minConf: 0.55,     // 후보가 되는 인식 점수
  seeConf: 0.35,     // 인식 상자로 보이는 최소 점수
  grace: 0.35,       // 잠깐 놓쳐도 머무르기 시간을 유지하는 시간(초)
  cooldown: 4,       // 끈 대상은 이 시간 동안 다시 틀지 않음(초)
};

// ───── 기본 장면 ─────
const view = $('#view'), gl = $('#gl'), ov = $('#ov'), video = $('#glass'), dim = $('#dim');
const g2 = ov.getContext('2d');
const renderer = new THREE.WebGLRenderer({canvas: gl, antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#cfd6d2');
const camera = new THREE.PerspectiveCamera(62, 1, 0.03, 200);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xffffff, 0x8f8778, 2.2));
const sun = new THREE.DirectionalLight(0xfff4e2, 1.1);
sun.position.copy(B(2, -6, 12));
scene.add(sun);

const mat = (color, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({color, roughness: rough, metalness: metal});
const occluders = [];
function box(x0, x1, y0, y1, z0, z1, m) { // 블렌더 좌표의 축 정렬 상자
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0), m);
  mesh.position.copy(B((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
  scene.add(mesh);
  return mesh;
}
function textTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function face(obj, pos, dir) { obj.position.copy(pos); obj.lookAt(pos.clone().add(dir)); scene.add(obj); obj.updateMatrixWorld(true); return obj; }

// 2412호(모델의 팀플실, x 4~13 · y 1.5~9.5). 웹 모델은 벽을 잘라 두어서 윗벽과 천장을 채운다.
const wallM = mat(0xe8e4dc, 0.92);
for (const w of [
  [4, 7.8, 1.41, 1.59, 1.1, 3.2], [9.2, 13, 1.41, 1.59, 1.1, 3.2], [7.8, 9.2, 1.41, 1.59, 2.1, 3.2], // 복도 쪽 벽(문 8.5)
  [3.91, 4.09, 1.5, 9.5, 1.1, 3.2], [12.91, 13.09, 1.5, 9.5, 1.1, 3.2],                              // 서쪽·동쪽 벽
  [4, 13, 9.41, 9.59, 2.69, 3.2],                                                                     // 창 위
]) occluders.push(box(...w, wallM));
box(3.9, 13.1, 1.4, 9.6, 3.2, 3.26, new THREE.MeshBasicMaterial({color: 0xdedcd6}));
for (const x of [6, 8.5, 11]) for (const y of [3.5, 7]) box(x - 0.6, x + 0.6, y - 0.3, y + 0.3, 3.18, 3.2, new THREE.MeshBasicMaterial({color: 0xfffdf6}));

// ───── 인식 대상 ─────
const targets = [];
function target(t) {
  t.obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(t.obj);
  t.center = bb.getCenter(new THREE.Vector3());
  t.corners = [];
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) t.corners.push(new THREE.Vector3(x, y, z));
  t.noise = 0;
  targets.push(t);
  occluders.push(t.obj);
  return t;
}
const texLoader = new THREE.TextureLoader();
function tv(key, label, pos, dir, w) {
  const h = w * 9 / 16, g = new THREE.Group();
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, h + 0.05, 0.045), mat(0x111214, 0.4, 0.3));
  bezel.position.z = -0.025;
  const tex = texLoader.load(`posters/${key}.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: tex, toneMapped: false}));
  screen.position.z = 0.0005;
  g.add(bezel, screen);
  face(g, pos, dir);
  return target(key === 'x'
    ? {id: 'tv-x', label, kind: 'none', obj: g, normal: dir}
    : {id: 'tv-' + key, label, kind: 'video', key, obj: g, normal: dir});
}
// 화면이 바라보는 방향. NORTH = 북쪽 벽에 걸려 남쪽(방 안)을 봄, TO_N = 남쪽 벽 앞에서 북쪽을 봄
const NORTH = new THREE.Vector3(0, 0, 1), WEST = new THREE.Vector3(-1, 0, 0), EAST = new THREE.Vector3(1, 0, 0), TO_N = new THREE.Vector3(0, 0, -1);
// 북쪽 창가 TV 3대(모델의 화면 자리), 동쪽 벽 TV 3대 = TV 6대
tv('d', '견훤 TV', B(6.6, 9.08, 1.86), NORTH, 1.9);
tv('e', '마주봄 TV', B(9.2, 9.08, 1.86), NORTH, 1.9);
tv('a', '킨텍스 고래 TV', B(11.6, 9.08, 1.86), NORTH, 1.9);
tv('b', '해저놀이터 TV', B(12.88, 3.0, 1.75), WEST, 1.5);
tv('c', '언리얼 페스트 TV', B(12.88, 4.9, 1.75), WEST, 1.5);
tv('x', '준비 중 TV', B(12.88, 6.8, 1.75), WEST, 1.5);

// 앞쪽(서쪽 벽) 스크린 — 인식 대상 아님
{
  const tex = textTex(1600, 900, (c, w, h) => {
    const gr = c.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#0e1a2e'); gr.addColorStop(1, '#14324a');
    c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.fillStyle = '#7fd3ff'; c.font = '600 54px "Malgun Gothic"'; c.fillText('2412', 110, 230);
    c.fillStyle = '#ffffff'; c.font = '700 120px "Malgun Gothic"'; c.fillText('AI컴퓨터학과 작품 전시', 110, 400);
    c.fillStyle = '#b9d4e6'; c.font = '48px "Malgun Gothic"'; c.fillText('안경을 쓰고 작품과 기기를 바라보면 설명 영상 재생', 110, 520);
    c.fillStyle = '#3dff5a'; c.fillRect(110, 600, 220, 8);
  });
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.0, 0.03), mat(0x202226, 0.5));
  frame.position.z = -0.016;
  const s = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.9125), new THREE.MeshBasicMaterial({map: tex, toneMapped: false}));
  g.add(frame, s);
  face(g, B(4.34, 5.6, 1.75), EAST);
}

// 판넬(X배너) 2개 — 남쪽 벽 앞, 방 안쪽을 본다
function banner(id, label, pos, title, sub, lines, color, card) {
  const tex = textTex(600, 1600, (c, w, h) => {
    c.fillStyle = '#f7f5f0'; c.fillRect(0, 0, w, h);
    c.fillStyle = color; c.fillRect(0, 0, w, 420);
    c.fillStyle = '#fff'; c.font = '700 84px "Malgun Gothic"';
    title.split('\n').forEach((t, i) => c.fillText(t, 50, 190 + i * 100));
    c.fillStyle = '#222'; c.font = '600 46px "Malgun Gothic"'; c.fillText(sub, 50, 540);
    c.font = '40px "Malgun Gothic"'; c.fillStyle = '#444';
    lines.forEach((t, i) => { c.fillStyle = color; c.fillRect(50, 640 + i * 110, 14, 14); c.fillStyle = '#444'; c.fillText(t, 84, 660 + i * 110); });
    c.fillStyle = color; c.fillRect(50, 1480, 500, 10);
  });
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.6), new THREE.MeshStandardMaterial({map: tex, roughness: 0.8}));
  p.position.y = 0.95;
  const poleM = mat(0x9aa0a6, 0.3, 0.8);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.9), poleM);
    leg.position.set(s * 0.3, 0.95, -0.04); leg.rotation.z = s * 0.02; g.add(leg);
  }
  g.add(p);
  face(g, pos, TO_N);
  g.updateMatrixWorld(true);
  return target({id, label, kind: 'card', card, obj: p, normal: TO_N});
}
banner('banner-dept', '학과 소개 판넬', B(10.4, 1.85, 0), 'AI컴퓨터\n학과', 'VR · AR · 게임 · AI',
  ['실감 콘텐츠 제작', '게임 엔진 실습', 'AI 서비스 개발'], '#1f6f3a',
  {title: 'AI컴퓨터학과', tag: '학과 소개', lines: ['실감 콘텐츠 제작', '게임 엔진 실습', 'AI 서비스 개발']});
banner('banner-piuda', '피우다 판넬', B(11.6, 1.85, 0), '피우다\n2026', '글로벌 피우다 프로젝트',
  ['학생 팀 프로젝트', '마주봄 · Team MajuBom', '낙상 예측 연구'], '#2b4a8a',
  {title: '피우다 2026', tag: '팀 프로젝트', lines: ['글로벌 피우다 프로젝트', '마주봄 · Team MajuBom', '낙상 예측 연구']});

// 기기: 메타 퀘스트 2대, 애플 비전 프로, MS 홀로렌즈 2, 스마트홈 모형
function stand(pos) { // 테이블 위 헤드셋 거치대
  const g = new THREE.Group(), m = mat(0x2b2d31, 0.5, 0.2);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.015, 24), m); base.position.y = 0.0075;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.22, 12), m); post.position.y = 0.12;
  g.add(base, post);
  g.position.copy(pos); scene.add(g);
}
function quest() {
  const g = new THREE.Group(), white = mat(0xf2f2ef, 0.45), dark = mat(0x2a2c30, 0.8);
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.105, 0.09), white));
  for (const [x, y] of [[-0.075, 0.035], [0.075, 0.035], [-0.075, -0.035], [0.075, -0.035]]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 12), mat(0x0b0b0c, 0.2));
    c.rotation.x = Math.PI / 2; c.position.set(x, y, 0.046); g.add(c);
  }
  const fc = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.09, 0.03), dark); fc.position.z = -0.058; g.add(fc);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.01, 8, 32), dark);
  strap.rotation.x = Math.PI / 2; strap.scale.set(1, 1.25, 1); strap.position.z = -0.17; g.add(strap);
  return g;
}
function visionPro() {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 16, Math.PI / 2 - 0.62, 1.24, Math.PI / 2 - 0.32, 0.64),
    new THREE.MeshStandardMaterial({color: 0x06070a, metalness: 0.9, roughness: 0.06}));
  glass.position.z = -0.11;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.095, 0.045), mat(0xc9ccd1, 0.25, 0.9)); frame.position.z = 0.0;
  const seal = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.08, 0.03), mat(0x8d8f94, 0.95)); seal.position.z = -0.035;
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.016, 10, 32), mat(0x9c9ea3, 1));
  band.rotation.x = Math.PI / 2; band.scale.set(1, 1.2, 1); band.position.z = -0.16;
  g.add(glass, frame, seal, band);
  return g;
}
function hololens() {
  const g = new THREE.Group();
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.017, 10, 32), mat(0x3a3b40, 0.6));
  band.rotation.x = Math.PI / 2; band.scale.set(1, 1.15, 1); band.position.set(0, 0.03, -0.07);
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.04), mat(0x111214, 0.4)); brow.position.set(0, 0.03, 0.05);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 12, Math.PI / 2 - 0.8, 1.6, Math.PI / 2 - 0.05, 0.5),
    new THREE.MeshStandardMaterial({color: 0x3a2a55, metalness: 0.6, roughness: 0.08, transparent: true, opacity: 0.7}));
  visor.position.set(0, 0.03, -0.05);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.04), mat(0x2b2c30, 0.6)); back.position.set(0, 0.03, -0.19);
  g.add(band, brow, visor, back);
  return g;
}
function device(id, label, make, x, card) {
  const top = B(x, 6.8, 0.79);
  stand(top);
  const g = make();
  return target({id, label, kind: 'card', card, obj: face(g, top.clone().add(new THREE.Vector3(0, 0.27, 0)), new THREE.Vector3(0, 0, 1))});
}
device('quest-1', '메타 퀘스트 2 · 1번', quest, 5.9,
  {title: '메타 퀘스트 2', tag: 'VR 헤드셋 · 1번', lines: ['단독형 VR 헤드셋', '선 없이 바로 체험', '체험 자리 1번']});
device('quest-2', '메타 퀘스트 2 · 2번', quest, 6.9,
  {title: '메타 퀘스트 2', tag: 'VR 헤드셋 · 2번', lines: ['단독형 VR 헤드셋', '선 없이 바로 체험', '체험 자리 2번']});
device('vision', '애플 비전 프로', visionPro, 10.2,
  {title: '애플 비전 프로', tag: '공간 컴퓨터', lines: ['눈과 손으로 조작', '현실 위에 앱 화면', '체험 1인용']});
device('hololens', 'MS 홀로렌즈 2', hololens, 11.2,
  {title: 'MS 홀로렌즈 2', tag: 'MR 안경', lines: ['투명 렌즈 위 3D 홀로그램', '손 추적 · 공간 인식', '산업·교육용 MR']});

{ // 스마트홈 모형(받침대 위)
  const base = B(5.6, 3.0, 0);
  box(5.3, 5.9, 2.7, 3.3, 0, 0.9, mat(0xf3f2ee, 0.7));
  const h = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.28, 0.34), mat(0xeadcc4, 0.8)); body.position.y = 0.14;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.18, 4), mat(0x6e4b3a, 0.7));
  roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.78); roof.position.y = 0.37;
  const glow = new THREE.MeshBasicMaterial({color: 0xffd36b});
  for (const x of [-0.13, 0.13]) { const w = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.07), glow); w.position.set(x, 0.17, 0.171); h.add(w); }
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.12), mat(0x5b3b2a)); door.position.set(0, 0.06, 0.171);
  const spk = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 24), mat(0x24262a, 0.5)); spk.position.set(0.31, 0.045, 0.08);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.004, 6, 24), new THREE.MeshBasicMaterial({color: 0x4fc3ff}));
  ring.rotation.x = Math.PI / 2; ring.position.set(0.31, 0.092, 0.08);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({color: 0xfff1c0})); lamp.position.set(-0.3, 0.12, 0.08);
  const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.1), mat(0x777777)); lampPole.position.set(-0.3, 0.05, 0.08);
  h.add(body, roof, door, spk, ring, lamp, lampPole);
  target({id: 'smarthome', label: '스마트홈 모형', kind: 'card', obj: face(h, base.clone().add(new THREE.Vector3(0, 0.9, 0)), EAST),
    card: {title: '스마트홈', tag: 'IoT 모형', lines: ['조명 · 스피커 · 센서 연동', '말로 조명 켜고 끄기', '집 상태를 안경에 표시']}});
}

// ───── 이동·시점 ─────
const eye = B(8.5, 2.2, 1.65);
let yaw = 0, pitch = 0;
function lookAt(from, to) {
  const d = to.clone().sub(from);
  return {yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y / d.length())};
}
const VIEWS = {
  '입구': [B(8.5, 2.2, 1.65), B(9.2, 9.1, 1.8)],
  'TV 3대 앞': [B(9.2, 5.0, 1.65), B(9.2, 9.1, 1.86)],
  '퀘스트 2대': [B(6.4, 5.2, 1.55), B(6.4, 6.8, 1.05)],
  '비전 프로·홀로렌즈': [B(10.7, 5.2, 1.55), B(10.7, 6.8, 1.05)],
  '스마트홈': [B(7.4, 3.0, 1.6), B(5.6, 3.0, 1.1)],
  '옆 벽 TV 3대': [B(9.4, 4.9, 1.65), B(12.9, 4.9, 1.75)],
  '판넬 2개': [B(11.0, 4.6, 1.65), B(11.0, 1.85, 1.2)],
};
let tween = null;
function goTo(name, dur = 1.2) {
  const [e, l] = VIEWS[name];
  return moveTo(e, l, dur);
}
function moveTo(e, l, dur) {
  const to = lookAt(e, l);
  let dy = to.yaw - yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return new Promise(done => { tween = {e0: eye.clone(), e1: e.clone(), y0: yaw, dy, p0: pitch, p1: to.pitch, t: 0, dur, done}; });
}
{
  const v = lookAt(...VIEWS['입구']); yaw = v.yaw; pitch = v.pitch;
  const nav = $('#views');
  for (const name of Object.keys(VIEWS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { stopAuto(); goTo(name); };
    nav.append(b);
  }
}
let drag = null;
gl.addEventListener('pointerdown', e => { stopAuto(); tween = null; drag = {x: e.clientX, y: e.clientY}; gl.setPointerCapture(e.pointerId); });
gl.addEventListener('pointermove', e => {
  if (!drag) return;
  yaw -= (e.clientX - drag.x) * 0.0035;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - drag.y) * 0.0035, -1.2, 1.2);
  drag = {x: e.clientX, y: e.clientY};
});
gl.addEventListener('pointerup', () => { drag = null; });
const keys = new Set();
addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); stopPlay('안경 탭'); return; }
  if (/^(Key[WASD]|Arrow)/.test(e.code)) { stopAuto(); tween = null; keys.add(e.code); }
});
addEventListener('keyup', e => keys.delete(e.code));
function walk(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp')) - (keys.has('KeyS') || keys.has('ArrowDown'));
  const s = (keys.has('KeyD') || keys.has('ArrowRight')) - (keys.has('KeyA') || keys.has('ArrowLeft'));
  if (!f && !s) return;
  const v = 1.6 * dt;
  eye.x += (-Math.sin(yaw) * f + Math.cos(yaw) * s) * v;
  eye.z += (-Math.cos(yaw) * f - Math.sin(yaw) * s) * v;
  eye.x = THREE.MathUtils.clamp(eye.x, 4.4, 12.6);
  eye.z = THREE.MathUtils.clamp(eye.z, -9.0, -1.8);
}

// ───── 안경 쪽: 영상·카드 ─────
let videos = {};
const FALLBACK = {a: 'whale.mp4', b: 'sea.mp4', c: 'fest.mp4', d: 'gyeon_envelope.mp4', e: 'majubom_box.mp4'};
fetch('/videos.json').then(r => r.json()).then(j => { videos = j; })
  .catch(() => { for (const [k, f] of Object.entries(FALLBACK)) videos[k] = {file: f, loop: true, url: '../../server/videos/' + f}; });

let playing = null, playAt = 0, lastApi = '-';
const cooldown = new Map();
let audio = null; // 녹화에 소리를 같이 담으려고 WebAudio로 돌린다
function ensureAudio() {
  if (audio) return;
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createMediaElementSource(video);
  src.connect(ctx.destination); src.connect(dest);
  audio = {ctx, dest};
}
addEventListener('pointerdown', ensureAudio, {once: true});
addEventListener('keydown', ensureAudio, {once: true});
function beep(f0, f1, dur = 0.18) {
  if (!audio) return;
  const {ctx, dest} = audio, o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ctx.destination); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.02);
}

function fire(t, now) {
  playing = t; playAt = now;
  dim.hidden = false;
  if (t.kind === 'video') {
    const v = videos[t.key] ?? {};
    lastApi = `GET /play?key=${t.key}`;
    log(`확정 → ${t.label}`);
    log(`${lastApi}  (${v.title ?? t.label})`, 'api');
    if ($('#real').checked) fetch(`/play?key=${t.key}${TOKEN}`).then(r => r.json()).then(j => log(`서버 응답: 안경 ${j.glasses ?? '?'}대에 보냄`, 'api')).catch(() => log('서버에 못 보냄', 'warn'));
    video.src = v.url ?? '/v/' + v.file;
    video.loop = !!v.loop;
    video.hidden = false;
    video.muted = false;
    video.play().catch(() => { video.muted = true; video.play(); });
  } else {
    video.pause(); video.hidden = true;
    lastApi = t.kind === 'none' ? '보내지 않음' : `카드: ${t.id}`;
    log(`확정 → ${t.label}`);
    log(t.kind === 'none' ? '목록에 없는 대상인데 그대로 띄움(나쁜 예)' : `안경에 설명 카드 표시: ${t.card.title}`, t.kind === 'none' ? 'warn' : 'api');
    beep(520, 1180);
  }
}
function stopPlay(why) {
  if (!playing) return;
  log(`끄기(${why}) · ${playing.label}`);
  cooldown.set(playing, performance.now() / 1000 + RULE.cooldown);
  if ($('#real').checked && playing.kind === 'video') fetch(`/stop?x=1${TOKEN}`).catch(() => {});
  playing = null;
  dim.hidden = true;
  video.pause(); video.hidden = true;
}
video.addEventListener('ended', () => stopPlay('영상 끝'));
$('#stop').onclick = () => stopPlay('안경 탭');

// ───── 인식과 판단 ─────
let mode = 'safe';
for (const [id, m] of [['#m-safe', 'safe'], ['#m-naive', 'naive']]) $(id).onclick = () => {
  mode = m;
  $('#m-safe').setAttribute('aria-pressed', String(m === 'safe'));
  $('#m-naive').setAttribute('aria-pressed', String(m === 'naive'));
  stopPlay('방식 바꿈');
  log(m === 'safe' ? '방식: 가운데 + 머무르기 확정' : '방식: 보이면 바로 틀기(비교용)');
};
const ray = new THREE.Raycaster();
let seen = [], hold = {t: null, time: 0, lost: 0}, status = '', pickNow = null, lastNaive = 0, lastWarn = '';
const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function detect() {
  const out = [];
  const W = ov.clientWidth, H = ov.clientHeight;
  camera.updateMatrixWorld();
  for (const t of targets) {
    t.noise = t.noise * 0.8 + (Math.random() - 0.5) * 0.07;
    const toCam = camera.position.clone().sub(t.center), dist = toCam.length();
    if (dist > 10) continue;
    if (t.center.clone().applyMatrix4(camera.matrixWorldInverse).z > -0.15) continue;
    let facing = 1;
    if (t.normal) { facing = t.normal.dot(toCam.normalize()); if (facing < 0.15) continue; }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, bad = false;
    for (const c of t.corners) {
      const v = c.clone().applyMatrix4(camera.matrixWorldInverse);
      if (v.z > -0.05) { bad = true; break; }
      const q = c.clone().project(camera);
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    if (bad) continue;
    const full = (x1 - x0) * (y1 - y0);
    const cw = Math.max(0, Math.min(x1, 1) - Math.max(x0, -1)), ch = Math.max(0, Math.min(y1, 1) - Math.max(y0, -1));
    const vis = full > 0 ? cw * ch / full : 0;
    if (vis < 0.3) continue;
    ray.set(camera.position, t.center.clone().sub(camera.position).normalize());
    ray.far = dist - 0.08;
    if (ray.intersectObjects(occluders.filter(o => o !== t.obj), true).length) continue;
    const size = Math.sqrt((x1 - x0) / 2 * (y1 - y0) / 2);
    const conf = THREE.MathUtils.clamp(smooth(0.02, 0.06, size) * smooth(0.15, 0.5, facing) * Math.min(1, vis / 0.8) * 0.96 + t.noise, 0, 0.99);
    if (conf < RULE.seeConf) continue;
    const px = x => (x + 1) / 2 * W, py = y => (1 - y) / 2 * H;
    const r = {t, conf, l: px(Math.max(x0, -1)), r: px(Math.min(x1, 1)), top: py(Math.min(y1, 1)), bot: py(Math.max(y0, -1))};
    const dx = Math.max(r.l - W / 2, 0, W / 2 - r.r), dy = Math.max(r.top - H / 2, 0, H / 2 - r.bot);
    r.d = Math.hypot(dx, dy) / H;
    r.area = (r.r - r.l) * (r.bot - r.top);
    out.push(r);
  }
  return out;
}

function decide(dt, now) {
  seen = detect();
  pickNow = null;
  if (mode === 'naive') {
    const top = [...seen].sort((a, b) => b.conf - a.conf)[0];
    status = top ? `점수 1등: ${top.t.label}` : '인식된 것 없음';
    pickNow = top ?? null;
    if (top && top.t !== playing && now - lastNaive > 0.3) { lastNaive = now; fire(top.t, now); }
    return;
  }
  const cand = seen.filter(r => r.conf >= RULE.minConf && r.d <= RULE.aimR && !(cooldown.get(r.t) > now))
    .sort((a, b) => a.d - b.d || a.area - b.area);
  let pick = null;
  if (!cand.length) status = seen.length ? '조준점을 대상에 맞춰 주세요' : '인식된 것 없음';
  else {
    const [a, b] = cand;
    const tie = b && (a.d === 0 && b.d === 0 ? a.area / b.area > 0.5 : b.d - a.d < RULE.tie);
    if (tie) { status = `${a.t.label} / ${b.t.label} 겹침 → 하나만 보이게`; warnOnce(`애매함: ${a.t.label} · ${b.t.label} → 확정 안 함`); }
    else if (a.t.kind === 'none') { status = `${a.t.label}: 목록에 없음 → 무시`; warnOnce(`${a.t.label}: 등록 안 된 대상이라 무시`); }
    else pick = a;
  }
  pickNow = pick;
  if (pick && pick.t === hold.t) { hold.time += dt; hold.lost = 0; }
  else if (pick) hold = {t: pick.t, time: dt, lost: 0};
  else { hold.lost += dt; if (hold.lost > RULE.grace) hold = {t: null, time: 0, lost: 0}; }
  if (!hold.t) return;
  if (hold.t === playing) { status = `재생 중: ${playing.label}`; return; }
  const need = playing ? RULE.switchDwell : RULE.dwell;
  status = `${hold.t.label} · ${Math.min(hold.time, need).toFixed(1)} / ${need.toFixed(1)}초` + (playing ? ' (바꾸려면 더 오래)' : '');
  if (hold.time >= need) { fire(hold.t, now); hold.time = 0; }
}
function warnOnce(m) { if (m !== lastWarn) { lastWarn = m; log(m, 'warn'); } }

// ───── 화면 그리기 ─────
function glassRect(W, H) { const h = H * 0.5, w = h * 0.75; return {x: (W - w) / 2, y: (H - h) / 2, w, h}; }
function resize() {
  const W = view.clientWidth, H = view.clientHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  const d = devicePixelRatio;
  ov.width = W * d; ov.height = H * d;
  const g = glassRect(W, H);
  Object.assign(video.style, {left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px'});
  Object.assign(dim.style, {left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px'});
}
new ResizeObserver(resize).observe(view);

function bracket(r, color, label) {
  const k = Math.min(18, (r.r - r.l) / 3, (r.bot - r.top) / 3);
  g2.strokeStyle = color; g2.lineWidth = 2;
  g2.beginPath();
  for (const [x, y, sx, sy] of [[r.l, r.top, 1, 1], [r.r, r.top, -1, 1], [r.l, r.bot, 1, -1], [r.r, r.bot, -1, -1]]) {
    g2.moveTo(x + sx * k, y); g2.lineTo(x, y); g2.lineTo(x, y + sy * k);
  }
  g2.stroke();
  g2.font = '600 12px "Malgun Gothic"';
  const tw = g2.measureText(label).width + 10;
  g2.fillStyle = 'rgba(0,0,0,.6)'; g2.fillRect(r.l, r.top - 20, tw, 18);
  g2.fillStyle = color; g2.fillText(label, r.l + 5, r.top - 6);
}
function drawCard(gr, t, age) {
  const p = Math.min(1, age / 0.35), e = 1 - Math.pow(1 - p, 3);
  const cx = gr.x + gr.w / 2, cy = gr.y + gr.h / 2;
  g2.save();
  g2.translate(cx, cy); g2.scale(0.6 + 0.4 * e, 0.6 + 0.4 * e); g2.translate(-cx, -cy);
  g2.globalAlpha = e;
  g2.strokeStyle = GREEN; g2.fillStyle = GREEN; g2.lineWidth = 2;
  const m = gr.w * 0.08, x = gr.x + m, w = gr.w - m * 2;
  g2.strokeRect(x, gr.y + gr.h * 0.12, w, gr.h * 0.76);
  const fs = gr.w / 14;
  g2.font = `600 ${fs * 0.7}px "Malgun Gothic"`; g2.fillText(t.card.tag, x + fs * 0.6, gr.y + gr.h * 0.12 + fs * 1.4);
  g2.font = `700 ${fs * 1.25}px "Malgun Gothic"`; g2.fillText(t.card.title, x + fs * 0.6, gr.y + gr.h * 0.12 + fs * 3.0);
  g2.fillRect(x + fs * 0.6, gr.y + gr.h * 0.12 + fs * 3.6, w * 0.3, 3);
  g2.font = `${fs * 0.78}px "Malgun Gothic"`;
  t.card.lines.forEach((l, i) => {
    const a = Math.min(1, Math.max(0, (age - 0.3 - i * 0.15) / 0.25));
    g2.globalAlpha = e * a;
    g2.fillText('▸ ' + l, x + fs * 0.6, gr.y + gr.h * 0.12 + fs * (5.2 + i * 1.5));
  });
  g2.globalAlpha = e * (0.4 + 0.3 * Math.sin(age * 6));
  const sy = gr.y + gr.h * 0.12 + ((age * 0.5) % 1) * gr.h * 0.76;
  g2.fillRect(x, sy, w, 1.5);
  g2.restore();
}
function drawOverlay(now) {
  const d = devicePixelRatio, W = ov.width / d, H = ov.height / d;
  g2.setTransform(d, 0, 0, d, 0, 0);
  g2.clearRect(0, 0, W, H);
  if ($('#boxes').checked) for (const r of seen) {
    const isPick = pickNow && r.t === pickNow.t;
    const col = r.t.kind === 'none' ? '#ffa45a' : isPick ? GREEN : 'rgba(255,255,255,.85)';
    bracket(r, col, `${r.t.label} ${r.conf.toFixed(2)}`);
  }
  const gr = glassRect(W, H);
  g2.setLineDash([6, 6]); g2.strokeStyle = 'rgba(61,255,90,.25)'; g2.lineWidth = 1;
  g2.strokeRect(gr.x, gr.y, gr.w, gr.h); g2.setLineDash([]);
  g2.font = '11px "Malgun Gothic"'; g2.fillStyle = 'rgba(61,255,90,.5)'; g2.fillText('안경 화면', gr.x, gr.y - 6);
  if (playing && playing.kind !== 'video') {
    if (playing.kind === 'none') drawCard(gr, {card: {tag: '오류', title: '등록 안 된 대상', lines: ['틀 영상이 없음', '잘못 인식된 예']}}, now - playAt);
    else drawCard(gr, playing, now - playAt);
  }
  // 조준점과 머무르기 원
  const cx = W / 2, cy = H / 2;
  g2.strokeStyle = GREEN; g2.lineWidth = 2;
  g2.beginPath(); g2.arc(cx, cy, 6, 0, Math.PI * 2); g2.stroke();
  g2.beginPath(); g2.arc(cx, cy, RULE.aimR * H, 0, Math.PI * 2); g2.strokeStyle = 'rgba(61,255,90,.18)'; g2.stroke();
  const need = playing ? RULE.switchDwell : RULE.dwell;
  if (mode === 'safe' && hold.t && hold.t !== playing) {
    g2.strokeStyle = GREEN; g2.lineWidth = 4;
    g2.beginPath(); g2.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hold.time / need)); g2.stroke();
  }
  g2.font = '600 13px "Malgun Gothic"'; g2.textAlign = 'center';
  const tw = g2.measureText(status).width + 16;
  g2.fillStyle = 'rgba(0,0,0,.55)'; g2.fillRect(cx - tw / 2, gr.y + gr.h + 10, tw, 22);
  g2.fillStyle = GREEN; g2.fillText(status, cx, gr.y + gr.h + 26);
  g2.textAlign = 'left';
}
function panel() {
  const need = playing ? RULE.switchDwell : RULE.dwell;
  const set = (s, on, text) => { const li = $(`#steps li[data-s=${s}]`); li.classList.toggle('on', on); li.querySelector('span').textContent = text; };
  set('cam', seen.length > 0, seen.length ? `${seen.length}개` : '-');
  set('pick', !!pickNow, pickNow ? pickNow.t.label : '-');
  set('hold', mode === 'safe' && !!hold.t && hold.t !== playing, mode === 'naive' ? '건너뜀' : hold.t && hold.t !== playing ? `${hold.time.toFixed(1)}/${need}초` : '-');
  set('api', !!playing, playing ? lastApi : '-');
  set('play', !!playing, playing ? playing.label : '꺼짐');
  $('#bar i').style.width = (mode === 'safe' && hold.t && hold.t !== playing ? Math.min(1, hold.time / need) * 100 : 0) + '%';
}
function log(m, cls = '') {
  const el = document.createElement('div');
  el.textContent = `${new Date().toLocaleTimeString('ko-KR', {hour12: false})}  ${m}`;
  if (cls) el.className = cls;
  const box = $('#log');
  box.append(el);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

// ───── 녹화(화면 + 안경 화면 + 소리 → webm) ─────
const comp = document.createElement('canvas'), cg = comp.getContext('2d');
let rec = null;
$('#rec').onclick = () => {
  if (rec) { rec.stop(); return; }
  ensureAudio();
  comp.width = gl.width; comp.height = gl.height;
  const tracks = [...comp.captureStream(30).getVideoTracks(), ...audio.dest.stream.getAudioTracks()];
  const type = ['video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const chunks = [];
  rec = new MediaRecorder(new MediaStream(tracks), {mimeType: type, videoBitsPerSecond: 8e6});
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, {type: 'video/webm'}));
    a.download = '2412_안경데모.webm'; a.click();
    rec = null; $('#rec').setAttribute('aria-pressed', 'false'); $('#rec').textContent = '녹화';
    log('녹화 저장: 2412_안경데모.webm');
  };
  rec.start(500);
  $('#rec').setAttribute('aria-pressed', 'true'); $('#rec').textContent = '녹화 끝내기';
  log('녹화 시작');
};
function compose() {
  if (!rec) return;
  if (comp.width !== gl.width || comp.height !== gl.height) { comp.width = gl.width; comp.height = gl.height; }
  const s = gl.width / view.clientWidth;
  cg.globalCompositeOperation = 'source-over';
  cg.drawImage(gl, 0, 0);
  if (!dim.hidden) {
    const g = glassRect(view.clientWidth, view.clientHeight);
    cg.fillStyle = 'rgba(0,0,0,.72)'; cg.fillRect(g.x * s, g.y * s, g.w * s, g.h * s);
  }
  if (!video.hidden && video.readyState >= 2) {
    const g = glassRect(view.clientWidth, view.clientHeight);
    cg.globalCompositeOperation = 'screen';
    cg.drawImage(video, g.x * s, g.y * s, g.w * s, g.h * s);
    cg.globalCompositeOperation = 'source-over';
  }
  cg.drawImage(ov, 0, 0, comp.width, comp.height);
}

// ───── 자동 시연 ─────
let autoRun = 0;
function stopAuto() { if (autoRun) { autoRun = 0; $('#auto').setAttribute('aria-pressed', 'false'); } }
const wait = s => new Promise(r => setTimeout(r, s * 1000));
$('#auto').onclick = async () => {
  if (autoRun) { stopAuto(); return; }
  ensureAudio();
  const run = autoRun = Date.now();
  $('#auto').setAttribute('aria-pressed', 'true');
  const alive = () => autoRun === run;
  const steps = [
    async () => { stopPlay('시연 시작'); await goTo('입구', 1.0); await wait(0.6); },
    async () => { await moveTo(B(8.5, 2.2, 1.65), B(6.6, 9.1, 1.86), 0.8); await moveTo(B(8.5, 2.2, 1.65), B(11.6, 9.1, 1.86), 1.6); }, // 훑기: 스쳐 가면 안 틀림
    async () => { await moveTo(B(8.5, 2.6, 1.65), B(9.2, 9.1, 1.86), 1.0); await wait(3.5); },                                    // 마주봄 확정
    async () => { await moveTo(B(8.3, 3.2, 1.65), B(6.6, 9.1, 1.86), 0.7); await wait(1.0); },                                    // 1초만 보면 안 바뀜
    async () => { await wait(2.6); },                                                                                              // 2초 넘게 보면 견훤으로
    async () => { await goTo('퀘스트 2대', 1.6); await wait(1.6); },                                                              // 둘 사이 → 애매함
    async () => { await moveTo(B(6.4, 5.2, 1.55), B(5.9, 6.8, 1.05), 0.8); await wait(2.8); },
    async () => { await moveTo(B(6.4, 5.2, 1.55), B(6.9, 6.8, 1.05), 0.8); await wait(2.8); },
    async () => { await moveTo(B(10.7, 5.2, 1.55), B(10.2, 6.8, 1.05), 1.6); await wait(2.8); },
    async () => { await moveTo(B(10.7, 5.2, 1.55), B(11.2, 6.8, 1.05), 0.8); await wait(2.8); },
    async () => { await goTo('스마트홈', 1.8); await wait(2.8); },
    async () => { await moveTo(B(9.4, 4.9, 1.65), B(12.9, 3.0, 1.75), 1.6); await wait(3.0); },
    async () => { await moveTo(B(9.4, 4.9, 1.65), B(12.9, 6.8, 1.75), 1.0); await wait(2.4); },                                  // 준비 중 TV → 무시
    async () => { await goTo('판넬 2개', 1.6); await wait(1.2); await moveTo(B(11.0, 4.6, 1.65), B(10.4, 1.85, 1.15), 0.6); await wait(2.8); },
    async () => { stopPlay('안경 탭'); await goTo('입구', 1.6); },
  ];
  log('자동 시연 시작');
  for (const s of steps) { if (!alive()) return; await s(); }
  if (alive()) { log('자동 시연 끝'); stopAuto(); }
};

// ───── 반복 ─────
let last = performance.now() / 1000, acc = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, dt = Math.min(0.1, now - last);
  last = now;
  if (tween) {
    tween.t += dt;
    const p = Math.min(1, tween.t / tween.dur), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    eye.lerpVectors(tween.e0, tween.e1, e);
    yaw = tween.y0 + tween.dy * e;
    pitch = tween.p0 + (tween.p1 - tween.p0) * e;
    if (p >= 1) { const d = tween.done; tween = null; d(); }
  }
  walk(dt);
  camera.position.copy(eye);
  camera.rotation.set(pitch, yaw, 0);
  acc += dt;
  if (acc >= 0.1) { decide(acc, now); acc = 0; panel(); } // 카메라 프레임은 초당 10장으로 가정
  renderer.render(scene, camera);
  drawOverlay(now);
  compose();
}

new GLTFLoader().load('floor4.glb', g => {
  g.scene.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) { m.roughness = Math.max(m.roughness ?? 1, 0.6); m.metalness = 0; } });
  scene.add(g.scene);
  $('#loading').hidden = true;
  gl.dataset.ready = 'true';
  log('2412호 준비 완료 · TV 6대, 판넬 2개, 기기 5대');
}, undefined, e => { $('#loading').textContent = '모델을 불러오지 못했습니다: ' + e.message; });
resize();
frame();
window.demo = {targets, get playing() { return playing?.id ?? null; }, get status() { return status; }, goTo, RULE};
