'use strict';
const C = require('./config');

/**
 * Генератор курсу CRYP (виконується ТІЛЬКИ на сервері).
 *
 * Модель: курс рухається «трендами» — кілька хвилин поспіль в один бік з
 * кроком 1–3% за 5 секунд. Напрямок нового тренду залежить від положення в
 * діапазоні (на низькому курсі перевага зростання, на високому — падіння).
 * Біля меж тренд, що впирається в межу, завершується й змінює напрямок.
 */

const LN_MIN = Math.log(C.RATE_MIN);
const LN_MAX = Math.log(C.RATE_MAX);
const STEP_MIN = 0.01;
const STEP_MAX = 0.03;

function round4(x) {
  return Math.round(x * 10_000) / 10_000;
}

function newState(rate = C.RATE_START) {
  return { rate, dir: 1, left: 0 };
}

function startTrend(state, rng) {
  // p: положення курсу в діапазоні за логарифмічною шкалою, 0..1
  const p = (Math.log(state.rate) - LN_MIN) / (LN_MAX - LN_MIN);
  const pUp = Math.min(0.92, Math.max(0.08, 0.5 + (0.5 - p) * 0.8));
  state.dir = rng() < pUp ? 1 : -1;
  state.left = 24 + Math.floor(rng() * 96); // 24..119 кроків = 2..10 хвилин
}

/** Один крок (5 с). Змінює state, повертає новий курс. */
function step(state, rng = Math.random) {
  if (state.left <= 0) startTrend(state, rng);

  let dir = state.dir;
  let mag = STEP_MIN + rng() * (STEP_MAX - STEP_MIN);
  // дрібна «корекція проти тренду», щоб графік не був прямою лінією
  if (rng() < 0.15) {
    dir = -dir;
    mag = STEP_MIN + rng() * 0.005;
  }

  let next = state.rate * (1 + dir * mag);
  if (next >= C.RATE_MAX) {
    next = C.RATE_MAX;
    state.left = 0;
  } else if (next <= C.RATE_MIN) {
    next = C.RATE_MIN;
    state.left = 0;
  } else {
    state.left -= 1;
  }
  state.rate = round4(next);
  return state.rate;
}

module.exports = { newState, step, round4 };
