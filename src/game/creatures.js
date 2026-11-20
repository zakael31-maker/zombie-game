// 생명체 종류와 행동. 새 생명체를 추가하려면 TYPES에 하나 더 적으면 된다.
import { MAP, CHUNK, isBlocked, isWater, isIce, chunksInRect, featuresInRect, nearestPond } from './world.js';
import { biomeAt, biomeIdAt } from './biomes.js';
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
  // ---- 겨울 ----
  hare:      { name: '눈토끼', radius: 8, edible: true, flee: 120, gain: { speed: 3 },           trait: 'earmuffs' },
  penguin:   { name: '펭귄', radius: 9, edible: true, flee: 55, gain: { power: 2 },             trait: 'scarf' },
  fox:       { name: '북극여우', radius: 8, edible: false, flee: 0 },
  snowman:   { name: '눈사람 정령', radius: 9, edible: true, flee: 45, gain: { speed: 2, power: 2 }, trait: 'beanie' },
  // ---- 사막 ----
  lizard:    { name: '도마뱀', radius: 6, edible: true, flee: 95, gain: { speed: 3 },            trait: 'shades' },
  meerkat:   { name: '미어캣', radius: 7, edible: true, flee: 0, gain: { speed: 1, power: 1 },  trait: 'safari' },
  camel:     { name: '낙타', radius: 13, edible: false, flee: 0 },
  quokka:    { name: '쿼카', radius: 7, edible: true, flee: 0, gain: { speed: 1, power: 1 }, trait: 'smile' },
  // 싸우는 애들 (fight): 좀비가 가까이 오면 쫓아와서 공격한다. hp = 콩! 몇 번에 어질어질 · dmg = 한 번에 깎는 체력
  goose:     { name: '거위', radius: 8, edible: true, flee: 0, gain: { speed: 1, power: 2 }, fight: { hp: 3, dmg: 1, aggro: 90, speed: 62, reach: 18, cd: 1.7, windup: 0.45 } },
  farmer:    { name: '빗자루 아저씨', radius: 10, edible: true, flee: 0, gain: { power: 4 }, trait: 'hat', fight: { hp: 5, dmg: 2, aggro: 110, speed: 50, reach: 24, cd: 1.6, windup: 0.55 } },
  scorpion:  { name: '전갈', radius: 7, edible: true, flee: 0, gain: { power: 3 }, fight: { hp: 4, dmg: 2, aggro: 80, speed: 55, reach: 17, cd: 1.4, windup: 0.5 } },
  bee:       { name: '꿀벌', radius: 4, edible: true, flee: 0, gain: { speed: 2 }, fight: { hp: 1, dmg: 1, aggro: 100, speed: 78, reach: 14, cd: 1.6, windup: 0.35 } },
  horse:     { name: '말', radius: 14, edible: false, flee: 0, ride: true },
  prickle:   { name: '선인장 정령', radius: 8, edible: true, flee: 45, gain: { speed: 2, power: 2 }, trait: 'cactus' },
  // ---- 밀림 ----
  monkey:    { name: '원숭이', radius: 8, edible: true, flee: 95, gain: { speed: 2, power: 1 },  trait: 'tail' },
  parrot:    { name: '앵무새', radius: 6, edible: true, flee: 80, gain: { speed: 2 },            trait: 'parrot' },
  sloth:     { name: '나무늘보', radius: 10, edible: false, flee: 0 },
  bloom:     { name: '꽃 정령', radius: 8, edible: true, flee: 45, gain: { speed: 2, power: 2 }, trait: 'hibiscus' },
  // ---- 바닷가 ----
  crab:      { name: '꽃게', radius: 6, edible: true, flee: 0, gain: { power: 2 },              trait: 'pincers' },
  gull:      { name: '갈매기', radius: 7, edible: true, flee: 85, gain: { speed: 2, power: 1 }, trait: 'sailor' },
  seal:      { name: '물범', radius: 12, edible: false, flee: 0 },
  starry:    { name: '불가사리 정령', radius: 7, edible: true, flee: 45, gain: { speed: 2, power: 2 }, trait: 'starpin' },
};

// 먹거나 물려면 먼저 콩! 몇 번 때려서 어질어질하게 만들어야 한다.
// hp = 버티는 힘 (좀비 콩! 한 번 = 1 + 힘×0.15) · react = 맞았을 때 하는 행동
//   flee  버둥거리며 도망 · shell 껍질에 숨기 (콩!이 반만 들어감) · spiky 가시 공 (때리면 좀비도 따끔)
//   brawl 맞으면 화나서 치고받기 · mixed 어른은 대들고 아이는 도망 · fight 먼저 덤비는 애들 (TYPES.fight)
export const TOUGH = {
  ladybug: { hp: 1, react: 'flee' }, caterpillar: { hp: 1, react: 'flee' }, chick: { hp: 1, react: 'flee' },
  snail: { hp: 1.5, react: 'shell' }, turtle: { hp: 3, react: 'shell' }, hedgehog: { hp: 2.5, react: 'spiky' },
  rabbit: { hp: 2, react: 'flee' }, hare: { hp: 2, react: 'flee' }, frog: { hp: 2, react: 'flee' }, lizard: { hp: 2, react: 'flee' },
  hen: { hp: 2, react: 'flee' }, parrot: { hp: 2, react: 'flee' }, gull: { hp: 2.5, react: 'flee' }, quokka: { hp: 2, react: 'flee' },
  spirit: { hp: 3, react: 'flee' }, snowman: { hp: 3.5, react: 'flee' }, prickle: { hp: 3, react: 'spiky' },
  bloom: { hp: 3, react: 'flee' }, starry: { hp: 3, react: 'flee' },
  meerkat: { hp: 2.5, react: 'brawl' }, penguin: { hp: 3, react: 'brawl' }, monkey: { hp: 3, react: 'brawl' }, crab: { hp: 3, react: 'brawl' },
  villager: { hp: 4, react: 'mixed' },
};
// 치고받는 애들이 화났을 때 (fight와 같은 모양)
const BRAWL = {
  meerkat: { dmg: 1, aggro: 90, speed: 52, reach: 15, cd: 1.5, windup: 0.4 },
  penguin: { dmg: 1, aggro: 90, speed: 40, reach: 17, cd: 1.7, windup: 0.5 },
  monkey: { dmg: 1, aggro: 100, speed: 68, reach: 16, cd: 1.4, windup: 0.4 },
  crab: { dmg: 1, aggro: 80, speed: 44, reach: 15, cd: 1.5, windup: 0.45 },
  villager: { dmg: 1, aggro: 100, speed: 48, reach: 20, cd: 1.8, windup: 0.55 },
};
export const maxHpOf = (type) => TYPES[type]?.fight?.hp ?? TOUGH[type]?.hp ?? 1;
const fightOf = (c) => TYPES[c.type].fight || BRAWL[c.type];
// 지금 반격하는 중인가 (화나서 덤비는 중)
export const isBrawling = (c) => !!(c.provoked && c.angry);

// 외형 변화가 생기려면 같은 계열을 몇 번 먹어야 하는지
// 캐릭터별로 생명체가 알아채는 거리 배율 (살금이는 덜 들킨다)
export const CHAR_SNEAK = { meow: 0.6 };
export const TRAIT_NEED = { ears: 3, feather: 4, hat: 2, glow: 1, shell: 3, armor: 2, antenna: 3, frog: 2, spikes: 2, dots: 4, earmuffs: 3, scarf: 2, beanie: 1, shades: 3, safari: 2, cactus: 1, tail: 2, parrot: 3, hibiscus: 1, pincers: 3, sailor: 2, starpin: 1, smile: 2 };

let nextId = 1;

export function createCreature(type, x, y, extra = {}) {
  return {
    id: nextId++, type, x, y,
    vx: 0, vy: 0, facing: 1,
    mode: 'idle', t: rand(0.5, 2), anim: Math.random() * 10,
    color: pick(['#7ec8e3', '#f7a6b8', '#ffd36e', '#a8e6a1', '#c3a6f7', '#ffb37a']),
    fur: pick(['#f4a259', '#9a9a9a', '#3d3d3d', '#f5f0e6']),
    coat: Math.floor(Math.random() * 5), // 말 털색
    hp: maxHpOf(type),
    ...extra,
  };
}

// ---------------- 생명체 불러오기 / 치우기 ----------------
// 좀비 주변(ACTIVE)에 있는 조각과 지형에만 생명체가 산다. 멀어지면(DESPAWN) 치운다.
// 화면보다 훨씬 바깥에서 생기고 사라지기 때문에 눈에 띄지 않는다.
export const ACTIVE = 1500, DESPAWN = 1900;

// 마을·숲·연못에 사는 생명체 (지형 크기에 맞춰)
const FEATURE_SPAWNS = {
  // 마을 사람과 동물 구성은 지역마다 다르다 (집 수에 맞춰). 가운데 처음 동네는 원래 그대로.
  village: (f) => {
    if (!f.houses) return { villager: 9, hen: 6, horse: 2.5, farmer: 1.6 };
    const n = f.houses.length, p = 1.4 * n;
    switch (f.biome) {
      case 'snow': return { villager: p, snowman: 0.5 * n, hare: 0.4 * n, fox: 0.15 * n };
      case 'desert': return { villager: p, camel: 0.35 * n, meerkat: 0.15 * n, lizard: 0.3 * n };
      case 'jungle': return { villager: p, parrot: 0.5 * n, monkey: 0.4 * n, sloth: 0.1 * n };
      case 'beach': return { villager: p, crab: 0.5 * n, gull: 0.4 * n, seal: 0.15 * n };
      default: return { villager: p, hen: 0.8 * n, horse: 0.25 * n, farmer: 0.25 * n };
    }
  },
  forest: (f) => (f.oasis ? { camel: 2 * (f.r / 360) ** 2, lizard: 2 * (f.r / 360) ** 2, prickle: 1, scorpion: 1 }
    : f.jungle ? { monkey: 3 * (f.r / 430) ** 2, parrot: 3 * (f.r / 430) ** 2, sloth: 1.5 * (f.r / 430) ** 2, bloom: 1, bee: 2.5 * (f.r / 430) ** 2 }
    : f.beach ? { crab: 2 * (f.r / 430) ** 2, gull: 2 * (f.r / 430) ** 2 }
    : f.snow ? { snowman: 3 * (f.r / 430) ** 2, fox: 2 * (f.r / 430) ** 2, hare: 3 * (f.r / 430) ** 2 }
    : { spirit: 4 * (f.r / 430) ** 2, hedgehog: 6 * (f.r / 430) ** 2 }),
  pond: (f) => (f.ice ? { penguin: 2 + f.rx / 50 } : { duck: 1 + f.rx / 80, turtle: 1 + f.rx / 100, frog: 1.5 + f.rx / 70, ...(f.oasis ? {} : { goose: 0.8 + f.rx / 160 }) }),
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
  state.creatures = state.creatures.filter((c) => c.friend || c.ridden || c.carriedBy || c.stunned > 0 || busy.has(c.id) || dist(c.x, c.y, z.x, z.y) < DESPAWN);
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
  if (type === 'villager' || type === 'farmer') { // 사는 지역에 맞는 옷차림, 가끔 어린이
    extra.look = zone.feature?.biome || biomeIdAt(state.world, spot.x, spot.y);
    if (type === 'villager' && Math.random() < 0.3) extra.kid = true;
  }
  if (zone.feature?.kind === 'pond') extra.pond = zone.feature;
  else if (zone.feature) extra.home = zone.feature;
  const c = createCreature(type, spot.x, spot.y, extra);
  state.creatures.push(c);
  if (type === 'meerkat') { // 미어캣은 가족끼리 굴 하나에 모여 산다
    c.burrow = { x: spot.x, y: spot.y, owner: c.id };
    for (let k = 0; k < 2; k++) state.creatures.push(createCreature('meerkat', spot.x + rand(-14, 14), spot.y + rand(-10, 10), { src: zone.key, burrow: c.burrow }));
  }
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
    if (type === 'duck' || type === 'penguin') return tryN(20, () => [f.x + rand(-0.5, 0.5) * f.rx, f.y + rand(-0.5, 0.5) * f.ry], ok);
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
  c.ouch = Math.max(0, (c.ouch || 0) - dt);
  // 한동안 안 맞으면 기운이 다시 찬다
  c.lastHit = (c.lastHit ?? 99) + dt;
  const maxHp = maxHpOf(c.type);
  if (c.lastHit > 8 && c.hp < maxHp) c.hp = Math.min(maxHp, c.hp + dt * 0.4);
  // 맞고 버둥버둥 도망 (아주 빠르진 않게: 쫓아가면 또 콩! 할 수 있다)
  if (c.scared > 0) {
    c.scared -= dt;
    c.mode = 'flee';
    if (c.ouch <= 0) {
      const a = Math.atan2(c.y - z.y, c.x - z.x) + Math.sin(c.anim * 9) * 0.5;
      step(c, state, Math.cos(a), Math.sin(a), c.scaredSpeed || 40, dt);
    }
    if (c.scared <= 0) { c.mode = 'idle'; c.t = rand(0.4, 1); c.calm = 2.5; }
    return;
  }
  // 맞아서 화난 애: 치고받기
  if (c.provoked) {
    if (c.angry) return fighter(c, state, dt, dz, null);
    c.provoked = false;
  }

  // 겁 많은 애들은 좀비가 다가오면 도망 (좀비가 가만히 있으면 덜 무서워함)
  // 가만히 있거나 살금살금 기어가면 덜 무서워한다
  const fleeRange = def.flee * (CHAR_SNEAK[z.char] ?? 1) * (!z.moving ? 0.55 : z.moveMode === 'crawl' ? 0.7 : z.moveMode === 'run' ? 1.3 : 1);
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
    case 'snail': if (c.mode === 'hide') { if (c.t <= 0) { c.mode = 'idle'; c.t = 1; } return; } return crawl(c, state, dt, 5, [3, 8], [3, 7]);
    case 'ladybug': return crawl(c, state, dt, 7, [1, 4], [1, 3]);
    case 'caterpillar': return caterpillar(c, state, dt);
    case 'turtle': return turtle(c, state, dt, dz);
    case 'hedgehog': return hedgehog(c, state, dt, dz);
    case 'frog': return frog(c, state, dt);
    case 'hare': return rabbit(c, state, dt, 135);
    case 'fox': return cat(c, state, dt, dz);
    case 'penguin': return penguin(c, state, dt);
    case 'snowman': return snowman(c, state, dt);
    case 'lizard': return lizard(c, state, dt);
    case 'meerkat': return meerkat(c, state, dt, dz);
    case 'camel': return camel(c, state, dt);
    case 'horse': return horse(c, state, dt);
    case 'quokka': return quokka(c, state, dt, dz);
    case 'goose': return fighter(c, state, dt, dz, () => wander(c, state, dt, 20, [1, 3], [1, 2.5]));
    case 'farmer': return fighter(c, state, dt, dz, () => wander(c, state, dt, 26, [1.5, 4], [2, 5]));
    case 'scorpion': return fighter(c, state, dt, dz, () => wander(c, state, dt, 22, [1.5, 4], [0.8, 2]));
    case 'bee': return fighter(c, state, dt, dz, () => wander(c, state, dt, 34, [0.3, 1], [0.6, 1.5]));
    case 'prickle': return snowman(c, state, dt);
    case 'monkey': return monkey(c, state, dt);
    case 'parrot': case 'gull': return bird(c, state, dt);
    case 'sloth': return sloth(c, state, dt);
    case 'bloom': case 'starry': return snowman(c, state, dt);
    case 'crab': return crab(c, state, dt, dz);
    case 'seal': return seal(c, state, dt);
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

function rabbit(c, state, dt, fleeSpeed = 120) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, fleeSpeed);
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

// 펭귄: 뒤뚱뒤뚱 걷다가, 놀라거나 얼음 위에선 가끔 배로 쭈욱 미끄러진다
function penguin(c, state, dt) {
  const z = state.zombie;
  if (c.mode === 'flee') {
    c.mode = 'slide'; c.t = rand(1.2, 1.8);
    c.dir = Math.atan2(c.y - z.y, c.x - z.x) + rand(-0.4, 0.4);
  }
  if (c.mode === 'slide') {
    const ice = isIce(state.world, c.x, c.y);
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), (ice ? 85 : 55) * Math.min(1, c.t + 0.3), dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 2.5); }
    return;
  }
  if (c.mode === 'idle' && c.t <= 0) {
    if (isIce(state.world, c.x, c.y) && Math.random() < 0.35) { c.mode = 'slide'; c.t = rand(1, 2); c.dir = Math.random() * Math.PI * 2; return; }
    c.mode = 'walk'; c.t = rand(1, 3); c.dir = Math.random() * Math.PI * 2;
    const h = c.pond;
    if (h && dist(c.x, c.y, h.x, h.y) > h.rx * 1.6) c.dir = Math.atan2(h.y - c.y, h.x - c.x);
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 16, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1.5, 4); }
  }
}

// 눈사람 정령: 통통 튀며 느릿느릿
function snowman(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 42);
  if (c.mode === 'idle' && c.t <= 0) { c.mode = 'walk'; c.t = rand(1.5, 3.5); c.dir = Math.random() * Math.PI * 2; }
  else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 12, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(2, 5); }
  }
}

// 도마뱀: 쪼르르 달리다 멈칫. 멈춰 있을 땐 팔굽혀펴기
function lizard(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 125);
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(0.2, 0.5); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 85, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3.5); }
  }
}

// 미어캣: 굴 옆에서 꼿꼿이 서서 망을 보다가, 좀비가 다가오면 굴로 쏙
function meerkat(c, state, dt, dz) {
  const z = state.zombie, b = c.burrow || (c.burrow = { x: c.x, y: c.y });
  const db = dist(c.x, c.y, b.x, b.y);
  if (z.moving && dz < (z.moveMode === 'crawl' ? 55 : 85) && c.mode !== 'hide') { c.mode = 'dash'; c.t = 2; }
  if (c.mode === 'dash') {
    if (db < 4 || c.t <= 0) { c.x = b.x; c.y = b.y; c.mode = 'hide'; c.t = rand(3, 6); return; }
    step(c, state, (b.x - c.x) / db, (b.y - c.y) / db, 80, dt);
    return;
  }
  if (c.mode === 'hide') { if (c.t <= 0 && !(z.moving && dz < 85)) { c.mode = 'watch'; c.t = rand(2, 5); } return; }
  if ((c.mode === 'idle' || c.mode === 'watch') && c.t <= 0) {
    if (Math.random() < 0.45) { c.mode = 'watch'; c.t = rand(2, 6); return; }
    c.mode = 'walk'; c.t = rand(0.5, 1.4);
    c.dir = db > 40 ? Math.atan2(b.y - c.y, b.x - c.x) : Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 34, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.8, 2.5); }
  }
}

// 낙타: 느긋하게 걷다가 가끔 털썩 앉아서 쉰다
function camel(c, state, dt) {
  if (c.mode === 'sit') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3); } return; }
  if (c.mode === 'idle' && c.t <= 0 && Math.random() < 0.25) { c.mode = 'sit'; c.t = rand(12, 25); return; }
  return wander(c, state, dt, 13, [3, 7], [3, 7]);
}

// 말: 풀을 뜯다가 느긋하게 걷고, 가끔 신나서 다그닥 뛰어 본다
function horse(c, state, dt) {
  if (c.mode === 'graze') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 1.5); } return; }
  if (c.mode === 'trot') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 70, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3); }
    return;
  }
  if (c.mode === 'idle' && c.t <= 0) {
    const r = Math.random();
    if (r < 0.4) { c.mode = 'graze'; c.t = rand(4, 10); return; }
    if (r < 0.5) { c.mode = 'trot'; c.t = rand(1, 2); c.dir = Math.random() * Math.PI * 2; const h = c.home; if (h && dist(c.x, c.y, h.x, h.y) > h.r) c.dir = Math.atan2(h.y - c.y, h.x - c.x); return; }
  }
  return wander(c, state, dt, 18, [2, 5], [2, 5]);
}

// 싸우는 애들: 좀비가 다가오면 화나서 쫓아온다 → 앞에서 잠깐 뜸들이고(피할 틈) → 공격 → 살짝 물러섰다 다시.
// 좀비가 멀리 도망가거나 기절하면 흥미를 잃고 돌아간다.
function fighter(c, state, dt, dz, idle) {
  const F = fightOf(c), z = state.zombie;
  c.cd = Math.max(0, (c.cd || 0) - dt);
  const aggro = F.aggro * (CHAR_SNEAK[z.char] ?? 1);
  if (idle && !c.angry && dz < aggro && !(c.calm > 0) && !(z.fainted > 0)) {
    c.angry = true; c.mode = 'chase';
    state.events.push({ type: 'alert', x: c.x, y: c.y, creature: c.type });
  }
  if (!c.angry) return idle();
  if (z.fainted > 0 || dz > aggro * 2.6 || state.inside) { c.angry = false; c.provoked = false; c.calm = 6; c.mode = 'idle'; c.t = 1; return; }
  if (c.ouch > 0) return; // 맞고 멈칫
  const dx = (z.x - c.x) / (dz || 1), dy = (z.y - c.y) / (dz || 1);
  if (c.mode === 'windup') {
    c.facing = dx >= 0 ? 1 : -1;
    if (c.t <= 0) {
      if (dz < F.reach + 8) state.events.push({ type: 'attack', dmg: F.dmg, x: c.x, y: c.y, creature: c.type });
      c.mode = 'cool'; c.cd = F.cd; c.swing = 0.3;
    }
    return;
  }
  c.swing = Math.max(0, (c.swing || 0) - dt);
  if (c.mode === 'cool') {
    if (c.cd > F.cd * 0.5) step(c, state, -dx, -dy, F.speed * 0.4, dt);
    if (Math.abs(dx) > 0.15) c.facing = Math.sign(dx);
    if (c.cd <= 0) c.mode = 'chase';
    return;
  }
  c.mode = 'chase';
  if (dz > F.reach) step(c, state, dx, dy, F.speed, dt);
  else { c.mode = 'windup'; c.t = F.windup; }
}

// 맞았을 때 (좀비나 친구에게): 밀려나고 잠깐 멈칫, 기운이 다 빠지면 어질어질 (그때 냠/물기)
export function knockFoe(state, c, fx, fy, push) {
  const d = Math.hypot(c.x - fx, c.y - fy) || 1;
  const nx = c.x + (c.x - fx) / d * push, ny = c.y + (c.y - fy) / d * push;
  if (!isBlocked(state.world, nx, ny, 8)) { c.x = nx; c.y = ny; }
  c.ouch = 0.3; c.lastHit = 0;
  if (c.hp <= 0) {
    c.hp = 0; c.angry = false; c.provoked = false; c.scared = 0; c.stunned = 8; c.mode = 'stunned';
    state.events.push({ type: 'beaten', x: c.x, y: c.y, creature: c.type });
    return;
  }
  if (TYPES[c.type].fight) { c.mode = 'chase'; c.angry = true; return; }
  let react = TOUGH[c.type]?.react || 'flee';
  if (react === 'mixed') { c.brave ??= !c.kid && Math.random() < 0.6; react = c.brave ? 'brawl' : 'flee'; }
  if (react === 'brawl') {
    if (!c.provoked) state.events.push({ type: 'alert', x: c.x, y: c.y, creature: c.type, brawl: true });
    c.provoked = true; c.angry = true; c.mode = 'chase'; c.scared = 0;
  } else if (react === 'shell') { c.mode = 'hide'; c.t = rand(2, 3); }
  else if (react === 'spiky') { if (c.type === 'hedgehog') { c.mode = 'ball'; c.t = rand(2, 3); } }
  else {
    c.scared = rand(0.7, 1.1); c.mode = 'flee';
    c.scaredSpeed = Math.min(48, Math.max(26, (TYPES[c.type].flee || 60) * 0.4));
    state.events.push({ type: 'squirm', x: c.x, y: c.y, creature: c.type });
  }
}

// 쿼카: 겁이 없고 궁금한 게 많다. 좀비가 천천히 오면 먼저 다가와서 올려다보며 방긋
function quokka(c, state, dt, dz) {
  const z = state.zombie;
  const fast = z.moving && (z.moveMode === 'run' || z.riding);
  if (dz < 120 && dz > 30 && !fast && !(c.calm > 0)) {
    c.mode = 'hop';
    step(c, state, (z.x - c.x) / dz, (z.y - c.y) / dz, 34, dt);
    c.t = rand(1, 2);
    return;
  }
  if (dz <= 30 && !fast) { // 바로 앞에서 올려다보며 웃기
    c.mode = 'smile'; c.facing = z.x >= c.x ? 1 : -1; c.t = rand(1, 2);
    return;
  }
  if (c.mode === 'smile' || c.mode === 'hop') { c.mode = 'idle'; c.t = rand(0.5, 1.5); }
  if (c.mode === 'munch') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 2); } return; }
  if (c.mode === 'idle' && c.t <= 0 && Math.random() < 0.35) { c.mode = 'munch'; c.t = rand(3, 6); return; }
  if (c.mode === 'walk') { step(c, state, Math.cos(c.dir), Math.sin(c.dir), 26, dt); if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3); } return; }
  return wander(c, state, dt, 26, [1, 3], [0.8, 2]);
}

// 원숭이: 통통 뛰어다니다 앉아서 머리 긁적
function monkey(c, state, dt) {
  if (c.mode === 'flee') return fleeFrom(c, state, dt, 115);
  if (c.mode === 'sit') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 1.5); } return; }
  if (c.mode === 'idle' && c.t <= 0) {
    if (Math.random() < 0.3) { c.mode = 'sit'; c.t = rand(3, 7); return; }
    c.mode = 'walk'; c.t = rand(0.6, 1.6); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 50, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.8, 2.5); }
  }
}

// 앵무새 · 갈매기: 땅에서 종종 걷고 콕콕 쪼다가, 놀라면 푸드덕 날아간다
function bird(c, state, dt) {
  if (c.mode === 'flee') {
    c.alt = Math.min(22, (c.alt || 0) + dt * 60);
    const z = state.zombie, a = Math.atan2(c.y - z.y, c.x - z.x);
    c.x += Math.cos(a) * 110 * dt; c.y += Math.sin(a) * 110 * dt;
    c.x = Math.max(30, Math.min(MAP.w - 30, c.x)); c.y = Math.max(30, Math.min(MAP.h - 30, c.y));
    if (Math.abs(Math.cos(a)) > 0.15) c.facing = Math.sign(Math.cos(a));
    if (c.t <= 0) { c.mode = 'land'; c.t = 1; }
    return;
  }
  if (c.mode === 'land') {
    c.alt = Math.max(0, (c.alt || 0) - dt * 30);
    c.x += c.facing * 30 * dt;
    if (c.alt <= 0) {
      if (isBlocked(state.world, c.x, c.y, 6)) { c.mode = 'flee'; c.t = 0.5; return; } // 물이나 나무 위면 조금 더 날기
      c.mode = 'idle'; c.t = rand(1, 3);
    }
    return;
  }
  if (c.mode === 'idle' && c.t <= 0) {
    if (Math.random() < 0.4) { c.mode = 'peck'; c.t = rand(1, 2.5); return; }
    c.mode = 'walk'; c.t = rand(0.5, 1.5); c.dir = Math.random() * Math.PI * 2;
  } else if (c.mode === 'peck') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 2); } }
  else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 20, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3); }
  }
}

// 나무늘보: 아주아주 느릿느릿, 자주 잔다
function sloth(c, state, dt) {
  if (c.mode === 'sleep') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(2, 5); } return; }
  if (c.mode === 'idle' && c.t <= 0 && Math.random() < 0.5) { c.mode = 'sleep'; c.t = rand(15, 35); return; }
  crawl(c, state, dt, 3.5, [3, 8], [4, 9]);
}

// 꽃게: 옆으로 종종종. 좀비가 다가오면 모래 속으로 쏙 (눈만 빼꼼)
function crab(c, state, dt, dz) {
  const z = state.zombie;
  if (z.moving && dz < (z.moveMode === 'crawl' ? 40 : 65)) { if (c.mode !== 'hide') { c.mode = 'hide'; } c.t = rand(2.5, 4.5); return; }
  if (c.mode === 'hide') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(0.5, 1.5); } return; }
  if (c.mode === 'idle' && c.t <= 0) {
    c.mode = 'walk'; c.t = rand(0.6, 1.8); c.dir = Math.random() < 0.5 ? 0 : Math.PI; c.dir += rand(-0.3, 0.3);
  } else if (c.mode === 'walk') {
    const f = c.facing;
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 30, dt);
    c.facing = f; // 옆으로 걸으니 몸은 안 돌아간다
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(1, 3); }
  }
}

// 물범: 배 깔고 누워 있다가 가끔 데굴, 가끔 박수
function seal(c, state, dt) {
  if (c.mode === 'roll') { step(c, state, Math.cos(c.dir), Math.sin(c.dir), 18, dt); if (c.t <= 0) { c.mode = 'idle'; c.t = rand(3, 7); } return; }
  if (c.mode === 'clap') { if (c.t <= 0) { c.mode = 'idle'; c.t = rand(3, 8); } return; }
  if (c.mode === 'idle' && c.t <= 0) {
    const r = Math.random();
    if (r < 0.3) { c.mode = 'roll'; c.t = rand(1, 1.8); c.dir = Math.random() < 0.5 ? 0 : Math.PI; }
    else if (r < 0.55) { c.mode = 'clap'; c.t = rand(1.5, 2.5); }
    else { c.mode = 'walk'; c.t = rand(1, 3); c.dir = Math.random() * Math.PI * 2; }
  } else if (c.mode === 'walk') {
    step(c, state, Math.cos(c.dir), Math.sin(c.dir), 9, dt);
    if (c.t <= 0) { c.mode = 'idle'; c.t = rand(3, 8); }
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
  if (task.kind === 'fight') { // 좀비를 괴롭히는 애한테 덤벼서 콩콩
    if (!prey || prey.dying != null || prey.friend || !(prey.hp > 0) || prey.stunned > 0 || task.time <= 0) { c.task = null; return false; }
    const d = moveTo(prey.x, prey.y, sp);
    c.hitT = (c.hitT || 0) - dt;
    if (d < 16 && c.hitT <= 0) {
      prey.hp -= 0.6; c.hitT = 1;
      knockFoe(state, prey, c.x, c.y, 6);
      state.events.push({ type: 'hit', x: prey.x, y: prey.y, creature: prey.type, by: 'friend' });
    }
    return true;
  }
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
    if (c.stunned <= 0) {
      c.mode = 'idle'; c.t = 0.5; c.calm = 2;
      // 정신 차리면 살짝 기운 차려서 돌아간다
      c.hp = Math.max(1, Math.ceil(maxHpOf(c.type) * 0.5)); c.lastHit = 0;
      if (TYPES[c.type].fight) c.calm = 12;
    }
    return true;
  }
  return false;
}
