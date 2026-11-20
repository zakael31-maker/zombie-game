// 집 안: 문 앞에서 들어가면 방 하나가 나온다. 방은 집마다 늘 같다 (집 위치로 정해짐).
// 방 좌표: 방 가운데가 (0,0), 바닥은 x -w/2~w/2, y -h/2~h/2. 문은 아래쪽 가운데.
// 좀비가 안에 있는 동안 바깥의 z.x·z.y는 문 앞에 그대로 둔다 → 친구들이 문 앞에서 기다린다.
import { mulberry32, hash2, clamp, dist } from '../core/rng.js';
import { chunksInRect } from './world.js';
import { createCreature } from './creatures.js';

// 문 위치 (집 그림 너비 pw 기준 비율). 모양(v)마다 문 자리가 다르다
const DOOR_DX = {
  cottage: [0, 0, 0.16], cabin: [0, 0, 0.15], igloo: [0, -0.17, -0.47], adobe: [0, -0.04, 0],
  tent: [0, 0, 0], stilt: [0, 0, 0.15], beachhut: [0, 0, 0.12],
};
export function doorOf(h) {
  const s = h.s || 1, dx = (DOOR_DX[h.style] || DOOR_DX.cottage)[h.v || 0] * (h.pw || h.w);
  return { x: h.x + dx * s, y: h.y + h.h / 2 };
}
// 집 모양 → 그 집 사람 옷차림(지역)
export const STYLE_BIOME = { cottage: 'meadow', cabin: 'snow', igloo: 'snow', adobe: 'desert', tent: 'desert', stilt: 'jungle', beachhut: 'beach' };

// 좀비 근처에 문이 있는 집
export function houseDoorNear(world, x, y) {
  let best = null, bd = 99;
  for (const ch of chunksInRect(world, x - 150, y - 120, x + 150, y + 40)) {
    for (const h of ch.houses) {
      const d = doorOf(h), s = h.s || 1;
      const dx = Math.abs(x - d.x), dy = y - d.y;
      if (dx < 24 * Math.max(1, s) && dy > -4 && dy < 30 && dx + dy < bd) { best = h; bd = dx + dy; }
    }
  }
  return best;
}

// 방 꾸미기: [종류, x비율, y비율]. y가 'wall'이면 뒷벽에 거는 물건
const LAYOUT = {
  cottage: [['fireplace', -0.3, 'back'], ['window', -0.08, 'wall'], ['picture', 0.34, 'wall'], ['bed', 0.32, -0.12], ['rug', -0.05, 0.12],
    ['table', -0.12, 0.08], ['chair', -0.3, 0.12], ['chair', 0.06, 0.12], ['plant', -0.45, 0.42], ['chest', 0.4, 0.38], ['shelf', 0.12, 'back']],
  cabin: [['fireplace', 0.28, 'back'], ['window', -0.08, 'wall'], ['skis', -0.38, 'wall'], ['bed', -0.32, -0.12], ['fur', 0.05, 0.1],
    ['table', 0.18, 0.12], ['chair', 0.36, 0.14], ['logs', 0.44, -0.1], ['lantern', -0.44, 0.4], ['chest', -0.1, 'back']],
  igloo: [['stove', 0, 'back'], ['furbed', -0.3, -0.05], ['fur', 0.08, 0.12], ['lantern', 0.3, -0.18], ['fishing', 0.38, 0.25], ['pot', -0.38, 0.35], ['cushion', 0.18, 0.05]],
  adobe: [['window', -0.25, 'wall'], ['tapestry', 0.2, 'wall'], ['matbed', 0.3, -0.12], ['rug', -0.08, 0.1], ['lowtable', -0.08, 0.08],
    ['cushion', -0.3, 0.1], ['cushion', 0.12, 0.12], ['pot', -0.44, -0.2], ['pot', -0.38, -0.25], ['plant', 0.44, 0.4]],
  tent: [['tapestry', 0, 'wall'], ['rug', 0, 0.05], ['lowtable', 0, 0.02], ['cushion', -0.22, 0.05], ['cushion', 0.22, 0.05],
    ['matbed', -0.3, -0.25], ['lantern', 0.36, -0.2], ['chest', 0.38, 0.3], ['pot', -0.42, 0.35]],
  stilt: [['window', 0, 'wall'], ['hammock', 0.22, -0.18], ['mat', -0.2, 0.1], ['basket', -0.38, -0.2], ['plant', 0.44, 0.38],
    ['plant', -0.44, 0.38], ['lowtable', -0.2, 0.06], ['pot', 0.4, -0.25]],
  beachhut: [['window', -0.22, 'wall'], ['shells', 0.2, 'wall'], ['bed', 0.3, -0.12], ['surfboard', -0.44, -0.2], ['table', -0.15, 0.1],
    ['fishbowl', -0.15, 0.02], ['chair', -0.32, 0.14], ['rug', 0.05, 0.2], ['plant', 0.44, 0.4]],
};
// 바닥 크기 [w, h], 부딪히면 막히는지
const ITEM = {
  fireplace: [48, 20, true], stove: [30, 18, true], shelf: [40, 14, true], chest: [30, 16, true], bed: [56, 46, true],
  furbed: [56, 38, false], matbed: [56, 36, false], table: [42, 22, true], lowtable: [34, 18, true], chair: [16, 12, true],
  rug: [100, 54, false], fur: [70, 40, false], mat: [70, 40, false], plant: [16, 10, true], pot: [14, 9, true],
  lantern: [12, 8, true], logs: [26, 14, true], fishing: [24, 10, false], cushion: [22, 14, false], hammock: [76, 14, true],
  basket: [22, 12, true], surfboard: [14, 10, true], fishbowl: [0, 0, false],
};
const BEDS = ['bed', 'furbed', 'matbed', 'hammock'];

export function makeRoom(h) {
  const style = h.style || 'cottage';
  const r = mulberry32(hash2(77, Math.round(h.x), Math.round(h.y), 3));
  const s = h.s || 1;
  const w = Math.round(clamp((h.pw || h.w) * s * 2.3, 230, 340));
  const rh = Math.round(clamp(w * 0.55, 140, 180));
  const flip = r() < 0.5 ? -1 : 1; // 좌우 뒤집어서 같은 지역 집도 배치가 조금씩 다르다
  const items = [];
  for (const [kind, fx, fy] of LAYOUT[style] || LAYOUT.cottage) {
    const x = fx * w * flip;
    if (fy === 'wall') { items.push({ kind, x, y: -rh / 2, wall: true }); continue; }
    const [iw, ih, solid] = ITEM[kind] || [20, 12, true];
    const y = fy === 'back' ? -rh / 2 + ih + 2 : fy * rh;
    items.push({ kind, x, y, w: iw, h: ih, solid });
  }
  const bed = items.find((it) => BEDS.includes(it.kind));
  const room = { style, v: h.v || 0, roof: h.roof, w, h: rh, items, bed, flip, cat: r() < 0.45, people: [] };
  // 사는 사람 (가끔 아이도)
  const n = r() < 0.75 ? 1 + (r() < 0.35 ? 1 : 0) : 0;
  for (let i = 0; i < n; i++) {
    const p = createCreature('villager', (r() - 0.5) * w * 0.4, rh * (0.05 + r() * 0.2), { look: STYLE_BIOME[style], kid: i > 0 || r() < 0.2, mode: 'idle' });
    p.t = 1 + r() * 2;
    room.people.push(p);
  }
  if (room.cat) { const rug = items.find((it) => ['rug', 'fur', 'mat'].includes(it.kind)); room.catAt = rug ? { x: rug.x + 22, y: rug.y } : { x: 0, y: rh * 0.2 }; }
  return room;
}

export function blockedInRoom(room, x, y, r) {
  if (x < -room.w / 2 + r || x > room.w / 2 - r || y < -room.h / 2 + r * 0.6 || y > room.h / 2 - 2) return true;
  for (const it of room.items) {
    if (!it.solid || it.wall) continue;
    if (x > it.x - it.w / 2 - r && x < it.x + it.w / 2 + r && y > it.y - it.h - r * 0.4 && y < it.y + r * 0.4) return true;
  }
  return false;
}

// 문 앞에서 들어가기
export function enterHouse(state, h) {
  const z = state.zombie, d = doorOf(h);
  z.x = d.x; z.y = d.y + 14; // 바깥 자리는 문 앞
  const room = h._room || (h._room = makeRoom(h));
  state.inside = { house: h, room, x: 0, y: room.h / 2 - 12, t: 0 };
  z.restPose = null; z.vx = 0; z.vy = 0; z.facing = 1;
  state.events.push({ type: 'enter', x: z.x, y: z.y, style: h.style });
}
export function leaveHouse(state) {
  const z = state.zombie, d = doorOf(state.inside.house);
  z.x = d.x; z.y = d.y + 18; z.restPose = null;
  state.inside = null;
  state.events.push({ type: 'leave', x: z.x, y: z.y });
}

// 방 안에서 움직이기 (좀비 + 사는 사람). 문으로 걸어 나가면 true
export function moveInside(state, dt, vx, vy) {
  const ins = state.inside, room = ins.room, z = state.zombie;
  ins.t += dt;
  if (Math.abs(vx) + Math.abs(vy) > 0.5) {
    const nx = ins.x + vx * dt, ny = ins.y + vy * dt;
    if (!blockedInRoom(room, nx, ny, 10)) { ins.x = nx; ins.y = ny; }
    else if (!blockedInRoom(room, nx, ins.y, 10)) ins.x = nx;
    else if (!blockedInRoom(room, ins.x, ny, 10)) ins.y = ny;
  }
  // 침대에 누우면 침대 위로 쏙
  ins.onBed = z.restPose === 'lie' && room.bed && dist(ins.x, ins.y, room.bed.x, room.bed.y - room.bed.h / 2) < 46;
  // 사람들: 천천히 돌아다니다 쉬다가, 좀비가 오면 손 흔들기
  for (const p of room.people) {
    p.anim += dt;
    p.t -= dt;
    const near = dist(p.x, p.y, ins.x, ins.y) < 44;
    p.wave = near ? Math.min(1, (p.wave || 0) + dt * 3) : Math.max(0, (p.wave || 0) - dt * 2);
    if (near) { p.mode = 'idle'; p.facing = ins.x > p.x ? 1 : -1; continue; }
    if (p.t <= 0) {
      if (p.mode === 'walk') { p.mode = 'idle'; p.t = 2 + Math.random() * 4; }
      else { p.mode = 'walk'; p.t = 1.5 + Math.random() * 2; const a = Math.random() * Math.PI * 2; p.vx = Math.cos(a) * 16; p.vy = Math.sin(a) * 10; }
    }
    if (p.mode === 'walk') {
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (!blockedInRoom(room, nx, ny, 9) && ny < room.h / 2 - 16) { p.x = nx; p.y = ny; p.facing = p.vx > 0 ? 1 : -1; }
      else p.t = 0;
    }
  }
  // 문으로 나가기: 아래 가운데에서 아래로 걸으면
  return ins.t > 0.6 && vy > 5 && Math.abs(ins.x) < 22 && ins.y > room.h / 2 - 6;
}
