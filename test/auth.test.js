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

test('host disconnect promotes the remaining player to host', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { host, guest, hj, gj } = await startedRoom(srv);
  await host.close();
  const m = await guest.waitFor('players', 3000, x => x.host === gj.pid && x.players.length === 1);
  assert.equal(m.host, gj.pid);
  assert.notEqual(m.host, hj.pid);
});

test('a held host reclaims host when they rejoin', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { host, guest, code, hj, gj } = await startedRoom(srv);
  await host.close();
  await guest.waitFor('players', 3000, x => x.host === gj.pid && x.players.length === 1);
  guest.queue.length = 0;
  const h2 = await connect(srv);
  h2.send({ t: 'rejoin', code, token: hj.token });
  const j = await h2.waitFor('joined', 3000);
  assert.equal(j.rejoined, true);
  assert.equal(j.pid, hj.pid);
  assert.equal(j.host, hj.pid);
  const m = await guest.waitFor('players', 3000, x => x.host === hj.pid && x.players.length === 2);
  assert.equal(m.host, hj.pid);
});

test('after the host hold expires the interim host keeps host and the old host cannot rejoin', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { host, guest, code, hj, gj } = await startedRoom(srv);
  await host.close();
  await guest.waitFor('players', 3000, x => x.host === gj.pid && x.players.length === 1);
  await sleep(HOLD_MS + 700);
  const h2 = await connect(srv);
  h2.send({ t: 'rejoin', code, token: hj.token });
  const e = await h2.waitFor('err', 3000);
  assert.equal(e.rejoin, false);
  guest.queue.length = 0;
  guest.send({ t: 'upd', weapon: 'rifle' });   // forces a players broadcast
  const m = await guest.waitFor('players', 3000);
  assert.equal(m.host, gj.pid);
});

test('everyone drops: first back becomes host, the held host then reclaims it', { timeout: 30000 }, async t => {
  const srv = await setup(t);
  const { host, guest, code, hj, gj } = await startedRoom(srv);
  await host.close();
  await guest.close();
  await until(async () => (await srv.stats()).players === 0, 3000, 'both players to drop');
  const g2 = await connect(srv);
  g2.send({ t: 'rejoin', code, token: gj.token });
  const jg = await g2.waitFor('joined', 3000);
  assert.equal(jg.host, gj.pid, 'first player back takes host while the host slot is empty');
  g2.queue.length = 0;
  const h2 = await connect(srv);
  h2.send({ t: 'rejoin', code, token: hj.token });
  const jh = await h2.waitFor('joined', 3000);
  assert.equal(jh.host, hj.pid);
  const m = await g2.waitFor('players', 3000, x => x.host === hj.pid && x.players.length === 2);
  assert.equal(m.host, hj.pid);
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
