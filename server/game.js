'use strict';
const crypto = require('crypto');
const C = require('./config');
const money = require('./money');
const podium = require('./podium');

class GameError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const MODEL_IDS = Object.keys(C.MODELS);

function isSlot(n) {
  return Number.isInteger(n) && n >= 0 && n < C.FARM_SIZE;
}

function newPlayerId(db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let id = 'P-';
    for (const b of bytes) id += alphabet[b % alphabet.length];
    if (!db.players[id]) return id;
  }
}

/**
 * Уся ігрова логіка. Кожен публічний метод:
 *  1) перевіряє сесію,
 *  2) нараховує майнінг до поточного моменту,
 *  3) валідує вхід ДО будь-якої зміни,
 *  4) змінює стан синхронно (атомарно, бо Node виконує код в одному потоці).
 */
class Game {
  constructor(store, exchange, now = Date.now) {
    this.store = store;
    this.exchange = exchange;
    this.now = now;
  }

  // ---------- гравці ----------
  createPlayer({ email, authMethod }) {
    const db = this.store.db;
    const now = this.now();
    const id = newPlayerId(db);
    db.players[id] = {
      id,
      email,
      authMethod,
      emailVerified: false,
      createdAt: now,
      nickname: null,
      nicknameChangedAt: 0,
      balance: C.START_BALANCE_KOP,
      cryp: 0,
      inventory: Object.fromEntries(MODEL_IDS.map((m) => [m, 0])),
      farm: new Array(C.FARM_SIZE).fill(null),
      mining: false,
      lastAccrualAt: now,
      lastSeenAt: now,
      sessionId: null,
      opIds: [],
    };
    this.store.markDirty();
    return db.players[id];
  }

  getPlayer(id) {
    const p = this.store.db.players[id];
    if (!p) throw new GameError('unauthorized', 401);
    return p;
  }

  installedCount(p) {
    return p.farm.reduce((n, m) => n + (m ? 1 : 0), 0);
  }

  totalCards(p) {
    return this.installedCount(p) + MODEL_IDS.reduce((n, m) => n + p.inventory[m], 0);
  }

  power(p) {
    return p.farm.reduce((sum, m) => sum + (m ? C.MODELS[m].power : 0), 0);
  }

  // ---------- майнінг ----------
  /**
   * Правило 60 секунд (серверний час). Якщо з останнього контакту минуло
   * ≤ 60 с — зараховується весь період; якщо більше — нічого за час
   * відсутності (офлайн-майнінгу немає). Годинник клієнта не використовується.
   */
  accrue(p, now) {
    const gap = now - p.lastAccrualAt;
    if (gap > 0 && p.mining && gap <= C.MAX_GAP_MS) {
      const power = this.power(p);
      if (power > 0) p.cryp += Math.floor((power * gap) / 60_000); // power — мікро-CRYP за хвилину
    }
    p.lastAccrualAt = now;
    p.lastSeenAt = now;
  }

  // ---------- сесія (одна активна на акаунт) ----------
  startSession(playerId) {
    const p = this.getPlayer(playerId);
    const now = this.now();
    p.sessionId = crypto.randomBytes(16).toString('hex');
    p.lastAccrualAt = now; // час відсутності не зараховується
    p.lastSeenAt = now;
    this.store.markDirty();
    return { sessionId: p.sessionId, state: this.state(p) };
  }

  _session(playerId, sessionId) {
    const p = this.getPlayer(playerId);
    if (!sessionId || sessionId !== p.sessionId) throw new GameError('session_replaced', 409);
    return p;
  }

  /** Обгортка для кожної дії: сесія → нарахування → дедуплікація → дія → стан. */
  _act(playerId, sessionId, opId, fn) {
    const p = this._session(playerId, sessionId);
    if (opId !== undefined && (typeof opId !== 'string' || opId.length > 64)) {
      throw new GameError('bad_request');
    }
    this.accrue(p, this.now());
    if (opId && p.opIds.includes(opId)) {
      return { state: this.state(p), duplicate: true };
    }
    const extra = fn(p) || {};
    podium.invalidate(); // баланс змінився — рейтинг перерахується на наступний запит
    if (opId) {
      p.opIds.push(opId);
      if (p.opIds.length > 100) p.opIds.shift();
    }
    this.store.markDirty();
    return { state: this.state(p), ...extra };
  }

  state(p) {
    const installed = this.installedCount(p);
    return {
      playerId: p.id,
      nickname: p.nickname,
      nicknameNextChangeAt: p.nicknameChangedAt ? p.nicknameChangedAt + C.NICK_COOLDOWN_MS : 0,
      balance: p.balance,
      cryp: p.cryp,
      inventory: p.inventory,
      farm: p.farm,
      installed,
      mining: p.mining,
      miningActive: p.mining && installed > 0,
      power: this.power(p),
      serverTime: this.now(),
      rate: this.exchange.current().rate,
      email: p.email,
      authMethod: p.authMethod,
      emailVerified: p.emailVerified,
      createdAt: p.createdAt,
    };
  }

  heartbeat(playerId, sessionId) {
    return this._act(playerId, sessionId, undefined, () => {});
  }

  setMining(playerId, sessionId, enabled) {
    if (typeof enabled !== 'boolean') throw new GameError('bad_request');
    return this._act(playerId, sessionId, undefined, (p) => {
      if (enabled && this.installedCount(p) === 0) throw new GameError('no_cards_installed');
      p.mining = enabled;
    });
  }

  // ---------- магазин / інвентар ----------
  buy(playerId, sessionId, { model, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      const m = C.MODELS[model];
      if (!m) throw new GameError('bad_model');
      if (p.balance < m.priceKop) throw new GameError('not_enough_money');
      p.balance -= m.priceKop;
      p.inventory[m.id] += 1;
    });
  }

  /** Продаж відеокарти з ферми (slot) або з інвентаря (model) за 50% початкової вартості. */
  sellCard(playerId, sessionId, { source, model, slot, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      let id;
      if (source === 'farm') {
        if (!isSlot(slot)) throw new GameError('bad_slot');
        id = p.farm[slot];
        if (!id) throw new GameError('slot_empty');
      } else if (source === 'inventory') {
        if (!C.MODELS[model]) throw new GameError('bad_model');
        id = model;
        if (p.inventory[id] < 1) throw new GameError('not_in_inventory');
      } else {
        throw new GameError('bad_request');
      }
      if (this.totalCards(p) <= 1) throw new GameError('last_card');
      const gain = Math.floor((C.MODELS[id].priceKop * C.SELL_RATIO_PERCENT) / 100);
      if (source === 'farm') p.farm[slot] = null;
      else p.inventory[id] -= 1;
      p.balance += gain;
      return { gainedKop: gain };
    });
  }

  /** Встановлення з інвентаря. replace=true — заміна карти в зайнятій клітинці (покращення). */
  install(playerId, sessionId, { model, slot, replace, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      if (!C.MODELS[model]) throw new GameError('bad_model');
      if (!isSlot(slot)) throw new GameError('bad_slot');
      if (p.inventory[model] < 1) throw new GameError('not_in_inventory');
      const old = p.farm[slot];
      if (old) {
        if (replace !== true) throw new GameError('slot_occupied');
        if (old === model) throw new GameError('same_model');
        p.inventory[old] += 1; // слабша карта повертається в інвентар
      }
      p.inventory[model] -= 1;
      p.farm[slot] = model;
    });
  }

  uninstall(playerId, sessionId, { slot, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      if (!isSlot(slot)) throw new GameError('bad_slot');
      const id = p.farm[slot];
      if (!id) throw new GameError('slot_empty');
      p.farm[slot] = null;
      p.inventory[id] += 1;
    });
  }

  /** Переміщення в межах ферми; якщо цільова клітинка зайнята — карти міняються місцями. */
  move(playerId, sessionId, { from, to, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      if (!isSlot(from) || !isSlot(to) || from === to) throw new GameError('bad_slot');
      if (!p.farm[from]) throw new GameError('slot_empty');
      [p.farm[from], p.farm[to]] = [p.farm[to], p.farm[from]];
    });
  }

  // ---------- біржа ----------
  /**
   * Продаж CRYP за актуальним серверним курсом у момент підтвердження.
   * Без комісії; сума округлюється до найближчої копійки.
   */
  sellCryp(playerId, sessionId, { amount, all, opId }) {
    return this._act(playerId, sessionId, opId, (p) => {
      const micro = all === true ? p.cryp : money.parseCryp(amount);
      if (micro === null) throw new GameError('bad_amount');
      if (micro < C.MIN_SELL_MICRO) throw new GameError('amount_too_small');
      if (micro > p.cryp) throw new GameError('not_enough_cryp');
      const { rate } = this.exchange.current();
      const kop = money.crypToKop(micro, rate);
      if (kop < 1) throw new GameError('sale_worth_nothing'); // не «спалюємо» CRYP за 0 копійок
      p.cryp -= micro;
      p.balance += kop;
      return { sale: { micro, kop, rate } };
    });
  }

  // ---------- профіль ----------
  setNickname(playerId, sessionId, nickname) {
    return this._act(playerId, sessionId, undefined, (p) => {
      if (typeof nickname !== 'string' || !C.NICK_REGEX.test(nickname)) throw new GameError('nick_invalid');
      const lower = nickname.toLowerCase();
      if (C.NICK_BLOCKLIST.some((w) => lower.includes(w))) throw new GameError('nick_forbidden');
      const db = this.store.db;
      const owner = db.nicknames[lower];
      if (owner && owner !== p.id) throw new GameError('nick_taken', 409);
      const now = this.now();
      if (p.nickname && now < p.nicknameChangedAt + C.NICK_COOLDOWN_MS) {
        throw new GameError('nick_cooldown', 429);
      }
      if (p.nickname) delete db.nicknames[p.nickname.toLowerCase()];
      db.nicknames[lower] = p.id;
      const isFirst = !p.nickname;
      p.nickname = nickname;
      if (!isFirst) p.nicknameChangedAt = now; // перше налаштування не запускає 7-денний ліміт
    });
  }

  /**
   * Профіль гравця (затверджений склад): загальний капітал, ₴, CRYP, встановлені карти,
   * потужність ферми. Без email та без права змінювати чужі дані. Значення «наживо».
   */
  publicProfile(playerId) {
    const p = this.store.db.players[playerId];
    if (!p || !p.nickname) throw new GameError('not_found', 404);
    const { rate, ts } = this.exchange.current();
    return {
      playerId: p.id,
      nickname: p.nickname,
      rank: podium.rankOf(this.store.db, rate, ts, p.id),
      capitalKop: money.capitalKop(p.balance, p.cryp, rate),
      balanceKop: p.balance,
      cryp: p.cryp,
      installed: this.installedCount(p),
      power: this.power(p),
      farm: p.farm,
    };
  }
}

module.exports = { Game, GameError, MODEL_IDS };
