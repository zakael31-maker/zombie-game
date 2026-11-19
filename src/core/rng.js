// 시드 고정 난수: 같은 시드면 매번 같은 맵이 만들어진다.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (min, max) => min + Math.random() * (max - min);
export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 좌표마다 고정된 난수 씨앗 (같은 자리 = 항상 같은 값)
export function hash2(seed, x, y, salt = 0) {
  let h = (seed * 374761393 + x * 668265263 + y * 2147483647 + salt * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// 부드러운 값 노이즈 (0~1). scale = 언덕 하나의 크기
export function noise2(seed, x, y, scale) {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const v = (i, j) => hash2(seed, ix + i, iy + j, 9) / 4294967296;
  const a = v(0, 0) + (v(1, 0) - v(0, 0)) * sx;
  const b = v(0, 1) + (v(1, 1) - v(0, 1)) * sx;
  return a + (b - a) * sy;
}
