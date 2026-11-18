// 입력: 폰은 화면 아무 곳이나 눌러서 끌면 조이스틱, PC는 WASD/방향키 + 스페이스(먹기)
export function createInput(canvas, eatButton) {
  const keys = new Set();
  const stick = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
  let eatQueued = false;
  const RADIUS = 55;

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Space') { eatQueued = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('pointerdown', (e) => {
    if (stick.active) return;
    stick.active = true; stick.id = e.pointerId;
    stick.ox = e.clientX; stick.oy = e.clientY;
    stick.x = 0; stick.y = 0;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stick.active || e.pointerId !== stick.id) return;
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      // 손가락이 멀리 가면 조이스틱 중심이 따라온다
      stick.ox += (dx / d) * (d - RADIUS);
      stick.oy += (dy / d) * (d - RADIUS);
      dx = e.clientX - stick.ox; dy = e.clientY - stick.oy;
    }
    stick.x = dx / RADIUS; stick.y = dy / RADIUS;
  });
  const end = (e) => {
    if (e.pointerId !== stick.id) return;
    stick.active = false; stick.x = 0; stick.y = 0;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  eatButton.addEventListener('pointerdown', (e) => { eatQueued = true; e.preventDefault(); });

  return {
    stick, RADIUS,
    read() {
      let x = 0, y = 0;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
      if (stick.active) { x += stick.x; y += stick.y; }
      const eat = eatQueued;
      eatQueued = false;
      return { x, y, eat };
    },
  };
}
