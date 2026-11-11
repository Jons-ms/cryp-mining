'use strict';
/**
 * Усі ігрові константи в одному місці.
 * Значення, позначені [ПІДТВЕРДИТИ], в документі вимог не задані й є рекомендованими.
 */
module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),

  // --- Економіка (документ: розд. 1) ---
  START_BALANCE_KOP: 490_00,          // 490 ₴, одноразово
  FARM_SIZE: 16,                      // ферма 4×4
  FARM_COLS: 4,
  SELL_RATIO_PERCENT: 50,             // продаж карти = 50% початкової вартості

  // Три моделі відеокарт — ціни та віддача ЗАТВЕРДЖЕНІ: 250 ₴ = 5 CRYP/хв, 2500 ₴ = 12, 4500 ₴ = 18.
  // power — мікро-CRYP за хвилину (1 CRYP = 1 000 000 мікро-CRYP).
  // Назви моделей у документі не задані: PX-100/300/900 — робочі, для підтвердження.
  MODELS: {
    basic: { id: 'basic', name: 'PX-100', priceKop: 250_00,  power: 5_000_000 },
    mid:   { id: 'mid',   name: 'PX-300', priceKop: 2500_00, power: 12_000_000 },
    pro:   { id: 'pro',   name: 'PX-900', priceKop: 4500_00, power: 18_000_000 },
  },

  // --- Біржа (розд. 2) ---
  RATE_TICK_MS: 5000,
  RATE_START: 1.0,
  RATE_MIN: 0.25,
  RATE_MAX: 7.0,
  RATE_HISTORY_RAW_MS: 60 * 60 * 1000,        // «сире» вікно = 1 година (графік)
  RATE_HISTORY_KEEP_MS: 25 * 60 * 60 * 1000,  // зберігаємо ≥ 24 год (з запасом)
  MIN_SELL_MICRO: 1,                          // 0,000001 CRYP

  // --- Майнінг (розд. 3) ---
  MAX_GAP_MS: 60_000,                 // перерва ≤ 60 с зараховується повністю
  HEARTBEAT_MS: 10_000,               // клієнт пінгує сервер

  // --- Гравці / акаунти ---
  NICK_REGEX: /^[A-Za-z0-9_-]{3,20}$/,
  NICK_COOLDOWN_MS: 7 * 24 * 60 * 60 * 1000,
  // Мінімальний чорний список (підрядки, нижній регістр). [ПІДТВЕРДИТИ] — потрібен повний список.
  NICK_BLOCKLIST: ['admin', 'moderator', 'support', 'fuck', 'shit', 'nazi', 'hitler', 'nigger', 'rape', 'cunt'],
  PASSWORD_MIN: 8,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,

  // --- Подіум (розд. 4) ---
  PODIUM_TOP: 10, // Подіум оновлюється в реальному часі (затверджено)
};
