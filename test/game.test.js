'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../server/config');
const money = require('../server/money');
const rateGen = require('../server/rate');
const { Store } = require('../server/store');
const { Exchange } = require('../server/exchange');
const { Game, GameError } = require('../server/game');
const podium = require('../server/podium');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryp-'));
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const store = new Store(dir);
  const exchange = new Exchange(dir, { now });
  const game = new Game(store, exchange, now);
  const mk = (email = 'a@b.co') => {
    const p = game.createPlayer({ email, authMethod: 'password' });
    const { sessionId } = game.startSession(p.id);
    return { p, sid: sessionId };
  };
  return { game, store, exchange, mk, advance: (ms) => { clock += ms; }, now };
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof GameError && e.code === code, `очікувалась помилка ${code}`);

test('money: parse/format/convert без плаваючої крапки', () => {
  assert.equal(money.parseCryp('1.5'), 1_500_000);
  assert.equal(money.parseCryp('0,000001'), 1);
  assert.equal(money.parseCryp('0.0000001'), null);
  assert.equal(money.parseCryp('-1'), null);
  assert.equal(money.parseCryp('abc'), null);
  assert.equal(money.formatCryp(1_234_567), '1.234567');
  assert.equal(money.crypToKop(1_000_000, 1.2345), 123); // 1 CRYP × 1.2345 = 1.2345 ₴ -> 123 коп (123.45 -> 123)
  assert.equal(money.crypToKop(1_000_000, 1.2355), 124); // 123.55 -> 124 (до найближчої)
});

test('rate: завжди в межах діапазону, 4 знаки', () => {
  const st = rateGen.newState();
  let r;
  for (let i = 0; i < 200_000; i++) {
    r = rateGen.step(st);
    assert.ok(r >= C.RATE_MIN && r <= C.RATE_MAX, `поза діапазоном: ${r}`);
    assert.equal(r, Math.round(r * 10_000) / 10_000);
  }
});

test('rate: за довгий час відвідує і низькі, і високі значення', () => {
  const st = rateGen.newState();
  let lo = Infinity, hi = 0;
  for (let i = 0; i < 400_000; i++) {
    const r = rateGen.step(st);
    lo = Math.min(lo, r); hi = Math.max(hi, r);
  }
  assert.ok(lo < 0.6, `мінімум ${lo}`);
  assert.ok(hi > 3, `максимум ${hi}`);
});

test('новий гравець: 490 ₴, порожня ферма 4×4, нуль CRYP', () => {
  const { mk, game } = setup();
  const { p } = mk();
  const s = game.state(p);
  assert.equal(s.balance, 49_000);
  assert.equal(s.cryp, 0);
  assert.equal(s.farm.length, 16);
  assert.equal(s.installed, 0);
});

test('покупка: списання ціни та додавання в інвентар', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic' });
  assert.equal(p.balance, 49_000 - 25_000);
  assert.equal(p.inventory.basic, 1);
});

test('покупка: баланс ніколи не стає від’ємним', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic' });      // 240 ₴ лишилось
  throwsCode(() => game.buy(p.id, sid, { model: 'basic' }), 'not_enough_money');
  throwsCode(() => game.buy(p.id, sid, { model: 'pro' }), 'not_enough_money');
  assert.equal(p.balance, 24_000);
  assert.equal(p.inventory.basic, 1);
});

test('дедуплікація opId: повторний запит не купує вдруге', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic', opId: 'x1' });
  const r = game.buy(p.id, sid, { model: 'basic', opId: 'x1' });
  assert.equal(r.duplicate, true);
  assert.equal(p.inventory.basic, 1);
});

test('майнінг: перерва ≤ 60 с зараховується повністю, > 60 с — нічого', () => {
  const { mk, game, advance } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic' });
  game.install(p.id, sid, { model: 'basic', slot: 0 });
  game.setMining(p.id, sid, true);
  const base = p.cryp;
  advance(10_000);
  game.heartbeat(p.id, sid);
  assert.equal(p.cryp - base, 833_333);               // 10 с × 5 CRYP/хв = 0.833333 CRYP
  advance(60_000);
  game.heartbeat(p.id, sid);
  assert.equal(p.cryp - base, 833_333 + 5_000_000);   // рівно 60 с = 5 CRYP — зараховано
  advance(61_000);
  game.heartbeat(p.id, sid);
  assert.equal(p.cryp - base, 833_333 + 5_000_000);   // 61 с — не зараховано
});

test('майнінг: без запуску або без карт нічого не нараховується', () => {
  const { mk, game, advance } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic' });
  game.install(p.id, sid, { model: 'basic', slot: 3 });
  advance(30_000); game.heartbeat(p.id, sid);
  assert.equal(p.cryp, 0);
  throwsCode(() => {
    game.uninstall(p.id, sid, { slot: 3 });
    game.setMining(p.id, sid, true);
  }, 'no_cards_installed');
});

test('одна сесія: стара сесія отримує session_replaced', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  const second = game.startSession(p.id);
  throwsCode(() => game.heartbeat(p.id, sid), 'session_replaced');
  assert.doesNotThrow(() => game.heartbeat(p.id, second.sessionId));
});

test('ферма: встановлення, заміна, переміщення зі swap, зняття', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  p.balance += 100_000; // тестові гроші: дві карти коштують більше за стартові 490 ₴
  game.buy(p.id, sid, { model: 'basic' });
  game.buy(p.id, sid, { model: 'basic' });
  game.install(p.id, sid, { model: 'basic', slot: 0 });
  game.install(p.id, sid, { model: 'basic', slot: 5 });
  throwsCode(() => game.install(p.id, sid, { model: 'basic', slot: 0 }), 'not_in_inventory');
  game.move(p.id, sid, { from: 0, to: 1 });
  assert.equal(p.farm[0], null); assert.equal(p.farm[1], 'basic');
  game.uninstall(p.id, sid, { slot: 1 });
  assert.equal(p.inventory.basic, 1);
  throwsCode(() => game.move(p.id, sid, { from: 0, to: 99 }), 'bad_slot');
});

test('заміна карти повертає стару в інвентар', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  game.buy(p.id, sid, { model: 'basic' });
  game.install(p.id, sid, { model: 'basic', slot: 0 });
  p.balance += 300_000; // тестові гроші: середня карта коштує 2500 ₴
  game.buy(p.id, sid, { model: 'mid' });
  throwsCode(() => game.install(p.id, sid, { model: 'mid', slot: 0 }), 'slot_occupied');
  game.install(p.id, sid, { model: 'mid', slot: 0, replace: true });
  assert.equal(p.farm[0], 'mid');
  assert.equal(p.inventory.basic, 1);
});

test('продаж карти = 50%, останню карту продати не можна', () => {
  const { mk, game } = setup();
  const { p, sid } = mk();
  p.balance += 100_000;
  game.buy(p.id, sid, { model: 'basic' });
  throwsCode(() => game.sellCard(p.id, sid, { source: 'inventory', model: 'basic' }), 'last_card');
  game.buy(p.id, sid, { model: 'basic' });
  const before = p.balance;
  game.sellCard(p.id, sid, { source: 'inventory', model: 'basic' });
  assert.equal(p.balance - before, 12_500);
  assert.equal(game.totalCards(p), 1);
});

test('біржа: продаж за серверним курсом, відмови без змін', () => {
  const { mk, game, exchange } = setup();
  const { p, sid } = mk();
  exchange.gen.rate = 2; // курс 2 ₴
  p.cryp = 3_500_000;
  const b = p.balance;
  const out = game.sellCryp(p.id, sid, { amount: '1.25' });
  assert.equal(out.sale.kop, 250);
  assert.equal(p.balance - b, 250);
  assert.equal(p.cryp, 2_250_000);
  throwsCode(() => game.sellCryp(p.id, sid, { amount: '999' }), 'not_enough_cryp');
  throwsCode(() => game.sellCryp(p.id, sid, { amount: '0' }), 'amount_too_small');
  throwsCode(() => game.sellCryp(p.id, sid, { amount: '1.1234567' }), 'bad_amount');
  throwsCode(() => game.sellCryp(p.id, sid, { amount: '-5' }), 'bad_amount');
  game.sellCryp(p.id, sid, { all: true });
  assert.equal(p.cryp, 0);
});

test('біржа: продаж, що дає 0 копійок, відхиляється і CRYP не списується', () => {
  const { mk, game, exchange } = setup();
  const { p, sid } = mk();
  exchange.gen.rate = 0.25;
  p.cryp = 100;
  throwsCode(() => game.sellCryp(p.id, sid, { amount: '0.0001' }), 'sale_worth_nothing');
  assert.equal(p.cryp, 100);
});

test('нікнейм: формат, чорний список, унікальність без урахування регістру, 7 днів', () => {
  const { mk, game, advance } = setup();
  const a = mk('a@a.co'); const b = mk('b@b.co');
  throwsCode(() => game.setNickname(a.p.id, a.sid, 'ab'), 'nick_invalid');
  throwsCode(() => game.setNickname(a.p.id, a.sid, 'bad name'), 'nick_invalid');
  throwsCode(() => game.setNickname(a.p.id, a.sid, 'SuperAdmin'), 'nick_forbidden');
  game.setNickname(a.p.id, a.sid, 'Miner_1');
  throwsCode(() => game.setNickname(b.p.id, b.sid, 'miner_1'), 'nick_taken');
  game.setNickname(a.p.id, a.sid, 'Miner_2');                       // перша зміна після встановлення
  throwsCode(() => game.setNickname(a.p.id, a.sid, 'Miner_3'), 'nick_cooldown');
  advance(7 * 24 * 3600 * 1000 + 1);
  game.heartbeat(a.p.id, a.sid);
  game.setNickname(a.p.id, a.sid, 'Miner_3');
  game.setNickname(b.p.id, b.sid, 'Miner_2');                       // старий нікнейм звільнився
});

test('затверджені моделі: ціни та віддача', () => {
  assert.deepEqual(
    Object.values(C.MODELS).map((m) => [m.priceKop / 100, m.power / 1e6]),
    [[250, 5], [2500, 12], [4500, 18]],
  );
});

test('подіум наживо: K = ₴ + CRYP×R, лише гравці з нікнеймом, перерахунок після змін', () => {
  const { mk, game, store, exchange } = setup();
  const a = mk('a@a.co'); const b = mk('b@b.co'); const c = mk('c@c.co'); mk('d@d.co');
  game.setNickname(a.p.id, a.sid, 'Alpha');
  game.setNickname(b.p.id, b.sid, 'Bravo');
  game.setNickname(c.p.id, c.sid, 'Charlie');
  exchange.gen.rate = 2;
  b.p.cryp = 2_000_000;      // +4 ₴
  c.p.balance = 60_000;      // 600 ₴
  podium.invalidate();
  let v = podium.view(store.db, 2, 1, a.p.id);
  assert.equal(v.count, 3);                                   // гравець без нікнейма не враховується
  assert.deepEqual(v.top10.map((x) => x.nickname), ['Charlie', 'Bravo', 'Alpha']);
  assert.equal(v.top10[1].capitalKop, 49_000 + 400);
  assert.equal(v.me.rank, 3);

  // дія гравця одразу змінює рейтинг: Alpha продає CRYP зі зміненого балансу
  a.p.cryp = 100_000_000; // 100 CRYP
  game.sellCryp(a.p.id, a.sid, { all: true });                // за поточним серверним курсом 2 ₴ -> +200 ₴
  v = podium.view(store.db, 2, 1, a.p.id);
  assert.equal(v.me.rank, 1);
  assert.equal(v.me.capitalKop, 49_000 + 20_000);

  // новий тік курсу перераховує капітал тих, хто тримає CRYP
  v = podium.view(store.db, 7, 2, b.p.id);
  assert.equal(v.me.capitalKop, 49_000 + 1_400);
});

test('профіль гравця: затверджений склад даних, без email', () => {
  const { mk, game } = setup();
  const a = mk('a@a.co');
  game.setNickname(a.p.id, a.sid, 'Alpha');
  game.buy(a.p.id, a.sid, { model: 'basic' });
  game.install(a.p.id, a.sid, { model: 'basic', slot: 2 });
  const pr = game.publicProfile(a.p.id);
  assert.equal(pr.nickname, 'Alpha');
  assert.equal(pr.installed, 1);
  assert.equal(pr.power, 5_000_000);
  assert.equal(pr.balanceKop, 24_000);
  assert.equal('email' in pr, false);
  assert.equal(pr.farm[2], 'basic');
});

test('біржа: історія переживає перезапуск', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryp-ex-'));
  const e1 = new Exchange(dir);
  for (let i = 0; i < 10; i++) e1.tick();
  const r = e1.current().rate;
  e1.save();
  const e2 = new Exchange(dir);
  assert.equal(e2.current().rate, r);
  assert.ok(e2.history('1h').length >= 10);
});
