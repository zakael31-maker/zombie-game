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
  // 앞으로 추가: snow(겨울) · desert(사막) · jungle(밀림) · beach(바닷가)
};

// 지역 배치: 가운데는 집(초원), 바깥은 방향별로 나뉜다. 경계는 노이즈로 구불구불하게.
export const LAYOUT = { home: 'meadow', north: 'snow', south: 'desert', east: 'jungle', west: 'beach' };
export const HOME_RADIUS = 1900;

export function biomeIdAt(world, x, y) {
  const cx = world.size.w / 2, cy = world.size.h / 2;
  const dx = x - cx, dy = y - cy;
  const wob = noise2(world.seed, x, y, 900) - 0.5;
  if (Math.hypot(dx, dy) < HOME_RADIUS + wob * 700) return LAYOUT.home;
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
