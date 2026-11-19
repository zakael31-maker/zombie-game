// 소리: 파일 없이 Web Audio로 직접 만든다 (게임 로직과 분리, 상태를 보고 소리만 낸다)
// - 배경: 느긋한 오르골 멜로디, 낮엔 새소리 · 밤엔 귀뚜라미와 부엉이
// - 좀비: 발소리(걷기/기기/뛰기), 냠냠, 새 특징 생길 때 반짝 소리, 누우면 코골이
// - 생명체: 도망갈 때 찍, 거북이 숨기·고슴도치 몸 말기 뽁, 개구리 개굴, 나비 변신 반짝
import { TYPES } from '../game/creatures.js';
import { nightAmount } from '../game/game.js';
import { biomeIdAt } from '../game/biomes.js';
import { coastX } from '../game/world.js';

const MUTE_KEY = 'zombie-world-muted';
const HEAR = 320; // 이 거리 안의 생명체 소리만 들린다

// 펜타토닉(도레미솔라)이라 아무 음이나 이어도 어울린다
const SCALE = [0, 2, 4, 7, 9];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// 생명체별 목소리 높이
const VOICE = {
  rabbit: 1500, hen: 900, chick: 2200, villager: 520, cat: 700, duck: 600,
  spirit: 1800, snail: 1200, turtle: 500, caterpillar: 1700, frog: 300,
  hedgehog: 1300, ladybug: 2400, butterfly: 2600,
  hare: 1650, penguin: 760, fox: 1150, snowman: 1900,
  lizard: 2100, meerkat: 1450, camel: 260, prickle: 1750,
  monkey: 1100, parrot: 1900, sloth: 420, bloom: 2000, crab: 2300, gull: 1300, seal: 480, starry: 1850, quokka: 1600, horse: 700, goose: 650, farmer: 480, scorpion: 2000, bee: 2400,
};

export function createSound() {
  let ctx = null, master = null, musicBus = null, sfxBus = null, ambBus = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}

  // 브라우저는 사용자가 화면을 처음 만질 때만 소리를 켤 수 있다
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
      // 오르골에 살짝 울림(딜레이) 추가
      musicBus = ctx.createGain(); musicBus.gain.value = 0.16;
      const delay = ctx.createDelay(1); delay.delayTime.value = 0.32;
      const fb = ctx.createGain(); fb.gain.value = 0.35;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 2200;
      musicBus.connect(master); musicBus.connect(delay);
      delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(master);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(master);
      ambBus = ctx.createGain(); ambBus.gain.value = 0.22; ambBus.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
    if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05);
  }

  // ---------- 소리 재료 ----------
  function tone(freq, { at = 0, dur = 0.2, type = 'sine', vol = 0.3, slideTo, attack = 0.005, bus = sfxBus } = {}) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise({ at = 0, dur = 0.1, vol = 0.2, freq = 800, q = 1, type = 'lowpass', attack = 0.005, bus = sfxBus, sweepTo } = {}) {
    const t = ctx.currentTime + at;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }

  // ---------- 효과음 ----------
  const sfx = {
    step(mode, ground) {
      if (ground === 'snow') { // 뽀드득
        const v = mode === 'run' ? 1.3 : mode === 'crawl' ? 0.5 : 1;
        noise({ dur: 0.1, vol: 0.09 * v, freq: 1900 + Math.random() * 500, type: 'bandpass', q: 1.4 });
        noise({ at: 0.03, dur: 0.07, vol: 0.06 * v, freq: 700, type: 'bandpass', q: 1 });
        return;
      }
      if (ground === 'sand') { // 사락사락
        const v = mode === 'run' ? 1.3 : mode === 'crawl' ? 0.5 : 1;
        noise({ dur: 0.16, vol: 0.06 * v, freq: 2600 + Math.random() * 600, type: 'bandpass', q: 0.7, attack: 0.03 });
        return;
      }
      if (ground === 'ice') { tone(1800 + Math.random() * 400, { dur: 0.04, vol: 0.04, type: 'triangle' }); return; }
      if (mode === 'crawl') noise({ dur: 0.12, vol: 0.05, freq: 1400, type: 'bandpass', q: 0.8 });
      else noise({ dur: mode === 'run' ? 0.07 : 0.09, vol: mode === 'run' ? 0.16 : 0.11, freq: 380 + Math.random() * 120 });
    },
    // 말발굽: 따각 (달리면 다그닥 세 번)
    hoof(gallop, ground, k) {
      const soft = ground === 'sand' || ground === 'snow' ? 0.55 : 1;
      const one = (at, v) => {
        tone((k ? 820 : 700) + Math.random() * 60, { at, dur: 0.035, type: 'triangle', vol: 0.07 * v * soft });
        noise({ at, dur: 0.05, vol: 0.07 * v * soft, freq: ground === 'sand' ? 2200 : 1300, type: 'bandpass', q: 1.5 });
      };
      if (gallop) { one(0, 1); one(0.07, 0.8); one(0.14, 1.1); } else one(0, 1);
    },
    hit(friend) { // 콩! (친구는 톡)
      tone(friend ? 900 : 520, { dur: 0.08, type: 'triangle', vol: friend ? 0.12 : 0.25, slideTo: friend ? 1200 : 760 });
      noise({ dur: 0.05, vol: friend ? 0.06 : 0.12, freq: 1800, type: 'bandpass', q: 1 });
    },
    hurt() { tone(420, { dur: 0.18, type: 'triangle', vol: 0.22, slideTo: 260 }); noise({ dur: 0.08, vol: 0.1, freq: 900 }); },
    honk() { for (let i = 0; i < 2; i++) { tone(330, { at: i * 0.16, dur: 0.12, type: 'sawtooth', vol: 0.05, slideTo: 300 }); tone(660, { at: i * 0.16, dur: 0.12, type: 'square', vol: 0.025 }); } },
    buzz() { tone(220, { dur: 0.35, type: 'sawtooth', vol: 0.03, slideTo: 250 }); },
    grumble() { tone(200, { dur: 0.15, type: 'triangle', vol: 0.16, slideTo: 170 }); tone(240, { at: 0.17, dur: 0.18, type: 'triangle', vol: 0.15, slideTo: 200 }); },
    faint() { [76, 72, 69, 64, 60].forEach((n, i) => tone(midi(n), { at: i * 0.12, dur: 0.3, type: 'triangle', vol: 0.14 })); },
    wake() { [72, 76, 79, 84].forEach((n, i) => tone(midi(n), { at: i * 0.08, dur: 0.3, vol: 0.12 })); },
    neigh() { // 히이잉~ (떨리는 소리)
      for (let i = 0; i < 7; i++) tone(980 - i * 40 + (i % 2) * 90, { at: i * 0.07, dur: 0.09, type: 'triangle', vol: 0.07, slideTo: 900 - i * 40 });
      tone(420, { at: 0.5, dur: 0.15, vol: 0.06, slideTo: 300 });
    },
    eat(type) {
      const r = TYPES[type]?.radius || 8;
      const base = 520 - r * 12;
      // 냠! 냠! 두 번 + 바삭
      tone(base, { dur: 0.1, type: 'triangle', vol: 0.35, slideTo: base * 1.5 });
      tone(base * 1.2, { at: 0.13, dur: 0.12, type: 'triangle', vol: 0.32, slideTo: base * 1.8 });
      noise({ at: 0.02, dur: 0.08, vol: 0.12, freq: 2500, type: 'highpass' });
      noise({ at: 0.15, dur: 0.08, vol: 0.1, freq: 2500, type: 'highpass' });
    },
    trait() {
      [72, 76, 79, 84, 88].forEach((n, i) => tone(midi(n), { at: i * 0.09, dur: 0.6, vol: 0.18 }));
      tone(midi(96), { at: 0.5, dur: 0.9, vol: 0.08 });
    },
    bite() {
      // 앙! + 마법처럼 올라가는 소리
      tone(330, { dur: 0.12, type: 'triangle', vol: 0.3, slideTo: 220 });
      [67, 71, 74, 79, 83].forEach((n, i) => tone(midi(n), { at: 0.12 + i * 0.06, dur: 0.4, type: 'triangle', vol: 0.1 }));
    },
    whistle() { tone(1400, { dur: 0.12, vol: 0.12, slideTo: 2000 }); tone(1500, { at: 0.16, dur: 0.18, vol: 0.12, slideTo: 2400 }); },
    caught(v) { tone(700, { dur: 0.08, type: 'triangle', vol: 0.2 * v, slideTo: 1100 }); },
    delivered() { [79, 84].forEach((n, i) => tone(midi(n), { at: i * 0.1, dur: 0.35, type: 'triangle', vol: 0.14 })); },
    release() { [84, 79, 76, 72].forEach((n, i) => tone(midi(n), { at: i * 0.1, dur: 0.5, vol: 0.1 })); },
    full() { tone(300, { dur: 0.15, vol: 0.15, slideTo: 240 }); tone(240, { at: 0.16, dur: 0.2, vol: 0.13, slideTo: 200 }); },
    sparkle() {
      for (let i = 0; i < 6; i++) tone(midi(84 + SCALE[i % 5] + (i > 4 ? 12 : 0)), { at: i * 0.05, dur: 0.35, vol: 0.06 });
    },
    squeak(type, v) {
      const f = VOICE[type] || 1200;
      if (type === 'villager') { tone(f, { dur: 0.22, type: 'triangle', vol: 0.12 * v, slideTo: f * 1.6 }); return; }
      if (type === 'hen' || type === 'duck') {
        tone(f, { dur: 0.08, type: 'square', vol: 0.05 * v, slideTo: f * 0.8 });
        tone(f * 1.1, { at: 0.1, dur: 0.08, type: 'square', vol: 0.05 * v, slideTo: f * 0.8 });
        return;
      }
      tone(f, { dur: 0.09, vol: 0.14 * v, slideTo: f * 1.5 });
    },
    pop(v) { tone(500, { dur: 0.08, vol: 0.18 * v, slideTo: 180 }); },
    croak(v) {
      for (let i = 0; i < 2; i++) tone(170, { at: i * 0.14, dur: 0.11, type: 'sawtooth', vol: 0.05 * v, slideTo: 120 });
    },
    meow(v) { tone(700, { dur: 0.4, type: 'triangle', vol: 0.07 * v, slideTo: 520, attack: 0.08 }); },
    snore() { noise({ dur: 1.4, vol: 0.06, freq: 300, sweepTo: 600, attack: 0.6 }); },
    click() { tone(900, { dur: 0.05, vol: 0.08, slideTo: 1200 }); },
    // 배경 생활 소리
    bird() {
      const f = 2400 + Math.random() * 1600, n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) tone(f, { at: i * 0.11, dur: 0.08, vol: 0.18, slideTo: f * (1.2 + Math.random() * 0.3), bus: ambBus });
    },
    cricket() {
      const f = 4200 + Math.random() * 600;
      for (let i = 0; i < 4; i++) tone(f, { at: i * 0.045, dur: 0.03, type: 'square', vol: 0.04, bus: ambBus });
    },
    owl() {
      tone(380, { dur: 0.35, vol: 0.22, slideTo: 340, attack: 0.05, bus: ambBus });
      tone(380, { at: 0.5, dur: 0.6, vol: 0.2, slideTo: 330, attack: 0.08, bus: ambBus });
    },
    wind() { noise({ dur: 4, vol: 0.12, freq: 300, sweepTo: 700, attack: 1.8, type: 'bandpass', q: 0.6, bus: ambBus }); },
    coldWind() { noise({ dur: 5, vol: 0.16, freq: 500, sweepTo: 1100, attack: 2.2, type: 'bandpass', q: 1.2, bus: ambBus }); },
    // 겨울: 멀리서 들리는 작은 방울 소리
    chime() { const f = midi(88 + SCALE[Math.floor(Math.random() * 5)]); tone(f, { dur: 1.8, vol: 0.05, bus: ambBus }); tone(f * 2, { at: 0.02, dur: 0.8, vol: 0.02, bus: ambBus }); },
    // 사막: 모래 바람 휘잉 · 낙타 음머 · 멀리서 울리는 피리 같은 소리
    sandWind() { noise({ dur: 4.5, vol: 0.13, freq: 1400, sweepTo: 2600, attack: 2, type: 'bandpass', q: 2.2, bus: ambBus }); },
    grunt(v) { tone(150, { dur: 0.45, type: 'sawtooth', vol: 0.05 * v, slideTo: 110, attack: 0.08 }); },
    flute() {
      const n = 74 + [0, 1, 4, 5, 7][Math.floor(Math.random() * 5)];
      tone(midi(n), { dur: 1.4, type: 'triangle', vol: 0.035, attack: 0.25, slideTo: midi(n) * 0.985, bus: ambBus });
    },
    // 밀림: 열대 새 (휘리릭 · 꾸룩), 풀벌레, 원숭이
    tropicBird() {
      const f = 900 + Math.random() * 1400, kind = Math.random();
      if (kind < 0.4) for (let i = 0; i < 3; i++) tone(f * (1 + i * 0.25), { at: i * 0.12, dur: 0.12, vol: 0.12, slideTo: f * (1.4 + i * 0.25), bus: ambBus });
      else if (kind < 0.7) { tone(f * 0.5, { dur: 0.25, vol: 0.12, slideTo: f * 0.35, bus: ambBus }); tone(f * 0.5, { at: 0.3, dur: 0.25, vol: 0.1, slideTo: f * 0.35, bus: ambBus }); }
      else tone(f * 1.6, { dur: 0.5, vol: 0.06, slideTo: f * 2.2, type: 'triangle', bus: ambBus });
    },
    insects() { noise({ dur: 2.5, vol: 0.035, freq: 5200, type: 'bandpass', q: 6, attack: 0.8, bus: ambBus }); },
    ooh(v) { tone(500, { dur: 0.25, type: 'triangle', vol: 0.1 * v, slideTo: 800 }); tone(800, { at: 0.28, dur: 0.2, type: 'triangle', vol: 0.08 * v, slideTo: 600 }); },
    // 바닷가: 철썩 파도, 갈매기
    wave(v) { noise({ dur: 3.2, vol: 0.22 * v, freq: 500, sweepTo: 1500, attack: 1.3, type: 'lowpass', q: 0.5, bus: ambBus }); noise({ at: 1.2, dur: 2, vol: 0.08 * v, freq: 3500, type: 'highpass', attack: 0.4, bus: ambBus }); },
    gullCall(v = 1) { for (let i = 0; i < 3; i++) tone(1500, { at: i * 0.2, dur: 0.16, vol: 0.07 * v, slideTo: 1050, type: 'triangle', bus: ambBus }); },
    slide() { noise({ dur: 0.5, vol: 0.05, freq: 3000, type: 'highpass', attack: 0.05 }); },
  };

  // ---------- 오르골 배경음 ----------
  let noteTimer = 1, phrase = [], chordTimer = 0;
  function music(dt, night) {
    noteTimer -= dt;
    chordTimer -= dt;
    if (chordTimer <= 0) {
      // 낮은 화음 깔기 (밤엔 더 낮고 조용하게)
      const root = [48, 53, 55, 45][Math.floor(Math.random() * 4)] - (night > 0.5 ? 2 : 0);
      for (const n of [0, 7, 16]) tone(midi(root + n), { dur: 7, vol: 0.05, attack: 1.5, bus: musicBus });
      chordTimer = 8;
    }
    if (noteTimer > 0) return;
    if (!phrase.length) {
      // 짧은 악절 하나 만들기 → 끝나면 잠깐 쉼
      let idx = Math.floor(Math.random() * 5);
      const len = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < len; i++) {
        idx = Math.max(0, Math.min(9, idx + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]));
        phrase.push(72 + SCALE[idx % 5] + Math.floor(idx / 5) * 12 - (night > 0.5 ? 5 : 0));
      }
    }
    const n = phrase.shift();
    tone(midi(n), { dur: 1.6, vol: 0.22, bus: musicBus });
    tone(midi(n + 12), { dur: 0.5, vol: 0.04, bus: musicBus }); // 오르골 반짝임
    if (snow > 0.5) tone(midi(n + 24), { dur: 0.9, vol: 0.025, type: 'triangle', bus: musicBus }); // 겨울엔 방울 소리 섞기
    if (jungle > 0.5) tone(midi(n - 5), { dur: 0.25, vol: 0.06, type: 'triangle', bus: musicBus }); // 밀림엔 통통 마림바
    if (desert > 0.5) tone(midi(n - 12), { dur: 0.6, vol: 0.05, type: 'triangle', bus: musicBus }); // 사막엔 낮은 퉁 소리 섞기
    const slow = 1 + night * 0.6;
    noteTimer = (phrase.length ? 0.45 + Math.random() * 0.25 : 2.5 + Math.random() * 3) * slow;
  }

  // ---------- 매 프레임: 게임 상태를 보고 소리 내기 ----------
  let lastStep = 0, ambTimer = 2, windTimer = 6, snoreTimer = 1, slideTimer = 0;
  let jungle = 0, beach = 0, waveT = 2;
  let snow = 0, desert = 0; // 겨울 · 사막 지역 정도 (부드럽게)
  const prev = new WeakMap();
  const cool = {}; // 같은 종류 소리 너무 자주 안 나게
  const canPlay = (k, sec) => { const now = ctx.currentTime; if ((cool[k] || 0) > now) return false; cool[k] = now + sec; return true; };

  function update(state, dt) {
    if (!ctx || ctx.state !== 'running' || muted) return;
    dt = Math.min(dt, 0.1);
    const z = state.zombie;
    const night = nightAmount(state.time);

    const bid = biomeIdAt(state.world, z.x, z.y), inSnow = bid === 'snow', inDesert = bid === 'desert';
    snow += ((inSnow ? 1 : 0) - snow) * Math.min(1, dt * 0.5);
    desert += ((inDesert ? 1 : 0) - desert) * Math.min(1, dt * 0.5);
    jungle += ((bid === 'jungle' ? 1 : 0) - jungle) * Math.min(1, dt * 0.5);
    beach += ((bid === 'beach' ? 1 : 0) - beach) * Math.min(1, dt * 0.5);
    // 바다가 가까우면 파도 소리 (해안에서 멀어질수록 작게)
    const seaV = Math.max(0, 1 - (z.x - coastX(state.world, z.y)) / 700);
    waveT -= dt;
    if (seaV > 0.02 && waveT <= 0) { sfx.wave(seaV); waveT = 6.5; }
    music(dt, night);

    // 발소리: 걸음 주기(walkAnim)가 반 바퀴 돌 때마다 (눈 위는 뽀드득, 얼음은 톡)
    const ground = z.onIce ? 'ice' : inSnow ? 'snow' : inDesert || bid === 'beach' ? 'sand' : 'grass';
    const stepIdx = Math.floor(z.walkAnim * (z.riding ? 2 : 1) / Math.PI);
    if (z.riding) { if (z.moving && stepIdx !== lastStep && (z.moveMode !== 'run' || stepIdx % 2 === 0)) sfx.hoof(z.moveMode === 'run', ground, stepIdx % 2); }
    else if (z.moving && stepIdx !== lastStep) sfx.step(z.moveMode, z.onIce ? 'ice' : inSnow ? 'snow' : inDesert || bid === 'beach' ? 'sand' : 'grass');
    slideTimer -= dt;
    if (z.sliding && slideTimer <= 0) { sfx.slide(); slideTimer = 0.45; }
    lastStep = stepIdx;

    // 누워서 자면 코골이
    if (!z.moving && z.pose === 'lie') {
      snoreTimer -= dt;
      if (snoreTimer <= 0) { sfx.snore(); snoreTimer = 3.2; }
    } else snoreTimer = 1.5;

    for (const e of state.events) {
      if (e.type === 'eat') sfx.eat(e.creature);
      if (e.type === 'trait') sfx.trait();
      if (e.type === 'bite') sfx.bite();
      if (e.type === 'mount') sfx.neigh();
      if (e.type === 'hit') sfx.hit(e.by === 'friend');
      if (e.type === 'hurt') sfx.hurt();
      if (e.type === 'faint') sfx.faint();
      if (e.type === 'wake') sfx.wake();
      if (e.type === 'beaten') sfx.sparkle();
      if (e.type === 'alert') e.creature === 'goose' ? sfx.honk() : e.creature === 'bee' ? sfx.buzz() : e.creature === 'farmer' ? sfx.grumble() : sfx.caught(0.6);
      if (e.type === 'dismount') sfx.caught(1);
      if (e.type === 'full') sfx.full();
      if (e.type === 'fetch') e.count ? sfx.whistle() : sfx.full();
      if (e.type === 'caught') sfx.caught(Math.max(0.3, 1 - Math.hypot(e.x - z.x, e.y - z.y) / 400));
      if (e.type === 'delivered') sfx.delivered();
      if (e.type === 'release') sfx.release();
      if (e.type === 'giveup') sfx.full();
      if (e.type === 'metamorph' && Math.hypot(e.x - z.x, e.y - z.y) < HEAR) sfx.sparkle();
    }

    // 생명체 상태가 바뀌는 순간 소리
    for (const c of state.creatures) {
      const d = Math.hypot(c.x - z.x, c.y - z.y);
      const p = prev.get(c);
      prev.set(c, { mode: c.mode, hop: c.hopping > 0 });
      if (d > HEAR || !p || c.dying !== undefined || c.friend) continue;
      const v = 1 - d / HEAR;
      if (c.mode === 'flee' && p.mode !== 'flee' && canPlay('flee', 0.25)) sfx.squeak(c.type, v);
      if ((c.mode === 'hide' || c.mode === 'ball') && p.mode !== c.mode) sfx.pop(v);
      if (c.type === 'frog' && c.hopping > 0 && !p.hop && canPlay('frog', 2.5)) sfx.croak(v);
      if (c.type === 'cat' && c.mode === 'sit' && p.mode !== 'sit' && canPlay('cat', 6)) sfx.meow(v);
      if (c.type === 'fox' && c.mode === 'sit' && p.mode !== 'sit' && canPlay('fox', 6)) sfx.squeak('fox', v);
      if (c.type === 'monkey' && c.mode === 'sit' && p.mode !== 'sit' && canPlay('monkey', 5)) sfx.ooh(v);
      if (c.type === 'seal' && c.mode === 'clap' && p.mode !== 'clap' && canPlay('seal', 4)) sfx.squeak('seal', v);
      if (c.type === 'camel' && c.mode === 'sit' && p.mode !== 'sit' && canPlay('camel', 8)) sfx.grunt(v);
      if (c.type === 'penguin' && c.mode === 'slide' && p.mode !== 'slide' && canPlay('peng', 1)) sfx.squeak('penguin', v * 0.7);
    }

    // 배경: 낮엔 새, 밤엔 귀뚜라미 · 부엉이, 가끔 바람
    ambTimer -= dt;
    if (ambTimer <= 0 && snow > 0.5) {
      // 겨울: 새·귀뚜라미 대신 고요함 + 가끔 방울 소리, 밤엔 아주 가끔 부엉이
      if (night > 0.5 && Math.random() < 0.15) sfx.owl(); else if (Math.random() < 0.6) sfx.chime();
      ambTimer = 4 + Math.random() * 6;
    } else if (ambTimer <= 0 && jungle > 0.5) {
      if (night > 0.5) { Math.random() < 0.5 ? sfx.insects() : sfx.cricket(); ambTimer = 1 + Math.random() * 2; }
      else { sfx.tropicBird(); if (Math.random() < 0.3) sfx.insects(); ambTimer = 1.5 + Math.random() * 3; }
    } else if (ambTimer <= 0 && beach > 0.5) {
      if (night > 0.5) { sfx.cricket(); ambTimer = 2 + Math.random() * 3; }
      else { Math.random() < 0.6 ? sfx.gullCall(0.8) : sfx.bird(); ambTimer = 4 + Math.random() * 6; }
    } else if (ambTimer <= 0 && desert > 0.5) {
      // 사막: 낮엔 조용 + 가끔 피리 같은 소리, 밤엔 귀뚜라미 조금
      if (night > 0.5) { sfx.cricket(); ambTimer = 1.5 + Math.random() * 3; }
      else { if (Math.random() < 0.5) sfx.flute(); else if (Math.random() < 0.3) sfx.bird(); ambTimer = 4 + Math.random() * 6; }
    } else if (ambTimer <= 0) {
      if (night > 0.5) {
        if (Math.random() < 0.08) sfx.owl(); else sfx.cricket();
        ambTimer = 0.4 + Math.random() * 1.2;
      } else {
        sfx.bird();
        ambTimer = 2.5 + Math.random() * 5;
      }
    }
    windTimer -= dt;
    if (windTimer <= 0) {
      if (snow > 0.5) { sfx.coldWind(); windTimer = 7 + Math.random() * 8; }
      else if (desert > 0.5) { sfx.sandWind(); windTimer = 8 + Math.random() * 8; }
      else { sfx.wind(); windTimer = 12 + Math.random() * 15; }
    }
  }

  return {
    update,
    click: () => { if (ctx && !muted) sfx.click(); },
    get muted() { return muted; },
    get audioState() { return ctx ? ctx.state : "off"; },
    toggleMute() { unlock(); setMuted(!muted); return muted; },
  };
}
