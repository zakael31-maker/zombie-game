// 지도: 오른쪽 위 작은 지도 + 누르면 전체 지도. 안 가 본 곳은 구름(안개)으로 가린다.
// 게임 상태를 읽기만 한다.
import { MAP, featuresInRect, seaAt } from '../game/world.js';
import { biomeAt } from '../game/biomes.js';
import { EXPLORE, EXPLORE_W, EXPLORE_H } from '../game/game.js';

const OVS = 20;            // 지도 1픽셀 = 20칸
const SMALL_SPAN = 2400;   // 작은 지도에 보이는 범위

export function createMinimap(state, small, big) {
  const world = state.world;
  // 1) 전체 지도 그림: 지역 색을 칠하고 지형을 얹는다 (맵이 아주 커지면 buildSome 줄 수를 나눠서)
  const ov = document.createElement('canvas');
  ov.width = Math.ceil(MAP.w / OVS); ov.height = Math.ceil(MAP.h / OVS);
  const og = ov.getContext('2d');
  const img = og.createImageData(ov.width, ov.height);
  let row = 0, ready = false;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function buildSome(rows) {
    if (ready) return;
    for (let k = 0; k < rows && row < ov.height; k++, row++) {
      for (let x = 0; x < ov.width; x++) {
        const wx = (x + 0.5) * OVS, wy = (row + 0.5) * OVS;
        const [r, g, b] = seaAt(world, wx, wy) ? [92, 184, 222] : hex(biomeAt(world, wx, wy).map);
        const o = (row * ov.width + x) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    og.putImageData(img, 0, 0);
    if (row >= ov.height) { ready = true; drawFeatures(); }
  }
  function drawFeatures() {
    og.save(); og.scale(1 / OVS, 1 / OVS);
    const feats = featuresInRect(world, 0, 0, MAP.w, MAP.h);
    for (const f of feats) if (f.kind === 'forest') { og.fillStyle = 'rgba(60,130,70,0.45)'; og.beginPath(); og.arc(f.x, f.y, f.r, 0, Math.PI * 2); og.fill(); }
    og.lineCap = 'round'; og.lineJoin = 'round'; og.strokeStyle = '#efd9a6'; og.lineWidth = 60;
    for (const p of world.paths) { og.beginPath(); og.moveTo(...p[0]); for (let i = 1; i < p.length; i++) og.lineTo(...p[i]); og.stroke(); }
    for (const f of feats) if (f.kind === 'village') { og.fillStyle = 'rgba(240,215,160,0.9)'; og.beginPath(); og.ellipse(f.x, f.y, f.r * 0.9, f.r * 0.75, 0, 0, Math.PI * 2); og.fill(); }
    const houses = [...world.houses];
    for (const f of feats) if (f.kind === 'village' && f.houses) houses.push(...f.houses);
    for (const h of houses) { og.fillStyle = h.roof; og.fillRect(h.x - h.w / 2 - 8, h.y - h.h / 2 - 15, h.w + 16, h.h + 30); }
    for (const f of feats) if (f.kind === 'pond') {
      og.fillStyle = '#efdcaa'; og.beginPath(); og.ellipse(f.x, f.y, f.rx + 30, f.ry + 30, 0, 0, Math.PI * 2); og.fill();
      og.fillStyle = '#6cc0e6'; og.beginPath(); og.ellipse(f.x, f.y, f.rx, f.ry, 0, 0, Math.PI * 2); og.fill();
    }
    og.restore();
  }

  // 2) 안개: 가 본 칸은 투명, 안 가 본 칸은 크림색. 작게 그려서 늘리면 경계가 부드럽다.
  const fog = document.createElement('canvas');
  fog.width = EXPLORE_W; fog.height = EXPLORE_H;
  const fg = fog.getContext('2d');
  const fimg = fg.createImageData(EXPLORE_W, EXPLORE_H);
  let lastCount = -1;
  function updateFog() {
    const e = state.explored;
    let n = 0;
    for (let i = 0; i < e.length; i++) n += e[i];
    if (n === lastCount) return;
    lastCount = n;
    for (let i = 0; i < e.length; i++) {
      const o = i * 4; fimg.data[o] = 246; fimg.data[o + 1] = 240; fimg.data[o + 2] = 226; fimg.data[o + 3] = e[i] ? 0 : 235;
    }
    fg.putImageData(fimg, 0, 0);
  }
  const exploredPct = () => { const e = state.explored; let n = 0; for (let i = 0; i < e.length; i++) n += e[i]; return Math.max(n ? 1 : 0, Math.round((n / e.length) * 100)); };

  // 3) 그리기
  const sg = small.getContext('2d');
  const bg = big.getContext('2d');
  function fit(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return dpr;
  }
  // 세계 사각형(x0,y0,span) → 캔버스 전체에 지도 + 안개 + 좀비
  function paint(g, cv, x0, y0, spanX, spanY, markerR) {
    const W = cv.width, H = cv.height, k = W / spanX;
    g.imageSmoothingEnabled = true;
    g.fillStyle = '#f6f0e2'; g.fillRect(0, 0, W, H);
    if (ready) g.drawImage(ov, x0 / OVS, y0 / OVS, spanX / OVS, spanY / OVS, 0, 0, W, H);
    else { g.fillStyle = '#a6db8a'; g.fillRect(0, 0, W, H); }
    g.drawImage(fog, x0 / EXPLORE, y0 / EXPLORE, spanX / EXPLORE, spanY / EXPLORE, 0, 0, W, H);
    // 맵 밖은 연한 회색
    g.fillStyle = 'rgba(200,190,175,0.9)';
    if (x0 < 0) g.fillRect(0, 0, -x0 * k, H);
    if (y0 < 0) g.fillRect(0, 0, W, -y0 * k);
    if (x0 + spanX > MAP.w) g.fillRect((MAP.w - x0) * k, 0, W, H);
    if (y0 + spanY > MAP.h) g.fillRect(0, (MAP.h - y0) * k, W, H);
    // 친구 + 좀비
    const z = state.zombie;
    for (const c of state.creatures) if (c.friend) { g.fillStyle = '#9fd18b'; g.beginPath(); g.arc((c.x - x0) * k, (c.y - y0) * k, markerR * 0.5, 0, Math.PI * 2); g.fill(); }
    const zx = (z.x - x0) * k, zy = (z.y - y0) * k;
    g.fillStyle = '#fff'; g.beginPath(); g.arc(zx, zy, markerR + 2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6fbf5a'; g.beginPath(); g.arc(zx, zy, markerR, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2e2a28'; g.beginPath(); g.arc(zx + z.facing * markerR * 0.35, zy - markerR * 0.2, markerR * 0.25, 0, Math.PI * 2); g.fill();
  }

  buildSome(ov.height); // 7600칸 맵 기준 약 0.01초
  let timer = 0;
  function update(dt) {
    buildSome(24);
    timer -= dt;
    const open = big.parentElement.classList.contains('show');
    if (timer > 0 && !open) return;
    timer = 0.25;
    updateFog();
    const z = state.zombie;
    const d1 = fit(small);
    paint(sg, small, z.x - SMALL_SPAN / 2, z.y - SMALL_SPAN / 2, SMALL_SPAN, SMALL_SPAN, 4 * d1);
    if (open) {
      const d2 = fit(big);
      paint(bg, big, 0, 0, MAP.w, MAP.h, 5 * d2);
    }
  }
  return { update, exploredPct };
}
