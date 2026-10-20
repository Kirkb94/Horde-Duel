'use strict';
// Relay-mode room logic: create, join, full room, host leave, sweeper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, until, sleep } = require('./helpers');

async function setup(t, env = {}) {
  const srv = await startServer(Object.assign({ MODE: 'relay' }, env));
  t.after(() => srv.stop());
  return srv;
}
async function makeRoom(srv, name = 'Host') {
  const host = await connect(srv);
  host.send({ t: 'create', name });
  const joined = await host.waitFor('joined');
  return { host, joined };
}

test('create returns a 4-letter code, ids and relay mode', async t => {
  const srv = await setup(t);
  const { joined } = await makeRoom(srv);
  assert.match(joined.code, /^[A-Z]{4}$/);
  assert.equal(typeof joined.pid, 'number');
  assert.match(joined.token, /^[0-9a-f]{32}$/);
  assert.equal(joined.host, joined.pid);
  assert.equal(joined.auth, false);
  assert.equal((await srv.stats()).rooms, 1);
});

test('join: both players see a 2-entry roster (code is case-insensitive)', async t => {
  const srv = await setup(t);
  const { host, joined } = await makeRoom(srv);
  const g = await connect(srv);
  g.send({ t: 'join', code: joined.code.toLowerCase(), name: 'Guest' });
  const gj = await g.waitFor('joined');
  assert.equal(gj.code, joined.code);
  assert.equal(gj.host, joined.pid);
  await host.waitFor('players', 3000, m => m.players.length === 2);
  await g.waitFor('players', 3000, m => m.players.length === 2);
});

test('join with an unknown code is rejected', async t => {
  const srv = await setup(t);
  const g = await connect(srv);
  g.send({ t: 'join', code: 'ZZZZ' });
  const e = await g.waitFor('err');
  assert.match(e.msg, /No room with that code/);
});

test('full room: a 1v1 room refuses a third player', async t => {
  const srv = await setup(t);
  const { host, joined } = await makeRoom(srv);
  host.send({ t: 'cfg', mode: 'duel', size: 2 });
  await host.waitFor('players', 3000, m => m.cfg.mode === 'duel');
  const g = await connect(srv);
  g.send({ t: 'join', code: joined.code });
  await g.waitFor('joined');
  const g3 = await connect(srv);
  g3.send({ t: 'join', code: joined.code });
  const e = await g3.waitFor('err');
  assert.match(e.msg, /full/);
  assert.equal((await srv.stats()).players, 2);
});

test('cannot join a match that already started', async t => {
  const srv = await setup(t);
  const { host, joined } = await makeRoom(srv);
  host.send({ t: 'start' });
  await host.waitFor('players', 3000, m => m.started === true);
  const g = await connect(srv);
  g.send({ t: 'join', code: joined.code });
  assert.match((await g.waitFor('err')).msg, /already started/);
});

test('relay: host leaving closes the room for everyone', async t => {
  const srv = await setup(t);
  const { host, joined } = await makeRoom(srv);
  const g = await connect(srv);
  g.send({ t: 'join', code: joined.code });
  await g.waitFor('joined');
  await host.waitFor('players', 3000, m => m.players.length === 2);
  await host.close();
  const c = await g.waitFor('closed');
  assert.match(c.reason, /host left/i);
  await until(async () => (await srv.stats()).rooms === 0, 5000, 'room removal');
});

test('relay: a guest leaving notifies the host and keeps the room', async t => {
  const srv = await setup(t);
  const { host, joined } = await makeRoom(srv);
  const g = await connect(srv);
  g.send({ t: 'join', code: joined.code });
  const gj = await g.waitFor('joined');
  g.send({ t: 'leave' });
  const left = await host.waitFor('left');
  assert.equal(left.pid, gj.pid);
  assert.equal((await srv.stats()).rooms, 1);
});

test('relay: rejoin is not available', async t => {
  const srv = await setup(t);
  const { joined } = await makeRoom(srv);
  const g = await connect(srv);
  g.send({ t: 'rejoin', code: joined.code, token: joined.token });
  assert.match((await g.waitFor('err')).msg, /isn't available/);
});

test('sweeper removes unstarted lobbies older than ROOM_MAX_AGE_MS', async t => {
  const srv = await setup(t, { SWEEP_MS: '100', ROOM_MAX_AGE_MS: '500' });
  await makeRoom(srv);
  assert.equal((await srv.stats()).rooms, 1);
  await until(async () => (await srv.stats()).rooms === 0, 6000, 'sweeper to remove the old lobby');
});

test('sweeper keeps started matches regardless of age', async t => {
  const srv = await setup(t, { SWEEP_MS: '100', ROOM_MAX_AGE_MS: '500' });
  const { host } = await makeRoom(srv);
  host.send({ t: 'start' });
  await host.waitFor('players', 3000, m => m.started === true);
  await sleep(1500);
  assert.equal((await srv.stats()).rooms, 1);
});
