'use strict';
// Horde Duel online relay server.
// One process serves the game page and a WebSocket relay. A room is up to 16 players;
// the room creator's browser runs the simulation (host) and the server only forwards messages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;
const MAX_ROOMS = +(process.env.MAX_ROOMS || 60);
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const WEAPONS = ['pistol', 'revolver', 'smg', 'rifle', 'shotgun', 'rocket', 'sword', 'sniper'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
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
const list = room => [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon }));
function bcastPlayers(room) {
  const msg = { t: 'players', host: room.host, players: list(room), started: room.started };
  for (const p of room.players.values()) send(p.ws, msg);
}
function joinRoom(ws, room, name, weapon) {
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Room is full (16 players).' });
  if (room.started) return send(ws, { t: 'err', msg: 'That match already started.' });
  leaveRoom(ws);
  const p = { ws, pid: nextPid++, name: uniqueName(room, name), weapon: WEAPONS.includes(weapon) ? weapon : 'rifle' };
  ws.p = p; ws.room = room;
  room.players.set(p.pid, p);
  if (!room.host) room.host = p.pid;
  send(ws, { t: 'joined', code: room.code, pid: p.pid, host: room.host, players: list(room), started: room.started });
  bcastPlayers(room);
}
function leaveRoom(ws) {
  const room = ws.room, p = ws.p;
  if (!room || !p) return;
  room.players.delete(p.pid);
  ws.room = null; ws.p = null;
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
        const r = { code, players: new Map(), host: 0, started: false, created: Date.now() };
        rooms.set(code, r); return joinRoom(ws, r, m.name, m.weapon);
      }
      case 'join': {
        const r = rooms.get(clean(m.code, 4).toUpperCase());
        if (!r) return send(ws, { t: 'err', msg: 'No room with that code.' });
        return joinRoom(ws, r, m.name, m.weapon);
      }
      case 'quick': {
        let best = null;
        for (const r of rooms.values()) if (!r.started && r.players.size < MAX_PLAYERS && (!best || r.players.size > best.players.size)) best = r;
        if (!best) {
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Server is busy, try again in a minute.' });
          const code = newCode(); best = { code, players: new Map(), host: 0, started: false, created: Date.now() }; rooms.set(code, best);
        }
        return joinRoom(ws, best, m.name, m.weapon);
      }
      case 'upd': {
        if (!room || !p) return;
        if (typeof m.name === 'string') p.name = uniqueName({ players: new Map([...room.players].filter(([k]) => k !== p.pid)) }, m.name);
        if (WEAPONS.includes(m.weapon)) p.weapon = m.weapon;
        return bcastPlayers(room);
      }
      case 'start': if (room && p && p.pid === room.host && !room.started) { room.started = true; bcastPlayers(room); } return;
      case 'lobby': if (room && p && p.pid === room.host) { room.started = false; bcastPlayers(room); } return;
      case 'leave': return leaveRoom(ws);
      case 'r': {                                      // relay: client -> host, host -> peer or everyone
        if (!room || !p) return;
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
  for (const [c, r] of rooms) if (!r.players.size || (!r.started && now - r.created > 6 * 3600e3)) rooms.delete(c);
}, 25000);

server.listen(PORT, () => console.log('Horde Duel server listening on :' + PORT));
