'use strict';
// Auth-mode (server-run match) reconnect logic: rejoin hold, hold expiry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, until, sleep } = require('./helpers');

const HOLD_MS = 1500;

async function setup(t) {
  const srv = await startServer({ MODE: 'auth', HOLD_MS: String(HOLD_MS), SWEEP_MS: '200' });
  t.after(() => srv.stop());
  return srv;
}
// Host creates, a guest joins, host starts the server-run match.
async function startedRoom(srv) {
  const host = await connect(srv);
  host.send({ t: 'create', name: 'Host' });
  const hj = await host.waitFor('joined');
  assert.equal(hj.auth, true);
  const guest = await connect(srv);
  guest.send({ t: 'join', code: hj.code, name: 'Guest' });
  const gj = await guest.waitFor('joined');
  await host.waitFor('players', 3000, m => m.players.length === 2);
  host.send({ t: 'start' });
  await host.waitFor('players', 10000, m => m.started === true);
  return { host, guest, code: hj.code, hj, gj };
}

test('rejoin within the hold window restores the same player', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { guest, code, gj } = await startedRoom(srv);
  await guest.close();
  await until(async () => (await srv.stats()).players === 1, 3000, 'server to notice the disconnect');
  const g2 = await connect(srv);
  g2.send({ t: 'rejoin', code, token: gj.token });
  const j = await g2.waitFor('joined', 3000);
  assert.equal(j.rejoined, true);
  assert.equal(j.pid, gj.pid);
  assert.equal(j.started, true);
  assert.equal((await srv.stats()).players, 2);
});

test('rejoin after the hold expired is refused', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { guest, code, gj } = await startedRoom(srv);
  await guest.close();
  await until(async () => (await srv.stats()).players === 1, 3000, 'server to notice the disconnect');
  await sleep(HOLD_MS + 700);
  const g2 = await connect(srv);
  g2.send({ t: 'rejoin', code, token: gj.token });
  const e = await g2.waitFor('err', 3000);
  assert.equal(e.rejoin, false);
  assert.match(e.msg, /no longer held/);
});

test('a held last player keeps the room until the hold expires', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { host, guest } = await startedRoom(srv);
  await guest.close();
  await host.close();
  await until(async () => (await srv.stats()).players === 0, 3000, 'both players to drop');
  assert.equal((await srv.stats()).rooms, 1, 'room should be held for rejoin');
  await until(async () => (await srv.stats()).rooms === 0, HOLD_MS + 5000, 'hold expiry to free the room');
  assert.equal((await srv.stats()).matches, 0);
});

test('rejoin with a wrong token is refused', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { guest, code } = await startedRoom(srv);
  await guest.close();
  await until(async () => (await srv.stats()).players === 1, 3000, 'server to notice the disconnect');
  const g2 = await connect(srv);
  g2.send({ t: 'rejoin', code, token: 'deadbeef' });
  const e = await g2.waitFor('err', 3000);
  assert.equal(e.rejoin, false);
});
