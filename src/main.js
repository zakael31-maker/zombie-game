import { createGame, updateGame, nightAmount, totalEaten, maxFriends, friendsOf, DAY_LENGTH } from './game/game.js';
import { TYPES } from './game/creatures.js';
import { createRenderer } from './render/canvas2d.js';
import { createInput } from './input/input.js';
import { createSound } from './audio/sound.js';
import { createMinimap } from './render/minimap.js';

const canvas = document.getElementById('game');
const eatBtn = document.getElementById('eat');
const biteBtn = document.getElementById('bite');
const friendBar = document.getElementById('friendBar');
const panel = document.getElementById('panel');
const EMOJI = { rabbit: '🐰', hen: '🐔', chick: '🐥', villager: '🧑‍🌾', spirit: '🍄', snail: '🐌', turtle: '🐢',
  caterpillar: '🐛', frog: '🐸', hedgehog: '🦔', ladybug: '🐞', hare: '🐇', penguin: '🐧', fox: '🦊', snowman: '⛄',
  lizard: '🦎', meerkat: '🐿️', camel: '🐫', prickle: '🌵' };
const hud = document.getElementById('hud');
const toast = document.getElementById('toast');
const hint = document.getElementById('hint');

const state = createGame();
const renderer = createRenderer(canvas, state);
const actionBtns = [...document.querySelectorAll('[data-action]')];
const input = createInput(canvas, eatBtn, actionBtns, biteBtn);
const sound = createSound();
const muteBtn = document.getElementById('mute');
// 지도: 작은 지도를 누르면 전체 지도, 아무 데나 누르면 닫기
const bigmap = document.getElementById('bigmap');
const minimap = createMinimap(state, document.getElementById('minimap'), bigmap.querySelector('canvas'));
document.getElementById('minimap').addEventListener('pointerdown', (e) => {
  e.preventDefault(); sound.click();
  bigmap.querySelector('.info').textContent = `🗺️ 가 본 곳 ${minimap.exploredPct()}% · 누르면 닫혀요`;
  bigmap.classList.add('show');
});
bigmap.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); bigmap.classList.remove('show'); });
window.addEventListener('keydown', (e) => { // M 키로 지도 열고 닫기
  if (e.code !== 'KeyM') return;
  if (bigmap.classList.toggle('show')) bigmap.querySelector('.info').textContent = `🗺️ 가 본 곳 ${minimap.exploredPct()}% · 누르면 닫혀요`;
});
const showMute = () => { muteBtn.textContent = sound.muted ? '🔇' : '🔊'; };
showMute();
muteBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); sound.toggleMute(); showMute(); });
for (const b of actionBtns) b.addEventListener('pointerdown', () => sound.click());

// 친구 명령
document.getElementById('fetchBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); input.queue('fetch'); });
document.getElementById('listBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault(); sound.click();
  panel.classList.toggle('show');
  if (panel.classList.contains('show')) renderPanel();
});
function renderPanel() {
  const fr = friendsOf(state);
  panel.innerHTML = `<h3>🧟 좀비 친구 ${fr.length}/${maxFriends(state.zombie)}</h3>` +
    (fr.length ? '' : '<div class="empty">아직 친구가 없어요</div>');
  for (const c of fr) {
    const row = document.createElement('div');
    row.className = 'row';
    const busy = c.task ? (c.task.kind === 'hunt' ? ' · 사냥 중' : ' · 데려오는 중') : '';
    row.innerHTML = `${EMOJI[c.type] || '🧟'} <span>${TYPES[c.type].name}${busy}</span>`;
    const b = document.createElement('button');
    b.textContent = '놓아주기';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); input.queue({ type: 'release', id: c.id }); });
    row.appendChild(b);
    panel.appendChild(row);
  }
}
let panelTimer = 0;
window.__game = state; window.__sound = sound; // 개발용: 브라우저 콘솔에서 상태 확인
// 개발용: 화면이 백그라운드여도 n프레임 강제로 진행
window.__step = (n = 1, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) { updateGame(state, dt, input.read()); renderer.render(state, dt, input); sound.update(state, dt); }
};

const TRAIT_TEXT = {
  ears: '토끼 귀가 쫑긋 생겼어요!',
  feather: '깃털 장식이 생겼어요!',
  hat: '밀짚모자를 얻었어요!',
  glow: '몸에서 은은한 빛이 나요…',
  shell: '등에 달팽이 껍질이 생겼어요!',
  armor: '거북이 등딱지 갑옷을 입었어요!',
  antenna: '머리에 더듬이가 쏙 나왔어요!',
  frog: '개구리 친구가 머리 위에 올라탔어요!',
  spikes: '머리에 고슴도치 가시가 돋았어요!',
  dots: '몸에 무당벌레 점무늬가 생겼어요!',
  earmuffs: '복슬복슬 귀마개가 생겼어요!',
  scarf: '포근한 목도리를 둘렀어요!',
  beanie: '방울 털모자를 썼어요!',
  shades: '반짝반짝 선글라스를 썼어요!',
  safari: '탐험가 모자를 얻었어요!',
  cactus: '머리에 꼬마 선인장이 자라났어요!',
};

let last = performance.now();
let hudTimer = 0;
let toastTimer = 0;
let hintHidden = false;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const inp = input.read();
  if (!hintHidden && (Math.abs(inp.x) + Math.abs(inp.y) > 0)) { hint.classList.add('hide'); hintHidden = true; }

  updateGame(state, dt, inp);
  renderer.render(state, dt, input);
  sound.update(state, dt);
  minimap.update(dt);

  for (const e of state.events) {
    if (e.type === 'trait') showToast(TRAIT_TEXT[e.trait]);
    if (e.type === 'eat') showToast(`${withObjectParticle(TYPES[e.creature].name)} 먹었어요`, 1.4);
    if (e.type === 'bite') showToast(`${withSubjectParticle(TYPES[e.creature].name)} 좀비 친구가 됐어요!`, 2);
    if (e.type === 'fetch') showToast(e.count ? `친구 ${e.count}명이 잡으러 갔어요!` : (friendsOf(state).some((c) => c.task) ? '다들 바빠요' : '근처에 잡을 게 없어요'), 1.8);
    if (e.type === 'delivered') showToast(`${withObjectParticle(TYPES[e.creature].name)} 데려왔어요! 냠 또는 물기`, 2.2);
    if (e.type === 'giveup') showToast('놓쳤어요… 친구가 돌아와요', 1.6);
    if (e.type === 'release') showToast(`${withSubjectParticle(TYPES[e.creature].name)} 돌아갔어요. 안녕~`, 2.2);
    if (e.type === 'full') showToast('친구가 꽉 찼어요 · 힘💪이 세지면 더 데려가요', 2.5);
  }
  toastTimer -= dt;
  if (toastTimer <= 0) toast.classList.remove('show');

  const nf = friendsOf(state).length;
  friendBar.classList.toggle('show', nf > 0);
  if (nf === 0 && panel.classList.contains('show') && !state.events.some((e) => e.type === 'release')) panel.classList.remove('show');
  panelTimer -= dt;
  if (panel.classList.contains('show') && (panelTimer <= 0 || state.events.some((e) => e.type === 'release' || e.type === 'bite'))) { renderPanel(); panelTimer = 0.5; }
  eatBtn.classList.toggle('show', !!state.nearEdible);
  biteBtn.classList.toggle('show', !!state.nearEdible);
  biteBtn.classList.toggle('full', friendsOf(state).length >= maxFriends(state.zombie));
  // 지금 켜져 있는 자세/이동 방식 버튼 표시
  const z = state.zombie;
  for (const b of actionBtns) {
    const a = b.dataset.action;
    b.classList.toggle('on', z.restPose === a || z.moveMode === a);
  }
  hudTimer -= dt;
  if (hudTimer <= 0) { updateHud(); hudTimer = 0.25; }
  requestAnimationFrame(frame);
}

// 받침이 있으면 '이', 없으면 '가'
function withSubjectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code % 28 !== 0 ? '이' : '가');
}

// 받침이 있으면 '을', 없으면 '를'
function withObjectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code % 28 !== 0 ? '을' : '를');
}

setTimeout(() => { hint.classList.add('hide'); hintHidden = true; }, 10000);

function showToast(text, sec = 2.5) {
  toast.textContent = text;
  toast.classList.add('show');
  toastTimer = sec;
}

function updateHud() {
  const z = state.zombie;
  const p = (state.time % DAY_LENGTH) / DAY_LENGTH;
  const icon = nightAmount(state.time) > 0.4 ? '🌙' : p < 0.4 ? '🌅' : p < 0.65 ? '☀️' : '🌇';
  hud.textContent = `${icon}  🦶 ${Math.round(z.speed)}  💪 ${z.power}  🍖 ${totalEaten(z)}  🧟 ${friendsOf(state).length}/${maxFriends(z)}`;
}

requestAnimationFrame(frame);
