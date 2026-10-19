'use strict';
// Horde Duel online relay server.
// One process serves the game page and a WebSocket relay. A room is up to 16 players;
// the room creator's browser runs the simulation (host) and the server only forwards messages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { loadPage, createSim } = require('./sim');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;
// MODE=auth  : the server runs the match (recommended, needs a paid Render instance for CPU)
// MODE=relay : the room creator's browser runs the match and the server only forwards messages (fine on the free plan)
const MODE = process.env.MODE === 'relay' ? 'relay' : 'auth';
const TICK_HZ = +(process.env.TICK_HZ || 30);
const MAX_ROOMS = +(process.env.MAX_ROOMS || 60);
const MAX_MATCHES = +(process.env.MAX_MATCHES || (MODE === 'auth' ? 4 : 60));   // simultaneous server-run matches
let PAGE = null;
const loadGame = () => { if (!PAGE) PAGE = loadPage(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')); return PAGE; };
const perf = { ticks: 0, ms: 0, max: 0 };
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const WEAPONS = ['pistol', 'revolver', 'smg', 'rifle', 'shotgun', 'rocket', 'sword', 'sniper'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mode: MODE, rooms: rooms.size, matches: [...rooms.values()].filter(r => r.sim).length, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      tickMsAvg: perf.ticks ? +(perf.ms / perf.ticks).toFixed(2) : 0, tickMsMax: +perf.max.toFixed(1) }));
  }
  if (process.env.DEBUG_HOOKS === '1' && url.startsWith('/debug/')) {   // test helpers, never enabled in production
    const [, , cmd, code] = url.split('/'); const r = rooms.get(code);
    if (!r || !r.sim) { res.writeHead(404); return res.end('no sim'); }
    const G = r.sim.api.G;
    if (cmd === 'winner') { const q = new URL(req.url, 'http://x').searchParams, keep = +(q.get('keep') || 0); for (const f of G.fighters.slice(0, 16)) if (f.id !== keep) f.alive = false; if (q.get('wins')) G.fighters[keep].wins = +q.get('wins'); }
    res.writeHead(200); return res.end('ok');
  }
  let file = url === '/' ? '/index.html' : url;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('connection', s => s.setNoDelay(true));
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024, perMessageDeflate: process.env.DEFLATE === '0' ? false : { threshold: 600, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 } });

const rooms = new Map();   // code -> room
let nextPid = 1;

const clean = (s, n) => String(s == null ? '' : s).replace(/[^\w \-.!?]/g, '').trim().slice(0, n);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function uniqueName(room, name) {
  let base = clean(name, 14) || 'Player', n = base, i = 2;
  const used = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  while (used.has(n.toLowerCase())) n = base.slice(0, 12) + i++;
  return n;
}
function stopSim(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.sim) { try { room.sim.stop(); } catch (e) {} room.sim = null; }
}
function startSim(room, diff) {
  const players = [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon, team: p.team }));
  const sendTo = (p, str) => { if (p && p.ws.readyState === 1) p.ws.send(str); };
  const io = {
    rel(to, d) {
      const str = JSON.stringify({ t: 'r', from: 0, d });
      if (to === '*') { for (const p of room.players.values()) sendTo(p, str); return; }
      const p = room.players.get(to);
      if (p && !(d && d.k === 's' && p.ws.bufferedAmount > 200000)) sendTo(p, str);   // drop stale snapshots for slow links
    }
  };
  room.sim = createSim(loadGame(), io);
  room.sim.api.start(players, diff, room.cfg);
  let last = process.hrtime.bigint();
  const step = 1000 / TICK_HZ;
  const loop = () => {
    if (!room.sim) return;
    const t0 = process.hrtime.bigint();
    const dt = Math.min(0.05, Number(t0 - last) / 1e9); last = t0;
    try { room.sim.api.tick(dt); } catch (e) { console.error('sim error', e); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    perf.ticks++; perf.ms += ms; if (ms > perf.max) perf.max = ms;
    if (perf.ticks > 6000) { perf.ticks = 1500; perf.ms = perf.ms / 4; perf.max = ms; }
    room.timer = setTimeout(loop, Math.max(1, step - ms));
  };
  room.timer = setTimeout(loop, step);
}
const roomCap = room => room.cfg.mode === 'duel' ? 2 : room.cfg.mode === 'team' ? 4 : room.cfg.size;
const newCfg = () => ({ mode: 'br', size: 16 });
const list = room => [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon, team: p.team }));
function bcastPlayers(room) {
  const msg = { t: 'players', host: room.host, players: list(room), started: room.started, cfg: room.cfg };
  for (const p of room.players.values()) send(p.ws, msg);
}
function joinRoom(ws, room, name, weapon) {
  if (room.players.size >= roomCap(room)) return send(ws, { t: 'err', msg: 'That room is full.' });
  if (room.started) return send(ws, { t: 'err', msg: 'That match already started.' });
  leaveRoom(ws);
  const nA = [...room.players.values()].filter(q => q.team === 0).length, nB = room.players.size - nA;
  const p = { ws, pid: nextPid++, name: uniqueName(room, name), weapon: WEAPONS.includes(weapon) ? weapon : 'rifle', team: nA <= nB ? 0 : 1 };
  ws.p = p; ws.room = room;
  room.players.set(p.pid, p);
  if (!room.host) room.host = p.pid;
  send(ws, { t: 'joined', auth: room.auth, cfg: room.cfg, code: room.code, pid: p.pid, host: room.host, players: list(room), started: room.started });
  bcastPlayers(room);
}
function leaveRoom(ws) {
  const room = ws.room, p = ws.p;
  if (!room || !p) return;
  room.players.delete(p.pid);
  ws.room = null; ws.p = null;
  if (room.auth) {
    if (room.sim) { try { room.sim.api.botify(p.pid); if (!room.sim.api.humans()) { stopSim(room); room.started = false; } } catch (e) {} }
    if (!room.players.size) { stopSim(room); rooms.delete(room.code); return; }
    if (p.pid === room.host) room.host = room.players.keys().next().value;
    bcastPlayers(room); return;
  }
  if (p.pid === room.host) {
    for (const q of room.players.values()) { send(q.ws, { t: 'closed', reason: 'The host left the match.' }); q.ws.room = null; q.ws.p = null; }
    rooms.delete(room.code);
    return;
  }
  const h = room.players.get(room.host);
  if (h) send(h.ws, { t: 'left', pid: p.pid });
  if (!room.players.size) rooms.delete(room.code); else bcastPlayers(room);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true; ws.msgs = 0; ws.room = null; ws.p = null;
  ws.on('pong', () => { ws.isAlive = true; });
  const rate = setInterval(() => { ws.msgs = 0; }, 1000);
  ws.on('message', (raw) => {
    if (++ws.msgs > 700) return;                      // flood guard
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room, p = ws.p;
    switch (m.t) {
      case 'ping': return send(ws, { t: 'pong', ts: m.ts });
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Server is busy, try again in a minute.' });
        const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'No room codes free.' });
        const r = { code, players: new Map(), host: 0, started: false, created: Date.now(), auth: MODE === 'auth', sim: null, cfg: newCfg() };
        rooms.set(code, r); return joinRoom(ws, r, m.name, m.weapon);
      }
      case 'join': {
        const r = rooms.get(clean(m.code, 4).toUpperCase());
        if (!r) return send(ws, { t: 'err', msg: 'No room with that code.' });
        return joinRoom(ws, r, m.name, m.weapon);
      }
      case 'quick': {
        let best = null;
        for (const r of rooms.values()) if (!r.started && r.players.size < roomCap(r) && (!best || r.players.size > best.players.size)) best = r;
        if (!best) {
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Server is busy, try again in a minute.' });
          const code = newCode(); best = { code, players: new Map(), host: 0, started: false, created: Date.now(), auth: MODE === 'auth', sim: null, cfg: newCfg() }; rooms.set(code, best);
        }
        return joinRoom(ws, best, m.name, m.weapon);
      }
      case 'cfg': {
        if (!room || !p || p.pid !== room.host || room.started) return;
        const mode = ['br', 'duel', 'team'].includes(m.mode) ? m.mode : 'br';
        let size = Math.max(2, Math.min(MAX_PLAYERS, Math.round(+m.size) || 16));
        const cap = mode === 'duel' ? 2 : mode === 'team' ? 4 : size;
        if (mode === 'br') size = Math.max(size, room.players.size);
        else if (room.players.size > cap) return send(ws, { t: 'err', msg: 'Too many players in the room for ' + (mode === 'duel' ? '1v1' : '2v2') + '.' });
        room.cfg = { mode, size };
        if (mode === 'team') { let a = 0, b = 0; for (const q of room.players.values()) { if (q.team === 1) b++; else a++; } for (const q of room.players.values()) { if (q.team === 1 && b > 2) { q.team = 0; b--; a++; } else if (q.team !== 1 && a > 2) { q.team = 1; a--; b++; } } }
        return bcastPlayers(room);
      }
      case 'upd': {
        if (!room || !p) return;
        if (m.team === 0 || m.team === 1) { const n = [...room.players.values()].filter(q => q !== p && q.team === m.team).length; if (room.cfg.mode !== 'team' || n < 2) p.team = m.team; else send(ws, { t: 'err', msg: 'That team is full.' }); }
        if (typeof m.name === 'string') p.name = uniqueName({ players: new Map([...room.players].filter(([k]) => k !== p.pid)) }, m.name);
        if (WEAPONS.includes(m.weapon)) p.weapon = m.weapon;
        return bcastPlayers(room);
      }
      case 'start':
        if (room && p && p.pid === room.host && !room.started) {
          if (room.auth) {
            if ([...rooms.values()].filter(r => r.sim).length >= MAX_MATCHES) return send(ws, { t: 'err', msg: 'The server is running as many matches as it can. Try again shortly.' });
            try { room.started = true; startSim(room, m.diff); } catch (e) { console.error('start failed', e); room.started = false; stopSim(room); return send(ws, { t: 'err', msg: 'Could not start the match on the server.' }); }
          } else room.started = true;
          bcastPlayers(room);
        } return;
      case 'lobby': if (room && p && p.pid === room.host) { stopSim(room); room.started = false; bcastPlayers(room); } return;
      case 'leave': return leaveRoom(ws);
      case 'r': {                                      // relay: client -> host, host -> peer or everyone
        if (!room || !p) return;
        if (room.auth) { if (room.sim) { try { room.sim.api.recv(p.pid, m.d); } catch (e) {} } return; }
        if (p.pid === room.host) {
          if (m.to === '*') { const out = JSON.stringify({ t: 'r', from: p.pid, d: m.d }); for (const q of room.players.values()) if (q !== p && q.ws.readyState === 1) q.ws.send(out); }
          else { const q = room.players.get(m.to); if (q && q.ws.readyState === 1) {
            if (m.d && m.d.k === 's' && q.ws.bufferedAmount > 200000) return;       // drop stale snapshots for slow links
            q.ws.send(JSON.stringify({ t: 'r', from: p.pid, d: m.d })); } }
        } else {
          const h = room.players.get(room.host); if (h && h.ws.readyState === 1) h.ws.send(JSON.stringify({ t: 'r', from: p.pid, d: m.d }));
        }
        return;
      }
    }
  });
  ws.on('close', () => { clearInterval(rate); leaveRoom(ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();                              // sweep empty / abandoned lobbies
  for (const [c, r] of rooms) if (!r.players.size || (!r.started && now - r.created > 6 * 3600e3)) { stopSim(r); rooms.delete(c); }
}, 25000);

server.listen(PORT, () => console.log('Horde Duel server listening on :' + PORT + ' mode=' + MODE));
