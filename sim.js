'use strict';
// Runs the game's own simulation code headlessly inside the server (one isolated VM context per room).
// The page script is loaded with a stand-in for the DOM, so the exact same rules, bots and zombies run here.
const vm = require('vm');

function stub() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      return stub();
    },
    apply: () => stub(), construct: () => stub(), set: () => true, has: () => true
  });
}

function loadPage(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no script in page');
  const vars = {};
  const root = /:root\s*\{([^}]*)\}/.exec(html);
  if (root) for (const d of root[1].split(';')) { const i = d.indexOf(':'); if (i > 0) vars[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  return { script: new vm.Script(m[1], { filename: 'game.js' }), vars };
}

function createSim(page, io) {
  const intervals = new Set();
  const timeouts = new Set();
  const sandbox = {
    console: { log() {}, error: (...a) => console.error('[sim]', ...a), warn() {} },
    performance, Math, JSON,
    setTimeout: (f, ms, ...a) => { const h = setTimeout(() => { timeouts.delete(h); f(...a); }, ms); timeouts.add(h); return h; },
    clearTimeout: h => { clearTimeout(h); timeouts.delete(h); },
    setInterval: (f, ms) => { const h = setInterval(f, ms); intervals.add(h); return h; },
    clearInterval: h => { clearInterval(h); intervals.delete(h); },
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'server', maxTouchPoints: 0, vibrate() {}, getGamepads: () => [] },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: n => page.vars[n.trim()] || '#888888' }),
    document: stub(), location: { protocol: 'http:', host: 'localhost' }
  };
  sandbox.document = new Proxy(stub(), {
    get: (t, k) => (k === 'hidden' ? false : k === 'documentElement' ? { dataset: {}, style: {} } : stub()),
    set: () => true
  });
  sandbox.window = sandbox;
  sandbox.__SIM = { api: null, rel: (to, d) => io.rel(to, d), send: o => io.send && io.send(o) };
  const ctx = vm.createContext(sandbox);
  page.script.runInContext(ctx);
  const api = sandbox.__SIM.api;
  if (!api) throw new Error('simulation API missing');
  return {
    api,
    stop() { for (const h of intervals) clearInterval(h); intervals.clear(); for (const h of timeouts) clearTimeout(h); timeouts.clear(); api.NET.live = false; api.NET.m = null; }
  };
}
module.exports = { loadPage, createSim };
