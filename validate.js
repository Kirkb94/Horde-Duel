'use strict';
// Strict per-message-type schema validation for client -> server WebSocket messages.
// validateMsg(m) -> { ok: true, msg } or { ok: false, err } (err is null for a silent drop).
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length <= max;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
// NaN serialises to null in JSON, so null is tolerated and treated as 0 downstream.
const numOrNull = (v, lo, hi) => v === undefined || v === null || num(v, lo, hi);
const fail = err => ({ ok: false, err: err || null });
const GAME_KINDS = ['i', 'ready', 'rs', 's', 'start', 'res', 'drop'];

function validInput(d) {
  if (!numOrNull(d.mx, -2, 2) || !numOrNull(d.my, -2, 2) || !numOrNull(d.f, -1e4, 1e4)) return false;
  if (!(d.fr === undefined || d.fr === null || d.fr === 0 || d.fr === 1 || typeof d.fr === 'boolean')) return false;
  if (!numOrNull(d.sv, -1, 1000) || !numOrNull(d.q, 0, 1e9)) return false;
  if (d.a !== undefined && d.a !== null) {
    if (!Array.isArray(d.a) || d.a.length > 12) return false;
    for (const a of d.a) {
      if (!Array.isArray(a) || a.length < 1 || a.length > 4 || !str(a[0], 8)) return false;
      for (let i = 1; i < a.length; i++) if (!(typeof a[i] === 'boolean' || numOrNull(a[i], -1e5, 1e5))) return false;
    }
  }
  return true;
}
function validReady(d) {
  if (d.picks === undefined) return true;
  if (!Array.isArray(d.picks) || d.picks.length > 16) return false;
  return d.picks.every(p => Array.isArray(p) && p.length >= 1 && str(p[0], 32));
}

function validateMsg(m) {
  if (!isObj(m) || typeof m.t !== 'string' || m.t.length > 16) return fail();
  switch (m.t) {
    case 'ping':
      return { ok: true, msg: { t: 'ping', ts: num(m.ts, -1e15, 1e15) ? m.ts : 0 } };
    case 'create': case 'quick': case 'join':
      if (m.name !== undefined && !str(m.name, 64)) return fail('Invalid name.');
      if (m.weapon !== undefined && !str(m.weapon, 32)) return fail('Invalid weapon.');
      if (m.t === 'join' && !str(m.code, 16)) return fail('Invalid room code.');
      return { ok: true, msg: m };
    case 'rejoin':
      if (!str(m.code, 16)) return fail('Invalid room code.');
      if (m.token !== undefined && !str(m.token, 64)) return fail('Invalid token.');
      return { ok: true, msg: m };
    case 'cfg':
      if (m.mode !== undefined && !str(m.mode, 16)) return fail('Invalid game mode.');
      if (m.map !== undefined && !str(m.map, 16)) return fail('Invalid map.');
      if (m.size !== undefined && !num(m.size, 0, 1000)) return fail('Invalid room size.');
      if (m.mods !== undefined && !(Array.isArray(m.mods) && m.mods.length <= 32 && m.mods.every(k => str(k, 32)))) return fail('Invalid modifiers.');
      return { ok: true, msg: m };
    case 'upd':
      if (m.name !== undefined && !str(m.name, 64)) return fail('Invalid name.');
      if (m.weapon !== undefined && !str(m.weapon, 32)) return fail('Invalid weapon.');
      if (m.team !== undefined && m.team !== 0 && m.team !== 1) return fail('Invalid team.');
      return { ok: true, msg: m };
    case 'start': case 'rematch':
      if (m.diff !== undefined && !str(m.diff, 16)) return fail('Invalid difficulty.');
      return { ok: true, msg: m };
    case 'lobby': case 'leave':
      return { ok: true, msg: m };
    case 'r': {
      if (!(m.to === undefined || m.to === '*' || (Number.isInteger(m.to) && m.to >= 0 && m.to <= 1e9))) return fail();
      const d = m.d;
      if (!isObj(d) || !str(d.k, 8) || !GAME_KINDS.includes(d.k)) return fail();
      if (d.k === 'i' && !validInput(d)) return fail();
      if (d.k === 'ready' && !validReady(d)) return fail();
      return { ok: true, msg: m };
    }
    default:
      return fail();
  }
}

// Rate-limit class of a parsed message (used by server.js token buckets).
// input = per-frame player input; ready = loadout pick; host = relay host snapshots/start/results;
// join = join/quick/rejoin; ping = RTT pings; lobby = everything else (create, cfg, upd, start, leave...).
function msgClass(m) {
  const t = m && m.t;
  if (t === 'ping') return 'ping';
  if (t === 'join' || t === 'quick' || t === 'rejoin') return 'join';
  if (t === 'r') {
    const k = m.d && m.d.k;
    if (k === 'i') return 'input';
    if (k === 'ready') return 'ready';
    return 'host';
  }
  return 'lobby';
}

module.exports = { validateMsg, msgClass };
