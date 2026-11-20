// 2D 카툰 렌더러. 게임 상태를 읽어서 그리기만 한다 (게임 규칙은 건드리지 않음).
// 3D로 바꿀 때는 같은 render(state, dt, input) 모양의 three.js 렌더러로 교체하면 된다.
import { MAP, CHUNK, chunksInRect, featuresInRect, inFeature, pondAt, coastX } from '../game/world.js';
import { BIOMES, biomeAt, biomeIdAt } from '../game/biomes.js';
import { TYPES } from '../game/creatures.js';
import { nightAmount, DAY_LENGTH } from '../game/game.js';
import { mulberry32, clamp, hash2 } from '../core/rng.js';

const TAU = Math.PI * 2;

export function createRenderer(canvas, state) {
  const mainCtx = canvas.getContext('2d');
  let ctx = mainCtx; // 좀비 친구는 잠깐 다른 캔버스에 그린 뒤 초록빛을 입힌다
  const fCanvas = document.createElement('canvas');
  const fCtx = fCanvas.getContext('2d');
  const particles = [];
  const fireflies = [];
  const cam = { x: state.zombie.x, y: state.zombie.y, zoom: 1 };
  let W = 0, H = 0, dpr = 1, t = 0;
  const sun = { x: 0, k: 1 }; // 그림자 방향(-1 아침 ~ 1 저녁)과 진하기
  let zSnow = false, snowK = 0; // 좀비가 겨울 지역에 있나 / 얼마나 깊이 (0~1)
  let zDesert = false, desK = 0; // 사막도 똑같이
  let zJungle = false, jK = 0, zBeach = false, beachK = 0; // 밀림 · 바닷가

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
    // 좀비가 겨울 지역에 얼마나 들어왔는지 (부드럽게 바뀜): 눈 내림·입김·색감에 쓴다
    zSnow = biomeIdAt(state.world, z.x, z.y) === 'snow';
    snowK += ((zSnow ? 1 : 0) - snowK) * Math.min(1, dt * 0.6);
    zDesert = biomeIdAt(state.world, z.x, z.y) === 'desert';
    desK += ((zDesert ? 1 : 0) - desK) * Math.min(1, dt * 0.6);
    const zb = biomeIdAt(state.world, z.x, z.y);
    zJungle = zb === 'jungle'; zBeach = zb === 'beach';
    jK += ((zJungle ? 1 : 0) - jK) * Math.min(1, dt * 0.6);
    beachK += ((zBeach ? 1 : 0) - beachK) * Math.min(1, dt * 0.6);

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

    drawTerrain(state.world, view);
    const ponds = featuresInRect(state.world, view.x0, view.y0, view.x1, view.y1).filter((f) => f.kind === 'pond');
    drawWaterShimmer(ponds, view, dt);
    drawSea(state.world, view, dt);

    // 화면에 걸친 조각들의 물체만 그린다
    const chunks = [...chunksInRect(state.world, view.x0, view.y0, view.x1, view.y1)];
    for (const ch of chunks) {
      for (const f of ch.flowers) if (inView(f)) drawFlower(f);
      for (const m of ch.mushrooms) if (inView(m)) drawMushroom(m);
      for (const r of ch.rocks) if (inView(r)) drawRock(r);
    }

    for (const c of state.creatures) if (c.type === 'meerkat' && c.burrow?.owner === c.id && inView(c.burrow)) drawBurrow(c.burrow);
    drawSnailTrails(state, view);
    updateTracks(state, view, z);

    // 물 위 생명체 먼저
    for (const c of state.creatures) if (c.type === 'duck' && inView(c)) { duckWake(c, dt); drawDuck(c); }

    // 앞뒤 순서(y)대로 정렬해서 그리기
    const list = [];
    for (const ch of chunks) {
      for (const tr of ch.trees) if (inView(tr)) list.push({ y: tr.y, draw: () => drawTree(tr, z) });
      for (const h of ch.houses) list.push({ y: h.y + h.h / 2, draw: () => drawHouse(h, night) });
    }
    for (const c of state.creatures) {
      if (c.type === 'duck' || c.type === 'butterfly' || c.ridden || !inView(c)) continue;
      list.push({ y: c.y, draw: () => (c.friend ? drawFriend(c, night) : c.carriedBy ? drawCarried(c, night) : drawCreature(c, night)) });
    }
    list.push({ y: z.y, draw: () => drawZombie(z) });
    breathe(state, z, dt, view);
    list.sort((a, b) => a.y - b.y);
    for (const it of list) it.draw();

    for (const c of state.creatures) if (c.type === 'butterfly' && inView(c)) drawButterfly(c);
    if (state.nearFoe) drawTargetRing(state.nearFoe, 13, '255,80,80');
    else if (state.nearEdible) drawTargetRing(state.nearEdible);
    else if (state.nearRide) drawTargetRing(state.nearRide, 20);
    drawParticles(dt);
    updateTumbleweeds(dt, view, state.world);
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
      for (const ch of chunks) for (const h of ch.houses) houseLights(h, night);
      for (const c of state.creatures) if (c.type === 'spirit' && inView(c)) glow(c.x, c.y - 14, 34, `rgba(110,240,220,${0.35 * night + 0.1})`);
      for (const c of state.creatures) if (c.type === 'snowman' && inView(c)) glow(c.x, c.y - 12, 30, `rgba(170,210,255,${0.3 * night + 0.06})`);
      for (const c of state.creatures) if (c.type === 'bloom' && inView(c)) glow(c.x, c.y - 14, 28, `rgba(255,140,170,${0.35 * night + 0.05})`);
      for (const c of state.creatures) if (c.type === 'starry' && inView(c)) glow(c.x, c.y - 10, 26, `rgba(255,190,120,${0.35 * night + 0.05})`);
      for (const c of state.creatures) if (c.type === 'prickle' && inView(c)) glow(c.x, c.y - 20, 28, `rgba(255,150,190,${0.35 * night + 0.05})`);
      if (z.traits.includes('glow')) glow(z.x, z.y - 22, 46, `rgba(150,255,200,${0.3 * night + 0.08})`);
      updateFireflies(dt, night, halfW, halfH);
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrade(dayP, night);
    if (snowK > 0.02) { ctx.fillStyle = `rgba(210,228,255,${snowK * 0.08})`; ctx.fillRect(0, 0, W, H); }
    if (desK > 0.02) { ctx.fillStyle = `rgba(255,205,140,${desK * 0.07 * (1 - night)})`; ctx.fillRect(0, 0, W, H); }
    if (jK > 0.02) { ctx.fillStyle = `rgba(30,110,70,${jK * 0.07})`; ctx.fillRect(0, 0, W, H); lightShafts(night); }
    if (beachK > 0.02) { ctx.fillStyle = `rgba(200,240,255,${beachK * 0.05 * (1 - night)})`; ctx.fillRect(0, 0, W, H); }
    drawJoystick(input);
  }

  // ================= 지형: 조각마다 미리 그리기 =================
  // 400칸 조각 하나씩 그림으로 구워 두고, 화면에 보이는 조각만 붙인다.
  // 조각 경계에서 이음새가 안 보이도록 가장자리를 PAD만큼 겹쳐 그린다.
  const PAD = 3, TILE = CHUNK + PAD * 2;
  const tiles = new Map(); // 키 → { cv, used }
  const MAX_TILES = 56;
  const strSeed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

  function drawTerrain(world, view) {
    let budget = tiles.size === 0 ? 99 : 2; // 처음엔 화면 전부, 그 뒤로는 한 프레임에 2장까지만 새로 굽기
    for (const ch of chunksInRect(world, view.x0, view.y0, view.x1, view.y1)) {
      let tl = tiles.get(ch.key);
      if (!tl && budget > 0) { budget--; tl = { cv: bakeChunk(world, ch) }; tiles.set(ch.key, tl); }
      if (tl) { tl.used = t; ctx.drawImage(tl.cv, ch.x0 - PAD, ch.y0 - PAD, TILE, TILE); }
      else { ctx.fillStyle = biomeAt(world, ch.x0 + CHUNK / 2, ch.y0 + CHUNK / 2).ground; ctx.fillRect(ch.x0, ch.y0, CHUNK, CHUNK); }
    }
    // 여유가 있으면 화면 바로 바깥 조각을 미리 구워 둔다
    if (budget > 0) {
      for (const ch of chunksInRect(world, view.x0 - CHUNK, view.y0 - CHUNK, view.x1 + CHUNK, view.y1 + CHUNK)) {
        if (tiles.has(ch.key)) continue;
        tiles.set(ch.key, { cv: bakeChunk(world, ch), used: t });
        break;
      }
    }
    if (tiles.size > MAX_TILES) {
      const old = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, tiles.size - MAX_TILES);
      for (const [k] of old) tiles.delete(k);
    }
  }

  // 지역 바닥색: 25칸 간격 점을 찍어 부드럽게 늘린다 (지역 경계가 자연스럽게 섞이도록)
  const SAMPLE = 25, SN = CHUNK / SAMPLE + 2;
  const sampleCv = document.createElement('canvas'); sampleCv.width = SN; sampleCv.height = SN;
  const sampleG = sampleCv.getContext('2d');
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  // 꽁꽁 언 연못: 눈 둑 → 얼음 (금, 서리, 빛줄기)
  function paintIcePond(g, p, r) {
    g.fillStyle = 'rgba(150,180,215,0.4)'; g.beginPath(); g.ellipse(p.x, p.y + 3, p.rx + 24, p.ry + 20, 0, 0, TAU); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(p.x, p.y, p.rx + 20, p.ry + 17, 0, 0, TAU); g.fill();
    g.fillStyle = '#d8e6f2'; g.beginPath(); g.ellipse(p.x, p.y + 1, p.rx + 5, p.ry + 4, 0, 0, TAU); g.fill();
    const ig = g.createRadialGradient(p.x - p.rx * 0.2, p.y - p.ry * 0.2, 0, p.x, p.y, Math.max(p.rx, p.ry));
    ig.addColorStop(0, '#d6f1fb'); ig.addColorStop(0.65, '#b3e0f2'); ig.addColorStop(1, '#e4f5fc');
    g.fillStyle = ig;
    g.save(); g.translate(p.x, p.y); g.scale(1, p.ry / p.rx); g.beginPath(); g.arc(0, 0, p.rx, 0, TAU); g.fill(); g.restore();
    g.save(); g.beginPath(); g.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, TAU); g.clip();
    // 서리 얼룩
    for (let i = 0; i < 10; i++) {
      const a = r() * TAU, d = r() * 0.9, R = 10 + r() * 26;
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(p.x + Math.cos(a) * p.rx * d, p.y + Math.sin(a) * p.ry * d, R, R * 0.45, r() * 3, 0, TAU); g.fill();
    }
    // 빛줄기
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const x = p.x - p.rx * 0.5 + i * p.rx * 0.18, y = p.y - p.ry * 0.25 + i * 6;
      g.lineWidth = 3 - i * 0.7; g.beginPath(); g.moveTo(x, y); g.lineTo(x + p.rx * 0.22, y - p.ry * 0.2); g.stroke();
    }
    // 금
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 0.9;
    for (let i = 0; i < 5; i++) {
      let x = p.x + (r() - 0.5) * p.rx * 1.2, y = p.y + (r() - 0.5) * p.ry * 1.2, a = r() * TAU;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { a += (r() - 0.5) * 1.2; x += Math.cos(a) * 12; y += Math.sin(a) * 8; g.lineTo(x, y); }
      g.stroke();
    }
    g.restore();
    // 가장자리 눈 덩어리
    for (let i = 0; i < Math.round(10 + p.rx / 10); i++) {
      const a = r() * TAU, k = 1.0 + r() * 0.06, R = 5 + r() * 7;
      const x = p.x + Math.cos(a) * p.rx * k, y = p.y + Math.sin(a) * p.ry * k;
      g.fillStyle = 'rgba(150,180,215,0.4)'; g.beginPath(); g.ellipse(x + 1, y + 2, R, R * 0.45, 0, 0, TAU); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(x, y, R, R * 0.55, 0, 0, TAU); g.fill();
    }
  }

  function bakeChunk(world, ch) {
    const c = document.createElement('canvas');
    c.width = TILE; c.height = TILE;
    const g = c.getContext('2d');
    const x0 = ch.x0, y0 = ch.y0, bx0 = x0 - PAD, by0 = y0 - PAD, bx1 = x0 + CHUNK + PAD, by1 = y0 + CHUNK + PAD;
    g.translate(-bx0, -by0);
    const hits = (x, y, R) => x + R > bx0 && x - R < bx1 && y + R > by0 && y - R < by1;

    // 1) 바닥색
    const img = sampleG.createImageData(SN, SN);
    for (let j = 0; j < SN; j++) for (let i = 0; i < SN; i++) {
      const [R, G, B] = hexRgb(biomeAt(world, x0 - SAMPLE / 2 + SAMPLE * i, y0 - SAMPLE / 2 + SAMPLE * j).ground);
      const o = (j * SN + i) * 4; img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
    sampleG.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(sampleCv, x0 - SAMPLE, y0 - SAMPLE, SN * SAMPLE, SN * SAMPLE);

    // 이웃 조각까지 포함해 흩뿌리기 (조각마다 고정된 난수라 경계가 이어진다)
    const scatter = (salt, fn) => {
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const nx = ch.cx + i, ny = ch.cy + j;
        const r = mulberry32(hash2(world.seed, nx, ny, salt));
        const b = biomeAt(world, (nx + 0.5) * CHUNK, (ny + 0.5) * CHUNK);
        fn(r, nx * CHUNK, ny * CHUNK, b);
      }
    };
    const blob = (r, x, y, rx, ry, col) => { const a = r() * 3; if (!hits(x, y, rx)) return; g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, a, 0, TAU); g.fill(); };
    const feats = featuresInRect(world, bx0, by0, bx1, by1);
    const snowAt = (x, y) => biomeIdAt(world, x, y) === 'snow';
    const sandAt = (x, y) => biomeIdAt(world, x, y) === 'desert';
    const jungleAt = (x, y) => biomeIdAt(world, x, y) === 'jungle';
    const beachAt = (x, y) => biomeIdAt(world, x, y) === 'beach';

    // 2) 큰 색 얼룩 + 붓터치
    scatter(11, (r, ox, oy) => {
      const n = Math.floor(2.5 + r());
      for (let i = 0; i < n; i++) {
        const x = ox + r() * CHUNK, y = oy + r() * CHUNK, R = 120 + r() * 220, warm = r() < 0.5;
        if (!hits(x, y, R)) continue;
        const bid = biomeIdAt(world, x, y), sn = bid === 'snow', sd = bid === 'desert';
        const c0 = bid === 'jungle' ? (warm ? 'rgba(175,220,110,0.25)' : 'rgba(25,105,60,0.28)')
          : bid === 'beach' ? (warm ? 'rgba(255,252,232,0.32)' : 'rgba(225,195,135,0.14)')
          : sn ? (warm ? 'rgba(255,255,255,0.55)' : 'rgba(165,195,228,0.1)')
          : sd ? (warm ? 'rgba(255,240,205,0.3)' : 'rgba(215,160,100,0.16)')
          : (warm ? 'rgba(220,235,140,0.28)' : 'rgba(80,160,90,0.18)');
        const gr = g.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, c0); gr.addColorStop(1, c0.replace(/[\d.]+\)$/, '0)'));
        g.fillStyle = gr; g.fillRect(x - R, y - R, R * 2, R * 2);
      }
      for (let i = 0; i < 39; i++) {
        const x = ox + r() * CHUNK, y = oy + r() * CHUNK, rx = 10 + r() * 40, ry = 6 + r() * 22, light = r() < 0.5;
        if (!hits(x, y, rx)) { r(); continue; }
        const bid = biomeIdAt(world, x, y), sn = bid === 'snow', sd = bid === 'desert' || bid === 'beach';
        blob(r, x, y, rx, ry, bid === 'jungle' ? (light ? 'rgba(220,255,170,0.08)' : 'rgba(25,95,50,0.12)') : sn ? (light ? 'rgba(255,255,255,0.35)' : 'rgba(150,180,215,0.06)')
          : sd ? (light ? 'rgba(255,248,222,0.07)' : 'rgba(200,140,80,0.05)')
          : (light ? 'rgba(255,255,220,0.07)' : 'rgba(60,140,60,0.06)'));
      }
    });

    // 3) 숲 바닥 (진한 색 + 낙엽과 이끼)
    for (const f of feats) {
      if (f.kind !== 'forest') continue;
      const fg = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 1.15);
      if (f.oasis) { // 오아시스: 모래 위 초록 풀밭 + 풀 포기
        fg.addColorStop(0, 'rgba(140,205,105,0.95)'); fg.addColorStop(0.62, 'rgba(150,208,112,0.85)'); fg.addColorStop(0.9, 'rgba(170,200,120,0.25)'); fg.addColorStop(1, 'rgba(170,200,120,0)');
        g.fillStyle = fg; g.fillRect(f.x - f.r * 1.2, f.y - f.r * 1.2, f.r * 2.4, f.r * 2.4);
        const r = mulberry32(strSeed(f.id + 'oasis')), n = Math.round(900 * (f.r / 360) ** 2);
        g.lineWidth = 1.4; g.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const a = r() * TAU, d = Math.sqrt(r()) * f.r * 0.95, h = 5 + r() * 4, light = r() < 0.35, kind = r();
          const x = f.x + Math.cos(a) * d, y = f.y + Math.sin(a) * d;
          if (!hits(x, y, 8)) continue;
          if (kind < 0.12) { g.fillStyle = 'rgba(90,170,80,0.5)'; for (let l = 0; l < 3; l++) { const la = l * 2.1 + a; g.beginPath(); g.arc(x + Math.cos(la) * 2, y + Math.sin(la) * 2, 2, 0, TAU); g.fill(); } continue; }
          g.strokeStyle = light ? 'rgba(170,215,100,0.6)' : 'rgba(70,150,70,0.5)';
          g.beginPath(); g.moveTo(x - 3, y); g.quadraticCurveTo(x - 3, y - h * 0.5, x - 5, y - h * 0.7);
          g.moveTo(x, y); g.lineTo(x + 0.5, y - h); g.moveTo(x + 3, y); g.quadraticCurveTo(x + 3, y - h * 0.5, x + 5, y - h * 0.7); g.stroke();
        }
        continue;
      }
      if (f.beach) continue; // 바닷가 야자수 숲: 모래 그대로
      if (snowAt(f.x, f.y)) { // 겨울 숲: 그늘진 푸른 눈밭만
        fg.addColorStop(0, 'rgba(150,180,215,0.22)'); fg.addColorStop(1, 'rgba(150,180,215,0)');
        g.fillStyle = fg; g.fillRect(f.x - f.r * 1.2, f.y - f.r * 1.2, f.r * 2.4, f.r * 2.4);
        continue;
      }
      fg.addColorStop(0, 'rgba(40,110,60,0.38)'); fg.addColorStop(1, 'rgba(40,110,60,0)');
      g.fillStyle = fg; g.fillRect(f.x - f.r * 1.2, f.y - f.r * 1.2, f.r * 2.4, f.r * 2.4);
      const r = mulberry32(strSeed(f.id + 'floor')), n = Math.round(700 * (f.r / 430) ** 2);
      for (let i = 0; i < n; i++) {
        const a = r() * TAU, d = Math.sqrt(r()) * f.r;
        const x = f.x + Math.cos(a) * d, y = f.y + Math.sin(a) * d;
        if (r() < 0.6) {
          const col = ['#d9a05b', '#e8b86a', '#c97e4a', '#b9c46a'][Math.floor(r() * 4)], rot = r() * 3;
          if (!hits(x, y, 4)) continue;
          g.fillStyle = col; g.globalAlpha = 0.55;
          g.beginPath(); g.ellipse(x, y, 3, 1.6, rot, 0, TAU); g.fill();
          g.globalAlpha = 1;
        } else blob(r, x, y, 8 + r() * 14, 5 + r() * 8, 'rgba(70,140,70,0.22)');
      }
    }
    // 4) 마을 바닥: 흙 + 돌바닥 무늬
    for (const v of feats) {
      if (v.kind !== 'village') continue;
      const vc = { snow: '215,228,240', desert: '230,190,130', jungle: '200,170,110', beach: '245,225,180' }[v.biome] || '240,220,170';
      const vg = g.createRadialGradient(v.x, v.y, v.r * 0.3, v.x, v.y, v.r * 0.95);
      vg.addColorStop(0, `rgba(${vc},0.6)`); vg.addColorStop(1, `rgba(${vc},0)`);
      g.fillStyle = vg;
      g.beginPath(); g.ellipse(v.x, v.y, v.r * 0.95, v.r * 0.8, 0, 0, TAU); g.fill();
      const r = mulberry32(strSeed(v.id + 'floor'));
      for (let i = 0; i < 260; i++) {
        const a = r() * TAU, d = Math.sqrt(r()) * v.r * 0.55;
        blob(r, v.x + Math.cos(a) * d, v.y + Math.sin(a) * d * 0.85, 5 + r() * 4, 3.5 + r() * 2, 'rgba(200,180,140,0.35)');
      }
    }
    // 5) 클로버 · 풀 포기 · 조약돌
    scatter(12, (r, ox, oy) => {
      const nc = Math.floor(4.4 + r());
      for (let i = 0; i < nc; i++) {
        const cx = ox + r() * CHUNK, cy = oy + r() * CHUNK;
        if (jungleAt(cx, cy)) {
          // 밀림: 고사리 덤불 (잎줄기가 사방으로)
          const n = 5 + Math.floor(r() * 3), L0 = 10 + r() * 8;
          if (!hits(cx, cy, L0 + 6)) continue;
          for (let k = 0; k < n; k++) {
            const a = Math.PI + (k / (n - 1)) * Math.PI + (r() - 0.5) * 0.3, L = L0 * (0.75 + r() * 0.4);
            const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L * 0.6;
            g.strokeStyle = k % 2 ? 'rgba(60,140,70,0.75)' : 'rgba(80,165,80,0.75)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo((cx + ex) / 2, (cy + ey) / 2 - 4, ex, ey); g.stroke();
            g.fillStyle = k % 2 ? 'rgba(70,150,70,0.8)' : 'rgba(95,175,85,0.8)';
            for (let q = 1; q < 6; q++) {
              const u = q / 6, px = cx + (ex - cx) * u, py = cy + (ey - cy) * u - Math.sin(u * Math.PI) * 3, w = (1 - u) * 3 + 0.8;
              g.beginPath(); g.ellipse(px, py - w * 0.5, w, w * 0.45, a + 1.2, 0, TAU); g.fill();
              g.beginPath(); g.ellipse(px, py + w * 0.5, w, w * 0.45, a - 1.2, 0, TAU); g.fill();
            }
          }
          continue;
        }
        if (beachAt(cx, cy)) {
          // 바닷가: 조개 무리 · 불가사리 · 유목 · 해초
          const kind = r(), a = r() * TAU, ss = 0.8 + r() * 0.5;
          if (!hits(cx, cy, 20)) continue;
          if (kind < 0.35) {
            for (let k = 0; k < 3; k++) {
              const x = cx + (k - 1) * 7 * ss, y = cy + (k % 2) * 3, col = ['#ffd1c4', '#fff4e6', '#f9b8c9'][k];
              g.fillStyle = 'rgba(190,150,100,0.3)'; g.beginPath(); g.ellipse(x + 0.6, y + 1.2, 3.4 * ss, 1.3 * ss, 0, 0, TAU); g.fill();
              g.fillStyle = col; g.beginPath(); g.moveTo(x, y + 1.5 * ss); g.arc(x, y + 1.5 * ss, 3.6 * ss, Math.PI * 1.1, Math.PI * 1.9); g.closePath(); g.fill();
              g.strokeStyle = 'rgba(200,130,120,0.5)'; g.lineWidth = 0.5;
              for (let q = -2; q <= 2; q++) { g.beginPath(); g.moveTo(x, y + 1.5 * ss); g.lineTo(x + q * 1.4 * ss, y - 1.6 * ss); g.stroke(); }
            }
          } else if (kind < 0.55) {
            g.save(); g.translate(cx, cy); g.rotate(a); g.scale(ss, ss);
            g.fillStyle = 'rgba(190,140,90,0.3)'; starPath(g, 1, 1.4, 7, 3); g.fill();
            g.fillStyle = '#ff9a6e'; starPath(g, 0, 0, 7, 3); g.fill();
            g.fillStyle = 'rgba(255,240,220,0.8)'; for (let q = 0; q < 5; q++) { const qa = q * 1.2566 - 1.57; g.beginPath(); g.arc(Math.cos(qa) * 3.5, Math.sin(qa) * 3.5, 0.6, 0, TAU); g.fill(); }
            g.restore();
          } else if (kind < 0.75) {
            g.save(); g.translate(cx, cy); g.rotate(a * 0.3 - 0.15);
            g.fillStyle = 'rgba(160,120,80,0.3)'; g.beginPath(); g.ellipse(1, 2, 16 * ss, 2.6, 0, 0, TAU); g.fill();
            g.fillStyle = '#c9ab88'; g.beginPath(); g.ellipse(0, 0, 15 * ss, 2.6, 0, 0, TAU); g.fill();
            g.fillStyle = '#ddc4a4'; g.beginPath(); g.ellipse(-2, -0.8, 12 * ss, 1, 0, 0, TAU); g.fill();
            g.strokeStyle = 'rgba(130,100,70,0.5)'; g.lineWidth = 0.5; g.beginPath(); g.moveTo(-10 * ss, 0.5); g.lineTo(8 * ss, 0.2); g.stroke();
            g.restore();
          } else {
            g.strokeStyle = 'rgba(70,140,90,0.6)'; g.lineWidth = 1.4; g.lineCap = 'round';
            for (let k = 0; k < 4; k++) { const x = cx + (k - 1.5) * 4; g.beginPath(); g.moveTo(x, cy); g.bezierCurveTo(x + 4, cy - 3, x - 4, cy - 6, x + 2, cy - 9 - k); g.stroke(); }
          }
          continue;
        }
        if (sandAt(cx, cy) && !snowAt(cx, cy)) {
          // 사막: 바람이 만든 모래 물결 (밝은 능선 + 아래 그늘)
          const n = 3 + Math.floor(r() * 3), len = 30 + r() * 40, tilt = (r() - 0.5) * 0.4;
          for (let k = 0; k < n; k++) {
            const x = cx + (r() - 0.5) * 10, y = cy + k * (5 + r() * 2), L = len * (0.6 + r() * 0.4);
            if (!hits(x, y, L)) continue;
            const wave = (dy, col, w) => {
              g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x - L / 2, y + dy - tilt * L / 2);
              g.bezierCurveTo(x - L / 6, y + dy - 3 - tilt * L / 6, x + L / 6, y + dy + 3 + tilt * L / 6, x + L / 2, y + dy + tilt * L / 2); g.stroke();
            };
            g.lineCap = 'round';
            wave(1.4, 'rgba(195,145,85,0.14)', 2.2);
            wave(0, 'rgba(255,248,226,0.38)', 1.4);
          }
          continue;
        }
        if (snowAt(cx, cy)) {
          // 겨울: 클로버 대신 눈 더미 (아래 파란 그늘 + 하얀 언덕 + 반짝)
          const n = 3 + Math.floor(r() * 3);
          for (let k = 0; k < n; k++) {
            const x = cx + (r() - 0.5) * 50, y = cy + (r() - 0.5) * 20, R = 7 + r() * 9;
            if (!hits(x, y, R + 4)) continue;
            g.fillStyle = 'rgba(150,180,215,0.35)'; g.beginPath(); g.ellipse(x + 1, y + R * 0.3, R * 1.1, R * 0.4, 0, 0, TAU); g.fill();
            g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(x, y, R, R * 0.5, 0, Math.PI, TAU); g.ellipse(x, y, R, R * 0.18, 0, 0, Math.PI); g.fill();
            g.fillStyle = 'rgba(200,225,250,0.7)'; g.beginPath(); g.ellipse(x - R * 0.3, y - R * 0.3, R * 0.25, R * 0.1, -0.3, 0, TAU); g.fill();
          }
          continue;
        }
        for (let k = 0; k < 7; k++) {
          const x = cx + (r() - 0.5) * 40, y = cy + (r() - 0.5) * 24, a0 = r(), white = r() < 0.12;
          if (!hits(x, y, 6)) continue;
          g.fillStyle = 'rgba(90,170,80,0.5)';
          for (let l = 0; l < 3; l++) { const la = l * 2.1 + a0; g.beginPath(); g.arc(x + Math.cos(la) * 2, y + Math.sin(la) * 2, 2, 0, TAU); g.fill(); }
          if (white) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y - 3, 2.2, 0, TAU); g.fill(); }
        }
      }
      g.lineWidth = 1.5; g.lineCap = 'round';
      for (let i = 0; i < 125; i++) {
        const x = ox + r() * CHUNK, y = oy + r() * CHUNK, h = 5 + r() * 4, light = r() >= 0.7;
        if (!hits(x, y, 10)) continue;
        const gb = biomeIdAt(world, x, y);
        if (gb === 'jungle') {
          if (i % 6 === 0) { // 떨어진 큰 잎
            const a = (i * 2.4) % TAU, col = ['rgba(200,190,90,0.6)', 'rgba(110,170,70,0.6)', 'rgba(190,130,70,0.5)'][i % 3];
            g.save(); g.translate(x, y); g.rotate(a);
            g.fillStyle = col; g.beginPath(); g.moveTo(-5, 0); g.quadraticCurveTo(0, -3.4, 5, 0); g.quadraticCurveTo(0, 3.4, -5, 0); g.fill();
            g.strokeStyle = 'rgba(80,90,40,0.4)'; g.lineWidth = 0.5; g.beginPath(); g.moveTo(-5, 0); g.lineTo(5, 0); g.stroke();
            g.restore(); g.lineWidth = 1.5;
            continue;
          }
          g.strokeStyle = light ? 'rgba(120,190,80,0.55)' : 'rgba(40,120,60,0.5)';
          g.beginPath();
          g.moveTo(x - 3, y); g.quadraticCurveTo(x - 3, y - h * 0.6, x - 6, y - h * 0.9);
          g.moveTo(x, y); g.lineTo(x + 0.5, y - h * 1.2);
          g.moveTo(x + 3, y); g.quadraticCurveTo(x + 3, y - h * 0.6, x + 6, y - h * 0.9);
          g.stroke();
          continue;
        }
        if (gb === 'beach') {
          if (i % 6 === 0) { g.fillStyle = ['#ffd6cc', '#fff8ee', '#f5c9a8'][i % 3]; g.beginPath(); g.arc(x, y, 1.4, Math.PI, TAU); g.fill(); }
          else if (i % 6 === 1) { g.fillStyle = 'rgba(255,255,250,0.95)'; g.fillRect(x - 0.6, y - 0.6, 1.2, 1.2); }
          else if (i % 6 === 2) { g.fillStyle = 'rgba(200,170,120,0.3)'; g.beginPath(); g.ellipse(x, y, 1.2 + h * 0.1, 0.8, 0, 0, TAU); g.fill(); }
          continue;
        }
        if (sandAt(x, y) && !snowAt(x, y)) {
          if (i % 5 === 0) { // 마른 풀 포기
            g.strokeStyle = 'rgba(190,150,80,0.65)'; g.lineWidth = 1.1;
            g.beginPath(); g.moveTo(x - 2, y); g.quadraticCurveTo(x - 3, y - h * 0.4, x - 5, y - h * 0.6);
            g.moveTo(x, y); g.lineTo(x + 0.3, y - h * 0.8); g.moveTo(x + 2, y); g.quadraticCurveTo(x + 3, y - h * 0.4, x + 5, y - h * 0.55); g.stroke();
            g.lineWidth = 1.5;
          } else if (i % 5 === 1) { // 반짝이는 모래알
            g.fillStyle = 'rgba(255,252,235,0.9)'; g.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
          } else if (i % 5 === 2) { g.fillStyle = 'rgba(190,130,80,0.3)'; g.beginPath(); g.ellipse(x, y, 1.2 + h * 0.12, 0.9, 0, 0, TAU); g.fill(); }
          else if (i % 25 === 3) { // 꼬마 공 선인장
            const R = 2.6 + h * 0.15;
            g.fillStyle = 'rgba(160,110,60,0.3)'; g.beginPath(); g.ellipse(x + 0.5, y + 0.6, R * 1.2, R * 0.45, 0, 0, TAU); g.fill();
            g.fillStyle = '#5faa66'; g.beginPath(); g.ellipse(x, y - R * 0.7, R, R * 0.9, 0, 0, TAU); g.fill();
            g.strokeStyle = 'rgba(40,110,60,0.45)'; g.lineWidth = 0.5;
            for (let l = -1; l <= 1; l++) { g.beginPath(); g.moveTo(x + l * R * 0.45, y - R * 1.5); g.quadraticCurveTo(x + l * R * 0.75, y - R * 0.7, x + l * R * 0.45, y); g.stroke(); }
            g.fillStyle = 'rgba(220,255,200,0.4)'; g.beginPath(); g.ellipse(x - R * 0.35, y - R * 1.1, R * 0.3, R * 0.2, -0.4, 0, TAU); g.fill();
            if (h > 7) { g.fillStyle = '#ff8fb3'; for (let l = 0; l < 5; l++) { const la = l * 1.26; g.beginPath(); g.arc(x + Math.cos(la) * 1, y - R * 1.6 + Math.sin(la) * 1, 0.9, 0, TAU); g.fill(); } }
            g.lineWidth = 1.5;
          }
          continue;
        }
        if (snowAt(x, y)) {
          if (i % 4 === 0) { // 눈 밖으로 삐죽 나온 마른 풀
            g.strokeStyle = 'rgba(170,140,100,0.6)'; g.lineWidth = 1.1;
            g.beginPath(); g.moveTo(x - 2, y); g.lineTo(x - 3, y - h * 0.6); g.moveTo(x + 1, y); g.lineTo(x + 1.5, y - h * 0.8); g.stroke();
            g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(x, y, 4, 1.4, 0, 0, TAU); g.fill();
            g.lineWidth = 1.5;
          } else if (i % 4 === 1) { // 반짝이는 눈 결정
            g.fillStyle = 'rgba(255,255,255,0.95)'; g.fillRect(x - 1.5, y - 0.3, 3, 0.6); g.fillRect(x - 0.3, y - 1.5, 0.6, 3);
          } else { g.fillStyle = 'rgba(160,190,225,0.22)'; g.beginPath(); g.ellipse(x, y, 2.5 + h * 0.3, 1.2, 0, 0, TAU); g.fill(); }
          continue;
        }
        g.strokeStyle = light ? 'rgba(150,200,90,0.5)' : 'rgba(70,150,70,0.45)';
        g.beginPath();
        g.moveTo(x - 3, y); g.quadraticCurveTo(x - 3, y - h * 0.5, x - 5, y - h * 0.7);
        g.moveTo(x, y); g.lineTo(x + 0.5, y - h);
        g.moveTo(x + 3, y); g.quadraticCurveTo(x + 3, y - h * 0.5, x + 5, y - h * 0.7);
        g.stroke();
      }
      for (let i = 0; i < 14; i++) { const x = ox + r() * CHUNK, y = oy + r() * CHUNK; blob(r, x, y, 1.5 + r() * 2, 1 + r() * 1.5, snowAt(x, y) ? 'rgba(130,150,175,0.35)' : sandAt(x, y) || beachAt(x, y) ? 'rgba(180,130,85,0.3)' : 'rgba(150,150,140,0.35)'); }
    });

    // 6) 길: 부드러운 가장자리 + 자갈 + 삐져나온 풀
    g.lineCap = 'round'; g.lineJoin = 'round';
    world.paths.forEach((p, pi) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of p) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      if (maxX + 40 < bx0 || minX - 40 > bx1 || maxY + 40 < by0 || minY - 40 > by1) return;
      const pathLine = () => { g.beginPath(); g.moveTo(...p[0]); for (let i = 1; i < p.length; i++) g.lineTo(...p[i]); g.stroke(); };
      for (const [w, col] of [[52, 'rgba(150,170,90,0.35)'], [44, '#d8bf88'], [36, '#ead6a4'], [26, '#f0dfb2']]) { g.strokeStyle = col; g.lineWidth = w; pathLine(); }
      const r = mulberry32(world.seed * 31 + pi * 977);
      for (let k = 1; k < p.length; k++) {
        const [x1, y1] = p[k - 1], [x2, y2] = p[k];
        const len = Math.hypot(x2 - x1, y2 - y1);
        for (let d = 0; d < len; d += 9) {
          const u = d / len, ox = (r() - 0.5) * 34, oy = (r() - 0.5) * 34;
          if (r() < 0.5) blob(r, x1 + (x2 - x1) * u + ox, y1 + (y2 - y1) * u + oy, 1.6 + r() * 1.6, 1.2 + r(), 'rgba(170,140,100,0.45)');
        }
        g.strokeStyle = 'rgba(90,160,80,0.55)'; g.lineWidth = 1.4;
        for (let d = 0; d < len; d += 6) {
          const u = d / len, nx = -(y2 - y1) / len, ny = (x2 - x1) / len, side = r() < 0.5 ? -1 : 1;
          const off = 17 + r() * 4, x = x1 + (x2 - x1) * u + nx * side * off, y = y1 + (y2 - y1) * u + ny * side * off;
          const jx = (r() - 0.5) * 3, jy = 4 + r() * 3;
          if (!hits(x, y, 8)) continue;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + jx, y - jy); g.stroke();
        }
      }
    });

    // 7) 연못: 젖은 모래 → 얕은 물 → 깊은 물 + 연잎 + 갈대
    for (const p of feats) {
      if (p.kind !== 'pond') continue;
      const r = mulberry32(strSeed(p.id + 'pond'));
      if (p.ice) { paintIcePond(g, p, r); continue; }
      if (p.oasis) { // 오아시스 샘: 초록 풀 둑 → 젖은 모래 → 청록 물
        g.fillStyle = 'rgba(120,190,90,0.9)'; g.beginPath(); g.ellipse(p.x, p.y, p.rx + 34, p.ry + 28, 0, 0, TAU); g.fill();
        g.fillStyle = '#93d07a'; g.beginPath(); g.ellipse(p.x, p.y, p.rx + 24, p.ry + 20, 0, 0, TAU); g.fill();
      }
      g.fillStyle = p.oasis ? '#f0d9a2' : '#efdcaa';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx + 14, p.ry + 12, 0, 0, TAU); g.fill();
      if (!p.oasis) { g.beginPath(); g.ellipse(p.x, p.y, p.rx + 20, p.ry + 18, 0, 0, TAU); g.fill(); }
      g.fillStyle = p.oasis ? '#d9b97c' : '#d9c08a';
      g.beginPath(); g.ellipse(p.x, p.y, p.rx + 8, p.ry + 7, 0, 0, TAU); g.fill();
      const wg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(p.rx, p.ry));
      if (p.oasis) { wg.addColorStop(0, '#29a9bd'); wg.addColorStop(0.65, '#4fc6cf'); wg.addColorStop(1, '#93e2da'); }
      else { wg.addColorStop(0, '#5fb3dd'); wg.addColorStop(0.7, '#7cc9ea'); wg.addColorStop(1, '#a6e0f2'); }
      g.fillStyle = wg;
      g.save(); g.translate(p.x, p.y); g.scale(1, p.ry / p.rx); g.translate(-p.x, -p.y);
      g.beginPath(); g.arc(p.x, p.y, p.rx, 0, TAU); g.fill();
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(p.x, p.y, p.rx - 4, p.ry - 4, 0, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
      const lilies = Math.round(4 + p.rx / 30);
      for (let i = 0; i < lilies; i++) {
        const a = r() * TAU, d = 0.3 + r() * 0.55;
        const x = p.x + Math.cos(a) * p.rx * d, y = p.y + Math.sin(a) * p.ry * d, R = 8 + r() * 6, flower = r() < 0.4;
        g.fillStyle = 'rgba(30,90,120,0.25)';
        g.beginPath(); g.ellipse(x + 2, y + 2, R, R * 0.8, 0, 0, TAU); g.fill();
        g.fillStyle = '#6cbf6a';
        g.beginPath(); g.arc(x, y, R, 0.3, TAU - 0.3); g.lineTo(x, y); g.fill();
        g.strokeStyle = 'rgba(60,140,60,0.7)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - R * 0.7, y - R * 0.3); g.moveTo(x, y); g.lineTo(x - R * 0.4, y + R * 0.6); g.stroke();
        if (flower) {
          g.fillStyle = '#ffb3d1'; for (let k = 0; k < 5; k++) { const ka = k * 1.256; g.beginPath(); g.ellipse(x + 2 + Math.cos(ka) * 2.5, y - 2 + Math.sin(ka) * 2.5, 2.4, 1.4, ka, 0, TAU); g.fill(); }
          g.fillStyle = '#ffe680'; g.beginPath(); g.arc(x + 2, y - 2, 1.4, 0, TAU); g.fill();
        }
      }
      const reeds = Math.round(8 + p.rx / 12);
      for (let i = 0; i < reeds; i++) {
        const a = r() * TAU, k = 1.02 + r() * 0.08;
        const x = p.x + Math.cos(a) * p.rx * k, y = p.y + Math.sin(a) * p.ry * k;
        g.strokeStyle = '#6aa05a'; g.lineWidth = 1.6;
        for (let l = 0; l < 3; l++) { const hh = 14 + r() * 6; g.beginPath(); g.moveTo(x + l * 2 - 2, y); g.quadraticCurveTo(x + l * 2 - 2, y - 8, x + l * 3 - 3, y - hh); g.stroke(); }
        if (r() < 0.5) { g.fillStyle = '#8a5a3a'; g.beginPath(); g.ellipse(x, y - 17, 1.8, 4, 0, 0, TAU); g.fill(); }
      }
    }
    // 8) 바다: 젖은 모래 → 얕은 물 → 깊은 물 (해안선을 따라 띠를 겹쳐 칠한다)
    if (bx0 < 1500) {
      const ys = [];
      for (let y = by0 - 10; y <= by1 + 10; y += 8) ys.push([y, coastX(world, y)]);
      if (Math.min(...ys.map((p) => p[1])) - 260 < bx1) {
        const band = (off, col) => {
          g.fillStyle = col; g.beginPath(); g.moveTo(bx0 - 10, ys[0][0]);
          for (const [y, cx] of ys) g.lineTo(cx + off(y), y);
          g.lineTo(bx0 - 10, ys[ys.length - 1][0]); g.closePath(); g.fill();
        };
        const wob = (k) => (y) => Math.sin(y * 0.02 + k) * 4;
        band((y) => 46 + wob(1)(y), 'rgba(230,205,150,0.5)');
        band((y) => 26 + wob(2)(y), '#ead39e');
        band(() => 0, '#a5e2e6');
        band((y) => -14 + wob(3)(y), '#7fd2e0');
        band((y) => -60 + wob(4)(y) * 3, '#5cbfdc');
        band((y) => -150 + wob(5)(y) * 5, '#46a9d4');
        band((y) => -320 + wob(6)(y) * 6, '#3994c8');
        // 물속 모래톱 얼룩
        const r = mulberry32(hash2(world.seed, ch.cx, ch.cy, 21));
        for (let i = 0; i < 6; i++) {
          const y = by0 + r() * (by1 - by0), x = coastX(world, y) - 30 - r() * 120, R = 14 + r() * 26;
          if (!hits(x, y, R)) continue;
          g.fillStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.ellipse(x, y, R, R * 0.4, 0, 0, TAU); g.fill();
        }
      }
    }
    return c;
  }

  const ripples = [];
  function drawWaterShimmer(ponds, view, dt) {
    ctx.lineCap = 'round';
    for (const p of ponds) {
      if (p.x + p.rx < view.x0 || p.x - p.rx > view.x1 || p.y + p.ry < view.y0 || p.y - p.ry > view.y1) continue;
      if (p.ice) {
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 8; i++) {
          const k = Math.sin(t * 1.3 + i * 2.7 + p.x);
          if (k < 0.9) continue;
          ctx.globalAlpha = (k - 0.9) * 10;
          const a = i * 2.1 + p.y;
          star(p.x + Math.cos(a) * p.rx * 0.6, p.y + Math.sin(a) * p.ry * 0.6, 3.5);
        }
        ctx.globalAlpha = 1;
        continue;
      }
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
  // ---- 바다: 밀려왔다 빠지는 파도, 먼바다 물결, 반짝임 ----
  function drawSea(world, view, dt) {
    if (view.x0 > 1500) return;
    const ys = [];
    for (let y = Math.floor(view.y0 / 6) * 6; y <= view.y1; y += 6) ys.push([y, coastX(world, y)]);
    if (Math.min(...ys.map((p) => p[1])) - 400 > view.x1) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 파도 두 줄: 해안을 따라 조금씩 다른 박자로 밀려왔다 빠진다
    for (const [period, k, amp] of [[6.5, 0, 26], [6.5, 0.5, 16]]) {
      const ext = (y) => {
        const u = (((t + Math.sin(y * 0.004) * 1.2) / period + k) % 1 + 1) % 1;
        return u < 0.55 ? Math.sin((u / 0.55) * Math.PI * 0.5) * amp : Math.cos(((u - 0.55) / 0.45) * Math.PI * 0.5) * amp;
      };
      const fade = (y) => { const u = (((t + Math.sin(y * 0.004) * 1.2) / period + k) % 1 + 1) % 1; return u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45 * 0.8; };
      ctx.fillStyle = 'rgba(150,220,235,0.45)';
      ctx.beginPath(); ctx.moveTo(ys[0][1] - 20, ys[0][0]);
      for (const [y, cx] of ys) ctx.lineTo(cx + ext(y), y);
      for (let i = ys.length - 1; i >= 0; i--) ctx.lineTo(ys[i][1] - 20, ys[i][0]);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.6;
      ctx.globalAlpha = 0.85 * fade(ys[0][0]);
      ctx.beginPath(); ys.forEach(([y, cx], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, cx + ext(y), y)); ctx.stroke();
      ctx.globalAlpha = 0.35; ctx.lineWidth = 1.2;
      ctx.beginPath(); ys.forEach(([y, cx], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, cx + ext(y) - 6, y + 2)); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 먼바다에서 다가오는 물결 줄
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.6;
    for (let w = 0; w < 4; w++) {
      const off = 40 + ((w * 60 - t * 12) % 240 + 240) % 240;
      ctx.globalAlpha = Math.min(1, (240 - off) / 60) * Math.min(1, (off - 30) / 30) * 0.6;
      if (ctx.globalAlpha <= 0.02) continue;
      for (let i = 0; i < ys.length - 3; i += 7) {
        const [y1, c1] = ys[i], [y2, c2] = ys[i + 3];
        ctx.beginPath(); ctx.moveTo(c1 - off, y1); ctx.quadraticCurveTo((c1 + c2) / 2 - off - 3, (y1 + y2) / 2, c2 - off, y2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // 반짝임
    ctx.fillStyle = '#fff';
    for (let i = 0; i < ys.length; i += 3) {
      const [y, cx] = ys[i], k = Math.sin(t * 2.2 + i * 1.7);
      if (k < 0.8) continue;
      ctx.globalAlpha = (k - 0.8) * 5;
      star(cx - 50 - ((i * 37) % 200), y, 3);
    }
    ctx.globalAlpha = 1;
  }

  // ---- 밀림: 나뭇잎 사이로 비치는 햇살 줄기 ----
  function lightShafts(night) {
    const a = jK * (1 - night) * 0.05;
    if (a < 0.005) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const x = ((i * 0.31 + 0.1) % 1) * W + Math.sin(t * 0.07 + i) * 40, w = 40 + (i % 2) * 30;
      const k = 0.6 + 0.4 * Math.sin(t * 0.3 + i * 2);
      const gr = ctx.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, `rgba(255,250,200,${a * k})`); gr.addColorStop(1, 'rgba(255,250,200,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w - H * 0.35, H); ctx.lineTo(x - H * 0.35, H); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
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
    if (r.snow) stamp(sprite('rockS' + v, 26, 20, 13, 12, () => { paintRock(v, true); paintRockSnow(); }), r.x, r.y, r.s);
    else if (r.sand) stamp(sprite('rockD' + v, 28, 22, 14, 13, () => paintSandRock(v)), r.x, r.y, r.s);
    else stamp(sprite('rock' + v, 26, 20, 13, 12, () => paintRock(v)), r.x, r.y, r.s);
  }
  function paintRockSnow() {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(-0.5, -2.8, 8.6, 4.4, 0, Math.PI * 1.02, TAU * 0.99); ctx.fill();
    for (const [x, R] of [[-7, 2], [-3.5, 2.4], [1, 2.6], [5.5, 2.2]]) { ctx.beginPath(); ctx.ellipse(x, -3, R, R * 0.8, 0, 0, TAU); ctx.fill(); }
    ctx.fillStyle = 'rgba(170,200,230,0.5)'; ctx.beginPath(); ctx.ellipse(0, -1.6, 8, 1.1, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(170,200,230,0.55)'; ctx.beginPath(); ctx.ellipse(0, 6.5, 12, 2.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff'; for (const [x, R] of [[-9, 2.6], [8.5, 2.4]]) { ctx.beginPath(); ctx.ellipse(x, 5.2, R, R * 0.6, 0, 0, TAU); ctx.fill(); }
  }
  // 사막 바위: 붉은 사암 줄무늬 + 발치에 쌓인 모래
  function paintSandRock(v) {
    const r = mulberry32(600 + v);
    ctx.fillStyle = 'rgba(240,215,160,0.9)'; ctx.beginPath(); ctx.ellipse(0, 5.6, 12.5, 2.6, 0, 0, TAU); ctx.fill();
    const w = v === 1 ? 8.5 : 10.5, h = v === 2 ? 9 : 7.2;
    ctx.fillStyle = '#c47f52'; ctx.beginPath(); ctx.ellipse(0, 0.6, w + 0.3, h + 0.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#dd9a66'; ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#efb985'; ctx.beginPath(); ctx.ellipse(-1.5, -h * 0.35, w * 0.65, h * 0.5, 0, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, TAU); ctx.clip();
    ctx.strokeStyle = 'rgba(170,95,55,0.4)'; ctx.lineWidth = 0.7;
    for (let i = 0; i < 4; i++) { const y = -h + 3 + i * (h * 0.5) + r(); ctx.beginPath(); ctx.moveTo(-w, y); ctx.quadraticCurveTo(0, y + 1.2 - r() * 2, w, y + 0.5); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,240,215,0.25)'; ctx.fillRect(-w, -h * 0.15, w * 2, 1);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,245,225,0.55)'; ctx.beginPath(); ctx.ellipse(-w * 0.4, -h * 0.55, 2.4, 1.1, -0.3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f3dba4'; for (const [x, R] of [[-w + 1, 2.6], [w - 1.5, 2.2], [1, 2]]) { ctx.beginPath(); ctx.ellipse(x, h - 1.2, R * 1.4, R * 0.6, 0, 0, TAU); ctx.fill(); }
  }
  function paintRock(v, snowy) {
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
    if (v !== 2 && !snowy) {
      ctx.fillStyle = '#86c46e';
      for (let i = 0; i < 6; i++) circle(-8 + i * 1.6 + r(), 3 + r() * 1.5, 1.2 + r() * 0.6);
      ctx.fillStyle = 'rgba(200,240,170,0.6)'; circle(-6, 2.6, 0.6); circle(-3, 3, 0.5);
    }
    // 돌 옆 풀
    if (snowy) return;
    ctx.strokeStyle = '#6fbf5a'; ctx.lineWidth = 0.8;
    for (const x of [8.5, 10, 11]) { ctx.beginPath(); ctx.moveTo(x, 5); ctx.lineTo(x + r() - 0.5, 1); ctx.stroke(); }
  }

  // ================= 나무와 집 =================
  function drawTree(tr, z) {
    const s = tr.size;
    const sway = Math.sin(t * 0.9 + tr.phase) * 1.5 + Math.sin(t * 2.3 + tr.phase * 2) * 0.4;
    const sw = tr.kind === 'saguaro' ? 12 : tr.kind === 'prickly' ? 15 : tr.kind === 'palm' ? 17 : tr.kind === 'jtree' ? 30 : tr.kind === 'banana' ? 18 : 22;
    shadow(tr.x, tr.y, sw * s, (sw / 2.75) * s, 1.6);
    // 좀비가 나무 뒤에 있으면 반투명하게
    const behind = z.y < tr.y && z.y > tr.y - 70 * s && Math.abs(z.x - tr.x) < 30 * s;
    const v = Math.floor(tr.phase * 7) % 3, fruit = tr.kind !== 'pine' && tr.phase > 4.5;
    const spr = tr.kind === 'pine' ? sprite('pine' + v, 70, 90, 35, 84, () => paintPine(v))
      : tr.kind === 'snowpine' ? sprite('snowpine' + v, 70, 92, 35, 86, () => paintPine(v, true))
      : tr.kind === 'bare' ? sprite('bare' + v, 76, 80, 38, 74, () => paintBareTree(v))
      : tr.kind === 'saguaro' ? sprite('sag' + v + fruit, 64, 100, 32, 94, () => paintSaguaro(v, fruit))
      : tr.kind === 'prickly' ? sprite('prick' + v + fruit, 52, 50, 26, 46, () => paintPrickly(v, fruit))
      : tr.kind === 'palm' ? sprite('palm' + v, 110, 100, 55, 94, () => paintPalm(v))
      : tr.kind === 'jtree' ? sprite('jtree' + v + fruit, 104, 104, 52, 98, () => paintJungleTree(v, fruit))
      : tr.kind === 'banana' ? sprite('banana' + v, 80, 70, 40, 64, () => paintBanana(v))
      : sprite('tree' + v + fruit, 76, 78, 38, 72, () => paintRoundTree(v, fruit));
    // 바람: 뿌리는 고정, 위로 갈수록 더 흔들림 (기울이기)
    ctx.save();
    ctx.translate(tr.x, tr.y);
    ctx.transform(1, 0, -sway / 55, 1, 0, 0);
    if (behind) ctx.globalAlpha = 0.45;
    stamp(spr, 0, 0, s);
    ctx.restore();
  }
  // ---- 사막 나무들 ----
  // 기둥 선인장: 굵은 몸통 + 위로 꺾인 팔, 세로 골과 작은 가시
  function paintSaguaro(v, flower) {
    const r = mulberry32(91 + v);
    const H = 70 + v * 6, G = '#62b06c', D = '#4a9659';
    ctx.fillStyle = 'rgba(200,160,100,0.4)'; ctx.beginPath(); ctx.ellipse(0, 1, 11, 2.8, 0, 0, TAU); ctx.fill();
    const arm = (side, y0, out, up, w) => {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const path = () => { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(side * (out - 2), y0); ctx.quadraticCurveTo(side * out, y0, side * out, y0 - 4); ctx.lineTo(side * out, y0 - up); };
      ctx.strokeStyle = D; ctx.lineWidth = w + 1; path(); ctx.stroke();
      ctx.strokeStyle = G; ctx.lineWidth = w; path(); ctx.stroke();
      ctx.strokeStyle = 'rgba(220,255,210,0.3)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(side * out - w * 0.25, y0 - 5); ctx.lineTo(side * out - w * 0.25, y0 - up + 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(30,90,50,0.3)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(side * out, y0 - 5); ctx.lineTo(side * out, y0 - up + 1); ctx.stroke();
      return [side * out, y0 - up - w / 2];
    };
    const tips = [];
    if (v !== 2) tips.push(arm(-1, -H * 0.42, 13, 20 + v * 3, 8));
    tips.push(arm(1, -H * 0.58, 12, 15, 7.5));
    // 몸통
    ctx.fillStyle = D; rr(-7, -H, 14, H + 1, 7);
    ctx.fillStyle = G; rr(-6.6, -H, 13, H, 6.5);
    ctx.fillStyle = 'rgba(30,90,50,0.22)'; rr(1.8, -H + 2, 4.6, H - 2, 3);
    ctx.fillStyle = 'rgba(225,255,215,0.3)'; rr(-4.6, -H + 4, 2.2, H - 10, 1.1);
    ctx.strokeStyle = 'rgba(35,100,55,0.35)'; ctx.lineWidth = 0.7;
    for (const x of [-2.6, 0.4, 3.4]) { ctx.beginPath(); ctx.moveTo(x, -H + 4); ctx.lineTo(x, -2); ctx.stroke(); }
    // 가시
    ctx.strokeStyle = 'rgba(255,252,230,0.85)'; ctx.lineWidth = 0.45;
    for (let i = 0; i < 30; i++) {
      const x = [-4, -1.1, 1.9, 4.9][Math.floor(r() * 4)], y = -H + 6 + r() * (H - 10);
      ctx.beginPath(); ctx.moveTo(x - 0.9, y - 0.5); ctx.lineTo(x + 0.9, y + 0.5); ctx.moveTo(x - 0.9, y + 0.5); ctx.lineTo(x + 0.9, y - 0.5); ctx.stroke();
    }
    // 발치 모래
    ctx.fillStyle = '#f3dba4'; for (const [x, R] of [[-7, 3.2], [-2, 2.6], [5, 3], [8.5, 2.4]]) { ctx.beginPath(); ctx.ellipse(x, 0.8, R * 1.3, R * 0.55, 0, 0, TAU); ctx.fill(); }
    // 꽃 (가끔)
    if (flower) for (const [x, y] of [[0, -H - 1], ...tips]) {
      ctx.fillStyle = '#fff4f0'; for (let k = 0; k < 5; k++) { const a = k * 1.26 - 1.57; ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 1.8, y + Math.sin(a) * 1.3, 1.5, 1, a, 0, TAU); ctx.fill(); }
      ctx.fillStyle = '#ffd34d'; circle(x, y, 0.9);
    }
  }
  // 부채 선인장: 동글납작한 잎이 겹겹이, 가끔 분홍 열매
  function paintPrickly(v, fruit) {
    const r = mulberry32(131 + v);
    ctx.fillStyle = 'rgba(200,160,100,0.4)'; ctx.beginPath(); ctx.ellipse(0, 0.5, 13, 3, 0, 0, TAU); ctx.fill();
    const pads = [[0, -9, 8, 9.5, 0], [-8, -20, 6.2, 7.8, -0.45], [7.5, -22, 6.6, 8.2, 0.35], [v ? -1 : 1, -31, 5.6, 7, v ? -0.15 : 0.2]];
    if (v === 2) pads.push([-13, -31, 4.6, 5.8, -0.7]);
    for (const [x, y, rx, ry, a] of pads) {
      ctx.fillStyle = '#4a9659'; ctx.beginPath(); ctx.ellipse(x + 0.5, y + 0.6, rx, ry, a, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6fbf74'; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, a, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(30,90,50,0.18)'; ctx.beginPath(); ctx.ellipse(x + rx * 0.3, y + ry * 0.2, rx * 0.6, ry * 0.75, a, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(225,255,215,0.35)'; ctx.beginPath(); ctx.ellipse(x - rx * 0.35, y - ry * 0.35, rx * 0.3, ry * 0.25, a - 0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,250,225,0.9)';
      for (let k = 0; k < 6; k++) circle(x + (r() - 0.5) * rx * 1.3, y + (r() - 0.5) * ry * 1.3, 0.45);
    }
    if (fruit) {
      for (const [x, y, rx, ry, a] of pads.slice(1)) {
        const fx = x + Math.sin(a) * ry * 0.9, fy = y - Math.cos(a) * ry * 0.95;
        ctx.fillStyle = '#c8406a'; ctx.beginPath(); ctx.ellipse(fx + 0.3, fy + 0.3, 1.9, 2.5, a, 0, TAU); ctx.fill();
        ctx.fillStyle = '#e8628a'; ctx.beginPath(); ctx.ellipse(fx, fy, 1.8, 2.4, a, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; circle(fx - 0.6, fy - 0.8, 0.5);
      }
    }
    ctx.fillStyle = '#f3dba4'; for (const [x, R] of [[-8, 2.8], [-3, 2.2], [6, 2.8]]) { ctx.beginPath(); ctx.ellipse(x, 0.6, R * 1.3, R * 0.55, 0, 0, TAU); ctx.fill(); }
  }
  // 야자수: 마디진 휜 줄기 + 늘어진 잎 + 코코넛
  function paintPalm(v) {
    const r = mulberry32(171 + v);
    const lean = [-1, 1, 0.5][v] * 14, N = 12, top = -60 - v * 4;
    const P = (i) => { const u = i / N; return [lean * u * u, top * u]; };
    ctx.fillStyle = 'rgba(60,110,50,0.25)'; ctx.beginPath(); ctx.ellipse(0, 1, 10, 2.6, 0, 0, TAU); ctx.fill();
    for (let i = 0; i <= N; i++) {
      const [x, y] = P(i), w = 5 - i * 0.14;
      ctx.fillStyle = '#a77b4f'; ctx.beginPath(); ctx.ellipse(x, y + 0.6, w + 0.3, 3.4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = i % 2 ? '#c69a68' : '#bb8e5c'; ctx.beginPath(); ctx.ellipse(x, y, w, 3.2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,235,200,0.3)'; ctx.beginPath(); ctx.ellipse(x - w * 0.45, y - 0.6, w * 0.3, 1.2, 0, 0, TAU); ctx.fill();
    }
    const [tx, ty] = P(N);
    const frond = (a, len, droop, col, dark) => {
      const ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.55 + droop;
      const mx = tx + Math.cos(a) * len * 0.5, my = ty + Math.sin(a) * len * 0.3 - 8;
      const nx = -Math.sin(a), ny = Math.cos(a) * 0.6;
      ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(tx, ty + 1); ctx.quadraticCurveTo(mx + nx * 7, my + ny * 7 + 2, ex, ey + 1.5); ctx.quadraticCurveTo(mx - nx * 7, my - ny * 7 + 2, tx, ty + 1); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(mx + nx * 7, my + ny * 7, ex, ey); ctx.quadraticCurveTo(mx - nx * 7, my - ny * 7, tx, ty); ctx.fill();
      // 잎 갈래 (가장자리 톱니)
      ctx.strokeStyle = dark; ctx.lineWidth = 0.7;
      for (let k = 2; k < 9; k++) {
        const u = k / 10, px = (1 - u) * (1 - u) * tx + 2 * (1 - u) * u * mx + u * u * ex, py = (1 - u) * (1 - u) * ty + 2 * (1 - u) * u * my + u * u * ey;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + nx * 6 * (1 - u * 0.6), py + ny * 6 * (1 - u * 0.6) + 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - nx * 6 * (1 - u * 0.6), py - ny * 6 * (1 - u * 0.6) + 2); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(230,255,200,0.55)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(mx, my, ex, ey); ctx.stroke();
    };
    const back = [-2.6, -0.5, -1.55], front = [Math.PI - 0.2, 0.2, 2.2, 0.95, Math.PI + 0.75];
    for (const a of back) frond(a + (r() - 0.5) * 0.2, 30 + r() * 6, 6, '#4f9e57', '#3f8549');
    // 코코넛
    for (const [x, y] of [[-3, 3], [2.5, 3.5], [0, 5.5]]) { ctx.fillStyle = '#7a5434'; circle(tx + x, ty + y, 2.8); ctx.fillStyle = 'rgba(255,230,190,0.35)'; circle(tx + x - 0.8, ty + y - 0.9, 0.9); }
    for (const a of front) frond(a + (r() - 0.5) * 0.2, 32 + r() * 7, 12 + r() * 6, '#66bb63', '#4f9e57');
  }
  // ---- 밀림 나무: 판자뿌리 + 넓고 짙은 잎 지붕 + 늘어진 덩굴과 꽃 ----
  function paintJungleTree(v, flowers) {
    const r = mulberry32(211 + v);
    ctx.fillStyle = 'rgba(30,80,40,0.25)'; ctx.beginPath(); ctx.ellipse(0, 1, 16, 3.5, 0, 0, TAU); ctx.fill();
    // 판자뿌리
    ctx.fillStyle = '#8a6448';
    for (const [x, w] of [[-12, -1], [12, 1], [-5, -0.4], [6, 0.5]]) { ctx.beginPath(); ctx.moveTo(x, 1.5); ctx.quadraticCurveTo(x * 0.4, -4, w * 3, -22); ctx.lineTo(w * 3 + (w > 0 ? -4 : 4), -22); ctx.quadraticCurveTo(x * 0.3, -2, x - w * 3, 1.5); ctx.fill(); }
    ctx.fillStyle = '#9a7252'; rr(-6, -46, 12, 47, 4);
    ctx.fillStyle = 'rgba(70,45,30,0.25)'; rr(1.5, -46, 4.5, 47, 2);
    ctx.fillStyle = 'rgba(255,230,200,0.15)'; rr(-4.5, -44, 2, 40, 1);
    ctx.fillStyle = 'rgba(110,170,80,0.55)'; for (let i = 0; i < 8; i++) circle(-5 + r() * 10, -40 + r() * 36, 1.2 + r() * 1.6); // 이끼
    const cy = -58;
    const blobs = [[-26, 10, 17], [26, 10, 17], [-14, 2, 21], [16, 2, 21], [0, -10, 25], [-30, -2, 13], [30, -2, 13]];
    ctx.fillStyle = '#245f38'; for (const [x, y, R] of blobs) circle(x, cy + y + 3, R);
    ctx.fillStyle = '#2f7444'; for (const [x, y, R] of blobs) circle(x, cy + y, R);
    for (let i = 0; i < 34; i++) { const a = r() * TAU, d = 24 + r() * 10; ctx.fillStyle = Math.sin(a) > 0.2 ? '#2f7444' : '#3d8a4e'; circle(Math.cos(a) * d * 1.35, cy + Math.sin(a) * d * 0.8, 4.5 + r() * 3.5); }
    ctx.fillStyle = '#3d8a4e'; circle(-8, cy - 10, 18); circle(14, cy - 6, 14); circle(-24, cy + 1, 10);
    ctx.fillStyle = '#4f9f58'; circle(-11, cy - 15, 10); circle(10, cy - 13, 8); circle(-27, cy - 3, 5);
    // 넓은 잎 무늬
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * 32, x = Math.cos(a) * d * 1.25, y = cy + Math.sin(a) * d * 0.75, L = 4 + r() * 3, rot = r() * TAU;
      ctx.fillStyle = y < cy - 6 && x < 8 ? 'rgba(150,215,130,0.4)' : 'rgba(20,75,40,0.35)';
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(L * 0.5, -L * 0.5, L, 0); ctx.quadraticCurveTo(L * 0.5, L * 0.5, 0, 0); ctx.fill(); ctx.restore();
    }
    // 늘어진 덩굴
    ctx.lineCap = 'round';
    for (const [x, len] of [[-22, 30], [-8, 22], [18, 34], [28, 20]].slice(0, 3 + (v % 2))) {
      const y0 = cy + 12;
      ctx.strokeStyle = '#3f8a4a'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.quadraticCurveTo(x + 3, y0 + len * 0.5, x - 1, y0 + len); ctx.stroke();
      ctx.fillStyle = '#5cb05e';
      for (let k = 1; k < 5; k++) { const yy = y0 + (len * k) / 5; ctx.beginPath(); ctx.ellipse(x + (k % 2 ? 2.4 : -2), yy, 2.2, 1.1, k % 2 ? 0.5 : -0.5, 0, TAU); ctx.fill(); }
    }
    ctx.fillStyle = 'rgba(200,240,170,0.35)'; circle(-12, cy - 19, 3.5); circle(8, cy - 17, 2);
    if (flowers) for (const [x, y] of [[-18, -8], [12, 4], [24, -12], [-2, -22], [-30, 6]]) {
      ctx.fillStyle = '#ff6f8f'; for (let k = 0; k < 5; k++) { const a = k * 1.2566; circle(x + Math.cos(a) * 1.6, cy + y + Math.sin(a) * 1.6, 1.3); }
      ctx.fillStyle = '#ffe07a'; circle(x, cy + y, 0.8);
    }
  }
  // ---- 바나나 나무: 커다란 잎이 늘어지고 바나나 송이 ----
  function paintBanana(v) {
    const r = mulberry32(251 + v);
    ctx.fillStyle = 'rgba(30,80,40,0.25)'; ctx.beginPath(); ctx.ellipse(0, 1, 10, 2.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8fbf6a'; rr(-3.5, -30, 7, 31, 3);
    ctx.fillStyle = 'rgba(60,110,50,0.3)'; rr(0.5, -30, 3, 31, 1.5);
    ctx.strokeStyle = 'rgba(80,120,60,0.4)'; ctx.lineWidth = 0.6; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-3.5, -6 - i * 6); ctx.lineTo(3.5, -9 - i * 6); ctx.stroke(); }
    const leaf = (a, L, droop, col) => {
      const tx = 0, ty = -30, ex = Math.cos(a) * L, ey = ty + Math.sin(a) * L * 0.4 + droop;
      const mx = ex * 0.5, my = ty - 14 + droop * 0.2, nx = -Math.sin(a) * 0.4, ny = Math.cos(a);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(mx + nx * 9, my - 8, ex, ey); ctx.quadraticCurveTo(mx - nx * 2, my + 9 * Math.abs(ny) + 2, tx, ty); ctx.fill();
      ctx.strokeStyle = 'rgba(230,255,200,0.6)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(mx, my - 2, ex, ey); ctx.stroke();
      ctx.strokeStyle = 'rgba(40,100,50,0.35)'; ctx.lineWidth = 0.4;
      for (let k = 2; k < 8; k++) { const u = k / 9, px = 2 * (1 - u) * u * mx + u * u * ex, py = (1 - u) * (1 - u) * ty + 2 * (1 - u) * u * (my - 2) + u * u * ey; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 2, py + 3.5); ctx.stroke(); }
    };
    leaf(-2.4, 30, 8, '#4f9e57'); leaf(-0.7, 30, 8, '#4f9e57');
    // 바나나 송이
    ctx.fillStyle = '#f5d24a';
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.ellipse(4 + (i % 3) * 2.2, -24 + Math.floor(i / 3) * 3.5, 1.3, 3.4, 0.5, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#b06a8a'; ctx.beginPath(); ctx.ellipse(7, -15, 2, 3.2, 0.2, 0, TAU); ctx.fill();
    leaf(Math.PI + 0.3, 32, 10, '#62b566'); leaf(0.3, 32, 10, '#62b566'); leaf(Math.PI - 0.6 + r() * 0.2, 26, 16, '#6cc06a');
  }
  function paintTrunk(r, snowy) {
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
    // 뿌리 옆 풀 (겨울엔 눈 더미)
    if (snowy) {
      ctx.fillStyle = 'rgba(170,200,230,0.5)'; ctx.beginPath(); ctx.ellipse(0, 1.8, 13, 3.2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff'; for (const [x, R] of [[-8, 3.4], [-3, 3], [4, 3.2], [9, 3]]) { ctx.beginPath(); ctx.ellipse(x, 0.6, R, R * 0.6, 0, 0, TAU); ctx.fill(); }
      return;
    }
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
  // 겨울 앙상한 나무: 갈라지는 가지 위에 눈이 얹혀 있고, 빨간 열매가 몇 알
  function paintBareTree(v) {
    const r = mulberry32(55 + v);
    paintTrunk(r, true);
    const branches = [];
    const grow = (x, y, a, len, w, depth) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      branches.push([x, y, x2, y2, w]);
      if (depth <= 0) return;
      grow(x2, y2, a - 0.35 - r() * 0.3, len * 0.72, w * 0.68, depth - 1);
      grow(x2, y2, a + 0.35 + r() * 0.3, len * 0.72, w * 0.68, depth - 1);
    };
    grow(0, -22, -Math.PI / 2 + (r() - 0.5) * 0.2, 21, 5.4, 3);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#8a6046';
    for (const [x1, y1, x2, y2, w] of branches) { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,230,200,0.25)';
    for (const [x1, y1, x2, y2, w] of branches) { ctx.lineWidth = w * 0.35; ctx.beginPath(); ctx.moveTo(x1 - w * 0.25, y1); ctx.lineTo(x2 - w * 0.25, y2); ctx.stroke(); }
    // 가지 위 눈
    ctx.strokeStyle = '#ffffff';
    for (const [x1, y1, x2, y2, w] of branches) { ctx.lineWidth = Math.max(1.2, w * 0.55); ctx.beginPath(); ctx.moveTo(x1, y1 - w * 0.45); ctx.lineTo(x2, y2 - w * 0.45); ctx.stroke(); }
    ctx.fillStyle = '#ffffff';
    for (const [, , x2, y2, w] of branches) if (w < 1.6) circle(x2, y2 - 0.6, 1.4);
    for (let i = 0; i < 6; i++) {
      const [, , x2, y2] = branches[3 + Math.floor(r() * (branches.length - 3))];
      ctx.fillStyle = '#e8505b'; circle(x2 + 0.6, y2 + 1.4, 1.4);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; circle(x2 + 0.2, y2 + 1, 0.45);
    }
  }
  function paintPine(v, snowy) {
    const r = mulberry32(77 + v);
    paintTrunk(r, snowy);
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
      tri(1.5, snowy ? '#3f7a62' : '#4c9a5a');
      tri(0, snowy ? (i % 2 ? '#5a9a80' : '#4e8c74') : (i % 2 ? '#6ab874' : '#5aa866'));
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
    // 겨울: 층마다 눈이 소복이
    if (snowy) {
      for (let i = 0; i < 3; i++) {
        const w = 30 - i * 7, y = -(20 + i * 17), top = y - 26;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.moveTo(0, top - 0.5);
        const yb = top + 12;
        ctx.lineTo(w * 0.47, yb);
        for (let k = 0; k <= 6; k++) { const x = w * 0.47 - (w * 0.94 * k) / 6; ctx.quadraticCurveTo(x + w * 0.08, yb + (k % 2 ? 3.2 : 1), x, yb + (k % 2 ? 0 : 2)); }
        ctx.closePath(); ctx.fill();
        // 가지 끝에 쌓인 눈
        for (let k = 0; k < 5; k++) { const x = -w + 4 + k * (w * 2 - 8) / 4; ctx.beginPath(); ctx.ellipse(x, y - 1.5, 3.4, 1.7, 0, 0, TAU); ctx.fill(); }
        ctx.fillStyle = 'rgba(170,200,230,0.45)';
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w * 0.47, yb); ctx.lineTo(w * 0.2, yb + 1); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#ffffff'; circle(0, -82, 2.6);
      return;
    }
    // 솔방울 하나
    if (v === 1) { ctx.fillStyle = '#a0724a'; ctx.beginPath(); ctx.ellipse(9, -18, 1.6, 2.4, 0.3, 0, TAU); ctx.fill(); }
  }

  function drawHouse(h) {
    const base = h.y + h.h / 2, sc = h.s || 1, style = h.style || 'cottage', pw = h.pw || h.w, v = h.v || 0;
    const round = style === 'igloo' || (style === 'tent' && v < 2);
    shadow(h.x, base, h.w * (round ? 0.58 : 0.62), 13 * sc, 1.4);
    const paint = HOUSE_PAINT[style] || HOUSE_PAINT.cottage;
    const spr = sprite('house' + style + v + h.roof + pw, pw + 90, 220, pw / 2 + 45, 205, () => paint(pw, h.roof, v));
    ctx.save(); ctx.translate(h.x, base); ctx.scale(sc, sc); stamp(spr, 0, 0); ctx.restore();
    // 굴뚝 연기 (굴뚝 있는 집만)
    const ch = chimneyOf(style, v, pw);
    if (ch && Math.random() < 0.025) particles.push({ x: h.x + (ch[0] + (Math.random() - 0.5) * 4) * sc, y: base + ch[1] * sc, vx: 6 + Math.random() * 4, vy: -10, life: 3, kind: 'smoke', r: 4 });
  }
  // 굴뚝 꼭대기 자리 (그림 기준). 없으면 null
  function chimneyOf(style, v, pw) {
    const gable = (w, wallH, dx) => { const chx = -w / 2 + w * 0.72; return [dx + chx, -wallH + 4 - (1 - Math.abs(chx) / (w / 2 + 10)) * 46 - 24]; };
    if (style === 'cottage') return v === 2 ? gable(pw * 0.68, 58, pw * 0.16) : gable(pw, v === 1 ? 94 : 58, 0);
    if (style === 'cabin') return v === 1 ? [pw * 0.22, -96] : v === 2 ? gable(pw * 0.7, 58, pw * 0.15) : gable(pw, 58, 0);
    if (style === 'igloo' && v === 2) return [pw * 0.22, -pw * 0.47 - 30];
    return null;
  }
  const HOUSE_PAINT = {
    cottage: (w, roof, v) => v === 1 ? paintTwoStorey(w, roof) : v === 2 ? paintCottageWing(w, roof) : paintHouse(w, roof),
    cabin: (w, roof, v) => v === 1 ? paintAFrame(w, roof) : v === 2 ? paintCabinShed(w, roof) : paintCabin(w, roof),
    igloo: (w, roof, v) => v === 1 ? paintTwinIgloo(w) : v === 2 ? paintIglooTunnel(w) : paintIgloo(w),
    adobe: (w, roof, v) => v === 1 ? paintAdobeTiers(w, roof) : v === 2 ? paintAdobeDome(w, roof) : paintAdobe(w, roof),
    tent: (w, roof, v) => v === 1 ? paintYurt(w, roof) : v === 2 ? paintCanopy(w, roof) : paintTent(w, roof),
    stilt: (w, roof, v) => v === 1 ? paintRoundStilt(w, roof) : v === 2 ? paintStiltVeranda(w, roof) : paintStilt(w, roof),
    beachhut: (w, roof, v) => v === 1 ? paintBeachHouse(w, roof) : v === 2 ? paintHutParasol(w, roof) : paintBeachHut(w, roof),
  };
  // 밤에 불 켜지는 자리 (그림 기준 좌표)
  const HOUSE_LIGHTS = {
    cottage: (w, v) => v === 1 ? [[-w / 2 + 22, -36], [w / 2 - 22, -36], [-w / 2 + 22, -74], [w / 2 - 22, -74]]
      : v === 2 ? [[w * 0.16 - w * 0.34 + 22, -36], [w * 0.16 + w * 0.34 - 22, -36]] : [[-w / 2 + 22, -36], [w / 2 - 22, -36]],
    cabin: (w, v) => v === 1 ? [[0, -62], [0, -20]] : v === 2 ? [[w * 0.15 - w * 0.35 + 22, -34], [w * 0.15 + w * 0.35 - 22, -34]] : [[-w / 2 + 22, -34], [w / 2 - 22, -34]],
    igloo: (w, v) => v === 1 ? [[-w / 2 + w * 0.33, -12]] : v === 2 ? [[-w / 2 + 12, -10], [w * 0.1, -30]] : [[0, -12]],
    adobe: (w, v) => v === 1 ? [[-w / 2 + 20, -24], [w * 0.2, -66]] : v === 2 ? [[-w / 2 + 20, -26], [w / 2 - 20, -26]] : [[-w / 2 + 22, -32], [w / 2 - 22, -32]],
    tent: (w, v) => v === 2 ? [[0, -28]] : [[0, -14]],
    stilt: (w, v) => v === 2 ? [[w * 0.15, -52], [-w / 2 + 14, -40]] : [[0, -52]],
    beachhut: (w, v) => v === 1 ? [[-w / 2 + 22, -52], [w / 2 - 22, -52]] : v === 2 ? [[w * 0.15 + w * 0.38 - 20, -34]] : [[w / 2 - 20, -34]],
  };
  const shifted = (dx, fn) => { ctx.save(); ctx.translate(dx, 0); fn(); ctx.restore(); };

  // ---- 풀밭 v1: 2층집 (창이 두 줄, 가운데 띠, 작은 발코니) ----
  function paintTwoStorey(w, roof) {
    paintHouse(w, roof, 94);
    ctx.fillStyle = '#e9d6b6'; ctx.fillRect(-w / 2, -60, w, 4);
    for (const wx of [-w / 2 + 12, w / 2 - 32]) {
      ctx.fillStyle = '#c9a57c'; rr(wx - 2, -84, 24, 20, 4);
      ctx.fillStyle = '#fff3a8'; rr(wx, -82, 20, 16, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(wx + 2, -80, 5, 5);
      ctx.fillStyle = '#c9a57c'; ctx.fillRect(wx + 9, -82, 2, 16); ctx.fillRect(wx, -75, 20, 2);
    }
    // 가운데 작은 발코니 + 문
    ctx.fillStyle = '#b47b52'; rr(-8, -88, 16, 26, 6);
    ctx.fillStyle = '#fff3a8'; rr(-5, -84, 10, 8, 3);
    ctx.fillStyle = '#c9a57c'; rr(-16, -64, 32, 4, 1.5);
    ctx.fillStyle = roof; rr(-16, -63, 32, 3, 1);
    ctx.strokeStyle = '#c9a57c'; ctx.lineWidth = 1.6;
    for (let x = -14; x <= 14; x += 4) { ctx.beginPath(); ctx.moveTo(x, -64); ctx.lineTo(x, -74); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-16, -74); ctx.lineTo(16, -74); ctx.stroke();
    ctx.fillStyle = '#ff9eb5'; circle(-11, -76, 2); ctx.fillStyle = '#ffd34d'; circle(11, -76, 2);
  }

  // ---- 풀밭 v2: 옆채(헛간) 달린 넓은 집 ----
  function paintCottageWing(w, roof) {
    const mw = w * 0.68, cx = (w - mw) / 2, x0 = -w / 2, ww = w - mw + 8, wh = 40;
    // 헛간 벽 (빨간 판자)
    ctx.fillStyle = '#e8a184'; rr(x0, -wh, ww, wh, 4);
    ctx.strokeStyle = 'rgba(140,60,40,0.25)'; ctx.lineWidth = 0.8;
    for (let x = x0 + 5; x < x0 + ww; x += 6) { ctx.beginPath(); ctx.moveTo(x, -wh); ctx.lineTo(x, 0); ctx.stroke(); }
    // 외쪽 지붕
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(x0 - 8, -wh + 4); ctx.lineTo(x0 + ww + 4, -wh - 22); ctx.lineTo(x0 + ww + 4, -wh - 8); ctx.lineTo(x0 - 8, -wh + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath(); ctx.moveTo(x0 - 8, -wh + 10); ctx.lineTo(x0 + ww + 4, -wh - 8); ctx.lineTo(x0 + ww + 4, -wh - 5); ctx.lineTo(x0 - 6, -wh + 12); ctx.fill();
    // 헛간 문 (X 모양)
    const dx = x0 + ww / 2 - 6;
    ctx.fillStyle = '#fff4e6'; rr(dx - 12, -30, 24, 30, 2);
    ctx.fillStyle = '#c96a50'; rr(dx - 10, -28, 20, 28, 1);
    ctx.strokeStyle = '#fff4e6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(dx - 10, -28); ctx.lineTo(dx + 10, 0); ctx.moveTo(dx + 10, -28); ctx.lineTo(dx - 10, 0); ctx.stroke();
    // 건초 + 물뿌리개
    ctx.fillStyle = '#f2cf6a'; rr(x0 - 6, -12, 14, 12, 3);
    ctx.strokeStyle = 'rgba(170,120,40,0.5)'; ctx.lineWidth = 0.7; for (let y = -10; y < 0; y += 3) { ctx.beginPath(); ctx.moveTo(x0 - 5, y); ctx.lineTo(x0 + 7, y); ctx.stroke(); }
    // 본채
    shifted(cx, () => paintHouse(mw, roof));
    // 앞마당 울타리
    ctx.fillStyle = '#fffaf0';
    for (let x = x0 + ww + 2; x < x0 + ww + 22; x += 5) rr(x, -10, 3, 10, 1);
  }

  // ---- 눈 v1: 뾰족한 A자 산장 (지붕이 땅까지, 큰 세모 창) ----
  function paintAFrame(w, roof) {
    const R = w / 2 + 6, H = 112;
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(0, -H); ctx.lineTo(R, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.beginPath(); ctx.moveTo(0, -H); ctx.lineTo(R, 0); ctx.lineTo(R - 14, 0); ctx.closePath(); ctx.fill();
    // 나무 앞면
    const iR = R - 16, iH = H - 26;
    ctx.fillStyle = '#b98258';
    ctx.beginPath(); ctx.moveTo(-iR, 0); ctx.lineTo(0, -iH); ctx.lineTo(iR, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(110,65,35,0.35)'; ctx.lineWidth = 0.8;
    for (let y = -6; y > -iH; y -= 7) { const half = iR * (1 + y / iH); ctx.beginPath(); ctx.moveTo(-half, y); ctx.lineTo(half, y); ctx.stroke(); }
    // 큰 세모 창
    ctx.fillStyle = '#6e4a32'; ctx.beginPath(); ctx.moveTo(-22, -46); ctx.lineTo(0, -84); ctx.lineTo(22, -46); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.moveTo(-17, -49); ctx.lineTo(0, -78); ctx.lineTo(17, -49); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#6e4a32'; ctx.fillRect(-1, -78, 2, 30); ctx.fillRect(-12, -60, 24, 2);
    // 문 + 화환
    ctx.fillStyle = '#7a4f32'; rr(-10, -34, 20, 34, 8);
    ctx.fillStyle = '#ffd34d'; circle(6, -16, 1.6);
    ctx.strokeStyle = '#4f9a62'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(0, -25, 4.2, 0, TAU); ctx.stroke();
    // 지붕 눈 (양쪽 비탈)
    ctx.fillStyle = '#fbfdff';
    ctx.beginPath(); ctx.moveTo(-R - 3, 2); ctx.lineTo(0, -H - 5); ctx.lineTo(R + 3, 2); ctx.lineTo(R - 8, 2); ctx.lineTo(0, -H + 8); ctx.lineTo(-R + 8, 2); ctx.closePath(); ctx.fill();
    // 쇠 굴뚝 (오른쪽 비탈)
    const px = w * 0.22, py = -H * (1 - px / R);
    ctx.fillStyle = '#6f7378'; rr(px - 3.5, py - 26, 7, 28, 1.5);
    ctx.fillStyle = '#fbfdff'; rr(px - 6, py - 30, 12, 5, 2.5);
    // 눈 더미 + 스키
    ctx.fillStyle = '#fbfdff'; for (const [x, rx] of [[-R + 4, 12], [R - 4, 12]]) { ctx.beginPath(); ctx.ellipse(x, -1, rx, 5, 0, Math.PI, TAU); ctx.fill(); }
    ctx.fillStyle = '#e05a5a'; ctx.save(); ctx.translate(-R + 18, -18); ctx.rotate(-0.15); rr(-1.5, -18, 3, 36, 1.5); rr(3, -18, 3, 36, 1.5); ctx.restore();
  }

  // ---- 눈 v2: 오두막 + 옆에 장작 헛간 ----
  function paintCabinShed(w, roof) {
    const mw = w * 0.7, cx = (w - mw) / 2, x0 = -w / 2, sw = w - mw + 6;
    // 헛간 기둥 + 지붕
    ctx.fillStyle = '#7a5236'; rr(x0 + 2, -40, 4, 40, 1.5); rr(x0 + sw - 8, -44, 4, 44, 1.5);
    // 장작 더미 (동그란 통나무 끝)
    for (let row = 0; row < 4; row++) for (let i = 0; i < 4 - (row > 2 ? 1 : 0); i++) {
      const lx = x0 + 11 + i * 9 + (row % 2) * 4.5, ly = -5 - row * 8.5;
      if (lx > x0 + sw - 12) continue;
      ctx.fillStyle = '#c98e5e'; circle(lx, ly, 4.4);
      ctx.fillStyle = '#e6b884'; circle(lx, ly, 3);
      ctx.strokeStyle = 'rgba(140,90,50,0.6)'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(lx, ly, 1.5, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(x0 - 6, -38); ctx.lineTo(x0 + sw, -52); ctx.lineTo(x0 + sw, -44); ctx.lineTo(x0 - 6, -32); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fbfdff';
    ctx.beginPath(); ctx.moveTo(x0 - 8, -40); ctx.lineTo(x0 + sw, -56); ctx.lineTo(x0 + sw, -51); ctx.lineTo(x0 - 6, -36); ctx.closePath(); ctx.fill();
    // 도끼 꽂힌 그루터기
    ctx.fillStyle = '#a0724a'; rr(x0 + sw - 2, -9, 12, 9, 2);
    ctx.fillStyle = '#e6b884'; ctx.beginPath(); ctx.ellipse(x0 + sw + 4, -9, 6, 2, 0, 0, TAU); ctx.fill();
    shifted(cx, () => paintCabin(mw, roof));
  }

  // ---- 눈 v1: 이글루 두 개 붙은 집 ----
  function paintTwinIgloo(w) {
    const R1 = w * 0.33, R2 = w * 0.22;
    shifted(w / 2 - R2 - 2, () => paintIgloo(R2 * 2, true));
    shifted(-w / 2 + R1, () => paintIgloo(R1 * 2));
  }
  // ---- 눈 v2: 긴 굴 입구 + 난로 연통 달린 이글루 ----
  function paintIglooTunnel(w) {
    const dw = w * 0.82, dx = w / 2 - dw / 2;
    shifted(dx, () => paintIgloo(dw, true));
    // 굴 입구 (반원 터널, 왼쪽으로)
    const tl = -w / 2, tr = dx - dw * 0.2, th = 22;
    ctx.fillStyle = '#eef6fd'; rr(tl, -th, tr - tl, th, [th, 4, 0, 0]);
    ctx.strokeStyle = 'rgba(140,175,210,0.55)'; ctx.lineWidth = 1;
    for (let x = tl + 12; x < tr; x += 12) { ctx.beginPath(); ctx.moveTo(x, -th + (x < tl + 14 ? 6 : 0)); ctx.lineTo(x, 0); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(tl + 6, -11); ctx.lineTo(tr, -11); ctx.stroke();
    ctx.fillStyle = '#5a7290'; ctx.beginPath(); ctx.ellipse(tl + 3, 0, 7, 15, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,140,0.45)'; ctx.beginPath(); ctx.ellipse(tl + 4, 0, 4, 9, 0, Math.PI, TAU); ctx.fill();
    // 얼음 창
    ctx.fillStyle = '#bfe3f7'; circle(w * 0.1, -30, 7); ctx.fillStyle = 'rgba(255,230,160,0.7)'; circle(w * 0.1, -30, 5);
    ctx.strokeStyle = '#9cc7e3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(w * 0.1 - 5, -30); ctx.lineTo(w * 0.1 + 5, -30); ctx.stroke();
    // 연통
    const H = dw * 0.55;
    ctx.fillStyle = '#6f7378'; rr(w * 0.22 - 3, -H * 0.86 - 26, 6, 26, 1.5);
    ctx.fillStyle = '#585c60'; rr(w * 0.22 - 5, -H * 0.86 - 29, 10, 4, 1);
    // 썰매
    ctx.fillStyle = '#c9744a'; rr(w / 2 - 8, -7, 22, 4, 2);
    ctx.strokeStyle = '#8a5a3a'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(w / 2 - 10, -1); ctx.lineTo(w / 2 + 16, -1); ctx.quadraticCurveTo(w / 2 + 20, -1, w / 2 + 19, -6); ctx.stroke();
  }

  // ---- 사막 v1: 2단 흙집 (위층 작은 방 + 사다리) ----
  function paintAdobeTiers(w, accent) {
    const x0 = -w / 2, lh = 46, uw = w * 0.52, ux = w / 2 - uw - 4, uh = 34;
    const block = (x, y, bw, bh) => {
      ctx.fillStyle = '#eab98a'; rr(x, y, bw, bh, 8);
      ctx.fillStyle = 'rgba(150,80,40,0.14)'; rr(x + bw - 14, y, 14, bh, 7);
      ctx.fillStyle = '#e2ac78'; rr(x - 3, y - 5, bw + 6, 8, 4);
      ctx.fillStyle = '#8a5a3a'; for (let bx = x + 8; bx < x + bw - 6; bx += 16) rr(bx, y + 2, 5, 3.5, 1.5);
    };
    block(ux, -lh - uh, uw, uh + 6);
    block(x0, -lh, w, lh);
    // 위층 창 + 꽃
    ctx.fillStyle = '#7a4a32'; ctx.beginPath(); ctx.moveTo(ux + uw / 2 - 7, -lh - 2); ctx.lineTo(ux + uw / 2 - 7, -lh - 16); ctx.arc(ux + uw / 2, -lh - 16, 7, Math.PI, TAU); ctx.lineTo(ux + uw / 2 + 7, -lh - 2); ctx.fill();
    ctx.fillStyle = accent; rr(ux + uw / 2 - 10, -lh - 3, 20, 3, 1);
    // 사다리 (아래 지붕 → 위층)
    ctx.strokeStyle = '#9a6a3a'; ctx.lineWidth = 1.8;
    const lx = ux - 10;
    ctx.beginPath(); ctx.moveTo(lx, -lh); ctx.lineTo(lx + 6, -lh - uh - 4); ctx.moveTo(lx + 8, -lh); ctx.lineTo(lx + 14, -lh - uh - 4); ctx.stroke();
    ctx.lineWidth = 1.3; for (let k = 1; k < 5; k++) { const t = k / 5, y = -lh - (uh + 4) * t; ctx.beginPath(); ctx.moveTo(lx + 6 * t, y); ctx.lineTo(lx + 8 + 6 * t, y); ctx.stroke(); }
    // 아래층 문 + 창
    ctx.fillStyle = '#7a4a32'; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-14, -20); ctx.arc(-4, -20, 10, Math.PI, TAU); ctx.lineTo(6, 0); ctx.fill();
    ctx.fillStyle = accent; ctx.globalAlpha = 0.6; ctx.fillRect(-14, -12, 20, 3); ctx.globalAlpha = 1;
    ctx.fillStyle = '#c98e5e'; rr(x0 + 12, -34, 16, 14, 3); ctx.fillStyle = '#4a6a8a'; rr(x0 + 14, -32, 12, 10, 2);
    ctx.fillStyle = accent; ctx.fillRect(x0 + 19.4, -32, 1.2, 10);
    // 지붕 위 빨래줄
    ctx.strokeStyle = 'rgba(120,90,60,0.6)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(x0 + 6, -lh - 14); ctx.quadraticCurveTo(x0 + 22, -lh - 8, ux - 14, -lh - 14); ctx.stroke();
    ctx.fillStyle = '#6a6460'; ctx.fillRect(x0 + 5, -lh - 15, 1.6, 15); ctx.fillRect(ux - 15, -lh - 15, 1.6, 15);
    ctx.fillStyle = accent; rr(x0 + 12, -lh - 12, 6, 7, 1); ctx.fillStyle = '#fff4e0'; rr(x0 + 22, -lh - 11, 6, 6, 1);
    // 항아리
    ctx.fillStyle = '#c9744a'; ctx.beginPath(); ctx.ellipse(x0 + w - 8, -6, 6, 7, 0, 0, TAU); ctx.fill();
  }

  // ---- 사막 v2: 둥근 지붕 집 ----
  function paintAdobeDome(w, accent) {
    const x0 = -w / 2, wallH = 46, R = w * 0.36;
    // 돔
    ctx.fillStyle = '#f2cfa2'; ctx.beginPath(); ctx.ellipse(0, -wallH + 2, R, R * 0.92, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(150,80,40,0.14)'; ctx.beginPath(); ctx.ellipse(R * 0.3, -wallH + 2, R * 0.7, R * 0.92, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-R * 0.4, -wallH - R * 0.55, R * 0.18, R * 0.1, -0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = accent; rr(-R - 2, -wallH - 3, 2 * R + 4, 5, 2);
    ctx.fillStyle = '#d9a640'; circle(0, -wallH - R * 0.92 - 2, 3.5); ctx.fillRect(-0.8, -wallH - R * 0.92 - 10, 1.6, 8);
    // 벽
    ctx.fillStyle = '#eab98a'; rr(x0, -wallH, w, wallH, 8);
    ctx.fillStyle = 'rgba(150,80,40,0.14)'; rr(x0 + w - 16, -wallH, 16, wallH, 8);
    // 무늬 띠
    ctx.fillStyle = accent; ctx.globalAlpha = 0.75;
    for (let x = x0 + 6; x < x0 + w - 6; x += 10) { ctx.beginPath(); ctx.moveTo(x, -wallH + 8); ctx.lineTo(x + 5, -wallH + 13); ctx.lineTo(x + 10, -wallH + 8); ctx.fill(); }
    ctx.globalAlpha = 1;
    // 아치 문 + 기둥
    ctx.fillStyle = '#e2ac78'; ctx.beginPath(); ctx.moveTo(-15, 0); ctx.lineTo(-15, -22); ctx.arc(0, -22, 15, Math.PI, TAU); ctx.lineTo(15, 0); ctx.fill();
    ctx.fillStyle = '#6a4030'; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-10, -22); ctx.arc(0, -22, 10, Math.PI, TAU); ctx.lineTo(10, 0); ctx.fill();
    ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(-10, -22); ctx.arc(0, -22, 10, Math.PI, TAU); ctx.lineTo(10, -18); ctx.lineTo(-10, -18); ctx.fill();
    // 아치 창
    for (const wx of [x0 + 20, x0 + w - 20]) {
      ctx.fillStyle = '#4a6a8a'; ctx.beginPath(); ctx.moveTo(wx - 6, -18); ctx.lineTo(wx - 6, -28); ctx.arc(wx, -28, 6, Math.PI, TAU); ctx.lineTo(wx + 6, -18); ctx.fill();
      ctx.fillStyle = '#c98e5e'; rr(wx - 8, -19, 16, 3, 1);
    }
    // 야자 화분
    ctx.fillStyle = '#d2865a'; rr(x0 - 4, -9, 11, 9, 2);
    ctx.strokeStyle = '#5fa04e'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (const a of [-2.4, -1.9, -1.2, -0.7]) { ctx.beginPath(); ctx.moveTo(x0 + 1.5, -9); ctx.quadraticCurveTo(x0 + 1.5 + Math.cos(a) * 8, -9 + Math.sin(a) * 14, x0 + 1.5 + Math.cos(a) * 13, -9 + Math.sin(a) * 10); ctx.stroke(); }
    ctx.lineCap = 'butt';
  }

  // ---- 사막 v1: 둥근 게르 (격자 벽 + 원뿔 지붕) ----
  function paintYurt(w, accent) {
    const R = w / 2, wallH = 30, roofH = 30;
    ctx.fillStyle = '#fff4e0'; ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(-R, -wallH); ctx.quadraticCurveTo(0, -wallH - 6, R, -wallH); ctx.lineTo(R, 0); ctx.quadraticCurveTo(0, 5, -R, 0); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(180,130,80,0.35)'; ctx.lineWidth = 0.8;
    for (let x = -R - 30; x < R; x += 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 30, -wallH - 4); ctx.moveTo(x + 30, 0); ctx.lineTo(x, -wallH - 4); ctx.stroke(); }
    ctx.fillStyle = 'rgba(120,70,30,0.13)'; ctx.fillRect(R * 0.45, -wallH - 6, R, wallH + 8);
    ctx.restore();
    ctx.fillStyle = accent; rr(-R, -wallH * 0.55, 2 * R, 5, 1);
    ctx.fillStyle = '#fff4e0'; for (let x = -R + 6; x < R - 3; x += 9) circle(x, -wallH * 0.55 + 2.5, 1.2);
    // 원뿔 지붕
    ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(-R - 6, -wallH + 2); ctx.quadraticCurveTo(0, -wallH - 8, R + 6, -wallH + 2); ctx.lineTo(0, -wallH - roofH); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.moveTo(0, -wallH - roofH); ctx.lineTo(R + 6, -wallH + 2); ctx.lineTo(R * 0.3, -wallH - 3); ctx.fill();
    ctx.strokeStyle = 'rgba(255,244,224,0.7)'; ctx.lineWidth = 1;
    for (const t of [-0.66, -0.33, 0, 0.33, 0.66]) { ctx.beginPath(); ctx.moveTo(0, -wallH - roofH); ctx.lineTo(t * (R + 4), -wallH - 3 + Math.abs(t) * 4); ctx.stroke(); }
    ctx.fillStyle = '#d9a640'; ctx.beginPath(); ctx.ellipse(0, -wallH - roofH + 1, 5, 2.5, 0, 0, TAU); ctx.fill();
    // 나무 문
    ctx.fillStyle = '#b5743c'; rr(-9, -24, 18, 24, 2);
    ctx.fillStyle = accent; rr(-7, -22, 6, 20, 1); rr(1, -22, 6, 20, 1);
    ctx.fillStyle = '#ffd34d'; circle(0, -12, 1.4);
  }

  // ---- 사막 v2: 기둥 네 개 위 그늘막 (방석 + 등불) ----
  function paintCanopy(w, accent) {
    const x0 = -w / 2, top = -46;
    // 뒤 천 (벽)
    ctx.fillStyle = '#efe2c8'; rr(x0 + 6, top + 4, w - 12, -top - 4, 2);
    ctx.fillStyle = 'rgba(120,70,30,0.12)'; ctx.fillRect(x0 + 6, top + 4, w - 12, 8);
    // 양탄자 + 방석
    ctx.fillStyle = accent; rr(x0 + 10, -8, w - 20, 8, 2);
    ctx.fillStyle = '#fff4e0'; for (let x = x0 + 14; x < x0 + w - 14; x += 8) ctx.fillRect(x, -5, 4, 2);
    ctx.fillStyle = '#e8b13c'; rr(x0 + 16, -16, 18, 9, 4); ctx.fillStyle = '#c86aa8'; rr(x0 + w - 36, -16, 18, 9, 4);
    // 작은 탁자 + 찻주전자
    ctx.fillStyle = '#9a6a3a'; rr(-12, -14, 24, 3, 1); ctx.fillRect(-9, -11, 2, 5); ctx.fillRect(7, -11, 2, 5);
    ctx.fillStyle = '#d9a640'; ctx.beginPath(); ctx.ellipse(0, -18, 4.5, 4, 0, 0, TAU); ctx.fill(); ctx.fillRect(3, -20, 5, 1.6);
    // 기둥
    ctx.fillStyle = '#8a5f3a'; for (const x of [x0 + 4, x0 + w - 8]) rr(x, top, 4, -top, 1.5);
    // 지붕 천 (줄무늬 + 물결 끝)
    ctx.save(); ctx.beginPath(); ctx.moveTo(x0 - 6, top + 4); ctx.lineTo(x0 + 8, top - 14); ctx.lineTo(x0 + w - 8, top - 14); ctx.lineTo(x0 + w + 6, top + 4); ctx.closePath(); ctx.clip();
    for (let x = x0 - 6, k = 0; x < x0 + w + 6; x += 10, k++) { ctx.fillStyle = k % 2 ? '#fff4e0' : accent; ctx.fillRect(x, top - 14, 10, 20); }
    ctx.restore();
    for (let x = x0 - 6, k = 0; x < x0 + w + 6; x += 10, k++) { ctx.fillStyle = k % 2 ? '#fff4e0' : accent; ctx.beginPath(); ctx.arc(x + 5, top + 4, 5, 0, Math.PI); ctx.fill(); }
    // 등불
    ctx.strokeStyle = 'rgba(120,90,60,0.7)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, top + 8); ctx.lineTo(0, top + 14); ctx.stroke();
    ctx.fillStyle = '#d9a640'; rr(-3.5, top + 14, 7, 8, 2); ctx.fillStyle = '#fff3a8'; rr(-2, top + 16, 4, 4, 1);
  }

  // ---- 밀림 v1: 둥근 오두막 (높은 원뿔 풀지붕) ----
  function paintRoundStilt(w, accent) {
    const R = w / 2 - 6, post = 22, floor = -post, wallH = 34, top = floor - wallH;
    const r = mulberry32(w * 11 + accent.charCodeAt(2));
    ctx.fillStyle = '#8a5f3a'; for (const x of [-R + 4, -R * 0.3, R * 0.3, R - 8]) rr(x, floor - 2, 5, post + 2, 2);
    ctx.fillStyle = '#b07e4e'; ctx.beginPath(); ctx.ellipse(0, floor - 1, R + 10, 5, 0, 0, TAU); ctx.fill();
    // 둥근 벽 (흙 + 무늬)
    ctx.fillStyle = '#c99a62'; ctx.beginPath(); ctx.moveTo(-R, floor - 2); ctx.lineTo(-R + 2, top); ctx.quadraticCurveTo(0, top - 6, R - 2, top); ctx.lineTo(R, floor - 2); ctx.quadraticCurveTo(0, floor + 3, -R, floor - 2); ctx.fill();
    ctx.fillStyle = 'rgba(100,60,30,0.15)'; ctx.fillRect(R * 0.4, top - 4, R * 0.6, wallH + 2);
    ctx.fillStyle = accent; for (let x = -R + 6; x < R - 6; x += 9) { ctx.beginPath(); ctx.moveTo(x, top + 10); ctx.lineTo(x + 4.5, top + 15); ctx.lineTo(x + 9, top + 10); ctx.fill(); }
    // 문 + 사다리
    ctx.fillStyle = '#5a3e26'; rr(-8, floor - 26, 16, 24, 8);
    ctx.strokeStyle = '#9a6a3a'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(-6, floor); ctx.lineTo(-8, 0); ctx.moveTo(6, floor); ctx.lineTo(8, 0); ctx.stroke();
    ctx.lineWidth = 1.3; for (let k = 1; k < 5; k++) { const y = floor + (post * k) / 5; ctx.beginPath(); ctx.moveTo(-6 - k * 0.4, y); ctx.lineTo(6 + k * 0.4, y); ctx.stroke(); }
    // 높은 원뿔 풀지붕
    const peak = top - 62;
    for (let layer = 0; layer < 3; layer++) {
      const y = top + 6 - layer * 18, spread = R + 16 - layer * 13;
      ctx.fillStyle = ['#b8904a', '#c9a25a', '#d6b06a'][layer];
      ctx.beginPath(); ctx.moveTo(-spread, y); ctx.lineTo(0, peak); ctx.lineTo(spread, y);
      for (let x = spread; x > -spread; x -= 6) ctx.lineTo(x - 3, y + 4 + r() * 3);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#8a6a3a'; ctx.fillRect(-1, peak - 10, 2, 12);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(1, peak - 10); ctx.lineTo(10, peak - 7); ctx.lineTo(1, peak - 4); ctx.fill();
  }

  // ---- 밀림 v2: 오두막 + 해먹 걸린 넓은 마루 ----
  function paintStiltVeranda(w, accent) {
    const mw = w * 0.7, cx = (w - mw) / 2, x0 = -w / 2, post = 24, floor = -post;
    // 마루 기둥 + 바닥
    ctx.fillStyle = '#8a5f3a'; rr(x0 + 4, floor - 2, 5, post + 2, 2);
    ctx.fillStyle = '#b07e4e'; rr(x0, floor - 4, w - mw + 10, 6, 2);
    // 난간
    ctx.strokeStyle = '#8a5f3a'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x0 + 2, floor - 4); ctx.lineTo(x0 + 2, floor - 22); ctx.lineTo(x0 + w - mw + 6, floor - 22); ctx.stroke();
    for (let x = x0 + 8; x < x0 + w - mw + 6; x += 6) { ctx.beginPath(); ctx.moveTo(x, floor - 4); ctx.lineTo(x, floor - 22); ctx.stroke(); }
    // 해먹 (기둥과 집 사이)
    ctx.fillStyle = '#8a5f3a'; rr(x0 + 2, floor - 46, 3, 26, 1);
    ctx.strokeStyle = 'rgba(120,90,60,0.7)'; ctx.lineWidth = 0.8;
    const hx1 = x0 + 4, hx2 = x0 + w - mw + 6;
    ctx.beginPath(); ctx.moveTo(hx1, floor - 42); ctx.lineTo(hx1 + 6, floor - 32); ctx.moveTo(hx2, floor - 42); ctx.lineTo(hx2 - 6, floor - 32); ctx.stroke();
    ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(hx1 + 6, floor - 32); ctx.quadraticCurveTo((hx1 + hx2) / 2, floor - 14, hx2 - 6, floor - 32); ctx.quadraticCurveTo((hx1 + hx2) / 2, floor - 22, hx1 + 6, floor - 32); ctx.fill();
    ctx.fillStyle = '#fff4e0'; for (let t = 0.2; t < 0.9; t += 0.2) circle(hx1 + 6 + (hx2 - hx1 - 12) * t, floor - 22 - Math.abs(t - 0.5) * 12, 1);
    shifted(cx, () => paintStilt(mw, accent));
    // 바나나 송이
    ctx.fillStyle = '#ffd34d'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(x0 + 14 + i * 3, floor - 6 - (i % 2) * 2, 1.6, 4, 0.4, 0, TAU); ctx.fill(); }
  }

  // ---- 바닷가 v1: 짧은 기둥 위 평지붕 집 (계단 + 지붕 난간 + 차양) ----
  function paintBeachHouse(w, accent) {
    const x0 = -w / 2, post = 12, floor = -post, wallH = 54, top = floor - wallH;
    ctx.fillStyle = '#c9a074'; for (const x of [x0 + 4, x0 + w * 0.5, x0 + w - 8]) rr(x, floor, 5, post, 1.5);
    ctx.fillStyle = '#c9a074'; rr(x0 - 6, floor - 4, w + 12, 5, 2);
    // 벽 (판자, 파스텔)
    ctx.fillStyle = '#e8f6fb'; rr(x0, top, w, wallH - 4, 3);
    ctx.strokeStyle = 'rgba(80,140,170,0.25)'; ctx.lineWidth = 0.8;
    for (let y = top + 6; y < floor - 4; y += 6) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(x0 + w - 12, top, 12, wallH - 4);
    // 평지붕 + 난간
    ctx.fillStyle = accent; rr(x0 - 6, top - 6, w + 12, 8, 2);
    ctx.strokeStyle = '#fffaf0'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x0 - 4, top - 6); ctx.lineTo(x0 - 4, top - 18); ctx.lineTo(x0 + w + 4, top - 18); ctx.lineTo(x0 + w + 4, top - 6); ctx.stroke();
    for (let x = x0 + 4; x < x0 + w; x += 7) { ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, top - 18); ctx.stroke(); }
    // 지붕 위 작은 파라솔
    ctx.fillStyle = '#9a7a5a'; ctx.fillRect(x0 + w * 0.7, top - 34, 1.6, 28);
    ctx.fillStyle = '#ffcc4d'; ctx.beginPath(); ctx.moveTo(x0 + w * 0.7 - 14, top - 30); ctx.quadraticCurveTo(x0 + w * 0.7, top - 44, x0 + w * 0.7 + 16, top - 30); ctx.closePath(); ctx.fill();
    // 창 두 개 + 줄무늬 차양
    for (const wx of [x0 + 12, x0 + w - 32]) {
      ctx.fillStyle = '#fff3a8'; rr(wx, top + 16, 20, 16, 2);
      ctx.fillStyle = '#fffaf0'; ctx.fillRect(wx + 9.4, top + 16, 1.2, 16);
      for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fffaf0' : accent; ctx.beginPath(); ctx.moveTo(wx - 3 + i * 6.5, top + 8); ctx.lineTo(wx + 3.5 + i * 6.5, top + 8); ctx.lineTo(wx + 3.5 + i * 6.5, top + 15); ctx.lineTo(wx - 3 + i * 6.5, top + 15); ctx.fill(); }
    }
    // 문 + 계단
    ctx.fillStyle = accent; rr(-9, floor - 32, 18, 28, 3);
    ctx.fillStyle = '#fffaf0'; circle(5, floor - 17, 1.4); rr(-6, floor - 29, 12, 8, 2);
    ctx.fillStyle = '#c9a074'; for (let k = 0; k < 3; k++) rr(-12 - k * 2, floor + 4 * k, 24 + k * 4, 3, 1);
    // 불가사리
    ctx.fillStyle = '#ff9e7a'; ctx.save(); ctx.translate(x0 + w - 4, -4);
    ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr2 = i % 2 ? 2 : 5; ctx.lineTo(Math.cos(a) * rr2, Math.sin(a) * rr2); } ctx.fill(); ctx.restore();
  }

  // ---- 바닷가 v2: 오두막 + 큰 파라솔과 선베드 ----
  function paintHutParasol(w, accent) {
    const mw = w * 0.76, cx = (w - mw) / 2, x0 = -w / 2;
    shifted(cx, () => paintBeachHut(mw, accent));
    // 선베드
    ctx.fillStyle = '#fffaf0'; ctx.save(); ctx.translate(x0 + 4, -6);
    rr(0, -2, 22, 4, 1.5); ctx.translate(20, 0); ctx.rotate(-0.6); rr(0, -2, 12, 4, 1.5); ctx.restore();
    ctx.fillStyle = '#c9a074'; ctx.fillRect(x0 + 6, -4, 1.6, 4); ctx.fillRect(x0 + 22, -4, 1.6, 4);
    // 큰 파라솔
    const px = x0 + 14;
    ctx.fillStyle = '#9a7a5a'; ctx.save(); ctx.translate(px, 0); ctx.rotate(0.12); ctx.fillRect(-0.9, -50, 1.8, 50);
    ctx.translate(0, -50);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? '#fffaf0' : accent; ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(-24 + i * 8, 6); ctx.lineTo(-16 + i * 8, 6); ctx.closePath(); ctx.fill(); }
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? '#fffaf0' : accent; ctx.beginPath(); ctx.arc(-20 + i * 8, 6, 4, 0, Math.PI); ctx.fill(); }
    ctx.restore();
    // 모래성
    ctx.fillStyle = '#ecd29a'; rr(x0 + w * 0.5 - 50, -8, 12, 8, 1); rr(x0 + w * 0.5 - 48, -13, 4, 5, 1); rr(x0 + w * 0.5 - 42, -12, 4, 4, 1);
  }

  // ---- 눈 지역: 통나무 오두막 (지붕에 눈이 소복, 고드름) ----
  function paintCabin(w, roof) {
    const x0 = -w / 2, wallH = 58, top = -wallH;
    const r = mulberry32(w * 3 + roof.charCodeAt(1));
    // 통나무 벽
    ctx.fillStyle = '#a8724a'; rr(x0, top, w, wallH, 5);
    for (let y = top + 3, k = 0; y < -6; y += 8, k++) {
      ctx.fillStyle = k % 2 ? '#b98258' : '#ad774e'; rr(x0 - 3, y, w + 6, 7, 3.5);
      ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(x0, y + 1, w, 1.2);
      ctx.fillStyle = '#d9a878'; circle(x0 - 1, y + 3.5, 3.2); circle(x0 + w + 1, y + 3.5, 3.2); // 통나무 끝
      ctx.strokeStyle = 'rgba(120,70,40,0.5)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(x0 - 1, y + 3.5, 1.6, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(x0 + w + 1, y + 3.5, 1.6, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(80,45,25,0.15)'; ctx.fillRect(x0 + w - 14, top, 14, wallH);
    ctx.fillStyle = '#8f8a86'; rr(x0, -7, w, 7, 2);
    // 굴뚝 (돌)
    const chx = x0 + w * 0.72, roofY = (x) => top + 4 - (1 - Math.abs(x) / (w / 2 + 10)) * 46;
    ctx.fillStyle = '#9a9590'; rr(chx - 7, roofY(chx) - 20, 14, 26, 2);
    ctx.fillStyle = '#fff'; rr(chx - 9, roofY(chx) - 24, 18, 6, 3);
    // 지붕 + 눈
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(x0 - 12, top + 6); ctx.lineTo(0, top - 44); ctx.lineTo(x0 + w + 12, top + 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fbfdff';
    ctx.beginPath(); ctx.moveTo(x0 - 14, top + 2); ctx.lineTo(0, top - 48); ctx.lineTo(x0 + w + 14, top + 2);
    for (let x = x0 + w + 14; x > x0 - 14; x -= 9) ctx.quadraticCurveTo(x - 4.5, top + 9 + r() * 3, x - 9, top + 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(160,190,225,0.45)';
    ctx.beginPath(); ctx.moveTo(0, top - 48); ctx.lineTo(x0 + w + 14, top + 2); ctx.lineTo(10, top + 2); ctx.fill();
    // 고드름
    ctx.fillStyle = '#d6ecff';
    for (let x = x0 - 6; x < x0 + w + 8; x += 7 + r() * 5) { const L = 4 + r() * 7; ctx.beginPath(); ctx.moveTo(x - 1.6, top + 6); ctx.lineTo(x, top + 6 + L); ctx.lineTo(x + 1.6, top + 6); ctx.fill(); }
    // 문
    ctx.fillStyle = '#7a4f32'; rr(-10, -34, 20, 34, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; rr(-7, -30, 5, 24, 2);
    ctx.fillStyle = '#ffd34d'; circle(6, -16, 1.6);
    // 문에 걸린 화환
    ctx.strokeStyle = '#4f9a62'; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.arc(0, -25, 4.5, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#e05a5a'; circle(0, -20.5, 1.6);
    // 창문 (따뜻한 빛 + 눈 쌓인 창턱)
    for (const wx of [x0 + 12, x0 + w - 32]) {
      ctx.fillStyle = '#6e4a32'; rr(wx - 2, -46, 24, 20, 3);
      ctx.fillStyle = '#ffe08a'; rr(wx, -44, 20, 16, 2);
      ctx.fillStyle = '#6e4a32'; ctx.fillRect(wx + 9, -44, 2, 16); ctx.fillRect(wx, -37, 20, 2);
      ctx.fillStyle = '#fbfdff'; rr(wx - 3, -28, 26, 4, 2);
    }
    // 눈 더미
    ctx.fillStyle = '#fbfdff';
    for (const [x, rx] of [[x0 + 4, 12], [x0 + w - 6, 14], [x0 + w * 0.3, 8]]) { ctx.beginPath(); ctx.ellipse(x, -1, rx, 5, 0, Math.PI, TAU); ctx.fill(); }
  }

  // ---- 눈 지역: 이글루 ----
  function paintIgloo(w, plain) {
    const R = w / 2, H = w * 0.55;
    const g = ctx.createLinearGradient(0, -H, 0, 0);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d7e8f6');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, R, H, 0, Math.PI, TAU); ctx.fill();
    // 얼음 블록 줄
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, R, H, 0, Math.PI, TAU); ctx.clip();
    ctx.strokeStyle = 'rgba(140,175,210,0.55)'; ctx.lineWidth = 1;
    const rows = 5;
    for (let i = 1; i <= rows; i++) {
      const y = -H * i / (rows + 0.6);
      ctx.beginPath(); ctx.moveTo(-R, y); ctx.lineTo(R, y); ctx.stroke();
      const y2 = -H * (i - 1) / (rows + 0.6), half = R * Math.sqrt(Math.max(0, 1 - (y / H) ** 2));
      for (let x = -half + (i % 2) * 9; x < half; x += 18) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y2); ctx.stroke(); }
    }
    ctx.fillStyle = 'rgba(120,160,210,0.18)';
    ctx.beginPath(); ctx.ellipse(R * 0.35, 0, R * 0.65, H, 0, Math.PI, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.ellipse(-R * 0.35, -H * 0.7, R * 0.22, H * 0.12, -0.4, 0, TAU); ctx.fill();
    if (plain) return;
    // 입구 굴
    const er = Math.max(13, R * 0.34);
    ctx.fillStyle = '#eef6fd'; ctx.beginPath(); ctx.ellipse(0, 2, er + 5, er * 1.05 + 4, 0, Math.PI, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(140,175,210,0.6)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#5a7290'; ctx.beginPath(); ctx.ellipse(0, 2, er * 0.68, er * 0.82, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,140,0.5)'; ctx.beginPath(); ctx.ellipse(0, 2, er * 0.4, er * 0.45, 0, Math.PI, TAU); ctx.fill();
    // 꼭대기 작은 깃발
    ctx.fillStyle = '#9a7a5a'; ctx.fillRect(-0.8, -H - 14, 1.6, 15);
    ctx.fillStyle = '#ff8a7a'; ctx.beginPath(); ctx.moveTo(0.8, -H - 14); ctx.lineTo(10, -H - 11); ctx.lineTo(0.8, -H - 8); ctx.fill();
  }

  // ---- 사막: 흙벽돌 집 (평평한 지붕, 둥근 문, 차양) ----
  function paintAdobe(w, accent) {
    const x0 = -w / 2, wallH = 56, top = -wallH;
    const r = mulberry32(w * 5 + accent.charCodeAt(2));
    ctx.fillStyle = '#eab98a'; rr(x0, top, w, wallH, 10);
    // 지붕 턱 (울퉁불퉁)
    ctx.fillStyle = '#e2ac78'; rr(x0 - 3, top - 6, w + 6, 10, 5);
    for (let x = x0 + 6; x < x0 + w - 6; x += 22) rr(x, top - 12, 12, 8, 3);
    // 흙 질감 + 그늘
    ctx.fillStyle = 'rgba(190,120,70,0.18)';
    for (let i = 0; i < 18; i++) { ctx.beginPath(); ctx.ellipse(x0 + 6 + r() * (w - 12), top + 6 + r() * (wallH - 14), 2 + r() * 2.5, 1 + r(), 0, 0, TAU); ctx.fill(); }
    ctx.fillStyle = 'rgba(150,80,40,0.14)'; rr(x0 + w - 16, top, 16, wallH, 8);
    // 나무 들보
    ctx.fillStyle = '#8a5a3a';
    for (let x = x0 + 10; x < x0 + w - 6; x += 18) { rr(x, top + 2, 6, 4, 2); }
    // 차양 (줄무늬 천)
    ctx.save(); ctx.translate(0, -40);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? '#fff4e0' : accent; ctx.beginPath(); ctx.moveTo(-18 + i * 6, 0); ctx.lineTo(-18 + (i + 1) * 6, 0); ctx.lineTo(-20 + (i + 1) * 6.7, 8); ctx.lineTo(-20 + i * 6.7, 8); ctx.fill(); }
    ctx.fillStyle = accent; for (let i = 0; i < 6; i++) circle(-17 + i * 6.7, 8.5, 1.8);
    ctx.restore();
    // 둥근 문
    ctx.fillStyle = '#7a4a32'; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-10, -22); ctx.arc(0, -22, 10, Math.PI, TAU); ctx.lineTo(10, 0); ctx.fill();
    ctx.fillStyle = accent; ctx.globalAlpha = 0.6; ctx.fillRect(-10, -12, 20, 3); ctx.globalAlpha = 1;
    // 둥근 창
    for (const wx of [x0 + 20, x0 + w - 20]) {
      ctx.fillStyle = '#c98e5e'; circle(wx, -34, 8);
      ctx.fillStyle = '#4a6a8a'; circle(wx, -34, 6);
      ctx.fillStyle = accent; ctx.fillRect(wx - 6, -34.6, 12, 1.2); ctx.fillRect(wx - 0.6, -40, 1.2, 12);
    }
    // 항아리 + 작은 선인장 화분
    ctx.fillStyle = '#c9744a'; ctx.beginPath(); ctx.ellipse(x0 + w - 8, -6, 6, 7, 0, 0, TAU); ctx.fill(); rr(x0 + w - 11, -15, 6, 3, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x0 + w - 11, -8, 6, 1.5);
    ctx.fillStyle = '#d2865a'; rr(x0 + 4, -8, 10, 8, 2);
    ctx.fillStyle = '#6fae5a'; rr(x0 + 6.5, -20, 5, 13, 2.5); rr(x0 + 3, -16, 3.5, 6, 1.7);
  }

  // ---- 사막: 줄무늬 천막 ----
  function paintTent(w, accent) {
    const R = w / 2, H = w * 0.62;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(-R, 0); ctx.quadraticCurveTo(-R * 0.4, -H * 0.55, 0, -H); ctx.quadraticCurveTo(R * 0.4, -H * 0.55, R, 0); ctx.closePath();
    ctx.fillStyle = '#fff4e0'; ctx.fill(); ctx.clip();
    ctx.fillStyle = accent;
    for (let x = -R; x < R; x += 16) { ctx.beginPath(); ctx.moveTo(0, -H); ctx.lineTo(x, 0); ctx.lineTo(x + 8, 0); ctx.fill(); }
    ctx.fillStyle = 'rgba(120,70,30,0.15)'; ctx.fillRect(R * 0.25, -H, R, H);
    ctx.restore();
    // 열린 문
    ctx.fillStyle = '#6a4a3a'; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(0, -H * 0.55); ctx.lineTo(9, 0); ctx.fill();
    ctx.fillStyle = '#fff4e0'; ctx.beginPath(); ctx.moveTo(0, -H * 0.55); ctx.lineTo(-13, 0); ctx.lineTo(-7, 0); ctx.fill();
    // 꼭대기 장식 + 줄
    ctx.fillStyle = '#d9a640'; circle(0, -H - 2, 3);
    ctx.strokeStyle = 'rgba(120,90,60,0.6)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(-R * 0.5, -H * 0.45); ctx.lineTo(-R - 8, 0); ctx.moveTo(R * 0.5, -H * 0.45); ctx.lineTo(R + 8, 0); ctx.stroke();
  }

  // ---- 밀림: 기둥 위 오두막 (풀 지붕, 사다리) ----
  function paintStilt(w, accent) {
    const x0 = -w / 2, post = 24, wallH = 40, floor = -post, top = floor - wallH;
    const r = mulberry32(w * 7 + accent.charCodeAt(3));
    // 기둥
    ctx.fillStyle = '#8a5f3a';
    for (const x of [x0 + 6, x0 + w * 0.36, x0 + w * 0.64, x0 + w - 10]) rr(x, floor - 2, 5, post + 2, 2);
    // 마루
    ctx.fillStyle = '#b07e4e'; rr(x0 - 6, floor - 4, w + 12, 6, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x0 - 6, floor - 4, w + 12, 1.3);
    // 대나무 벽
    ctx.fillStyle = '#d9bc7a'; rr(x0, top, w, wallH, 3);
    ctx.strokeStyle = 'rgba(140,100,50,0.4)'; ctx.lineWidth = 0.8;
    for (let x = x0 + 5; x < x0 + w; x += 5) { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, floor - 4); ctx.stroke(); }
    ctx.fillStyle = 'rgba(120,80,40,0.15)'; ctx.fillRect(x0 + w - 12, top, 12, wallH);
    // 문 + 사다리
    ctx.fillStyle = '#6a4a2a'; rr(-9, floor - 30, 18, 26, 6);
    ctx.fillStyle = accent; ctx.globalAlpha = 0.7; rr(-9, floor - 30, 18, 6, 3); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#9a6a3a'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(-7, floor); ctx.lineTo(-9, 0); ctx.moveTo(7, floor); ctx.lineTo(9, 0); ctx.stroke();
    ctx.lineWidth = 1.4;
    for (let k = 1; k < 5; k++) { const y = floor + (post * k) / 5; ctx.beginPath(); ctx.moveTo(-7 - k * 0.4, y); ctx.lineTo(7 + k * 0.4, y); ctx.stroke(); }
    // 창 (덧문)
    ctx.fillStyle = '#5a3e26'; rr(x0 + 8, top + 10, 16, 14, 2); rr(x0 + w - 24, top + 10, 16, 14, 2);
    ctx.fillStyle = accent; rr(x0 + 3, top + 10, 5, 14, 1); rr(x0 + w - 8, top + 10, 5, 14, 1);
    // 풀 지붕 (겹겹이, 끝이 술처럼)
    const roofTop = top - 40;
    for (let layer = 0; layer < 3; layer++) {
      const y = top + 4 - layer * 13, spread = w / 2 + 18 - layer * 12;
      ctx.fillStyle = ['#c9a25a', '#d6b06a', '#e2bf7a'][layer];
      ctx.beginPath(); ctx.moveTo(-spread, y); ctx.lineTo(0, roofTop); ctx.lineTo(spread, y);
      for (let x = spread; x > -spread; x -= 6) ctx.lineTo(x - 3, y + 4 + r() * 3);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(140,100,40,0.35)'; ctx.lineWidth = 0.7;
    for (let i = 0; i < 14; i++) { const x = -w / 2 - 10 + r() * (w + 20); ctx.beginPath(); ctx.moveTo(x * 0.3, roofTop + 10); ctx.lineTo(x, top + 4); ctx.stroke(); }
    ctx.fillStyle = '#8a6a3a'; circle(0, roofTop + 1, 3.5);
    // 기둥에 감긴 덩굴 잎
    ctx.fillStyle = '#5fae5a';
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.ellipse(x0 + 8 + Math.sin(i) * 3, floor + 4 + i * 3.5, 2.6, 1.4, i, 0, TAU); ctx.fill(); }
  }

  // ---- 바닷가: 알록달록 줄무늬 오두막 (나무 데크, 구명튜브) ----
  function paintBeachHut(w, accent) {
    const x0 = -w / 2, wallH = 52, top = -wallH - 6;
    // 데크
    ctx.fillStyle = '#c9a074'; rr(x0 - 8, -7, w + 16, 7, 2);
    ctx.strokeStyle = 'rgba(120,80,50,0.35)'; ctx.lineWidth = 0.6;
    for (let x = x0 - 2; x < x0 + w + 8; x += 7) { ctx.beginPath(); ctx.moveTo(x, -7); ctx.lineTo(x, 0); ctx.stroke(); }
    // 줄무늬 벽
    ctx.save(); ctx.beginPath(); ctx.roundRect(x0, top, w, wallH, 3); ctx.clip();
    for (let x = x0, k = 0; x < x0 + w; x += 9, k++) { ctx.fillStyle = k % 2 ? '#fffaf0' : accent; ctx.fillRect(x, top, 9, wallH); }
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(x0 + w - 12, top, 12, wallH);
    ctx.restore();
    // 박공 지붕
    ctx.fillStyle = '#fffaf0';
    ctx.beginPath(); ctx.moveTo(x0 - 8, top + 3); ctx.lineTo(0, top - 30); ctx.lineTo(x0 + w + 8, top + 3); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x0 - 8, top + 3); ctx.lineTo(0, top - 30); ctx.lineTo(x0 + w + 8, top + 3); ctx.stroke();
    ctx.fillStyle = accent; circle(0, top - 14, 4.5); ctx.fillStyle = '#fff3a8'; circle(0, top - 14, 3);
    // 문
    ctx.fillStyle = '#fffaf0'; rr(-11, -42, 22, 36, 4);
    ctx.fillStyle = accent; rr(-8, -39, 16, 30, 3);
    ctx.fillStyle = '#fffaf0'; circle(5, -24, 1.5);
    // 창 + 덧문
    const wx = x0 + w - 22;
    ctx.fillStyle = '#fff3a8'; rr(wx - 7, -44, 14, 12, 2);
    ctx.fillStyle = '#fffaf0'; ctx.fillRect(wx - 0.6, -44, 1.2, 12);
    ctx.fillStyle = accent; rr(wx - 12, -44, 5, 12, 1); rr(wx + 7, -44, 5, 12, 1);
    // 구명 튜브
    const lx = x0 + 12;
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(lx, -30, 6, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ff6b6b'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(lx, -30, 6, i * Math.PI / 2, i * Math.PI / 2 + 0.6); ctx.stroke(); }
    // 서핑보드
    ctx.save(); ctx.translate(x0 + w + 6, -22); ctx.rotate(0.12);
    ctx.fillStyle = '#ffd36e'; ctx.beginPath(); ctx.ellipse(0, 0, 4.5, 22, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = accent; ctx.fillRect(-0.8, -20, 1.6, 40);
    ctx.restore();
  }
  // 집 한 채를 (문 아래 가운데 = 0,0) 기준으로 자세히 그린다
  function paintHouse(w, roof, wallH = 58) {
    const h = { x: 0, w, roof }, x0 = -w / 2, base = 0;
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
    const base = h.y + h.h / 2, sc = h.s || 1, pw = h.pw || h.w;
    for (const [lx, ly] of (HOUSE_LIGHTS[h.style] || HOUSE_LIGHTS.cottage)(pw, h.v || 0)) glow(h.x + lx * sc, base + ly * sc, 30 * sc, `rgba(255,200,110,${0.5 * night})`);
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
      case 'ride': {
        const gal = z.moving && z.moveMode === 'run';
        return { hipY: -0.04, rot: (gal ? 0.22 : 0.06) + breathe, headTilt: z.moving ? Math.sin(z.walkAnim * 2) * 0.05 : Math.sin(t * 0.7) * 0.04, legs: 'ride', arms: eating ? 'grab' : 'rein', w: 0, shadow: 0 };
      }
      default:
        return { hipY: -0.34, rot: (eating ? 0.25 : 0) + breathe, headTilt: eating ? 0.1 : 0, legs: 'stand', arms: eating ? 'grab' : 'zombie', w: 0, shadow: 0.42 };
    }
  }

  let zPincers = false;
  // 캐릭터별 색 (game.js CHARACTERS와 같은 이름)
  const LOOKS = {
    sprout:  { size: 1,    skin: '#a9db94', body: '#9fd18b', dark: '#8cc27a', shade: 'rgba(70,130,60,0.22)', stitch: '#6a8a5a', line: '#4a5a3a', pants: '#5b6c8f', shoe: '#7a5640', shirt: '#e6c9a8' },
    zip:     { size: 0.96, skin: '#a8dcef', body: '#94cfe6', dark: '#7dbbd6', shade: 'rgba(50,110,150,0.22)', stitch: '#5a88a0', line: '#35506a', pants: '#3f5f9a', shoe: '#ff5a52', shirt: '#ffe066' },
    mungchi: { size: 1.16, skin: '#cbb4ec', body: '#bca3e2', dark: '#a78dd2', shade: 'rgba(100,70,150,0.22)', stitch: '#8a70a8', line: '#4e3e66', pants: '#5aa0d8', shoe: '#6a4a3a', shirt: '#ffb3b3' },
    meow:    { size: 0.94, skin: '#f7c6d8', body: '#efb4ca', dark: '#e19db7', shade: 'rgba(170,80,120,0.2)',  stitch: '#b77a95', line: '#6a3e52', pants: '#7a6aa8', shoe: '#5a4a6a', shirt: '#fffaf4' },
  };
  let ZC = LOOKS.sprout;
  // 셔츠 무늬: 새싹이 기운 천 · 쌩쌩이 번개 · 뭉치 멜빵바지 · 살금이 줄무늬
  function shirtDeco(z, s) {
    if (z.char === 'zip') {
      ctx.fillStyle = '#ff6b4a';
      ctx.beginPath(); ctx.moveTo(s * 0.02, -s * 0.27); ctx.lineTo(-s * 0.1, -s * 0.12); ctx.lineTo(-s * 0.01, -s * 0.12); ctx.lineTo(-s * 0.06, s * 0.0); ctx.lineTo(s * 0.12, -s * 0.16); ctx.lineTo(s * 0.03, -s * 0.16); ctx.lineTo(s * 0.09, -s * 0.27); ctx.closePath(); ctx.fill();
    } else if (z.char === 'mungchi') {
      ctx.fillStyle = ZC.pants;
      rr(-s * 0.18, -s * 0.22, s * 0.36, s * 0.25, s * 0.04);
      ctx.fillRect(-s * 0.18, -s * 0.31, s * 0.06, s * 0.1); ctx.fillRect(s * 0.1, -s * 0.31, s * 0.06, s * 0.1);
      ctx.fillStyle = '#ffd34d'; circle(-s * 0.14, -s * 0.2, s * 0.025); circle(s * 0.13, -s * 0.2, s * 0.025);
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; rr(-s * 0.08, -s * 0.14, s * 0.14, s * 0.07, s * 0.02);
    } else if (z.char === 'meow') {
      ctx.fillStyle = '#ff9fbf';
      for (const y of [-s * 0.24, -s * 0.15, -s * 0.06]) ctx.fillRect(-s * 0.28, y, s * 0.56, s * 0.045);
      ctx.fillStyle = '#7fc8e8'; ctx.beginPath(); ctx.ellipse(s * 0.06, -s * 0.11, s * 0.06, s * 0.03, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.0, -s * 0.11); ctx.lineTo(-s * 0.04, -s * 0.14); ctx.lineTo(-s * 0.04, -s * 0.08); ctx.fill();
    } else {
      ctx.fillStyle = '#c9d8f0'; rr(-s * 0.18, -s * 0.2, s * 0.13, s * 0.11, s * 0.02);
      ctx.strokeStyle = '#7a6a5a'; ctx.lineWidth = s * 0.012; ctx.setLineDash([s * 0.02, s * 0.02]);
      ctx.strokeRect(-s * 0.17, -s * 0.19, s * 0.11, s * 0.09); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(150,120,90,0.35)';
      rr(s * 0.04, -s * 0.16, s * 0.08, s * 0.1, s * 0.03);
    }
  }
  // 쌩쌩이 빨간 머리띠: 뒤로 끈이 펄럭
  function zipBand(z, s) {
      const flap = Math.sin(t * (z.moving ? 14 : 3)) * (z.moving ? 0.35 : 0.12);
      ctx.save(); ctx.translate(-s * 0.3, -s * 0.13);
      for (const [a0, len] of [[0.35, 0.2], [0.05, 0.17]]) {
        ctx.save(); ctx.rotate(Math.PI + a0 + flap * (len > 0.18 ? 1 : -0.8) - (z.moving ? 0.3 : -0.4));
        ctx.fillStyle = '#e8423f'; rr(0, -s * 0.025, s * len, s * 0.05, s * 0.02); ctx.restore();
      }
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, s * 0.345, s * 0.305, 0, 0, TAU); ctx.clip();
      ctx.fillStyle = '#ff5a52'; ctx.beginPath(); ctx.moveTo(-s * 0.4, -s * 0.12); ctx.quadraticCurveTo(0, -s * 0.24, s * 0.4, -s * 0.14); ctx.lineTo(s * 0.4, -s * 0.07); ctx.quadraticCurveTo(0, -s * 0.17, -s * 0.4, -s * 0.05); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffe066'; ctx.beginPath(); ctx.moveTo(s * 0.03, -s * 0.2); ctx.lineTo(-s * 0.015, -s * 0.13); ctx.lineTo(s * 0.02, -s * 0.13); ctx.lineTo(-s * 0.01, -s * 0.07); ctx.lineTo(s * 0.07, -s * 0.15); ctx.lineTo(s * 0.03, -s * 0.15); ctx.lineTo(s * 0.06, -s * 0.2); ctx.closePath(); ctx.fill();
      ctx.restore();
  }
  // 캐릭터 고르는 화면용 그림: 작은 캔버스에 좀비 하나만
  function portrait(cv, id, walking, extra) {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
    const k = h / 66;
    g.setTransform(k, 0, 0, k, w / 2, h * 0.9);
    const keep = ctx; ctx = g;
    drawZombie({ x: 0, y: 0, facing: 1, pose: walking ? 'walk' : 'stand', walkAnim: t * 7, eatAnim: 0, traits: [], power: 1, char: id, moving: walking, ...extra });
    ctx = keep;
  }
  function drawZombie(z) {
    ZC = LOOKS[z.char] || LOOKS.sprout;
    const s = 30 * ZC.size * (1 + Math.min(z.power, 40) * 0.012);
    zPincers = z.traits.includes('pincers');
    const p = zombiePose(z, s);
    const hipY = p.hipY * s;
    // 말 타기: 말을 먼저 그리고, 좀비는 안장 위에 앉힌다
    const horse = z.riding ? state.creatures.find((c) => c.ridden) : null;
    let rideY = 0;
    if (horse) {
      const gait = !z.moving ? 'idle' : z.moveMode === 'run' ? 'gallop' : 'walk';
      shadow(z.x, z.y, 22, 5.5, 1.6);
      ctx.save(); ctx.translate(z.x, z.y); ctx.scale(z.facing, 1);
      rideY = -horseBody(horse, gait, z.walkAnim * 2, true);
      ctx.restore();
      if (gait === 'gallop' && Math.random() < 0.35) particles.push({ x: z.x - z.facing * 10, y: z.y - 1, vx: -z.facing * (12 + Math.random() * 18), vy: -10 - Math.random() * 8, life: 0.5, kind: 'dust' });
    } else shadow(z.x + (p.legs === 'prone' ? -s * 0.1 : 0), z.y, s * p.shadow, s * 0.12);

    ctx.save();
    ctx.translate(z.x - (horse ? z.facing * 2 : 0) + (z.hurt > 0 ? Math.sin(t * 90) * 2 : 0), z.y + rideY);
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
    // 어깨 위 앵무새 친구
    if (z.traits.includes('parrot') && z.pose !== 'lie' && z.pose !== 'prone') {
      const bx = hx - s * 0.36, by = hy + s * 0.26 - Math.abs(Math.sin(t * 2)) * s * 0.01;
      ctx.save(); ctx.translate(bx, by); ctx.scale(s / 30, s / 30);
      ctx.fillStyle = '#3fa9e0'; ctx.beginPath(); ctx.moveTo(-2, -2); ctx.lineTo(-6, 5); ctx.lineTo(-3.5, 5.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ef5a4f'; ctx.beginPath(); ctx.ellipse(0, -4, 3.4, 4.2, 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffb35a'; ctx.beginPath(); ctx.ellipse(0.8, -3, 2, 2.6, 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#3fa9e0'; ctx.beginPath(); ctx.ellipse(-1.4, -3.6, 1.6, 3, 0.3, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ef5a4f'; circle(0.8, -9, 2.8);
      ctx.beginPath(); ctx.moveTo(-0.5, -11); ctx.quadraticCurveTo(-2.5, -14, 0, -14.5); ctx.quadraticCurveTo(0.5, -12.5, 1.2, -11.6); ctx.fill();
      ctx.fillStyle = '#f4ead8'; ctx.beginPath(); ctx.moveTo(3, -9.8); ctx.quadraticCurveTo(5.4, -9.6, 4.8, -7.4); ctx.lineTo(3.2, -8); ctx.fill();
      ctx.fillStyle = '#2e2a28'; circle(1.6, -9.6, 0.7); ctx.fillStyle = '#fff'; circle(1.85, -9.9, 0.25);
      ctx.restore();
    }

    // 엎드렸을 때 턱 괴는 손은 머리 앞에
    if (p.arms === 'chin') {
      ctx.fillStyle = ZC.body;
      circle(hx + s * 0.12, hy + s * 0.24, s * 0.08);
      circle(hx - s * 0.08, hy + s * 0.25, s * 0.08);
    }
    ctx.restore();

    // 맞았을 때 빨갛게 번쩍
    if (z.hurt > 0) { ctx.save(); ctx.globalAlpha = z.hurt * 0.9; glow(z.x, z.y - s * 0.6, s * 1.1, 'rgba(255,90,100,0.55)'); ctx.restore(); }
    // 기절: 머리 위로 별이 빙글빙글
    if (z.fainted > 0) {
      for (let i = 0; i < 4; i++) { const a = t * 4 + (i * TAU) / 4; ctx.fillStyle = '#ffd34d'; star(z.x + z.facing * s * 0.2 + Math.cos(a) * s * 0.4, z.y - s * 0.55 + Math.sin(a) * s * 0.12, 3); }
    }
    // 효과: 잠 / 뛸 때 먼지
    if (z.pose === 'lie' && !(z.fainted > 0) && Math.random() < 0.025) {
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
    const C = ZC.pants, W = s * 0.16, w = p.w;
    const shoe = (x, y) => { ctx.fillStyle = ZC.shoe; ctx.beginPath(); ctx.ellipse(x + W * 0.25, y, W * 0.72, W * 0.48, 0, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.25)'; circle(x + W * 0.4, y - W * 0.15, W * 0.18); };
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
      case 'ride': // 말 옆구리로 다리 하나 늘어뜨리기 (다른 쪽은 말 몸에 가려짐)
        leg2(s * 0.02, hipY, s * 0.15, hipY + s * 0.16, s * 0.06, hipY + s * 0.38 + Math.sin(t * 2) * s * 0.01, W, C);
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
    // 목도리 꼬리: 움직이면 뒤로 펄럭
    if (has('scarf')) {
      const flap = z.moving ? Math.sin(t * 10) * 0.25 : 0;
      ctx.save(); ctx.translate(-s * 0.12, -s * 0.48); ctx.rotate((z.moving ? -1.25 : -0.25) + flap);
      ctx.fillStyle = '#d8434f'; rr(-s * 0.05, 0, s * 0.11, s * 0.32, s * 0.03);
      ctx.fillStyle = '#fff4e8'; ctx.fillRect(-s * 0.05, s * 0.1, s * 0.11, s * 0.04); ctx.fillRect(-s * 0.05, s * 0.2, s * 0.11, s * 0.04);
      ctx.strokeStyle = '#d8434f'; ctx.lineWidth = s * 0.015;
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.035 + i * s * 0.03, s * 0.32); ctx.lineTo(-s * 0.035 + i * s * 0.03, s * 0.37); ctx.stroke(); }
      ctx.restore();
    }
    // 원숭이 꼬리: 엉덩이 뒤로 동그랗게 말려 살랑
    if (has('tail')) {
      const sw = Math.sin(t * 2.2) * s * 0.03;
      ctx.strokeStyle = ZC.dark; ctx.lineWidth = s * 0.06; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.06); ctx.quadraticCurveTo(-s * 0.55, -s * 0.02, -s * 0.52 + sw, -s * 0.36);
      ctx.arc(-s * 0.43 + sw, -s * 0.36, s * 0.09, Math.PI, Math.PI * 2.4); ctx.stroke();
    }
    // 살금이 고양이 꼬리: 위로 말려 올라가 살랑 (원숭이 꼬리가 생기면 그쪽을 보여 준다)
    if (z.char === 'meow' && !has('tail')) {
      const sw = Math.sin(t * 2.6) * s * 0.05;
      ctx.strokeStyle = ZC.dark; ctx.lineWidth = s * 0.08; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-s * 0.2, -s * 0.08); ctx.quadraticCurveTo(-s * 0.5, -s * 0.05, -s * 0.46 + sw, -s * 0.42); ctx.stroke();
      ctx.strokeStyle = '#fff4f8'; ctx.lineWidth = s * 0.085;
      ctx.beginPath(); ctx.moveTo(-s * 0.465 + sw, -s * 0.37); ctx.lineTo(-s * 0.46 + sw, -s * 0.43); ctx.stroke();
    }
    // 뒤쪽 팔
    drawArm(p, s, 1);
    ctx.fillStyle = ZC.body;
    rr(-s * 0.28, -s * 0.5, s * 0.56, s * 0.54, s * 0.18);
    // 낡은 셔츠: 아래 끝이 들쭉날쭉
    ctx.fillStyle = ZC.shirt;
    ctx.beginPath();
    ctx.moveTo(-s * 0.28, -s * 0.24);
    ctx.quadraticCurveTo(-s * 0.28, -s * 0.3, -s * 0.2, -s * 0.3);
    ctx.lineTo(s * 0.2, -s * 0.3); ctx.quadraticCurveTo(s * 0.28, -s * 0.3, s * 0.28, -s * 0.24);
    ctx.lineTo(s * 0.28, -s * 0.02);
    for (let i = 0; i <= 6; i++) ctx.lineTo(s * 0.28 - i * s * 0.0933, i % 2 ? s * 0.03 : -s * 0.03);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(150,120,90,0.18)'; ctx.fillRect(s * 0.12, -s * 0.3, s * 0.16, s * 0.3);
    shirtDeco(z, s);
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
    // 목도리: 목에 두른 부분 (줄무늬) + 앞으로 늘어진 끝
    if (has('scarf')) {
      ctx.fillStyle = '#e8505b'; rr(-s * 0.3, -s * 0.57, s * 0.6, s * 0.14, s * 0.07);
      ctx.fillStyle = '#fff4e8'; for (const x of [-s * 0.16, s * 0.04]) ctx.fillRect(x, -s * 0.57, s * 0.05, s * 0.14);
      ctx.fillStyle = 'rgba(120,20,30,0.2)'; rr(-s * 0.3, -s * 0.48, s * 0.6, s * 0.05, s * 0.025);
      if (!z.moving) {
        ctx.fillStyle = '#e8505b'; rr(s * 0.08, -s * 0.48, s * 0.11, s * 0.26, s * 0.03);
        ctx.fillStyle = '#fff4e8'; ctx.fillRect(s * 0.08, -s * 0.38, s * 0.11, s * 0.035);
      }
    }
    // 앞쪽 팔
    drawArm(p, s, 0);
  }

  function drawArm(p, s, back) {
    const C = back ? ZC.dark : ZC.body, W = s * 0.12;
    const sy = back ? -s * 0.42 : -s * 0.32; // 어깨 높이
    const sx = s * 0.06;
    const hand = (x, y) => {
      if (zPincers) { // 꽃게 집게 장갑
        const snap = Math.sin(t * 3 + back) > 0.7 ? 0.35 : 0;
        ctx.fillStyle = back ? '#d4553a' : '#f0704f'; circle(x, y, W * 0.7);
        ctx.beginPath(); ctx.moveTo(x, y - W * 0.2); ctx.lineTo(x + W * 0.9, y - W * (0.9 + snap)); ctx.lineTo(x + W * 0.7, y - W * 0.1); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y + W * 0.1); ctx.lineTo(x + W * 0.95, y + W * (0.5 + snap)); ctx.lineTo(x + W * 0.5, y + W * 0.45); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; circle(x - W * 0.2, y - W * 0.25, W * 0.2);
        return;
      }
      ctx.fillStyle = back ? ZC.dark : ZC.skin; circle(x, y, W * 0.62); ctx.fillStyle = 'rgba(255,255,255,0.25)'; circle(x - W * 0.15, y - W * 0.2, W * 0.2);
    };
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
      case 'rein': // 고삐 잡듯 두 손을 앞으로
        return arm2(sx, sy, sx + s * 0.16, sy + s * 0.14, sx + s * 0.36 + (back ? -s * 0.04 : 0), sy + s * 0.12, W, C);
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
      ctx.fillStyle = ZC.skin;
      ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.38, s * 0.07, s * 0.2, -0.2 - flop, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.1, -s * 0.36, s * 0.07, s * 0.2, 0.5 - flop, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f7b6c4';
      ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.38, s * 0.035, s * 0.13, -0.2 - flop, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.1, -s * 0.36, s * 0.035, s * 0.13, 0.5 - flop, 0, TAU); ctx.fill();
    }
    // 캐릭터 머리 장식 (머리 뒤): 살금이 고양이 귀 · 뭉치 작은 뿔
    if (z.char === 'meow' && !has('ears')) {
      for (const [x, k] of [[-s * 0.17, -1], [s * 0.15, 1]]) {
        ctx.fillStyle = ZC.skin; ctx.beginPath(); ctx.moveTo(x - s * 0.12, -s * 0.16); ctx.lineTo(x + k * s * 0.03, -s * 0.44); ctx.lineTo(x + s * 0.12, -s * 0.2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ff9fbf'; ctx.beginPath(); ctx.moveTo(x - s * 0.06, -s * 0.2); ctx.lineTo(x + k * s * 0.025, -s * 0.36); ctx.lineTo(x + s * 0.06, -s * 0.22); ctx.closePath(); ctx.fill();
      }
    }
    if (z.char === 'mungchi') {
      for (const x of [-s * 0.16, s * 0.16]) {
        ctx.fillStyle = '#fff1c9'; ctx.beginPath(); ctx.moveTo(x - s * 0.07, -s * 0.2); ctx.quadraticCurveTo(x - s * 0.02, -s * 0.44, x + x * 0.25, -s * 0.42); ctx.quadraticCurveTo(x + s * 0.06, -s * 0.3, x + s * 0.07, -s * 0.2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(200,160,110,0.35)'; ctx.fillRect(x - s * 0.06, -s * 0.3, s * 0.11, s * 0.025);
      }
    }
    ctx.fillStyle = ZC.skin;
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.34, s * 0.3, 0, 0, TAU); ctx.fill();
    // 머리 입체감: 아래 그늘 + 위쪽 빛
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, s * 0.34, s * 0.3, 0, 0, TAU); ctx.clip();
    ctx.fillStyle = ZC.shade; ctx.beginPath(); ctx.ellipse(-s * 0.04, s * 0.26, s * 0.42, s * 0.2, 0, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.17, s * 0.1, s * 0.05, -0.4, 0, TAU); ctx.fill();
    // 이마 꿰맨 자국
    ctx.strokeStyle = ZC.stitch; ctx.lineWidth = s * 0.014; ctx.lineCap = 'round';
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
      ctx.strokeStyle = ZC.line; ctx.lineWidth = s * 0.025; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(s * 0.12, -s * 0.04, s * 0.06, 0.2, Math.PI - 0.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(-s * 0.1, -s * 0.03, s * 0.045, 0.2, Math.PI - 0.2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,140,150,0.45)';
    circle(s * 0.2, s * 0.08, s * 0.05);
    ctx.strokeStyle = ZC.line;
    ctx.lineWidth = Math.max(1, s * 0.025);
    ctx.beginPath();
    const grin = z.traits.includes('smile') && z.eatAnim <= 0 && z.pose !== 'lie';
    if (grin) { // 쿼카 미소: 활짝 웃는 입 + 혀 + 반대쪽 볼도 발그레
      ctx.fillStyle = 'rgba(255,140,150,0.35)'; circle(-s * 0.18, s * 0.08, s * 0.05);
      ctx.fillStyle = '#b8475a'; ctx.beginPath(); ctx.arc(s * 0.06, s * 0.07, s * 0.085, 0.05, Math.PI - 0.05); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ff8fa3'; ctx.beginPath(); ctx.ellipse(s * 0.06, s * 0.125, s * 0.04, s * 0.022, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.06, s * 0.07, s * 0.085, 0.05, Math.PI - 0.05); ctx.closePath();
    } else if (z.eatAnim > 0) ctx.ellipse(s * 0.06, s * 0.12, s * 0.07, s * 0.06, 0, 0, TAU);
    else if (z.pose === 'run') ctx.ellipse(s * 0.07, s * 0.11, s * 0.05, s * 0.04, 0, 0, TAU);
    else ctx.arc(s * 0.05, s * 0.07, s * 0.06, 0.2, Math.PI - 0.2);
    ctx.stroke();
    // 삐죽 나온 이빨 하나
    if (z.eatAnim <= 0 && z.pose !== 'run' && !grin) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(s * 0.07, s * 0.122); ctx.lineTo(s * 0.1, s * 0.118); ctx.lineTo(s * 0.087, s * 0.16); ctx.fill(); }

    // 살금이 수염
    if (z.char === 'meow') {
      ctx.strokeStyle = 'rgba(110,60,80,0.55)'; ctx.lineWidth = s * 0.012; ctx.lineCap = 'round';
      for (const dy of [-0.015, 0.025]) { ctx.beginPath(); ctx.moveTo(s * 0.24, s * (0.06 + dy)); ctx.lineTo(s * 0.38, s * (0.04 + dy * 2)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-s * 0.2, s * (0.07 + dy)); ctx.lineTo(-s * 0.33, s * (0.06 + dy * 2)); ctx.stroke(); }
      ctx.fillStyle = '#ff8fb3'; ctx.beginPath(); ctx.ellipse(s * 0.07, s * 0.035, s * 0.025, s * 0.018, 0, 0, TAU); ctx.fill();
    }
    // 귀마개: 머리띠 + 복슬복슬 동그라미
    if (has('earmuffs')) {
      ctx.strokeStyle = '#c99be0'; ctx.lineWidth = s * 0.05; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, -s * 0.02, s * 0.36, Math.PI + 0.35, TAU - 0.35); ctx.stroke();
      for (const [x, y, k] of [[-s * 0.33, s * 0.02, 0.9], [s * 0.31, s * 0.03, 1]]) {
        ctx.fillStyle = '#ffb3c8';
        for (let i = 0; i < 7; i++) { const a = i * 0.9; circle(x + Math.cos(a) * s * 0.07 * k, y + Math.sin(a) * s * 0.07 * k, s * 0.045 * k); }
        circle(x, y, s * 0.08 * k);
        ctx.fillStyle = 'rgba(255,255,255,0.6)'; circle(x - s * 0.025, y - s * 0.03, s * 0.025 * k);
      }
    }
    // 모자는 하나만: 그 지역 모자 먼저 (겨울 털모자 · 사막 탐험모), 아니면 밀짚모자
    const hatKind = zSnow && has('beanie') ? 'beanie' : zDesert && has('safari') ? 'safari' : zBeach && has('sailor') ? 'sailor'
      : has('hat') ? 'hat' : has('safari') ? 'safari' : has('sailor') ? 'sailor' : has('beanie') ? 'beanie' : null;
    if (z.char === 'zip' && hatKind) zipBand(z, s);
    // 히비스커스 꽃: 귀 뒤에 꽂기
    if (has('hibiscus')) {
      const fx = -s * 0.27, fy = -s * 0.1;
      for (let k = 0; k < 5; k++) { const a = k * 1.2566 + 0.3; ctx.fillStyle = '#e8456a'; ctx.beginPath(); ctx.ellipse(fx + Math.cos(a) * s * 0.06, fy + Math.sin(a) * s * 0.06, s * 0.065, s * 0.045, a, 0, TAU); ctx.fill(); }
      ctx.fillStyle = '#ff7896'; circle(fx, fy, s * 0.045);
      ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = s * 0.012; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + s * 0.07, fy - s * 0.05); ctx.stroke();
    }
    const beanie = hatKind === 'beanie';
    // 선글라스: 누워 있으면 이마 위로 올린다
    if (has('shades')) {
      const up = z.pose === 'lie' ? -s * 0.15 : 0;
      ctx.save(); ctx.translate(0, up);
      ctx.strokeStyle = '#3a3340'; ctx.lineWidth = s * 0.022;
      ctx.beginPath(); ctx.moveTo(-s * 0.3, -s * 0.06); ctx.lineTo(-s * 0.17, -s * 0.04); ctx.moveTo(-s * 0.03, -s * 0.035); ctx.lineTo(s * 0.03, -s * 0.035); ctx.stroke();
      for (const [x, w] of [[-s * 0.1, s * 0.085], [s * 0.12, s * 0.1]]) {
        ctx.fillStyle = '#3a3340'; ctx.beginPath(); ctx.ellipse(x, -s * 0.02, w, s * 0.07, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ff7aa8'; ctx.beginPath(); ctx.ellipse(x, -s * 0.02, w * 0.82, s * 0.055, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffb36b'; ctx.beginPath(); ctx.ellipse(x, s * 0.005, w * 0.75, s * 0.03, 0, 0, Math.PI); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.ellipse(x - w * 0.35, -s * 0.045, w * 0.22, s * 0.015, -0.4, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    if (hatKind === 'sailor') {
      // 세일러 모자: 하얀 둥근 모자 + 남색 띠 + 닻
      ctx.fillStyle = '#e6edf2'; ctx.beginPath(); ctx.ellipse(0, -s * 0.2, s * 0.33, s * 0.09, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff'; rr(-s * 0.26, -s * 0.38, s * 0.52, s * 0.19, s * 0.08);
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(0, -s * 0.37, s * 0.27, s * 0.07, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#3a5a9a'; ctx.fillRect(-s * 0.26, -s * 0.26, s * 0.52, s * 0.055);
      ctx.strokeStyle = '#3a5a9a'; ctx.lineWidth = s * 0.012;
      const ax = s * 0.08, ay = -s * 0.32;
      ctx.beginPath(); ctx.moveTo(ax, ay - s * 0.03); ctx.lineTo(ax, ay + s * 0.03); ctx.moveTo(ax - s * 0.02, ay - s * 0.015); ctx.lineTo(ax + s * 0.02, ay - s * 0.015); ctx.stroke();
      ctx.beginPath(); ctx.arc(ax, ay + s * 0.01, s * 0.02, 0.2, Math.PI - 0.2); ctx.stroke();
      ctx.fillStyle = 'rgba(150,170,190,0.3)'; ctx.beginPath(); ctx.ellipse(s * 0.1, -s * 0.3, s * 0.12, s * 0.05, 0, 0, TAU); ctx.fill();
    } else if (hatKind === 'safari') {
      // 탐험가 모자: 둥근 꼭대기 + 넓은 챙 + 띠
      ctx.fillStyle = '#c9b07a'; ctx.beginPath(); ctx.ellipse(0, -s * 0.2, s * 0.46, s * 0.1, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#e9d6a4'; ctx.beginPath(); ctx.ellipse(0, -s * 0.215, s * 0.44, s * 0.09, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#e1cb94'; ctx.beginPath(); ctx.ellipse(0, -s * 0.24, s * 0.27, s * 0.24, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(150,120,70,0.25)'; ctx.beginPath(); ctx.ellipse(s * 0.08, -s * 0.25, s * 0.18, s * 0.21, 0, Math.PI * 1.15, TAU); ctx.fill();
      ctx.fillStyle = '#8a6440'; ctx.fillRect(-s * 0.27, -s * 0.29, s * 0.54, s * 0.05);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-s * 0.1, -s * 0.4, s * 0.08, s * 0.035, -0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c9b07a'; circle(0, -s * 0.48, s * 0.03);
    } else if (beanie) {
      // 방울 털모자: 줄무늬 + 접힌 챙 + 방울
      ctx.fillStyle = '#e85d6f';
      ctx.beginPath(); ctx.ellipse(0, -s * 0.16, s * 0.33, s * 0.27, 0, Math.PI, TAU); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.ellipse(0, -s * 0.16, s * 0.33, s * 0.27, 0, Math.PI, TAU); ctx.clip();
      ctx.fillStyle = '#fff4e8'; ctx.fillRect(-s * 0.4, -s * 0.33, s * 0.8, s * 0.06);
      ctx.strokeStyle = 'rgba(150,40,60,0.3)'; ctx.lineWidth = s * 0.012;
      for (let x = -s * 0.3; x <= s * 0.3; x += s * 0.06) { ctx.beginPath(); ctx.moveTo(x, -s * 0.16); ctx.lineTo(x * 0.6, -s * 0.44); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(-s * 0.12, -s * 0.33, s * 0.08, s * 0.04, -0.4, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#fff4e8'; rr(-s * 0.36, -s * 0.21, s * 0.72, s * 0.11, s * 0.05);
      ctx.strokeStyle = 'rgba(200,170,150,0.5)'; ctx.lineWidth = s * 0.01;
      for (let x = -s * 0.32; x <= s * 0.32; x += s * 0.045) { ctx.beginPath(); ctx.moveTo(x, -s * 0.2); ctx.lineTo(x, -s * 0.11); ctx.stroke(); }
      const bob = Math.sin(t * 3) * s * 0.01;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 6; i++) { const a = i * 1.05; circle(Math.cos(a) * s * 0.05, -s * 0.46 + bob + Math.sin(a) * s * 0.05, s * 0.045); }
      circle(0, -s * 0.46 + bob, s * 0.07);
    } else if (hatKind === 'hat') {
      ctx.fillStyle = '#f2d27a';
      ctx.beginPath(); ctx.ellipse(0, -s * 0.22, s * 0.42, s * 0.08, 0, 0, TAU); ctx.fill();
      rr(-s * 0.22, -s * 0.42, s * 0.44, s * 0.22, s * 0.1);
      ctx.fillStyle = '#e07a6a'; ctx.fillRect(-s * 0.22, -s * 0.28, s * 0.44, s * 0.05);
    } else if (has('cactus')) {
      // 선인장이 머리 위 자리를 차지
    } else if (z.char === 'zip') {
      // 쌩쌩이: 뒤로 휙 넘어간 삐죽 머리 (바람에 날리는 느낌)
      ctx.fillStyle = '#3f6fb0';
      ctx.beginPath(); ctx.moveTo(s * 0.2, -s * 0.22); ctx.quadraticCurveTo(s * 0.05, -s * 0.38, -s * 0.12, -s * 0.36);
      ctx.lineTo(-s * 0.42, -s * 0.44); ctx.lineTo(-s * 0.24, -s * 0.3); ctx.lineTo(-s * 0.46, -s * 0.28); ctx.lineTo(-s * 0.27, -s * 0.2);
      ctx.lineTo(-s * 0.4, -s * 0.12); ctx.lineTo(-s * 0.2, -s * 0.15); ctx.quadraticCurveTo(0, -s * 0.24, s * 0.2, -s * 0.22); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.ellipse(-s * 0.02, -s * 0.31, s * 0.1, s * 0.025, -0.15, 0, TAU); ctx.fill();
    } else if (z.char === 'sprout' || !LOOKS[z.char]) {
      ctx.strokeStyle = '#5aa04a'; ctx.lineWidth = s * 0.03;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.28); ctx.quadraticCurveTo(s * 0.04, -s * 0.4, 0, -s * 0.45); ctx.stroke();
      ctx.fillStyle = '#7cc56a';
      ctx.beginPath(); ctx.ellipse(s * 0.06, -s * 0.42, s * 0.07, s * 0.035, -0.5 + Math.sin(t * 2) * 0.2, 0, TAU); ctx.fill();
    }
    if (z.char === 'zip' && !hatKind) zipBand(z, s);
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
    // 꼬마 선인장: 머리 왼쪽 위에서 쏙 (모자가 있으면 모자 위에)
    if (has('cactus')) {
      const cy = -s * (beanie ? 0.5 : hatKind ? 0.42 : 0.27), cx = -s * 0.15, k = s * 0.01;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.25 + Math.sin(t * 1.3) * 0.05);
      ctx.fillStyle = '#c47f52'; rr(-6 * k, -2 * k, 12 * k, 6 * k, 1.5 * k);
      ctx.fillStyle = '#dd9a66'; rr(-7 * k, -3 * k, 14 * k, 2.6 * k, 1.2 * k);
      ctx.fillStyle = '#5faa66'; rr(-4 * k, -17 * k, 8 * k, 15 * k, 4 * k);
      rr(-9 * k, -12 * k, 4 * k, 6 * k, 2 * k); rr(5 * k, -14 * k, 4 * k, 7 * k, 2 * k);
      ctx.fillStyle = 'rgba(225,255,215,0.4)'; rr(-2.6 * k, -15 * k, 1.6 * k, 10 * k, 0.8 * k);
      ctx.fillStyle = '#ff8fb3'; for (let i = 0; i < 5; i++) { const a = i * 1.26; circle(Math.cos(a) * 2.4 * k, -18 * k + Math.sin(a) * 2 * k, 1.7 * k); }
      ctx.fillStyle = '#ffd34d'; circle(0, -18 * k, 1.2 * k);
      ctx.restore();
    }
    // 불가사리 머리핀
    if (has('starpin')) {
      ctx.save(); ctx.translate(s * 0.2, -s * (hatKind ? 0.2 : 0.24)); ctx.rotate(0.3 + Math.sin(t * 1.5) * 0.05);
      ctx.fillStyle = '#e86f4f'; starPath(ctx, s * 0.005, s * 0.008, s * 0.1, s * 0.05); ctx.fill();
      ctx.fillStyle = '#ffb08a'; starPath(ctx, 0, 0, s * 0.095, s * 0.047); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; circle(-s * 0.015, -s * 0.02, s * 0.015);
      ctx.restore();
    }
    if (has('frog')) {
      const fy = -s * (beanie ? 0.6 : hatKind ? 0.5 : 0.36) - Math.abs(Math.sin(t * 1.5)) * s * 0.03;
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
    const top = c.y - (c.type === 'villager' || c.type === 'farmer' ? 34 : TYPES[c.type].radius * 2 + 6);
    for (let i = 0; i < 3; i++) {
      const a = c.anim * 4 + (i * TAU) / 3;
      ctx.fillStyle = '#ffd34d';
      star(c.x + Math.cos(a) * 7, top + Math.sin(a) * 2.5, 2.2);
    }
  }
  function starPath(g, x, y, R, r) {
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - Math.PI / 2, rr2 = i % 2 ? r : R; g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); }
    g.closePath();
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
    if (c.mode === 'stunned' && !c.carriedBy && ctx === mainCtx) { drawCreatureBody(c, night); dizzyStars(c); foeBar(c); return; }
    // 맞으면 부르르
    const shake = c.friend ? 0 : c.ouch > 0 ? Math.sin(t * 80) * 1.5 : c.mode === 'windup' ? Math.sin(t * 50) * 0.7 : 0;
    if (shake) { ctx.save(); ctx.translate(shake, 0); }
    drawCreatureBody(c, night);
    if (shake) ctx.restore();
    if (TYPES[c.type].fight && !c.friend && ctx === mainCtx) foeBar(c);
  }
  // 싸우는 애 머리 위: 화나면 💢, 공격 직전엔 빨간 '!', 맞았으면 체력 막대
  function foeBar(c) {
    const F = TYPES[c.type].fight;
    if (!F) return;
    const top = c.y - (c.type === 'farmer' ? 44 : c.type === 'bee' ? 22 : F && c.type === 'goose' ? 28 : 20);
    if (c.hp < F.hp && c.mode !== 'stunned') {
      ctx.fillStyle = 'rgba(60,40,30,0.35)'; rr(c.x - 9, top - 1, 18, 4, 2);
      ctx.fillStyle = c.hp / F.hp > 0.4 ? '#ffb34d' : '#ff6b6b'; rr(c.x - 8.5, top - 0.5, 17 * Math.max(0, c.hp / F.hp), 3, 1.5);
    }
    if (c.mode === 'windup') {
      ctx.fillStyle = '#ff4d5e'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('!', c.x, top - 4); ctx.textAlign = 'start';
    } else if (c.angry && c.mode !== 'stunned') {
      // 화났어요 표시 (빨간 십자 혈관)
      const x = c.x + c.facing * 6, y = top - 3 + Math.sin(t * 6) * 0.6;
      ctx.strokeStyle = '#ff5a6a'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.moveTo(x + a * 1, y + b * 1); ctx.quadraticCurveTo(x + a * 2.6, y + b * 0.4, x + a * 3, y + b * 2.6); ctx.stroke(); }
    }
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
      case 'hare': return drawRabbit(c, HARE);
      case 'penguin': return drawPenguin(c);
      case 'fox': return drawFox(c);
      case 'snowman': return drawSnowman(c);
      case 'lizard': return drawLizard(c);
      case 'meerkat': return drawMeerkat(c);
      case 'camel': return drawCamel(c);
      case 'horse': return drawHorse(c);
      case 'quokka': return drawQuokka(c);
      case 'goose': return drawGoose(c);
      case 'farmer': return drawFarmer(c);
      case 'scorpion': return drawScorpion(c);
      case 'bee': return drawBee(c);
      case 'prickle': return drawPrickle(c);
      case 'monkey': return drawMonkey(c);
      case 'parrot': return drawBirdie(c, PARROT);
      case 'gull': return drawBirdie(c, GULL);
      case 'sloth': return drawSloth(c);
      case 'bloom': return drawBloom(c);
      case 'crab': return drawCrab(c);
      case 'seal': return drawSeal(c);
      case 'starry': return drawStarry(c);
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

  const HARE = { fur: '#ffffff', shade: '#dce6ef', tips: '#7d8796' };
  function drawRabbit(c, kind) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 12)) * 6 : 0;
    const [fur, shade] = kind ? [kind.fur, kind.shade] : RABBIT_FUR[c.id % RABBIT_FUR.length];
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
    if (kind) { // 눈토끼: 귀 끝이 까맣고, 털이 더 복슬복슬
      ctx.fillStyle = kind.tips;
      ctx.beginPath(); ctx.ellipse(8 + Math.sin(0.25 + twitch) * 4.6, -23.6, 1.3, 1.6, 0.25 + twitch, 0, TAU); ctx.fill();
      ctx.fillStyle = fur;
      for (const [x, y] of [[-6, -10], [-2, -11.6], [2, -11.2], [-7.5, -4], [3, -1.6]]) circle(x, y, 2.2);
      ctx.fillStyle = kind.shade; circle(4.5, -7.5, 2.6);
    }
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
  // 지역별 옷차림: 옷 색 · 바지 · 신발
  const LOOK = {
    meadow: { pants: '#4b4b6b', shoes: '#5a3f30' },
    snow: { shirts: ['#e8585a', '#4f8fd6', '#f2b33d', '#6cc08a', '#b07ad8'], pants: '#3e4a6a', shoes: '#f4f4f4' },
    desert: { shirts: ['#fff2d8', '#f6e3c0', '#e9d4f0', '#d8eef2'], pants: '#e3cfa8', shoes: '#b07a4a' },
    jungle: { shirts: ['#c9b07a', '#b9a46a', '#d6c08a'], pants: '#8a7a50', shoes: '#6a4a2a' },
    beach: { shirts: ['#ff8fa3', '#5cc4e8', '#ffcc4d', '#8fd694', '#ff9f6b'], pants: '#4f9fd8', shoes: '#ffd36e', bare: true },
  };
  function drawVillager(c) {
    const s = 26;
    const flee = c.mode === 'flee';
    const walk = c.mode === 'walk' || flee ? Math.sin(c.anim * (flee ? 16 : 9)) : 0;
    const style = c.id % 4, hair = HAIR[c.id % HAIR.length];
    const look = LOOK[c.look] ? c.look : 'meadow', L = LOOK[look];
    const shirtCol = L.shirts ? L.shirts[c.id % L.shirts.length] : c.color;
    const k = c.kid ? 0.74 : 1;
    shadow(c.x, c.y, 10 * k, 3.5 * k);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing * k, k);
    const keepCol = c.color; c.color = shirtCol;
    // 다리 + 신발
    ctx.fillStyle = L.bare ? '#ffe0c2' : L.pants;
    rr(-5 + walk * 2, -11, 4.5, 11, 2);
    rr(1 - walk * 2, -11, 4.5, 11, 2);
    if (L.bare) { ctx.fillStyle = L.pants; rr(-5.8 + walk, -12, 11.6, 6, 2); } // 바닷가: 반바지 + 맨다리
    ctx.fillStyle = L.shoes;
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
    if (look === 'meadow' && style === 0) { // 밀짚모자
      ctx.fillStyle = '#f2d27a';
      ctx.beginPath(); ctx.ellipse(0, -s * 1.27, 10, 2.4, 0, 0, TAU); ctx.fill();
      rr(-5.5, -s * 1.45, 11, 5.5, 2.5);
      ctx.fillStyle = '#e07a6a'; ctx.fillRect(-5.5, -s * 1.31, 11, 1.4);
    }
    if (look !== 'meadow') villagerGear(c, look, style, s, shirtCol, walk);
    c.color = keepCol;
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
    if (flee && Math.random() < 0.03) particles.push({ x: c.x, y: c.y - 38 * k, vx: 0, vy: -20, life: 0.8, kind: 'text', text: '!', color: '#e05a5a', size: 14 });
  }

  // 지역별 소품 (얼굴까지 그린 뒤 위에 얹는다)
  function villagerGear(c, look, style, s, col, walk) {
    const hy = -s * 1.1; // 머리 가운데
    if (look === 'snow') {
      // 목도리
      ctx.fillStyle = style % 2 ? '#ffffff' : '#ffd36e'; rr(-6, -s * 0.92, 12, 3.4, 1.7); rr(-5.5, -s * 0.9, 3, 7, 1.5);
      if (style < 2) { // 털 달린 모자(후드)
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, hy - 1, 8.6, Math.PI * 0.95, TAU * 1.0); ctx.fill();
        ctx.fillStyle = '#fbf6ee';
        for (let i = 0; i <= 8; i++) { const a = Math.PI * 0.95 + (i / 8) * Math.PI * 1.08; circle(Math.cos(a) * 8.4, hy - 1 + Math.sin(a) * 8.4, 1.9); }
      } else { // 방울 털모자 + 귀마개
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, hy - 2, 7.6, Math.PI, TAU); ctx.fill();
        ctx.fillStyle = '#fff'; rr(-7.8, hy - 3, 15.6, 3, 1.5); circle(0, hy - 10.5, 2.6);
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; for (let x = -5; x <= 5; x += 2.5) ctx.fillRect(x, hy - 8, 1, 5);
      }
      // 장갑 낀 손
      ctx.fillStyle = '#fff'; circle(3 + Math.sin(-walk * 0.5) * 7, -s * 0.82 + 7, 2.2);
      return;
    }
    if (look === 'desert') {
      if (style % 2 === 0) { // 챙 넓은 햇빛 모자
        ctx.fillStyle = '#f3e2b8';
        ctx.beginPath(); ctx.ellipse(0, hy - 6, 12.5, 3, 0, 0, TAU); ctx.fill();
        rr(-5.5, hy - 12.5, 11, 7, 3.5);
        ctx.fillStyle = '#d9784a'; ctx.fillRect(-5.5, hy - 7.6, 11, 1.6);
        ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.beginPath(); ctx.ellipse(1, hy - 4.6, 10, 1.2, 0, 0, TAU); ctx.fill();
      } else { // 머리를 덮는 햇빛 가리개 천
        ctx.fillStyle = col === '#fff2d8' ? '#9fd0e0' : '#fff2d8';
        ctx.beginPath(); ctx.arc(0, hy - 0.5, 8.2, Math.PI * 0.92, TAU * 1.02); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-8, hy); ctx.quadraticCurveTo(-10, hy + 8, -6, hy + 11); ctx.lineTo(-3.5, hy + 4); ctx.fill();
        ctx.fillStyle = '#d9a640'; ctx.fillRect(-8, hy - 3.2, 16, 1.4);
      }
      // 물병
      ctx.fillStyle = '#8a6a4a'; rr(-8.5, -s * 0.62, 3.5, 6, 1.5);
      ctx.fillStyle = '#5a9ad8'; ctx.fillRect(-8, -s * 0.58, 2.5, 1);
      return;
    }
    if (look === 'jungle') {
      // 탐험가 모자
      ctx.fillStyle = '#e3d29e';
      ctx.beginPath(); ctx.ellipse(0, hy - 5.5, 11, 2.6, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, hy - 7.5, 7, 5.5, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = '#7a5a3a'; ctx.fillRect(-7, hy - 7.6, 14, 1.6);
      // 조끼 주머니 + 쌍안경
      ctx.fillStyle = 'rgba(90,70,40,0.35)'; rr(-5.5, -s * 0.72, 3.6, 3, 0.8); rr(2, -s * 0.72, 3.6, 3, 0.8);
      if (style < 2) {
        ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(-4, -s * 0.9); ctx.lineTo(0, -s * 0.66); ctx.lineTo(4, -s * 0.9); ctx.stroke();
        ctx.fillStyle = '#3a3a3a'; rr(-2.8, -s * 0.68, 2.6, 3.6, 1); rr(0.2, -s * 0.68, 2.6, 3.6, 1);
      }
      return;
    }
    if (look === 'beach') {
      // 셔츠 꽃무늬
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (const [x, y] of [[-3.5, -s * 0.82], [2.5, -s * 0.7], [-1, -s * 0.5]]) { for (let i = 0; i < 5; i++) circle(x + Math.cos(i * 1.26) * 1.1, y + Math.sin(i * 1.26) * 1.1, 0.7); }
      // 선글라스
      ctx.fillStyle = '#2e2a38'; rr(-1.5, hy - 1.8, 3.8, 2.6, 1.2); rr(2.6, hy - 1.8, 3.8, 2.6, 1.2); ctx.fillRect(-1, hy - 1.6, 7, 0.7);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-0.8, hy - 1.4, 1, 0.8); ctx.fillRect(3.3, hy - 1.4, 1, 0.8);
      if (style === 0 || style === 3) { // 꽃 단 밀짚 모자
        ctx.fillStyle = '#f4dc94'; ctx.beginPath(); ctx.ellipse(0, hy - 6, 11.5, 2.6, 0, 0, TAU); ctx.fill(); rr(-5.5, hy - 11.5, 11, 6, 3);
        ctx.fillStyle = '#ff6b8a'; circle(-4, hy - 7, 2); ctx.fillStyle = '#ffd36e'; circle(-4, hy - 7, 0.8);
      }
      if (style === 1) { // 아이스크림
        const hx = 3 + Math.sin(-walk * 0.5) * 7, hyy = -s * 0.82 + 5;
        ctx.fillStyle = '#e8b878'; ctx.beginPath(); ctx.moveTo(hx - 2, hyy - 1); ctx.lineTo(hx, hyy + 4); ctx.lineTo(hx + 2, hyy - 1); ctx.fill();
        ctx.fillStyle = '#ffb3c8'; circle(hx, hyy - 2.5, 2.6); ctx.fillStyle = '#fff'; circle(hx - 0.8, hyy - 3.4, 0.8);
      }
    }
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

  // ---- 펭귄: 뒤뚱뒤뚱 / 배로 미끄러지기 ----
  function drawPenguin(c) {
    const slide = c.mode === 'slide';
    shadow(c.x, c.y, slide ? 11 : 8, 2.5);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    const dark = '#33405a', belly = '#fffaf2';
    if (slide) {
      ctx.fillStyle = '#ffa94d'; ctx.beginPath(); ctx.ellipse(-11.5, -2.5, 2.2, 1.2, 0.3, 0, TAU); ctx.fill();
      ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(0, -4.5, 11, 5.4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(0.5, -2.4, 9, 2.8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(-3, -6, 5.5, 1.6, -0.15, 0, TAU); ctx.fill(); // 날개를 뒤로
      circle(9.5, -6.5, 4.6);
      ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(11, -5.6, 2.6, 2.4, 0, 0, TAU); ctx.fill();
      eye(c, 11.2, -7.4, 0.85);
      ctx.fillStyle = '#ffa94d'; ctx.beginPath(); ctx.moveTo(13.4, -6.6); ctx.lineTo(16.4, -5.9); ctx.lineTo(13.4, -5); ctx.fill();
      blush(11.8, -4.8, 0.9, 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-1, -8, 5, 1.2, 0, 0, TAU); ctx.fill();
      if (Math.random() < 0.3) particles.push({ x: c.x + c.facing * 12, y: c.y - 1, vx: c.facing * (8 + Math.random() * 10), vy: -6 - Math.random() * 6, life: 0.5, kind: 'snowpuff' });
    } else {
      const walk = c.mode === 'walk' ? Math.sin(c.anim * 9) : 0;
      ctx.rotate(walk * 0.13);
      ctx.fillStyle = '#ffa94d';
      ctx.beginPath(); ctx.ellipse(-3 + walk, -0.6, 2.6, 1.3, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(3 - walk, -0.6, 2.6, 1.3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(0, -9, 7, 9.2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(1.6, -7.6, 4.8, 7.2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(150,170,200,0.25)'; ctx.beginPath(); ctx.ellipse(1.6, -3.4, 4.2, 2.6, 0, 0, Math.PI); ctx.fill();
      // 얼굴
      ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(3, -15, 3.2, 2.8, 0, 0, TAU); ctx.fill();
      eye(c, 3.4, -15.6, 0.95);
      ctx.fillStyle = '#ffa94d'; ctx.beginPath(); ctx.moveTo(5.6, -14.6); ctx.lineTo(8.8, -13.9); ctx.lineTo(5.6, -13.1); ctx.fill();
      blush(4.4, -12.8, 1, 0.55);
      // 날개 (걸을 때 파닥)
      ctx.fillStyle = dark;
      ctx.save(); ctx.translate(-5, -11); ctx.rotate(0.35 + Math.abs(walk) * 0.3);
      ctx.beginPath(); ctx.ellipse(0, 3.5, 1.9, 5, 0, 0, TAU); ctx.fill(); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.ellipse(-2.5, -15, 2, 1.1, -0.5, 0, TAU); ctx.fill();
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 북극여우: 고양이처럼 다가와 옆에 앉는다. 잘 땐 꼬리로 몸을 감싼다 ----
  function drawFox(c) {
    shadow(c.x, c.y, 10, 3);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    const fur = '#fffaf2', shade = '#e6e2dc', inner = '#d6c9c0';
    const tailWag = Math.sin(c.anim * 2.2) * 0.3;
    const tail = (x, y, rot, len) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(-len * 0.5, 0.6, len * 0.55, 3.8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(-len * 0.5, 0, len * 0.55, 3.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff'; circle(-len * 0.95, 0, 2.6);
      ctx.restore();
    };
    const head = (hx, hy, sleep) => {
      ctx.fillStyle = fur;
      ctx.beginPath(); ctx.moveTo(hx - 4, hy - 3); ctx.lineTo(hx - 2.5, hy - 10); ctx.lineTo(hx + 0.5, hy - 4); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 1.5, hy - 4); ctx.lineTo(hx + 5, hy - 10); ctx.lineTo(hx + 6, hy - 2.5); ctx.fill();
      ctx.fillStyle = inner;
      ctx.beginPath(); ctx.moveTo(hx - 2.8, hy - 4); ctx.lineTo(hx - 2.3, hy - 8); ctx.lineTo(hx - 0.8, hy - 4.3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 2.6, hy - 4.3); ctx.lineTo(hx + 4.7, hy - 8); ctx.lineTo(hx + 5, hy - 3.4); ctx.fill();
      ctx.fillStyle = fur; circle(hx, hy, 5.4);
      ctx.beginPath(); ctx.ellipse(hx + 5, hy + 1.6, 3.4, 2.2, 0.1, 0, TAU); ctx.fill(); // 주둥이
      ctx.fillStyle = 'rgba(200,215,230,0.5)'; ctx.beginPath(); ctx.arc(hx, hy, 5.4, 0.4, Math.PI - 0.4); ctx.fill();
      ctx.fillStyle = '#333'; circle(hx + 8.2, hy + 1.2, 0.95);
      if (sleep) { ctx.strokeStyle = '#555'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(hx + 2.5, hy - 0.8, 1.2, 0.2, Math.PI - 0.2); ctx.stroke(); }
      else { eye(c, hx + 2.6, hy - 1, 1, { color: '#3a3f4a' }); eye(c, hx - 1, hy - 1, 0.85, { color: '#3a3f4a' }); }
      blush(hx + 3.5, hy + 2, 1.1, 0.45);
    };
    if (c.mode === 'sleep') {
      ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(0, -5, 9.5, 6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(-1, -2.5, 8, 2.6, 0, 0, Math.PI); ctx.fill();
      head(6, -6, true);
      tail(9, -1.5, Math.PI + 0.15 + tailWag * 0.15, 15); // 꼬리로 코를 덮는다
      if (Math.random() < 0.01) particles.push({ x: c.x + 6, y: c.y - 16, vx: 6, vy: -10, life: 1.8, kind: 'z' });
    } else {
      const sit = c.mode === 'sit' || c.mode === 'idle';
      const walk = c.mode === 'walk' ? Math.sin(c.anim * 8) : 0;
      tail(-7, sit ? -4 : -7, sit ? -0.4 + tailWag * 0.3 : -0.2 + tailWag, 14);
      ctx.fillStyle = shade; rr(-5 - walk, -4, 2.6, 4.5, 1.2); rr(2 + walk, -4, 2.6, 4.5, 1.2);
      ctx.fillStyle = fur;
      ctx.beginPath(); ctx.ellipse(-1, sit ? -8 : -7, sit ? 7 : 9.5, sit ? 7.5 : 5.6, 0, 0, TAU); ctx.fill();
      rr(-4 + walk, -4, 2.6, 4.5, 1.2); rr(3 - walk, -4, 2.6, 4.5, 1.2);
      ctx.fillStyle = 'rgba(200,215,230,0.45)'; ctx.beginPath(); ctx.ellipse(-1, sit ? -3.5 : -3.2, sit ? 6 : 8, 2, 0, 0, Math.PI); ctx.fill();
      for (const [x, y] of [[-5, sit ? -13 : -11], [-1.5, sit ? -14.5 : -12], [2.5, sit ? -13.6 : -11.5]]) { ctx.fillStyle = fur; circle(x, y, 1.8); }
      head(5, sit ? -16 : -12, false);
      if (c.mode === 'sit' && Math.random() < 0.006) particles.push({ x: c.x, y: c.y - 30, vx: 0, vy: -16, life: 1.4, kind: 'heart' });
    }
    ctx.restore();
  }

  // ---- 눈사람 정령: 눈덩이 두 개, 나뭇가지 팔을 흔든다 ----
  function drawSnowman(c) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 6)) * 4 : 0;
    shadow(c.x, c.y, 8, 2.6);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    const wave = Math.sin(c.anim * 4) * 0.5;
    ctx.strokeStyle = '#8a5a3a'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-5, -11); ctx.lineTo(-10, -15 - wave * 2); ctx.moveTo(-8, -13.5 - wave); ctx.lineTo(-9.5, -17 - wave * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, -11); ctx.lineTo(10, -9 + wave * 2); ctx.moveTo(8.2, -9.8 + wave); ctx.lineTo(10.4, -12 + wave); ctx.stroke();
    // 아래 눈덩이
    ctx.fillStyle = '#e6eef6'; circle(0, -6, 7.4);
    ctx.fillStyle = '#ffffff'; circle(-0.5, -6.5, 6.9);
    belly(0, -6, 7, 7, 'rgba(170,195,225,0.4)');
    ctx.fillStyle = '#4a4f5a'; circle(1.5, -8, 0.9); circle(1.8, -4.8, 0.9);
    // 위 눈덩이 (얼굴)
    ctx.fillStyle = '#e6eef6'; circle(0.6, -15.5, 5.3);
    ctx.fillStyle = '#ffffff'; circle(0.2, -15.9, 4.9);
    eye(c, 2.6, -16.6, 0.9, { color: '#2e2a28' }); eye(c, -0.8, -16.6, 0.8, { color: '#2e2a28' });
    ctx.fillStyle = '#ff9a4d'; ctx.beginPath(); ctx.moveTo(3, -15.4); ctx.lineTo(7.4, -14.6); ctx.lineTo(3, -14); ctx.fill();
    ctx.strokeStyle = '#555'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(1.4, -13.6, 1.3, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(4.2, -13.6, 1, 0.6); blush(-1.8, -13.8, 0.9, 0.5);
    // 머리 위 눈꽃 한 송이
    ctx.strokeStyle = '#a9cdf0'; ctx.lineWidth = 0.7;
    for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3 + c.anim * 0.4; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 2.2, -22 + Math.sin(a) * 2.2); ctx.lineTo(-Math.cos(a) * 2.2, -22 - Math.sin(a) * 2.2); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; circle(-2, -18.5, 1.1);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ================= 사막 생명체 =================
  // ---- 도마뱀: 쪼르르 달리고, 멈추면 팔굽혀펴기 ----
  const LIZ = [['#f2b766', '#de8f48', '#fbe3b0'], ['#8fd1a0', '#5fae7a', '#e3f6d8'], ['#9cc3ef', '#6d98cf', '#e6f0fb']];
  function drawLizard(c) {
    const [body, spot, bellyC] = LIZ[c.id % 3];
    const run = c.mode === 'walk' || c.mode === 'flee';
    const leg = run ? Math.sin(c.anim * 26) : 0;
    const push = !run && (c.anim % 3.2) < 0.9 ? Math.abs(Math.sin(c.anim * 10)) * 1.4 : 0;
    shadow(c.x, c.y, 9, 2.2);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    // 꼬리: 점점 가늘어지는 동그라미들, 살랑살랑
    const sw = Math.sin(c.anim * (run ? 18 : 3)) * (run ? 2.2 : 1.2);
    for (let i = 0; i < 9; i++) {
      const u = i / 8;
      ctx.fillStyle = i % 3 === 1 ? spot : body;
      circle(-4 - u * 12, -1.6 - u * 0.4 + Math.sin(u * 3 + c.anim * 3) * sw * u, 2.2 - u * 1.6);
    }
    // 다리 (옆으로 벌어진)
    ctx.fillStyle = spot;
    for (const [x, ph] of [[-3, 1], [3.5, -1]]) {
      ctx.beginPath(); ctx.ellipse(x + leg * ph * 1.2, -0.3, 1.8, 0.9, 0.5 * ph, 0, TAU); ctx.fill();
    }
    ctx.save(); ctx.translate(0, -push);
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, -2.6, 6.6, 2.9, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = bellyC; ctx.beginPath(); ctx.ellipse(0.5, -1.2, 5, 1.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = spot; for (const [x, y] of [[-3, -3.6], [0, -4.4], [2.6, -3.6]]) circle(x, y, 0.9);
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(6.6, -3.6, 3.6, 2.6, -0.1, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-1, -4.5, 3, 0.8, 0, 0, TAU); ctx.fill();
    eye(c, 7.4, -4.6, 1.05, { white: true });
    ctx.strokeStyle = 'rgba(80,50,30,0.6)'; ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.arc(8.4, -3.2, 1.3, 0.2, Math.PI * 0.7); ctx.stroke();
    blush(8.2, -2.4, 0.8, 0.45);
    ctx.restore();
    // 앞다리 (몸 위로)
    ctx.fillStyle = spot;
    for (const [x, ph] of [[-2, -1], [4.5, 1]]) { ctx.beginPath(); ctx.ellipse(x + leg * ph * 1.2, 0, 1.7, 0.85, -0.5 * ph, 0, TAU); ctx.fill(); }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 미어캣 굴 ----
  function drawBurrow(b) {
    ctx.fillStyle = '#e8c88e'; ctx.beginPath(); ctx.ellipse(b.x, b.y + 0.5, 13, 5.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f6e2b4'; ctx.beginPath(); ctx.ellipse(b.x - 2, b.y - 1, 9, 3, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#6e4a2c'; ctx.beginPath(); ctx.ellipse(b.x, b.y + 0.6, 6.2, 2.7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a3020'; ctx.beginPath(); ctx.ellipse(b.x, b.y + 1.2, 4.6, 1.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(180,130,80,0.5)'; for (const [x, y] of [[-10, 2], [9, 2.5], [5, -3]]) circle(b.x + x, b.y + y, 0.9);
  }
  // ---- 미어캣: 꼿꼿이 서서 망보기 / 네 발로 종종 / 굴 속에서 빼꼼 ----
  function drawMeerkat(c) {
    const fur = '#e3b87f', dark = '#7a5434', light = '#f6dfb4';
    const head = (hx, hy, look) => {
      ctx.save(); ctx.translate(hx, hy); ctx.scale(look, 1);
      ctx.fillStyle = fur; circle(0, 0, 3.5);
      ctx.beginPath(); ctx.ellipse(2.8, 0.8, 2.6, 1.7, 0.15, 0, TAU); ctx.fill();
      ctx.fillStyle = dark; circle(5.1, 0.9, 0.75); circle(-2.4, -2.2, 1.1);
      ctx.fillStyle = 'rgba(90,60,40,0.55)'; ctx.beginPath(); ctx.ellipse(1.2, -0.6, 1.6, 1.3, 0.2, 0, TAU); ctx.fill();
      eye(c, 1.3, -0.6, 0.85);
      blush(2.6, 1.5, 0.8, 0.45);
      ctx.restore();
    };
    if (c.mode === 'hide') {
      // 굴 속에서 가끔 빼꼼
      const peek = Math.sin(c.anim * 1.3 + c.id);
      if (peek > 0.2) {
        const k = Math.min(1, (peek - 0.2) * 3);
        ctx.save(); ctx.beginPath(); ctx.rect(c.x - 8, c.y - 20, 16, 20.6); ctx.clip();
        head(c.x, c.y + 3.5 - k * 4.5, Math.sin(c.anim * 0.7) > 0 ? 1 : -1);
        ctx.restore();
      }
      return;
    }
    fade(c);
    if (c.mode === 'watch') {
      shadow(c.x, c.y, 5.5, 2, 1.8);
      ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
      ctx.strokeStyle = dark; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-2.5, -2); ctx.quadraticCurveTo(-6, -1, -7, 0.5); ctx.stroke();
      ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(-1.5, -0.6, 2.4, 1.1, 0, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(1.8, -0.6, 2.4, 1.1, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, -8.5, 4.4, 8, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(0.9, -7.5, 2.6, 6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(150,100,60,0.25)'; ctx.beginPath(); ctx.ellipse(-2, -8, 1.6, 6.5, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(1.6, -11.2, 1.1, 2.4, 0.4, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(3, -11, 1.1, 2.4, 0.2, 0, TAU); ctx.fill();
      const look = Math.sin(c.anim * 0.8 + c.id * 1.7) > -0.3 ? 1 : -1;
      head(0.6, -18.4, look);
      ctx.restore(); ctx.globalAlpha = 1;
      return;
    }
    const run = c.mode === 'walk' || c.mode === 'dash';
    const leg = run ? Math.sin(c.anim * (c.mode === 'dash' ? 26 : 16)) : 0;
    shadow(c.x, c.y, 7, 2.2);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.strokeStyle = dark; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-5.5, -4); ctx.quadraticCurveTo(-10, -4 - leg, -12, -1); ctx.stroke();
    ctx.fillStyle = '#c79a62'; rr(-5 - leg, -3.5, 2, 3.5, 1); rr(3 + leg, -3.5, 2, 3.5, 1);
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(0, -5, 6.8, 3.4, 0, 0, TAU); ctx.fill();
    rr(-4 + leg, -3.5, 2, 3.5, 1); rr(4 - leg, -3.5, 2, 3.5, 1);
    ctx.fillStyle = 'rgba(122,84,52,0.35)'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(-3.6 + i * 2.2, -7.4, 0.6, 1.3, 0.3, 0, TAU); ctx.fill(); }
    head(6.5, -7.6, 1);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 낙타: 혹 두 개, 졸린 눈, 등에 알록달록 담요. 앉아서 우물우물 ----
  function drawCamel(c) {
    const fur = '#e2b47c', shade = '#c99560', light = '#f3d1a0';
    const sit = c.mode === 'sit';
    shadow(c.x, c.y, sit ? 15 : 14, 4, sit ? 1 : 1.6);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    const walk = c.mode === 'walk' || c.mode === 'flee' ? Math.sin(c.anim * 6) : 0;
    const by = sit ? 9 : 19; // 몸통 높이
    const bob = Math.abs(walk) * 0.8;
    const legs = (back) => {
      ctx.fillStyle = back ? shade : fur;
      for (const [x, ph] of back ? [[-8.5, 1], [6.5, -1]] : [[-6.5, -1], [8.5, 1]]) {
        ctx.save(); ctx.translate(x, -by + 3); ctx.rotate(walk * 0.35 * ph);
        rr(-1.5, 0, 3, by - 3, 1.5); ctx.fillStyle = back ? '#b58250' : shade; rr(-1.8, by - 5, 3.6, 2.2, 1.1);
        ctx.restore(); ctx.fillStyle = back ? shade : fur;
      }
    };
    if (!sit) legs(true);
    ctx.save(); ctx.translate(0, -bob);
    // 꼬리
    ctx.strokeStyle = shade; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-12, -by - 1); ctx.quadraticCurveTo(-15, -by + 3 + walk, -14, -by + 7); ctx.stroke();
    ctx.fillStyle = '#8a6440'; circle(-14, -by + 7.5, 1.4);
    // 몸통 + 혹
    ctx.fillStyle = fur;
    ctx.beginPath(); ctx.ellipse(0, -by, 12.5, sit ? 6.4 : 6.8, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-4.6, -by - 5, 4.8, 5.6, -0.1, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(4, -by - 5, 4.6, 5.4, 0.1, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(160,110,60,0.22)'; ctx.beginPath(); ctx.ellipse(0, -by + 3.2, 11.5, 3, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,215,0.45)'; ctx.beginPath(); ctx.ellipse(-5.5, -by - 8.6, 2.4, 1.2, -0.3, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(3, -by - 8.4, 2.2, 1.1, -0.2, 0, TAU); ctx.fill();
    // 혹 사이 담요 + 술
    ctx.fillStyle = '#e8585e'; rr(-3.2, -by - 4.5, 6.4, 8.5, 1.5);
    ctx.fillStyle = '#ffd36e'; ctx.fillRect(-3.2, -by - 2, 6.4, 1.2); ctx.fillStyle = '#5fb3c9'; ctx.fillRect(-3.2, -by + 0.6, 6.4, 1);
    ctx.fillStyle = '#ffd36e'; for (const x of [-2.4, 0, 2.4]) circle(x, -by + 4.8, 0.8);
    // 목 + 머리
    const hb = sit ? 0 : walk * 0.8;
    const hx = 15.5, hy = -by - 11 + hb;
    ctx.strokeStyle = fur; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(9, -by - 1); ctx.quadraticCurveTo(14, -by - 2, hx - 1, hy + 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(160,110,60,0.25)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(10, -by + 1.5); ctx.quadraticCurveTo(15, -by, hx, hy + 4); ctx.stroke();
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(hx + 1, hy, 4.6, 3.2, 0.15, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx + 4.4, hy + 1.2, 2.8, 2.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(hx - 2.4, hy - 2.6, 1, 1.8, -0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(hx + 0.4, hy - 2, 2, 0.9, 0, 0, TAU); ctx.fill();
    // 졸린 눈 + 긴 속눈썹
    ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.arc(hx + 1.6, hy - 0.6, 1.3, 0.15, Math.PI - 0.15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx + 0.4, hy - 0.2); ctx.lineTo(hx - 0.2, hy + 0.6); ctx.moveTo(hx + 1.2, hy + 0.5); ctx.lineTo(hx + 1, hy + 1.3); ctx.stroke();
    ctx.fillStyle = '#4a3a2a'; circle(hx + 6.2, hy + 0.6, 0.5);
    const chew = sit ? Math.sin(c.anim * 5) * 0.5 : 0;
    ctx.beginPath(); ctx.ellipse(hx + 5, hy + 2.8 + chew * 0.3, 1.4, 0.5 + Math.abs(chew) * 0.4, 0, 0, Math.PI); ctx.stroke();
    blush(hx + 2.6, hy + 1.8, 1.1, 0.5);
    ctx.restore();
    if (sit) {
      ctx.fillStyle = shade; for (const x of [-9, 7]) { ctx.beginPath(); ctx.ellipse(x, -1.6, 4, 1.8, 0, 0, TAU); ctx.fill(); }
    } else legs(false);
    ctx.restore();
  }

  // ---- 말: 통통한 꼬마 말. 풀 뜯기 · 걷기 · 다그닥 달리기, 타면 안장 ----
  const HORSE_COATS = [
    { body: '#c98b5c', shade: '#a96f45', light: '#e3ad80', mane: '#6a4430', hoof: '#5a3a28' }, // 밤색
    { body: '#f4eee6', shade: '#d9d0c6', light: '#ffffff', mane: '#b9b0d0', hoof: '#8a8090' }, // 하얀 말
    { body: '#ecc583', shade: '#cfa462', light: '#f8dda8', mane: '#fff3d6', hoof: '#8a6a40' }, // 황금빛
    { body: '#5f525c', shade: '#4a3f48', light: '#7d7079', mane: '#2e2830', hoof: '#2a2228' }, // 까만 말
    { body: '#f4eee6', shade: '#d9d0c6', light: '#ffffff', mane: '#6a4430', hoof: '#5a3a28', spots: '#c98b5c' }, // 얼룩말(점박이)
  ];
  function drawHorse(c) {
    const gait = c.mode === 'trot' ? 'gallop' : c.mode === 'walk' || c.mode === 'flee' ? 'walk' : c.mode === 'graze' ? 'graze' : 'idle';
    shadow(c.x, c.y, 20, 5, 1.6);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    horseBody(c, gait, c.anim * (gait === 'gallop' ? 13 : 7), false);
    ctx.restore();
  }
  // 원점 = 발 아래, 오른쪽을 본다. 돌려주는 값 = 안장 높이(-y)
  function horseBody(c, gait, ph, saddle) {
    const C = HORSE_COATS[c.coat % HORSE_COATS.length];
    const moving = gait === 'walk' || gait === 'gallop';
    const sw = moving ? Math.sin(ph) * (gait === 'gallop' ? 0.6 : 0.35) : 0;
    const bob = gait === 'gallop' ? Math.abs(Math.sin(ph)) * 2.4 : moving ? Math.abs(Math.sin(ph)) * 0.8 : Math.sin(t * 1.8 + c.id) * 0.3;
    const by = 22 + bob;
    const legs = (back) => {
      for (const [x, k] of back ? [[-12, 1], [9, -1]] : [[-8, -1], [13, 1]]) {
        const a = sw * k * (gait === 'gallop' ? (x > 0 ? 1 : -1) : 1);
        ctx.save(); ctx.translate(x, -by + 4); ctx.rotate(a);
        ctx.fillStyle = back ? C.shade : C.body; rr(-2, 0, 4, by - 4 - (gait === 'gallop' ? Math.max(0, Math.sin(ph * k)) * 3 : 0), 2);
        ctx.fillStyle = C.hoof; rr(-2.3, by - 6.5 - (gait === 'gallop' ? Math.max(0, Math.sin(ph * k)) * 3 : 0), 4.6, 2.8, 1.2);
        ctx.restore();
      }
    };
    legs(true);
    // 꼬리: 살랑 (달리면 뒤로 휘날림)
    const tw = Math.sin(t * 2.4 + c.id) * 1.5 + (gait === 'gallop' ? -4 : 0);
    ctx.fillStyle = C.mane;
    ctx.beginPath(); ctx.moveTo(-15, -by - 4); ctx.quadraticCurveTo(-24 + tw, -by - 2, -22 + tw * 1.5, -by + (gait === 'gallop' ? 4 : 12));
    ctx.quadraticCurveTo(-19 + tw, -by + 2, -15, -by + 1); ctx.closePath(); ctx.fill();
    // 몸통
    ctx.fillStyle = C.body; ctx.beginPath(); ctx.ellipse(0, -by, 17, 8.8, 0, 0, TAU); ctx.fill();
    if (C.spots) { ctx.save(); ctx.beginPath(); ctx.ellipse(0, -by, 17, 8.8, 0, 0, TAU); ctx.clip(); ctx.fillStyle = C.spots;
      ctx.beginPath(); ctx.ellipse(-9, -by - 3, 6, 5, 0.4, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(6, -by + 4, 5, 4, -0.3, 0, TAU); ctx.fill(); ctx.restore(); }
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.beginPath(); ctx.ellipse(0, -by + 4.5, 15, 3.6, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.ellipse(-4, -by - 5.5, 7, 2, -0.1, 0, TAU); ctx.fill();
    // 안장: 빨간 담요 + 갈색 안장 + 등자
    if (saddle) {
      ctx.fillStyle = '#e8585e'; rr(-8, -by - 8.5, 15, 11, 3);
      ctx.fillStyle = '#ffd36e'; ctx.fillRect(-8, -by + 0.5, 15, 1.4);
      ctx.fillStyle = '#9a6440'; ctx.beginPath(); ctx.ellipse(-0.5, -by - 7.5, 8, 3.2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#b97c52'; ctx.beginPath(); ctx.ellipse(-1, -by - 8.2, 6, 1.8, 0, 0, TAU); ctx.fill();
    }
    // 목 + 머리 (풀 뜯을 땐 고개를 숙인다)
    const graze = gait === 'graze';
    const chew = graze ? Math.sin(t * 6 + c.id) * 0.6 : 0;
    const nod = gait === 'gallop' ? Math.sin(ph) * 1.5 : moving ? Math.sin(ph) * 0.8 : 0;
    const hx = graze ? 24 : 21, hy = graze ? -6 + chew : -by - 16 + nod;
    ctx.strokeStyle = C.body; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(10, -by - 1); ctx.quadraticCurveTo(graze ? 22 : 15, graze ? -by + 2 : -by - 6, hx - 2, hy + 1); ctx.stroke();
    // 갈기
    ctx.strokeStyle = C.mane; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(7, -by - 5); ctx.quadraticCurveTo(graze ? 16 : 11, graze ? -by - 3 : -by - 11, hx - 4, hy - 3); ctx.stroke();
    ctx.fillStyle = C.body; ctx.beginPath(); ctx.ellipse(hx, hy, 6, 5, graze ? 0.9 : 0.25, 0, TAU); ctx.fill();
    const sx = hx + (graze ? 2.5 : 4.5), sy = hy + (graze ? 4.5 : 2.5);
    ctx.fillStyle = C.light; ctx.beginPath(); ctx.ellipse(sx, sy, 4.2, 3.4, graze ? 0.9 : 0.25, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(80,50,40,0.5)'; circle(sx + 1.8, sy - (graze ? 0 : 0.6), 0.7);
    // 귀 + 앞머리
    ctx.fillStyle = C.body; ctx.beginPath(); ctx.moveTo(hx - 3.5, hy - 3); ctx.lineTo(hx - 3.5 + (graze ? 2 : -0.5), hy - 9); ctx.lineTo(hx - 0.5, hy - 4); ctx.fill();
    ctx.fillStyle = C.shade; ctx.beginPath(); ctx.moveTo(hx - 3, hy - 3.6); ctx.lineTo(hx - 3 + (graze ? 1.6 : -0.3), hy - 7.5); ctx.lineTo(hx - 1.2, hy - 4); ctx.fill();
    ctx.fillStyle = C.mane; ctx.beginPath(); ctx.ellipse(hx - 0.5, hy - 4, 2.6, 1.6, 0.6, 0, TAU); ctx.fill();
    // 눈: 동글 + 반짝 (가끔 깜빡)
    const blink = ((t + c.id * 0.7) % 5) < 0.12;
    if (blink || graze) { ctx.strokeStyle = '#3a2a22'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(hx + 0.8, hy - 0.6, 1.3, 0.2, Math.PI - 0.2); ctx.stroke(); }
    else { ctx.fillStyle = '#3a2a22'; circle(hx + 0.8, hy - 0.8, 1.6); ctx.fillStyle = '#fff'; circle(hx + 1.3, hy - 1.4, 0.6); }
    blush(hx + 2.5, hy + 1.6, 1.3, 0.45);
    legs(false);
    return by + 8.5;
  }

  // ---- 쿼카: 동글동글 갈색 털, 작은 둥근 귀, 늘 방긋 웃는 얼굴. 깡충깡충 뛴다 ----
  function drawQuokka(c) {
    const fur = '#a8876a', dark = '#6e5544', light = '#d9c2a6';
    const hopping = c.mode === 'walk' || c.mode === 'hop';
    const hop = hopping ? Math.abs(Math.sin(c.anim * 9)) * 4 : 0;
    const smile = c.mode === 'smile';
    fade(c);
    shadow(c.x, c.y, 6.5, 2.2, 1.4);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    if (smile) ctx.translate(0, -Math.abs(Math.sin(c.anim * 3)) * 0.8); // 신나서 들썩
    // 꼬리 + 큰 뒷발
    ctx.strokeStyle = dark; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-4, -3); ctx.quadraticCurveTo(-8.5, -2, -9.5, 0); ctx.stroke();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(1.5, -0.8, 4, 1.4, 0, 0, TAU); ctx.fill();
    // 몸통 (동그랗게 앉은 자세) + 밝은 배
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(0, -6.5, 5.6, 6.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(1.6, -5.6, 3, 4.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(-2, -10, 2, 1.2, -0.4, 0, TAU); ctx.fill();
    // 앞발: 우물우물 먹을 땐 입가로, 웃을 땐 가슴 앞에 모으기
    const munch = c.mode === 'munch';
    ctx.fillStyle = dark;
    if (munch) { circle(4.6, -10.5 + Math.sin(c.anim * 8) * 0.4, 1.2); ctx.fillStyle = '#7cc56a'; ctx.beginPath(); ctx.ellipse(6, -10.6, 2, 0.9, 0.5, 0, TAU); ctx.fill(); }
    else { circle(3.6, -6.8, 1.1); circle(2.2, -6.4, 1.1); }
    // 머리: 크고 동그랗게, 주둥이는 짧게
    const hx = 1.6, hy = -14.2;
    ctx.fillStyle = fur;
    circle(hx - 3.2, hy - 3.8, 2.1); circle(hx + 1.4, hy - 4.4, 2.1); // 둥근 귀
    ctx.fillStyle = '#e8a6a0'; circle(hx - 3.2, hy - 3.8, 1.1); circle(hx + 1.4, hy - 4.4, 1.1);
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(hx, hy, 5.3, 4.7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.ellipse(hx - 1.8, hy - 2.4, 2, 1, -0.4, 0, TAU); ctx.fill();
    ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(hx + 2.4, hy + 1.4, 2.9, 2.3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3a2a22'; ctx.beginPath(); ctx.ellipse(hx + 4.3, hy + 0.3, 0.8, 0.6, 0, 0, TAU); ctx.fill(); // 작은 코
    eye(c, hx + 1.2, hy - 1, 1.1);
    blush(hx + 0.8, hy + 2, 1.2, smile ? 0.7 : 0.5);
    // 트레이드마크 미소: 입꼬리가 볼까지 올라간 큰 웃음 (웃을 땐 입을 활짝)
    ctx.strokeStyle = '#3a2a22'; ctx.lineWidth = 0.65; ctx.lineCap = 'round';
    if (smile) {
      ctx.fillStyle = '#c0505a'; ctx.beginPath(); ctx.moveTo(hx + 1.2, hy + 1.3); ctx.quadraticCurveTo(hx + 3, hy + 4.6, hx + 4.8, hy + 1.1); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff8fa3'; ctx.beginPath(); ctx.ellipse(hx + 3, hy + 2.6, 0.9, 0.5, 0, 0, TAU); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(hx + 1, hy + 1.1); ctx.quadraticCurveTo(hx + 3, hy + 3.6, hx + 4.8, hy + 1); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(hx + 4.3, hy + 0.6); ctx.lineTo(hx + 4.2, hy + 1.4); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
    if (smile && Math.random() < 0.012) particles.push({ x: c.x, y: c.y - 24, vx: 0, vy: -16, life: 1.4, kind: 'heart' });
  }

  // ================= 싸우는 애들 =================
  // ---- 거위: 하얗고 통통, 화나면 목을 쭉 빼고 날개를 펴고 꽥꽥 ----
  function drawGoose(c) {
    const mad = c.angry && !c.friend && c.mode !== 'stunned';
    const run = c.mode === 'walk' || c.mode === 'chase' || c.mode === 'cool';
    const leg = run ? Math.sin(c.anim * (mad ? 18 : 10)) : 0;
    const peck = c.mode === 'windup' ? -0.4 : c.swing > 0 ? 1 : 0;
    fade(c); shadow(c.x, c.y, 8, 2.6);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    ctx.strokeStyle = '#f29a3c'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-1.5, -5); ctx.lineTo(-1.5 + leg * 2, -0.5); ctx.moveTo(1.5, -5); ctx.lineTo(1.5 - leg * 2, -0.5); ctx.stroke();
    ctx.fillStyle = '#f29a3c'; ctx.beginPath(); ctx.ellipse(-0.5 + leg * 2, -0.3, 2, 0.8, 0, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(2.5 - leg * 2, -0.3, 2, 0.8, 0, 0, TAU); ctx.fill();
    // 몸통 + 꽁지
    ctx.fillStyle = '#fbf8f2';
    ctx.beginPath(); ctx.moveTo(-8, -10); ctx.lineTo(-12, -13); ctx.lineTo(-9.5, -7.5); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-1, -8.5, 8, 5.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(160,170,190,0.25)'; ctx.beginPath(); ctx.ellipse(-1, -5.5, 7, 2.4, 0, 0, Math.PI); ctx.fill();
    // 날개: 화나면 파닥파닥 펼침
    const flap = mad ? Math.sin(t * 22) * 0.5 - 0.7 : 0;
    ctx.save(); ctx.translate(-2, -10); ctx.rotate(flap);
    ctx.fillStyle = '#e9e6ee'; ctx.beginPath(); ctx.ellipse(-3, 1, 5.5, 3, -0.15, 0, TAU); ctx.fill();
    ctx.restore();
    // 목 + 머리 (화나면 앞으로 낮게 쭉)
    const hx = mad ? 11 + peck * 2 : 6, hy = mad ? -12 + peck * 3 : -19;
    ctx.strokeStyle = '#fbf8f2'; ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.moveTo(4, -10); ctx.quadraticCurveTo(mad ? 9 : 5, mad ? -13 : -14, hx, hy); ctx.stroke();
    ctx.fillStyle = '#fbf8f2'; circle(hx, hy, 3.2);
    const open = mad && (c.mode === 'windup' || Math.sin(t * 9) > 0.3);
    ctx.fillStyle = '#f29a3c';
    ctx.beginPath(); ctx.moveTo(hx + 2, hy - 1.2); ctx.lineTo(hx + 6.5, hy - (open ? 1.6 : 0.2)); ctx.lineTo(hx + 2.4, hy + 0.2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(hx + 2, hy + 0.4); ctx.lineTo(hx + 5.8, hy + (open ? 1.8 : 0.4)); ctx.lineTo(hx + 2.2, hy + 1.4); ctx.fill();
    eye(c, hx + 0.8, hy - 0.8, 0.85);
    if (mad) { ctx.strokeStyle = '#333'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(hx - 0.6, hy - 2.6); ctx.lineTo(hx + 2, hy - 1.6); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 빗자루 아저씨: 마을 사람 + 빗자루. 화나면 빗자루를 번쩍 들었다가 휙 ----
  function drawFarmer(c) {
    const mad = c.angry && !c.friend && c.mode !== 'stunned';
    const keep = c.mode;
    if (c.mode === 'chase' || c.mode === 'cool') c.mode = 'walk';
    drawVillager(c);
    c.mode = keep;
    const s = 26;
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    // 화난 눈썹 + 콧수염
    if (mad) { ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 1.1; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0.5, -s * 1.2); ctx.lineTo(4.5, -s * 1.15); ctx.stroke(); }
    ctx.fillStyle = '#6a4a3a'; ctx.beginPath(); ctx.ellipse(4.2, -s * 1.03, 2.8, 1, 0, 0, TAU); ctx.fill();
    // 빗자루
    const ang = c.mode === 'windup' ? -2.3 : c.swing > 0 ? 0.6 : mad ? -0.9 + Math.sin(t * 8) * 0.15 : -0.25;
    ctx.save(); ctx.translate(5, -s * 0.72); ctx.rotate(ang);
    ctx.fillStyle = '#b07a4a'; rr(-0.9, -3, 1.8, 22, 0.9);
    ctx.fillStyle = '#e8c46a'; ctx.beginPath(); ctx.moveTo(-1.5, 17); ctx.lineTo(-4.5, 25.5); ctx.lineTo(4.5, 25.5); ctx.lineTo(1.5, 17); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#d24f4f'; ctx.fillRect(-2, 17.5, 4, 1.4);
    ctx.strokeStyle = 'rgba(150,110,40,0.5)'; ctx.lineWidth = 0.5; for (const x of [-2.5, 0, 2.5]) { ctx.beginPath(); ctx.moveTo(x * 0.5, 19); ctx.lineTo(x, 25); ctx.stroke(); }
    ctx.fillStyle = '#ffe0c2'; circle(0, 2, 1.9);
    ctx.restore();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 전갈: 동글동글 주황, 집게 두 개, 꼬리를 말아 올리고 있다가 공격 땐 쭉 ----
  function drawScorpion(c) {
    const mad = c.angry && !c.friend && c.mode !== 'stunned';
    const run = c.mode === 'walk' || c.mode === 'chase' || c.mode === 'cool';
    const leg = run ? Math.sin(c.anim * 20) : 0;
    const body = '#e08a4a', dark = '#b8673a', light = '#f4b27a';
    fade(c); shadow(c.x, c.y, 9, 2.4);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    // 다리
    ctx.strokeStyle = dark; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) { const x = -4 + i * 2.6, w = (i % 2 ? leg : -leg) * 1.2; ctx.beginPath(); ctx.moveTo(x, -3); ctx.lineTo(x - 1.5 + w, -0.2); ctx.stroke(); }
    // 꼬리: 마디 다섯 개가 등 위로 말림 (뜸들일 땐 높이, 찌를 땐 앞으로)
    const lift = c.mode === 'windup' ? 1.35 : c.swing > 0 ? 0.6 : mad ? 1.1 + Math.sin(t * 6) * 0.05 : 1;
    const cx = -3.5, cy = -8, R = 5.2, a0 = Math.PI * 1.05, span = 2.6 * lift;
    let px = 0, py = 0, qx = 0, qy = 0;
    for (let i = 0; i <= 5; i++) {
      const a = a0 - (span * i) / 5;
      qx = px; qy = py;
      px = cx + Math.cos(a) * R; py = cy - Math.sin(a) * R;
      ctx.fillStyle = i % 2 ? body : light; circle(px, py, 2.1 - i * 0.15);
    }
    // 침: 꼬리 끝 방향으로 뾰족
    const dl = Math.hypot(px - qx, py - qy) || 1, ux = (px - qx) / dl, uy = (py - qy) / dl;
    ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(px - uy * 1.3, py + ux * 1.3); ctx.lineTo(px + ux * 3.4, py + uy * 3.4); ctx.lineTo(px + uy * 1.3, py - ux * 1.3); ctx.fill();
    // 몸통
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, -4, 6, 3.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(-1, -5.6, 3.5, 1, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 0.5; for (const x of [-2.5, 0, 2.5]) { ctx.beginPath(); ctx.moveTo(x, -7); ctx.lineTo(x, -1.2); ctx.stroke(); }
    // 집게 (딸깍딸깍)
    const snap = mad ? (Math.sin(t * 12) > 0 ? 0.5 : 0) : 0;
    for (const [y, k] of [[-5, 1], [-2.5, 0.85]]) {
      ctx.fillStyle = k < 1 ? dark : body;
      ctx.beginPath(); ctx.moveTo(4.5, y); ctx.lineTo(8, y - 1.5); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(9.5, y - 1.8, 2.4 * k, 1.8 * k, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fbe7d2'; ctx.beginPath(); ctx.moveTo(11, y - 2.2); ctx.lineTo(12.8, y - 3 - snap); ctx.lineTo(11.8, y - 1.6); ctx.fill();
    }
    eye(c, 3.6, -5.2, 0.8); eye(c, 1.8, -5.4, 0.7);
    if (mad) { ctx.strokeStyle = '#333'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(1, -7); ctx.lineTo(4.4, -6.3); ctx.stroke(); }
    blush(4.4, -3.6, 0.8, 0.45);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 꿀벌: 노랑·검정 줄무늬, 날개 붕붕. 화나면 쌩 날아와 콕 ----
  function drawBee(c) {
    const mad = c.angry && !c.friend && c.mode !== 'stunned';
    const alt = c.mode === 'stunned' ? 1 : 9 + Math.sin(c.anim * 5 + c.id) * 2 + (c.mode === 'windup' ? 3 : c.swing > 0 ? -4 : 0);
    fade(c); shadow(c.x, c.y, 3.5, 1.2);
    ctx.save(); ctx.translate(c.x, c.y - alt); ctx.scale(c.facing, 1);
    if (c.mode === 'stunned') ctx.rotate(0.5);
    // 날개 (빠르게 팔랑)
    const w = c.mode === 'stunned' ? 0 : Math.sin(t * 60) * 0.5;
    ctx.fillStyle = 'rgba(235,245,255,0.85)';
    ctx.beginPath(); ctx.ellipse(-1, -3.5, 2.6, 1.6, -0.9 + w, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(1, -3.6, 2.3, 1.4, -0.4 - w, 0, TAU); ctx.fill();
    // 몸통 + 줄무늬 + 침
    ctx.fillStyle = '#3a3030'; ctx.beginPath(); ctx.moveTo(-4.2, 0); ctx.lineTo(-6.4, 0.6); ctx.lineTo(-4.2, 1.2); ctx.fill();
    ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.ellipse(0, 0, 4.4, 3.2, 0, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 4.4, 3.2, 0, 0, TAU); ctx.clip();
    ctx.fillStyle = '#3a3030'; ctx.fillRect(-2.6, -4, 1.4, 8); ctx.fillRect(0.2, -4, 1.4, 8);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(1.5, -1.6, 1.4, 0.6, -0.3, 0, TAU); ctx.fill();
    eye(c, 3, -0.6, 0.7);
    if (mad) { ctx.strokeStyle = '#3a3030'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(1.8, -2.3); ctx.lineTo(4, -1.6); ctx.stroke(); }
    ctx.strokeStyle = '#3a3030'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(3, -2.6); ctx.quadraticCurveTo(3.6, -4.4, 4.6, -4.6); ctx.stroke();
    blush(3.3, 0.8, 0.6, 0.5);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 선인장 정령: 통통 튀는 꼬마 선인장, 머리에 분홍 꽃 ----
  function drawPrickle(c) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 6)) * 4 : 0;
    shadow(c.x, c.y, 7, 2.4);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    const wave = Math.sin(c.anim * 4) * 0.35;
    ctx.fillStyle = '#4f9a5c'; rr(-4.5, -2.4, 3.4, 2.6, 1.3); rr(1.3, -2.4, 3.4, 2.6, 1.3);
    // 팔 (동글, 위로)
    const armP = (x, y, side, rot) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot * side);
      ctx.fillStyle = '#4f9a5c'; rr(-1.9 + side * 0.3, -6, 3.8, 7, 1.9);
      ctx.fillStyle = '#6fbf74'; rr(-1.7, -6, 3.4, 6.6, 1.7);
      ctx.restore();
    };
    armP(-6, -9, -1, 0.3 + wave);
    ctx.fillStyle = '#4f9a5c'; rr(-6.2, -20.4, 12.4, 19.4, 6.2);
    ctx.fillStyle = '#6fbf74'; rr(-6, -20.6, 12, 19, 6);
    ctx.strokeStyle = 'rgba(40,110,60,0.35)'; ctx.lineWidth = 0.6;
    for (const x of [-3, 3]) { ctx.beginPath(); ctx.moveTo(x, -18); ctx.quadraticCurveTo(x * 1.25, -10, x, -3); ctx.stroke(); }
    ctx.fillStyle = 'rgba(225,255,215,0.4)'; ctx.beginPath(); ctx.ellipse(-3, -16, 1.4, 3, -0.2, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,252,230,0.9)'; for (const [x, y] of [[-4.8, -6], [4.9, -7], [-4.6, -12], [5, -13.5], [0, -4]]) circle(x, y, 0.45);
    armP(6, -8, 1, 0.3 - wave);
    // 얼굴
    eye(c, 2.4, -13, 0.95); eye(c, -1.6, -13, 0.85);
    ctx.strokeStyle = '#3a4a3a'; ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.arc(0.4, -11.2, 1.2, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(3.8, -11, 1.1, 0.6); blush(-3, -11, 1, 0.55);
    // 머리 꽃
    const fy = -21.5;
    ctx.fillStyle = '#ff8fb3'; for (let k = 0; k < 5; k++) { const a = k * 1.26 + c.anim * 0.3; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 2, fy + Math.sin(a) * 1.4, 1.8, 1.2, a, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#ffd34d'; circle(0, fy, 1.1);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ================= 밀림 생명체 =================
  // ---- 원숭이: 통통 뛰어다니고, 앉으면 머리를 긁적 ----
  function drawMonkey(c) {
    const fur = '#a8774e', dark = '#8a5f3c', face = '#f4d7b2';
    const walk = c.mode === 'walk' || c.mode === 'flee';
    const hop = walk ? Math.abs(Math.sin(c.anim * 9)) * 3.5 : 0;
    const sit = c.mode === 'sit';
    shadow(c.x, c.y, 7, 2.3);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    // 꼬리: 뒤로 말린 물음표
    ctx.strokeStyle = dark; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    const tw = Math.sin(c.anim * 2) * 1.5;
    ctx.beginPath(); ctx.moveTo(-4, -4); ctx.quadraticCurveTo(-11, -4, -11, -11 + tw); ctx.arc(-8.5, -11 + tw, 2.5, Math.PI, Math.PI * 2.3); ctx.stroke();
    const leg = walk ? Math.sin(c.anim * 9) * 1.5 : 0;
    ctx.fillStyle = dark; rr(-3.5 + leg, -3.5, 2.8, 3.8, 1.4); rr(1 - leg, -3.5, 2.8, 3.8, 1.4);
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(0, -7.5, 5.2, 5.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = face; ctx.beginPath(); ctx.ellipse(1, -6.5, 2.8, 3.8, 0, 0, TAU); ctx.fill();
    // 팔
    ctx.strokeStyle = fur; ctx.lineWidth = 2.2;
    const scratch = sit ? Math.sin(c.anim * 12) * 0.8 : 0;
    ctx.beginPath(); ctx.moveTo(-3, -10); ctx.lineTo(sit ? -5 : -5.5 - leg, sit ? -17 + scratch : -5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3, -10); ctx.lineTo(walk ? 6 + leg : 4.5, walk ? -6 : -5); ctx.stroke();
    // 머리
    const hy = -16;
    ctx.fillStyle = fur; circle(-5, hy, 2.4); circle(5.6, hy, 2.4);
    ctx.fillStyle = face; circle(-5, hy, 1.3); circle(5.6, hy, 1.3);
    ctx.fillStyle = fur; circle(0.3, hy, 5.2);
    ctx.fillStyle = face; circle(-0.8, hy - 0.6, 2.4); circle(2.4, hy - 0.6, 2.4); ctx.beginPath(); ctx.ellipse(0.8, hy + 1.8, 3.6, 2.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(120,70,40,0.6)'; ctx.beginPath(); ctx.ellipse(-1, hy - 4.2, 2.4, 1, 0, 0, TAU); ctx.fill();
    eye(c, -0.6, hy - 0.7, 0.9); eye(c, 2.6, hy - 0.7, 0.95);
    ctx.fillStyle = '#6a4630'; circle(0.4, hy + 1.2, 0.4); circle(1.4, hy + 1.2, 0.4);
    ctx.strokeStyle = '#6a4630'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(0.9, hy + 2, 1.4, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(-2.4, hy + 1.4, 0.9, 0.5); blush(4, hy + 1.4, 0.9, 0.5);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 앵무새 · 갈매기: 종종 걷고 콕콕, 놀라면 날개 펴고 날아간다 ----
  const PARROT = { body: '#ef5a4f', belly: '#ffb35a', wing: '#3fa9e0', wing2: '#4cc06a', tail: '#3fa9e0', beak: '#f4ead8', beakDark: '#3a3340', legs: '#8a7a6a', crest: true };
  const GULL = { body: '#ffffff', belly: '#f2f5f8', wing: '#b9c4ce', wing2: '#7d8996', tail: '#4a525c', beak: '#ffc94d', beakDark: '#e8584f', legs: '#ffa94d', crest: false };
  function drawBirdie(c, P) {
    const flying = c.mode === 'flee' || c.mode === 'land';
    const alt = flying ? c.alt || 0 : 0;
    shadow(c.x, c.y, flying ? 7 - alt * 0.12 : 6, 2);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - alt); ctx.scale(c.facing, 1);
    const peck = c.mode === 'peck' ? Math.max(0, Math.sin(c.anim * 9)) : 0;
    const walk = c.mode === 'walk' ? Math.sin(c.anim * 14) : 0;
    if (!flying) { ctx.strokeStyle = P.legs; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(-1, -3); ctx.lineTo(-1 + walk, 0); ctx.moveTo(1.5, -3); ctx.lineTo(1.5 - walk, 0); ctx.stroke(); }
    // 꼬리
    ctx.fillStyle = P.tail; ctx.beginPath(); ctx.moveTo(-4, -6); ctx.lineTo(-10, -4 + (flying ? -2 : 1)); ctx.lineTo(-9, -2 + (flying ? -1 : 2)); ctx.closePath(); ctx.fill();
    if (P.crest) { ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.moveTo(-8, -3); ctx.lineTo(-11, -1); ctx.lineTo(-9, 0); ctx.fill(); }
    // 날개 (뒤쪽, 날 때만)
    const flap = flying ? Math.sin(c.anim * 22) : 0;
    if (flying) { ctx.fillStyle = P.wing2; ctx.save(); ctx.translate(-1, -7); ctx.rotate(-0.8 - flap * 0.6); ctx.beginPath(); ctx.ellipse(0, -5, 2.2, 6, 0, 0, TAU); ctx.fill(); ctx.restore(); }
    ctx.fillStyle = P.body; ctx.beginPath(); ctx.ellipse(0, -6, 5.5, 4, -0.15, 0, TAU); ctx.fill();
    ctx.fillStyle = P.belly; ctx.beginPath(); ctx.ellipse(1, -4.4, 3.6, 2.2, 0, 0, TAU); ctx.fill();
    // 머리 (콕콕 쪼면 앞으로 숙임)
    ctx.save(); ctx.translate(3.5, -9); ctx.rotate(peck * 0.9);
    ctx.fillStyle = P.body; circle(0, 0, 3.3);
    eye(c, 1, -0.6, 0.8);
    ctx.fillStyle = P.beak; ctx.beginPath(); ctx.moveTo(2.6, -1.2); ctx.quadraticCurveTo(5.4, -1, 4.8, 1.4); ctx.lineTo(2.8, 0.8); ctx.fill();
    ctx.fillStyle = P.beakDark; circle(4.6, 0.9, 0.5);
    blush(1.6, 1.2, 0.8, 0.45);
    if (P.crest) { ctx.fillStyle = P.body; ctx.beginPath(); ctx.moveTo(-1, -2.6); ctx.quadraticCurveTo(-3, -5.5, -0.5, -6); ctx.quadraticCurveTo(0, -4, 1, -3); ctx.fill(); }
    ctx.restore();
    // 앞 날개
    ctx.fillStyle = P.wing;
    if (flying) { ctx.save(); ctx.translate(0, -7); ctx.rotate(-0.5 + flap * 0.7); ctx.beginPath(); ctx.ellipse(0, -5.5, 2.4, 6.5, 0, 0, TAU); ctx.fill(); ctx.fillStyle = P.wing2; ctx.beginPath(); ctx.ellipse(0, -10, 1.6, 2.2, 0, 0, TAU); ctx.fill(); ctx.restore(); }
    else { ctx.beginPath(); ctx.ellipse(-1.2, -6.4, 3.8, 2.2, -0.25, 0, TAU); ctx.fill(); ctx.fillStyle = P.wing2; ctx.beginPath(); ctx.ellipse(-3.6, -5.6, 1.8, 1.2, -0.3, 0, TAU); ctx.fill(); }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 나무늘보: 아주 느릿느릿, 늘 웃는 얼굴 ----
  function drawSloth(c) {
    const fur = '#b89c7e', shade = '#9c8164', face = '#f1e3cb';
    const sleep = c.mode === 'sleep';
    shadow(c.x, c.y, 11, 3);
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(c.facing, 1);
    const reach = c.mode === 'walk' ? Math.sin(c.anim * 1.5) * 1.5 : 0;
    ctx.fillStyle = shade; rr(-8, -4, 4, 4, 2); rr(4, -4, 4, 4, 2);
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(-1, -7, 9.5, 6.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(120,95,70,0.3)'; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(-6 + i * 3, -10, 0.7, 2, 0.4, 0, TAU); ctx.fill(); }
    // 긴 팔과 발톱
    ctx.strokeStyle = fur; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(4, -8); ctx.quadraticCurveTo(9 + reach, -6, 11 + reach, -1); ctx.stroke();
    ctx.strokeStyle = '#5a4a3a'; ctx.lineWidth = 0.6;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(10.5 + reach + k, -0.8); ctx.lineTo(11.5 + reach + k, 0.6); ctx.stroke(); }
    // 머리
    const hx = 7, hy = sleep ? -10 : -13;
    ctx.fillStyle = fur; circle(hx, hy, 5.4);
    ctx.fillStyle = face; ctx.beginPath(); ctx.ellipse(hx + 1, hy + 0.5, 4.3, 3.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6e5440';
    ctx.beginPath(); ctx.ellipse(hx - 1, hy, 2, 1.2, -0.35, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(hx + 3.2, hy, 2, 1.2, 0.35, 0, TAU); ctx.fill();
    if (sleep) {
      ctx.strokeStyle = '#2e2a28'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(hx - 0.8, hy, 0.9, 0.2, Math.PI - 0.2); ctx.stroke(); ctx.beginPath(); ctx.arc(hx + 3, hy, 0.9, 0.2, Math.PI - 0.2); ctx.stroke();
      if (Math.random() < 0.01) particles.push({ x: c.x + 6, y: c.y - 20, vx: 6, vy: -10, life: 1.8, kind: 'z' });
    } else { eye(c, hx - 0.8, hy, 0.75); eye(c, hx + 3, hy, 0.75); }
    ctx.fillStyle = '#4a3a2e'; ctx.beginPath(); ctx.ellipse(hx + 1.2, hy + 1.7, 1.1, 0.7, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#4a3a2e'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(hx + 1.2, hy + 2.2, 1.6, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(hx - 1.6, hy + 2, 0.9, 0.4); blush(hx + 4, hy + 2, 0.9, 0.4);
    ctx.restore();
  }

  // ---- 꽃 정령: 커다란 히비스커스 얼굴, 잎사귀 팔 ----
  function drawBloom(c) {
    const hop = c.mode === 'walk' || c.mode === 'flee' ? Math.abs(Math.sin(c.anim * 6)) * 4 : 0;
    shadow(c.x, c.y, 6, 2.2);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - hop); ctx.scale(c.facing, 1);
    const wave = Math.sin(c.anim * 4) * 0.4;
    ctx.strokeStyle = '#4f9e57'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -8); ctx.stroke();
    ctx.fillStyle = '#5cb05e';
    for (const [side, a] of [[-1, -0.6 + wave], [1, 0.6 - wave]]) { ctx.save(); ctx.translate(0, -5); ctx.rotate(a); ctx.beginPath(); ctx.ellipse(side * 3.5, 0, 3.5, 1.6, 0, 0, TAU); ctx.fill(); ctx.restore(); }
    ctx.fillStyle = '#4f9e57'; ctx.beginPath(); ctx.ellipse(-1.6, -0.4, 2, 1, 0, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(1.8, -0.4, 2, 1, 0, 0, TAU); ctx.fill();
    const fy = -14, spin = Math.sin(c.anim * 1.2) * 0.15;
    for (let k = 0; k < 5; k++) {
      const a = k * 1.2566 - Math.PI / 2 + spin;
      ctx.fillStyle = '#e8456a'; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 4.8, fy + Math.sin(a) * 4.8, 4.4, 3.4, a, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ff7896'; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 4.4, fy + Math.sin(a) * 4.4, 3.4, 2.4, a, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#ffe6a8'; circle(0, fy, 4.2);
    eye(c, 1.4, fy - 0.6, 0.8); eye(c, -1.4, fy - 0.6, 0.75);
    ctx.strokeStyle = '#7a4a3a'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(0, fy + 0.8, 1.1, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(2.6, fy + 1, 0.8, 0.55); blush(-2.6, fy + 1, 0.8, 0.5);
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(2.5, fy - 3); ctx.quadraticCurveTo(5, fy - 7, 6.5, fy - 8); ctx.stroke();
    ctx.fillStyle = '#ffd34d'; circle(6.5, fy - 8, 0.9);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ================= 바닷가 생명체 =================
  // ---- 꽃게: 옆으로 종종종, 놀라면 모래 속에 쏙 (눈만 빼꼼) ----
  function drawCrab(c) {
    const body = '#f0704f', dark = '#d4553a';
    if (c.mode === 'hide') {
      ctx.fillStyle = 'rgba(220,190,140,0.9)'; ctx.beginPath(); ctx.ellipse(c.x, c.y, 7, 2.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f8e8c0'; ctx.beginPath(); ctx.ellipse(c.x - 1, c.y - 0.8, 5, 1.4, 0, 0, TAU); ctx.fill();
      const peek = Math.sin(c.anim * 1.5 + c.id) > 0;
      if (peek) { ctx.strokeStyle = dark; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(c.x - 1.6, c.y - 0.5); ctx.lineTo(c.x - 1.8, c.y - 3.5); ctx.moveTo(c.x + 1.6, c.y - 0.5); ctx.lineTo(c.x + 1.8, c.y - 3.5); ctx.stroke(); eye(c, c.x - 1.8, c.y - 4, 0.8, { white: true }); eye(c, c.x + 1.8, c.y - 4, 0.8, { white: true }); }
      return;
    }
    shadow(c.x, c.y, 7, 2);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y);
    const walk = c.mode === 'walk' ? Math.sin(c.anim * 20) : 0;
    ctx.strokeStyle = dark; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
      const x = side * (3 + k * 1.3), ph = (k % 2 ? 1 : -1) * walk;
      ctx.beginPath(); ctx.moveTo(x * 0.7, -2.5); ctx.lineTo(x + side * 2, -2.5 - ph); ctx.lineTo(x + side * 2.8, 0); ctx.stroke();
    }
    ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(0, -3, 6.2, 3.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, -3.4, 5.8, 3.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-1.5, -5, 2.2, 0.9, -0.2, 0, TAU); ctx.fill();
    // 집게 (딸깍딸깍)
    const snap = Math.sin(c.anim * 5) > 0.6 ? 0.4 : 0;
    for (const side of [-1, 1]) {
      ctx.strokeStyle = dark; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.moveTo(side * 4, -4.5); ctx.lineTo(side * 6.5, -7.5); ctx.stroke();
      ctx.save(); ctx.translate(side * 7, -9); ctx.rotate(side * 0.3);
      ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 2.4, 2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(0, -1); ctx.lineTo(side * 1, -3.2 - snap * 2); ctx.lineTo(side * 2.2, -1.5); ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = dark; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(-1.6, -5.5); ctx.lineTo(-1.8, -8.3); ctx.moveTo(1.6, -5.5); ctx.lineTo(1.8, -8.3); ctx.stroke();
    eye(c, -1.8, -8.6, 0.85, { white: true }); eye(c, 1.8, -8.6, 0.85, { white: true });
    ctx.strokeStyle = '#8a2e20'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(0, -3.2, 1.2, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(-2.8, -2.6, 0.8, 0.5); blush(2.8, -2.6, 0.8, 0.5);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 물범: 배 깔고 누워 있다가 데굴, 짝짝 박수 ----
  function drawSeal(c) {
    const fur = '#aebcc7', shade = '#8e9daa', belly = '#e2e9ee';
    shadow(c.x, c.y, 13, 3.5);
    ctx.save(); ctx.translate(c.x, c.y - 5); ctx.scale(c.facing, 1);
    if (c.mode === 'roll') ctx.rotate(c.anim * 7 * (Math.cos(c.dir) >= 0 ? 1 : -1) * c.facing);
    // 뒷지느러미
    ctx.fillStyle = shade; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-15, -3); ctx.lineTo(-15, 2.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = fur; ctx.beginPath(); ctx.ellipse(-1, 0, 11, 5.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(0, 2.2, 9, 2.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(110,125,140,0.35)'; for (const [x, y] of [[-5, -2.5], [-1, -3.5], [3, -2], [-7, -0.5]]) circle(x, y, 0.8);
    // 머리
    const hx = 9, hy = -3;
    ctx.fillStyle = fur; circle(hx, hy, 5);
    ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(hx + 2.6, hy + 1.6, 2.6, 1.9, 0, 0, TAU); ctx.fill();
    eye(c, hx + 0.6, hy - 1.2, 1.2); eye(c, hx + 3.6, hy - 1.2, 1.1);
    ctx.fillStyle = '#3a3a42'; ctx.beginPath(); ctx.ellipse(hx + 3, hy + 0.8, 1, 0.7, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(80,80,90,0.6)'; ctx.lineWidth = 0.35;
    for (const dy of [-0.4, 0.8]) { ctx.beginPath(); ctx.moveTo(hx + 4.2, hy + 1.4 + dy * 0.5); ctx.lineTo(hx + 7, hy + 1 + dy); ctx.stroke(); }
    blush(hx + 0.6, hy + 2, 1, 0.45);
    // 앞지느러미 (박수)
    const clap = c.mode === 'clap' ? Math.abs(Math.sin(c.anim * 12)) : 0;
    ctx.fillStyle = shade;
    ctx.save(); ctx.translate(3, 2); ctx.rotate(-0.4 - clap * 1.2); ctx.beginPath(); ctx.ellipse(1.5, 1.5, 1.6, 3.2, 0, 0, TAU); ctx.fill(); ctx.restore();
    ctx.restore();
    if (c.mode === 'clap' && Math.random() < 0.02) particles.push({ x: c.x, y: c.y - 22, vx: 0, vy: -14, life: 1.2, kind: 'heart' });
  }

  // ---- 불가사리 정령: 별 모양 몸, 걸을 땐 옆구르기 ----
  function drawStarry(c) {
    const walk = c.mode === 'walk' || c.mode === 'flee';
    const hop = walk ? Math.abs(Math.sin(c.anim * 6)) * 3 : 0;
    shadow(c.x, c.y, 7, 2.2);
    fade(c);
    ctx.save(); ctx.translate(c.x, c.y - 8 - hop);
    if (walk) ctx.rotate(c.anim * 6 * c.facing);
    else ctx.rotate(Math.sin(c.anim * 2) * 0.12);
    ctx.fillStyle = '#e86f4f'; starPath(ctx, 0.4, 0.6, 9, 4.6); ctx.fill();
    ctx.fillStyle = '#ff9a6e'; starPath(ctx, 0, 0, 8.6, 4.4); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,220,0.85)';
    for (let q = 0; q < 5; q++) { const qa = q * 1.2566 - 1.57; circle(Math.cos(qa) * 5.5, Math.sin(qa) * 5.5, 0.6); circle(Math.cos(qa) * 3.8, Math.sin(qa) * 3.8, 0.45); }
    ctx.rotate(walk ? -c.anim * 6 * c.facing : 0);
    eye(c, -1.4, -0.6, 0.85); eye(c, 1.6, -0.6, 0.9);
    ctx.strokeStyle = '#8a3a2a'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(0.1, 0.9, 1.1, 0.3, Math.PI - 0.3); ctx.stroke();
    blush(-2.8, 1, 0.8, 0.55); blush(3, 1, 0.8, 0.55);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---- 굴러가는 회전초 (사막에서 가끔 바람 따라) ----
  const weeds = [];
  let weedT = 3;
  function updateTumbleweeds(dt, view, world) {
    weedT -= dt;
    if (desK > 0.6 && weedT <= 0 && weeds.length < 2) {
      weedT = 6 + Math.random() * 10;
      const y = view.y0 + 60 + Math.random() * (view.y1 - view.y0 - 120);
      if (biomeIdAt(world, view.x0, y) === 'desert') weeds.push({ x: view.x0 - 20, y, v: 35 + Math.random() * 25, rot: 0, ph: Math.random() * TAU, s: 0.8 + Math.random() * 0.4 });
    }
    const spr = sprite('tumble', 24, 24, 12, 12, paintTumbleweed);
    for (let i = weeds.length - 1; i >= 0; i--) {
      const w = weeds[i];
      w.x += w.v * dt; w.rot += (w.v / 9) * dt; w.ph += dt * 5;
      if (w.x > view.x1 + 40) { weeds.splice(i, 1); continue; }
      const hop = Math.abs(Math.sin(w.ph)) * 6 * w.s;
      ctx.fillStyle = `rgba(150,100,50,${0.18 * sun.k})`; ctx.beginPath(); ctx.ellipse(w.x, w.y, 9 * w.s * (1 - hop / 20), 2.4 * w.s, 0, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(w.x, w.y - 10 * w.s - hop); ctx.rotate(w.rot); stamp(spr, 0, 0, w.s); ctx.restore();
    }
  }
  function paintTumbleweed() {
    const r = mulberry32(919);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? 'rgba(225,190,130,0.95)' : 'rgba(160,115,65,0.9)'; ctx.lineWidth = pass ? 0.6 : 0.9;
      for (let i = 0; i < 22; i++) {
        const a = r() * TAU, b = a + 1.5 + r() * 2, R = 7 + r() * 3.5;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.quadraticCurveTo((r() - 0.5) * 8, (r() - 0.5) * 8, Math.cos(b) * R, Math.sin(b) * R); ctx.stroke();
      }
    }
  }

  // ---- 눈 위 발자국 (천천히 사라짐) ----
  const tracks = [];
  const lastPrint = new WeakMap();
  let zLastStep = 0, zSide = 1;
  function updateTracks(state, view, z) {
    const world = state.world;
    // 발자국이 남는 땅: 눈(파란 그늘) · 모래(갈색 그늘). 오아시스 풀밭엔 안 남는다
    const ground = (x, y) => {
      const b = biomeIdAt(world, x, y);
      if (b !== 'snow' && b !== 'desert' && b !== 'beach') return 0;
      if (pondAt(world, x, y, b === 'desert' ? 34 : 0) || (b === 'desert' && inFeature(world, x, y, 'forest'))) return 0;
      if (b === 'beach' && x < coastX(world, y) + 30) return 0; // 파도가 닿는 곳은 금방 지워진다
      return b === 'snow' ? 1 : 2;
    };
    const stepIdx = Math.floor(z.walkAnim / Math.PI);
    const zg = z.moving && stepIdx !== zLastStep ? ground(z.x, z.y) : 0;
    if (zg) {
      zSide = -zSide;
      tracks.push({ x: z.x - z.facing * 2, y: z.y + zSide * 3, t, w: 3.4, h: 2, g: zg });
    }
    zLastStep = stepIdx;
    for (const c of state.creatures) {
      if (c.type === 'butterfly' || c.carriedBy) continue;
      const lp = lastPrint.get(c);
      if (!lp) { lastPrint.set(c, { x: c.x, y: c.y, side: 1 }); continue; }
      const d = Math.hypot(c.x - lp.x, c.y - lp.y);
      const groove = c.type === 'penguin' && c.mode === 'slide';
      if (d < (groove ? 4 : 9)) continue;
      lp.x = c.x; lp.y = c.y; lp.side = -lp.side;
      const cg = ground(c.x, c.y);
      if (!cg) continue;
      const r = TYPES[c.type].radius;
      if (c.type === 'seal' || ((c.type === 'gull' || c.type === 'parrot') && c.alt > 0)) continue;
      tracks.push(groove ? { x: c.x, y: c.y - 1, t, w: 4, h: 2.4, g: cg } : { x: c.x, y: c.y + lp.side * r * 0.25, t, w: r * 0.22 + 0.8, h: r * 0.14 + 0.6, g: cg });
    }
    while (tracks.length > 600 || (tracks.length && t - tracks[0].t > 30)) tracks.shift();
    for (const p of tracks) {
      if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
      const a = 1 - (t - p.t) / 30;
      ctx.fillStyle = p.g === 2 ? `rgba(185,135,80,${0.3 * a})` : `rgba(140,170,205,${0.32 * a})`;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.w, p.h, 0, 0, TAU); ctx.fill();
    }
  }

  // ---- 추운 곳에선 입김이 폴폴 ----
  let breathT = 0;
  function breathe(state, z, dt, view) {
    if (snowK < 0.5) return;
    breathT -= dt;
    if (breathT > 0) return;
    breathT = 1.6 + Math.random() * 1.4;
    const s = 30 * (1 + Math.min(z.power, 40) * 0.012);
    const low = z.pose === 'lie' || z.pose === 'prone' || z.pose === 'crawl';
    const mx = z.x + z.facing * s * 0.25, my = z.y - (low ? s * 0.45 : s * 1.12);
    for (let i = 0; i < 3; i++) particles.push({ x: mx, y: my, vx: z.facing * (8 + i * 4), vy: -4 - i * 2, life: 1.1 + i * 0.15, kind: 'breath', r: 1.6 + i * 0.6 });
    // 근처 겨울 친구들도 가끔
    for (const c of state.creatures) {
      if (Math.random() > 0.25 || Math.abs(c.x - z.x) > 220 || Math.abs(c.y - z.y) > 260) continue;
      if (!['hare', 'penguin', 'fox'].includes(c.type) && !c.friend) continue;
      const r = TYPES[c.type].radius;
      particles.push({ x: c.x + c.facing * r * 1.1, y: c.y - r * 1.7, vx: c.facing * 7, vy: -4, life: 1, kind: 'breath', r: 1.2 });
    }
  }

  function drawTargetRing(c, big = 13, rgb = '255,120,150') {
    const p = (Math.sin(t * 6) + 1) / 2;
    ctx.strokeStyle = `rgba(${rgb},${0.5 + p * 0.4})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.ellipse(c.x, c.y, big + p * 2, big * 0.38 + p, 0, 0, TAU); ctx.stroke();
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
    } else if (e.type === 'hit') {
      for (let i = 0; i < 6; i++) { const a = Math.random() * TAU; particles.push({ x: e.x, y: e.y - 10, vx: Math.cos(a) * 50, vy: Math.sin(a) * 50 - 20, life: 0.6, kind: 'star' }); }
      particles.push({ x: e.x + (Math.random() - 0.5) * 8, y: e.y - 26, vx: 0, vy: -22, life: 0.8, kind: 'text', text: e.by === 'friend' ? '톡!' : '콩!', color: '#ff8a3d', size: e.by === 'friend' ? 10 : 14 });
    } else if (e.type === 'hurt') {
      particles.push({ x: e.x, y: e.y - 50, vx: 0, vy: -20, life: 1, kind: 'text', text: '아야! -' + e.dmg, color: '#ff4d5e', size: 12 });
      for (let i = 0; i < 4; i++) particles.push({ x: e.x, y: e.y - 30, vx: (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 20, life: 0.6, kind: 'star' });
    } else if (e.type === 'alert') {
      particles.push({ x: e.x, y: e.y - 30, vx: 0, vy: -14, life: 0.9, kind: 'text', text: e.creature === 'farmer' ? '이놈!' : e.creature === 'goose' ? '꽥!' : e.creature === 'bee' ? '윙!' : '!', color: '#ff5a6a', size: 11 });
    } else if (e.type === 'beaten') {
      particles.push({ x: e.x, y: e.y - 32, vx: 0, vy: -16, life: 1.3, kind: 'text', text: '어질어질~ 지금이야!', color: '#7a5adf', size: 10 });
    } else if (e.type === 'faint') {
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; particles.push({ x: e.x, y: e.y - 20, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, life: 1, kind: 'star' }); }
    } else if (e.type === 'wake') {
      for (let i = 0; i < 8; i++) particles.push({ x: e.x, y: e.y - 20, vx: (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 30, life: 1.1, kind: 'heart' });
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
      else if (p.kind === 'breath') { ctx.globalAlpha = Math.min(1, p.life) * 0.55; ctx.fillStyle = '#ffffff'; circle(p.x, p.y, p.r + (1.3 - p.life) * 3); p.vx *= 1 - dt; }
      else if (p.kind === 'snowpuff') { ctx.globalAlpha = p.life * 1.6; ctx.fillStyle = '#ffffff'; circle(p.x, p.y, 1.4 + (0.5 - p.life) * 3); }
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
  const clouds = Array.from({ length: 4 }, (_, i) => ({ x: (i * 977) % 3000, y: (i * 1613 + 300) % 3000, s: 2 + (i % 3) * 0.8, v: 6 + (i % 4) * 2 }));
  function drawClouds(view, night) {
    const a = (1 - night) * 0.16;
    if (a < 0.01) return;
    ctx.globalAlpha = a;
    for (const c of clouds) {
      // 구름은 카메라 주변 3000칸 무늬로 반복 (맵이 아무리 커도 같은 밀도)
      const T = 3000, bx = c.x + t * c.v, by = c.y + Math.sin(t * 0.05 + c.x) * 30;
      const x = bx + T * Math.round((cam.x - bx) / T), y = by + T * Math.round((cam.y - by) / T);
      const w = 256 * c.s, h = 160 * c.s;
      if (x + w < view.x0 || x > view.x1 || y + h < view.y0 || y > view.y1) continue;
      ctx.drawImage(cloudImg, x, y, w, h);
    }
    ctx.globalAlpha = 1;
  }

  // ---- 떠다니는 것들: 낮엔 꽃가루·민들레 씨앗, 숲에선 나뭇잎 ----
  const motes = [];
  function updateMotes(dt, night, halfW, halfH, world) {
    const want = Math.round((1 - night) * 22 * (1 - snowK) * (1 - desK) + 70 * snowK + 40 * desK);
    while (motes.length < want) {
      motes.push({ x: cam.x + (Math.random() - 0.5) * halfW * 2.2, y: cam.y + (Math.random() - 0.5) * halfH * 2.2, ph: Math.random() * TAU, leaf: false, rot: 0, snow: Math.random() < snowK, sz: 0.8 + Math.random() * 1.4 });
    }
    if (motes.length > want) motes.length = want;
    for (const m of motes) {
      if (!m.snow && !m.sand && Math.random() < desK * 0.03) m.sand = true;
      if (m.sand) { // 모래알: 바람 따라 옆으로 휙휙, 가끔 길게 한 줄
        m.x += (55 + m.sz * 25) * dt;
        m.y += Math.sin(t * 2 + m.ph) * 6 * dt;
        if (m.x - cam.x > halfW * 1.2 || Math.abs(m.y - cam.y) > halfH * 1.2) {
          m.x = cam.x - halfW * 1.15; m.y = cam.y + (Math.random() - 0.5) * halfH * 2.2;
          m.sand = Math.random() < desK;
        }
        ctx.globalAlpha = 0.55 * (1 - night * 0.6);
        ctx.strokeStyle = '#fff1cf'; ctx.lineWidth = m.sz * 0.7;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - 4 - m.sz * 3, m.y); ctx.stroke();
        continue;
      }
      if (m.snow) { // 눈송이: 천천히 내리면서 살랑살랑, 아래로 나가면 위에서 다시
        m.x += (4 + Math.sin(t * 0.8 + m.ph) * 8) * dt;
        m.y += (14 + m.sz * 6) * dt;
        if (m.y - cam.y > halfH * 1.15 || Math.abs(m.x - cam.x) > halfW * 1.2) {
          m.x = cam.x + (Math.random() - 0.5) * halfW * 2.2; m.y = cam.y - halfH * 1.1;
          m.snow = Math.random() < snowK;
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffffff'; circle(m.x, m.y, m.sz);
        continue;
      }
      if (Math.random() < snowK * 0.02) m.snow = true;
      m.leaf = !!inFeature(world, m.x, m.y, 'forest') || (jK > 0.5 && m.ph < 3.6);
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
    const want = Math.floor(night * 40 * (1 - snowK) * (1 - desK * 0.65)); // 겨울엔 반딧불이 없음, 사막엔 조금
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
    ctx.fillStyle = snowK > 0.5 ? `rgba(70,100,150,${0.16 * sun.k})` : desK > 0.5 ? `rgba(140,85,40,${0.2 * sun.k})` : `rgba(40,70,40,${0.18 * sun.k})`;
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

  // 개발용: 작은 캔버스에 말 하나 (자세 확인)
  function debugHorse(cv, c, gait) {
    const d = 2; cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d;
    const g = cv.getContext('2d'), k = cv.height / 60; g.setTransform(k, 0, 0, k, cv.width / 2, cv.height * 0.9);
    const keep = ctx; ctx = g; horseBody(c, gait, t * 10, false); ctx = keep;
  }
  // 개발용: 생명체 하나를 크게 (모양 확인)
  function debugCreature(cv, c, units = 30) {
    const d = 2; cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d;
    const g = cv.getContext('2d'), k = cv.height / units; g.setTransform(k, 0, 0, k, cv.width / 2, cv.height * 0.88);
    const keep = ctx; ctx = g; drawCreatureBody({ ...c, x: 0, y: 0 }, 0); ctx = keep;
  }
  return { render, portrait, debugHorse, debugCreature };
}
