// 게임 전체 상태와 한 프레임 진행. 화면/입력과 무관 (나중에 3D나 서버로 옮길 수 있게).
import { generateWorld, isBlocked, isIce, forgetFar, MAP } from './world.js';
import { TYPES, TRAIT_NEED, streamCreatures, updateCreature, updateFriend, updateCaptive, dropPrey, createCreature, knockFoe } from './creatures.js';
import { dist, clamp, rand } from '../core/rng.js';

export const DAY_LENGTH = 300; // 하루 = 5분
const SAVE_KEY = 'zombie-world-save-v1';
const EAT_RANGE = 30;
const SAVE_VER = 2;      // 2: 맵이 커지면서 예전 동네가 가운데로 옮겨짐
const OLD_MAP_SHIFT = 2600;

// 가 본 곳 기록 (지도의 안개 걷기용): EXPLORE칸마다 한 칸
export const EXPLORE = 200;
export const EXPLORE_W = Math.ceil(MAP.w / EXPLORE), EXPLORE_H = Math.ceil(MAP.h / EXPLORE);
const SEE = 420; // 좀비 주변 이만큼은 '가 봤다'로 친다

// 이동 방식별 속도 배율 (기본 속도 z.speed는 먹을수록 늘어난다)
export const MOVE_MULT = { crawl: 0.45, walk: 1, run: 1.7 };
// 처음에 고르는 좀비 캐릭터. speed/power = 시작 능력치 (살금이의 '덜 들킴'은 creatures.js CHAR_SNEAK)
export const CHARACTERS = {
  sprout: { name: '새싹이', emoji: '🌱', speed: 46, power: 1, hp: 12, desc: '머리에 새싹이 쏙! 뭐든지 골고루 잘해요' },
  zip:    { name: '쌩쌩이', emoji: '⚡', speed: 66, power: 1, hp: 9, desc: '번개처럼 제일 빨라요. 대신 체력은 적어요' },
  mungchi:{ name: '뭉치',   emoji: '💪', speed: 44, power: 5, hp: 16, desc: '크고 힘세고 튼튼해요. 친구도 더 많이 데려가요' },
  meow:   { name: '살금이', emoji: '🐾', speed: 54, power: 1, hp: 10, desc: '고양이처럼 살금살금, 동물들이 덜 놀라요' },
};
const OLD_BASE = { speed: 38, power: 1 }; // 캐릭터가 생기기 전 좀비의 시작 능력치

// 캐릭터 고르기/바꾸기: 그동안 먹어서 늘어난 만큼은 그대로 둔다
export function chooseCharacter(state, id) {
  const z = state.zombie, next = CHARACTERS[id];
  if (!next) return;
  const prev = CHARACTERS[z.char] || OLD_BASE;
  const hpK = z.hp / maxHp(z); // 바꿔도 체력은 같은 비율로
  z.speed = clamp(z.speed + next.speed - prev.speed, 20, 140);
  z.power = Math.max(1, z.power + next.power - prev.power);
  z.char = id;
  z.hp = Math.min(maxHp(z), Math.max(1, hpK * maxHp(z)));
  save(state);
}
export const needsCharacter = (state) => !CHARACTERS[state.zombie.char];

// 버튼으로 고르는 쉬는 자세
export const REST_POSES = ['sit', 'prone', 'lie'];
// 말 타기: 좀비 속도에 이만큼 더하고, 뛰기를 켜면 다그닥 달린다
const RIDE_BONUS = 55, RIDE_RUN = 1.6, RIDE_RANGE = 46;
export const ridden = (state) => state.creatures.find((c) => c.ridden);
// 체력: 힘이 셀수록 많다. 맞으면 줄고, 쉬면 찬다. 0이 되면 잠깐 기절했다가 다시 꽉 차서 일어난다
// 캐릭터마다 기본 체력이 다르고(CHARACTERS.hp), 힘이 세질수록 조금씩 늘어난다
export const maxHp = (z) => (CHARACTERS[z.char]?.hp ?? 10) + Math.floor(z.power / 3);
const FAINT_TIME = 4;
const HIT_GAP = 0.35; // 콩! 때리기 사이 간격

export function createGame() {
  const world = generateWorld(7);
  const saved = loadSave();
  if (saved && (saved.ver || 1) < 2 && saved.x != null) { saved.x += OLD_MAP_SHIFT; saved.y += OLD_MAP_SHIFT; }
  const zombie = {
    x: saved?.x ?? world.spawn.x,
    y: saved?.y ?? world.spawn.y,
    facing: 1,
    moving: false,
    idleTime: 0,
    walkAnim: 0,
    char: saved?.char ?? null, // 아직 안 골랐으면 null → 고르는 화면
    speed: saved?.speed ?? OLD_BASE.speed,
    power: saved?.power ?? 1,
    eaten: saved?.eaten ?? {},
    traits: saved?.traits ?? [],
    eatAnim: 0,
    hp: saved?.hp ?? 99, // 아래에서 최대 체력으로 맞춘다
    hurt: 0, fainted: 0, lastHit: 99, hitCd: 0,
    moveMode: 'walk', // walk | crawl | run (버튼으로 전환)
    restPose: null,   // null | sit | prone | lie (버튼으로 선택)
    pose: 'stand',
  };
  const state = {
    world, zombie,
    creatures: [],
    time: saved?.time ?? DAY_LENGTH * 0.3, // 아침부터
    events: [],
    nearEdible: null,
    streamTimer: 0,
    saveTimer: 0,
    forgetTimer: 0,
    explored: loadExplored(saved?.explored),
  };
  zombie.hp = Math.min(zombie.hp, maxHp(zombie));
  // 혹시 저장된 자리가 막힌 곳이면 시작 지점으로
  if (isBlocked(world, zombie.x, zombie.y, 11)) { zombie.x = world.spawn.x; zombie.y = world.spawn.y; }
  markExplored(state);
  streamCreatures(state, true);
  // 타고 있던 말도 다시 데려오기
  if (saved?.riding != null) state.creatures.push(createCreature('horse', zombie.x, zombie.y, { ridden: true, coat: saved.riding, mode: 'idle' }));
  // 저장된 좀비 친구들 다시 불러오기
  for (const type of saved?.friends || []) {
    if (!TYPES[type]) continue;
    state.creatures.push(createCreature(type, zombie.x + (Math.random() - 0.5) * 40, zombie.y + (Math.random() - 0.5) * 30, { friend: true }));
  }
  return state;
}

// 데리고 다닐 수 있는 친구 수: 힘이 셀수록 많아진다
export function maxFriends(z) { return 2 + Math.floor(z.power / 4); }
export function friendsOf(state) { return state.creatures.filter((c) => c.friend); }

// input = { x, y } (-1~1 이동 방향), eat = 먹기 버튼, actions = 누른 동작 버튼들
// actions: 'sit' | 'prone' | 'lie' (같은 버튼 다시 누르면 일어남), 'crawl' | 'run' (켜고 끄기)
export function updateGame(state, dt, input) {
  state.time += dt;
  state.events.length = 0;
  const z = state.zombie;

  z.riding = !!ridden(state);
  // 기절: 잠깐 누워서 쉬었다가 체력이 꽉 차서 일어난다 (그동안은 못 움직임)
  if (z.fainted > 0) {
    z.fainted -= dt;
    input = { x: 0, y: 0, actions: [] };
    if (z.fainted <= 0) { z.hp = maxHp(z); state.events.push({ type: 'wake', x: z.x, y: z.y }); }
  }
  z.hurt = Math.max(0, z.hurt - dt);
  z.hitCd = Math.max(0, z.hitCd - dt);
  z.lastHit += dt;
  for (const a of input.actions || []) {
    if (a === 'ride') toggleRide(state);
    else if (a === 'crawl' && z.riding) continue; // 말 위에선 기어가기 없음
    else if (REST_POSES.includes(a)) { if (ridden(state)) toggleRide(state); z.restPose = z.restPose === a ? null : a; }
    else if (a === 'crawl' || a === 'run') z.moveMode = z.moveMode === a ? 'walk' : a;
    else if (a === 'fetch') sendFetch(state);
    else if (a?.type === 'release') release(state, a.id);
  }

  // 이동 (움직이기 시작하면 쉬던 자세에서 일어난다)
  const len = Math.hypot(input.x, input.y);
  z.moving = len > 0.1 && z.eatAnim <= 0;
  // 원하는 속도 → 얼음 위에선 천천히 따라가서 미끄러진다
  let wx = 0, wy = 0;
  if (z.moving) {
    const k = Math.min(1, len); // 조이스틱을 살짝 밀면 느리게
    const sp = moveSpeed(state);
    wx = (input.x / len) * k * sp; wy = (input.y / len) * k * sp;
  }
  z.onIce = isIce(state.world, z.x, z.y);
  if (z.onIce) { const a = Math.min(1, dt * 1.4); z.vx = (z.vx || 0) + (wx - (z.vx || 0)) * a; z.vy = (z.vy || 0) + (wy - (z.vy || 0)) * a; }
  else { z.vx = wx; z.vy = wy; }
  if (Math.abs(z.vx) + Math.abs(z.vy) > 0.5) {
    const nx = z.x + z.vx * dt, ny = z.y + z.vy * dt;
    if (!isBlocked(state.world, nx, ny, 11)) { z.x = nx; z.y = ny; }
    else if (!isBlocked(state.world, nx, z.y, 11)) { z.x = nx; z.vy = 0; }
    else if (!isBlocked(state.world, z.x, ny, 11)) { z.y = ny; z.vx = 0; }
    else { z.vx = 0; z.vy = 0; }
  }
  z.sliding = z.onIce && !z.moving && Math.hypot(z.vx, z.vy) > 6;
  if (z.moving) {
    z.restPose = null;
    const k = Math.min(1, len);
    const dx = (input.x / len) * k;
    if (Math.abs(dx) > 0.1) z.facing = Math.sign(dx);
    const cur = moveSpeed(state) * k;
    z.walkAnim += dt * (z.riding ? 4 + cur / 16 : z.moveMode === 'crawl' ? 3 + cur / 6 : 3 + cur / 12);
    z.idleTime = 0;
  } else {
    z.idleTime += dt;
  }
  if (z.riding) z.restPose = null;
  z.pose = z.fainted > 0 ? 'lie' : z.riding ? 'ride' : z.moving ? z.moveMode : (z.restPose || 'stand');
  // 체력 회복: 한동안 안 맞으면 천천히, 앉거나 누우면 더 빨리
  if (z.fainted <= 0 && z.lastHit > 4 && z.hp < maxHp(z)) {
    const k = z.pose === 'lie' ? 5 : z.pose === 'sit' || z.pose === 'prone' ? 3 : 1;
    z.hp = Math.min(maxHp(z), z.hp + 0.4 * k * dt);
  }
  z.eatAnim = Math.max(0, z.eatAnim - dt);

  // 생명체 (친구는 좀비를 따라다닌다)
  const followSpeed = moveSpeed(state);
  let fi = 0;
  for (const c of state.creatures) {
    if (c.ridden) { c.x = z.x; c.y = z.y; c.facing = z.facing; c.anim += dt; c.mode = z.moving ? (z.moveMode === 'run' ? 'gallop' : 'walk') : 'idle'; continue; }
    if (c.dying != null) c.dying += dt;
    else if (c.friend) updateFriend(c, state, dt, fi++, followSpeed);
    else if (!updateCaptive(c, state, dt)) updateCreature(c, state, dt);
  }
  state.creatures = state.creatures.filter((c) => c.dying == null || c.dying < 0.8);
  // 공격받기 (싸우는 생명체가 보낸 공격)
  for (const e of [...state.events]) if (e.type === 'attack') hurtZombie(state, e);
  // 친구들이 좀비를 공격하는 애한테 덤벼든다
  for (const f of friendsOf(state)) {
    if (f.task) continue;
    const foe = state.creatures.find((c) => c.angry && !c.friend && (c.hp ?? 1) > 0 && !c.stunned && dist(c.x, c.y, z.x, z.y) < 160);
    if (foe) f.task = { kind: 'fight', target: foe.id, time: 15 };
  }

  // 근처 먹을 수 있는 것
  let best = null, bestD = EAT_RANGE + z.power * 0.5;
  for (const c of state.creatures) {
    if (!TYPES[c.type].edible || c.dying != null || c.friend || c.carriedBy) continue;
    const d = dist(c.x, c.y, z.x, z.y) - (TYPES[c.type].fight ? 8 : 0); // 싸우는 애는 조금 멀어도 닿는다
    if (d < bestD) { best = c; bestD = d; }
  }
  state.nearEdible = best;
  // 싸우는 애가 아직 기운이 있으면 냠/물기 대신 콩! 때리기
  state.nearFoe = best && TYPES[best.type].fight && best.hp > 0 && !(best.stunned > 0) ? best : null;
  // 근처 탈 수 있는 말
  let horse = null, hd = RIDE_RANGE;
  if (!z.riding) for (const c of state.creatures) {
    if (!TYPES[c.type].ride || c.friend) continue;
    const d = dist(c.x, c.y, z.x, z.y);
    if (d < hd) { horse = c; hd = d; }
  }
  state.nearRide = horse;
  if (state.nearFoe) { if ((input.eat || input.bite) && z.hitCd <= 0) hitFoe(state, best); }
  else if (input.eat && best) eat(state, best);
  else if (input.bite && best) bite(state, best);

  // 주변 생명체 불러오기/치우기, 가 본 곳 기록, 먼 조각 지우기
  state.world.clock = state.time;
  state.streamTimer -= dt;
  if (state.streamTimer <= 0) {
    streamCreatures(state);
    markExplored(state);
    state.streamTimer = 0.5;
  }
  state.forgetTimer -= dt;
  if (state.forgetTimer <= 0) { forgetFar(state.world, z.x, z.y); state.forgetTimer = 5; }

  state.saveTimer -= dt;
  if (state.saveTimer <= 0) { save(state); state.saveTimer = 5; }
}

// 화난 상태를 싹 지우기 (친구가 되거나 놓아줄 때)
function calmDown(c) { c.angry = false; c.ouch = 0; c.swing = 0; c.cd = 0; c.calm = 10; }

// 좀비가 맞았을 때: 체력이 줄고 살짝 밀려난다. 0이면 기절, 싸우던 애들은 흥미를 잃고 간다
function hurtZombie(state, e) {
  const z = state.zombie;
  if (z.fainted > 0) return;
  z.hp = Math.max(0, z.hp - e.dmg);
  z.hurt = 0.4; z.lastHit = 0;
  const d = Math.hypot(z.x - e.x, z.y - e.y) || 1;
  const nx = z.x + (z.x - e.x) / d * 14, ny = z.y + (z.y - e.y) / d * 14;
  if (!isBlocked(state.world, nx, ny, 11)) { z.x = nx; z.y = ny; }
  state.events.push({ type: 'hurt', x: z.x, y: z.y, dmg: e.dmg, creature: e.creature });
  if (z.hp <= 0) {
    if (ridden(state)) toggleRide(state);
    z.fainted = FAINT_TIME; z.restPose = null;
    for (const c of state.creatures) if (c.angry) { c.angry = false; c.calm = 15; c.mode = 'idle'; c.t = 1; }
    state.events.push({ type: 'faint', x: z.x, y: z.y });
  }
}

// 콩! 때리기: 힘이 셀수록 세게. 기운이 다 빠지면 어질어질 → 그때 냠/물기
function hitFoe(state, c) {
  const z = state.zombie;
  z.hitCd = HIT_GAP; z.eatAnim = 0.25;
  z.facing = c.x >= z.x ? 1 : -1;
  c.hp -= 1 + z.power * 0.15;
  knockFoe(state, c, z.x, z.y, 16);
  state.events.push({ type: 'hit', x: c.x, y: c.y, creature: c.type, by: 'zombie' });
}
// 지금 움직이는 빠르기 (말을 타면 훨씬 빠르다)
function moveSpeed(state) {
  const z = state.zombie;
  if (z.riding) return (z.speed + RIDE_BONUS) * (z.moveMode === 'run' ? RIDE_RUN : 1);
  return z.speed * MOVE_MULT[z.moveMode];
}

// 말에 올라타기 / 내리기
function toggleRide(state) {
  const z = state.zombie, h = ridden(state);
  if (h) {
    // 내리면 좀비는 말 옆으로 폴짝
    h.ridden = false; h.mode = 'idle'; h.t = rand(3, 6); h.calm = 10;
    for (const dx of [-26, 26, 0]) if (!isBlocked(state.world, z.x + dx * z.facing, z.y + 8, 11)) { z.x += dx * z.facing; z.y += 8; break; }
    z.riding = false;
    if (z.moveMode === 'crawl') z.moveMode = 'walk';
    state.events.push({ type: 'dismount', x: z.x, y: z.y });
  } else {
    const c = state.nearRide;
    if (!c) return;
    c.ridden = true; c.task = null;
    z.x = c.x; z.y = c.y; z.facing = c.facing; z.restPose = null; z.riding = true;
    if (z.moveMode === 'crawl') z.moveMode = 'walk';
    state.events.push({ type: 'mount', x: z.x, y: z.y });
  }
  save(state);
}

// 잡아와!: 쉬고 있는 친구마다 가까운 먹이 하나씩 잡으러 간다
const FETCH_RANGE = 320;
function sendFetch(state) {
  const z = state.zombie;
  const taken = new Set(state.creatures.filter((c) => c.task).map((c) => c.task.target));
  let sent = 0;
  for (const f of friendsOf(state)) {
    if (f.task) continue;
    let best = null, bestD = FETCH_RANGE;
    for (const c of state.creatures) {
      if (!TYPES[c.type].edible || TYPES[c.type].fight || c.friend || c.dying != null || c.carriedBy || c.stunned > 0 || taken.has(c.id)) continue;
      const d = dist(c.x, c.y, z.x, z.y);
      if (d < bestD) { best = c; bestD = d; }
    }
    if (!best) break;
    taken.add(best.id);
    f.task = { kind: 'hunt', target: best.id, time: 12 };
    sent++;
  }
  state.events.push({ type: 'fetch', count: sent, x: z.x, y: z.y });
}

// 놓아주기: 다시 원래 생명체로 돌아간다
function release(state, id) {
  const c = state.creatures.find((p) => p.id === id && p.friend);
  if (!c) return;
  if (c.task?.kind === 'return') {
    const prey = state.creatures.find((p) => p.id === c.task.target);
    if (prey && prey.carriedBy === c.id) dropPrey(prey, c);
  }
  c.friend = false;
  c.task = null;
  calmDown(c);
  const F = TYPES[c.type].fight;
  if (F) c.hp = F.hp; // 놓아주면 다시 기운 찬 모습으로
  c.mode = 'idle'; c.t = 1.5; c.calm = 6;
  state.events.push({ type: 'release', x: c.x, y: c.y, creature: c.type });
  save(state);
}

// 물기: 먹지 않고 좀비 친구로 만든다 (능력치는 오르지 않음)
function bite(state, c) {
  const z = state.zombie;
  if (friendsOf(state).length >= maxFriends(z)) {
    state.events.push({ type: 'full', x: z.x, y: z.y });
    return;
  }
  z.eatAnim = 0.4;
  z.facing = c.x >= z.x ? 1 : -1;
  c.friend = true;
  c.stunned = 0;
  calmDown(c);
  c.mode = 'idle';
  c.t = 0;
  state.events.push({ type: 'bite', x: c.x, y: c.y, creature: c.type });
  save(state);
}

function eat(state, c) {
  const z = state.zombie;
  const def = TYPES[c.type];
  c.dying = 0;
  z.eatAnim = 0.5;
  z.facing = c.x >= z.x ? 1 : -1;
  z.eaten[c.type] = (z.eaten[c.type] || 0) + 1;
  // 무엇을 먹든 조금씩 빨라지고, 날쌘 생명체는 더 많이 올려준다
  z.speed = clamp(z.speed + 1 + (def.gain?.speed || 0), 0, 140);
  z.power += def.gain?.power || 0;
  state.events.push({ type: 'eat', x: c.x, y: c.y, creature: c.type });

  // 외형 변화: 같은 계열을 일정 수 먹으면 특징이 생긴다
  const need = TRAIT_NEED;
  const t = def.trait;
  if (t && !z.traits.includes(t)) {
    const total = Object.entries(z.eaten)
      .filter(([k]) => TYPES[k].trait === t)
      .reduce((s, [, n]) => s + n, 0);
    if (total >= need[t]) {
      z.traits.push(t);
      state.events.push({ type: 'trait', trait: t, x: z.x, y: z.y });
    }
  }
  save(state);
}

// 0 = 한낮, 1 = 한밤
export function nightAmount(time) {
  const p = (time % DAY_LENGTH) / DAY_LENGTH; // 0 자정 → 0.5 정오
  return clamp(Math.cos(p * Math.PI * 2) * 1.4 - 0.15, 0, 1) ** 0.8;
}

export function totalEaten(z) {
  return Object.values(z.eaten).reduce((a, b) => a + b, 0);
}

function markExplored(state) {
  const z = state.zombie, e = state.explored;
  const x0 = Math.max(0, Math.floor((z.x - SEE) / EXPLORE)), x1 = Math.min(EXPLORE_W - 1, Math.floor((z.x + SEE) / EXPLORE));
  const y0 = Math.max(0, Math.floor((z.y - SEE) / EXPLORE)), y1 = Math.min(EXPLORE_H - 1, Math.floor((z.y + SEE) / EXPLORE));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cx = (x + 0.5) * EXPLORE, cy = (y + 0.5) * EXPLORE;
    if (Math.hypot(cx - z.x, cy - z.y) < SEE) e[y * EXPLORE_W + x] = 1;
  }
}
// 가 본 곳: 칸마다 0/1 → 글자로 압축 저장 (6칸 = 한 글자)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function packExplored(e) {
  let s = '';
  for (let i = 0; i < e.length; i += 6) { let v = 0; for (let k = 0; k < 6; k++) if (e[i + k]) v |= 1 << k; s += B64[v]; }
  return s;
}
function loadExplored(s) {
  const e = new Uint8Array(EXPLORE_W * EXPLORE_H);
  if (typeof s === 'string' && s.length === Math.ceil(e.length / 6)) {
    for (let i = 0; i < s.length; i++) { const v = B64.indexOf(s[i]); for (let k = 0; k < 6; k++) if (v & (1 << k)) e[i * 6 + k] = 1; }
  }
  return e;
}

function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

function save(state) {
  const z = state.zombie;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      ver: SAVE_VER, x: z.x, y: z.y, char: z.char, hp: Math.round(z.hp * 10) / 10, speed: z.speed, power: z.power,
      eaten: z.eaten, traits: z.traits, time: state.time,
      friends: friendsOf(state).map((c) => c.type),
      riding: ridden(state)?.coat ?? null,
      explored: packExplored(state.explored),
    }));
  } catch {}
}
