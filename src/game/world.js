// 맵(지형과 고정 물체) 생성과 충돌 판정. 화면과 무관하다.
// 좌표: x = 동서, y = 남북 (3D로 옮기면 y → z).
import { mulberry32, dist } from '../core/rng.js';

export const MAP = { w: 2400, h: 2400 };

export function generateWorld(seed = 7) {
  const r = mulberry32(seed);
  const world = {
    seed,
    spawn: { x: 1150, y: 1250 },
    ponds: [
      { x: 820, y: 1450, rx: 230, ry: 150 },
      { x: 1820, y: 1850, rx: 130, ry: 95 },
    ],
    village: { x: 1700, y: 760, r: 330 },
    forest: { x: 480, y: 520, r: 430 },
    houses: [],
    trees: [],
    rocks: [],
    flowers: [],
    mushrooms: [],
    paths: [],
  };

  // 마을 집
  const roofColors = ['#f08a7e', '#7eb6f0', '#f5b85a', '#b48ef0', '#7ed0a6'];
  const houseSpots = [
    [-170, -120], [40, -170], [210, -60], [-200, 90], [170, 140], [-20, 190],
  ];
  houseSpots.forEach(([dx, dy], i) => {
    world.houses.push({
      x: world.village.x + dx, y: world.village.y + dy,
      w: 110, h: 70, roof: roofColors[i % roofColors.length],
    });
  });

  // 길: 시작 지점 → 마을, 시작 지점 → 큰 연못, 마을 → 작은 연못
  world.paths.push(
    [[world.spawn.x, world.spawn.y], [1400, 1050], [world.village.x, world.village.y]],
    [[world.spawn.x, world.spawn.y], [1000, 1380], [world.ponds[0].x + 200, world.ponds[0].y - 60]],
    [[world.village.x, world.village.y], [1900, 1300], [world.ponds[1].x, world.ponds[1].y - 110]],
  );

  // 나무: 숲에는 빽빽하게(침엽수), 나머지는 드문드문(활엽수)
  const tryPlaceTree = (x, y, kind) => {
    if (!canPlaceDecor(world, x, y, 60)) return;
    if (world.trees.some((t) => dist(t.x, t.y, x, y) < 55)) return;
    world.trees.push({ x, y, kind, size: 0.85 + r() * 0.4, phase: r() * 6.28 });
  };
  for (let i = 0; i < 260; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * world.forest.r;
    tryPlaceTree(world.forest.x + Math.cos(a) * d, world.forest.y + Math.sin(a) * d, 'pine');
  }
  for (let i = 0; i < 140; i++) {
    tryPlaceTree(80 + r() * (MAP.w - 160), 80 + r() * (MAP.h - 160), r() < 0.2 ? 'pine' : 'round');
  }
  // 맵 가장자리 울타리 나무
  for (let x = 30; x < MAP.w; x += 70) {
    tryPlaceTree(x + r() * 20, 30 + r() * 20, 'round');
    tryPlaceTree(x + r() * 20, MAP.h - 30 - r() * 20, 'round');
  }
  for (let y = 100; y < MAP.h - 60; y += 70) {
    tryPlaceTree(30 + r() * 20, y + r() * 20, 'round');
    tryPlaceTree(MAP.w - 30 - r() * 20, y + r() * 20, 'round');
  }

  // 바닥 장식 (지나갈 수 있음)
  const flowerColors = ['#ff9ecb', '#fff27a', '#ffffff', '#b9a6ff', '#ffb27a'];
  for (let i = 0; i < 900; i++) {
    const x = r() * MAP.w, y = r() * MAP.h;
    if (isWater(world, x, y, 20)) continue;
    world.flowers.push({ x, y, color: flowerColors[Math.floor(r() * flowerColors.length)], s: 0.7 + r() * 0.6 });
  }
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * world.forest.r * 1.1;
    world.mushrooms.push({ x: world.forest.x + Math.cos(a) * d, y: world.forest.y + Math.sin(a) * d });
  }
  for (let i = 0; i < 60; i++) {
    const x = r() * MAP.w, y = r() * MAP.h;
    if (!isWater(world, x, y, 10)) world.rocks.push({ x, y, s: 0.6 + r() * 0.8 });
  }

  // 충돌 검사를 빠르게 하기 위한 격자
  world.treeGrid = buildGrid(world.trees, 120);
  return world;
}

function canPlaceDecor(world, x, y, margin) {
  if (x < 20 || y < 20 || x > MAP.w - 20 || y > MAP.h - 20) return false;
  if (isWater(world, x, y, margin)) return false;
  if (dist(x, y, world.village.x, world.village.y) < world.village.r - 40) return false;
  if (dist(x, y, world.spawn.x, world.spawn.y) < 150) return false;
  for (const p of world.paths) {
    for (let i = 0; i < p.length - 1; i++) {
      if (distToSegment(x, y, p[i], p[i + 1]) < 45) return false;
    }
  }
  return true;
}

export function isWater(world, x, y, pad = 0) {
  for (const p of world.ponds) {
    const dx = (x - p.x) / (p.rx + pad), dy = (y - p.y) / (p.ry + pad);
    if (dx * dx + dy * dy < 1) return true;
  }
  return false;
}

// 반지름 r인 몸이 (x, y)에 설 수 있는가 (물은 따로 판단)
export function isBlocked(world, x, y, r, { allowWater = false } = {}) {
  if (x < r || y < r || x > MAP.w - r || y > MAP.h - r) return true;
  if (!allowWater && isWater(world, x, y, -r * 0.3)) return true;
  for (const h of world.houses) {
    if (x > h.x - h.w / 2 - r && x < h.x + h.w / 2 + r && y > h.y - h.h / 2 - r && y < h.y + h.h / 2 + r * 0.3) return true;
  }
  for (const t of nearby(world.treeGrid, x, y)) {
    if (dist(x, y, t.x, t.y) < 12 * t.size + r) return true;
  }
  return false;
}

function buildGrid(items, cell) {
  const map = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.x / cell)},${Math.floor(it.y / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return { map, cell };
}

function* nearby(grid, x, y) {
  const cx = Math.floor(x / grid.cell), cy = Math.floor(y / grid.cell);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = grid.map.get(`${cx + i},${cy + j}`);
    if (list) yield* list;
  }
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 조건에 맞는 빈 자리 찾기 (생명체 생성용)
export function findSpot(world, test, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const x = 60 + Math.random() * (MAP.w - 120), y = 60 + Math.random() * (MAP.h - 120);
    if (test(x, y)) return { x, y };
  }
  return null;
}
