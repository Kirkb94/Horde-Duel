'use strict';
// Horde Duel online relay server.
// One process serves the game page and a WebSocket relay. A room is up to 16 players;
// the room creator's browser runs the simulation (host) and the server only forwards messages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { loadPage, createSim } = require('./sim');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 16;
const envMs = (k, d) => { const v = +process.env[k]; return v > 0 ? v : d; };   // timer overrides (used by tests); defaults are production values
const HOLD_MS = envMs('HOLD_MS', 30000);   // how long a disconnected player's slot is held for rejoin (auth mode)
const SWEEP_MS = envMs('SWEEP_MS', 10000);   // sweeper interval
const ROOM_MAX_AGE_MS = envMs('ROOM_MAX_AGE_MS', 6 * 3600e3);   // unstarted lobbies older than this are removed
const newToken = () => crypto.randomBytes(16).toString('hex');
const SLOW_BUF = envMs('SLOW_BUF', 200000);          // above this many queued bytes, stale snapshots are dropped for that socket
const HARD_BUF = envMs('HARD_BUF', 4 * 1024 * 1024);  // above this for HARD_BUF_MS the socket is terminated
const HARD_BUF_MS = envMs('HARD_BUF_MS', 5000);
// Returns true if the socket was terminated for staying over the hard buffer cap.
function slowCheck(ws) {
  if (ws.bufferedAmount > HARD_BUF) {
    const now = Date.now();
    if (!ws.overSince) ws.overSince = now;
    else if (now - ws.overSince >= HARD_BUF_MS) {
      console.error('terminating slow socket (' + ws.bufferedAmount + ' bytes queued for ' + (now - ws.overSince) + ' ms)');
      try { ws.terminate(); } catch (e) {}
      return true;
    }
  } else ws.overSince = 0;
  return false;
}
// Single send path for relayed/sim messages: drops stale snapshots to slow links, enforces the hard cap.
function relaySend(p, str, d) {
  if (!p || !p.ws || p.ws.readyState !== 1) return;
  if (slowCheck(p.ws)) return;
  if (d && d.k === 's' && p.ws.bufferedAmount > SLOW_BUF) return;   // drop stale snapshots for slow links
  p.ws.send(str);
}
const MAX_REJOIN_FAILS = 5;   // failed rejoin attempts allowed per socket before it is closed
const tokEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// MODE=auth  : the server runs the match (recommended, needs a paid Render instance for CPU)
// MODE=relay : the room creator's browser runs the match and the server only forwards messages (fine on the free plan)
const MODE = process.env.MODE === 'relay' ? 'relay' : 'auth';
const TICK_HZ = +(process.env.TICK_HZ || 30);
const MAX_ROOMS = +(process.env.MAX_ROOMS || 60);
const MAX_MATCHES = +(process.env.MAX_MATCHES || (MODE === 'auth' ? 4 : 60));   // simultaneous server-run matches
let PAGE = null;
const loadGame = () => { if (!PAGE) PAGE = loadPage(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')); return PAGE; };
const perf = { ticks: 0, ms: 0, max: 0, errors: 0, aborts: 0 };
const dropStats = { total: 0, rate: 0, client: 0, room: 0 };   // dropped inbound messages by reason (shown on /stats)
const SIM_MAX_CONSEC = +(process.env.SIM_MAX_CONSEC || 5);    // consecutive failed ticks before the match is ended
const SIM_MAX_TOTAL = +(process.env.SIM_MAX_TOTAL || 30);     // total failed ticks in one match before it is ended
const PUBLIC = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const WEAPONS = ['pistol', 'revolver', 'smg', 'rifle', 'shotgun', 'rocket', 'sword', 'sniper', 'crossbow', 'carbine', 'scorch'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mode: MODE, rooms: rooms.size, matches: [...rooms.values()].filter(r => r.sim).length, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      tickMsAvg: perf.ticks ? +(perf.ms / perf.ticks).toFixed(2) : 0, tickMsMax: +perf.max.toFixed(1), simErrors: perf.errors, simAborts: perf.aborts,
      dropped: Object.assign({}, dropStats, { roomsThrottled: [...rooms.values()].filter(r => r.dropped > 0).length }) }));
  }
  if (process.env.DEBUG_HOOKS === '1' && url.startsWith('/debug/')) {   // test helpers, never enabled in production
    const [, , cmd, code] = url.split('/'); const r = rooms.get(code);
    if (!r || !r.sim) { res.writeHead(404); return res.end('no sim'); }
    const G = r.sim.api.G;
    if (cmd === 'winner') { const q = new URL(req.url, 'http://x').searchParams, keep = +(q.get('keep') || 0); for (const f of G.fighters.slice(0, 16)) if (f.id !== keep) f.alive = false; if (q.get('wins')) G.fighters[keep].wins = +q.get('wins'); }
    res.writeHead(200); return res.end('ok');
  }
  serveStatic(req, res, url);
});

// ---- static file serving: safe paths, security headers, in-memory cache with gzip + ETag ----
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'self'"
};
const GZIP_EXT = new Set(['.html', '.js', '.css', '.json', '.svg']);
const staticCache = new Map();   // full path -> { mtimeMs, size, etag, data, gz }
function plain(res, code, msg) { res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain' }, SEC_HEADERS)); res.end(msg || ''); }
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, Object.assign({ Allow: 'GET, HEAD' }, SEC_HEADERS)); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url); } catch (e) { return plain(res, 400, 'Bad request'); }
  if (rel.indexOf('\0') !== -1 || rel.indexOf('\\') !== -1) return plain(res, 400, 'Bad request');
  rel = path.posix.normalize('/' + rel);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.split('/').some(s => s.startsWith('.'))) return plain(res, 404, 'Not found');
  const full = path.join(PUBLIC, rel);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return plain(res, 403, 'Forbidden');
  const respond = c => {
    const headers = Object.assign({ 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'ETag': c.etag, 'Vary': 'Accept-Encoding' }, SEC_HEADERS);
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') headers['Strict-Transport-Security'] = 'max-age=15552000';
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === c.etag)) { res.writeHead(304, headers); return res.end(); }
    let body = c.data;
    if (c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { body = c.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return plain(res, 404, 'Not found');
    const c = staticCache.get(full);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return respond(c);
    fs.readFile(full, (err2, data) => {
      if (err2) return plain(res, 404, 'Not found');
      const entry = { mtimeMs: st.mtimeMs, size: st.size, etag: '"' + crypto.createHash('sha1').update(data).digest('base64').replace(/=+$/, '') + '"', data, gz: null };
      const done = () => { staticCache.set(full, entry); respond(entry); };
      if (data.length > 1024 && GZIP_EXT.has(path.extname(full))) {
        zlib.gzip(data, { level: 9 }, (e, z) => { if (!e && z.length < data.length) entry.gz = z; done(); });
      } else done();
    });
  });
}

server.on('connection', s => s.setNoDelay(true));
// Cross-site WebSocket hijacking guard: browsers always send Origin on WS handshakes, so a page on another site can be detected.
// Allowed: no Origin (non-browser clients), same host as the request, or an entry in ALLOWED_ORIGINS (comma list of origins or bare hosts).
const normOrigin = s => String(s || '').trim().toLowerCase().replace(/\/+$/, '');
const originHost = o => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } };
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').concat(process.env.RENDER_EXTERNAL_URL || '').map(normOrigin).filter(Boolean);
function originAllowed(origin, host) {
  if (origin == null || origin === '') return true;
  const o = normOrigin(origin);
  if (o === 'null') return false;
  const oh = originHost(o);
  if (!oh) return false;
  if (host && oh === String(host).toLowerCase()) return true;
  return ALLOWED_ORIGINS.some(a => a === o || a === oh || originHost(a) === oh && /^https?:\/\//.test(a) && a.split('://')[0] === o.split('://')[0]);
}
function verifyOrigin(info, cb) {
  const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
  if (originAllowed(origin, info.req && info.req.headers && info.req.headers.host)) return cb(true);
  console.warn('ws: rejected origin', String(origin).slice(0, 100));
  cb(false, 403, 'Forbidden origin');
}
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyOrigin, maxPayload: 256 * 1024, perMessageDeflate: process.env.DEFLATE === '0' ? false : { threshold: 600, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 } });

const rooms = new Map();   // code -> room
let nextPid = 1;

// Per-IP abuse limits (override with env vars). Loopback is exempt for local testing.
const MAX_CONN_PER_IP = +(process.env.MAX_CONN_PER_IP || 8);
const ROOMS_PER_MIN = +(process.env.ROOMS_PER_MIN || 6);
// Number of trusted proxies in front of the server (Render = 1). N = take Nth X-Forwarded-For entry from the right; 0 = ignore the header, use the socket address.
const XFF_HOPS = process.env.XFF_HOPS !== undefined && process.env.XFF_HOPS !== '' && !isNaN(+process.env.XFF_HOPS) ? Math.max(0, Math.floor(+process.env.XFF_HOPS)) : 1;
const ipConns = new Map();   // ip -> open socket count
const ipRooms = new Map();   // ip -> timestamps of recent room creations
function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map(s => s.trim()).filter(Boolean);
  let ip = (XFF_HOPS > 0 && xff.length) ? xff[Math.max(0, xff.length - XFF_HOPS)] : (req.socket && req.socket.remoteAddress) || 'unknown';
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
function rejoinFail(ws, msg) {
  ws.rjFails = (ws.rjFails || 0) + 1;
  send(ws, { t: 'err', msg, rejoin: false });
  if (ws.rjFails >= MAX_REJOIN_FAILS) { try { ws.close(1008, 'too many rejoin attempts'); } catch (e) {} }
}

// Per-connection message limits: lobby traffic and game input are counted separately.
const LOBBY_PER_SEC = +(process.env.LOBBY_MSGS_PER_SEC || 20);
const GAME_PER_SEC = +(process.env.GAME_MSGS_PER_SEC || (MODE === 'auth' ? 150 : 700));   // relay host forwards snapshots to every peer
const JOIN_PER_10S = +(process.env.JOIN_PER_10S || 15);       // join / quick / rejoin (limits room-code guessing)
const MAX_LOBBY_BYTES = 2048;
const MAX_GAME_BYTES = 4096;                                   // auth mode only; relay snapshots can be large
const MAX_DROPS = 3000;                                        // drop count after which a connection is terminated
// Inbound byte budgets (1s fixed windows). A client over its own cap is dropped before it is charged to the room,
// so a noisy client exhausts only its own allowance; the room cap bounds the total.
const CLIENT_BYTES_PER_SEC = envMs('CLIENT_BYTES_PER_SEC', 24 * 1024);
const HOST_BYTES_PER_SEC = envMs('HOST_BYTES_PER_SEC', 3 * 1024 * 1024);   // relay-mode host uploads snapshots for everyone
const ROOM_BYTES_PER_SEC = envMs('ROOM_BYTES_PER_SEC', MODE === 'auth' ? 256 * 1024 : 3 * 1024 * 1024);
// Returns '' if the message fits the budgets, else 'client' or 'room'.
function byteBudget(ws, len, now) {
  const room = ws.room, p = ws.p;
  const isRelayHost = MODE === 'relay' && room && p && p.pid === room.host;
  const cap = isRelayHost ? HOST_BYTES_PER_SEC : CLIENT_BYTES_PER_SEC;
  if (now - (ws.bWin || 0) >= 1000) { ws.bWin = now; ws.bBytes = 0; }
  if ((ws.bBytes || 0) + len > cap) return 'client';
  if (room) {
    if (now - (room.bWin || 0) >= 1000) { room.bWin = now; room.bBytes = 0; }
    if ((room.bBytes || 0) + len > ROOM_BYTES_PER_SEC) return 'room';
    room.bBytes = (room.bBytes || 0) + len;
  }
  ws.bBytes = (ws.bBytes || 0) + len;
  return '';
}
function msgAllowed(ws, t, len) {
  const now = Date.now();
  let ok = true;
  if (t === 'r') {
    if (MODE === 'auth' && len > MAX_GAME_BYTES) ok = false;
    else { if (now - ws.gWin >= 1000) { ws.gWin = now; ws.gN = 0; } ok = ++ws.gN <= GAME_PER_SEC; }
  } else {
    if (len > MAX_LOBBY_BYTES) ok = false;
    else {
      if (now - ws.lWin >= 1000) { ws.lWin = now; ws.lN = 0; ws.lWarned = false; }
      if (++ws.lN > LOBBY_PER_SEC) {
        ok = false;
        if (!ws.lWarned) { ws.lWarned = true; send(ws, { t: 'err', msg: 'Slow down: too many requests.' }); }
      } else if (t === 'join' || t === 'quick' || t === 'rejoin') {
        if (now - ws.jWin >= 10000) { ws.jWin = now; ws.jN = 0; }
        if (++ws.jN > JOIN_PER_10S) { ok = false; send(ws, { t: 'err', msg: 'Too many join attempts. Wait a few seconds and try again.' }); }
      }
    }
  }
  let why = ok ? '' : 'rate';
  if (ok) { why = byteBudget(ws, len, now); ok = !why; }
  if (!ok) {
    dropStats.total++; dropStats[why]++;
    if (ws.room) ws.room.dropped = (ws.room.dropped || 0) + 1;
  }
  if (!ok && ++ws.drops > MAX_DROPS) { try { ws.terminate(); } catch (e) {} }
  return ok;
}

// Auth mode: rebuild a client's game payload from a whitelist before it reaches the simulation.
const ACT_KEYS = ['a', 'd', 'h', 'm', 'r', 'u', 'z'];
const RELAY_HOST_KINDS = ['s', 'start', 'res', 'drop'];   // relay mode: the only message kinds the host may send to peers
const RELAY_MAX_HOST = 200000;                          // max serialized size of one host relay message (chars)
const numIn = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
function cleanGameMsg(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.k === 'i') {
    const out = { k: 'i', mx: numIn(d.mx, -1, 1), my: numIn(d.my, -1, 1), f: numIn(d.f, -1e4, 1e4), fr: d.fr ? 1 : 0, a: [] };
    if (Array.isArray(d.a)) for (const a of d.a.slice(0, 6)) {
      if (!Array.isArray(a) || typeof a[0] !== 'string' || !ACT_KEYS.includes(a[0])) continue;
      out.a.push([a[0]].concat(a.slice(1, 3).map(v => numIn(v, -1e5, 1e5))));
    }
    if (typeof d.sv === 'number' && Number.isFinite(d.sv)) out.sv = Math.round(numIn(d.sv, -1, 1000));
    return out;
  }
  if (d.k === 'ready') {
    const picks = [];
    if (Array.isArray(d.picks)) for (const p of d.picks.slice(0, 8)) {
      if (Array.isArray(p) && typeof p[0] === 'string' && /^[A-Za-z][\w-]{0,31}$/.test(p[0]) && !(p[0] in Object.prototype)) picks.push([p[0], 1]);
    }
    return { k: 'ready', picks };
  }
  return null;
}
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
  room.heldHost = 0;
}
function expireHold(room, token) {
  const h = room.held.get(token);
  if (!h) return;
  room.held.delete(token);
  const hostLost = room.heldHost === h.p.pid;
  if (hostLost) room.heldHost = 0;
  if (hostLost && !room.auth) { closeRelayRoom(room, 'The host did not come back in time.'); return; }
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
const DIFFS = ['easy', 'normal', 'hard'];
function startSim(room, diff) {
  diff = typeof diff === 'string' && DIFFS.includes(diff) ? diff : 'normal';
  clearHolds(room);
  const players = [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon, team: p.team }));
  const sendTo = (p, str, d) => relaySend(p, str, d);
  const io = {
    rel(to, d) {
      const str = JSON.stringify({ t: 'r', from: 0, d });
      if (to === '*') { for (const p of room.players.values()) sendTo(p, str, d); return; }
      const p = room.players.get(to);
      if (p) sendTo(p, str, d);
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
const MOD_KEYS = ['fast', 'frag', 'xp2', 'curse'];
const newCfg = () => ({ mode: 'br', size: 16, map: 'random', mods: [] });
function balanceTeams(room) {
  if (room.started || room.cfg.mode !== 'team') return;
  const ps = [...room.players.values()];
  for (const q of ps) q.team = q.team === 1 ? 1 : 0;
  const a = ps.filter(q => q.team === 0), b = ps.filter(q => q.team === 1);
  while (a.length > 2 && b.length < 2) { const q = a.pop(); q.team = 1; b.push(q); }
  while (b.length > 2 && a.length < 2) { const q = b.pop(); q.team = 0; a.push(q); }
}
const list = room => [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, weapon: p.weapon, team: p.team }));
function bcastPlayers(room) {
  const msg = { t: 'players', host: room.host, players: list(room), started: room.started, cfg: room.cfg };
  for (const p of room.players.values()) send(p.ws, msg);
}
// Returns an error message if the room can't accept a new player right now, else null.
const joinBlock = room => room.players.size >= roomCap(room) ? 'That room is full.' : room.started ? 'That match already started.' : null;
const activeMatches = () => [...rooms.values()].filter(r => r.sim).length;
function joinRoom(ws, room, name, weapon) {
  const block = joinBlock(room);
  if (block) return send(ws, { t: 'err', msg: block });
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
  if (p.ws !== ws) { ws.room = null; ws.p = null; return; }   // this socket was replaced by a rejoin: it no longer owns the player
  room.players.delete(p.pid);
  ws.room = null; ws.p = null;
  if (room.auth) {
    const held = !!(hold && p.token && room.started && room.sim);
    if (room.sim) { try { room.sim.api.botify(p.pid); if (!room.sim.api.humans() && !held && !room.held.size) { stopSim(room); room.started = false; } } catch (e) {} }
    if (held) room.held.set(p.token, { p, timer: setTimeout(() => expireHold(room, p.token), HOLD_MS) });
    if (!room.players.size && !room.held.size) { stopSim(room); rooms.delete(room.code); return; }
    if (p.pid === room.host) {
      if (held) room.heldHost = p.pid;   // remember a held host so they can reclaim it on rejoin
      room.host = room.players.size ? room.players.keys().next().value : 0;
    }
    balanceTeams(room);
    bcastPlayers(room); return;
  }
  if (p.pid === room.host) {
    if (hold && p.token && room.started) {   // relay host dropped mid-match: hold the room so they can rejoin
      room.held.set(p.token, { p, timer: setTimeout(() => expireHold(room, p.token), HOLD_MS) });
      room.heldHost = p.pid;
      for (const q of room.players.values()) send(q.ws, { t: 'hostlost', ms: HOLD_MS });
      return;
    }
    closeRelayRoom(room, 'The host left the match.');
    return;
  }
  const h = room.players.get(room.host);
  if (h) send(h.ws, { t: 'left', pid: p.pid });
  else if (room.heldHost) (room.lostPids || (room.lostPids = [])).push(p.pid);   // host is away: tell them on return
  if (!room.players.size && !room.held.size) { clearHolds(room); rooms.delete(room.code); }
  else if (room.players.size) { balanceTeams(room); bcastPlayers(room); }
}
function closeRelayRoom(room, reason) {
  clearHolds(room);
  for (const q of room.players.values()) { send(q.ws, { t: 'closed', reason }); q.ws.room = null; q.ws.p = null; }
  room.players.clear();
  stopSim(room);
  rooms.delete(room.code);
}
// Relay mode: the held host reclaims the room with the token from their 'joined' message.
function relayRejoin(ws, r, tok) {
  const h = tok && r.held ? r.held.get(tok) : null;
  let q = h && r.heldHost === h.p.pid ? h.p : null;
  if (!q && tok && r.started) { const c = r.players.get(r.host); if (c && tokEq(c.token, tok)) q = c; }   // old socket not yet noticed as dead
  if (!q) return rejoinFail(ws, 'Could not rejoin: that room is no longer held.');
  if (h) { clearTimeout(h.timer); r.held.delete(tok); }
  r.heldHost = 0;
  const old = q.ws;
  if (old && old !== ws) { old.p = null; old.room = null; send(old, { t: 'closed', reason: 'You reconnected to this match from another connection.' }); try { old.close(1000, 'replaced'); } catch (e) {} }
  q.ws = ws; ws.p = q; ws.room = r; ws.rjFails = 0;
  r.players.set(q.pid, q);
  send(ws, { t: 'joined', token: q.token, auth: r.auth, cfg: r.cfg, code: r.code, pid: q.pid, host: r.host, players: list(r), started: r.started, rejoined: true });
  for (const pid of r.lostPids || []) send(ws, { t: 'left', pid });
  r.lostPids = null;
  for (const g of r.players.values()) if (g !== q) send(g.ws, { t: 'hostback' });
  bcastPlayers(r);
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
  ws.gWin = ws.lWin = ws.jWin = 0; ws.gN = ws.lN = ws.jN = 0; ws.drops = 0; ws.lWarned = false; ws.rjFails = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  const rate = setInterval(() => { ws.msgs = 0; }, 1000);
  ws.on('message', (raw) => {
    try { onMsg(raw); } catch (e) { console.error('message handler error', e); }
  });
  function onMsg(raw) {
    if (++ws.msgs > 700) return;                      // flood guard
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!msgAllowed(ws, m.t, raw.length)) return;
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
        for (const r of rooms.values()) if (!joinBlock(r) && (!best || r.players.size > best.players.size)) best = r;
        if (!best) {
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Server is busy, try again in a minute.' });
          if (MODE === 'auth' && activeMatches() >= MAX_MATCHES) return send(ws, { t: 'err', msg: 'The server is running as many matches as it can. Try again shortly.' });
          if (roomLimited(ws)) return;
          const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'No room codes free.' });
          best = { code, players: new Map(), held: new Map(), host: 0, started: false, created: Date.now(), auth: MODE === 'auth', sim: null, cfg: newCfg() }; rooms.set(code, best);
        }
        return joinRoom(ws, best, m.name, m.weapon);
      }
      case 'cfg': {
        if (!room || !p || p.pid !== room.host || room.started) return;
        if (m.mode !== undefined && !(typeof m.mode === 'string' && ['br', 'duel', 'team'].includes(m.mode))) return send(ws, { t: 'err', msg: 'Invalid game mode.' });
        if (m.map !== undefined && !(typeof m.map === 'string' && ['random', 'hotel', 'camp', 'hospital'].includes(m.map))) return send(ws, { t: 'err', msg: 'Invalid map.' });
        if (m.size !== undefined && !(typeof m.size === 'number' && isFinite(m.size))) return send(ws, { t: 'err', msg: 'Invalid room size.' });
        const mode = m.mode !== undefined ? m.mode : room.cfg.mode;
        let size = Math.max(2, Math.min(MAX_PLAYERS, Math.round(m.size !== undefined ? m.size : room.cfg.size) || 16));
        const cap = mode === 'duel' ? 2 : mode === 'team' ? 4 : size;
        if (mode === 'br') size = Math.max(size, room.players.size);
        else if (room.players.size > cap) return send(ws, { t: 'err', msg: 'Too many players in the room for ' + (mode === 'duel' ? '1v1' : '2v2') + '.' });
        const map = m.map !== undefined ? m.map : room.cfg.map;
        if (m.mods !== undefined && !Array.isArray(m.mods)) return send(ws, { t: 'err', msg: 'Invalid modifiers.' });
        const mods = m.mods !== undefined ? MOD_KEYS.filter(k => m.mods.includes(k)) : (room.cfg.mods || []);
        room.cfg = { mode, size, map, mods };
        balanceTeams(room);
        return bcastPlayers(room);
      }
      case 'upd': {
        if (!room || !p) return;
        if (room.started) return;                      // roster is locked once the match is running
        if (m.name !== undefined && typeof m.name !== 'string') return send(ws, { t: 'err', msg: 'Invalid name.' });
        if (m.weapon !== undefined && typeof m.weapon !== 'string') return send(ws, { t: 'err', msg: 'Invalid weapon.' });
        if (m.team !== undefined && m.team !== 0 && m.team !== 1) return send(ws, { t: 'err', msg: 'Invalid team.' });
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
        if (ws.rjFails >= MAX_REJOIN_FAILS) return;
        const r = rooms.get(clean(m.code, 4).toUpperCase());
        const tok = typeof m.token === 'string' && /^[0-9a-f]{32}$/.test(m.token) ? m.token : null;
        if (r && !r.auth) return relayRejoin(ws, r, tok);
        const h = r && r.held && tok ? r.held.get(tok) : null;
        let live = null;   // slot still attached to a half-dead socket the server hasn't noticed is gone yet
        if (!h && r && r.sim && tok) for (const q0 of r.players.values()) if (tokEq(q0.token, tok)) { live = q0; break; }
        if ((!h && !live) || !r.sim) return rejoinFail(ws, 'Could not rejoin: that slot is no longer held.');
        if (typeof r.sim.api.rejoin !== 'function') return send(ws, { t: 'err', msg: 'Rejoin is not supported by this build yet.', rejoin: false });
        let ok = false; try { ok = !!r.sim.api.rejoin((h ? h.p : live).pid); } catch (e) { console.error('rejoin failed', e); }
        if (!ok) return send(ws, { t: 'err', msg: 'Could not rejoin the match.', rejoin: false });
        if (ws.room && ws.p !== (h ? h.p : live)) leaveRoom(ws);
        if (h) { clearTimeout(h.timer); r.held.delete(tok); }
        const q = h ? h.p : live, old = q.ws;
        if (old && old !== ws) { old.p = null; old.room = null; send(old, { t: 'closed', reason: 'You reconnected to this match from another connection.' }); try { old.close(1000, 'replaced'); } catch (e) {} }
        q.ws = ws; ws.p = q; ws.room = r; ws.rjFails = 0;
        r.players.set(q.pid, q);
        if (r.heldHost === q.pid || !r.players.has(r.host)) { r.host = q.pid; if (r.heldHost === q.pid) r.heldHost = 0; }
        send(ws, { t: 'joined', token: q.token, auth: r.auth, cfg: r.cfg, code: r.code, pid: q.pid, host: r.host, players: list(r), started: r.started, rejoined: true });
        try { if (typeof r.sim.api.resync === 'function') r.sim.api.resync(q.pid); } catch (e) { console.error('resync failed', e); }
        return bcastPlayers(r);
      }
      case 'leave': return leaveRoom(ws);
      case 'r': {                                      // relay: client -> host, host -> peer or everyone
        if (!room || !p) return;
        if (room.auth) { if (room.sim) { const d = cleanGameMsg(m.d); if (d) { try { room.sim.api.recv(p.pid, d); } catch (e) {} } } return; }
        const d0 = m.d;
        if (!d0 || typeof d0 !== 'object' || Array.isArray(d0) || typeof d0.k !== 'string') return;
        if (p.pid === room.host) {
          if (!RELAY_HOST_KINDS.includes(d0.k)) return;
          if (m.to !== '*' && !Number.isInteger(m.to)) return;
          const out = JSON.stringify({ t: 'r', from: p.pid, d: d0 });
          if (out.length > RELAY_MAX_HOST) return;
          if (m.to === '*') { for (const q of room.players.values()) if (q !== p) relaySend(q, out, d0); }
          else { const q = room.players.get(m.to); if (q && q !== p && q.ws.readyState === 1) {
            if (slowCheck(q.ws) || (d0.k === 's' && q.ws.bufferedAmount > SLOW_BUF)) return;   // drop stale snapshots for slow links, kill hopeless sockets
            q.ws.send(out); } }
        } else {
          const d = cleanGameMsg(d0);   // peers may only send input ('i') or 'ready'; payload rebuilt from a whitelist
          if (!d) return;
          const h = room.players.get(room.host); if (h && h.ws.readyState === 1) h.ws.send(JSON.stringify({ t: 'r', from: p.pid, d }));
        }
        return;
      }
    }
  }
  ws.on('close', () => {
    clearInterval(rate); leaveRoom(ws, true);
    const n = (ipConns.get(ws.ip) || 1) - 1; if (n > 0) ipConns.set(ws.ip, n); else ipConns.delete(ws.ip);
  });
  ws.on('error', () => {});
});

function sweep() {
  try { sweepOnce(); } catch (e) { console.error('sweep error', e); }
}
function sweepOnce() {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } if (slowCheck(ws)) continue; ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();                              // sweep empty / abandoned lobbies
  for (const [ip, arr] of ipRooms) { const keep = arr.filter(t => now - t < 60000); if (keep.length) ipRooms.set(ip, keep); else ipRooms.delete(ip); }
  for (const [c, r] of rooms) if ((!r.players.size && !(r.held && r.held.size)) || (!r.started && now - r.created > ROOM_MAX_AGE_MS)) { clearHolds(r); stopSim(r); rooms.delete(c); }
}
const sweeper = setInterval(sweep, SWEEP_MS);

process.on('uncaughtException', (err) => { console.error('uncaughtException', err && err.stack || err); });
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection', reason && reason.stack || reason); });

server.listen(PORT, () => console.log('Horde Duel server listening on :' + server.address().port + ' mode=' + MODE));

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
