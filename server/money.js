'use strict';
/**
 * Грошові розрахунки без плаваючої крапки.
 *  - гривня зберігається в копійках (ціле),
 *  - CRYP — у мікро-CRYP (ціле, 6 знаків після коми),
 *  - курс — у «1/10000 ₴» (ціле) всередині розрахунків.
 */

const RATE_SCALE = 10_000;

/** Курс (число) -> ціле в 1/10000. */
function rateToInt(rate) {
  return Math.round(rate * RATE_SCALE);
}

/** Ціле ділення з округленням до найближчого (половина вгору), лише для невід'ємних BigInt. */
function divRound(a, b) {
  return (a + b / 2n) / b;
}

/**
 * Вартість CRYP у копійках: micro * rate / 1e6 (CRYP) * 100 (коп).
 * = micro * rateInt / (1e6 * 1e4) * 100 = micro * rateInt / 1e8
 */
function crypToKop(micro, rate) {
  const v = divRound(BigInt(micro) * BigInt(rateToInt(rate)), 100_000_000n);
  return Number(v);
}

/** "12.345678" -> мікро-CRYP (Number) або null, якщо формат неправильний. */
function parseCryp(str) {
  if (typeof str === 'number') str = String(str);
  if (typeof str !== 'string') return null;
  const s = str.trim().replace(',', '.');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  const micro = Number(BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0')));
  return Number.isSafeInteger(micro) ? micro : null;
}

/** мікро-CRYP -> "12.345678" */
function formatCryp(micro) {
  const m = BigInt(micro);
  const i = m / 1_000_000n;
  const f = (m % 1_000_000n).toString().padStart(6, '0');
  return `${i}.${f}`;
}

/** Загальний капітал K = B + C × R (у копійках). */
function capitalKop(balanceKop, micro, rate) {
  return balanceKop + crypToKop(micro, rate);
}

module.exports = { RATE_SCALE, rateToInt, divRound, crypToKop, parseCryp, formatCryp, capitalKop };
