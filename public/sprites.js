'use strict';
/**
 * Піксельні спрайти відеокарт, намальовані в canvas із текстових масок.
 * Власні оригінальні ілюстрації; зовнішніх ресурсів немає.
 * Символи: . порожньо, # корпус, o контур, f вентилятор, h радіатор, c конектор, l світлодіод
 */
const CARD_MASK = [
  '................',
  '.oooooooooooooo.',
  '.o############o.',
  '.o#hhhhhhhhhh#o.',
  '.o#hffhhhhffh#o.',
  '.o#hffhhhhffh#o.',
  '.o#hhhhhhhhhh#o.',
  '.o###l######l#o.',
  '.oooooooooooooo.',
  '..cccccccccccc..',
  '................',
];

const MODEL_STYLE = {
  basic: { body: '#3a4a5c', edge: '#1b232e', heat: '#56697f', fan: '#8fa4b8', led: '#4ad0ff', conn: '#c9a227' },
  mid:   { body: '#2f5d46', edge: '#14261c', heat: '#47856a', fan: '#9be3bf', led: '#7dff9a', conn: '#c9a227' },
  pro:   { body: '#6a3b78', edge: '#25122c', heat: '#8f56a1', fan: '#f0b8ff', led: '#ffd04a', conn: '#e8c24a' },
};

function drawCard(ctx, model, px, ox, oy, frame, active) {
  const st = MODEL_STYLE[model];
  for (let y = 0; y < CARD_MASK.length; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = CARD_MASK[y][x];
      if (ch === '.') continue;
      let col;
      if (ch === 'o') col = st.edge;
      else if (ch === '#') col = st.body;
      else if (ch === 'h') col = st.heat;
      else if (ch === 'c') col = st.conn;
      else if (ch === 'l') col = active && frame % 2 === 0 ? st.led : st.edge;
      else if (ch === 'f') {
        // вентилятор «крутиться»: чергуємо два візерунки
        col = active && (x + y + frame) % 2 === 0 ? st.heat : st.fan;
      }
      ctx.fillStyle = col;
      ctx.fillRect(ox + x * px, oy + y * px, px, px);
    }
  }
}

/** Малює вміст клітинки ферми: фон, і карту (за наявності). */
function drawSlot(canvas, model, frame, active) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  if (!model) return;
  const px = Math.floor(size / 16);
  const ox = Math.floor((size - px * 16) / 2);
  const oy = Math.floor((size - px * CARD_MASK.length) / 2);
  drawCard(ctx, model, px, ox, oy, frame, active);
}

/** Окремий малюнок картки для магазину/інвентаря. */
function cardIcon(model, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.className = 'pix';
  drawSlot(c, model, 0, false);
  return c;
}
