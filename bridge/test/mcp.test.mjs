// The MCP server over stdio, with a fake extension answering the calls it forwards.
//
//   node --test bridge/test/mcp.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'mcp-test-token';
const EXT = {
  origin: 'chrome-extension://abcdefghijklmnop',
  'x-bridge-token': TOKEN,
  'content-type': 'application/json',
};

let server;
let mcp;
let answering = true;
let stdout = '';
let buffered = [];
let waiters = [];

function send(message) {
  mcp.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Reads the next JSON-RPC message the server writes. */
function next(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no MCP message; output was: ${stdout}`)), timeoutMs);
    waiters.push(message => {
      clearTimeout(timer);
      resolve(message);
    });
    flush();
  });
}

function flush() {
  while (buffered.length && waiters.length) waiters.shift()(buffered.shift());
}

async function request(id, method, params) {
  send({ jsonrpc: '2.0', id, method, params });
  return next();
}

/** The extension side: one long poll at a time, answering what it is handed. */
async function fakeExtension() {
  while (answering) {
    let cmd = null;
    try {
      const response = await fetch(`${BASE}/ext/poll?panel=mcp&wait=1000`, { headers: EXT });
      cmd = (await response.json()).cmd;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    if (!cmd) continue;
    let result;
    if (cmd.type === 'tools') {
      result = {
        ok: true,
        tools: [
          {
            name: 'snapshot',
            description: 'Observe the page.',
            capability: 'core',
            schema: { type: 'object', properties: { mode: { type: 'string' } } },
          },
        ],
      };
    } else if (cmd.type === 'call' && cmd.tool === 'nope') {
      result = {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'Unknown tool nope' },
        text: 'Unknown tool nope',
      };
    } else if (cmd.type === 'call') {
      result = { ok: true, text: `${cmd.tool} ran · 3 refs`, data: { refs: 3 } };
    } else if (cmd.type === 'tabs') {
      result = {
        ok: true,
        tabs: [{ tabId: 7, url: 'https://example.com', title: 'Example', active: true, attachable: true }],
      };
    } else {
      result = { ok: true };
    }
    await fetch(`${BASE}/ext/result`, {
      method: 'POST',
      headers: EXT,
      body: JSON.stringify({ id: cmd.id, result }),
    });
  }
}

before(async () => {
  server = spawn(process.execPath, [join(HERE, '..', 'server.mjs'), '--port', String(PORT), '--quiet'], {
    env: { ...process.env, NANOBROWSER_BRIDGE_TOKEN: TOKEN },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      // not listening yet
    }
  }
  void fakeExtension();
  mcp = spawn(process.execPath, [join(HERE, '..', 'mcp.mjs')], {
    env: { ...process.env, NANOBROWSER_BRIDGE_URL: BASE, NANOBROWSER_BRIDGE_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      buffered.push(JSON.parse(line));
    }
    flush();
  });
});

after(() => {
  answering = false;
  mcp?.kill();
  server?.kill();
});

test('initialize names the server and its tools capability', async () => {
  const answer = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(answer.result.serverInfo.name, 'nanobrowser');
  assert.ok(answer.result.capabilities.tools);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

test('tools/list has the setup tools and the layer tools, with their schemas', async () => {
  const answer = await request(2, 'tools/list', {});
  const names = answer.result.tools.map(tool => tool.name);
  assert.ok(names.includes('browser_status'));
  assert.ok(names.includes('browser_attach'));
  assert.ok(names.includes('browser_snapshot'));
  const snapshot = answer.result.tools.find(tool => tool.name === 'browser_snapshot');
  assert.equal(snapshot.inputSchema.properties.mode.type, 'string');
});

test('a tool call is forwarded and its text comes back', async () => {
  const answer = await request(3, 'tools/call', { name: 'browser_snapshot', arguments: { mode: 'interactive' } });
  assert.equal(answer.result.isError, undefined);
  assert.equal(answer.result.content[0].type, 'text');
  assert.match(answer.result.content[0].text, /snapshot ran/);
});

test('an unknown tool is an error, not a crash', async () => {
  const answer = await request(4, 'tools/call', { name: 'browser_nope', arguments: {} });
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /Unknown tool/);
});

test('an unknown method gets a JSON-RPC error', async () => {
  const answer = await request(5, 'nonsense/method', {});
  assert.equal(answer.error.code, -32601);
});
