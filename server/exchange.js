'use strict';
const path = require('path');
const C = require('./config');
const rateGen = require('./rate');
const { writeJsonAtomic, readJson } = require('./store');

/**
 * Біржа: єдине джерело курсу CRYP. Клієнт курс не створює й не визначає.
 *  - тік кожні 5 с,
 *  - історія: «сирі» точки за останню годину + хвилинні агрегати до 25 год,
 *  - стан і історія переживають перезапуск сервера.
 */
class Exchange {
  constructor(dir, { rng = Math.random, now = Date.now } = {}) {
    this.file = path.join(dir, 'rate.json');
    this.rng = rng;
    this.now = now;
    this.listeners = new Set();
    this.timer = null;

    const saved = readJson(this.file, null);
    if (saved && saved.gen) {
      this.gen = saved.gen;
      this.raw = saved.raw || [];
      this.agg = saved.agg || [];
      this.ts = saved.ts || this.now();
    } else {
      this.gen = rateGen.newState();
      this.raw = [];
      this.agg = [];
      this.ts = this.now();
      this._push(this.ts, this.gen.rate);
    }
    this.prev = this.gen.rate;
  }

  current() {
    return { rate: this.gen.rate, ts: this.ts, prev: this.prev };
  }

  onTick(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _push(t, rate) {
    this.raw.push([t, rate]);
    this._compact(t);
  }

  _compact(now) {
    const cutoff = now - C.RATE_HISTORY_RAW_MS;
    let lastMinute = this.agg.length ? Math.floor(this.agg[this.agg.length - 1][0] / 60000) : -1;
    while (this.raw.length && this.raw[0][0] < cutoff) {
      const [t, r] = this.raw.shift();
      const minute = Math.floor(t / 60000);
      if (minute > lastMinute) {
        this.agg.push([minute * 60000, r]);
        lastMinute = minute;
      }
    }
    const keepFrom = now - C.RATE_HISTORY_KEEP_MS;
    while (this.agg.length && this.agg[0][0] < keepFrom) this.agg.shift();
  }

  tick() {
    this.prev = this.gen.rate;
    const rate = rateGen.step(this.gen, this.rng);
    this.ts = this.now();
    this._push(this.ts, rate);
    const ev = this.current();
    for (const fn of this.listeners) {
      try { fn(ev); } catch (_) { /* слухач не повинен ламати біржу */ }
    }
    return ev;
  }

  /** range: '1h' | '24h' */
  history(range) {
    const now = this.now();
    if (range === '24h') {
      return this.agg.filter((p) => p[0] >= now - 24 * 3600 * 1000).concat(this.raw);
    }
    return this.raw.filter((p) => p[0] >= now - 3600 * 1000);
  }

  save() {
    writeJsonAtomic(this.file, { gen: this.gen, ts: this.ts, raw: this.raw, agg: this.agg });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), C.RATE_TICK_MS);
    this.saveTimer = setInterval(() => this.save(), 30_000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    this.timer = this.saveTimer = null;
    this.save();
  }
}

module.exports = { Exchange };
