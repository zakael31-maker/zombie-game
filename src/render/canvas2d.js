// 2D 카툰 렌더러. 게임 상태를 읽어서 그리기만 한다 (게임 규칙은 건드리지 않음).
// 3D로 바꿀 때는 같은 render(state, dt, input) 모양의 three.js 렌더러로 교체하면 된다.
import { MAP } from '../game/world.js';
import { TYPES } from '../game/creatures.js';
import { nightAmount } from '../game/game.js';
import { mulberry32, clamp } from '../core/rng.js';

const TAU = Math.PI * 2;

export function createRenderer(canvas, state) {
  const ctx = canvas.getContext('2d');
  const terrain = bakeTerrain(state.world);
  const particles = [];
  const fireflies = [];
  const cam = { x: state.zombie.x, y: state.zombie.y, zoom: 1 };
  let W = 0, H = 0, dpr = 1, t = 0;

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
    drawWaterShimmer(state.world, view);

    for (const f of state.world.flowers) if (inView(f)) drawFlower(f);
    for (const m of state.world.mushrooms) if (inView(m)) drawMushroom(m);
    for (const r of state.world.rocks) if (inView(r)) drawRock(r);

    drawSnailTrails(state);

    // 물 위 생명체 먼저
    for (const c of state.creatures) if (c.type === 'duck' && inView(c)) drawDuck(c);

    // 앞뒤 순서(y)대로 정렬해서 그리기
    const list = [];
    for (const tr of state.world.trees) if (inView(tr)) list.push({ y: tr.y, draw: () => drawTree(tr, z) });
    for (const h of state.world.houses) if (inView(h)) list.push({ y: h.y + h.h / 2, draw: () => drawHouse(h, night) });
    for (const c of state.creatures) {
      if (c.type === 'duck' || c.type === 'butterfly' || !inView(c)) continue;
      list.push({ y: c.y, draw: () => drawCreature(c, night) });
    }
    list.push({ y: z.y, draw: () => drawZombie(z) });
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.draw();

    for (const c of state.creatures) if (c.type === 'butterfly' && inView(c)) drawButterfly(c);
    if (state.nearEdible) drawTargetRing(state.nearEdible);
    drawParticles(dt);
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

    drawJoystick(input);
  }

  // ================= 지형 미리 그리기 =================
  function bakeTerrain(world) {
    const c = document.createElement('canvas');
    c.width = MAP.w; c.height = MAP.h;
    const g = c.getContext('2d');
    const r = mulberry32(world.seed + 99);

    g.fillStyle = '#a6db8a';
    g.fillRect(0, 0, MAP.w, MAP.h);
    // 풀밭 얼룩
    for (let i = 0; i < 500; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,220,0.10)' : 'rgba(60,140,60,0.08)';
      g.beginPath();
      g.ellipse(r() * MAP.w, r() * MAP.h, 30 + r() * 90, 20 + r() * 60, r() * 3, 0, TAU);
      g.fill();
    }
    // 숲은 조금 더 진하게
    const f = world.forest;
    const fg = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 1.15);
    fg.addColorStop(0, 'rgba(40,110,60,0.35)');
    fg.addColorStop(1, 'rgba(40,110,60,0)');
    g.fillStyle = fg;
    g.fillRect(f.x - f.r * 1.2, f.y - f.r * 1.2, f.r * 2.4, f.r * 2.4);
    // 마을 바닥
    const v = world.village;
    g.fillStyle = 'rgba(240, 220, 170, 0.55)';
    g.beginPath(); g.ellipse(v.x, v.y, v.r * 0.9, v.r * 0.75, 0, 0, TAU); g.fill();
    // 풀 포기
    g.strokeStyle = 'rgba(70,150,70,0.45)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 3500; i++) {
      const x = r() * MAP.w, y = r() * MAP.h;
      g.beginPath();
      g.moveTo(x - 3, y); g.lineTo(x - 4, y - 5);
      g.moveTo(x, y); g.lineTo(x, y - 7);
      g.moveTo(x + 3, y); g.lineTo(x + 4, y - 5);
      g.stroke();
    }
    // 길
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const p of world.paths) {
      for (const [w, col] of [[44, '#dcc48e'], [34, '#ecd9a8']]) {
        g.strokeStyle = col; g.lineWidth = w;
        g.beginPath(); g.moveTo(...p[0]);
        for (let i = 1; i < p.length; i++) g.lineTo(...p[i]);
        g.stroke();
      }
    }
    // 연못
    for (const p of world.ponds) {
      g.fillStyle = '#efdcaa';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx + 18, p.ry + 16, 0, 0, TAU); g.fill();
      g.fillStyle = '#7cc9ea';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, TAU); g.fill();
      g.fillStyle = '#9fdcf3';
      g.beginPath(); g.ellipse(p.x - p.rx * 0.1, p.y - p.ry * 0.1, p.rx * 0.75, p.ry * 0.65, 0, 0, TAU); g.fill();
      // 연잎
      for (let i = 0; i < 9; i++) {
        const a = r() * TAU, d = 0.3 + r() * 0.55;
        const x = p.x + Math.cos(a) * p.rx * d, y = p.y + Math.sin(a) * p.ry * d;
        g.fillStyle = '#6cbf6a';
        g.beginPath(); g.arc(x, y, 9 + r() * 5, 0.3, TAU - 0.3); g.lineTo(x, y); g.fill();
        if (r() < 0.4) { g.fillStyle = '#ffb3d1'; g.beginPath(); g.arc(x + 2, y - 2, 3.5, 0, TAU); g.fill(); }
      }
    }
    return c;
  }

  function drawWaterShimmer(world, view) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const p of world.ponds) {
      if (p.x + p.rx < view.x0 || p.x - p.rx > view.x1 || p.y + p.ry < view.y0 || p.y - p.ry > view.y1) continue;
      for (let i = 0; i < 6; i++) {
        const a = i * 1.7 + p.x, k = (Math.sin(t * 0.8 + i) + 1) / 2;
        const x = p.x + Math.cos(a) * p.rx * 0.5, y = p.y + Math.sin(a * 1.3) * p.ry * 0.5;
        ctx.globalAlpha = 0.3 + k * 0.5;
        ctx.beginPath(); ctx.moveTo(x - 8 - k * 4, y); ctx.lineTo(x + 8 + k * 4, y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ================= 바닥 장식 =================
  function drawFlower(f) {
    const s = 3.2 * f.s, sway = Math.sin(t * 1.5 + f.x) * 0.8;
    ctx.fillStyle = f.color;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      circle(f.x + sway + Math.cos(a) * s, f.y + Math.sin(a) * s, s * 0.8);
    }
    ctx.fillStyle = '#ffd34d';
    circle(f.x + sway, f.y, s * 0.6);
  }
  function drawMushroom(m) {
    ctx.fillStyle = '#f5ecd9'; rr(m.x - 2, m.y - 6, 4, 6, 2);
    ctx.fillStyle = '#ef6f6c';
    ctx.beginPath(); ctx.ellipse(m.x, m.y - 6, 6, 4.5, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; circle(m.x - 2, m.y - 8, 1.2); circle(m.x + 2.5, m.y - 7.5, 1);
  }
  function drawRock(r) {
    ctx.fillStyle = '#b9b4ae';
    ctx.beginPath(); ctx.ellipse(r.x, r.y, 10 * r.s, 7 * r.s, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d6d1cb';
    ctx.beginPath(); ctx.ellipse(r.x - 2 * r.s, r.y - 2 * r.s, 6 * r.s, 4 * r.s, 0, 0, TAU); ctx.fill();
  }

  // ================= 나무와 집 =================
  function drawTree(tr, z) {
    const s = tr.size;
    const sway = Math.sin(t * 0.9 + tr.phase) * 1.5;
    shadow(tr.x, tr.y, 20 * s, 7 * s);
    ctx.fillStyle = '#9a6b4a';
    rr(tr.x - 5 * s, tr.y - 22 * s, 10 * s, 23 * s, 4 * s);
    // 좀비가 나무 뒤에 있으면 잎을 반투명하게
    const behind = z.y < tr.y && z.y > tr.y - 70 * s && Math.abs(z.x - tr.x) < 30 * s;
    ctx.globalAlpha = behind ? 0.45 : 1;
    if (tr.kind === 'pine') {
      for (let i = 0; i < 3; i++) {
        const w = (30 - i * 7) * s, y = tr.y - (20 + i * 17) * s;
        ctx.fillStyle = i % 2 ? '#6ab874' : '#5aa866';
        ctx.beginPath();
        ctx.moveTo(tr.x - w + sway * (i + 1) * 0.3, y);
        ctx.lineTo(tr.x + w + sway * (i + 1) * 0.3, y);
        ctx.lineTo(tr.x + sway * (i + 1) * 0.5, y - 26 * s);
        ctx.closePath(); ctx.fill();
      }
    } else {
      const cx = tr.x + sway, cy = tr.y - 40 * s;
      ctx.fillStyle = '#6cbb5c';
      circle(cx - 14 * s, cy + 6 * s, 17 * s);
      circle(cx + 14 * s, cy + 6 * s, 17 * s);
      circle(cx, cy - 6 * s, 22 * s);
      ctx.fillStyle = '#8ad277';
      circle(cx - 6 * s, cy - 10 * s, 12 * s);
      ctx.fillStyle = '#ff8a8a';
      if (tr.phase > 4.5) { circle(cx + 8 * s, cy, 3 * s); circle(cx - 12 * s, cy + 8 * s, 3 * s); }
    }
    ctx.globalAlpha = 1;
  }

  function drawHouse(h) {
    const x0 = h.x - h.w / 2, base = h.y + h.h / 2, wallH = 58;
    shadow(h.x, base, h.w * 0.6, 12);
    ctx.fillStyle = '#fbefd9';
    rr(x0, base - wallH, h.w, wallH, 6);
    ctx.fillStyle = '#e9d6b6';
    ctx.fillRect(x0, base - 8, h.w, 8);
    // 지붕
    ctx.fillStyle = h.roof;
    ctx.beginPath();
    ctx.moveTo(x0 - 10, base - wallH + 4);
    ctx.lineTo(h.x, base - wallH - 42);
    ctx.lineTo(x0 + h.w + 10, base - wallH + 4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(x0 - 4, base - wallH + 2); ctx.lineTo(h.x, base - wallH - 36); ctx.lineTo(h.x, base - wallH - 28); ctx.lineTo(x0 + 6, base - wallH + 2);
    ctx.fill();
    // 문과 창문
    ctx.fillStyle = '#b47b52';
    rr(h.x - 10, base - 34, 20, 34, 8);
    ctx.fillStyle = '#fff3a8';
    rr(x0 + 12, base - 44, 20, 16, 3);
    rr(x0 + h.w - 32, base - 44, 20, 16, 3);
    ctx.fillStyle = '#9fd18b';
    rr(x0 + 10, base - 27, 24, 5, 2);
    rr(x0 + h.w - 34, base - 27, 24, 5, 2);
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
    switch (p.legs) {
      case 'walk':
        limb(-s * 0.08, hipY, -s * 0.08 + w * s * 0.14, -Math.max(0, w) * s * 0.06, W, C);
        limb(s * 0.1, hipY, s * 0.1 - w * s * 0.14, -Math.max(0, -w) * s * 0.06, W, C);
        break;
      case 'run': {
        const a = w * s * 0.26;
        limb2(-s * 0.04, hipY, -s * 0.04 + a * 0.6, hipY + s * 0.2, -s * 0.04 + a, -Math.max(0, w) * s * 0.14, W, C);
        limb2(s * 0.08, hipY, s * 0.08 - a * 0.6, hipY + s * 0.2, s * 0.08 - a, -Math.max(0, -w) * s * 0.14, W, C);
        break;
      }
      case 'crawl': {
        // 무릎으로 기기: 엉덩이 → 무릎(바닥) → 발(뒤쪽)
        const k1 = w * s * 0.07, k2 = -k1;
        limb2(-s * 0.04, hipY, -s * 0.02 + k1, -s * 0.03, -s * 0.34 + k1, -s * 0.06, W, C);
        limb2(s * 0.04, hipY, s * 0.06 + k2, -s * 0.03, -s * 0.26 + k2, -s * 0.05, W, C);
        break;
      }
      case 'sit':
        limb2(-s * 0.06, hipY, s * 0.2, hipY + s * 0.02, s * 0.26, -s * 0.03, W, C);
        limb2(s * 0.06, hipY, s * 0.3, hipY + s * 0.03, s * 0.36, -s * 0.03, W, C);
        break;
      case 'prone': {
        const kick = Math.sin(t * 1.6) * s * 0.12;
        limb2(0, hipY, -s * 0.32, -s * 0.07, -s * 0.5, -s * 0.12 - Math.max(0, kick), W, C);
        limb2(0, hipY, -s * 0.34, -s * 0.06, -s * 0.48, -s * 0.12 - Math.max(0, -kick), W, C);
        break;
      }
      case 'lie':
        // 등 대고 누워서 한쪽 무릎 세우기
        limb2(0, hipY, s * 0.22, -s * 0.34, s * 0.42, -s * 0.07, W, C);
        limb(0, hipY, s * 0.5, -s * 0.08, W, C);
        break;
      default:
        limb(-s * 0.08, hipY, -s * 0.08, -s * 0.03, W, C);
        limb(s * 0.1, hipY, s * 0.1, -s * 0.03, W, C);
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
    ctx.fillStyle = '#e6c9a8';
    rr(-s * 0.28, -s * 0.28, s * 0.56, s * 0.3, s * 0.1);
    ctx.fillStyle = 'rgba(150,120,90,0.35)';
    rr(-s * 0.1, -s * 0.16, s * 0.08, s * 0.1, s * 0.03);
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
    const sw = Math.sin(t * 1.4) * s * 0.02;
    switch (p.arms) {
      case 'zombie': // 앞으로 쭉
        return limb(sx, sy, sx + s * 0.4, sy + (back ? -1 : 1) * sw + p.w * s * 0.04, W, C);
      case 'grab':
        return limb(sx, sy, sx + s * 0.42, sy - s * 0.1, W, C);
      case 'pump': { // 뛸 때 팔 흔들기
        const a = (back ? -1 : 1) * p.w * s * 0.22;
        return limb2(sx, sy, sx + a * 0.5, sy + s * 0.18, sx + a + s * 0.12, sy + s * 0.08, W, C);
      }
      case 'crawl': { // 몸통이 앞으로 기울어 있으니 '아래(+y)'가 땅 쪽
        const a = (back ? -1 : 1) * p.w * s * 0.1;
        return limb(sx, sy, sx + s * 0.18 + a, sy + s * 0.34, W, C);
      }
      case 'lap':
        return limb2(sx, sy, sx + s * 0.12, sy + s * 0.2, sx + s * 0.3, sy + s * 0.22, W, C);
      case 'chin':
        return limb(sx, sy, sx - s * 0.05, sy + s * 0.25, W, C);
      case 'belly':
        return limb2(sx, sy, sx + s * 0.12, sy + s * 0.08, sx + s * 0.02, sy + s * 0.22, W, C);
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
  function drawCreature(c, night) {
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

  // ---- 느린 친구들 ----
  function drawSnail(c) {
    const crawl = c.mode === 'walk' ? Math.sin(c.anim * 3) * 0.6 : 0;
    shadow(c.x, c.y, 8, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#f3dfb0';
    rr(-7, -4, 16 + crawl, 4.5, 2.2);
    ctx.strokeStyle = '#f3dfb0'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(7, -3); ctx.lineTo(8.5, -9); ctx.moveTo(9, -3); ctx.lineTo(11.5, -8); ctx.stroke();
    ctx.fillStyle = '#333'; circle(8.5, -9, 1); circle(11.5, -8, 1);
    ctx.fillStyle = '#e8955a'; circle(-1, -8, 6.5);
    ctx.strokeStyle = '#b8653a'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let a = 0; a < 11; a += 0.3) {
      const r = 5.5 - a * 0.45;
      ctx.lineTo(-1 + Math.cos(a) * r, -8 + Math.sin(a) * r);
    }
    ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
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
      circle(11, -6, 4);
      ctx.fillStyle = '#333'; circle(12.5, -7, 0.9);
      ctx.fillStyle = 'rgba(255,140,150,0.5)'; circle(13, -5, 1);
    }
    ctx.fillStyle = '#6fb35c';
    ctx.beginPath(); ctx.ellipse(0, -6, 11, 8, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#5c9a4c'; rr(-11, -6.5, 22, 3, 1.5);
    ctx.fillStyle = '#8cc977';
    circle(0, -10, 3); circle(-6, -8, 2.2); circle(6, -8, 2.2);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawCaterpillar(c) {
    fade(c);
    if (c.mode === 'cocoon') {
      const wob = Math.sin(c.anim * 4) * 0.15;
      shadow(c.x, c.y, 5, 2);
      ctx.save(); ctx.translate(c.x, c.y - 7); ctx.rotate(wob);
      ctx.fillStyle = '#e9d8a6';
      ctx.beginPath(); ctx.ellipse(0, 0, 4, 8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#cdb87f'; ctx.lineWidth = 0.8;
      for (let i = -4; i <= 4; i += 3) { ctx.beginPath(); ctx.moveTo(-3.5, i); ctx.lineTo(3.5, i + 1); ctx.stroke(); }
      ctx.restore(); ctx.globalAlpha = 1;
      return;
    }
    shadow(c.x, c.y, 8, 2);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    for (let i = 0; i < 5; i++) {
      const wig = c.mode === 'walk' ? Math.sin(c.anim * 6 - i) * 1.2 : 0;
      ctx.fillStyle = i % 2 ? '#8fd16a' : '#a6e07e';
      circle(-8 + i * 3.6, -3 - Math.max(0, wig), 3);
    }
    ctx.fillStyle = '#b8e88f'; circle(10, -4, 3.4);
    ctx.strokeStyle = '#5a7a3a'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(9, -7); ctx.lineTo(8, -10); ctx.moveTo(11, -7); ctx.lineTo(12, -10); ctx.stroke();
    ctx.fillStyle = '#333'; circle(11, -4.5, 0.7);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawFrog(c) {
    const hop = c.hopping > 0 ? Math.sin(((0.35 - c.hopping) / 0.35) * Math.PI) * 10 : 0;
    shadow(c.x, c.y, 7, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#7cc96a';
    ctx.beginPath(); ctx.ellipse(0, -5, 8, 5.5, 0, 0, TAU); ctx.fill();
    circle(-3, -10, 3.2); circle(3, -10, 3.2);
    ctx.fillStyle = '#fff'; circle(-3, -10.5, 2); circle(3, -10.5, 2);
    ctx.fillStyle = '#333'; circle(-2.6, -10.5, 1); circle(3.4, -10.5, 1);
    ctx.fillStyle = '#c9eeb9'; ctx.beginPath(); ctx.ellipse(0, -3.5, 5, 2.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,140,150,0.6)'; circle(-5, -6, 1.2); circle(5, -6, 1.2);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawHedgehog(c) {
    shadow(c.x, c.y, 9, 3);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.strokeStyle = '#6e4f36'; ctx.lineWidth = 1.4;
    if (c.mode === 'ball') {
      ctx.fillStyle = '#8a6a4a'; circle(0, -7, 7);
      for (let a = 0; a < TAU; a += 0.5) {
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * 6, -7 + Math.sin(a) * 6); ctx.lineTo(Math.cos(a) * 9.5, -7 + Math.sin(a) * 9.5); ctx.stroke();
      }
    } else {
      const walk = c.mode === 'walk' ? Math.sin(c.anim * 8) * 0.8 : 0;
      ctx.fillStyle = '#e9cfa8';
      ctx.beginPath(); ctx.ellipse(6, -4, 5, 3.6, 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#333'; circle(10.5, -3.5, 1.1); circle(6.5, -5.5, 0.8);
      ctx.fillStyle = '#8a6a4a';
      ctx.beginPath(); ctx.ellipse(-2, -5 + walk, 9, 6.5, 0, Math.PI, TAU); ctx.fill();
      for (let a = Math.PI; a <= TAU; a += 0.35) {
        ctx.beginPath();
        ctx.moveTo(-2 + Math.cos(a) * 7, -5 + walk + Math.sin(a) * 5);
        ctx.lineTo(-2 + Math.cos(a) * 11, -5 + walk + Math.sin(a) * 8.5);
        ctx.stroke();
      }
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawLadybug(c) {
    shadow(c.x, c.y, 4, 1.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - 2); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#333'; circle(3.5, -1, 2);
    ctx.fillStyle = '#ef4b4b'; circle(0, -1, 4);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 3); ctx.stroke();
    ctx.fillStyle = '#333'; circle(-2, -2.5, 0.9); circle(2, 0.5, 0.9); circle(-1.8, 1, 0.8);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; circle(-1.5, -3.5, 0.8);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // 달팽이 반짝이 자국
  const trails = new Map();
  function drawSnailTrails(state) {
    const alive = new Set();
    ctx.lineCap = 'round';
    for (const c of state.creatures) {
      if (c.type !== 'snail') continue;
      alive.add(c.id);
      let tr = trails.get(c.id);
      if (!tr) { tr = []; trails.set(c.id, tr); }
      const lastP = tr[tr.length - 1];
      if (!lastP || Math.hypot(lastP.x - c.x, lastP.y - c.y) > 3) tr.push({ x: c.x - c.facing * 6, y: c.y - 1, t });
      while (tr.length && t - tr[0].t > 12) tr.shift();
      for (let i = 1; i < tr.length; i++) {
        const a = 1 - (t - tr[i].t) / 12;
        ctx.strokeStyle = `rgba(235,245,255,${a * 0.6})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke();
      }
    }
    for (const id of trails.keys()) if (!alive.has(id)) trails.delete(id);
  }
  const fade = (c) => { ctx.globalAlpha = c.dying != null ? Math.max(0, 1 - c.dying / 0.8) : 1; };

  function drawRabbit(c) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 12)) * 6 : 0;
    shadow(c.x, c.y, 8, 3);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#fbf7f2';
    ctx.beginPath(); ctx.ellipse(0, -6, 8, 6, 0, 0, TAU); ctx.fill();
    circle(-7, -6, 3);
    circle(6, -11, 5.5);
    ctx.beginPath(); ctx.ellipse(4, -20, 1.8, 5.5, -0.15, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, -19, 1.8, 5.5, 0.25, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f7b6c4';
    ctx.beginPath(); ctx.ellipse(4, -20, 0.8, 3.8, -0.15, 0, TAU); ctx.fill();
    ctx.fillStyle = '#333'; circle(8, -12, 1);
    ctx.fillStyle = '#f7a6b8'; circle(10.5, -10, 0.9);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawBird(c, k) {
    const bob = c.mode === 'walk' || c.mode === 'flee' ? Math.sin(c.anim * 14) * 1.2 : Math.sin(c.anim * 3) * 0.4;
    const peck = c.mode === 'idle' && Math.sin(c.anim * 2) > 0.85 ? 3 : 0;
    shadow(c.x, c.y, 8 * k, 3 * k);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y + bob); ctx.scale(c.facing * k, k);
    ctx.fillStyle = k < 1 ? '#ffe066' : '#fffaf0';
    ctx.beginPath(); ctx.ellipse(0, -8, 9, 7.5, 0, 0, TAU); ctx.fill();
    circle(6, -14 + peck, 5);
    ctx.fillStyle = '#ffa94d';
    ctx.beginPath(); ctx.moveTo(10, -14 + peck); ctx.lineTo(14, -12.5 + peck); ctx.lineTo(10, -11.5 + peck); ctx.fill();
    if (k >= 1) { ctx.fillStyle = '#ef5a5a'; circle(5, -19 + peck, 2.2); circle(7.5, -18.5 + peck, 1.8); }
    ctx.fillStyle = '#333'; circle(7.5, -15 + peck, 1);
    ctx.fillStyle = k < 1 ? '#f5cf3d' : '#efe6d6';
    ctx.beginPath(); ctx.ellipse(-2, -8, 4.5, 3, 0.3, 0, TAU); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawVillager(c) {
    const s = 26;
    const walk = c.mode === 'walk' || c.mode === 'flee' ? Math.sin(c.anim * (c.mode === 'flee' ? 16 : 9)) : 0;
    shadow(c.x, c.y, 10, 3.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#4b4b6b';
    rr(-5 + walk * 2, -11, 4.5, 11, 2);
    rr(1 - walk * 2, -11, 4.5, 11, 2);
    ctx.fillStyle = c.color;
    rr(-7, -s * 0.9, 14, 14, 5);
    ctx.fillStyle = '#ffe0c2';
    circle(0, -s * 1.1, 7);
    ctx.fillStyle = '#6b4a3a';
    ctx.beginPath(); ctx.arc(0, -s * 1.13, 7.3, Math.PI * 1.05, TAU * 0.99); ctx.fill();
    ctx.fillStyle = '#333'; circle(3, -s * 1.1, 0.9);
    if (c.mode === 'flee') { ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(3.5, -s * 1.03, 1.4, 0, TAU); ctx.stroke(); }
    else { ctx.fillStyle = 'rgba(255,140,150,0.5)'; circle(4.5, -s * 1.06, 1.4); }
    ctx.restore(); ctx.globalAlpha = 1;
    if (c.mode === 'flee' && Math.random() < 0.03) particles.push({ x: c.x, y: c.y - 38, vx: 0, vy: -20, life: 0.8, kind: 'text', text: '!', color: '#e05a5a', size: 14 });
  }

  function drawCat(c) {
    shadow(c.x, c.y, 9, 3);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.fillStyle = c.fur;
    const tail = Math.sin(c.anim * 2.5) * 0.4;
    if (c.mode === 'sleep') {
      ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, TAU); ctx.fill();
      circle(7, -6, 5);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(8, -6.5, 1.3, 0.2, Math.PI - 0.2); ctx.stroke();
      if (Math.random() < 0.01) particles.push({ x: c.x + 6, y: c.y - 16, vx: 6, vy: -10, life: 1.8, kind: 'z' });
    } else {
      const sit = c.mode === 'sit' || c.mode === 'idle';
      ctx.beginPath(); ctx.ellipse(-1, sit ? -8 : -7, sit ? 7 : 10, sit ? 8 : 6, 0, 0, TAU); ctx.fill();
      circle(5, sit ? -18 : -13, 6);
      ctx.beginPath(); ctx.moveTo(1, (sit ? -22 : -17)); ctx.lineTo(2.5, (sit ? -29 : -24)); ctx.lineTo(5.5, (sit ? -23 : -18)); ctx.fill();
      ctx.beginPath(); ctx.moveTo(6, (sit ? -23 : -18)); ctx.lineTo(9.5, (sit ? -29 : -24)); ctx.lineTo(10.5, (sit ? -21 : -16)); ctx.fill();
      ctx.save(); ctx.translate(-8, -6); ctx.rotate(-1 + tail);
      rr(-1.5, -14, 3, 14, 1.5); ctx.restore();
      ctx.fillStyle = '#333';
      circle(4, sit ? -18 : -13, 0.9); circle(8, sit ? -18 : -13, 0.9);
      ctx.fillStyle = '#f7a6b8'; circle(6, sit ? -16 : -11, 0.8);
      if (c.mode === 'sit' && Math.random() < 0.006) particles.push({ x: c.x, y: c.y - 30, vx: 0, vy: -16, life: 1.4, kind: 'heart' });
    }
    ctx.restore();
  }

  function drawDuck(c) {
    const bob = Math.sin(c.anim * 2) * 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(c.x, c.y + 1, 12 + Math.sin(c.anim * 2) * 2, 4, 0, 0, TAU); ctx.stroke();
    ctx.save(); ctx.translate(c.x, c.y + bob); ctx.scale(c.facing, 1);
    ctx.fillStyle = '#fff8e8';
    ctx.beginPath(); ctx.ellipse(0, -3, 9, 5.5, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(-12, -9); ctx.lineTo(-6, -6); ctx.fill();
    ctx.fillStyle = '#5bb86a'; circle(6, -10, 4.5);
    ctx.fillStyle = '#ffa94d'; rr(9, -10, 5, 2.5, 1);
    ctx.fillStyle = '#222'; circle(7.5, -11, 0.9);
    ctx.restore();
  }

  function drawButterfly(c) {
    const flap = Math.abs(Math.sin(c.anim * 14));
    const y = c.y - 22 + Math.sin(c.anim * 3) * 4;
    const hue = (c.id * 67) % 360;
    shadow(c.x, c.y, 3, 1.2);
    if (c.dying != null) ctx.globalAlpha = Math.max(0, 1 - c.dying / 0.8);
    ctx.save(); ctx.translate(c.x, y - (c.dying || 0) * 30);
    ctx.fillStyle = `hsl(${hue}, 85%, 78%)`;
    ctx.beginPath(); ctx.ellipse(-3 * flap - 1, -2, 4 * flap + 0.5, 4, -0.4, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3 * flap + 1, -2, 4 * flap + 0.5, 4, 0.4, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsl(${hue}, 80%, 68%)`;
    ctx.beginPath(); ctx.ellipse(-2 * flap - 1, 2.5, 2.8 * flap + 0.4, 2.5, 0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2 * flap + 1, 2.5, 2.8 * flap + 0.4, 2.5, -0.3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#5a4a3a'; rr(-0.8, -4, 1.6, 8, 0.8);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawSpirit(c, night) {
    const fl = Math.sin(c.anim * 2) * 3;
    shadow(c.x, c.y, 7, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - 6 + fl);
    ctx.fillStyle = '#eafaf5'; rr(-4, -8, 8, 10, 4);
    ctx.fillStyle = `rgb(${110 + night * 40}, ${220 + night * 30}, 210)`;
    ctx.beginPath(); ctx.ellipse(0, -9, 11, 8, 0, Math.PI, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -9, 11, 2.5, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#fff'; circle(-4, -13, 1.8); circle(4, -14, 1.4); circle(0, -16, 1.2);
    ctx.fillStyle = '#334'; circle(-1.8, -3, 0.9); circle(1.8, -3, 0.9);
    ctx.fillStyle = 'rgba(255,150,170,0.6)'; circle(-3.2, -1.5, 1); circle(3.2, -1.5, 1);
    ctx.restore(); ctx.globalAlpha = 1;
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
      else if (p.kind === 'z') { ctx.fillStyle = '#7a8ab0'; ctx.font = 'bold 9px system-ui'; ctx.fillText('z', p.x, p.y); }
      else { ctx.fillStyle = p.color; ctx.font = `bold ${p.size}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y); }
    }
    ctx.globalAlpha = 1;
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

  // ================= 도형 도우미 =================
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function shadow(x, y, rx, ry) { ctx.fillStyle = 'rgba(40,70,40,0.18)'; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill(); }
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
