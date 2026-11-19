// 게임 전체 상태와 한 프레임 진행. 화면/입력과 무관 (나중에 3D나 서버로 옮길 수 있게).
import { generateWorld, isBlocked, forgetFar, MAP } from './world.js';
import { TYPES, TRAIT_NEED, streamCreatures, updateCreature, updateFriend, updateCaptive, dropPrey, createCreature } from './creatures.js';
import { dist, clamp } from '../core/rng.js';

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
// 버튼으로 고르는 쉬는 자세
export const REST_POSES = ['sit', 'prone', 'lie'];

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
    speed: saved?.speed ?? 38,
    power: saved?.power ?? 1,
    eaten: saved?.eaten ?? {},
    traits: saved?.traits ?? [],
    eatAnim: 0,
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
  // 혹시 저장된 자리가 막힌 곳이면 시작 지점으로
  if (isBlocked(world, zombie.x, zombie.y, 11)) { zombie.x = world.spawn.x; zombie.y = world.spawn.y; }
  markExplored(state);
  streamCreatures(state, true);
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

  for (const a of input.actions || []) {
    if (REST_POSES.includes(a)) z.restPose = z.restPose === a ? null : a;
    else if (a === 'crawl' || a === 'run') z.moveMode = z.moveMode === a ? 'walk' : a;
    else if (a === 'fetch') sendFetch(state);
    else if (a?.type === 'release') release(state, a.id);
  }

  // 이동 (움직이기 시작하면 쉬던 자세에서 일어난다)
  const len = Math.hypot(input.x, input.y);
  z.moving = len > 0.1 && z.eatAnim <= 0;
  if (z.moving) {
    z.restPose = null;
    const k = Math.min(1, len); // 조이스틱을 살짝 밀면 느리게
    const dx = (input.x / len) * k, dy = (input.y / len) * k;
    const sp = z.speed * MOVE_MULT[z.moveMode] * dt;
    const nx = z.x + dx * sp, ny = z.y + dy * sp;
    if (!isBlocked(state.world, nx, ny, 11)) { z.x = nx; z.y = ny; }
    else if (!isBlocked(state.world, nx, z.y, 11)) z.x = nx;
    else if (!isBlocked(state.world, z.x, ny, 11)) z.y = ny;
    if (Math.abs(dx) > 0.1) z.facing = Math.sign(dx);
    const cur = z.speed * MOVE_MULT[z.moveMode] * k;
    z.walkAnim += dt * (z.moveMode === 'crawl' ? 3 + cur / 6 : 3 + cur / 12);
    z.idleTime = 0;
  } else {
    z.idleTime += dt;
  }
  z.pose = z.moving ? z.moveMode : (z.restPose || 'stand');
  z.eatAnim = Math.max(0, z.eatAnim - dt);

  // 생명체 (친구는 좀비를 따라다닌다)
  const followSpeed = z.speed * MOVE_MULT[z.moveMode];
  let fi = 0;
  for (const c of state.creatures) {
    if (c.dying != null) c.dying += dt;
    else if (c.friend) updateFriend(c, state, dt, fi++, followSpeed);
    else if (!updateCaptive(c, state, dt)) updateCreature(c, state, dt);
  }
  state.creatures = state.creatures.filter((c) => c.dying == null || c.dying < 0.8);

  // 근처 먹을 수 있는 것
  let best = null, bestD = EAT_RANGE + z.power * 0.5;
  for (const c of state.creatures) {
    if (!TYPES[c.type].edible || c.dying != null || c.friend || c.carriedBy) continue;
    const d = dist(c.x, c.y, z.x, z.y);
    if (d < bestD) { best = c; bestD = d; }
  }
  state.nearEdible = best;
  if (input.eat && best) eat(state, best);
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
      if (!TYPES[c.type].edible || c.friend || c.dying != null || c.carriedBy || c.stunned > 0 || taken.has(c.id)) continue;
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
      ver: SAVE_VER, x: z.x, y: z.y, speed: z.speed, power: z.power,
      eaten: z.eaten, traits: z.traits, time: state.time,
      friends: friendsOf(state).map((c) => c.type),
      explored: packExplored(state.explored),
    }));
  } catch {}
}
