// 지역(바이옴) 정의. 새 지역을 만들려면 BIOMES에 하나 추가하고 LAYOUT에 자리를 정하면 된다.
// 아직 만들지 않은 지역은 초원(meadow)으로 보인다.
import { noise2 } from '../core/rng.js';

// ground: 바닥색 · map: 지도에서 보이는 색
// trees: 60칸마다 나무가 날 확률 · pine: 그중 침엽수 비율
// flowers / rocks: 400칸 한 조각에 평균 몇 개
// creatures: 400칸 한 조각에 평균 몇 마리
export const BIOMES = {
  meadow: {
    name: '초원', ground: '#a6db8a', map: '#a6db8a',
    trees: 0.06, pine: 0.2, flowers: 25, rocks: 1.7,
    creatures: { rabbit: 0.61, snail: 0.5, caterpillar: 0.33, ladybug: 0.39, butterfly: 0.72, cat: 0.14 },
  },
  snow: {
    name: '겨울', ground: '#eef4f8', map: '#e9f1f6',
    trees: 0.08, pine: 0.75, flowers: 0, rocks: 2.4,
    creatures: { hare: 0.45, fox: 0.1, snowman: 0.08, penguin: 0.12 },
  },
  desert: {
    name: '사막', ground: '#f3dba4', map: '#f0d59a',
    trees: 0.045, pine: 0.55, flowers: 2, rocks: 2.6, // 나무 = 선인장 (pine 비율 = 키 큰 기둥 선인장)
    creatures: { lizard: 0.42, meerkat: 0.16, prickle: 0.07, camel: 0.035 },
  },
  // 앞으로 추가: jungle(밀림) · beach(바닷가)
};

// 지역 배치: 가운데는 집(초원), 바깥은 방향별로 나뉜다. 경계는 노이즈로 구불구불하게.
export const LAYOUT = { home: 'meadow', north: 'snow', south: 'desert', east: 'jungle', west: 'beach' };
export const HOME_RADIUS = 1900;

export function biomeIdAt(world, x, y) {
  const cx = world.size.w / 2, cy = world.size.h / 2;
  const dx = x - cx, dy = y - cy;
  // 큰 굽이 + 작은 굽이 (경계가 자연스럽게 구불구불)
  const wob = (noise2(world.seed, x, y, 900) - 0.5) * 700 + (noise2(world.seed + 2, x, y, 220) - 0.5) * 240;
  if (Math.hypot(dx, dy) < HOME_RADIUS + wob) return LAYOUT.home;
  const a = Math.atan2(dy, dx) + (noise2(world.seed + 1, x, y, 1400) - 0.5) * 0.9; // 화면 아래 = 남쪽
  const q = Math.PI / 4;
  if (a > -q && a <= q) return LAYOUT.east;
  if (a > q && a <= 3 * q) return LAYOUT.south;
  if (a > -3 * q && a <= -q) return LAYOUT.north;
  return LAYOUT.west;
}

// 실제로 쓸 지역 정보 (아직 없는 지역이면 초원으로 대신)
export function biomeAt(world, x, y) {
  return BIOMES[biomeIdAt(world, x, y)] || BIOMES.meadow;
}
