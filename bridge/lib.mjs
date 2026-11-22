// Shared plumbing for the bridge's CLI and MCP server: start the server if it is not running, authenticate, and
// turn one command into one answer.
//
// The token lives in bridge/.token, written by the server on its first start. The extension pairs itself; agents read
// the file. Nothing here talks to a model or to a page directly.
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, '.token');
const LOG_FILE = join(HERE, '.server.log');

export const PORT = Number(process.env.NANOBROWSER_BRIDGE_PORT ?? 8788);
export const BASE = process.env.NANOBROWSER_BRIDGE_URL ?? `http://127.0.0.1:${PORT}`;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function token() {
  if (process.env.NANOBROWSER_BRIDGE_TOKEN) return process.env.NANOBROWSER_BRIDGE_TOKEN;
  if (!existsSync(TOKEN_FILE)) return null;
  const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
  return saved || null;
}

export async function request(path, init = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(token() ? { 'x-bridge-token': token() } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && !body.error) body.error = { message: `the bridge answered ${response.status}` };
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function health(timeoutMs = 1500) {
  try {
    return await request('/health', {}, timeoutMs);
  } catch {
    return null;
  }
}

/** Starts bridge/server.mjs detached when nothing answers, and waits until it does. */
export async function ensureServer({ quiet = true } = {}) {
  const running = await health();
  if (running?.service === 'nanobrowser-bridge') return running;
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [join(HERE, 'server.mjs'), ...(quiet ? ['--quiet'] : [])], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(join(HERE, '.server.pid'), `${child.pid}\n`, 'utf8');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(150);
    const ready = await health(1000);
    if (ready?.service === 'nanobrowser-bridge') return ready;
  }
  throw new Error(`the bridge did not start; see ${LOG_FILE}`);
}

export async function status() {
  await ensureServer();
  return request('/status');
}

export async function tools({ ensure = true } = {}) {
  if (ensure) await ensureServer();
  return request('/tools', {}, 15_000);
}

/**
 * Sends one command and waits for the extension's answer. `waitMs` is the bridge's patience; the HTTP timeout is
 * longer, so the bridge's own message (extension not connected, no answer) is what the caller sees.
 */
export async function command(type, payload = {}, { waitMs = 90_000, panel } = {}) {
  await ensureServer();
  // A panel id targets one extension instance (one Chrome profile) when more than one is polling.
  const target = panel ?? process.env.NANOBROWSER_BRIDGE_PANEL ?? null;
  const answer = await request(
    '/cmd',
    { method: 'POST', body: JSON.stringify({ type, ...payload, waitMs, ...(target ? { panel: target } : {}) }) },
    waitMs + 20_000,
  );
  return answer;
}

export async function events({ since = 0, waitMs = 0 } = {}) {
  await ensureServer();
  if (!waitMs) return request(`/events?since=${since}`, {}, 10_000);
  return request(`/events/follow?since=${since}&wait=${Math.min(waitMs, 25_000)}`, {}, 30_000);
}

/** The error line for an answer that did not carry a usable result. */
export function errorOf(answer) {
  if (!answer) return 'no answer';
  if (answer.error)
    return typeof answer.error === 'string' ? answer.error : answer.error.message || JSON.stringify(answer.error);
  if (answer.pending) return 'the extension did not answer in time';
  return null;
}

/** The layer's `text` when the answer is a tool result, else the whole answer as JSON. */
export function textOf(answer) {
  const result = answer?.result;
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text;
  if (result && typeof result === 'object' && typeof result.ok === 'boolean')
    return result.text ?? JSON.stringify(result);
  return JSON.stringify(result ?? answer, null, 2);
}

/** A target from `--ref e1`, `--role button --name Save`, or `--x 120 --y 300`. */
export function targetOf(values, positional) {
  if (values.ref || values.target) return { ref: String(values.ref ?? values.target) };
  if (values.role) {
    const target = { role: String(values.role) };
    if (values.name !== undefined) target.name = String(values.name);
    if (values.nth !== undefined) target.nth = Number(values.nth);
    if (values.within !== undefined) target.within = String(values.within);
    return target;
  }
  if (values.x !== undefined && values.y !== undefined) return { x: Number(values.x), y: Number(values.y) };
  if (positional[0]) return { ref: String(positional[0]) };
  return null;
}

/** A tiny flag parser: `--name value`, `--name=value`, and everything else positional. */
export function parseArgs(argv) {
  const positional = [];
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) values[name] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) values[name] = argv[++i];
    else values[name] = true;
  }
  return { positional, values };
}

export function argsJson(values, positional) {
  if (values.args) return JSON.parse(String(values.args));
  if (positional[0]?.trim().startsWith('{')) return JSON.parse(positional[0]);
  return {};
}
