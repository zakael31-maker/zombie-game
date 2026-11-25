import { createGame, updateGame, maxHp, CHARACTERS, RACES, raceOf, chooseCharacter, needsCharacter, nightAmount, totalEaten, maxFriends, friendsOf, DAY_LENGTH } from './game/game.js';
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
  lizard: '🦎', meerkat: '🐿️', camel: '🐫', prickle: '🌵',
  horse: '🐴', quokka: '🦘', goose: '🪿', farmer: '🧹', scorpion: '🦂', bee: '🐝', monkey: '🐒', parrot: '🦜', sloth: '🦥', bloom: '🌺', crab: '🦀', gull: '🕊️', seal: '🦭', starry: '⭐' };
const hud = document.getElementById('hud');
const toast = document.getElementById('toast');
const hint = document.getElementById('hint');

const state = createGame();
const renderer = createRenderer(canvas, state);
const actionBtns = [...document.querySelectorAll('[data-action]')];
const crawlBtn = actionBtns.find((b) => b.dataset.action === 'crawl');
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

// 말 타기 / 내리기
const rideBtn = document.getElementById('ride');
rideBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); input.queue('ride'); });
// 집 들어가기 / 나가기
const doorBtn = document.getElementById('door');
doorBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); input.queue('door'); });
const fadeEl = document.getElementById('fade');
window.addEventListener('keydown', (e) => { if (e.code === 'KeyE' || e.code === 'Enter') input.queue('door'); }); // 키보드: E로 문

// 친구 명령
document.getElementById('fetchBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); input.queue('fetch'); });
document.getElementById('listBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault(); sound.click();
  panel.classList.toggle('show');
  if (panel.classList.contains('show')) renderPanel();
});
function renderPanel() {
  const fr = friendsOf(state);
  panel.innerHTML = `<h3>${RACES[raceOf(state.zombie)].emoji} ${RACES[raceOf(state.zombie)].friend} ${fr.length}/${maxFriends(state.zombie)}</h3>` +
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
// 캐릭터 고르기: 처음(또는 예전 저장)엔 자동으로, 🧟 버튼으로 언제든 바꾸기
const chars = document.getElementById('chars');
const charCards = {};
let picked = state.zombie.char || 'zip';
const MAXSP = Math.max(...Object.values(CHARACTERS).map((c) => c.speed));
const MAXPW = Math.max(...Object.values(CHARACTERS).map((c) => c.power));
const MAXHP = Math.max(...Object.values(CHARACTERS).map((c) => c.hp));
const RACE_NOTE = { zombie: '물린 친구는 초록 좀비가 돼요 🧟', vampire: '물린 친구는 보랏빛 뱀파이어가 돼요 🦇', werewolf: '물린 친구는 달빛 늑대가 돼요 🐾' };
let shownRace = raceOf(state.zombie);
const tabs = {};
for (const [r, R] of Object.entries(RACES)) {
  const b = document.createElement('button');
  b.textContent = `${R.emoji} ${R.name}`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); sound.click(); showRace(r); });
  chars.querySelector('.tabs').appendChild(b);
  tabs[r] = b;
}
for (const [id, c] of Object.entries(CHARACTERS)) {
  const b = document.createElement('button');
  b.className = 'card';
  b.innerHTML = `<canvas></canvas><b>${c.emoji} ${c.name}</b><div class="d">${c.desc}</div>` +
    `<div class="bar">🦶<i><span style="width:${Math.round(c.speed / MAXSP * 100)}%;background:#7fc8e8"></span></i></div>` +
    `<div class="bar">💪<i><span style="width:${Math.round(c.power / MAXPW * 100)}%;background:#ffb36b"></span></i></div>` +
    `<div class="bar">❤️<i><span style="width:${Math.round(c.hp / MAXHP * 100)}%;background:#ff8fa3"></span></i></div>`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); sound.click(); picked = id; markPicked(); });
  chars.querySelector('.grid').appendChild(b);
  charCards[id] = b;
}
// 종족 탭: 고른 종족의 4명만 보여 준다
function showRace(r) {
  shownRace = r;
  for (const [k, b] of Object.entries(tabs)) b.classList.toggle('on', k === r);
  for (const [id, b] of Object.entries(charCards)) b.style.display = CHARACTERS[id].race === r ? '' : 'none';
  chars.querySelector('.race-note').textContent = RACE_NOTE[r];
  if (CHARACTERS[picked]?.race !== r) { picked = Object.keys(CHARACTERS).find((id) => CHARACTERS[id].race === r); markPicked(); }
}
const markPicked = () => { for (const [id, b] of Object.entries(charCards)) b.classList.toggle('on', id === picked); };
function openChars() {
  picked = state.zombie.char || picked;
  chars.querySelector('.note').textContent = totalEaten(state.zombie) ? '바꿔도 먹어서 자란 만큼은 그대로예요' : '';
  chars.querySelector('.go').textContent = state.zombie.char ? '이 친구로 바꾸기!' : '이 친구로 시작!';
  showRace(raceOf({ char: picked })); markPicked(); chars.classList.add('show');
}
chars.querySelector('.go').addEventListener('pointerdown', (e) => {
  e.preventDefault(); sound.click();
  const first = !state.zombie.char;
  if (picked !== state.zombie.char) chooseCharacter(state, picked);
  chars.classList.remove('show');
  charBtnEl.textContent = RACES[raceOf(state.zombie)].emoji;
  showToast(first ? `${CHARACTERS[picked].name}랑 출발!` : `${withObjectParticle(CHARACTERS[picked].name)} 골랐어요!`, 2);
});
const charBtnEl = document.getElementById('charBtn');
charBtnEl.textContent = RACES[raceOf(state.zombie)].emoji;
charBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); sound.click(); openChars(); });
if (needsCharacter(state)) openChars();

let panelTimer = 0;
window.__game = state; window.__sound = sound; window.__renderer = renderer; // 개발용: 브라우저 콘솔에서 상태 확인
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
  tail: '원숭이 꼬리가 살랑살랑 생겼어요!',
  parrot: '앵무새 친구가 어깨에 앉았어요!',
  hibiscus: '귀 뒤에 히비스커스 꽃을 꽂았어요!',
  pincers: '손이 꽃게 집게가 됐어요! 딸깍딸깍',
  sailor: '세일러 모자를 얻었어요!',
  starpin: '불가사리 머리핀을 꽂았어요!',
  smile: '쿼카처럼 활짝 웃게 됐어요! 😊',
};

let last = performance.now();
let hudTimer = 0, hudBottom = 0;
let toastTimer = 0;
let hintHidden = false;
let alerted = false; // '화났어요' 안내는 처음 한 번만
let brawlTold = false, hitTold = false; // 반격·콩! 안내도 처음 한 번만

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const inp = input.read();
  if (!hintHidden && (Math.abs(inp.x) + Math.abs(inp.y) > 0)) { hint.classList.add('hide'); hintHidden = true; }

  updateGame(state, dt, inp);
  renderer.render(state, dt, input);
  sound.update(state, dt);
  minimap.update(dt);
  if (chars.classList.contains('show')) for (const [id, b] of Object.entries(charCards)) if (CHARACTERS[id].race === shownRace) renderer.portrait(b.firstChild, id, id === picked);

  for (const e of state.events) {
    if (e.type === 'trait') showToast(TRAIT_TEXT[e.trait]);
    if (e.type === 'eat') showToast(`${withObjectParticle(TYPES[e.creature].name)} 먹었어요`, 1.4);
    if (e.type === 'bite') showToast(`${withSubjectParticle(TYPES[e.creature].name)} ${RACES[raceOf(state.zombie)].friend}가 됐어요!`, 2);
    if (e.type === 'fetch') showToast(e.count ? `친구 ${e.count}명이 잡으러 갔어요!` : (friendsOf(state).some((c) => c.task) ? '다들 바빠요' : '근처에 잡을 게 없어요'), 1.8);
    if (e.type === 'delivered') showToast(`${withObjectParticle(TYPES[e.creature].name)} 데려왔어요! 냠 또는 물기`, 2.2);
    if (e.type === 'giveup') showToast('놓쳤어요… 친구가 돌아와요', 1.6);
    if (e.type === 'release') showToast(`${withSubjectParticle(TYPES[e.creature].name)} 돌아갔어요. 안녕~`, 2.2);
    if (e.type === 'alert' && e.brawl && !brawlTold) { showToast(`${withSubjectParticle(TYPES[e.creature].name)} 반격해요! 피하면서 콩! 콩!`, 2.6); brawlTold = true; }
    else if (e.type === 'alert' && !alerted) { showToast(`${withSubjectParticle(TYPES[e.creature].name)} 화났어요! 냠 버튼으로 콩! 때려요`, 2.6); alerted = true; }
    if (e.type === 'hit' && e.by === 'zombie' && !hitTold && !state.events.some((x) => x.type === 'beaten')) { showToast('콩! 콩! 어질어질해지면 냠! 또는 물기', 2.6); hitTold = true; }
    if (e.type === 'beaten') showToast(`${withSubjectParticle(TYPES[e.creature].name)} 어질어질~ 지금 냠! 또는 물기`, 2.4);
    if (e.type === 'faint') showToast('기절했어요… 잠깐 쉬고 다시 일어나요 💤', 3.5);
    if (e.type === 'wake') showToast('기운을 차렸어요! 체력 가득 ❤️', 2);
    if (e.type === 'hurt' || e.type === 'wake') hudTimer = 0;
    if (e.type === 'mount') showToast('말에 올라탔어요! 🏃 뛰기로 다그닥 달려요', 2.4);
    if (e.type === 'dismount') showToast('말에서 내렸어요', 1.4);
    if (e.type === 'enter' || e.type === 'leave') { fadeEl.classList.add('on'); setTimeout(() => fadeEl.classList.remove('on'), 40); }
    if (e.type === 'enter') showToast(state.inside?.room.people.length ? '실례합니다~ 🏠 아래 문으로 나가요' : '빈집이에요 · 침대에서 눕기 하면 푹 쉬어요', 2.4);
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
  const foe = !!state.nearFoe;
  if (eatBtn.classList.contains('foe') !== foe) { eatBtn.classList.toggle('foe', foe); eatBtn.innerHTML = foe ? '👊<br>콩!' : '냠!'; }
  // 말 버튼: 먹기 버튼이 떠 있으면 그 위로 비켜 준다
  const canRide = state.zombie.riding || !!state.nearRide;
  rideBtn.classList.toggle('show', canRide);
  rideBtn.classList.toggle('up', canRide && !!state.nearEdible);
  const rideText = state.zombie.riding ? '🐴<br>내리기' : '🐴<br>타기';
  if (rideBtn.innerHTML !== rideText) rideBtn.innerHTML = rideText;
  // 문 버튼: 집 안이면 나가기, 문 앞이면 들어가기. 다른 버튼이 떠 있으면 비켜 준다
  const canDoor = !!state.inside || !!state.nearDoor;
  doorBtn.classList.toggle('show', canDoor);
  doorBtn.classList.toggle('up', canDoor && !state.inside && (!!state.nearEdible !== canRide));
  doorBtn.classList.toggle('up2', canDoor && !state.inside && !!state.nearEdible && canRide);
  const doorText = state.inside ? '🚪<br>나가기' : '🚪<br>들어가기';
  if (doorBtn.innerHTML !== doorText) doorBtn.innerHTML = doorText;
  biteBtn.classList.toggle('show', !!state.nearEdible && !foe);
  biteBtn.classList.toggle('full', friendsOf(state).length >= maxFriends(state.zombie));
  // 지금 켜져 있는 자세/이동 방식 버튼 표시
  const z = state.zombie;
  // 뱀파이어는 '기기' 자리에 '박쥐' 변신 버튼
  const crawlText = raceOf(z) === 'vampire' ? '🦇<small>박쥐</small>' : '🐛<small>기기</small>';
  if (crawlBtn.innerHTML !== crawlText) crawlBtn.innerHTML = crawlText;
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
  const hp = z.hp / maxHp(z);
  hud.innerHTML = `<b>❤️<span class="hp${hp < 0.3 ? ' low' : ''}"><i style="width:${Math.round(hp * 100)}%"></i></span>${icon}</b><b>🦶 ${Math.round(z.speed)}</b><b>💪 ${z.power}</b><b>🍖 ${totalEaten(z)}</b><b>${RACES[raceOf(z)].emoji} ${friendsOf(state).length}/${maxFriends(z)}</b>`;
  // 상태 줄이 좁은 화면에서 두 줄이 되면 그 아래 버튼들도 같이 내려간다
  const bottom = Math.round(hud.getBoundingClientRect().bottom);
  if (bottom !== hudBottom) { hudBottom = bottom; document.documentElement.style.setProperty('--hudB', bottom + 'px'); }
}

requestAnimationFrame(frame);
