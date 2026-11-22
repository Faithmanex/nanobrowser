// The bridge's relay, without Chrome: a fake extension long-polls and answers, an agent sends commands.
//
//   node --test bridge/test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';
const EXT = {
  origin: 'chrome-extension://abcdefghijklmnop',
  'x-bridge-token': TOKEN,
  'content-type': 'application/json',
};
const AGENT = { 'x-bridge-token': TOKEN, 'content-type': 'application/json' };
let server;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function get(path, headers = AGENT) {
  const response = await fetch(`${BASE}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

async function post(path, body, headers = AGENT) {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

/** One long poll, as the extension makes it. Resolves with the command it was handed. */
async function poll(panel = 'p1', wait = 1000) {
  const response = await fetch(`${BASE}/ext/poll?panel=${panel}&wait=${wait}`, { headers: EXT });
  assert.equal(response.status, 200);
  return (await response.json()).cmd;
}

before(async () => {
  server = spawn(process.execPath, [join(HERE, '..', 'server.mjs'), '--port', String(PORT), '--quiet'], {
    env: { ...process.env, NANOBROWSER_BRIDGE_TOKEN: TOKEN, NANOBROWSER_BRIDGE_REDELIVER_MS: '300' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      if ((await get('/health')).body.service === 'nanobrowser-bridge') return;
    } catch {
      // not listening yet
    }
  }
  throw new Error('the bridge did not start');
});

after(() => server?.kill());

test('health needs no token', async () => {
  const { status, body } = await get('/health', {});
  assert.equal(status, 200);
  assert.equal(body.service, 'nanobrowser-bridge');
  assert.equal(body.extension, false);
});

test('the extension pairs; a web page does not', async () => {
  const pair = await get('/pair', { origin: EXT.origin });
  assert.equal(pair.status, 200);
  assert.equal(pair.body.token, TOKEN);

  const page = await get('/pair', { origin: 'https://evil.example' });
  assert.equal(page.status, 403);
});

test('agent routes require the token', async () => {
  assert.equal((await get('/status', {})).status, 401);
  assert.equal((await post('/cmd', { type: 'status' }, {})).status, 401);
});

test('a command with no extension connected fails with a useful message', async () => {
  const { status, body } = await post('/cmd', { type: 'status', waitMs: 500 });
  assert.equal(status, 503);
  assert.match(body.error.message, /extension is not connected/i);
});

test('a held poll takes the next command and returns its result to the agent', async () => {
  const waiting = poll('p1', 5000);
  // The poll is held; the command arrives after it.
  await sleep(150);
  const sending = post('/cmd', { type: 'status', waitMs: 5000 });
  const cmd = await waiting;
  assert.equal(cmd.type, 'status');
  assert.ok(cmd.id);

  await post('/ext/result', { id: cmd.id, result: { ok: true, session: { id: 's1' } } }, EXT);
  const answer = await sending;
  assert.equal(answer.status, 200);
  assert.equal(answer.body.result.ok, true);
  assert.equal(answer.body.result.session.id, 's1');
});

test('a poll with nothing to hand over ends as an empty answer', async () => {
  const start = Date.now();
  const cmd = await poll('p2', 200);
  assert.equal(cmd, null);
  assert.ok(Date.now() - start >= 180);
});

test('an unanswered command is offered again to the same panel', async () => {
  const first = poll('p3', 5000);
  await sleep(100);
  const sending = post('/cmd', { type: 'tabs', waitMs: 5000 });
  const cmd = await first;
  assert.equal(cmd.type, 'tabs');
  // No result is posted; the next poll after the redelivery window gets it again, with the same id.
  await sleep(400);
  const again = await poll('p3', 3000);
  assert.equal(again?.id, cmd.id);
  await post('/ext/result', { id: cmd.id, result: { ok: true, tabs: [] } }, EXT);
  const answer = await sending;
  assert.equal(answer.body.result.ok, true);
});

test('the tool catalogue is asked of the extension', async () => {
  const waiting = poll('p4', 5000);
  const asking = get('/tools');
  const cmd = await waiting;
  assert.equal(cmd.type, 'tools');
  await post(
    '/ext/result',
    {
      id: cmd.id,
      result: { ok: true, tools: [{ name: 'snapshot', description: 'observe', schema: { type: 'object' } }] },
    },
    EXT,
  );
  const first = await asking;
  assert.equal(first.status, 200);
  assert.equal(first.body.tools[0].name, 'snapshot');
  assert.equal(first.body.stale, false);
});

test('events are kept with increasing ids', async () => {
  await post('/ext/event', { panel: 'p1', type: 'audit', data: { tool: 'snapshot' } }, EXT);
  const { body } = await get('/events?since=0');
  assert.ok(body.events.some(event => event.type === 'audit'));
  assert.ok(body.last >= 1);
});

test('status reports the live panel', async () => {
  const { body } = await get('/status');
  assert.equal(body.extension, true);
  assert.ok(body.panels.some(panel => panel.id === 'p1' && panel.live));
});
