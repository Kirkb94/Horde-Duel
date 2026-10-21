'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateMsg } = require('../validate');
const { startServer, connect } = require('./helpers');

const ok = m => validateMsg(m).ok;

test('rejects non-objects and unknown types', () => {
  assert.ok(!ok(null)); assert.ok(!ok([])); assert.ok(!ok({})); assert.ok(!ok({ t: 5 })); assert.ok(!ok({ t: 'nope' }));
});

test('lobby field types and lengths', () => {
  assert.ok(ok({ t: 'create', name: 'Bob', weapon: 'rifle' }));
  assert.ok(!ok({ t: 'create', name: 'x'.repeat(65) }));
  assert.ok(!ok({ t: 'create', name: { a: 1 } }));
  assert.ok(!ok({ t: 'join' }));
  assert.ok(!ok({ t: 'join', code: 'ABCDEFGHIJKLMNOPQ' }));
  assert.ok(!ok({ t: 'rejoin', code: 'ABCD', token: 5 }));
  assert.ok(!ok({ t: 'cfg', size: Infinity }));
  assert.ok(!ok({ t: 'cfg', size: '8' }));
  assert.ok(!ok({ t: 'cfg', mods: 'x' }));
  assert.ok(!ok({ t: 'upd', team: 2 }));
  assert.ok(ok({ t: 'cfg', mode: 'duel', size: 2, mods: ['a'] }));
});

test('msgClass buckets messages for rate limiting', () => {
  const { msgClass } = require('../validate');
  assert.strictEqual(msgClass({ t: 'r', d: { k: 'i' } }), 'input');
  assert.strictEqual(msgClass({ t: 'r', d: { k: 'ready' } }), 'ready');
  assert.strictEqual(msgClass({ t: 'r', d: { k: 's' } }), 'host');
  assert.strictEqual(msgClass({ t: 'ping' }), 'ping');
  assert.strictEqual(msgClass({ t: 'join' }), 'join');
  assert.strictEqual(msgClass({ t: 'upd' }), 'lobby');
});

test('ping ts is sanitised', () => {
  assert.strictEqual(validateMsg({ t: 'ping', ts: 'abc' }).msg.ts, 0);
  assert.strictEqual(validateMsg({ t: 'ping', ts: 12 }).msg.ts, 12);
});

test('relay and input payloads', () => {
  assert.ok(ok({ t: 'r', to: 0, d: { k: 'i', mx: 1, my: -1, f: 3.1, fr: 1, a: [['a', 10, 20]], sv: 3, q: 7 } }));
  assert.ok(ok({ t: 'r', d: { k: 'i', mx: null, my: 0, f: null } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', mx: 'abc' } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', mx: Infinity } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', mx: 50 } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', a: 'x' } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', a: new Array(13).fill(['a']) } }));
  assert.ok(!ok({ t: 'r', d: { k: 'i', a: [['a', {}]] } }));
  assert.ok(!ok({ t: 'r', d: { k: 'bogus' } }));
  assert.ok(!ok({ t: 'r', d: [] }));
  assert.ok(!ok({ t: 'r', to: 1.5, d: { k: 's' } }));
  assert.ok(!ok({ t: 'r', to: 'x', d: { k: 's' } }));
  assert.ok(ok({ t: 'r', to: '*', d: { k: 's' } }));
  assert.ok(ok({ t: 'r', d: { k: 'ready', picks: [['a', 1]] } }));
  assert.ok(!ok({ t: 'r', d: { k: 'ready', picks: 'x' } }));
});

test('live server survives garbage and still serves valid messages', async () => {
  const srv = await startServer();
  try {
    const c = await connect(srv);
    c.send({ t: 'create', name: 'Tester' });
    await c.waitFor('joined');
    c.send({ t: 'cfg', mode: 5 });
    const e = await c.waitFor('err');
    assert.match(e.msg, /Invalid game mode/);
    c.ws.send('{ not json');
    c.send({ t: 'r', d: { k: 'i', mx: 'abc', f: 'x' } });
    c.send({ t: 'r', to: {}, d: null });
    c.send({ t: 'ping', ts: 42 });
    const pong = await c.waitFor('pong');
    assert.ok(pong);
    await c.close();
  } finally { await srv.stop(); }
});
