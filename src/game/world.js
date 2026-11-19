// 맵(지형과 고정 물체) 생성과 충돌 판정. 화면과 무관하다.
// 좌표: x = 동서, y = 남북 (3D로 옮기면 y → z).
//
// 큰 맵을 위한 구조:
//  - 맵 전체를 한 번에 만들지 않는다. 400칸짜리 "조각(chunk)"으로 나눠서, 필요할 때 만든다.
//  - 같은 자리는 언제 만들어도 똑같이 나온다 (자리마다 고정된 난수 씨앗).
//  - 그래서 멀리 있는 조각은 지워도 되고, 맵 크기를 더 키워도 속도가 그대로다.
//  - 연못·숲·마을 같은 큰 지형(feature)은 1200칸 "구역"마다 정해진다.
//  - 가운데 "집" 지역은 손으로 배치한 그대로 (처음부터 있던 동네).
import { mulberry32, dist, hash2 } from '../core/rng.js';
import { biomeAt, biomeIdAt, BIOMES } from './biomes.js';

export const MAP = { w: 7600, h: 7600 };
export const CHUNK = 400;   // 작은 조각 (나무·꽃·돌, 바닥 그림)
const FCELL = 1200;         // 큰 구역 (연못·숲·마을)
const TREE_CELL = 52;       // 나무 후보 격자 (이 간격보다 가깝게는 안 남)

export function generateWorld(seed = 7) {
  // 처음 만든 2400칸 동네를 맵 한가운데에 그대로 옮긴다
  const ox = MAP.w / 2 - 1200, oy = MAP.h / 2 - 1200;
  const P = (x, y) => [x + ox, y + oy];
  const world = {
    seed,
    size: MAP,
    home: { x0: ox, y0: oy, x1: ox + 2400, y1: oy + 2400 },
    spawn: { x: 1150 + ox, y: 1250 + oy },
    landmarks: [],
    paths: [],
    houses: [],
    chunks: new Map(),
    fcells: new Map(),
  };
  let fid = 1;
  const add = (f) => { f.id = 'L' + fid++; world.landmarks.push(f); return f; };
  const pond1 = add({ kind: 'pond', x: 820 + ox, y: 1450 + oy, rx: 230, ry: 150 });
  const pond2 = add({ kind: 'pond', x: 1820 + ox, y: 1850 + oy, rx: 130, ry: 95 });
  const village = add({ kind: 'village', x: 1700 + ox, y: 760 + oy, r: 330 });
  add({ kind: 'forest', x: 480 + ox, y: 520 + oy, r: 430 });

  // 마을 집
  const roofColors = ['#f08a7e', '#7eb6f0', '#f5b85a', '#b48ef0', '#7ed0a6'];
  [[-170, -120], [40, -170], [210, -60], [-200, 90], [170, 140], [-20, 190]].forEach(([dx, dy], i) => {
    world.houses.push({ x: village.x + dx, y: village.y + dy, w: 110, h: 70, roof: roofColors[i % roofColors.length] });
  });

  // 길: 시작 지점 → 마을, 시작 지점 → 큰 연못, 마을 → 작은 연못
  const s = [world.spawn.x, world.spawn.y], v = [village.x, village.y];
  world.paths.push(
    [s, P(1400, 1050), v],
    [s, P(1000, 1380), [pond1.x + 200, pond1.y - 60]],
    [v, P(1900, 1300), [pond2.x, pond2.y - 110]],
  );
  return world;
}

// ---------------- 큰 지형 (구역마다) ----------------
function overlapsRect(f, x0, y0, x1, y1) {
  const rx = f.rx ?? f.r, ry = f.ry ?? f.r;
  return f.x + rx > x0 && f.x - rx < x1 && f.y + ry > y0 && f.y - ry < y1;
}

function makeCellFeatures(world, mx, my) {
  const x0 = mx * FCELL, y0 = my * FCELL;
  const h = world.home, pad = 250;
  // 집 동네와 겹치는 구역, 맵 밖 구역은 비워 둔다
  if (x0 + FCELL > h.x0 - pad && x0 < h.x1 + pad && y0 + FCELL > h.y0 - pad && y0 < h.y1 + pad) return [];
  if (x0 >= MAP.w || y0 >= MAP.h || x0 < 0 || y0 < 0) return [];
  const r = mulberry32(hash2(world.seed, mx, my, 1));
  const out = [];
  const inside = (m) => [x0 + m + r() * (FCELL - 2 * m), y0 + m + r() * (FCELL - 2 * m)];
  if (r() < 0.6) {
    const rx = 90 + r() * 130, [x, y] = inside(rx + 160);
    const ry = rx * (0.55 + r() * 0.25);
    if (x < MAP.w - rx - 120 && y < MAP.h - rx - 120) out.push({ kind: 'pond', id: `p${mx},${my}`, x, y, rx, ry, ice: biomeIdAt(world, x, y) === 'snow' });
  }
  if (r() < 0.45) {
    const R = 250 + r() * 170, [x, y] = inside(R * 0.6);
    out.push({ kind: 'forest', id: `f${mx},${my}`, x, y, r: R, snow: biomeIdAt(world, x, y) === 'snow' });
  }
  return out;
}

// 이 구역 근처에 영향을 주는 큰 지형 목록 (주변 구역 + 집 동네 포함)
function fcell(world, mx, my) {
  const key = mx + ',' + my;
  let c = world.fcells.get(key);
  if (c) return c;
  const x0 = mx * FCELL - 300, y0 = my * FCELL - 300, x1 = (mx + 1) * FCELL + 300, y1 = (my + 1) * FCELL + 300;
  const near = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const f of ownFeatures(world, mx + i, my + j)) if (overlapsRect(f, x0, y0, x1, y1)) near.push(f);
  }
  for (const f of world.landmarks) if (overlapsRect(f, x0, y0, x1, y1)) near.push(f);
  c = { near, ponds: near.filter((f) => f.kind === 'pond') };
  world.fcells.set(key, c);
  return c;
}
const ownCache = new WeakMap();
function ownFeatures(world, mx, my) {
  let m = ownCache.get(world);
  if (!m) { m = new Map(); ownCache.set(world, m); }
  const key = mx + ',' + my;
  if (!m.has(key)) m.set(key, makeCellFeatures(world, mx, my));
  return m.get(key);
}

// (x, y) 근처의 큰 지형들
export function featuresAt(world, x, y) {
  return fcell(world, Math.floor(x / FCELL), Math.floor(y / FCELL)).near;
}
// 사각형 안에 걸치는 큰 지형들 (그리기·지도용)
export function featuresInRect(world, x0, y0, x1, y1) {
  const out = new Set();
  for (let mx = Math.floor(x0 / FCELL); mx <= Math.floor(x1 / FCELL); mx++) {
    for (let my = Math.floor(y0 / FCELL); my <= Math.floor(y1 / FCELL); my++) {
      for (const f of fcell(world, mx, my).near) if (overlapsRect(f, x0, y0, x1, y1)) out.add(f);
    }
  }
  return [...out];
}
export function inFeature(world, x, y, kind, k = 1) {
  for (const f of featuresAt(world, x, y)) if (f.kind === kind && dist(x, y, f.x, f.y) < f.r * k) return f;
  return null;
}
export function nearestPond(world, x, y) {
  let best = null, bd = Infinity;
  for (const f of fcell(world, Math.floor(x / FCELL), Math.floor(y / FCELL)).ponds) {
    const d = dist(x, y, f.x, f.y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

// 연못 안인가 (얼음 연못 포함) → 그 연못을 돌려준다
export function pondAt(world, x, y, pad = 0) {
  for (const p of fcell(world, Math.floor(x / FCELL), Math.floor(y / FCELL)).ponds) {
    const dx = (x - p.x) / (p.rx + pad), dy = (y - p.y) / (p.ry + pad);
    if (dx * dx + dy * dy < 1) return p;
  }
  return null;
}
// 물 (못 지나감). 얼음 연못은 물이 아니다 — 걸어 다닐 수 있고 미끄럽다.
export function isWater(world, x, y, pad = 0) {
  const p = pondAt(world, x, y, pad);
  return !!p && !p.ice;
}
export function isIce(world, x, y) {
  const p = pondAt(world, x, y, -4);
  return !!p && p.ice;
}

// ---------------- 작은 조각 (나무·꽃·돌·집) ----------------
export function getChunk(world, cx, cy) {
  const key = cx + ',' + cy;
  let ch = world.chunks.get(key);
  if (!ch) { ch = buildChunk(world, cx, cy); world.chunks.set(key, ch); }
  ch.used = world.clock || 0;
  return ch;
}
export function* chunksInRect(world, x0, y0, x1, y1) {
  const a = Math.max(0, Math.floor(x0 / CHUNK)), b = Math.min(Math.ceil(MAP.w / CHUNK) - 1, Math.floor(x1 / CHUNK));
  const c = Math.max(0, Math.floor(y0 / CHUNK)), d = Math.min(Math.ceil(MAP.h / CHUNK) - 1, Math.floor(y1 / CHUNK));
  for (let cy = c; cy <= d; cy++) for (let cx = a; cx <= b; cx++) yield getChunk(world, cx, cy);
}
// 멀리 있는 조각은 지운다 (다시 필요하면 똑같이 다시 만들어진다)
export function forgetFar(world, x, y, keep = 3200) {
  if (world.chunks.size < 250) return;
  for (const [k, ch] of world.chunks) {
    if (Math.abs(ch.x0 + CHUNK / 2 - x) > keep || Math.abs(ch.y0 + CHUNK / 2 - y) > keep) world.chunks.delete(k);
  }
}

// 나무 후보: 격자 칸마다 하나. 이웃 후보와 너무 가까우면 우선순위가 낮은 쪽이 빠진다.
function treeCand(world, gx, gy) {
  const r = mulberry32(hash2(world.seed, gx, gy, 3));
  const x = (gx + r()) * TREE_CELL, y = (gy + r()) * TREE_CELL;
  const roll = r(), prio = r(), kindRoll = r(), size = 0.85 + r() * 0.4, phase = r() * 6.28;
  const forest = inFeature(world, x, y, 'forest');
  const b = biomeAt(world, x, y);
  if (roll >= (forest ? 0.62 : b.trees)) return null;
  if (!canPlaceDecor(world, x, y, 60)) return null;
  const snow = b === BIOMES.snow;
  const pine = forest || kindRoll < b.pine;
  return { x, y, prio, kind: snow ? (pine ? 'snowpine' : 'bare') : (pine ? 'pine' : 'round'), size, phase };
}

function buildChunk(world, cx, cy) {
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  const r = mulberry32(hash2(world.seed, cx, cy, 2));
  const ch = { cx, cy, x0, y0, key: cx + ',' + cy, trees: [], flowers: [], rocks: [], mushrooms: [], houses: [],
    biome: biomeIdAt(world, x0 + CHUNK / 2, y0 + CHUNK / 2) };

  // 나무
  const g0x = Math.floor(x0 / TREE_CELL), g1x = Math.floor((x0 + CHUNK - 1) / TREE_CELL);
  const g0y = Math.floor(y0 / TREE_CELL), g1y = Math.floor((y0 + CHUNK - 1) / TREE_CELL);
  const cand = new Map();
  const getCand = (gx, gy) => { const k = gx + ',' + gy; if (!cand.has(k)) cand.set(k, treeCand(world, gx, gy)); return cand.get(k); };
  for (let gy = g0y; gy <= g1y; gy++) for (let gx = g0x; gx <= g1x; gx++) {
    const t = getCand(gx, gy);
    if (!t || t.x < x0 || t.x >= x0 + CHUNK || t.y < y0 || t.y >= y0 + CHUNK) continue;
    let ok = true;
    for (let i = -1; i <= 1 && ok; i++) for (let j = -1; j <= 1 && ok; j++) {
      if (!i && !j) continue;
      const o = getCand(gx + i, gy + j);
      if (o && o.prio > t.prio && dist(o.x, o.y, t.x, t.y) < TREE_CELL) ok = false;
    }
    if (ok) ch.trees.push(t);
  }
  // 맵 가장자리 울타리 나무
  const edge = (x, y) => { if (x >= x0 && x < x0 + CHUNK && y >= y0 && y < y0 + CHUNK) ch.trees.push({ x, y, kind: biomeAt(world, x, y) === BIOMES.snow ? 'snowpine' : 'round', size: 0.9 + r() * 0.3, phase: r() * 6.28 }); };
  if (y0 === 0 || y0 + CHUNK >= MAP.h || x0 === 0 || x0 + CHUNK >= MAP.w) {
    for (let x = x0 + 30; x < x0 + CHUNK; x += 70) { edge(x, 40); edge(x, MAP.h - 40); }
    for (let y = y0 + 30; y < y0 + CHUNK; y += 70) { edge(40, y); edge(MAP.w - 40, y); }
  }

  // 바닥 장식 (지나갈 수 있음)
  // 꽃·돌: 후보를 넉넉히 뽑고, 그 자리 지역의 밀도에 맞춰 남긴다 (경계가 자연스럽게)
  const flowerColors = ['#ff9ecb', '#fff27a', '#ffffff', '#b9a6ff', '#ffb27a'];
  for (let i = 0; i < 25; i++) {
    const x = x0 + r() * CHUNK, y = y0 + r() * CHUNK, color = flowerColors[Math.floor(r() * 5)], s = 0.7 + r() * 0.6, keep = r();
    if (keep < biomeAt(world, x, y).flowers / 25 && !pondAt(world, x, y, 20)) ch.flowers.push({ x, y, color, s });
  }
  for (let i = 0; i < 3; i++) {
    const x = x0 + r() * CHUNK, y = y0 + r() * CHUNK, s = 0.6 + r() * 0.8, keep = r();
    const bb = biomeAt(world, x, y);
    if (keep < bb.rocks / 3 && !pondAt(world, x, y, 10)) ch.rocks.push({ x, y, s, snow: bb === BIOMES.snow });
  }
  for (const f of featuresAt(world, x0 + CHUNK / 2, y0 + CHUNK / 2)) {
    if (f.kind !== 'forest') continue;
    const k = Math.round((70 * CHUNK * CHUNK) / (Math.PI * (f.r * 1.1) ** 2));
    for (let i = 0; i < k; i++) {
      const x = x0 + r() * CHUNK, y = y0 + r() * CHUNK;
      if (dist(x, y, f.x, f.y) < f.r * 1.1 && biomeAt(world, x, y) !== BIOMES.snow) ch.mushrooms.push({ x, y });
    }
  }
  for (const h of world.houses) if (h.x >= x0 && h.x < x0 + CHUNK && h.y >= y0 && h.y < y0 + CHUNK) ch.houses.push(h);
  return ch;
}

export function canPlaceDecor(world, x, y, margin) {
  if (x < 20 || y < 20 || x > MAP.w - 20 || y > MAP.h - 20) return false;
  if (pondAt(world, x, y, margin)) return false;
  for (const f of featuresAt(world, x, y)) if (f.kind === 'village' && dist(x, y, f.x, f.y) < f.r - 40) return false;
  if (dist(x, y, world.spawn.x, world.spawn.y) < 150) return false;
  for (const p of world.paths) {
    for (let i = 0; i < p.length - 1; i++) {
      if (distToSegment(x, y, p[i], p[i + 1]) < 45) return false;
    }
  }
  return true;
}

// 반지름 r인 몸이 (x, y)에 설 수 있는가
export function isBlocked(world, x, y, r, { allowWater = false } = {}) {
  if (x < r || y < r || x > MAP.w - r || y > MAP.h - r) return true;
  if (!allowWater && isWater(world, x, y, -r * 0.3)) return true;
  for (const ch of chunksInRect(world, x - 80, y - 60, x + 80, y + 60)) {
    for (const h of ch.houses) {
      if (x > h.x - h.w / 2 - r && x < h.x + h.w / 2 + r && y > h.y - h.h / 2 - r && y < h.y + h.h / 2 + r * 0.3) return true;
    }
    for (const t of ch.trees) {
      const dx = x - t.x, dy = y - t.y, R = 12 * t.size + r;
      if (dx * dx + dy * dy < R * R) return true;
    }
  }
  return false;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
