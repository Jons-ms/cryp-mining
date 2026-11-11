'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const C = require('./config');
const { GameError } = require('./game');

const scrypt = promisify(crypto.scrypt);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * ЛОКАЛЬНА авторизація (email + пароль) для розробки та першої версії.
 *
 * Це заглушка під Firebase Authentication з тим самим інтерфейсом:
 *   register / login -> token,  verifyToken(token) -> playerId.
 * Для переходу на Firebase замініть verifyToken на firebase-admin
 * `verifyIdToken` і зіставляйте uid -> playerId. Ігрова логіка не зміниться.
 * Не реалізовано тут (робиться на боці Firebase): Google-вхід, підтвердження
 * email, відновлення пароля, об'єднання способів входу.
 */
class Auth {
  constructor(store, game) {
    this.store = store;
    this.game = game;
    this._sweep();
  }

  _sweep() {
    const now = Date.now();
    const s = this.store.db.sessions;
    for (const k of Object.keys(s)) if (s[k].exp < now) delete s[k];
  }

  async _hash(password, salt) {
    return (await scrypt(password, salt, 64)).toString('hex');
  }

  _issue(playerId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.store.db.sessions[sha256(token)] = { playerId, exp: Date.now() + C.SESSION_TTL_MS };
    this.store.markDirty();
    return token;
  }

  _validate(email, password) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw new GameError('email_invalid');
    if (typeof password !== 'string' || password.length < C.PASSWORD_MIN || password.length > 128) {
      throw new GameError('password_weak');
    }
    return email.trim().toLowerCase();
  }

  async register(email, password) {
    const key = this._validate(email, password);
    if (this.store.db.accounts[key]) throw new GameError('email_taken', 409);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await this._hash(password, salt);
    if (this.store.db.accounts[key]) throw new GameError('email_taken', 409); // гонка під час await
    const p = this.game.createPlayer({ email: key, authMethod: 'password' });
    this.store.db.accounts[key] = { playerId: p.id, salt, hash };
    return { token: this._issue(p.id) };
  }

  async login(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string') throw new GameError('bad_request');
    const key = email.trim().toLowerCase();
    const acc = this.store.db.accounts[key];
    const salt = acc ? acc.salt : '00'.repeat(16);
    const hash = await this._hash(password, salt); // однаковий час для існуючого/неіснуючого email
    if (!acc || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(acc.hash, 'hex'))) {
      throw new GameError('bad_credentials', 401);
    }
    return { token: this._issue(acc.playerId) };
  }

  verifyToken(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const row = this.store.db.sessions[sha256(token)];
    if (!row) return null;
    if (row.exp < Date.now()) {
      delete this.store.db.sessions[sha256(token)];
      return null;
    }
    return this.store.db.players[row.playerId] ? row.playerId : null;
  }

  logout(token) {
    delete this.store.db.sessions[sha256(token)];
    this.store.markDirty();
  }
}

module.exports = { Auth };
