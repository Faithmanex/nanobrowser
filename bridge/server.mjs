// The Nanobrowser bridge: a loopback relay that lets an agent on this machine drive the extension.
//
// The extension is a service worker: it cannot accept connections. So it long-polls this server for commands and
// posts back what the layer did, exactly as the side panel would. This file only relays; it never touches a tab,
// never talks to a model and holds no page state beyond the last results it was given.
//
//   node bridge/server.mjs [--port 8788] [--quiet]
//
// Binds 127.0.0.1 only. Agents authenticate with the token in bridge/.token (written on first start, also printed).
// The extension is given the token by GET /pair, which only a chrome-extension:// origin may call.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const HOST = '127.0.0.1';

const argv = process.argv.slice(2);
const option = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(option('--port') ?? process.env.NANOBROWSER_BRIDGE_PORT ?? 8788);
const QUIET = argv.includes('--quiet');
const TOKEN_FILE = join(HERE, '.token');
const SHOTS_DIR = join(HERE, '.shots');
const TOOLS_CACHE = join(HERE, '.tools.json');

const MAX_BODY = 32 * 1024 * 1024;
/** A command nobody collects must not be handed to a later, unrelated request. */
const CMD_TTL = 120_000;
/** How long a dispatched command may go unanswered before it is offered again. The extension de-duplicates by id. */
const REDELIVER_MS = Number(process.env.NANOBROWSER_BRIDGE_REDELIVER_MS ?? 30_000);
const MAX_DELIVERIES = 3;
/** A panel past this age is not polling: the worker slept, or the extension is not installed. */
const PANEL_LIVE_MS = 35_000;
const AGENT_WAIT_MS = 30_000;
const MAX_EVENTS = 1000;
const MAX_RESULTS = 200;

// ------------------------------------------------------------------ token

function loadToken() {
  if (process.env.NANOBROWSER_BRIDGE_TOKEN) return process.env.NANOBROWSER_BRIDGE_TOKEN;
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

const TOKEN = loadToken();
if (!existsSync(SHOTS_DIR)) mkdirSync(SHOTS_DIR, { recursive: true });

// ------------------------------------------------------------------ state

let nextCmdId = 1;
let nextEventId = 1;

/** Commands an agent asked for that no panel has taken yet. */
const queue = [];
/** Commands a panel took and has not answered. Re-offered after REDELIVER_MS so a worker restart loses nothing. */
const inFlight = new Map();
/** Results waiting for the agent that asked (an async command, or one whose wait ended early). */
const results = new Map();
/** Agent requests waiting for a result, by command id. */
const waiters = new Map();
/** One held poll per panel; a new poll replaces it, which also tells us the old connection is gone. */
const polls = new Map();
/** Panels that polled recently: id to its heartbeat. */
const panels = new Map();
const events = [];

let tools = null;
let toolsAt = 0;
try {
  const saved = JSON.parse(readFileSync(TOOLS_CACHE, 'utf8'));
  if (Array.isArray(saved?.tools)) {
    tools = saved.tools;
    toolsAt = Number(saved.at) || 0;
  }
} catch {
  // No cache yet: the first /tools call asks the extension.
}

function addEvent(type, data) {
  events.push({ id: nextEventId++, at: new Date().toISOString(), type, data });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return events[events.length - 1];
}

function touchPanel({ id, label, version, tab }) {
  if (!id) return null;
  const previous = panels.get(id) ?? {};
  const entry = {
    id,
    label: label || previous.label || '',
    version: version || previous.version || '',
    tab: tab || previous.tab || null,
    firstSeen: previous.firstSeen ?? Date.now(),
    lastSeen: Date.now(),
    status: previous.status ?? null,
  };
  panels.set(id, entry);
  return entry;
}

function livePanels() {
  const now = Date.now();
  return [...panels.values()].filter(p => now - p.lastSeen < PANEL_LIVE_MS);
}

function pruneQueue(now = Date.now()) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const cmd = queue[i];
    if (now - cmd.createdAt > (cmd.ttl || CMD_TTL)) {
      queue.splice(i, 1);
      settle(cmd.id, { ok: false, error: { message: 'The command expired before the extension took it.' } });
    }
  }
  for (const [id, cmd] of inFlight) {
    if (now - cmd.deliveredAt > CMD_TTL) {
      inFlight.delete(id);
      settle(id, { ok: false, error: { message: 'The extension took the command but never answered.' } });
    }
  }
}

/** The public shape of a command: no internal bookkeeping. */
function visible(cmd) {
  return { id: cmd.id, type: cmd.type, ...cmd.payload };
}

/** The next command for this panel, redelivering one it never answered before a new one. */
function take(panelId) {
  pruneQueue();
  for (const cmd of inFlight.values()) {
    if (cmd.panel === panelId && Date.now() - cmd.deliveredAt > REDELIVER_MS && cmd.attempts < MAX_DELIVERIES) {
      cmd.deliveredAt = Date.now();
      cmd.attempts++;
      return visible(cmd);
    }
  }
  const index = queue.findIndex(c => !c.panel || c.panel === panelId);
  if (index < 0) return null;
  const [cmd] = queue.splice(index, 1);
  cmd.panel = panelId;
  cmd.deliveredAt = Date.now();
  cmd.attempts = 1;
  inFlight.set(cmd.id, cmd);
  return visible(cmd);
}

function settle(id, payload) {
  inFlight.delete(id);
  results.set(id, { ...payload, id, at: Date.now() });
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
  const waiting = waiters.get(id) ?? [];
  waiters.delete(id);
  for (const resolve of waiting) resolve(payload);
  const entry = queue.find(c => c.id === id) ?? null;
  if (entry) queue.splice(queue.indexOf(entry), 1);
}

/** Enqueues a command for a panel and resolves with the extension's answer, or a timeout. */
function dispatch(payload, waitMs = AGENT_WAIT_MS, panelId = null) {
  const id = `c${nextCmdId++}`;
  const cmd = { id, type: payload.type, payload, panel: panelId, createdAt: Date.now(), ttl: CMD_TTL };
  // A result of the same id from an earlier run must not be mistaken for this one.
  results.delete(id);
  queue.push(cmd);
  addEvent('command', { id, type: cmd.type, from: 'agent' });
  for (const idOfPanel of [...polls.keys()]) {
    if (panelId && idOfPanel !== panelId) continue;
    const next = take(idOfPanel);
    if (!next) break;
    endPoll(idOfPanel, next);
  }
  if (waitMs <= 0) return Promise.resolve({ id, pending: true });
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const list = (waiters.get(id) ?? []).filter(fn => fn !== done);
      waiters.set(id, list);
      resolve({
        id,
        pending: true,
        error: {
          message: livePanels().length
            ? 'The extension took the command but did not answer in time. Ask again or check /status.'
            : 'The Nanobrowser extension is not connected. Load dist/ unpacked, open Settings → General and switch the local agent bridge on, then try again.',
        },
      });
    }, waitMs);
    function done(payload) {
      clearTimeout(timer);
      resolve({ id, ...payload });
    }
    waiters.set(id, [...(waiters.get(id) ?? []), done]);
  });
}

function endPoll(panelId, cmd) {
  const poll = polls.get(panelId);
  if (!poll) return false;
  polls.delete(panelId);
  clearTimeout(poll.timer);
  if (!poll.res.destroyed) json(poll.res, 200, { cmd });
  poll.resolve?.();
  return true;
}

// ------------------------------------------------------------------ http

const CORS_HEADERS = {
  'access-control-allow-headers': 'content-type,x-bridge-token',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
};

function corsFor(origin) {
  // Only extension pages may call from a browser. A web page's Origin is its own site, so it gets no CORS grant and
  // its preflight fails; an agent on this machine sends no Origin at all.
  return origin && origin.startsWith('chrome-extension://')
    ? { ...CORS_HEADERS, 'access-control-allow-origin': origin }
    : { ...CORS_HEADERS, 'access-control-allow-origin': 'null' };
}

function json(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsFor(origin),
  });
  res.end(body);
}

function text(res, status, body, origin) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...corsFor(origin) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** A web page (not an extension page) may never call this server. */
function webOrigin(origin) {
  return !!origin && !origin.startsWith('chrome-extension://');
}

function authorized(req) {
  return req.headers['x-bridge-token'] === TOKEN;
}

function saveShot(result) {
  const data = result?.data;
  if (!data || data.mimeType !== 'image/png' || typeof data.base64 !== 'string') return null;
  const file = join(SHOTS_DIR, `shot-${Date.now()}.png`);
  try {
    writeFileSync(file, Buffer.from(data.base64, 'base64'));
    return file;
  } catch {
    return null;
  }
}

async function toolList() {
  if (tools && Date.now() - toolsAt < 300_000) return { tools, stale: false, at: new Date(toolsAt).toISOString() };
  // Nothing is polling: answer from the cache at once instead of holding an MCP client's first call.
  if (!livePanels().length) {
    return tools
      ? {
          tools,
          stale: true,
          at: new Date(toolsAt).toISOString(),
          error: { message: 'the extension is not connected' },
        }
      : { tools: [], stale: true, error: { message: 'the extension is not connected' } };
  }
  const answer = await dispatch({ type: 'tools' }, 10_000);
  if (answer.result?.tools) {
    tools = answer.result.tools;
    toolsAt = Date.now();
    try {
      writeFileSync(TOOLS_CACHE, JSON.stringify({ at: toolsAt, tools }), 'utf8');
    } catch {
      // A read-only checkout still answers from memory.
    }
    return { tools, stale: false, at: new Date(toolsAt).toISOString() };
  }
  if (tools) return { tools, stale: true, at: new Date(toolsAt).toISOString(), error: answer.error };
  return { tools: [], stale: true, error: answer.error ?? { message: 'The extension did not answer.' } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = req.headers.origin;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsFor(origin));
    return res.end();
  }
  if (webOrigin(origin))
    return json(res, 403, { error: 'this server answers extension pages and local agents only' }, origin);

  try {
    if (path === '/health' && req.method === 'GET') {
      return json(
        res,
        200,
        {
          ok: true,
          service: 'nanobrowser-bridge',
          version: VERSION,
          port: PORT,
          extension: livePanels().length > 0,
          panels: livePanels().length,
        },
        origin,
      );
    }

    // The extension's pairing call. A web page cannot reach it: webOrigin() refused every Origin that is not a
    // chrome-extension:// page, so only the extension (or a local agent that reads bridge/.token anyway) gets here.
    if (path === '/pair' && req.method === 'GET') {
      return json(res, 200, { token: TOKEN, port: PORT, version: VERSION }, origin);
    }

    if (!authorized(req)) {
      return json(res, 401, { error: 'missing or wrong x-bridge-token (see bridge/.token)' }, origin);
    }

    // ---- the extension

    if (path === '/ext/hello' && req.method === 'POST') {
      const body = await readBody(req);
      addEvent('extension', { id: body.id ?? null, label: body.label ?? null, version: body.version ?? null });
      return json(res, 200, { ok: true, version: VERSION }, origin);
    }

    // A held poll keeps the service worker alive; the answer is a command, or null when the wait is over.
    if (path === '/ext/poll' && req.method === 'GET') {
      const panelId = url.searchParams.get('panel') || 'default';
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 20_000), 0), 25_000);
      touchPanel({
        id: panelId,
        label: url.searchParams.get('label') || '',
        version: url.searchParams.get('version') || '',
        tab: url.searchParams.get('tab') || '',
      });
      if (polls.has(panelId)) endPoll(panelId, null);
      const cmd = take(panelId);
      if (cmd) return json(res, 200, { cmd }, origin);
      return new Promise(resolvePoll => {
        const finish = () => {
          if (polls.get(panelId)?.res === res) polls.delete(panelId);
          clearTimeout(timer);
          if (!res.destroyed) json(res, 200, { cmd: null }, origin);
          resolvePoll();
        };
        const timer = setTimeout(finish, wait);
        polls.set(panelId, { res, timer, resolve: resolvePoll });
        res.on('close', () => {
          if (polls.get(panelId)?.res === res) {
            clearTimeout(timer);
            polls.delete(panelId);
          }
        });
      });
    }

    if (path === '/ext/result' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      if (!id) return json(res, 400, { error: 'id is required' }, origin);
      const file = body.result ? saveShot(body.result) : null;
      if (file && body.result?.data) delete body.result.data.base64;
      settle(id, { result: body.result ?? null, error: body.error ?? null, shot: file });
      addEvent('result', { id, ok: !body.error && body.result?.result?.ok !== false });
      return json(res, 200, { ok: true }, origin);
    }

    if (path === '/ext/event' && req.method === 'POST') {
      const body = await readBody(req);
      const panelId = body.panel ?? null;
      if (panelId && panels.has(panelId) && body.status) panels.get(panelId).status = body.status;
      addEvent(body.type || 'event', { ...(body.data ?? {}), panel: panelId });
      return json(res, 200, { ok: true }, origin);
    }

    // ---- an agent on this machine

    if (path === '/status' && req.method === 'GET') {
      const now = Date.now();
      return json(
        res,
        200,
        {
          ok: true,
          bridge: { version: VERSION, port: PORT, tokenFile: TOKEN_FILE },
          extension: livePanels().length > 0,
          panels: [...panels.values()].map(p => ({
            ...p,
            ageMs: now - p.lastSeen,
            live: now - p.lastSeen < PANEL_LIVE_MS,
          })),
          queued: queue.length,
          inFlight: inFlight.size,
          events: events.length,
        },
        origin,
      );
    }

    if (path === '/panels' && req.method === 'GET') {
      return json(res, 200, { panels: livePanels() }, origin);
    }

    if (path === '/tools' && req.method === 'GET') {
      const list = await toolList();
      return json(res, list.tools.length ? 200 : 503, list, origin);
    }

    if (path === '/cmd' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.type) return json(res, 400, { error: 'type is required' }, origin);
      if (!livePanels().length) {
        return json(
          res,
          503,
          {
            ok: false,
            error: {
              message:
                'The Nanobrowser extension is not connected. Load dist/ unpacked in Chrome, open Settings → General and switch the local agent bridge on, then try again.',
            },
          },
          origin,
        );
      }
      const { waitMs, ...payload } = body;
      const answer = await dispatch(payload, waitMs === undefined ? AGENT_WAIT_MS : Number(waitMs), body.panel ?? null);
      return json(res, 200, answer, origin);
    }

    if (path === '/result' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      const answer = results.get(id);
      if (!answer) return json(res, 404, { pending: true, id }, origin);
      results.delete(id);
      return json(res, 200, answer, origin);
    }

    if (path === '/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const after = events.filter(e => e.id > since);
      return json(res, 200, { events: after, last: after.at(-1)?.id ?? since }, origin);
    }

    if (path === '/events/follow' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 20_000), 0), 25_000);
      const start = Date.now();
      const timer = setInterval(() => {
        const after = events.filter(e => e.id > since);
        if (after.length || Date.now() - start >= wait) {
          clearInterval(timer);
          return json(res, 200, { events: after, last: after.at(-1)?.id ?? since }, origin);
        }
      }, 250);
      res.on('close', () => clearInterval(timer));
      return;
    }

    if (path === '/shots' && req.method === 'GET') {
      return json(res, 200, { dir: SHOTS_DIR }, origin);
    }

    return json(res, 404, { error: `no route for ${req.method} ${path}` }, origin);
  } catch (error) {
    return json(res, error?.status || 500, { error: String(error?.message || error) }, origin);
  }
});

server.listen(PORT, HOST, () => {
  if (QUIET) return;
  console.log('');
  console.log(`  Nanobrowser bridge ${VERSION}`);
  console.log(`  listening    http://${HOST}:${PORT}`);
  console.log(`  token        ${TOKEN}`);
  console.log(`  token file   ${TOKEN_FILE}`);
  console.log('');
  console.log('  The extension pairs itself when Settings → General has the bridge on.');
  console.log(`  Try: node ${join('bridge', 'cli.mjs')} status`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
