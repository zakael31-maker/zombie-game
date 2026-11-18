import { createGame, updateGame, nightAmount, totalEaten, DAY_LENGTH } from './game/game.js';
import { TYPES } from './game/creatures.js';
import { createRenderer } from './render/canvas2d.js';
import { createInput } from './input/input.js';

const canvas = document.getElementById('game');
const eatBtn = document.getElementById('eat');
const hud = document.getElementById('hud');
const toast = document.getElementById('toast');
const hint = document.getElementById('hint');

const state = createGame();
const renderer = createRenderer(canvas, state);
const actionBtns = [...document.querySelectorAll('[data-action]')];
const input = createInput(canvas, eatBtn, actionBtns);
window.__game = state; // 개발용: 브라우저 콘솔에서 상태 확인
// 개발용: 화면이 백그라운드여도 n프레임 강제로 진행
window.__step = (n = 1, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) { updateGame(state, dt, input.read()); renderer.render(state, dt, input); }
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

  for (const e of state.events) {
    if (e.type === 'trait') showToast(TRAIT_TEXT[e.trait]);
    if (e.type === 'eat') showToast(`${withObjectParticle(TYPES[e.creature].name)} 먹었어요`, 1.4);
  }
  toastTimer -= dt;
  if (toastTimer <= 0) toast.classList.remove('show');

  eatBtn.classList.toggle('show', !!state.nearEdible);
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
  hud.textContent = `${icon}  🦶 ${Math.round(z.speed)}  💪 ${z.power}  🍖 ${totalEaten(z)}`;
}

requestAnimationFrame(frame);
