'use strict';
// Test helpers: start server.js as a child process on a random port and talk to it over WebSocket.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll fn until it returns a truthy value (or throw on timeout).
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(25);
  }
}

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: '0', DEBUG_HOOKS: '1' }, env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '', settled = false;
    const exited = new Promise(r => child.once('exit', r));
    const timer = setTimeout(() => fail(new Error('server did not start in time:\n' + log)), 10000);
    function fail(e) { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} reject(e); }
    const onData = d => {
      log += d;
      const m = /listening on :(\d+)/.exec(log);
      if (m && !settled) {
        settled = true; clearTimeout(timer);
        const srv = {
          port: +m[1], child, clients: [],
          logs: () => log,
          stats() {
            return new Promise((res, rej) => {
              http.get({ host: '127.0.0.1', port: srv.port, path: '/stats' }, r => {
                let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
              }).on('error', rej);
            });
          },
          async stop() {
            for (const c of srv.clients) { try { c.ws.terminate(); } catch (_) {} }
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM');
              const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 6000);
              await exited; clearTimeout(t);
            }
          }
        };
        resolve(srv);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', d => { log += d; });
    child.once('error', fail);
    child.once('exit', code => fail(new Error('server exited early (' + code + '):\n' + log)));
  });
}

// Connect a WebSocket client with a message queue. Do not set X-Forwarded-For (per-IP limits would apply).
function connect(srv) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws');
    const queue = [], waiters = [];
    const flush = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const k = queue.findIndex(m => m.t === w.type && (!w.pred || w.pred(m)));
        if (k >= 0) { const [m] = queue.splice(k, 1); waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); }
      }
    };
    const c = {
      ws, queue,
      send: o => ws.send(JSON.stringify(o)),
      waitFor(type, ms = 3000, pred) {
        return new Promise((res, rej) => {
          const w = { type, pred, resolve: res };
          w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out waiting for "' + type + '" message; queue: ' + JSON.stringify(queue.map(m => m.t)))); }, ms);
          waiters.push(w); flush();
        });
      },
      close() { return new Promise(r => { if (ws.readyState === 3) return r(); ws.once('close', r); ws.close(); }); },
      closed: new Promise(r => ws.once('close', r))
    };
    ws.on('message', raw => { try { queue.push(JSON.parse(raw.toString())); flush(); } catch (_) {} });
    ws.once('open', () => { srv.clients.push(c); resolve(c); });
    ws.once('error', reject);
  });
}

module.exports = { startServer, connect, until, sleep };
