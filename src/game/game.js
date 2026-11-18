// 게임 전체 상태와 한 프레임 진행. 화면/입력과 무관 (나중에 3D나 서버로 옮길 수 있게).
import { generateWorld, isBlocked } from './world.js';
import { TYPES, TRAIT_NEED, populate, updateCreature } from './creatures.js';
import { dist, clamp } from '../core/rng.js';

export const DAY_LENGTH = 300; // 하루 = 5분
const SAVE_KEY = 'zombie-world-save-v1';
const EAT_RANGE = 30;

export function createGame() {
  const world = generateWorld(7);
  const saved = loadSave();
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
  };
  const state = {
    world, zombie,
    creatures: [],
    time: saved?.time ?? DAY_LENGTH * 0.3, // 아침부터
    events: [],
    nearEdible: null,
    respawnTimer: 0,
    saveTimer: 0,
  };
  populate(state, true);
  return state;
}

// input = { x, y } (-1~1 이동 방향), eat = 먹기 버튼 눌림
export function updateGame(state, dt, input) {
  state.time += dt;
  state.events.length = 0;
  const z = state.zombie;

  // 이동
  const len = Math.hypot(input.x, input.y);
  z.moving = len > 0.1 && z.eatAnim <= 0;
  if (z.moving) {
    const k = Math.min(1, len);
    const dx = (input.x / len) * k, dy = (input.y / len) * k;
    const sp = z.speed * dt;
    const nx = z.x + dx * sp, ny = z.y + dy * sp;
    if (!isBlocked(state.world, nx, ny, 11)) { z.x = nx; z.y = ny; }
    else if (!isBlocked(state.world, nx, z.y, 11)) z.x = nx;
    else if (!isBlocked(state.world, z.x, ny, 11)) z.y = ny;
    if (Math.abs(dx) > 0.1) z.facing = Math.sign(dx);
    z.walkAnim += dt * (4 + z.speed / 20);
    z.idleTime = 0;
  } else {
    z.idleTime += dt;
  }
  z.eatAnim = Math.max(0, z.eatAnim - dt);

  // 생명체
  for (const c of state.creatures) {
    if (c.dying != null) c.dying += dt;
    else updateCreature(c, state, dt);
  }
  state.creatures = state.creatures.filter((c) => c.dying == null || c.dying < 0.8);

  // 근처 먹을 수 있는 것
  let best = null, bestD = EAT_RANGE + z.power * 0.5;
  for (const c of state.creatures) {
    if (!TYPES[c.type].edible || c.dying != null) continue;
    const d = dist(c.x, c.y, z.x, z.y);
    if (d < bestD) { best = c; bestD = d; }
  }
  state.nearEdible = best;
  if (input.eat && best) eat(state, best);

  // 천천히 다시 채우기
  state.respawnTimer -= dt;
  if (state.respawnTimer <= 0) {
    populate(state);
    state.respawnTimer = 6;
  }

  state.saveTimer -= dt;
  if (state.saveTimer <= 0) { save(state); state.saveTimer = 5; }
}

function eat(state, c) {
  const z = state.zombie;
  const def = TYPES[c.type];
  c.dying = 0;
  z.eatAnim = 0.5;
  z.facing = c.x >= z.x ? 1 : -1;
  z.eaten[c.type] = (z.eaten[c.type] || 0) + 1;
  z.speed = clamp(z.speed + (def.gain?.speed || 0), 0, 140);
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

function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

function save(state) {
  const z = state.zombie;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      x: z.x, y: z.y, speed: z.speed, power: z.power,
      eaten: z.eaten, traits: z.traits, time: state.time,
    }));
  } catch {}
}
