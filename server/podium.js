'use strict';
const C = require('./config');
const money = require('./money');

/**
 * Подіум у реальному часі: загальний капітал K = ₴ + CRYP × поточний курс.
 * Обладнання в капітал не входить. Результат кешується на один тік курсу (5 с),
 * тому багато запитів не навантажують сервер.
 *
 * Рівність капіталу в документі не визначена: тимчасово вище гравець з меншим Player ID
 * (стабільно, без випадковості). Потребує рішення власника.
 */
let cache = { key: null, rows: null, byId: null };

function ranking(db, rate, rateTs) {
  // кеш діє до наступного тіку курсу або до будь-якої ігрової дії (invalidate)
  if (cache.key === rateTs) return cache;
  const rows = [];
  for (const p of Object.values(db.players)) {
    if (!p.nickname) continue; // без нікнейма гравець не відображається
    rows.push({ p, k: money.capitalKop(p.balance, p.cryp, rate) });
  }
  rows.sort((a, b) => b.k - a.k || (a.p.id < b.p.id ? -1 : 1));
  const byId = {};
  rows.forEach((r, i) => { r.rank = i + 1; byId[r.p.id] = r; });
  cache = { key: rateTs, rows, byId };
  return cache;
}

function rowView(r) {
  return { rank: r.rank, playerId: r.p.id, nickname: r.p.nickname, balanceKop: r.p.balance, capitalKop: r.k };
}

function view(db, rate, rateTs, playerId) {
  const { rows, byId } = ranking(db, rate, rateTs);
  const me = playerId && byId[playerId] ? rowView(byId[playerId]) : null;
  return { rate, count: rows.length, top10: rows.slice(0, C.PODIUM_TOP).map(rowView), me };
}

function rankOf(db, rate, rateTs, playerId) {
  const { byId } = ranking(db, rate, rateTs);
  return byId[playerId] ? byId[playerId].rank : null;
}

/** Скидає кеш (викликається після будь-якої зміни балансів). */
function invalidate() { cache = { key: null, rows: null, byId: null }; }

module.exports = { view, rankOf, invalidate };
