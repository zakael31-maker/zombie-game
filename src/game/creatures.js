// 생명체 종류와 행동. 새 생명체를 추가하려면 TYPES에 하나 더 적으면 된다.
import { MAP, CHUNK, isBlocked, isWater, chunksInRect, featuresInRect, nearestPond } from './world.js';
import { biomeAt } from './biomes.js';
import { rand, dist, pick } from '../core/rng.js';

// edible: 먹을 수 있는가 / gain: 먹었을 때 얻는 것
// 어디에 몇 마리 사는지는 biomes.js(들판)와 아래 FEATURE_SPAWNS(마을·숲·연못)에서 정한다
export const TYPES = {
  rabbit:    { name: '토끼', radius: 8,  edible: true,  flee: 110, gain: { speed: 3 },          trait: 'ears' },
  hen:       { name: '닭',   radius: 9,  edible: true,  flee: 80,  gain: { speed: 1, power: 1 }, trait: 'feather' },
  chick:     { name: '병아리', radius: 5, edible: true,  flee: 70,  gain: { speed: 1 },          trait: 'feather' },
  villager:  { name: '마을 사람', radius: 10, edible: true, flee: 70, gain: { power: 3 },          trait: 'hat' },
  cat:       { name: '고양이', radius: 8, edible: false, flee: 0 },
  duck:      { name: '오리', radius: 8,  edible: false, flee: 0 },
  butterfly: { name: '나비', radius: 4,  edible: false, flee: 0 },
  spirit:    { name: '버섯 정령', radius: 8, edible: true, flee: 60, gain: { speed: 2, power: 2 }, trait: 'glow' },
  // 느린 친구들 (처음에 잡기 쉬움)
  snail:     { name: '달팽이', radius: 6, edible: true, flee: 0, gain: { power: 1 },          trait: 'shell' },
  turtle:    { name: '거북이', radius: 9, edible: true, flee: 0, gain: { power: 2 },          trait: 'armor' },
  caterpillar: { name: '애벌레', radius: 5, edible: true, flee: 0, gain: { speed: 1 },        trait: 'antenna' },
  frog:      { name: '개구리', radius: 7, edible: true, flee: 55, gain: { speed: 2 },         trait: 'frog' },
  hedgehog:  { name: '고슴도치', radius: 8, edible: true, flee: 0, gain: { power: 2 },         trait: 'spikes' },
  ladybug:   { name: '무당벌레', radius: 4, edible: true, flee: 0, gain: { speed: 1 },        trait: 'dots' },
};

// 외형 변화가 생기려면 같은 계열을 몇 번 먹어야 하는지
export const TRAIT_NEED = { ears: 3, feather: 4, hat: 2, glow: 1, shell: 3, armor: 2, antenna: 3, frog: 2, spikes: 2, dots: 4 };

let nextId = 1;

export function createCreature(type, x, y, extra = {}) {
  return {
    id: nextId++, type, x, y,
    vx: 0, vy: 0, facing: 1,
    mode: 'idle', t: rand(0.5, 2), anim: Math.random() * 10,
    color: pick(['#7ec8e3', '#f7a6b8', '#ffd36e', '#a8e6a1', '#c3a6f7', '#ffb37a']),
    fur: pick(['#f4a259', '#9a9a9a', '#3d3d3d', '#f5f0e6']),
    ...extra,
  };
}

// ---------------- 생명체 불러오기 / 치우기 ----------------
// 좀비 주변(ACTIVE)에 있는 조각과 지형에만 생명체가 산다. 멀어지면(DESPAWN) 치운다.
// 화면보다 훨씬 바깥에서 생기고 사라지기 때문에 눈에 띄지 않는다.
export const ACTIVE = 1500, DESPAWN = 1900;

// 마을·숲·연못에 사는 생명체 (지형 크기에 맞춰)
const FEATURE_SPAWNS = {
  village: () => ({ villager: 9, hen: 6 }),
  forest: (f) => ({ spirit: 4 * (f.r / 430) ** 2, hedgehog: 6 * (f.r / 430) ** 2 }),
  pond: (f) => ({ duck: 1 + f.rx / 80, turtle: 1 + f.rx / 100, frog: 1.5 + f.rx / 70 }),
};

function roundQuota(q) {
  const out = {};
  for (const [t, n] of Object.entries(q)) { const k = Math.floor(n + Math.random()); if (k > 0) out[t] = k; }
  return out;
}

export function streamCreatures(state, initial = false) {
  const { world, zombie: z } = state;
  state.zones ??= new Map();
  const zones = state.zones;
  // 1) 새로 가까워진 조각·지형에 생명체 채우기
  for (const ch of chunksInRect(world, z.x - ACTIVE, z.y - ACTIVE, z.x + ACTIVE, z.y + ACTIVE)) {
    const key = 'c' + ch.key, x = ch.x0 + CHUNK / 2, y = ch.y0 + CHUNK / 2;
    if (zones.has(key) || dist(x, y, z.x, z.y) > ACTIVE) continue;
    const zone = { key, x, y, chunk: ch, quota: roundQuota(biomeAt(world, x, y).creatures), refill: rand(60, 180) };
    zones.set(key, zone);
    for (const [type, n] of Object.entries(zone.quota)) for (let i = 0; i < n; i++) spawnIn(state, zone, type, () => true);
  }
  for (const f of featuresInRect(world, z.x - ACTIVE, z.y - ACTIVE, z.x + ACTIVE, z.y + ACTIVE)) {
    const key = 'f' + f.id;
    if (zones.has(key) || !FEATURE_SPAWNS[f.kind] || dist(f.x, f.y, z.x, z.y) > ACTIVE) continue;
    const zone = { key, x: f.x, y: f.y, feature: f, quota: roundQuota(FEATURE_SPAWNS[f.kind](f)), refill: rand(60, 180) };
    zones.set(key, zone);
    for (const [type, n] of Object.entries(zone.quota)) for (let i = 0; i < n; i++) spawnIn(state, zone, type, () => true);
  }
  // 2) 멀어진 생명체와 구역 치우기 (친구, 잡혀가는 중, 어질어질한 애들은 그대로)
  const busy = new Set();
  for (const c of state.creatures) if (c.task) busy.add(c.task.target);
  state.creatures = state.creatures.filter((c) => c.friend || c.carriedBy || c.stunned > 0 || busy.has(c.id) || dist(c.x, c.y, z.x, z.y) < DESPAWN);
  for (const [k, zone] of zones) if (dist(zone.x, zone.y, z.x, z.y) > DESPAWN) zones.delete(k);
  if (initial) return;
  // 3) 줄어든 구역은 아주 천천히 다시 채우기 (좀비가 안 보는 곳에)
  const counts = new Map();
  for (const c of state.creatures) if (!c.friend && c.src) {
    const m = counts.get(c.src) || counts.set(c.src, {}).get(c.src);
    m[c.type] = (m[c.type] || 0) + 1;
  }
  const far = (x, y) => dist(x, y, z.x, z.y) > 500;
  for (const zone of zones.values()) {
    zone.refill -= 0.5;
    if (zone.refill > 0) continue;
    zone.refill = rand(60, 180);
    const have = counts.get(zone.key) || {};
    for (const [type, n] of Object.entries(zone.quota)) if ((have[type] || 0) < n) spawnIn(state, zone, type, far);
  }
}

function spawnIn(state, zone, type, ok) {
  const spot = spawnSpot(state.world, zone, type, ok);
  if (!spot) return;
  const extra = { src: zone.key };
  if (zone.feature?.kind === 'pond') extra.pond = zone.feature;
  else if (zone.feature) extra.home = zone.feature;
  const c = createCreature(type, spot.x, spot.y, extra);
  state.creatures.push(c);
  if (type === 'hen') {
    for (let k = 0; k < 3; k++) state.creatures.push(createCreature('chick', spot.x + rand(-20, 20), spot.y + rand(-20, 20), { mom: c.id, src: zone.key, home: c.home }));
  }
}

function spawnSpot(world, zone, type, ok) {
  const land = (x, y) => !isBlocked(world, x, y, 12) && ok(x, y);
  const f = zone.feature;
  const tryN = (n, gen, test) => { for (let i = 0; i < n; i++) { const [x, y] = gen(); if (test(x, y)) return { x, y }; } return null; };
  if (!f) {
    const ch = zone.chunk, gen = () => [ch.x0 + Math.random() * CHUNK, ch.y0 + Math.random() * CHUNK];
    return tryN(30, gen, type === 'butterfly' ? ok : land);
  }
  if (f.kind === 'pond') {
    if (type === 'duck') return tryN(20, () => [f.x + rand(-0.5, 0.5) * f.rx, f.y + rand(-0.5, 0.5) * f.ry], ok);
    // 연못가 (물 바로 바깥)
    return tryN(60, () => { const a = Math.random() * Math.PI * 2, k = rand(1.08, 1.35); return [f.x + Math.cos(a) * f.rx * k, f.y + Math.sin(a) * f.ry * k]; }, land);
  }
  return tryN(200, () => { const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * f.r; return [f.x + Math.cos(a) * d, f.y + Math.sin(a) * d]; }, land);
}

// ---------------- 행동 ----------------
export function updateCreature(c, state, dt) {
  const def = TYPES[c.type];
  const z = state.zombie;
  const dz = dist(c.x, c.y, z.x, z.y);
  c.anim += dt;
  c.t -= dt;

  // 겁 많은 애들은 좀비가 다가오면 도망 (좀비가 가만히 있으면 덜 무서워함)
  // 가만히 있거나 살금살금 기어가면 덜 무서워한다
  const fleeRange = def.flee * (!z.moving ? 0.55 : z.moveMode === 'crawl' ? 0.7 : z.moveMode === 'run' ? 1.3 : 1);
  if (c.calm > 0) c.calm -= dt;
  if (def.flee && dz < fleeRange && c.mode !== 'sleep' && !(c.calm > 0)) {
    c.mode = 'flee';
    c.t = rand(0.6, 1.2);
  }

  switch (c.type) {
    case 'rabbit': return rabbit(c, state, dt);
    case 'hen': return wander(c, state, dt, 22, [1, 3], [1, 2.5]);
    case 'chick': return chick(c, state, dt);
    case 'villager': return wander(c, state, dt, 28, [1.5, 4], [2, 5]);
    case 'cat': return cat(c, state, dt, dz);
    case 'duck': return duck(c, state, dt);
    case 'butterfly': return butterfly(c, state, dt);
    case 'spirit': return spirit(c, state, dt);
    case 'snail': return crawl(c, state, dt, 5, [3, 8], [3, 7]);
    case 'ladybug': return crawl(c, state, dt, 7, [1, 4], [1, 3]);
    case 'caterpillar': return caterpillar(c, state, dt);
    case 'turtle': return turtle(c, state, dt, dz);
    case 'hedgehog': return hedgehog(c, state, dt, dz);
    case 'frog': return frog(c, state, dt);
  }
}

// 느릿느릿 기어다니기
function crawl(c, state, dt, speed, idleT, walkT) {
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(...walkT); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), speed, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(...idleT); }
  }
}

// 애벌레 → 번데기 → 나비
function caterpillar(c, state, dt) {
  c.age = (c.age || 0) + dt;
  c.grow ??= rand(90, 160);
  if (c.mode === 'cocoon') {
    if (c.t <= 0) {
      c.type = 'butterfly';
      c.mode = 'walk';
      c.life = rand(150, 240);
      c.dir = Math.random() * Math.PI * 2;
      c.t = 0.5;
      state.events.push({ type: 'metamorph', x: c.x, y: c.y });
    }
    return;
  }
  if (c.age > c.grow) { c.mode = 'cocoon'; c.t = 20; return; }
  crawl(c, state, dt, 6, [1, 4], [2, 5]);
}

// 거북이: 좀비가 다가오면 껍질 속에 숨는다
function turtle(c, state, dt, dz) {
  const z = state.zombie;
  if (dz < 60 && z.moving) { c.mode = 'hide'; c.t = rand(3, 5); return; }
  if (c.mode === 'hide') { if (c.t <= 0) { c.mode = 'idle'; c.t = 1; } return; }
  crawl(c, state, dt, 8, [2, 6], [2, 5]);
}

// 고슴도치: 놀라면 동그랗게 말린다
function hedgehog(c, state, dt, dz) {
  const z = state.zombie;
  if (dz < 55 && z.moving) { c.mode = 'ball'; c.t = rand(2.5, 4); return; }
  if (c.mode === 'ball') { if (c.t <= 0) { c.mode = 'idle'; c.t = 1; } return; }
  crawl(c, state, dt, 12, [1.5, 4], [1, 3]);
}

// 개구리: 가만히 있다가 가끔 폴짝
function frog(c, state, dt) {
  if (c.mode === 'flee') {
    if (!c.hopping) { c.hopping = 0.35; c.dir = Math.atan2(c.y - state.zombie.y, c.x - state.zombie.x); }
  } else if (c.mode === 'idle' && c.t <= 0) {
    c.hopping = 0.35;
    // 연못에서 너무 멀어지면 연못 쪽으로
    const p = c.pond || nearestPond(state.world, c.x, c.y);
    c.dir = p && dist(c.x, c.y, p.x, p.y) > Math.max(p.rx, p.ry) * 1.5
      ? Math.atan2(p.y - c.y, p.x - c.x)
      : Math.random() * Math.PI * 2;
    c.t = rand(2, 6);
  }
  if (c.hopping > 0) {
    c.hopping -= dt;
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 70, dt);
    if (c.hopping <= 0) { c.hopping = 0; if (c.mode === 'flee') { c.mode = 'idle'; c.t = rand(1, 3); } }
  }
}

function fleeFrom(c, state, dt, speed) {
  const z = state.zombie;
  const a = Math.atan2(c.y - z.y, c.x - z.x) + rand(-0.3, 0.3);
  step(c, state, Math.cos(a), Math.sin(a), speed, dt);
  if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 1.5); }
}

function rabbit(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 120);
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(0.4, 1.2); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 65, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3.5); }
  }
}

function wander(c, state, dt, speed, idleT, walkT) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, speed * 2.2);
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(...walkT);
    c.dir = Math.random() * Math.PI * 2;
    const h = c.home;
    if (h && dist(c.x, c.y, h.x, h.y) > h.r) c.dir = Math.atan2(h.y - c.y, h.x - c.x); // 집 근처로 돌아가기
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), speed, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(...idleT); }
  }
}

function chick(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 70);
  const mom = state.creatures.find((m) => m.id === c.mom);
  if (!mom) return wander(c, state, dt, 18, [1, 2], [0.5, 1.5]);
  const d = dist(c.x, c.y, mom.x, mom.y);
  if (d > 28) {
    step(c, state, (mom.x - c.x) / d, (mom.y - c.y) / d, 40, dt);
    c.mode = 'walk';
  } else {
    c.mode = 'idle';
  }
}

// 고양이: 좀비가 가만히 있으면 슬금슬금 다가와서 옆에 앉는다
function cat(c, state, dt, dz) {
  const z = state.zombie;
  if (!z.moving && z.idleTime > 3 && dz < 260 && dz > 34) {
    c.mode = 'walk';
    step(c, state, (z.x + 26 - c.x) / dz, (z.y + 6 - c.y) / dz, 30, dt);
    return;
  }
  if (dz <= 34 && !z.moving) { c.mode = 'sit'; return; }
  if (c.mode === 'sit') { c.mode = 'idle'; c.t = rand(1, 3); }
  if (c.mode === 'sleep') {
    if (c.t <= 0) { c.mode = 'idle'; c.t = 1; }
    return;
  }
  if (c.mode === 'idle' && c.t <= 0) {
    if (Math.random() < 0.3) { c.mode = 'sleep'; c.t = rand(8, 20); return; }
    c.mode = 'walk'; c.t = rand(1, 3); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 26, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(2, 5); }
  }
}

function duck(c, state, dt) {
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(2, 5); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    const nx = c.x + Math.cos(c.dir) * 14 * dt, ny = c.y + Math.sin(c.dir) * 14 * dt;
    if (isWater(state.world, nx, ny, -14)) {
      c.x = nx; c.y = ny;
      if (Math.abs(Math.cos(c.dir)) > 0.1) c.facing = Math.sign(Math.cos(c.dir));
    } else {
      c.dir += Math.PI * rand(0.5, 1.5);
    }
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 4); }
  }
}

function butterfly(c, state, dt) {
  // 애벌레에서 태어난 나비는 한동안 놀다가 멀리 날아간다
  if (c.life != null) {
    c.life -= dt;
    if (c.life <= 0) { c.dying = 0; return; }
  }
  if (c.t <= 0) { c.dir = (c.dir ?? 0) + rand(-1.2, 1.2); c.t = rand(0.5, 2); }
  c.x += Math.cos(c.dir) * 22 * dt;
  c.y += Math.sin(c.dir) * 22 * dt;
  c.facing = Math.cos(c.dir) >= 0 ? 1 : -1;
  if (c.x < 40 || c.x > MAP.w - 40 || c.y < 40 || c.y > MAP.h - 40) {
    c.dir = Math.atan2(MAP.h / 2 - c.y, MAP.w / 2 - c.x);
  }
}

function spirit(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 50);
  return wander(c, state, dt, 14, [2, 5], [1, 3]);
}

// 벽에 막히면 미끄러지고, 완전히 막히면 방향을 바꾼다
function step(c, state, dx, dy, speed, dt) {
  const r = TYPES[c.type].radius;
  const nx = c.x + dx * speed * dt, ny = c.y + dy * speed * dt;
  const w = state.world;
  if (!isBlocked(w, nx, ny, r)) { c.x = nx; c.y = ny; }
  else if (!isBlocked(w, nx, c.y, r)) c.x = nx;
  else if (!isBlocked(w, c.x, ny, r)) c.y = ny;
  else { c.dir = Math.random() * Math.PI * 2; }
  if (Math.abs(dx) > 0.15) c.facing = Math.sign(dx);
}

// ---------------- 좀비 친구 ----------------
// 물어서 친구가 된 생명체는 좀비 뒤를 졸졸 따라다니고, 좀비가 쉬면 같이 쉰다
export function updateFriend(c, state, dt, i, followSpeed) {
  const z = state.zombie;
  c.anim += dt;
  c.t -= dt;
  if (c.task && huntStep(c, state, dt, followSpeed)) return;
  // 좀비 뒤쪽에 옹기종기 모이는 자리 (친구마다 다른 자리)
  const a = i * 2.4;
  const r = 16 + i * 5;
  // 좀비가 오래 가만히 있으면 근처를 살짝 어슬렁거린다
  if (!z.moving && z.idleTime > 4 && !z.restPose) {
    if (c.t <= 0) { c.wx = rand(-30, 30); c.wy = rand(-20, 20); c.t = rand(3, 7); }
  } else { c.wx = 0; c.wy = 0; }
  const tx = z.x - z.facing * 20 + Math.cos(a) * r + (c.wx || 0);
  const ty = z.y + 4 + Math.sin(a) * r * 0.6 + (c.wy || 0);
  const d = dist(c.x, c.y, tx, ty);
  if (d > 450) { c.x = tx; c.y = ty; return; } // 너무 멀어지면 순간이동
  if (d > 6) {
    const sp = Math.max(30, followSpeed * 1.15) * Math.min(1.6, 0.4 + d / 40);
    const dx = (tx - c.x) / d, dy = (ty - c.y) / d;
    const ox = c.x, oy = c.y;
    step(c, state, dx, dy, sp, dt);
    // 나무 같은 데 걸리면 그냥 스르륵 통과 (좀비니까)
    if (c.x === ox && c.y === oy) { c.x += dx * sp * dt; c.y += dy * sp * dt; }
    if (Math.abs(dx) > 0.15) c.facing = Math.sign(dx);
    c.mode = 'walk';
  } else {
    c.mode = z.pose === 'lie' ? 'sleep' : (z.pose === 'sit' || z.pose === 'prone') ? 'sit' : 'idle';
    if (z.restPose) c.facing = z.facing;
  }
}

// 잡아오기: 목표에게 달려가서 잡고 → 좀비 옆에 데려다 놓는다. 처리했으면 true
function huntStep(c, state, dt, followSpeed) {
  const z = state.zombie;
  const task = c.task;
  task.time -= dt;
  const sp = Math.max(60, followSpeed * 1.3);
  const prey = state.creatures.find((p) => p.id === task.target);
  const moveTo = (tx, ty, speed) => {
    const d = dist(c.x, c.y, tx, ty);
    if (d < 1) return d;
    const dx = (tx - c.x) / d, dy = (ty - c.y) / d;
    const ox = c.x, oy = c.y;
    step(c, state, dx, dy, speed, dt);
    if (c.x === ox && c.y === oy) { c.x += dx * speed * dt; c.y += dy * speed * dt; }
    if (Math.abs(dx) > 0.15) c.facing = Math.sign(dx);
    c.mode = 'walk';
    return d;
  };
  if (task.kind === 'hunt') {
    // 목표가 사라졌거나(먹힘/다른 친구 차지) 너무 오래 걸리면 포기하고 돌아온다
    if (!prey || prey.dying != null || prey.friend || prey.carriedBy || task.time <= 0) {
      c.task = null;
      if (task.time <= 0) state.events.push({ type: 'giveup', x: c.x, y: c.y });
      return false;
    }
    const d = moveTo(prey.x, prey.y, sp);
    if (d < 12) {
      prey.carriedBy = c.id;
      prey.mode = 'carried';
      c.task = { kind: 'return', target: prey.id, time: 20 };
      state.events.push({ type: 'caught', x: prey.x, y: prey.y, creature: prey.type });
    }
    return true;
  }
  if (task.kind === 'return') {
    if (!prey || prey.carriedBy !== c.id) { c.task = null; return false; }
    const tx = z.x + z.facing * 22, ty = z.y + 6;
    const d = moveTo(tx, ty, sp);
    if (d < 14 || task.time <= 0) {
      dropPrey(prey, c);
      c.task = null;
      state.events.push({ type: 'delivered', x: prey.x, y: prey.y, creature: prey.type });
    }
    return true;
  }
  return false;
}

// 친구가 데려온 생명체는 잠깐 어질어질 (그 사이에 먹거나 물 수 있다)
export function dropPrey(prey, carrier) {
  prey.carriedBy = null;
  prey.x = carrier.x + carrier.facing * 6; prey.y = carrier.y + 2;
  prey.stunned = 8;
  prey.mode = 'stunned';
}

// 잡혀 가는 중 / 어질어질한 생명체. 처리했으면 true
export function updateCaptive(c, state, dt) {
  if (c.carriedBy) {
    const f = state.creatures.find((p) => p.id === c.carriedBy);
    if (!f || !f.friend) { c.carriedBy = null; c.stunned = 4; c.mode = 'stunned'; return true; }
    c.x = f.x; c.y = f.y + 0.5; c.facing = f.facing;
    c.anim += dt;
    return true;
  }
  if (c.stunned > 0) {
    c.stunned -= dt;
    c.anim += dt;
    c.mode = 'stunned';
    if (c.stunned <= 0) { c.mode = 'idle'; c.t = 0.5; c.calm = 2; }
    return true;
  }
  return false;
}
