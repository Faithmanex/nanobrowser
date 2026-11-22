// End to end: a real Chrome with the built extension, the bridge, and the same commands an agent sends.
//
//   node bridge/test/e2e.mjs
//
// Needs dist/ (pnpm build), stable Chrome for Testing (pnpm install-chrome) and port 8788 free. It opens fixture pages
// from fixtures/server.mjs, drives them through the bridge, and checks what the layer reports and what the page holds.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT as FIXTURE_PORT, startServer } from '../../fixtures/server.mjs';
import { findChrome } from '../../fixtures/find-chrome.mjs';
import { command, ensureServer, status } from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST = join(ROOT, 'dist');
const PROFILE = mkdtempSync(join(tmpdir(), 'nb-bridge-e2e-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let chrome;
let fixtures;
let failed = 0;
let panelId;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS ${name}`))
    .catch(error => {
      failed++;
      console.log(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function cli(...args) {
  return execFileSync(process.execPath, [join(ROOT, 'bridge', 'cli.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NANOBROWSER_BRIDGE_PORT: '8788' },
  });
}

async function cleanup() {
  if (chrome?.pid) {
    // Chrome runs a tree of processes; kill it whole so the profile's files are released.
    try {
      execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        chrome.kill();
      } catch {
        // already gone
      }
    }
  }
  try {
    fixtures?.close();
  } catch {
    // already closed
  }
  await sleep(1200);
  // A profile Chrome has not let go of can stay behind; it is a temp folder, not a result.
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // left for the OS to clean
  }
}

try {
  if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('dist/ is missing; run pnpm build first');
  await ensureServer();
  // Other Chrome profiles may already be polling (a person's own browser). Record them, then target the instance this
  // run launches by its panel id.
  const known = new Set((await status()).panels.map(panel => panel.id));
  fixtures = await startServer();
  chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${DIST}`,
      `--disable-extensions-except=${DIST}`,
      '--use-mock-keychain',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--window-size=1280,900',
      '--lang=en-US',
      '--accept-lang=en-US',
      '--headless=new',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  const chromeLog = [];
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', chunk => chromeLog.push(chunk));

  await check('the extension connects to the bridge on its own', async () => {
    panelId = await waitFor(
      async () => {
        const state = await status();
        return state.panels.find(panel => panel.live && !known.has(panel.id))?.id ?? null;
      },
      60_000,
      'the launched extension to poll',
    );
    assert.ok(panelId);
  });

  const cmd = (type, payload = {}) => command(type, payload, { panel: panelId });
  const opened = await cmd('call', {
    tool: 'tabs',
    args: { action: 'open', url: `http://localhost:${FIXTURE_PORT}/form.html` },
  });
  const tabId = opened.result?.data?.opened;

  await check('a tab opens and joins the session', async () => {
    assert.equal(opened.result?.ok, true, opened.result?.text);
    assert.equal(typeof tabId, 'number');
  });

  const snapshot = await cmd('call', { tool: 'snapshot', args: { tabId, mode: 'interactive' } });
  await check('snapshot prints refs and the page header', async () => {
    assert.equal(snapshot.result?.ok, true, snapshot.result?.text);
    assert.match(snapshot.result.text, /Observation form|tab \d+/);
    assert.match(snapshot.result.text, /\ba\d+\b/);
  });

  const found = await cmd('call', { tool: 'find', args: { tabId, role: 'textbox', name: 'Full name' } });
  const ref = found.result?.data?.[0]?.ref;
  await check('find resolves a ref without a model', async () => {
    assert.equal(found.result?.ok, true, found.result?.text);
    assert.match(String(ref), /^a\d+$/);
  });

  const set = await cmd('call', { tool: 'set', args: { tabId, target: { ref }, value: 'Grace Hopper' } });
  await check('set writes the field and reads it back', async () => {
    assert.equal(set.result?.ok, true, set.result?.text);
    assert.match(set.result.text, /Grace Hopper/);
  });

  const click = await cmd('call', {
    tool: 'click',
    args: { tabId, target: { role: 'button', name: 'More options' } },
  });
  await check('click dispatches trusted input and reports a receipt', async () => {
    assert.equal(click.result?.ok, true, click.result?.text);
    assert.equal(click.result.receipt?.dispatched, true);
  });

  const read = await cmd('call', { tool: 'read', args: { tabId, maxChars: 600 } });
  await check('read returns the page text', async () => {
    assert.equal(read.result?.ok, true, read.result?.text);
    assert.match(read.result.text, /Observation form/);
  });

  const shot = await cmd('call', { tool: 'screenshot', args: { tabId } });
  await check('a screenshot is saved as a PNG', async () => {
    assert.equal(shot.result?.ok, true, shot.result?.text);
    assert.ok(shot.shot, 'the bridge should save the PNG');
    const png = readFileSync(shot.shot);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 1000);
  });

  await check('the CLI drives the same session', async () => {
    const out = cli('snap', '--mode', 'interactive', '--panel', panelId);
    assert.match(out, /\ba\d+\b/);
    const state = cli('status');
    assert.match(state, /extension\s+connected/);
  });

  const detached = await cmd('detach', { tabId });
  await check('detach releases the tab', async () => {
    assert.equal(detached.result?.ok, true, detached.error?.message ?? detached.result?.text);
    assert.ok(!(detached.result.tabs ?? []).includes(tabId));
  });

  console.log(`\n${failed ? `FAILED ${failed}` : 'all end-to-end checks passed'}`);
  if (failed) {
    const tail = chromeLog
      .join('')
      .split('\n')
      .filter(line => line.includes('ERROR') || line.includes('extension'))
      .slice(-10);
    if (tail.length) console.log(`\nChrome said:\n${tail.join('\n')}`);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await cleanup();
}
