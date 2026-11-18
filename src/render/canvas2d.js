// 2D 카툰 렌더러. 게임 상태를 읽어서 그리기만 한다 (게임 규칙은 건드리지 않음).
// 3D로 바꿀 때는 같은 render(state, dt, input) 모양의 three.js 렌더러로 교체하면 된다.
import { MAP } from '../game/world.js';
import { TYPES } from '../game/creatures.js';
import { nightAmount, DAY_LENGTH } from '../game/game.js';
import { mulberry32, clamp } from '../core/rng.js';

const TAU = Math.PI * 2;

export function createRenderer(canvas, state) {
  const mainCtx = canvas.getContext('2d');
  let ctx = mainCtx; // 좀비 친구는 잠깐 다른 캔버스에 그린 뒤 초록빛을 입힌다
  const fCanvas = document.createElement('canvas');
  const fCtx = fCanvas.getContext('2d');
  const terrain = bakeTerrain(state.world);
  const particles = [];
  const fireflies = [];
  const cam = { x: state.zombie.x, y: state.zombie.y, zoom: 1 };
  let W = 0, H = 0, dpr = 1, t = 0;
  const sun = { x: 0, k: 1 }; // 그림자 방향(-1 아침 ~ 1 저녁)과 진하기

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function render(state, dt, input) {
    t += dt;
    const z = state.zombie;
    const night = nightAmount(state.time);
    const dayP = (state.time % DAY_LENGTH) / DAY_LENGTH; // 0 자정 · 0.5 정오
    sun.x = Math.sin((dayP - 0.5) * TAU);
    sun.k = 1 - night * 0.6;
    for (const e of state.events) onEvent(e);

    // 카메라: 좀비를 부드럽게 따라가고, 오래 가만히 있으면 살짝 멀어져서 세상을 보여준다
    const baseZoom = clamp(Math.min(W, H) / 230, 1.2, 2.6);
    const targetZoom = baseZoom * (z.idleTime > 8 ? 0.8 : 1);
    cam.zoom += (targetZoom - cam.zoom) * Math.min(1, dt * (z.idleTime > 8 ? 0.3 : 2));
    cam.x += (z.x - cam.x) * Math.min(1, dt * 4);
    cam.y += (z.y - 10 - cam.y) * Math.min(1, dt * 4);
    const halfW = W / 2 / cam.zoom, halfH = H / 2 / cam.zoom;
    cam.x = clamp(cam.x, halfW, MAP.w - halfW);
    cam.y = clamp(cam.y, halfH, MAP.h - halfH);
    const view = { x0: cam.x - halfW - 80, y0: cam.y - halfH - 80, x1: cam.x + halfW + 80, y1: cam.y + halfH + 120 };
    const inView = (o) => o.x > view.x0 && o.x < view.x1 && o.y > view.y0 && o.y < view.y1;

    // --- 월드 좌표로 그리기 ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#8fcf7a';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    ctx.drawImage(terrain, 0, 0);
    drawWaterShimmer(state.world, view, dt);

    for (const f of state.world.flowers) if (inView(f)) drawFlower(f);
    for (const m of state.world.mushrooms) if (inView(m)) drawMushroom(m);
    for (const r of state.world.rocks) if (inView(r)) drawRock(r);

    drawSnailTrails(state, view);

    // 물 위 생명체 먼저
    for (const c of state.creatures) if (c.type === 'duck' && inView(c)) { duckWake(c, dt); drawDuck(c); }

    // 앞뒤 순서(y)대로 정렬해서 그리기
    const list = [];
    for (const tr of state.world.trees) if (inView(tr)) list.push({ y: tr.y, draw: () => drawTree(tr, z) });
    for (const h of state.world.houses) if (inView(h)) list.push({ y: h.y + h.h / 2, draw: () => drawHouse(h, night) });
    for (const c of state.creatures) {
      if (c.type === 'duck' || c.type === 'butterfly' || !inView(c)) continue;
      list.push({ y: c.y, draw: () => (c.friend ? drawFriend(c, night) : c.carriedBy ? drawCarried(c, night) : drawCreature(c, night)) });
    }
    list.push({ y: z.y, draw: () => drawZombie(z) });
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.draw();

    for (const c of state.creatures) if (c.type === 'butterfly' && inView(c)) drawButterfly(c);
    if (state.nearEdible) drawTargetRing(state.nearEdible);
    drawParticles(dt);
    drawClouds(view, night);
    updateMotes(dt, night, halfW, halfH, state.world);
    ctx.restore();

    // --- 밤 ---
    if (night > 0.01) {
      ctx.fillStyle = `rgba(28, 34, 92, ${night * 0.5})`;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);
      ctx.globalCompositeOperation = 'lighter';
      for (const h of state.world.houses) if (inView(h)) houseLights(h, night);
      for (const c of state.creatures) if (c.type === 'spirit' && inView(c)) glow(c.x, c.y - 14, 34, `rgba(110,240,220,${0.35 * night + 0.1})`);
      if (z.traits.includes('glow')) glow(z.x, z.y - 22, 46, `rgba(150,255,200,${0.3 * night + 0.08})`);
      updateFireflies(dt, night, halfW, halfH);
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrade(dayP, night);
    drawJoystick(input);
  }

  // ================= 지형 미리 그리기 =================
  function bakeTerrain(world) {
    const c = document.createElement('canvas');
    c.width = MAP.w; c.height = MAP.h;
    const g = c.getContext('2d');
    const r = mulberry32(world.seed + 99);
    const blob = (x, y, rx, ry, col) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, r() * 3, 0, TAU); g.fill(); };

    g.fillStyle = '#a6db8a';
    g.fillRect(0, 0, MAP.w, MAP.h);
    // 큰 들판 색 얼룩: 햇살 받은 노란 풀밭 / 그늘진 초록
    for (let i = 0; i < 90; i++) {
      const x = r() * MAP.w, y = r() * MAP.h, R = 120 + r() * 220;
      const warm = r() < 0.5;
      const gr = g.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, warm ? 'rgba(220,235,140,0.28)' : 'rgba(80,160,90,0.18)');
      gr.addColorStop(1, warm ? 'rgba(220,235,140,0)' : 'rgba(80,160,90,0)');
      g.fillStyle = gr; g.fillRect(x - R, y - R, R * 2, R * 2);
    }
    // 작은 붓터치 얼룩
    for (let i = 0; i < 1400; i++) {
      blob(r() * MAP.w, r() * MAP.h, 10 + r() * 40, 6 + r() * 22,
        r() < 0.5 ? 'rgba(255,255,220,0.07)' : 'rgba(60,140,60,0.06)');
    }
    // 숲은 조금 더 진하게 + 낙엽과 이끼
    const f = world.forest;
    const fg = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 1.15);
    fg.addColorStop(0, 'rgba(40,110,60,0.38)');
    fg.addColorStop(1, 'rgba(40,110,60,0)');
    g.fillStyle = fg;
    g.fillRect(f.x - f.r * 1.2, f.y - f.r * 1.2, f.r * 2.4, f.r * 2.4);
    for (let i = 0; i < 700; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * f.r;
      const x = f.x + Math.cos(a) * d, y = f.y + Math.sin(a) * d;
      if (r() < 0.6) {
        g.fillStyle = ['#d9a05b', '#e8b86a', '#c97e4a', '#b9c46a'][Math.floor(r() * 4)];
        g.globalAlpha = 0.55;
        g.beginPath(); g.ellipse(x, y, 3, 1.6, r() * 3, 0, TAU); g.fill();
        g.globalAlpha = 1;
      } else blob(x, y, 8 + r() * 14, 5 + r() * 8, 'rgba(70,140,70,0.22)');
    }
    // 마을 바닥: 흙 + 돌바닥 무늬
    const v = world.village;
    const vg = g.createRadialGradient(v.x, v.y, v.r * 0.3, v.x, v.y, v.r * 0.95);
    vg.addColorStop(0, 'rgba(240,220,170,0.6)');
    vg.addColorStop(1, 'rgba(240,220,170,0)');
    g.fillStyle = vg;
    g.beginPath(); g.ellipse(v.x, v.y, v.r * 0.95, v.r * 0.8, 0, 0, TAU); g.fill();
    for (let i = 0; i < 260; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * v.r * 0.55;
      blob(v.x + Math.cos(a) * d, v.y + Math.sin(a) * d * 0.85, 5 + r() * 4, 3.5 + r() * 2, 'rgba(200,180,140,0.35)');
    }
    // 클로버 군락
    for (let i = 0; i < 160; i++) {
      const cx = r() * MAP.w, cy = r() * MAP.h;
      for (let k = 0; k < 7; k++) {
        const x = cx + (r() - 0.5) * 40, y = cy + (r() - 0.5) * 24;
        g.fillStyle = 'rgba(90,170,80,0.5)';
        for (let l = 0; l < 3; l++) { const la = l * 2.1 + r(); g.beginPath(); g.arc(x + Math.cos(la) * 2, y + Math.sin(la) * 2, 2, 0, TAU); g.fill(); }
        if (r() < 0.12) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y - 3, 2.2, 0, TAU); g.fill(); }
      }
    }
    // 풀 포기 (두 가지 색)
    g.lineWidth = 1.5; g.lineCap = 'round';
    for (let i = 0; i < 4500; i++) {
      const x = r() * MAP.w, y = r() * MAP.h, h = 5 + r() * 4;
      g.strokeStyle = r() < 0.7 ? 'rgba(70,150,70,0.45)' : 'rgba(150,200,90,0.5)';
      g.beginPath();
      g.moveTo(x - 3, y); g.quadraticCurveTo(x - 3, y - h * 0.5, x - 5, y - h * 0.7);
      g.moveTo(x, y); g.lineTo(x + 0.5, y - h);
      g.moveTo(x + 3, y); g.quadraticCurveTo(x + 3, y - h * 0.5, x + 5, y - h * 0.7);
      g.stroke();
    }
    // 조약돌
    for (let i = 0; i < 500; i++) blob(r() * MAP.w, r() * MAP.h, 1.5 + r() * 2, 1 + r() * 1.5, 'rgba(150,150,140,0.35)');
    // 길: 부드러운 가장자리 + 바퀴 자국 + 자갈
    g.lineCap = 'round'; g.lineJoin = 'round';
    const pathLine = (p) => { g.beginPath(); g.moveTo(...p[0]); for (let i = 1; i < p.length; i++) g.lineTo(...p[i]); g.stroke(); };
    for (const p of world.paths) {
      for (const [w, col] of [[52, 'rgba(150,170,90,0.35)'], [44, '#d8bf88'], [36, '#ead6a4'], [26, '#f0dfb2']]) {
        g.strokeStyle = col; g.lineWidth = w; pathLine(p);
      }
      // 길 위 자갈
      for (let k = 1; k < p.length; k++) {
        const [x1, y1] = p[k - 1], [x2, y2] = p[k];
        const len = Math.hypot(x2 - x1, y2 - y1);
        for (let d = 0; d < len; d += 9) {
          const u = d / len, ox = (r() - 0.5) * 34, oy = (r() - 0.5) * 34;
          if (r() < 0.5) blob(x1 + (x2 - x1) * u + ox, y1 + (y2 - y1) * u + oy, 1.6 + r() * 1.6, 1.2 + r(), 'rgba(170,140,100,0.45)');
        }
        // 가장자리로 삐져나온 풀
        g.strokeStyle = 'rgba(90,160,80,0.55)'; g.lineWidth = 1.4;
        for (let d = 0; d < len; d += 6) {
          const u = d / len, nx = -(y2 - y1) / len, ny = (x2 - x1) / len, side = r() < 0.5 ? -1 : 1;
          const x = x1 + (x2 - x1) * u + nx * side * (17 + r() * 4), y = y1 + (y2 - y1) * u + ny * side * (17 + r() * 4);
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - 4 - r() * 3); g.stroke();
        }
      }
    }
    // 연못: 젖은 모래 → 얕은 물 → 깊은 물
    for (const p of world.ponds) {
      g.fillStyle = '#efdcaa';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx + 20, p.ry + 18, 0, 0, TAU); g.fill();
      g.fillStyle = '#d9c08a';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx + 8, p.ry + 7, 0, 0, TAU); g.fill();
      const wg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(p.rx, p.ry));
      wg.addColorStop(0, '#5fb3dd'); wg.addColorStop(0.7, '#7cc9ea'); wg.addColorStop(1, '#a6e0f2');
      g.fillStyle = wg;
      g.save(); g.translate(p.x, p.y); g.scale(1, p.ry / p.rx); g.translate(-p.x, -p.y);
      g.beginPath(); g.arc(p.x, p.y, p.rx, 0, TAU); g.fill();
      g.restore();
      // 물가 하이라이트
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(p.x, p.y, p.rx - 4, p.ry - 4, 0, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
      // 연잎
      for (let i = 0; i < 11; i++) {
        const a = r() * TAU, d = 0.3 + r() * 0.55;
        const x = p.x + Math.cos(a) * p.rx * d, y = p.y + Math.sin(a) * p.ry * d, R = 8 + r() * 6;
        g.fillStyle = 'rgba(30,90,120,0.25)';
        g.beginPath(); g.ellipse(x + 2, y + 2, R, R * 0.8, 0, 0, TAU); g.fill();
        g.fillStyle = '#6cbf6a';
        g.beginPath(); g.arc(x, y, R, 0.3, TAU - 0.3); g.lineTo(x, y); g.fill();
        g.strokeStyle = 'rgba(60,140,60,0.7)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - R * 0.7, y - R * 0.3); g.moveTo(x, y); g.lineTo(x - R * 0.4, y + R * 0.6); g.stroke();
        if (r() < 0.4) {
          g.fillStyle = '#ffb3d1'; for (let k = 0; k < 5; k++) { const ka = k * 1.256; g.beginPath(); g.ellipse(x + 2 + Math.cos(ka) * 2.5, y - 2 + Math.sin(ka) * 2.5, 2.4, 1.4, ka, 0, TAU); g.fill(); }
          g.fillStyle = '#ffe680'; g.beginPath(); g.arc(x + 2, y - 2, 1.4, 0, TAU); g.fill();
        }
      }
      // 물가 갈대
      for (let i = 0; i < 26; i++) {
        const a = r() * TAU, k = 1.02 + r() * 0.08;
        const x = p.x + Math.cos(a) * p.rx * k, y = p.y + Math.sin(a) * p.ry * k;
        g.strokeStyle = '#6aa05a'; g.lineWidth = 1.6;
        for (let l = 0; l < 3; l++) { g.beginPath(); g.moveTo(x + l * 2 - 2, y); g.quadraticCurveTo(x + l * 2 - 2, y - 8, x + l * 3 - 3, y - 14 - r() * 6); g.stroke(); }
        if (r() < 0.5) { g.fillStyle = '#8a5a3a'; g.beginPath(); g.ellipse(x, y - 17, 1.8, 4, 0, 0, TAU); g.fill(); }
      }
    }
    return c;
  }

  const ripples = [];
  function drawWaterShimmer(world, view, dt) {
    ctx.lineCap = 'round';
    for (const p of world.ponds) {
      if (p.x + p.rx < view.x0 || p.x - p.rx > view.x1 || p.y + p.ry < view.y0 || p.y - p.ry > view.y1) continue;
      // 반짝이는 물결
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 9; i++) {
        const a = i * 1.7 + p.x, k = (Math.sin(t * 0.8 + i * 1.3) + 1) / 2;
        const x = p.x + Math.cos(a) * p.rx * 0.6 + Math.sin(t * 0.3 + i) * 6, y = p.y + Math.sin(a * 1.3) * p.ry * 0.6;
        ctx.globalAlpha = 0.15 + k * 0.5;
        ctx.beginPath(); ctx.moveTo(x - 6 - k * 5, y); ctx.quadraticCurveTo(x, y - 2, x + 6 + k * 5, y); ctx.stroke();
      }
      // 햇빛 반짝 점
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 6; i++) {
        const k = Math.sin(t * 3 + i * 2.1 + p.x);
        if (k < 0.85) continue;
        ctx.globalAlpha = (k - 0.85) * 6;
        const a = i * 2.3 + p.y;
        star(p.x + Math.cos(a) * p.rx * 0.5, p.y + Math.sin(a) * p.ry * 0.5, 3);
      }
      // 가끔 동그란 물결
      if (Math.random() < dt * 0.8) {
        const a = Math.random() * TAU, d = Math.random() * 0.8;
        ripples.push({ x: p.x + Math.cos(a) * p.rx * d, y: p.y + Math.sin(a) * p.ry * d, life: 0 });
      }
    }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.life += dt;
      if (rp.life > 2) { ripples.splice(i, 1); continue; }
      ctx.globalAlpha = 0.5 * (1 - rp.life / 2);
      ctx.beginPath(); ctx.ellipse(rp.x, rp.y, 3 + rp.life * 10, (3 + rp.life * 10) * 0.5, 0, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // 오리가 지나가면 물결
  function duckWake(c, dt) {
    if (c.mode === 'walk' && Math.random() < dt * 3) ripples.push({ x: c.x - c.facing * 6, y: c.y, life: 0.4 });
  }

  // ================= 바닥 장식 =================
  function drawFlower(f) {
    const sway = Math.sin(t * 1.5 + f.x) * 0.8;
    const v = Math.floor(f.x) % 2;
    stamp(sprite('flower' + f.color + v, 18, 20, 9, 9, () => paintFlower(f.color, v)), f.x + sway, f.y, f.s);
  }
  function paintFlower(col, v) {
    const s = 3.2;
    // 줄기와 잎
    ctx.strokeStyle = '#5fa84e'; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.quadraticCurveTo(-1, 6, 0.5, 9); ctx.stroke();
    ctx.fillStyle = '#6fbf5a';
    ctx.beginPath(); ctx.ellipse(-2.5, 7, 2.6, 1.1, -0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2.8, 8, 2.4, 1, 0.5, 0, TAU); ctx.fill();
    // 꽃잎: 그늘 → 본색 → 안쪽 밝은 결
    const n = v ? 6 : 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU - Math.PI / 2;
      ctx.save(); ctx.translate(Math.cos(a) * s, Math.sin(a) * s); ctx.rotate(a);
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.ellipse(0.3, 0.4, s * 0.95, s * 0.72, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, s * 0.95, s * 0.72, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-s * 0.2, -s * 0.15, s * 0.45, s * 0.3, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.35;
      ctx.beginPath(); ctx.moveTo(-s * 0.6, 0); ctx.lineTo(s * 0.5, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = '#e8a92e'; circle(0, 0.3, s * 0.62);
    ctx.fillStyle = '#ffd34d'; circle(0, 0, s * 0.55);
    ctx.fillStyle = '#c98a1e';
    for (let i = 0; i < 6; i++) { const a = i * 1.05; circle(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3, 0.3); }
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(-0.6, -0.7, 0.55);
  }
  function drawMushroom(m) {
    stamp(sprite('mush' + (Math.floor(m.x) % 2), 16, 14, 8, 12, () => paintMushroom(Math.floor(m.x) % 2)), m.x, m.y);
  }
  function paintMushroom(v) {
    const drawOne = (x, k) => {
      ctx.save(); ctx.translate(x, 0); ctx.scale(k, k);
      ctx.fillStyle = '#f5ecd9'; rr(-2, -6, 4, 6.5, 2);
      ctx.fillStyle = 'rgba(160,130,100,0.25)'; rr(0.5, -6, 1.5, 6.5, 1);
      ctx.fillStyle = '#d65a58';
      ctx.beginPath(); ctx.ellipse(0, -5.6, 6, 4.8, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = '#ef6f6c';
      ctx.beginPath(); ctx.ellipse(-0.3, -6, 5.6, 4.6, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = '#f2dcc4'; ctx.beginPath(); ctx.ellipse(0, -6, 6, 1.1, 0, 0, Math.PI); ctx.fill();
      ctx.fillStyle = '#fff'; circle(-2.2, -8.2, 1.2); circle(2.5, -7.8, 1); circle(0.3, -10, 0.7); circle(-4.3, -6.8, 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(-2.5, -9.5, 2, 0.9, -0.4, 0, TAU); ctx.fill();
      ctx.restore();
    };
    if (v) drawOne(4, 0.6);
    drawOne(0, 1);
    ctx.strokeStyle = '#6fbf5a'; ctx.lineWidth = 0.8; ctx.lineCap = 'round';
    for (const x of [-4, -3, 3.5]) { ctx.beginPath(); ctx.moveTo(x, 0.8); ctx.lineTo(x + 0.6, -2); ctx.stroke(); }
  }
  function drawRock(r) {
    const v = Math.floor(r.x + r.y) % 3;
    stamp(sprite('rock' + v, 26, 20, 13, 12, () => paintRock(v)), r.x, r.y, r.s);
  }
  function paintRock(v) {
    const r = mulberry32(500 + v);
    ctx.fillStyle = '#a49f99';
    ctx.beginPath(); ctx.ellipse(0, 0.5, 10.3, 7.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#b9b4ae';
    ctx.beginPath(); ctx.ellipse(0, 0, 10, 7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d6d1cb';
    ctx.beginPath(); ctx.ellipse(-2, -2, 6, 4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.ellipse(-3.5, -3.5, 2.5, 1.2, -0.3, 0, TAU); ctx.fill();
    // 금 + 얼룩
    ctx.strokeStyle = 'rgba(110,100,95,0.45)'; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(3, -4); ctx.lineTo(4.5, -1); ctx.lineTo(3.5, 2); ctx.stroke();
    ctx.fillStyle = 'rgba(120,110,100,0.25)';
    for (let i = 0; i < 4; i++) circle(-6 + r() * 12, -3 + r() * 6, 0.6 + r() * 0.6);
    // 이끼
    if (v !== 2) {
      ctx.fillStyle = '#86c46e';
      for (let i = 0; i < 6; i++) circle(-8 + i * 1.6 + r(), 3 + r() * 1.5, 1.2 + r() * 0.6);
      ctx.fillStyle = 'rgba(200,240,170,0.6)'; circle(-6, 2.6, 0.6); circle(-3, 3, 0.5);
    }
    // 돌 옆 풀
    ctx.strokeStyle = '#6fbf5a'; ctx.lineWidth = 0.8;
    for (const x of [8.5, 10, 11]) { ctx.beginPath(); ctx.moveTo(x, 5); ctx.lineTo(x + r() - 0.5, 1); ctx.stroke(); }
  }

  // ================= 나무와 집 =================
  function drawTree(tr, z) {
    const s = tr.size;
    const sway = Math.sin(t * 0.9 + tr.phase) * 1.5 + Math.sin(t * 2.3 + tr.phase * 2) * 0.4;
    shadow(tr.x, tr.y, 22 * s, 8 * s, 1.6);
    // 좀비가 나무 뒤에 있으면 반투명하게
    const behind = z.y < tr.y && z.y > tr.y - 70 * s && Math.abs(z.x - tr.x) < 30 * s;
    const v = Math.floor(tr.phase * 7) % 3, fruit = tr.kind !== 'pine' && tr.phase > 4.5;
    const spr = tr.kind === 'pine'
      ? sprite('pine' + v, 70, 90, 35, 84, () => paintPine(v))
      : sprite('tree' + v + fruit, 76, 78, 38, 72, () => paintRoundTree(v, fruit));
    // 바람: 뿌리는 고정, 위로 갈수록 더 흔들림 (기울이기)
    ctx.save();
    ctx.translate(tr.x, tr.y);
    ctx.transform(1, 0, -sway / 55, 1, 0, 0);
    if (behind) ctx.globalAlpha = 0.45;
    stamp(spr, 0, 0, s);
    ctx.restore();
  }
  function paintTrunk(r) {
    ctx.fillStyle = '#9a6b4a';
    // 뿌리
    ctx.beginPath(); ctx.moveTo(-9, 1); ctx.quadraticCurveTo(-5, -2, -5, -8); ctx.lineTo(5, -8); ctx.quadraticCurveTo(5, -2, 9, 1); ctx.closePath(); ctx.fill();
    rr(-5, -24, 10, 25, 4);
    ctx.fillStyle = 'rgba(80,50,30,0.25)'; rr(1, -24, 4, 25, 2);
    ctx.fillStyle = 'rgba(255,230,200,0.18)'; rr(-4, -22, 2, 20, 1);
    // 나무껍질 결
    ctx.strokeStyle = 'rgba(90,55,35,0.4)'; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const x = -3 + r() * 6, y = -20 + r() * 16;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 0.8, y + 2, x, y + 3 + r() * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(90,55,35,0.45)';
    ctx.beginPath(); ctx.ellipse(-1, -12, 1.4, 1, 0, 0, TAU); ctx.stroke(); // 옹이
    // 뿌리 옆 풀
    ctx.strokeStyle = '#6fbf5a'; ctx.lineWidth = 0.9;
    for (const x of [-9, -7.5, 7, 8.5, 10]) { ctx.beginPath(); ctx.moveTo(x, 1.5); ctx.lineTo(x + (r() - 0.5) * 2, -2 - r() * 2.5); ctx.stroke(); }
  }
  function paintRoundTree(v, fruit) {
    const r = mulberry32(31 + v);
    paintTrunk(r);
    const cx = 0, cy = -40;
    const blobs = [[-14, 9, 17], [14, 9, 17], [-14, 5, 16], [14, 5, 16], [0, -6, 22]];
    // 아래쪽 그늘 덩어리 → 중간 → 빛 받는 위쪽 순서로
    ctx.fillStyle = '#4f9645';
    for (const [x, y, R] of blobs.slice(0, 2)) circle(cx + x, cy + y + 2, R);
    ctx.fillStyle = '#5ea851';
    for (const [x, y, R] of blobs.slice(0, 2)) circle(cx + x, cy + y, R);
    ctx.fillStyle = '#6cbb5c';
    for (const [x, y, R] of blobs.slice(2)) circle(cx + x, cy + y, R);
    // 가장자리 잎 뭉치 (울퉁불퉁 실루엣)
    for (let i = 0; i < 26; i++) {
      const a = r() * TAU, d = 18 + r() * 8;
      const x = cx + Math.cos(a) * d * 1.25, y = cy + Math.sin(a) * d * 0.95;
      ctx.fillStyle = y > cy + 4 ? '#5ea851' : '#6cbb5c';
      circle(x, y, 4 + r() * 3);
    }
    ctx.fillStyle = '#80cb6c';
    circle(cx - 5, cy - 10, 14); circle(cx - 17, cy + 1, 8); circle(cx + 10, cy - 12, 8);
    ctx.fillStyle = '#92d67c';
    circle(cx - 8, cy - 14, 8); circle(cx - 19, cy - 1, 4.5);
    // 잎사귀 조각 (작은 잎 모양)
    const leaf = (x, y, a, L, col) => {
      ctx.fillStyle = col; ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(L * 0.5, -L * 0.45, L, 0); ctx.quadraticCurveTo(L * 0.5, L * 0.45, 0, 0); ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < 70; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * 27;
      const x = cx + Math.cos(a) * d * 1.15, y = cy - 2 + Math.sin(a) * d * 0.85;
      const top = y < cy - 4 && x < cx + 6;
      leaf(x, y, r() * TAU, 2.6 + r() * 1.6, top ? 'rgba(200,245,170,0.55)' : y > cy + 6 ? 'rgba(50,120,50,0.35)' : 'rgba(70,150,60,0.4)');
    }
    // 잎 결 (반달 선)
    ctx.strokeStyle = 'rgba(60,130,60,0.35)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const x = cx - 18 + r() * 36, y = cy - 6 + r() * 20;
      ctx.beginPath(); ctx.arc(x, y, 4 + r() * 3, 0.2, 1.7); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(240,255,215,0.55)';
    circle(cx - 9, cy - 17, 4.5); circle(cx - 21, cy - 3, 2.5); circle(cx + 6, cy - 19, 2);
    if (fruit) {
      for (const [x, y, R] of [[8, 0, 3], [-12, 8, 3], [16, 12, 2.6], [-2, -14, 2.4], [20, -4, 2.4]]) {
        ctx.fillStyle = '#e86a6a'; circle(cx + x, cy + y + 0.4, R);
        ctx.fillStyle = '#ff8a8a'; circle(cx + x - 0.3, cy + y, R * 0.85);
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; circle(cx + x - R * 0.35, cy + y - R * 0.35, R * 0.3);
        ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(cx + x, cy + y - R); ctx.lineTo(cx + x + 0.6, cy + y - R - 1.4); ctx.stroke();
      }
    }
  }
  function paintPine(v) {
    const r = mulberry32(77 + v);
    paintTrunk(r);
    for (let i = 0; i < 3; i++) {
      const w = 30 - i * 7, y = -(20 + i * 17), top = y - 26;
      // 들쭉날쭉한 아래 가장자리
      const tri = (dy, col) => {
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, top + dy);
        const n = 7;
        for (let k = 0; k <= n; k++) {
          const x = w - (2 * w * k) / n;
          ctx.lineTo(x, y + dy + (k % 2 ? 2.5 : 0));
        }
        ctx.closePath(); ctx.fill();
      };
      tri(1.5, '#4c9a5a');
      tri(0, i % 2 ? '#6ab874' : '#5aa866');
      // 오른쪽 그늘 / 왼쪽 빛
      ctx.fillStyle = 'rgba(30,80,50,0.22)';
      ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w, y); ctx.lineTo(w * 0.25, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(220,255,200,0.2)';
      ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(-w * 0.55, y - 4); ctx.lineTo(-w * 0.2, y - 4); ctx.closePath(); ctx.fill();
      // 솔잎 결
      ctx.strokeStyle = 'rgba(40,100,60,0.35)'; ctx.lineWidth = 0.7; ctx.lineCap = 'round';
      for (let k = 0; k < 14; k++) {
        const fy = top + 6 + r() * (y - top - 7), half = (fy - top) / (y - top) * w * 0.85;
        const fx = (r() * 2 - 1) * half;
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + (fx < 0 ? -1.6 : 1.6), fy + 2); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(210,255,200,0.35)';
      for (let k = 0; k < 5; k++) {
        const fy = top + 8 + r() * (y - top - 10), half = (fy - top) / (y - top) * w * 0.6;
        const fx = -r() * half;
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx - 1.5, fy + 1.8); ctx.stroke();
      }
    }
    // 솔방울 하나
    if (v === 1) { ctx.fillStyle = '#a0724a'; ctx.beginPath(); ctx.ellipse(9, -18, 1.6, 2.4, 0.3, 0, TAU); ctx.fill(); }
  }

  function drawHouse(h) {
    const base = h.y + h.h / 2, wallH = 58;
    shadow(h.x, base, h.w * 0.62, 13, 1.4);
    stamp(sprite('house' + h.roof + h.w, h.w + 40, 122, h.w / 2 + 20, 114, () => paintHouse(h.w, h.roof)), h.x, base);
    // 굴뚝 연기
    const chx = h.x - h.w / 2 + h.w * 0.72, roofY = base - wallH + 4 - (1 - Math.abs(chx - h.x) / (h.w / 2 + 10)) * 46;
    if (Math.random() < 0.025) particles.push({ x: chx + (Math.random() - 0.5) * 4, y: roofY - 24, vx: 6 + Math.random() * 4, vy: -10, life: 3, kind: 'smoke', r: 4 });
  }
  // 집 한 채를 (문 아래 가운데 = 0,0) 기준으로 자세히 그린다
  function paintHouse(w, roof) {
    const h = { x: 0, w, roof }, x0 = -w / 2, base = 0, wallH = 58;
    const r = mulberry32(w + roof.length * 7 + roof.charCodeAt(2));
    ctx.fillStyle = '#fbefd9';
    rr(x0, base - wallH, h.w, wallH, 6);
    // 벽 나무결 + 오른쪽 그늘
    ctx.fillStyle = 'rgba(200,170,130,0.18)';
    for (let y = base - wallH + 12; y < base - 8; y += 9) ctx.fillRect(x0 + 2, y, h.w - 4, 1.2);
    ctx.fillStyle = 'rgba(150,110,70,0.12)';
    ctx.fillRect(x0 + h.w - 14, base - wallH, 14, wallH);
    ctx.fillStyle = '#e9d6b6';
    ctx.fillRect(x0, base - 8, h.w, 8);
    // 굴뚝
    const chx = x0 + h.w * 0.72, roofY = (x) => base - wallH + 4 - (1 - Math.abs(x - h.x) / (h.w / 2 + 10)) * 46;
    ctx.fillStyle = '#c98a6a'; rr(chx - 7, roofY(chx) - 20, 14, 26, 2);
    ctx.fillStyle = '#a96a4a'; ctx.fillRect(chx - 9, roofY(chx) - 22, 18, 5);
    // 지붕 + 기와 줄무늬 + 처마 그늘
    ctx.fillStyle = 'rgba(90,60,40,0.18)';
    ctx.fillRect(x0, base - wallH + 3, h.w, 6);
    ctx.fillStyle = h.roof;
    ctx.beginPath();
    ctx.moveTo(x0 - 10, base - wallH + 4); ctx.lineTo(h.x, base - wallH - 42); ctx.lineTo(x0 + h.w + 10, base - wallH + 4);
    ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1.5;
    for (let y = base - wallH - 30; y < base - wallH + 4; y += 8) { ctx.beginPath(); ctx.moveTo(x0 - 10, y); ctx.lineTo(x0 + h.w + 10, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath(); ctx.moveTo(h.x, base - wallH - 42); ctx.lineTo(x0 + h.w + 10, base - wallH + 4); ctx.lineTo(h.x + 10, base - wallH + 4); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(x0 - 4, base - wallH + 2); ctx.lineTo(h.x, base - wallH - 36); ctx.lineTo(h.x, base - wallH - 28); ctx.lineTo(x0 + 6, base - wallH + 2);
    ctx.fill();
    // 문
    ctx.fillStyle = '#b47b52';
    rr(h.x - 10, base - 34, 20, 34, 8);
    ctx.fillStyle = 'rgba(80,40,20,0.2)'; rr(h.x - 6, base - 30, 5, 24, 2); rr(h.x + 1, base - 30, 5, 24, 2);
    ctx.fillStyle = '#ffd34d'; circle(h.x + 6, base - 16, 1.6);
    ctx.fillStyle = '#d9c3a0'; rr(h.x - 13, base - 2, 26, 4, 2);
    // 창문 (틀 + 십자)
    for (const wx of [x0 + 12, x0 + h.w - 32]) {
      ctx.fillStyle = '#c9a57c'; rr(wx - 2, base - 46, 24, 20, 4);
      ctx.fillStyle = '#fff3a8'; rr(wx, base - 44, 20, 16, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(wx + 2, base - 42, 5, 5);
      ctx.fillStyle = '#c9a57c'; ctx.fillRect(wx + 9, base - 44, 2, 16); ctx.fillRect(wx, base - 37, 20, 2);
      // 화분
      ctx.fillStyle = '#9fd18b'; rr(wx - 2, base - 27, 24, 5, 2);
      ctx.fillStyle = h.roof; circle(wx + 3, base - 28, 2); circle(wx + 10, base - 29, 2); circle(wx + 17, base - 28, 2);
    }
    // --- 추가 디테일 ---
    // 아래 돌 기단
    for (let x = x0 + 2, i = 0; x < x0 + w - 4; i++) {
      const sw = 7 + r() * 6;
      ctx.fillStyle = i % 2 ? '#d8c3a2' : '#cdb693'; rr(x, base - 7, sw - 1, 6, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x + 1, base - 6.5, sw - 3, 1);
      x += sw;
    }
    // 굴뚝 벽돌
    const chTop = roofY(chx) - 20;
    ctx.strokeStyle = 'rgba(120,60,40,0.35)'; ctx.lineWidth = 0.6;
    for (let y = chTop + 7, k = 0; y < chTop + 22; y += 4, k++) {
      ctx.beginPath(); ctx.moveTo(chx - 7, y); ctx.lineTo(chx + 7, y); ctx.stroke();
      const o = k % 2 ? 0 : 3.5;
      for (let x = chx - 7 + o + 3.5; x < chx + 7; x += 7) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 4); ctx.stroke(); }
    }
    // 지붕 처마 물결 장식
    ctx.fillStyle = roof;
    for (let x = x0 - 8; x < x0 + w + 9; x += 6) circle(x + 3, base - wallH + 4.5, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    for (let x = x0 - 8; x < x0 + w + 9; x += 6) { ctx.beginPath(); ctx.arc(x + 3, base - wallH + 4.5, 3, 0.1, Math.PI - 0.1); ctx.fill(); }
    // 지붕 꼭대기 동그란 창
    ctx.fillStyle = '#fbefd9'; circle(0, base - wallH - 16, 6.5);
    ctx.fillStyle = '#c9a57c'; circle(0, base - wallH - 16, 5.5);
    ctx.fillStyle = '#fff3a8'; circle(0, base - wallH - 16, 4.3);
    ctx.fillStyle = '#c9a57c'; ctx.fillRect(-0.6, base - wallH - 20.3, 1.2, 8.6); ctx.fillRect(-4.3, base - wallH - 16.6, 8.6, 1.2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(-2, base - wallH - 18, 1);
    // 문: 나무판 결 + 경첩 + 작은 창
    ctx.strokeStyle = 'rgba(90,50,25,0.35)'; ctx.lineWidth = 0.6;
    for (const x of [-5, 0, 5]) { ctx.beginPath(); ctx.moveTo(x, base - 32); ctx.lineTo(x, base - 1); ctx.stroke(); }
    ctx.fillStyle = '#6e4a32'; rr(-10, base - 26, 3, 2, 0.8); rr(-10, base - 10, 3, 2, 0.8);
    ctx.fillStyle = '#fff3a8'; circle(0, base - 26, 3);
    ctx.fillStyle = 'rgba(140,90,60,0.8)'; ctx.fillRect(-0.4, base - 29, 0.8, 6); ctx.fillRect(-3, base - 26.4, 6, 0.8);
    // 창문 커튼 + 화분 꽃 잎
    for (const wx of [x0 + 12, x0 + w - 32]) {
      ctx.fillStyle = 'rgba(255,170,170,0.55)';
      ctx.beginPath(); ctx.moveTo(wx, base - 44); ctx.quadraticCurveTo(wx + 5, base - 38, wx + 2, base - 28); ctx.lineTo(wx, base - 28); ctx.fill();
      ctx.beginPath(); ctx.moveTo(wx + 20, base - 44); ctx.quadraticCurveTo(wx + 15, base - 38, wx + 18, base - 28); ctx.lineTo(wx + 20, base - 28); ctx.fill();
      ctx.fillStyle = '#7cc068';
      for (const fx of [wx + 1, wx + 6.5, wx + 13.5, wx + 19]) { ctx.beginPath(); ctx.ellipse(fx, base - 28.5, 1.6, 0.9, -0.5, 0, TAU); ctx.fill(); }
      ctx.fillStyle = '#fff'; for (const fx of [wx + 3, wx + 10, wx + 17]) circle(fx, base - 28, 0.7);
    }
    // 벽 담쟁이
    ctx.fillStyle = '#7cc068';
    for (let i = 0; i < 16; i++) {
      const y = base - 8 - i * 2.4 - r() * 1.5, x = x0 + w - 5 + Math.sin(i * 0.9) * 2.5;
      ctx.beginPath(); ctx.ellipse(x, y, 1.8, 1.2, r() * 3, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#9fd18b';
    for (let i = 0; i < 6; i++) circle(x0 + w - 5 + Math.sin(i * 2.1) * 2.5, base - 10 - i * 6, 0.9);
    // 문 옆 작은 꽃밭
    for (let i = 0; i < 5; i++) {
      const fx = 14 + i * 3.4, fy = base + 1 - (i % 2) * 1.5;
      ctx.fillStyle = '#7cc068'; ctx.beginPath(); ctx.ellipse(fx, fy + 1, 2, 1, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = ['#ff9eb5', '#ffd34d', '#b8a6ff'][i % 3]; circle(fx, fy - 1, 1.3);
    }
  }
  function houseLights(h, night) {
    const x0 = h.x - h.w / 2, base = h.y + h.h / 2;
    glow(x0 + 22, base - 36, 30, `rgba(255,200,110,${0.5 * night})`);
    glow(x0 + h.w - 22, base - 36, 30, `rgba(255,200,110,${0.5 * night})`);
  }

  // ================= 좀비 =================
  // 자세(pose): stand 서기 · sit 앉기 · prone 엎드리기 · lie 눕기 · crawl 기어가기 · walk 걷기 · run 뛰기
  // 몸을 다리 / 몸통(엉덩이 기준 회전) / 머리(따로 위치) 세 부분으로 나눠 그린다.
  const NECK = 0.74; // 엉덩이 → 머리 중심 거리 (s 배수)

  function zombiePose(z, s) {
    const w = Math.sin(z.walkAnim);
    const eating = z.eatAnim > 0;
    const breathe = Math.sin(t * 2) * 0.015;
    switch (z.pose) {
      case 'run':
        return { hipY: -0.34 + Math.abs(w) * 0.06, rot: 0.32, headTilt: 0.1, legs: 'run', arms: 'pump', w, shadow: 0.42 };
      case 'walk':
        return { hipY: -0.34 + Math.abs(w) * 0.03, rot: 0.06, headTilt: Math.sin(z.walkAnim * 0.5) * 0.05, legs: 'walk', arms: 'zombie', w, shadow: 0.42 };
      case 'crawl':
        return { hipY: -0.26, rot: 1.05, neck: 0.62, headTilt: -0.15 + Math.sin(z.walkAnim) * 0.06, legs: 'crawl', arms: 'crawl', w, shadow: 0.55 };
      case 'sit':
        return { hipY: -0.16, rot: -0.05 + breathe, headTilt: Math.sin(t * 0.7) * 0.06, legs: 'sit', arms: 'lap', w: 0, shadow: 0.45 };
      case 'prone':
        return { hipY: -0.12, rot: 1.48, neck: 0.62, headDY: -0.12, headTilt: 0.05 + Math.sin(t * 0.8) * 0.05, legs: 'prone', arms: 'chin', w: 0, shadow: 0.7 };
      case 'lie':
        return { hipY: -0.13, rot: -1.5, neck: 0.66, headDY: -0.06, headTilt: -1.25, legs: 'lie', arms: 'belly', w: 0, shadow: 0.7 };
      default:
        return { hipY: -0.34, rot: (eating ? 0.25 : 0) + breathe, headTilt: eating ? 0.1 : 0, legs: 'stand', arms: eating ? 'grab' : 'zombie', w: 0, shadow: 0.42 };
    }
  }

  function drawZombie(z) {
    const s = 30 * (1 + Math.min(z.power, 40) * 0.012);
    const p = zombiePose(z, s);
    const hipY = p.hipY * s;
    shadow(z.x + (p.legs === 'prone' ? -s * 0.1 : 0), z.y, s * p.shadow, s * 0.12);

    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.scale(z.facing, 1);

    drawLegs(p, s, hipY);

    // 몸통 (엉덩이 기준으로 회전)
    ctx.save();
    ctx.translate(0, hipY);
    ctx.rotate(p.rot);
    drawTorso(z, p, s);
    ctx.restore();

    // 머리
    const neck = (p.neck ?? NECK) * s;
    const hx = Math.sin(p.rot) * neck;
    const hy = hipY - Math.cos(p.rot) * neck + (p.headDY || 0) * s;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(p.headTilt);
    drawHead(z, s, p);
    ctx.restore();

    // 엎드렸을 때 턱 괴는 손은 머리 앞에
    if (p.arms === 'chin') {
      ctx.fillStyle = '#9fd18b';
      circle(hx + s * 0.12, hy + s * 0.24, s * 0.08);
      circle(hx - s * 0.08, hy + s * 0.25, s * 0.08);
    }
    ctx.restore();

    // 효과: 잠 / 뛸 때 먼지
    if (z.pose === 'lie' && Math.random() < 0.025) {
      particles.push({ x: z.x + z.facing * hx, y: z.y + hy - s * 0.3, vx: 8, vy: -14, life: 2, kind: 'z' });
    }
    if (z.pose === 'run' && Math.random() < 0.25) {
      particles.push({ x: z.x - z.facing * s * 0.2, y: z.y - 2, vx: -z.facing * (10 + Math.random() * 15), vy: -8 - Math.random() * 8, life: 0.5, kind: 'dust' });
    }
  }

  function limb(x1, y1, x2, y2, w, color) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function limb2(x1, y1, x2, y2, x3, y3, w, color) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke();
  }

  function drawLegs(p, s, hipY) {
    const C = '#5b6c8f', W = s * 0.16, w = p.w;
    const shoe = (x, y) => { ctx.fillStyle = '#7a5640'; ctx.beginPath(); ctx.ellipse(x + W * 0.25, y, W * 0.72, W * 0.48, 0, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.25)'; circle(x + W * 0.4, y - W * 0.15, W * 0.18); };
    const leg = (x1, y1, x2, y2, ww, cc) => { limb(x1, y1, x2, y2, ww, cc); shoe(x2, y2); };
    const leg2 = (x1, y1, x2, y2, x3, y3, ww, cc) => { limb2(x1, y1, x2, y2, x3, y3, ww, cc); ctx.fillStyle = 'rgba(255,255,255,0.18)'; circle(x2, y2, ww * 0.35); shoe(x3, y3); };
    switch (p.legs) {
      case 'walk':
        leg(-s * 0.08, hipY, -s * 0.08 + w * s * 0.14, -Math.max(0, w) * s * 0.06, W, C);
        leg(s * 0.1, hipY, s * 0.1 - w * s * 0.14, -Math.max(0, -w) * s * 0.06, W, C);
        break;
      case 'run': {
        const a = w * s * 0.26;
        leg2(-s * 0.04, hipY, -s * 0.04 + a * 0.6, hipY + s * 0.2, -s * 0.04 + a, -Math.max(0, w) * s * 0.14, W, C);
        leg2(s * 0.08, hipY, s * 0.08 - a * 0.6, hipY + s * 0.2, s * 0.08 - a, -Math.max(0, -w) * s * 0.14, W, C);
        break;
      }
      case 'crawl': {
        // 무릎으로 기기: 엉덩이 → 무릎(바닥) → 발(뒤쪽)
        const k1 = w * s * 0.07, k2 = -k1;
        leg2(-s * 0.04, hipY, -s * 0.02 + k1, -s * 0.03, -s * 0.34 + k1, -s * 0.06, W, C);
        leg2(s * 0.04, hipY, s * 0.06 + k2, -s * 0.03, -s * 0.26 + k2, -s * 0.05, W, C);
        break;
      }
      case 'sit':
        leg2(-s * 0.06, hipY, s * 0.2, hipY + s * 0.02, s * 0.26, -s * 0.03, W, C);
        leg2(s * 0.06, hipY, s * 0.3, hipY + s * 0.03, s * 0.36, -s * 0.03, W, C);
        break;
      case 'prone': {
        const kick = Math.sin(t * 1.6) * s * 0.12;
        leg2(0, hipY, -s * 0.32, -s * 0.07, -s * 0.5, -s * 0.12 - Math.max(0, kick), W, C);
        leg2(0, hipY, -s * 0.34, -s * 0.06, -s * 0.48, -s * 0.12 - Math.max(0, -kick), W, C);
        break;
      }
      case 'lie':
        // 등 대고 누워서 한쪽 무릎 세우기
        leg2(0, hipY, s * 0.22, -s * 0.34, s * 0.42, -s * 0.07, W, C);
        leg(0, hipY, s * 0.5, -s * 0.08, W, C);
        break;
      default:
        leg(-s * 0.08, hipY, -s * 0.08, -s * 0.03, W, C);
        leg(s * 0.1, hipY, s * 0.1, -s * 0.03, W, C);
    }
  }

  // 몸통: 원점 = 엉덩이, 위쪽이 -y
  function drawTorso(z, p, s) {
    const has = (k) => z.traits.includes(k);
    if (has('shell')) {
      ctx.fillStyle = '#e8955a'; circle(-s * 0.3, -s * 0.28, s * 0.22);
      ctx.strokeStyle = '#b8653a'; ctx.lineWidth = s * 0.03;
      ctx.beginPath();
      for (let a = 0; a < 11; a += 0.3) {
        const r = s * (0.19 - a * 0.016);
        ctx.lineTo(-s * 0.3 + Math.cos(a) * r, -s * 0.28 + Math.sin(a) * r);
      }
      ctx.stroke();
    }
    // 뒤쪽 팔
    drawArm(p, s, 1);
    ctx.fillStyle = '#9fd18b';
    rr(-s * 0.28, -s * 0.5, s * 0.56, s * 0.54, s * 0.18);
    // 낡은 셔츠: 아래 끝이 들쭉날쭉
    ctx.fillStyle = '#e6c9a8';
    ctx.beginPath();
    ctx.moveTo(-s * 0.28, -s * 0.24);
    ctx.quadraticCurveTo(-s * 0.28, -s * 0.3, -s * 0.2, -s * 0.3);
    ctx.lineTo(s * 0.2, -s * 0.3); ctx.quadraticCurveTo(s * 0.28, -s * 0.3, s * 0.28, -s * 0.24);
    ctx.lineTo(s * 0.28, -s * 0.02);
    for (let i = 0; i <= 6; i++) ctx.lineTo(s * 0.28 - i * s * 0.0933, i % 2 ? s * 0.03 : -s * 0.03);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(150,120,90,0.18)'; ctx.fillRect(s * 0.12, -s * 0.3, s * 0.16, s * 0.3);
    // 기운 천 조각 + 바느질
    ctx.fillStyle = '#c9d8f0'; rr(-s * 0.18, -s * 0.2, s * 0.13, s * 0.11, s * 0.02);
    ctx.strokeStyle = '#7a6a5a'; ctx.lineWidth = s * 0.012; ctx.setLineDash([s * 0.02, s * 0.02]);
    ctx.strokeRect(-s * 0.17, -s * 0.19, s * 0.11, s * 0.09); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150,120,90,0.35)';
    rr(s * 0.04, -s * 0.16, s * 0.08, s * 0.1, s * 0.03);
    // 목 아래 빛
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; rr(-s * 0.2, -s * 0.47, s * 0.2, s * 0.08, s * 0.04);
    if (has('armor')) {
      ctx.fillStyle = '#6fb35c';
      rr(-s * 0.3, -s * 0.46, s * 0.6, s * 0.38, s * 0.14);
      ctx.fillStyle = '#8cc977';
      circle(0, -s * 0.28, s * 0.08); circle(-s * 0.16, -s * 0.32, s * 0.06); circle(s * 0.16, -s * 0.32, s * 0.06);
    }
    if (has('dots')) {
      ctx.fillStyle = '#ef4b4b';
      circle(-s * 0.15, -s * 0.14, s * 0.045); circle(s * 0.12, -s * 0.08, s * 0.04); circle(-s * 0.02, -s * 0.04, s * 0.035);
    }
    // 앞쪽 팔
    drawArm(p, s, 0);
  }

  function drawArm(p, s, back) {
    const C = back ? '#8cc27a' : '#9fd18b', W = s * 0.12;
    const sy = back ? -s * 0.42 : -s * 0.32; // 어깨 높이
    const sx = s * 0.06;
    const hand = (x, y) => { ctx.fillStyle = back ? '#8cc27a' : '#a9db94'; circle(x, y, W * 0.62); ctx.fillStyle = 'rgba(255,255,255,0.25)'; circle(x - W * 0.15, y - W * 0.2, W * 0.2); };
    const arm = (x1, y1, x2, y2, ww, cc) => { limb(x1, y1, x2, y2, ww, cc); hand(x2, y2); };
    const arm2 = (x1, y1, x2, y2, x3, y3, ww, cc) => { limb2(x1, y1, x2, y2, x3, y3, ww, cc); hand(x3, y3); };
    const sw = Math.sin(t * 1.4) * s * 0.02;
    switch (p.arms) {
      case 'zombie': // 앞으로 쭉
        return arm(sx, sy, sx + s * 0.4, sy + (back ? -1 : 1) * sw + p.w * s * 0.04, W, C);
      case 'grab':
        return arm(sx, sy, sx + s * 0.42, sy - s * 0.1, W, C);
      case 'pump': { // 뛸 때 팔 흔들기
        const a = (back ? -1 : 1) * p.w * s * 0.22;
        return arm2(sx, sy, sx + a * 0.5, sy + s * 0.18, sx + a + s * 0.12, sy + s * 0.08, W, C);
      }
      case 'crawl': { // 몸통이 앞으로 기울어 있으니 '아래(+y)'가 땅 쪽
        const a = (back ? -1 : 1) * p.w * s * 0.1;
        return arm(sx, sy, sx + s * 0.18 + a, sy + s * 0.34, W, C);
      }
      case 'lap':
        return arm2(sx, sy, sx + s * 0.12, sy + s * 0.2, sx + s * 0.3, sy + s * 0.22, W, C);
      case 'chin':
        return arm(sx, sy, sx - s * 0.05, sy + s * 0.25, W, C);
      case 'belly':
        return arm2(sx, sy, sx + s * 0.12, sy + s * 0.08, sx + s * 0.02, sy + s * 0.22, W, C);
    }
  }

  // 머리: 원점 = 머리 중심
  function drawHead(z, s, p) {
    const has = (k) => z.traits.includes(k);
    if (has('spikes')) {
      ctx.fillStyle = '#8a6a4a';
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * 0.75 + i * 0.28;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.15) * s * 0.3, Math.sin(a - 0.15) * s * 0.26);
        ctx.lineTo(Math.cos(a) * s * 0.48, Math.sin(a) * s * 0.42);
        ctx.lineTo(Math.cos(a + 0.15) * s * 0.3, Math.sin(a + 0.15) * s * 0.26);
        ctx.fill();
      }
    }
    if (has('ears')) {
      const flop = p.legs === 'lie' || p.legs === 'prone' ? 0.6 : 0;
      ctx.fillStyle = '#a9db94';
      ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.38, s * 0.07, s * 0.2, -0.2 - flop, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.1, -s * 0.36, s * 0.07, s * 0.2, 0.5 - flop, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f7b6c4';
      ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.38, s * 0.035, s * 0.13, -0.2 - flop, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.1, -s * 0.36, s * 0.035, s * 0.13, 0.5 - flop, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#a9db94';
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.34, s * 0.3, 0, 0, TAU); ctx.fill();
    // 머리 입체감: 아래 그늘 + 위쪽 빛
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, s * 0.34, s * 0.3, 0, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(70,130,60,0.22)'; ctx.beginPath(); ctx.ellipse(-s * 0.04, s * 0.26, s * 0.42, s * 0.2, 0, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.17, s * 0.1, s * 0.05, -0.4, 0, TAU); ctx.fill();
    // 이마 꿰맨 자국
    ctx.strokeStyle = '#6a8a5a'; ctx.lineWidth = s * 0.014; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.14); ctx.lineTo(-s * 0.08, -s * 0.2); ctx.stroke();
    for (let i = 0; i < 3; i++) { const x = -s * 0.2 + i * s * 0.05, y = -s * 0.15 - i * s * 0.022; ctx.beginPath(); ctx.moveTo(x - s * 0.01, y - s * 0.03); ctx.lineTo(x + s * 0.01, y + s * 0.03); ctx.stroke(); }

    // 눈: 누우면 감고, 엎드리면 졸린 눈, 아니면 가끔 깜빡
    const closed = z.pose === 'lie' || (t % 4) < 0.12;
    const sleepy = z.pose === 'prone';
    if (!closed && !sleepy) {
      ctx.fillStyle = '#fff';
      circle(s * 0.12, -s * 0.03, s * 0.09);
      circle(-s * 0.1, -s * 0.02, s * 0.065);
      ctx.fillStyle = '#333';
      const look = z.pose === 'run' ? s * 0.02 : 0;
      circle(s * 0.14 + look, -s * 0.02, s * 0.04);
      circle(-s * 0.09 + look, -s * 0.01, s * 0.03);
      ctx.fillStyle = '#fff';
      circle(s * 0.155 + look, -s * 0.037, s * 0.015);
      circle(-s * 0.08 + look, -s * 0.022, s * 0.011);
    } else {
      ctx.strokeStyle = '#4a5a3a'; ctx.lineWidth = s * 0.025; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(s * 0.12, -s * 0.04, s * 0.06, 0.2, Math.PI - 0.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(-s * 0.1, -s * 0.03, s * 0.045, 0.2, Math.PI - 0.2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,140,150,0.45)';
    circle(s * 0.2, s * 0.08, s * 0.05);
    ctx.strokeStyle = '#4a5a3a';
    ctx.lineWidth = Math.max(1, s * 0.025);
    ctx.beginPath();
    if (z.eatAnim > 0) ctx.ellipse(s * 0.06, s * 0.12, s * 0.07, s * 0.06, 0, 0, TAU);
    else if (z.pose === 'run') ctx.ellipse(s * 0.07, s * 0.11, s * 0.05, s * 0.04, 0, 0, TAU);
    else ctx.arc(s * 0.05, s * 0.07, s * 0.06, 0.2, Math.PI - 0.2);
    ctx.stroke();
    // 삐죽 나온 이빨 하나
    if (z.eatAnim <= 0 && z.pose !== 'run') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(s * 0.07, s * 0.122); ctx.lineTo(s * 0.1, s * 0.118); ctx.lineTo(s * 0.087, s * 0.16); ctx.fill(); }

    if (has('hat')) {
      ctx.fillStyle = '#f2d27a';
      ctx.beginPath(); ctx.ellipse(0, -s * 0.22, s * 0.42, s * 0.08, 0, 0, TAU); ctx.fill();
      rr(-s * 0.22, -s * 0.42, s * 0.44, s * 0.22, s * 0.1);
      ctx.fillStyle = '#e07a6a'; ctx.fillRect(-s * 0.22, -s * 0.28, s * 0.44, s * 0.05);
    } else {
      ctx.strokeStyle = '#5aa04a'; ctx.lineWidth = s * 0.03;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.28); ctx.quadraticCurveTo(s * 0.04, -s * 0.4, 0, -s * 0.45); ctx.stroke();
      ctx.fillStyle = '#7cc56a';
      ctx.beginPath(); ctx.ellipse(s * 0.06, -s * 0.42, s * 0.07, s * 0.035, -0.5 + Math.sin(t * 2) * 0.2, 0, TAU); ctx.fill();
    }
    if (has('feather')) {
      ctx.fillStyle = '#ffd36e';
      ctx.beginPath(); ctx.ellipse(-s * 0.3, -s * 0.05, s * 0.05, s * 0.14, -0.6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff4c2';
      ctx.beginPath(); ctx.ellipse(-s * 0.33, 0, s * 0.04, s * 0.11, -0.9, 0, TAU); ctx.fill();
    }
    if (has('antenna')) {
      const wig = Math.sin(t * 3) * s * 0.03;
      ctx.strokeStyle = '#5a7a3a'; ctx.lineWidth = s * 0.025;
      ctx.beginPath();
      ctx.moveTo(-s * 0.08, -s * 0.26); ctx.quadraticCurveTo(-s * 0.16, -s * 0.45, -s * 0.2 + wig, -s * 0.52);
      ctx.moveTo(s * 0.1, -s * 0.26); ctx.quadraticCurveTo(s * 0.18, -s * 0.45, s * 0.24 - wig, -s * 0.5);
      ctx.stroke();
      ctx.fillStyle = '#ffd36e';
      circle(-s * 0.2 + wig, -s * 0.53, s * 0.045); circle(s * 0.24 - wig, -s * 0.51, s * 0.045);
    }
    if (has('frog')) {
      const fy = -s * (has('hat') ? 0.5 : 0.36) - Math.abs(Math.sin(t * 1.5)) * s * 0.03;
      ctx.fillStyle = '#7cc96a';
      ctx.beginPath(); ctx.ellipse(0, fy, s * 0.14, s * 0.09, 0, 0, TAU); ctx.fill();
      circle(-s * 0.06, fy - s * 0.08, s * 0.05); circle(s * 0.06, fy - s * 0.08, s * 0.05);
      ctx.fillStyle = '#fff'; circle(-s * 0.06, fy - s * 0.09, s * 0.03); circle(s * 0.06, fy - s * 0.09, s * 0.03);
      ctx.fillStyle = '#333'; circle(-s * 0.055, fy - s * 0.09, s * 0.015); circle(s * 0.065, fy - s * 0.09, s * 0.015);
    }
  }

  // ================= 생명체 =================
  // 친구가 머리 위로 번쩍 들고 오는 생명체
  function drawCarried(c, night) {
    ctx.save();
    ctx.translate(c.x, c.y - 16 + Math.sin(c.anim * 10) * 1.2);
    ctx.rotate(Math.sin(c.anim * 6) * 0.12);
    ctx.translate(-c.x, -c.y);
    drawCreature(c, night);
    ctx.restore();
  }

  // 어질어질: 머리 위에 별이 빙글빙글
  function dizzyStars(c) {
    const top = c.y - (c.type === 'villager' ? 34 : TYPES[c.type].radius * 2 + 6);
    for (let i = 0; i < 3; i++) {
      const a = c.anim * 4 + (i * TAU) / 3;
      ctx.fillStyle = '#ffd34d';
      star(c.x + Math.cos(a) * 7, top + Math.sin(a) * 2.5, 2.2);
    }
  }
  function star(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU - Math.PI / 2, rr2 = i % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2);
    }
    ctx.fill();
  }

  function drawCreature(c, night) {
    if (c.mode === 'stunned' && !c.carriedBy && ctx === mainCtx) { drawCreatureBody(c, night); dizzyStars(c); return; }
    drawCreatureBody(c, night);
  }
  function drawCreatureBody(c, night) {
    // 가만히 있을 때 숨쉬듯 살짝 들썩
    if (c.mode !== 'walk' && c.mode !== 'flee' && c.type !== 'spirit') {
      const b = Math.sin(c.anim * 2.6 + c.id) * 0.025;
      ctx.save(); ctx.translate(c.x, c.y); ctx.scale(1 - b * 0.5, 1 + b); ctx.translate(-c.x, -c.y);
      drawCreatureType(c, night);
      ctx.restore();
      return;
    }
    drawCreatureType(c, night);
  }
  function drawCreatureType(c, night) {
    switch (c.type) {
      case 'rabbit': return drawRabbit(c);
      case 'hen': return drawBird(c, 1);
      case 'chick': return drawBird(c, 0.6);
      case 'villager': return drawVillager(c);
      case 'cat': return drawCat(c);
      case 'spirit': return drawSpirit(c, night);
      case 'snail': return drawSnail(c);
      case 'turtle': return drawTurtle(c);
      case 'caterpillar': return drawCaterpillar(c);
      case 'frog': return drawFrog(c);
      case 'hedgehog': return drawHedgehog(c);
      case 'ladybug': return drawLadybug(c);
    }
  }

  // ---- 좀비 친구: 원래 모습에 초록빛 + 반창고 + 멍한 눈 ----
  function drawFriend(c, night) {
    const BW = 90, BH = 80, k = cam.zoom * dpr;
    const pw = Math.ceil(BW * k), ph = Math.ceil(BH * k);
    if (fCanvas.width < pw || fCanvas.height < ph) { fCanvas.width = pw; fCanvas.height = ph; }
    fCtx.setTransform(1, 0, 0, 1, 0, 0);
    fCtx.clearRect(0, 0, fCanvas.width, fCanvas.height);
    // 월드 좌표 (c.x-45, c.y-64) 가 작은 캔버스의 왼쪽 위
    fCtx.setTransform(k, 0, 0, k, -(c.x - BW / 2) * k, -(c.y - 64) * k);
    ctx = fCtx;
    drawCreature(c, night);
    ctx = mainCtx;
    fCtx.setTransform(1, 0, 0, 1, 0, 0);
    fCtx.globalCompositeOperation = 'source-atop';
    fCtx.fillStyle = 'rgba(110, 190, 95, 0.42)';
    fCtx.fillRect(0, 0, pw, ph);
    fCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(fCanvas, 0, 0, pw, ph, c.x - BW / 2, c.y - 64, pw / k, ph / k);

    // 머리 위 작은 반창고 (X자)
    const def = TYPES[c.type];
    const top = c.y - (c.type === 'villager' ? 40 : def.radius * 2 + 8) + Math.sin(c.anim * 2) * 0.8;
    ctx.save(); ctx.translate(c.x + c.facing * 2, top);
    ctx.fillStyle = '#f3d9b1';
    ctx.rotate(0.6); rr(-4, -1.3, 8, 2.6, 1.2);
    ctx.rotate(-1.2); rr(-4, -1.3, 8, 2.6, 1.2);
    ctx.restore();
    // 같이 자면 zzz, 가끔 초록 하트
    if (c.mode === 'sleep' && Math.random() < 0.008) particles.push({ x: c.x, y: top - 4, vx: 6, vy: -12, life: 1.6, kind: 'z' });
    if (c.mode === 'sit' && Math.random() < 0.003) particles.push({ x: c.x, y: top - 4, vx: 0, vy: -14, life: 1.3, kind: 'heart' });
  }

  // ---- 공통 디테일: 반짝이는 눈, 깜빡임, 볼터치 ----
  const blinking = (c) => ((c.anim + c.id * 1.37) % 3.7) < 0.13 || c.mode === 'sleep';
  function eye(c, x, y, r, opts = {}) {
    if (blinking(c) || opts.closed) {
      ctx.strokeStyle = '#333'; ctx.lineWidth = Math.max(0.6, r * 0.7); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, y - r * 0.2, r, 0.3, Math.PI - 0.3); ctx.stroke();
      return;
    }
    if (opts.white) { ctx.fillStyle = '#fff'; circle(x, y, r * 1.9); }
    ctx.fillStyle = opts.color || '#2e2a28'; circle(x + (opts.look || 0), y, r);
    ctx.fillStyle = '#fff'; circle(x + (opts.look || 0) + r * 0.35, y - r * 0.4, Math.max(0.35, r * 0.38));
  }
  const blush = (x, y, r, a = 0.5) => { ctx.fillStyle = `rgba(255,140,155,${a})`; circle(x, y, r); };
  // 아래쪽 그늘 (몸통 원 안쪽 아래에 반달)
  function belly(x, y, rx, ry, col) {
    // 잘라내기(clip) 없이 아래쪽 반달만 칠한다 (가볍게)
    ctx.fillStyle = col; ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.ellipse(x, y + ry * 0.05, rx * 0.95, ry * 0.55, 0, 0.88 * Math.PI, 0.12 * Math.PI, true);
    ctx.fill();
  }
  const RABBIT_FUR = [['#fbf7f2', '#e9e1d8'], ['#fbf7f2', '#e9e1d8'], ['#d9cfc7', '#bfb3aa'], ['#e8cfae', '#cfb08a']];

  // ---- 느린 친구들 ----
  function drawSnail(c) {
    const crawl = c.mode === 'walk' ? Math.sin(c.anim * 3) * 0.6 : 0;
    shadow(c.x, c.y, 8, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#f3dfb0';
    rr(-7, -4, 16 + crawl, 4.5, 2.2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; rr(-4, -3.6, 11 + crawl, 1.2, 0.6);
    ctx.strokeStyle = '#ead29c'; ctx.lineWidth = 1.2;
    const wig = Math.sin(c.anim * 2) * 0.6;
    ctx.beginPath(); ctx.moveTo(7, -3); ctx.lineTo(8.5 + wig, -9); ctx.moveTo(9, -3); ctx.lineTo(11.5 - wig, -8); ctx.stroke();
    ctx.fillStyle = '#ead29c'; circle(8.5 + wig, -9, 1.5); circle(11.5 - wig, -8, 1.5);
    eye(c, 8.6 + wig, -9, 0.8); eye(c, 11.6 - wig, -8, 0.8);
    blush(10, -4.5, 0.9, 0.55);
    stamp(sprite('snailShell', 18, 18, 10, 17, paintSnailShell), 0, 0);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function paintSnailShell() {
    const g = ctx.createRadialGradient(-3, -11, 0.5, -1, -8, 7.5);
    g.addColorStop(0, '#ffc08a'); g.addColorStop(0.6, '#e8955a'); g.addColorStop(1, '#c97340');
    ctx.fillStyle = g; circle(-1, -8, 6.6);
    // 소용돌이: 두께가 바뀌는 띠
    ctx.lineCap = 'round';
    for (const [col, w, off] of [['#b8653a', 1.4, 0], ['rgba(255,215,170,0.7)', 0.6, -0.5]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
      for (let a = 0; a < 11; a += 0.2) { const r = 5.5 - a * 0.45 + off * 0.3; ctx.lineTo(-1 + Math.cos(a) * r, -8 + Math.sin(a) * r + off * 0.3); }
      ctx.stroke();
    }
    // 성장선
    ctx.strokeStyle = 'rgba(150,80,40,0.35)'; ctx.lineWidth = 0.4;
    for (let a = 0.3; a < 6; a += 0.55) {
      const r1 = 5.5 - a * 0.45, r2 = 6.4;
      ctx.beginPath(); ctx.moveTo(-1 + Math.cos(a) * r1, -8 + Math.sin(a) * r1); ctx.lineTo(-1 + Math.cos(a) * r2, -8 + Math.sin(a) * r2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(-3.5, -11.5, 1.3);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; circle(-5.3, -9.5, 0.6);
  }

  function drawTurtle(c) {
    const hide = c.mode === 'hide';
    const walk = c.mode === 'walk' ? Math.sin(c.anim * 5) : 0;
    shadow(c.x, c.y, 12, 4);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    if (!hide) {
      ctx.fillStyle = '#a6d68a';
      circle(-7 + walk, -2, 2.6); circle(6 - walk, -2, 2.6);
      ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(-14, -3); ctx.lineTo(-10, -2); ctx.fill();
      circle(11, -6, 4);
      ctx.fillStyle = '#8fc277'; circle(11, -4.5, 2.6);
      eye(c, 12.3, -7, 0.95);
      ctx.strokeStyle = '#4a6a3a'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(13, -5, 1.2, 0.2, Math.PI * 0.7); ctx.stroke();
      blush(13.4, -5.3, 0.9);
    } else if (Math.random() < 0.01) particles.push({ x: c.x, y: c.y - 16, vx: 0, vy: -10, life: 1, kind: 'text', text: '…', color: '#5c9a4c', size: 9 });
    stamp(sprite('turtleShell', 28, 16, 14, 15, paintTurtleShell), 0, 0);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function paintTurtleShell() {
    ctx.fillStyle = '#5c9a4c';
    ctx.beginPath(); ctx.ellipse(0, -5.5, 11.4, 8.4, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#6fb35c';
    ctx.beginPath(); ctx.ellipse(0, -6, 11, 8, 0, Math.PI, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, -6, 11, 8, 0, Math.PI, TAU); ctx.clip();
    const g = ctx.createRadialGradient(-3, -12, 1, 0, -6, 12);
    g.addColorStop(0, 'rgba(220,255,190,0.35)'); g.addColorStop(1, 'rgba(40,90,40,0.15)');
    ctx.fillStyle = g; ctx.fillRect(-12, -15, 24, 10);
    const hex = (x, y, r) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * 1.047 + 0.52; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.75); } ctx.closePath(); };
    // 가장자리 작은 판 + 가운데 큰 판 (나이테 결 포함)
    for (const [x, y, R] of [[-9, -7, 2.2], [9, -7, 2.2], [-3.3, -6.3, 1.8], [3.3, -6.3, 1.8], [0, -10, 3.3], [-6.5, -8.5, 2.5], [6.5, -8.5, 2.5]]) {
      hex(x, y, R); ctx.fillStyle = '#8cc977'; ctx.fill();
      ctx.strokeStyle = '#4f8f42'; ctx.lineWidth = 0.8; ctx.stroke();
      hex(x, y, R * 0.6); ctx.strokeStyle = 'rgba(79,143,66,0.45)'; ctx.lineWidth = 0.4; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; circle(x - R * 0.35, y - R * 0.3, R * 0.25);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-3, -12, 4, 1.6, -0.3, 0, TAU); ctx.fill();
    ctx.restore();
    // 테두리 띠 + 무늬
    ctx.fillStyle = '#5c9a4c'; rr(-11.5, -6.5, 23, 3.2, 1.6);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; rr(-11.5, -4.6, 23, 1.3, 0.6);
    ctx.fillStyle = '#e9d58a'; for (let x = -9; x <= 8; x += 4.2) circle(x, -5, 0.75);
    ctx.strokeStyle = 'rgba(40,80,35,0.4)'; ctx.lineWidth = 0.4;
    for (let x = -7; x <= 7; x += 4.2) { ctx.beginPath(); ctx.moveTo(x, -6.4); ctx.lineTo(x, -3.5); ctx.stroke(); }
  }

  function drawCaterpillar(c) {
    fade(c);
    if (c.mode === 'cocoon') {
      const wob = Math.sin(c.anim * 4) * 0.15;
      shadow(c.x, c.y, 5, 2);
      ctx.save(); ctx.translate(c.x, c.y - 7); ctx.rotate(wob);
      ctx.strokeStyle = '#cdb87f'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, -13); ctx.stroke();
      ctx.fillStyle = '#e9d8a6';
      ctx.beginPath(); ctx.ellipse(0, 0, 4, 8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(160,130,70,0.25)';
      ctx.beginPath(); ctx.ellipse(1.5, 1, 2.5, 7, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#cdb87f'; ctx.lineWidth = 0.8;
      for (let i = -4; i <= 4; i += 3) { ctx.beginPath(); ctx.moveTo(-3.5, i); ctx.lineTo(3.5, i + 1); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; circle(-1.5, -4, 1);
      ctx.restore(); ctx.globalAlpha = 1;
      return;
    }
    shadow(c.x, c.y, 8, 2);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    for (let i = 0; i < 5; i++) {
      const wig = c.mode === 'walk' ? Math.sin(c.anim * 6 - i) * 1.2 : 0;
      const x = -8 + i * 3.6, y = -3 - Math.max(0, wig);
      ctx.fillStyle = '#5a7a3a'; circle(x - 1, -0.3, 0.6); circle(x + 1, -0.3, 0.6);
      ctx.fillStyle = i % 2 ? '#8fd16a' : '#a6e07e';
      circle(x, y, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; circle(x - 0.8, y - 1.3, 0.9);
      if (i % 2 === 0) { ctx.fillStyle = '#ffd36e'; circle(x, y - 2.4, 0.7); }
    }
    ctx.fillStyle = '#b8e88f'; circle(10, -4, 3.6);
    ctx.strokeStyle = '#5a7a3a'; ctx.lineWidth = 0.8;
    const aw = Math.sin(c.anim * 3) * 0.8;
    ctx.beginPath(); ctx.moveTo(9, -7); ctx.lineTo(8 - aw, -10.5); ctx.moveTo(11, -7); ctx.lineTo(12 + aw, -10.5); ctx.stroke();
    ctx.fillStyle = '#ffd36e'; circle(8 - aw, -10.8, 0.9); circle(12 + aw, -10.8, 0.9);
    eye(c, 11.2, -4.6, 0.75);
    ctx.strokeStyle = '#4a6a3a'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(11.6, -3.2, 0.9, 0.2, Math.PI - 0.4); ctx.stroke();
    blush(12.6, -3.3, 0.8, 0.6);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawFrog(c) {
    const hop = c.hopping > 0 ? Math.sin(((0.35 - c.hopping) / 0.35) * Math.PI) * 10 : 0;
    const throat = c.hopping > 0 ? 0 : Math.max(0, Math.sin(c.anim * 3)) * 1.2;
    shadow(c.x, c.y, 7, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#6ab85a';
    if (hop > 1) { ctx.beginPath(); ctx.ellipse(-6, 0, 4, 1.5, 0.4, 0, TAU); ctx.fill(); }
    else { ctx.beginPath(); ctx.ellipse(-5, -1.5, 3.5, 2.2, 0, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(5, -1.5, 3.5, 2.2, 0, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#7cc96a';
    ctx.beginPath(); ctx.ellipse(0, -5, 8, 5.5, 0, 0, TAU); ctx.fill();
    belly(0, -5, 8, 5.5, 'rgba(60,130,60,0.25)');
    ctx.fillStyle = '#5aa64c'; circle(-3, -7, 1.1); circle(2, -6, 0.8); circle(-5.5, -4.5, 0.7);
    ctx.fillStyle = '#7cc96a';
    circle(-3, -10, 3.2); circle(3, -10, 3.2);
    ctx.fillStyle = '#fff'; circle(-3, -10.5, 2.1); circle(3, -10.5, 2.1);
    eye(c, -2.6, -10.5, 1.05); eye(c, 3.4, -10.5, 1.05);
    ctx.fillStyle = '#c9eeb9'; ctx.beginPath(); ctx.ellipse(0, -3.3 + throat * 0.2, 5 + throat, 2.5 + throat, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#3f7a35'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(0, -7, 3.5, 0.35, Math.PI - 0.35); ctx.stroke();
    blush(-5, -6, 1.2, 0.6); blush(5, -6, 1.2, 0.6);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawHedgehog(c) {
    shadow(c.x, c.y, 9, 3);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.lineCap = 'round';
    if (c.mode === 'ball') {
      stamp(sprite('hogBall', 24, 24, 12, 19, paintHogBall), 0, 0);
    } else {
      const walk = c.mode === 'walk' ? Math.sin(c.anim * 8) * 0.8 : 0;
      ctx.fillStyle = '#c9a882'; circle(-5 + walk, -0.8, 1.5); circle(4 - walk, -0.8, 1.5);
      ctx.fillStyle = '#e9cfa8';
      ctx.beginPath(); ctx.ellipse(6, -4, 5, 3.6, 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d9bb90'; ctx.beginPath(); ctx.ellipse(5.5, -2.6, 3.8, 1.6, 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#333'; circle(10.8, -3.4, 1.15);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(10.5, -3.8, 0.4);
      eye(c, 7, -5.2, 0.85);
      blush(8, -3, 1, 0.55);
      ctx.fillStyle = '#d9bb90'; circle(3.5, -7.8, 1.4);
      stamp(sprite('hogBack', 28, 18, 16, 16, paintHogBack), 0, walk);
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // 가시 한 개: 뿌리 진한색 → 끝 밝은색
  function spine(x1, y1, x2, y2, w) {
    ctx.lineWidth = w;
    ctx.strokeStyle = '#5e4330'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (x2 - x1) * 0.6, y1 + (y2 - y1) * 0.6); ctx.stroke();
    ctx.strokeStyle = '#c9a882'; ctx.lineWidth = w * 0.75;
    ctx.beginPath(); ctx.moveTo(x1 + (x2 - x1) * 0.6, y1 + (y2 - y1) * 0.6); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function paintHogBack() {
    const r = mulberry32(808);
    ctx.lineCap = 'round';
    ctx.fillStyle = '#7a5a3e';
    ctx.beginPath(); ctx.ellipse(-2, -5, 9, 6.5, 0, Math.PI, TAU); ctx.fill();
    // 뒤쪽 줄부터 앞쪽 줄까지 3겹
    for (const [k, off, w] of [[1, 0, 1.3], [0.86, 0.12, 1.2], [0.7, 0.24, 1.1]]) {
      for (let a = Math.PI + off; a <= TAU - 0.05; a += 0.24) {
        const j = (r() - 0.5) * 0.12;
        spine(-2 + Math.cos(a + j) * 6.5 * k, -5 + Math.sin(a + j) * 4.6 * k,
          -2 + Math.cos(a + j) * 11 * k, -5 + Math.sin(a + j) * 8.6 * k, w);
      }
    }
    ctx.fillStyle = 'rgba(255,240,220,0.3)'; ctx.beginPath(); ctx.ellipse(-4, -9, 3.5, 1.4, -0.2, 0, TAU); ctx.fill();
    // 등에 붙은 낙엽 하나
    ctx.fillStyle = '#e8a64a'; ctx.save(); ctx.translate(-5, -11); ctx.rotate(-0.5);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(2, -1.6, 4, 0); ctx.quadraticCurveTo(2, 1.6, 0, 0); ctx.fill();
    ctx.strokeStyle = '#b8762a'; ctx.lineWidth = 0.3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(4, 0); ctx.stroke();
    ctx.restore();
  }
  function paintHogBall() {
    const r = mulberry32(909);
    ctx.lineCap = 'round';
    ctx.fillStyle = '#7a5a3e'; circle(0, -7, 7.2);
    for (const [r1, r2, off, w] of [[6, 10, 0, 1.3], [5, 8.6, 0.13, 1.2], [4, 7, 0.06, 1.1]]) {
      for (let a = off; a < TAU; a += 0.26) {
        const j = (r() - 0.5) * 0.1;
        spine(Math.cos(a + j) * r1, -7 + Math.sin(a + j) * r1, Math.cos(a + j) * r2, -7 + Math.sin(a + j) * r2, w);
      }
    }
    ctx.fillStyle = 'rgba(255,240,220,0.35)'; circle(-2.5, -10, 2);
    ctx.fillStyle = '#e9cfa8'; ctx.beginPath(); ctx.ellipse(3, -2.2, 2.2, 1.3, 0.3, 0, TAU); ctx.fill(); // 살짝 보이는 코
    ctx.fillStyle = '#333'; circle(4.6, -2.4, 0.7);
  }

  function drawLadybug(c) {
    shadow(c.x, c.y, 4, 1.5);
    fade(c);
    const leg = c.mode === 'walk' ? Math.sin(c.anim * 14) * 0.8 : 0;
    ctx.save(); ctx.translate(c.x, c.y - 2); ctx.scale(c.facing, 1);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 0.6;
    for (const x of [-2, 0.5, 3]) { ctx.beginPath(); ctx.moveTo(x, 1.5); ctx.lineTo(x - 1 + leg, 3.5); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(5, -2); ctx.lineTo(6.5, -4.5); ctx.moveTo(4.5, -2.5); ctx.lineTo(5, -5); ctx.stroke();
    ctx.fillStyle = '#333'; circle(3.8, -1, 2.2);
    ctx.fillStyle = '#fff'; circle(4.6, -2, 0.6); circle(4.6, 0, 0.5);
    ctx.fillStyle = '#ef4b4b'; circle(0, -1, 4);
    belly(0, -1, 4, 4, 'rgba(150,20,20,0.25)');
    ctx.strokeStyle = '#333'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(1.5, -5); ctx.lineTo(1.5, 3); ctx.stroke();
    ctx.fillStyle = '#333'; circle(-1.5, -2.5, 0.9); circle(-1.6, 1, 0.8); circle(3, -3, 0.6); circle(-3.3, -0.6, 0.6);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(-1.2, -3.8, 0.9);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // 달팽이 반짝이 자국
  const trails = new Map();
  function drawSnailTrails(state, view) {
    const alive = new Set();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.5;
    for (const c of state.creatures) {
      if (c.type !== 'snail') continue;
      alive.add(c.id);
      let tr = trails.get(c.id);
      if (!tr) { tr = []; trails.set(c.id, tr); }
      // 몸 위치 기준으로 3칸 이상 움직였을 때만 점 추가 (방향만 바뀔 땐 추가 안 함)
      const lastP = tr[tr.length - 1];
      if (!c.friend && !c.carriedBy && (!lastP || Math.hypot(lastP.cx - c.x, lastP.cy - c.y) > 3)) {
        if (lastP && Math.hypot(lastP.cx - c.x, lastP.cy - c.y) > 40) tr.length = 0; // 순간이동하면 새로 시작
        tr.push({ x: c.x - c.facing * 6, y: c.y - 1, cx: c.x, cy: c.y, t });
      }
      while (tr.length && (t - tr[0].t > 12 || tr.length > 120)) tr.shift();
      if (tr.length < 2 || c.x < view.x0 - 60 || c.x > view.x1 + 60 || c.y < view.y0 - 60 || c.y > view.y1 + 60) continue;
      // 오래된 정도에 따라 4묶음으로 나눠 한 번에 그린다
      for (let band = 0; band < 4; band++) {
        ctx.strokeStyle = `rgba(235,245,255,${(1 - band / 4) * 0.55})`;
        ctx.beginPath();
        let open = false;
        for (let i = 1; i < tr.length; i++) {
          const age = (t - tr[i].t) / 12;
          if (Math.min(3, Math.floor(age * 4)) !== band) { open = false; continue; }
          if (!open) { ctx.moveTo(tr[i - 1].x, tr[i - 1].y); open = true; }
          ctx.lineTo(tr[i].x, tr[i].y);
        }
        ctx.stroke();
      }
    }
    for (const id of trails.keys()) if (!alive.has(id)) trails.delete(id);
  }
  const fade = (c) => { ctx.globalAlpha = c.dying != null ? Math.max(0, 1 - c.dying / 0.8) : 1; };

  function drawRabbit(c) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 12)) * 6 : 0;
    const [fur, shade] = RABBIT_FUR[c.id % RABBIT_FUR.length];
    const twitch = c.mode === 'idle' && Math.sin(c.anim * 1.3 + c.id) > 0.9 ? 0.25 : 0;
    shadow(c.x, c.y, 8, 3);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    // 뒷귀
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.ellipse(4, -20, 1.8, 5.5, -0.15 - twitch, 0, TAU); ctx.fill();
    ctx.fillStyle = fur;
    ctx.beginPath(); ctx.ellipse(0, -6, 8, 6, 0, 0, TAU); ctx.fill();
    belly(0, -6, 8, 6, shade);
    // 꼬리 몽실
    ctx.fillStyle = '#fff'; circle(-7.5, -7, 2.6); circle(-6.5, -5.5, 2.2);
    // 발
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(-3, -0.8, 3.5, 1.6, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(4.5, -1, 1.8, 1.5, 0, 0, TAU); ctx.fill();
    // 머리
    circle(6, -11, 5.5);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; circle(4.5, -13.5, 2);
    ctx.fillStyle = fur;
    ctx.beginPath(); ctx.ellipse(8, -19, 1.9, 5.8, 0.25 + twitch, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f7b6c4';
    ctx.beginPath(); ctx.ellipse(8.1, -19, 0.85, 4, 0.25 + twitch, 0, TAU); ctx.fill();
    eye(c, 8, -12, 1.15);
    ctx.fillStyle = '#f39ab0'; circle(10.8, -10.2, 0.85);
    blush(8.5, -9.3, 1.2, 0.45);
    ctx.strokeStyle = 'rgba(120,100,100,0.45)'; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(10.5, -9.8); ctx.lineTo(13.5, -10.6); ctx.moveTo(10.5, -9.4); ctx.lineTo(13.5, -9); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawBird(c, k) {
    const moving = c.mode === 'walk' || c.mode === 'flee';
    const bob = moving ? Math.sin(c.anim * 14) * 1.2 : Math.sin(c.anim * 3) * 0.4;
    const peck = c.mode === 'idle' && Math.sin(c.anim * 2) > 0.85 ? 3 : 0;
    const chick = k < 1;
    const body = chick ? '#ffe066' : '#fffaf0', shade = chick ? '#f5cf3d' : '#ece2d0';
    shadow(c.x, c.y, 8 * k, 3 * k);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y + bob); ctx.scale(c.facing * k, k);
    // 다리
    const st = moving ? Math.sin(c.anim * 14) * 1.5 : 0;
    ctx.strokeStyle = '#f0a040'; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-2, -2); ctx.lineTo(-2 + st, 0.5 - bob); ctx.moveTo(2, -2); ctx.lineTo(2 - st, 0.5 - bob); ctx.stroke();
    // 꼬리깃
    if (!chick) {
      ctx.fillStyle = '#f2e8d6';
      ctx.beginPath(); ctx.moveTo(-7, -10); ctx.quadraticCurveTo(-13, -17, -11, -9); ctx.quadraticCurveTo(-13, -12, -8, -6); ctx.fill();
    }
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, -8, 9, 7.5, 0, 0, TAU); ctx.fill();
    belly(0, -8, 9, 7.5, shade);
    circle(6, -14 + peck, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(4.5, -16 + peck, 1.6);
    if (chick) { ctx.strokeStyle = '#f5cf3d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(5, -18.5 + peck); ctx.quadraticCurveTo(4, -22 + peck, 6.5, -21.5 + peck); ctx.stroke(); }
    ctx.fillStyle = '#ffa94d';
    ctx.beginPath(); ctx.moveTo(10, -14 + peck); ctx.lineTo(14, -12.5 + peck); ctx.lineTo(10, -11.5 + peck); ctx.fill();
    if (!chick) {
      ctx.fillStyle = '#ef5a5a'; circle(4.5, -19 + peck, 2.2); circle(7, -19.3 + peck, 2); circle(9, -18 + peck, 1.6);
      ctx.beginPath(); ctx.ellipse(10.3, -10.3 + peck, 1.1, 1.8, 0, 0, TAU); ctx.fill();
    }
    eye(c, 7.6, -15 + peck, 1.05);
    blush(8.5, -12.6 + peck, 1.1, 0.5);
    // 날개 (깃털 결)
    const flap = c.mode === 'flee' ? Math.sin(c.anim * 30) * 0.5 : 0;
    ctx.save(); ctx.translate(-2, -9); ctx.rotate(0.3 - flap);
    stamp(sprite('birdWing' + chick, 12, 9, 6, 4.5, () => paintBirdWing(chick)), 0, 0);
    ctx.restore();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function paintBirdWing(chick) {
    const base = chick ? '#f5cf3d' : '#ece2d0', dark = chick ? '#e0b52a' : '#d6c8b0', light = chick ? '#ffe680' : '#fffaf0';
    ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(0, 0.3, 5, 3.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = base; ctx.beginPath(); ctx.ellipse(0, 0, 4.8, 3.2, 0, 0, TAU); ctx.fill();
    if (chick) {
      // 병아리: 보송한 솜털 가장자리
      ctx.fillStyle = base;
      for (let i = 0; i < 6; i++) circle(-3.5 + i * 1.3, 2.6 + (i % 2) * 0.4, 0.9);
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(-0.5, -1.2, 2.6, 1.1, 0, 0, TAU); ctx.fill();
      return;
    }
    // 닭: 깃털 3줄 (비늘처럼 겹침)
    for (const [y, n, len] of [[2, 4, 2.6], [0.5, 4, 2.4], [-1, 3, 2.2]]) {
      for (let i = 0; i < n; i++) {
        const x = -3.6 + i * (6.5 / n) + (y < 0 ? 0.8 : 0);
        ctx.fillStyle = y > 1 ? dark : base;
        ctx.beginPath(); ctx.ellipse(x, y, len * 0.6, len * 0.42, 0.25, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(160,140,110,0.55)'; ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.ellipse(x, y, len * 0.6, len * 0.42, 0.25, 0.2, Math.PI - 0.2); ctx.stroke();
      }
    }
    ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(0.5, -1.8, 3, 1, 0, 0, TAU); ctx.fill();
  }

  const HAIR = ['#6b4a3a', '#3d2e26', '#a8683a', '#d9a35a', '#555'];
  function drawVillager(c) {
    const s = 26;
    const flee = c.mode === 'flee';
    const walk = c.mode === 'walk' || flee ? Math.sin(c.anim * (flee ? 16 : 9)) : 0;
    const style = c.id % 4, hair = HAIR[c.id % HAIR.length];
    shadow(c.x, c.y, 10, 3.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    // 다리 + 신발
    ctx.fillStyle = '#4b4b6b';
    rr(-5 + walk * 2, -11, 4.5, 11, 2);
    rr(1 - walk * 2, -11, 4.5, 11, 2);
    ctx.fillStyle = '#5a3f30';
    rr(-5.5 + walk * 2, -2, 6, 2.8, 1.4); rr(0.5 - walk * 2, -2, 6, 2.8, 1.4);
    // 뒤쪽 팔
    ctx.strokeStyle = c.color; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    const arm = flee ? -0.9 : walk * 0.5;
    ctx.save(); ctx.globalAlpha *= 0.85;
    ctx.beginPath(); ctx.moveTo(-2, -s * 0.82); ctx.lineTo(-2 - Math.sin(arm) * 7, -s * 0.82 + Math.cos(arm) * 7); ctx.stroke();
    ctx.restore();
    // 몸통
    const pat = (c.id >> 2) % 3;
    stamp(sprite('shirt' + c.color + style + pat, 16, 16, 8, 24, () => paintShirt(c.color, style, pat)), 0, 0);
    // 앞쪽 팔 + 손
    ctx.strokeStyle = c.color;
    const ax = 3 + Math.sin(-arm) * 7, ay = -s * 0.82 + Math.cos(arm) * 7;
    ctx.beginPath(); ctx.moveTo(3, -s * 0.82); ctx.lineTo(ax, flee ? -s * 1.05 : ay); ctx.stroke();
    ctx.fillStyle = '#ffe0c2'; circle(ax, flee ? -s * 1.05 : ay, 1.8);
    // 머리
    ctx.fillStyle = '#ffe0c2';
    circle(0, -s * 1.1, 7);
    ctx.fillStyle = 'rgba(230,170,140,0.35)'; ctx.beginPath(); ctx.arc(0, -s * 1.1, 7, 0.3, Math.PI - 0.3); ctx.fill();
    circle(-6.5, -s * 1.08, 1.6); // 귀
    ctx.fillStyle = hair;
    if (style === 2) { // 땋은 머리
      ctx.beginPath(); ctx.arc(0, -s * 1.13, 7.3, Math.PI * 1.05, TAU * 0.99); ctx.fill();
      circle(-7, -s * 0.98, 2.2); circle(-7.5, -s * 0.86, 1.8);
    } else if (style === 3) { // 곱슬
      for (let i = 0; i < 6; i++) circle(-6 + i * 2.4, -s * 1.31 + Math.abs(i - 2.5) * 0.6, 2.4);
    } else {
      ctx.beginPath(); ctx.arc(0, -s * 1.13, 7.3, Math.PI * 1.05, TAU * 0.99); ctx.fill();
      ctx.beginPath(); ctx.moveTo(1, -s * 1.27); ctx.quadraticCurveTo(5, -s * 1.22, 7, -s * 1.12); ctx.lineTo(7.3, -s * 1.2); ctx.fill();
    }
    if (style === 0) { // 밀짚모자
      ctx.fillStyle = '#f2d27a';
      ctx.beginPath(); ctx.ellipse(0, -s * 1.27, 10, 2.4, 0, 0, TAU); ctx.fill();
      rr(-5.5, -s * 1.45, 11, 5.5, 2.5);
      ctx.fillStyle = '#e07a6a'; ctx.fillRect(-5.5, -s * 1.31, 11, 1.4);
    }
    // 얼굴
    if (flee) {
      ctx.fillStyle = '#fff'; circle(3.2, -s * 1.12, 1.7); ctx.fillStyle = '#333'; circle(3.4, -s * 1.12, 0.8);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(3.8, -s * 1.03, 1.1, 1.4, 0, 0, TAU); ctx.stroke();
    } else {
      eye(c, 3, -s * 1.11, 0.95); eye(c, -0.5, -s * 1.11, 0.85);
      ctx.strokeStyle = '#a0604a'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(2.2, -s * 1.05, 1.2, 0.3, Math.PI - 0.3); ctx.stroke();
      blush(4.5, -s * 1.06, 1.4);
    }
    ctx.restore(); ctx.globalAlpha = 1;
    if (flee && Math.random() < 0.03) particles.push({ x: c.x, y: c.y - 38, vx: 0, vy: -20, life: 0.8, kind: 'text', text: '!', color: '#e05a5a', size: 14 });
  }

  // 마을 사람 윗옷 (몸통 위치: y -23.4 ~ -9.4)
  function paintShirt(col, style, pat) {
    const top = -23.4;
    ctx.fillStyle = col; rr(-7, top, 14, 14, 5);
    ctx.save(); ctx.beginPath(); ctx.roundRect(-7, top, 14, 14, 5); ctx.clip();
    if (pat === 1) { // 가로 줄무늬
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      for (let y = top + 2; y < top + 14; y += 3.2) ctx.fillRect(-7, y, 14, 1.3);
    } else if (pat === 2) { // 땡땡이
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let y = top + 2.5, k = 0; y < top + 14; y += 3, k++) for (let x = -6 + (k % 2) * 1.5; x < 7; x += 3) circle(x, y, 0.55);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fillRect(1, top, 6, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(-6, top, 2.5, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(-7, top + 12.4, 14, 1.6); // 밑단
    ctx.restore();
    // 옷깃
    ctx.fillStyle = '#fff6e6';
    ctx.beginPath(); ctx.moveTo(-3.5, top + 0.5); ctx.lineTo(0, top + 3); ctx.lineTo(-1, top + 0.3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(3.5, top + 0.5); ctx.lineTo(0, top + 3); ctx.lineTo(1, top + 0.3); ctx.fill();
    if (style === 1) { // 앞치마 + 주머니 + 레이스
      ctx.fillStyle = '#fff6e6'; rr(-5, top + 4.7, 10, 9, 3);
      ctx.fillStyle = 'rgba(200,170,140,0.35)'; rr(-2.5, top + 8.5, 5, 3, 1);
      ctx.fillStyle = '#fff6e6'; for (let x = -4.5; x <= 4.5; x += 1.5) circle(x, top + 13.7, 0.7);
      ctx.strokeStyle = 'rgba(220,120,120,0.6)'; ctx.lineWidth = 0.4; ctx.beginPath(); ctx.moveTo(-4.5, top + 5.6); ctx.lineTo(4.5, top + 5.6); ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; circle(0, top + 3.1, 0.75); circle(0, top + 6.2, 0.75); circle(0, top + 9.3, 0.75);
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; rr(2, top + 6, 3.4, 3, 0.8); // 주머니
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(2, top + 6, 3.4, 0.6);
    }
  }

  function drawCat(c) {
    shadow(c.x, c.y, 9, 3);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    const tail = Math.sin(c.anim * 2.5) * 0.4;
    const striped = c.fur === '#f4a259' || c.fur === '#9a9a9a';
    const stripe = c.fur === '#f4a259' ? 'rgba(200,110,40,0.6)' : 'rgba(80,80,80,0.5)';
    const chest = c.fur === '#3d3d3d' ? '#f5f0e6' : '#fff8ee';
    ctx.fillStyle = c.fur;
    if (c.mode === 'sleep') {
      ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, TAU); ctx.fill();
      if (striped) { ctx.strokeStyle = stripe; ctx.lineWidth = 1.2; for (const x of [-5, -2, 1]) { ctx.beginPath(); ctx.moveTo(x, -10.5); ctx.lineTo(x + 1, -7); ctx.stroke(); } }
      ctx.fillStyle = c.fur; circle(7, -6, 5);
      ctx.beginPath(); ctx.moveTo(4, -9); ctx.lineTo(5, -13); ctx.lineTo(7.5, -10); ctx.fill();
      ctx.beginPath(); ctx.moveTo(8, -10.5); ctx.lineTo(10.5, -13); ctx.lineTo(11, -8.5); ctx.fill();
      ctx.save(); ctx.translate(-8, -3); ctx.rotate(1.9 + tail * 0.3); rr(-1.5, -10, 3, 10, 1.5); ctx.restore();
      ctx.fillStyle = chest; ctx.beginPath(); ctx.ellipse(8.5, -4, 2.6, 1.8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(8, -6.5, 1.3, 0.2, Math.PI - 0.2); ctx.stroke();
      blush(9.5, -4.8, 1, 0.5);
      if (Math.random() < 0.01) particles.push({ x: c.x + 6, y: c.y - 16, vx: 6, vy: -10, life: 1.8, kind: 'z' });
    } else {
      const sit = c.mode === 'sit' || c.mode === 'idle';
      const hy = sit ? -18 : -13;
      ctx.save(); ctx.translate(-8, -6); ctx.rotate(-1 + tail);
      rr(-1.5, -14, 3, 14, 1.5); ctx.restore();
      ctx.fillStyle = c.fur;
      ctx.beginPath(); ctx.ellipse(-1, sit ? -8 : -7, sit ? 7 : 10, sit ? 8 : 6, 0, 0, TAU); ctx.fill();
      if (striped) { ctx.strokeStyle = stripe; ctx.lineWidth = 1.2; for (const x of [-5, -2, 1]) { ctx.beginPath(); ctx.moveTo(x, sit ? -15 : -12.5); ctx.lineTo(x + 1, sit ? -11 : -9); ctx.stroke(); } }
      ctx.fillStyle = chest; ctx.beginPath(); ctx.ellipse(3, sit ? -7 : -5, 3, sit ? 5 : 3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = c.fur; circle(2, -0.8, 1.8); circle(5, -0.8, 1.8);
      ctx.fillStyle = chest; circle(2, -0.5, 1.2); circle(5, -0.5, 1.2);
      ctx.fillStyle = c.fur;
      circle(5, hy, 6);
      ctx.beginPath(); ctx.moveTo(1, hy - 4); ctx.lineTo(2.5, hy - 11); ctx.lineTo(5.5, hy - 5); ctx.fill();
      ctx.beginPath(); ctx.moveTo(6, hy - 5); ctx.lineTo(9.5, hy - 11); ctx.lineTo(10.5, hy - 3); ctx.fill();
      ctx.fillStyle = '#f7b6c4';
      ctx.beginPath(); ctx.moveTo(2.2, hy - 5); ctx.lineTo(2.8, hy - 9); ctx.lineTo(4.6, hy - 5.5); ctx.fill();
      ctx.beginPath(); ctx.moveTo(7, hy - 5.5); ctx.lineTo(9.2, hy - 9); ctx.lineTo(9.6, hy - 4.5); ctx.fill();
      if (striped) { ctx.strokeStyle = stripe; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(5, hy - 5.5); ctx.lineTo(5, hy - 3.5); ctx.moveTo(3.5, hy - 5); ctx.lineTo(3.8, hy - 3.5); ctx.stroke(); }
      ctx.fillStyle = chest; ctx.beginPath(); ctx.ellipse(6.5, hy + 2.5, 3, 2, 0, 0, TAU); ctx.fill();
      eye(c, 4, hy, 1.1, { color: c.fur === '#3d3d3d' ? '#e8c84a' : '#2e2a28' }); eye(c, 8, hy, 1.1, { color: c.fur === '#3d3d3d' ? '#e8c84a' : '#2e2a28' });
      ctx.fillStyle = '#f7a6b8'; circle(6.3, hy + 1.8, 0.8);
      ctx.strokeStyle = 'rgba(90,80,80,0.5)'; ctx.lineWidth = 0.4;
      ctx.beginPath(); ctx.moveTo(8.5, hy + 2); ctx.lineTo(12, hy + 1.2); ctx.moveTo(8.5, hy + 2.6); ctx.lineTo(12, hy + 3); ctx.stroke();
      blush(2.5, hy + 2, 1.1, 0.4); blush(9, hy + 2, 1.1, 0.4);
      if (c.mode === 'sit' && Math.random() < 0.006) particles.push({ x: c.x, y: c.y - 30, vx: 0, vy: -16, life: 1.4, kind: 'heart' });
    }
    ctx.restore();
  }

  function drawDuck(c) {
    const bob = Math.sin(c.anim * 2) * 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(c.x, c.y + 1, 12 + Math.sin(c.anim * 2) * 2, 4, 0, 0, TAU); ctx.stroke();
    // 물에 비친 그림자
    ctx.fillStyle = 'rgba(40,90,120,0.18)'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 3, 10, 3, 0, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(c.x, c.y + bob); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#fff8e8';
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(-12, -9); ctx.lineTo(-6, -6); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -3, 9, 5.5, 0, 0, TAU); ctx.fill();
    belly(0, -3, 9, 5.5, 'rgba(200,190,170,0.5)');
    ctx.fillStyle = '#c9a77c'; ctx.beginPath(); ctx.ellipse(-1.5, -4, 5, 2.8, 0.15, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(120,90,60,0.5)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-5, -4); ctx.lineTo(1.5, -3.8); ctx.stroke();
    ctx.fillStyle = '#4f9fd9'; rr(-3.5, -5.5, 3, 1.4, 0.6);
    ctx.fillStyle = '#5bb86a'; circle(6, -10, 4.5);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; circle(4.8, -12, 1.4);
    ctx.fillStyle = '#fff'; rr(2.5, -6.5, 6.5, 1.2, 0.6);
    ctx.fillStyle = '#ffa94d'; rr(9, -10, 5, 2.5, 1);
    eye(c, 7.6, -11, 0.95);
    ctx.restore();
  }

  function drawButterfly(c) {
    const flap = Math.abs(Math.sin(c.anim * 14));
    const y = c.y - 22 + Math.sin(c.anim * 3) * 4;
    const hue = (c.id * 67) % 360;
    shadow(c.x, c.y, 3, 1.2);
    if (c.dying != null) ctx.globalAlpha = Math.max(0, 1 - c.dying / 0.8);
    ctx.save(); ctx.translate(c.x, y - (c.dying || 0) * 30);
    const wing = sprite('wing' + hue, 12, 15, 11, 8, () => paintButterflyWing(hue));
    const k = flap * 0.85 + 0.15;
    ctx.save(); ctx.scale(k, 1); stamp(wing, -0.6, 0); ctx.restore();
    ctx.save(); ctx.scale(-k, 1); stamp(wing, -0.6, 0); ctx.restore();
    ctx.fillStyle = '#5a4a3a'; rr(-0.8, -4, 1.6, 8, 0.8);
    ctx.strokeStyle = '#5a4a3a'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-0.3, -4); ctx.quadraticCurveTo(-1, -7, -2.2, -7.5); ctx.moveTo(0.3, -4); ctx.quadraticCurveTo(1, -7, 2.2, -7.5); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // 왼쪽 날개 하나 (활짝 편 모양). 오른쪽은 뒤집어서 쓴다.
  function paintButterflyWing(hue) {
    const up = () => { ctx.beginPath(); ctx.ellipse(-4.6, -2.4, 4.6, 4.1, -0.45, 0, TAU); };
    const lo = () => { ctx.beginPath(); ctx.ellipse(-3.3, 2.6, 3.3, 2.7, 0.35, 0, TAU); };
    ctx.fillStyle = `hsl(${hue}, 60%, 55%)`; lo(); ctx.fill();
    ctx.fillStyle = `hsl(${hue}, 80%, 68%)`; ctx.beginPath(); ctx.ellipse(-3.2, 2.5, 3, 2.4, 0.35, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsl(${hue}, 60%, 60%)`; up(); ctx.fill();
    ctx.fillStyle = `hsl(${hue}, 85%, 78%)`; ctx.beginPath(); ctx.ellipse(-4.4, -2.3, 4.2, 3.7, -0.45, 0, TAU); ctx.fill();
    // 날개맥
    ctx.strokeStyle = `hsla(${hue}, 50%, 40%, 0.45)`; ctx.lineWidth = 0.3; ctx.lineCap = 'round';
    for (const [x, y] of [[-8, -4.5], [-8.5, -1.5], [-6, -6], [-3.5, -6.2]]) { ctx.beginPath(); ctx.moveTo(-0.5, -0.5); ctx.quadraticCurveTo(x * 0.5, y * 0.4, x, y); ctx.stroke(); }
    for (const [x, y] of [[-5.5, 4], [-3, 5]]) { ctx.beginPath(); ctx.moveTo(-0.5, 0.5); ctx.lineTo(x, y); ctx.stroke(); }
    // 눈알 무늬 + 가장자리 점
    ctx.fillStyle = `hsl(${(hue + 40) % 360}, 90%, 92%)`; circle(-5, -2.8, 1.6);
    ctx.fillStyle = `hsl(${hue}, 60%, 45%)`; circle(-5, -2.8, 0.8);
    ctx.fillStyle = '#fff'; circle(-5.3, -3.1, 0.3);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 5; i++) { const a = -2.2 + i * 0.45; circle(-4.6 + Math.cos(a + Math.PI) * 3.7, -2.4 + Math.sin(a + Math.PI) * 3.3, 0.35); }
    ctx.fillStyle = `hsl(${(hue + 40) % 360}, 90%, 88%)`; circle(-3.6, 3, 0.8);
  }

  function drawSpirit(c, night) {
    const fl = Math.sin(c.anim * 2) * 3;
    shadow(c.x, c.y, 7, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - 6 + fl);
    // 작은 팔 흔들기
    const wave = Math.sin(c.anim * 4) * 0.5;
    ctx.strokeStyle = '#eafaf5'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-3.5, -3); ctx.lineTo(-6.5, -5 - wave * 2); ctx.moveTo(3.5, -3); ctx.lineTo(6.5, -1 + wave); ctx.stroke();
    ctx.fillStyle = '#eafaf5'; rr(-4, -8, 8, 10, 4);
    ctx.fillStyle = 'rgba(150,200,190,0.35)'; rr(0.5, -8, 3.5, 10, 3);
    const nq = Math.round(night * 4) / 4;
    stamp(sprite('spiritCap' + nq, 26, 14, 13, 18, () => paintSpiritCap(nq)), 0, 0);
    eye(c, -1.8, -3, 0.95, { color: '#334' }); eye(c, 1.8, -3, 0.95, { color: '#334' });
    ctx.strokeStyle = '#557'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(0, -1.8, 0.8, 0.2, Math.PI - 0.2); ctx.stroke();
    blush(-3.2, -1.5, 1, 0.6); blush(3.2, -1.5, 1, 0.6);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function paintSpiritCap(night) {
    const cap = `rgb(${110 + night * 40}, ${220 + night * 30}, 210)`, capD = `rgb(${80 + night * 40}, ${185 + night * 30}, 185)`;
    // 갓 아래 주름
    ctx.fillStyle = '#d8f2ea'; ctx.beginPath(); ctx.ellipse(0, -9, 11, 2.6, 0, 0, Math.PI); ctx.fill();
    ctx.strokeStyle = 'rgba(60,150,140,0.45)'; ctx.lineWidth = 0.35;
    for (let x = -9; x <= 9; x += 1.5) { ctx.beginPath(); ctx.moveTo(x * 0.35, -8.6); ctx.lineTo(x, -7.2 + Math.abs(x) * -0.08); ctx.stroke(); }
    // 갓: 진한 테두리 → 본색 → 그라데이션 빛
    ctx.fillStyle = capD; ctx.beginPath(); ctx.ellipse(0, -8.6, 11.3, 8.3, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = cap; ctx.beginPath(); ctx.ellipse(-0.2, -9, 11, 8, 0, Math.PI, TAU); ctx.fill();
    const g = ctx.createRadialGradient(-4, -14, 0.5, 0, -10, 11);
    g.addColorStop(0, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(-0.2, -9, 11, 8, 0, Math.PI, TAU); ctx.fill();
    // 점무늬 (그늘 포함)
    for (const [x, y, R] of [[-4, -13, 1.8], [4, -14, 1.4], [0, -16, 1.2], [7, -11, 1], [-8, -10.5, 0.9], [2.5, -10.8, 0.8]]) {
      ctx.fillStyle = 'rgba(40,120,110,0.25)'; circle(x + 0.3, y + 0.35, R);
      ctx.fillStyle = '#fff'; circle(x, y, R);
      ctx.fillStyle = 'rgba(200,240,235,0.9)'; circle(x + R * 0.25, y + R * 0.25, R * 0.45);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(-5, -14.8, 2.4, 1, -0.4, 0, TAU); ctx.fill();
  }

  function drawTargetRing(c) {
    const p = (Math.sin(t * 6) + 1) / 2;
    ctx.strokeStyle = `rgba(255,120,150,${0.5 + p * 0.4})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 13 + p * 2, 5 + p, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ================= 효과 =================
  function onEvent(e) {
    if (e.type === 'eat') {
      for (let i = 0; i < 7; i++) {
        particles.push({ x: e.x, y: e.y - 12, vx: (Math.random() - 0.5) * 60, vy: -40 - Math.random() * 40, life: 1, kind: 'heart' });
      }
      particles.push({ x: e.x, y: e.y - 34, vx: 0, vy: -18, life: 1.3, kind: 'text', text: '냠!', color: '#ff7a59', size: 13 });
    } else if (e.type === 'bite') {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        particles.push({ x: e.x, y: e.y - 12, vx: Math.cos(a) * 45, vy: Math.sin(a) * 45 - 15, life: 1, kind: 'star' });
      }
      particles.push({ x: e.x, y: e.y - 34, vx: 0, vy: -18, life: 1.3, kind: 'text', text: '앙!', color: '#4f9a3f', size: 13 });
    } else if (e.type === 'caught') {
      particles.push({ x: e.x, y: e.y - 30, vx: 0, vy: -18, life: 1, kind: 'text', text: '잡았다!', color: '#4f9a3f', size: 11 });
    } else if (e.type === 'delivered') {
      for (let i = 0; i < 5; i++) particles.push({ x: e.x, y: e.y - 14, vx: (Math.random() - 0.5) * 40, vy: -30 - Math.random() * 20, life: 1, kind: 'heart' });
    } else if (e.type === 'release') {
      for (let i = 0; i < 6; i++) particles.push({ x: e.x, y: e.y - 14, vx: (Math.random() - 0.5) * 40, vy: -30 - Math.random() * 20, life: 1.2, kind: 'heart' });
      particles.push({ x: e.x, y: e.y - 34, vx: 0, vy: -16, life: 1.4, kind: 'text', text: '안녕~', color: '#ff7a9a', size: 12 });
    } else if (e.type === 'metamorph') {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        particles.push({ x: e.x, y: e.y - 10, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30 - 10, life: 1, kind: 'star' });
      }
    } else if (e.type === 'trait') {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        particles.push({ x: e.x, y: e.y - 20, vx: Math.cos(a) * 70, vy: Math.sin(a) * 70, life: 1.1, kind: 'star' });
      }
    }
  }

  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'heart' || p.kind === 'star') p.vy += 60 * dt;
      ctx.globalAlpha = Math.min(1, p.life);
      if (p.kind === 'heart') { ctx.fillStyle = '#ff7d9c'; heart(p.x, p.y, 4); }
      else if (p.kind === 'star') { ctx.fillStyle = '#ffd34d'; circle(p.x, p.y, 2.2); }
      else if (p.kind === 'dust') { ctx.fillStyle = 'rgba(200,180,140,0.7)'; circle(p.x, p.y, 2 + (0.5 - p.life) * 6); }
      else if (p.kind === 'smoke') { ctx.globalAlpha = Math.min(1, p.life / 3) * 0.45; ctx.fillStyle = '#f4f1ec'; circle(p.x, p.y, p.r + (3 - p.life) * 3); p.vx += Math.sin(t + p.y * 0.05) * dt * 2; }
      else if (p.kind === 'z') { ctx.fillStyle = '#7a8ab0'; ctx.font = 'bold 9px system-ui'; ctx.fillText('z', p.x, p.y); }
      else { ctx.fillStyle = p.color; ctx.font = `bold ${p.size}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y); }
    }
    ctx.globalAlpha = 1;
  }

  // ---- 구름 그림자: 부드러운 덩어리를 하나 만들어 두고 크게 늘려서 쓴다 ----
  const cloudImg = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 160;
    const g = c.getContext('2d');
    const puff = (x, y, r) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(30,70,50,0.45)'); gr.addColorStop(1, 'rgba(30,70,50,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    };
    puff(90, 85, 60); puff(150, 75, 70); puff(120, 100, 55); puff(190, 95, 45); puff(60, 100, 40);
    return c;
  })();
  const clouds = Array.from({ length: 7 }, (_, i) => ({ x: (i * 977) % MAP.w, y: (i * 613 + 300) % MAP.h, s: 2 + (i % 3) * 0.8, v: 6 + (i % 4) * 2 }));
  function drawClouds(view, night) {
    const a = (1 - night) * 0.16;
    if (a < 0.01) return;
    ctx.globalAlpha = a;
    for (const c of clouds) {
      const span = MAP.w + 1000;
      const x = ((c.x + t * c.v) % span) - 500, y = c.y + Math.sin(t * 0.05 + c.x) * 30;
      const w = 256 * c.s, h = 160 * c.s;
      if (x + w < view.x0 || x > view.x1 || y + h < view.y0 || y > view.y1) continue;
      ctx.drawImage(cloudImg, x, y, w, h);
    }
    ctx.globalAlpha = 1;
  }

  // ---- 떠다니는 것들: 낮엔 꽃가루·민들레 씨앗, 숲에선 나뭇잎 ----
  const motes = [];
  function updateMotes(dt, night, halfW, halfH, world) {
    const want = Math.round((1 - night) * 22);
    while (motes.length < want) {
      motes.push({ x: cam.x + (Math.random() - 0.5) * halfW * 2.2, y: cam.y + (Math.random() - 0.5) * halfH * 2.2, ph: Math.random() * TAU, leaf: false, rot: 0 });
    }
    if (motes.length > want) motes.length = want;
    const f = world.forest;
    for (const m of motes) {
      m.leaf = Math.hypot(m.x - f.x, m.y - f.y) < f.r;
      m.x += (m.leaf ? 6 : 10) * dt + Math.sin(t * 0.7 + m.ph) * 6 * dt;
      m.y += (m.leaf ? 9 : -2) * dt + Math.cos(t * 0.9 + m.ph) * 5 * dt;
      m.rot += dt * (1 + Math.sin(m.ph));
      if (Math.abs(m.x - cam.x) > halfW * 1.2 || Math.abs(m.y - cam.y) > halfH * 1.2) {
        m.x = cam.x + (Math.random() - 0.5) * halfW * 2; m.y = cam.y + (Math.random() - 0.5) * halfH * 2;
      }
      ctx.globalAlpha = 0.85 * (1 - night);
      if (m.leaf) {
        ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.rot); ctx.scale(Math.cos(m.rot * 2), 1);
        ctx.fillStyle = m.ph > 3 ? '#e8b86a' : '#9cc65a';
        ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 1.6, 0, 0, TAU); ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = '#fffbe6'; circle(m.x, m.y, 1.3);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.6;
        for (let k = 0; k < 4; k++) { const a = k * 1.57 + m.rot; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(a) * 3, m.y + Math.sin(a) * 3); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- 화면 색감: 해 뜰 때 분홍, 해 질 때 주황 + 가장자리 살짝 어둡게 ----
  let vignette = null, vigW = 0, vigH = 0;
  function drawGrade(dayP, night) {
    const dawn = Math.exp(-(((dayP - 0.27) / 0.045) ** 2));
    const dusk = Math.exp(-(((dayP - 0.73) / 0.045) ** 2));
    // 곱하기 섞기로 색만 따뜻하게 (뿌옇게 되지 않게)
    ctx.globalCompositeOperation = 'multiply';
    if (dawn > 0.02) { ctx.fillStyle = `rgba(255,190,200,${dawn * 0.55})`; ctx.fillRect(0, 0, W, H); }
    if (dusk > 0.02) { ctx.fillStyle = `rgba(255,170,100,${dusk * 0.6})`; ctx.fillRect(0, 0, W, H); }
    ctx.globalCompositeOperation = 'source-over';
    if (dusk > 0.02) { ctx.fillStyle = `rgba(255,200,120,${dusk * 0.06})`; ctx.fillRect(0, 0, W, H); }
    const noon = Math.max(0, 1 - Math.abs(dayP - 0.5) / 0.15) * (1 - night);
    if (noon > 0.02) { ctx.fillStyle = `rgba(255,250,210,${noon * 0.06})`; ctx.fillRect(0, 0, W, H); }
    if (!vignette || vigW !== W || vigH !== H) {
      vigW = W; vigH = H;
      vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      vignette.addColorStop(0, 'rgba(40,50,30,0)');
      vignette.addColorStop(1, 'rgba(40,50,30,0.22)');
    }
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
  }

  function updateFireflies(dt, night, halfW, halfH) {
    const want = Math.floor(night * 40);
    while (fireflies.length < want) {
      fireflies.push({ x: cam.x + (Math.random() - 0.5) * halfW * 2.2, y: cam.y + (Math.random() - 0.5) * halfH * 2.2, a: Math.random() * TAU, ph: Math.random() * TAU });
    }
    if (fireflies.length > want) fireflies.length = want;
    for (const f of fireflies) {
      f.a += (Math.random() - 0.5) * dt * 3;
      f.x += Math.cos(f.a) * 10 * dt; f.y += Math.sin(f.a) * 10 * dt;
      if (Math.abs(f.x - cam.x) > halfW * 1.2 || Math.abs(f.y - cam.y) > halfH * 1.2) {
        f.x = cam.x + (Math.random() - 0.5) * halfW * 2; f.y = cam.y + (Math.random() - 0.5) * halfH * 2;
      }
      const b = (Math.sin(t * 2.5 + f.ph) + 1) / 2;
      glow(f.x, f.y, 7, `rgba(220,255,140,${b * night * 0.9})`);
    }
  }

  function drawJoystick(input) {
    const st = input.stick;
    if (!st.active) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    circle(st.ox, st.oy, input.RADIUS);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    circle(st.ox + st.x * input.RADIUS, st.oy + st.y * input.RADIUS, 22);
  }

  // ================= 미리 그려두기(스티커) =================
  // 안 움직이는 부분은 처음 한 번만 자세히 그려 두고, 매 프레임엔 붙이기만 한다.
  // paint()는 (0,0)을 기준점으로 평소처럼 ctx에 그린다.
  const SPR = 6; // 월드 1칸당 픽셀 (최대 줌 2.6 × 화면배율 2 ≈ 5.2 를 덮도록)
  const sprites = new Map();
  function sprite(key, w, h, ax, ay, paint) {
    let s = sprites.get(key);
    if (s) return s;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * SPR); cv.height = Math.ceil(h * SPR);
    const g = cv.getContext('2d');
    g.setTransform(SPR, 0, 0, SPR, ax * SPR, ay * SPR);
    const prev = ctx; ctx = g;
    paint();
    ctx = prev;
    s = { cv, half: null, w, h, ax, ay };
    sprites.set(key, s);
    return s;
  }
  // 멀리서 작게 보일 땐 절반 크기 사본을 써서 거칠어 보이지 않게
  function halfOf(s) {
    if (!s.half) {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(s.cv.width / 2)); cv.height = Math.max(1, Math.ceil(s.cv.height / 2));
      const g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(s.cv, 0, 0, cv.width, cv.height);
      s.half = cv;
    }
    return s.half;
  }
  function stamp(s, x, y, k = 1) {
    const px = Math.abs(ctx.getTransform().a) * k; // 화면에서 1칸이 몇 픽셀인지
    ctx.drawImage(px < SPR * 0.45 ? halfOf(s) : s.cv, x - s.ax * k, y - s.ay * k, s.w * k, s.h * k);
  }

  // ================= 도형 도우미 =================
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  // 그림자: 해의 위치에 따라 아침엔 서쪽, 저녁엔 동쪽으로 길어진다 (tall = 키 큰 물체일수록 많이)
  function shadow(x, y, rx, ry, tall = 1) {
    const off = sun.x * rx * 0.35 * tall, stretch = 1 + Math.abs(sun.x) * 0.35 * tall;
    ctx.fillStyle = `rgba(40,70,40,${0.18 * sun.k})`;
    ctx.beginPath(); ctx.ellipse(x + off, y, rx * stretch, ry, 0, 0, TAU); ctx.fill();
  }
  function glow(x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function heart(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.6);
    ctx.bezierCurveTo(x - r * 1.2, y - r * 0.4, x - r * 0.5, y - r * 1.2, x, y - r * 0.4);
    ctx.bezierCurveTo(x + r * 0.5, y - r * 1.2, x + r * 1.2, y - r * 0.4, x, y + r * 0.6);
    ctx.fill();
  }

  return { render };
}
