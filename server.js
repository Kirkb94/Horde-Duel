'use strict';
// Horde Duel online relay server.
// One process serves the game page and a WebSocket relay. A room is up to 16 players;
// the room creator's browser runs the simulation (host) and the server only forwards messages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadPage, createSim } = require('./sim');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;
const HOLD_MS = 30000;   // how long a disconnected player's slot is held for rejoin (auth mode)
const newToken = () => crypto.randomBytes(16).toString('hex');
// MODE=auth  : the server runs the match (recommended, needs a paid Render instance for CPU)
// MODE=relay : the room creator's browser runs the match and the server only forwards messages (fine on the free plan)
const MODE = process.env.MODE === 'relay' ? 'relay' : 'auth';
const TICK_HZ = +(process.env.TICK_HZ || 30);
const MAX_ROOMS = +(process.env.MAX_ROOMS || 60);
const MAX_MATCHES = +(process.env.MAX_MATCHES || (MODE === 'auth' ? 4 : 60));   // simultaneous server-run matches
let PAGE = null;
const loadGame = () => { if (!PAGE) PAGE = loadPage(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')); return PAGE; };
const perf = { ticks: 0, ms: 0, max: 0, errors: 0, aborts: 0 };
const SIM_MAX_CONSEC = +(process.env.SIM_MAX_CONSEC || 5);    // consecutive failed ticks before the match is ended
const SIM_MAX_TOTAL = +(process.env.SIM_MAX_TOTAL || 30);     // total failed ticks in one match before it is ended
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const WEAPONS = ['pistol', 'revolver', 'smg', 'rifle', 'shotgun', 'rocket', 'sword', 'sniper', 'crossbow', 'carbine', 'scorch'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mode: MODE, rooms: rooms.size, matches: [...rooms.values()].filter(r => r.sim).length, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      tickMsAvg: perf.ticks ? +(perf.ms / perf.ticks).toFixed(2) : 0, tickMsMax: +perf.max.toFixed(1), simErrors: perf.errors, simAborts: perf.aborts }));
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

// Per-IP abuse limits (override with env vars). Loopback is exempt for local testing.
const MAX_CONN_PER_IP = +(process.env.MAX_CONN_PER_IP || 8);
const ROOMS_PER_MIN = +(process.env.ROOMS_PER_MIN || 6);
const XFF_HOPS = +(process.env.XFF_HOPS || 0);   // 0 = trust first X-Forwarded-For entry; N = take Nth entry from the right (strict, set to your trusted proxy count)
const ipConns = new Map();   // ip -> open socket count
const ipRooms = new Map();   // ip -> timestamps of recent room creations
function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map(s => s.trim()).filter(Boolean);
  let ip = xff.length ? (XFF_HOPS > 0 ? xff[Math.max(0, xff.length - XFF_HOPS)] : xff[0]) : (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(ip).replace(/^::ffff:/, '').slice(0, 64);
}
const isLocalIp = ip => ip === '127.0.0.1' || ip === '::1' || ip === 'unknown';
function roomLimited(ws) {
  if (isLocalIp(ws.ip)) return false;
  const now = Date.now(), arr = (ipRooms.get(ws.ip) || []).filter(t => now - t < 60000);
  if (arr.length >= ROOMS_PER_MIN) {
    ipRooms.set(ws.ip, arr);
    const wait = Math.max(1, Math.ceil((60000 - (now - arr[0])) / 1000));
    send(ws, { t: 'err', msg: "You're creating rooms too quickly. Try again in " + wait + 's.' });
    return true;
  }
  arr.push(now); ipRooms.set(ws.ip, arr);
  return false;
}

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
function clearHolds(room) {
  if (!room.held) return;
  for (const h of room.held.values()) clearTimeout(h.timer);
  room.held.clear();
}
function expireHold(room, token) {
  if (!room.held.has(token)) return;
  room.held.delete(token);
  if (!room.players.size && !room.held.size) { stopSim(room); rooms.delete(room.code); }
}
function abortMatch(room, why) {
  perf.aborts++;
  console.error('ending match in room ' + room.code + ': ' + why);
  clearHolds(room);
  stopSim(room);
  room.started = false;
  if (!room.players.size) { rooms.delete(room.code); return; }
  bcastPlayers(room);   // started=false sends clients back to the lobby
  for (const p of room.players.values()) send(p.ws, { t: 'err', msg: "The match hit a server error and was ended. You're back in the lobby." });
}
function startSim(room, diff) {
  clearHolds(room);
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
  let fails = 0, totalFails = 0;
  const step = 1000 / TICK_HZ;
  const loop = () => {
    if (!room.sim) return;
    const t0 = process.hrtime.bigint();
    const dt = Math.min(0.05, Number(t0 - last) / 1e9); last = t0;
    try { room.sim.api.tick(dt); fails = 0; }
    catch (e) {
      fails++; totalFails++; perf.errors++;
      console.error('sim error (room ' + room.code + ', ' + fails + ' in a row, ' + totalFails + ' total)', e);
      if (fails >= SIM_MAX_CONSEC || totalFails >= SIM_MAX_TOTAL) return abortMatch(room, 'repeated sim tick errors');
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    perf.ticks++; perf.ms += ms; if (ms > perf.max) perf.max = ms;
    if (perf.ticks > 6000) { perf.ticks = 1500; perf.ms = perf.ms / 4; perf.max = ms; }
    room.timer = setTimeout(loop, Math.max(1, step - ms));
  };
  room.timer = setTimeout(loop, step);
}
const roomCap = room => room.cfg.mode === 'duel' ? 2 : room.cfg.mode === 'team' ? 4 : room.cfg.size;
const newCfg = () => ({ mode: 'br', size: 16, map: 'random' });
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
  const p = { ws, token: newToken(), pid: nextPid++, name: uniqueName(room, name), weapon: WEAPONS.includes(weapon) ? weapon : 'rifle', team: nA <= nB ? 0 : 1 };
  ws.p = p; ws.room = room;
  room.players.set(p.pid, p);
  if (!room.host) room.host = p.pid;
  send(ws, { t: 'joined', token: p.token, auth: room.auth, cfg: room.cfg, code: room.code, pid: p.pid, host: room.host, players: list(room), started: room.started });
  bcastPlayers(room);
}
function leaveRoom(ws, hold) {
  const room = ws.room, p = ws.p;
  if (!room || !p) return;
  room.players.delete(p.pid);
  ws.room = null; ws.p = null;
  if (room.auth) {
    const held = !!(hold && p.token && room.started && room.sim);
    if (room.sim) { try { room.sim.api.botify(p.pid); if (!room.sim.api.humans() && !held && !room.held.size) { stopSim(room); room.started = false; } } catch (e) {} }
    if (held) room.held.set(p.token, { p, timer: setTimeout(() => expireHold(room, p.token), HOLD_MS) });
    if (!room.players.size && !room.held.size) { stopSim(room); rooms.delete(room.code); return; }
    if (p.pid === room.host && room.players.size) room.host = room.players.keys().next().value;
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
  ws.ip = clientIp(req);
  const nConn = (ipConns.get(ws.ip) || 0) + 1;
  if (!isLocalIp(ws.ip) && nConn > MAX_CONN_PER_IP) {
    ws.on('error', () => {});
    try { ws.send(JSON.stringify({ t: 'err', msg: 'Too many connections from your network. Close other Horde Duel tabs and try again.' })); } catch (e) {}
    ws.close(1013, 'Too many connections');
    return;
  }
  ipConns.set(ws.ip, nConn);
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
        if (roomLimited(ws)) return;
        const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'No room codes free.' });
        const r = { code, players: new Map(), held: new Map(), host: 0, started: false, created: Date.now(), auth: MODE === 'auth', sim: null, cfg: newCfg() };
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
          if (roomLimited(ws)) return;
          const code = newCode(); best = { code, players: new Map(), held: new Map(), host: 0, started: false, created: Date.now(), auth: MODE === 'auth', sim: null, cfg: newCfg() }; rooms.set(code, best);
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
        const map = ['random', 'hotel', 'camp', 'hospital'].includes(m.map) ? m.map : 'random';
        room.cfg = { mode, size, map };
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
      case 'rematch':
        if (room && p && p.pid === room.host && room.started) {
          if (room.auth) {
            stopSim(room);
            try { room.started = true; startSim(room, m.diff); } catch (e) { console.error('rematch failed', e); room.started = false; stopSim(room); send(ws, { t: 'err', msg: 'Could not start the rematch.' }); }
          }
          bcastPlayers(room);
        } return;
      case 'lobby': if (room && p && p.pid === room.host) { clearHolds(room); stopSim(room); room.started = false; bcastPlayers(room); } return;
      case 'rejoin': {
        if (MODE !== 'auth') return send(ws, { t: 'err', msg: "Rejoin isn't available on this server." });
        const r = rooms.get(clean(m.code, 4).toUpperCase());
        const h = r && r.held && typeof m.token === 'string' ? r.held.get(m.token) : null;
        if (!h || !r.sim) return send(ws, { t: 'err', msg: 'Could not rejoin: that slot is no longer held.', rejoin: false });
        if (typeof r.sim.api.rejoin !== 'function') return send(ws, { t: 'err', msg: 'Rejoin is not supported by this build yet.', rejoin: false });
        let ok = false; try { ok = !!r.sim.api.rejoin(h.p.pid); } catch (e) { console.error('rejoin failed', e); }
        if (!ok) return send(ws, { t: 'err', msg: 'Could not rejoin the match.', rejoin: false });
        if (ws.room) leaveRoom(ws);
        clearTimeout(h.timer); r.held.delete(m.token);
        const q = h.p; q.ws = ws; ws.p = q; ws.room = r;
        r.players.set(q.pid, q);
        if (!r.players.has(r.host)) r.host = q.pid;
        send(ws, { t: 'joined', token: q.token, auth: r.auth, cfg: r.cfg, code: r.code, pid: q.pid, host: r.host, players: list(r), started: r.started, rejoined: true });
        return bcastPlayers(r);
      }
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
  ws.on('close', () => {
    clearInterval(rate); leaveRoom(ws, true);
    const n = (ipConns.get(ws.ip) || 1) - 1; if (n > 0) ipConns.set(ws.ip, n); else ipConns.delete(ws.ip);
  });
  ws.on('error', () => {});
});

const sweeper = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();                              // sweep empty / abandoned lobbies
  for (const [ip, arr] of ipRooms) { const keep = arr.filter(t => now - t < 60000); if (keep.length) ipRooms.set(ip, keep); else ipRooms.delete(ip); }
  for (const [c, r] of rooms) if ((!r.players.size && !(r.held && r.held.size)) || (!r.started && now - r.created > 6 * 3600e3)) { clearHolds(r); stopSim(r); rooms.delete(c); }
}, 10000);

server.listen(PORT, () => console.log('Horde Duel server listening on :' + PORT + ' mode=' + MODE));

// Graceful shutdown (Render sends SIGTERM on every deploy/restart)
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(sig + ' received, shutting down');
  const force = setTimeout(() => { console.error('shutdown timed out, forcing exit'); process.exit(1); }, 5000);
  clearInterval(sweeper);
  server.close(() => { clearTimeout(force); console.log('shutdown complete'); process.exit(0); });   // stop accepting new HTTP / WS upgrades
  for (const room of rooms.values()) { clearHolds(room); stopSim(room); }
  rooms.clear();
  const msg = JSON.stringify({ t: 'closed', reason: 'The server is restarting for an update. Please start a new room in a moment.' });
  for (const ws of wss.clients) {
    ws.room = null; ws.p = null;                       // so the close handler doesn't start rejoin holds
    try { if (ws.readyState === 1) ws.send(msg); ws.close(1001, 'server restarting'); } catch (e) { try { ws.terminate(); } catch (_) {} }
  }
  setTimeout(() => { for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} } }, 1500);   // clients that don't finish the close handshake
  wss.close();
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 2000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
