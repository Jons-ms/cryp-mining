'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');

test('HTTP: реєстрація → сесія → нікнейм → покупка → біржа → подіум → видалення', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryp-http-'));
  const app = createApp({ dataDir: dir });
  const srv = await app.start(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body, { token, sid, method = 'POST' } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(sid ? { 'X-Session': sid } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  try {
    assert.equal((await call('/api/shop/buy', { model: 'basic' })).status, 401);
    assert.equal((await call('/api/auth/register', { email: 'bad', password: 'password1' })).json.error, 'email_invalid');
    assert.equal((await call('/api/auth/register', { email: 'a@b.co', password: 'short' })).json.error, 'password_weak');

    const reg = await call('/api/auth/register', { email: 'a@b.co', password: 'password1' });
    assert.equal(reg.status, 200);
    const token = reg.json.token;
    assert.equal((await call('/api/auth/register', { email: 'A@b.co', password: 'password1' })).json.error, 'email_taken');
    assert.equal((await call('/api/auth/login', { email: 'a@b.co', password: 'wrong-pass' })).status, 401);

    const ses = await call('/api/session/start', {}, { token });
    const sid = ses.json.sessionId;
    assert.equal(ses.json.state.balance, 49_000);
    assert.equal((await call('/api/heartbeat', {}, { token, sid: 'nope' })).json.error, 'session_replaced');

    assert.equal((await call('/api/profile/nickname', { nickname: 'Tester' }, { token, sid })).status, 200);

    const buy = await call('/api/shop/buy', { model: 'basic', opId: 'o1' }, { token, sid });
    assert.equal(buy.json.state.balance, 24_000);

    // другу карту за 250 ₴ купити не можна (лишилось 240 ₴); підсунута клієнтом ціна ігнорується
    const denied = await call('/api/shop/buy', { model: 'basic', price: 1, opId: 'o2' }, { token, sid });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error, 'not_enough_money');

    const rate = await call('/api/rate', null, { method: 'GET' });
    assert.ok(rate.json.rate >= 0.25 && rate.json.rate <= 7);
    const hist = await call('/api/rate/history?range=1h', null, { method: 'GET' });
    assert.ok(Array.isArray(hist.json.points) && hist.json.points.length >= 1);
    const pod = await call('/api/podium', null, { method: 'GET', token });
    assert.equal(pod.status, 200);
    assert.equal(pod.json.top10.length, 1);

    // профіль і вихід
    const me = pod.json.me;
    assert.equal(me.nickname, 'Tester');
    const prof = await call(`/api/profile/${me.playerId}`, null, { method: 'GET' });
    assert.equal(prof.status, 200);
    assert.equal(prof.json.email, undefined);
    assert.equal((await call('/api/account/delete', { password: 'password1' }, { token })).status, 404);
    await call('/api/auth/logout', {}, { token });
    assert.equal((await call('/api/session/start', {}, { token })).status, 401);

    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/..%2fserver%2fconfig.js')).status, 403);
  } finally {
    await app.stop();
  }
});
