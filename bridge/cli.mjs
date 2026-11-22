#!/usr/bin/env node
// The bridge's command line: one command per call, for a person or for a script that wants a shell instead of MCP.
//
//   node bridge/cli.mjs status
//   node bridge/cli.mjs tabs
//   node bridge/cli.mjs attach 1234
//   node bridge/cli.mjs open https://example.com
//   node bridge/cli.mjs snap
//   node bridge/cli.mjs click e12
//   node bridge/cli.mjs fill e3 "ada@example.com"
//   node bridge/cli.mjs shot page.png
//
// The server and the extension must be running; this starts the server if it is not, and says so when the extension
// is not connected. Full tool list: node bridge/cli.mjs tools
import { existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASE,
  argsJson,
  command,
  ensureServer,
  errorOf,
  events,
  parseArgs,
  status,
  targetOf,
  textOf,
  tools,
} from './lib.mjs';

const [name, ...rest] = process.argv.slice(2);
const { positional, values } = parseArgs(rest);
const json = values.json === true;

function fail(message, code = 1) {
  console.error(`nanobrowser: ${message}`);
  process.exitCode = code;
}

function printAnswer(answer) {
  const error = errorOf(answer);
  if (error) return fail(error, answer?.pending ? 2 : 1);
  const result = answer.result;
  if (json) {
    console.log(JSON.stringify(result ?? answer, null, 2));
  } else if (result && typeof result.text === 'string') {
    console.log(result.text);
  } else {
    console.log(JSON.stringify(result ?? answer, null, 2));
  }
  if (result && result.ok === false) process.exitCode = 1;
}

async function call(tool, args = {}) {
  const answer = await command('call', { tool, args });
  printAnswer(answer);
  return answer;
}

function number(name) {
  return values[name] === undefined ? undefined : Number(values[name]);
}

const usage = `Nanobrowser bridge CLI

  status                         bridge, extension and panels
  tools [--json]                 the layer's tool catalogue and schemas
  tabs [--json]                  Chrome tabs, with the ones that can be attached
  attach [tabId]                 share a tab (default: the active one)
  detach [tabId]                 release a tab
  open <url>                     open a tab and attach it
  snap [--mode interactive]      observe the page (refs come from here)
  find [--role r] [--name n] [--text t]
  read [--ref e1] [--max 4000] [--format text]
  click <ref | --role --name | --x --y>
  fill <ref> <value> [--submit]  set a field, checkbox or select
  type <text> [--ref e1]         type key by key
  press <keys>                   a key or chord, such as Enter or Control+A
  hover <ref>
  scroll [--to top|bottom] [--px 500] [--pages 1] [--ref e1]
  wait [--text t] [--ms 1000] [--url part]
  nav <url | back | forward | reload>
  shot [file.png] [--full] [--ref e1] [--labels]
  upload <path> [path...] [--ref e1]
  dialog accept | dismiss [--text reply]
  call <tool> [json]             any layer tool, raw
  events [--since 0] [--follow 20]
  stop                           abort the running call
  mcp-config                     the config line for an MCP client

Flags: --json (raw result), --tab <id> (the tab to act on).
`;

try {
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.log(usage);
    process.exitCode = name ? 0 : 2;
  } else if (name === 'status') {
    const body = await status();
    if (json) console.log(JSON.stringify(body, null, 2));
    else {
      console.log(`bridge      ${BASE}  ${body.bridge?.version ?? '?'}`);
      console.log(`extension   ${body.extension ? 'connected' : 'not connected'}`);
      for (const panel of body.panels ?? []) {
        console.log(
          `panel       ${panel.label || panel.id} · ${panel.live ? 'polling' : `silent ${Math.round(panel.ageMs / 1000)}s`}`,
        );
      }
      console.log(`queue       ${body.queued ?? 0} waiting, ${body.inFlight ?? 0} in flight`);
    }
  } else if (name === 'tools') {
    const body = await tools();
    if (json) console.log(JSON.stringify(body, null, 2));
    else {
      if (body.stale) console.error(`nanobrowser: ${body.error?.message ?? 'the catalogue is cached'}`);
      for (const tool of body.tools ?? []) console.log(`${tool.name.padEnd(14)} ${tool.description}`);
    }
    if (!body.tools?.length) process.exitCode = 1;
  } else if (name === 'tabs') {
    const answer = await command('tabs');
    if (json) console.log(JSON.stringify(answer.result ?? answer, null, 2));
    else if (errorOf(answer)) fail(errorOf(answer));
    else {
      for (const tab of answer.result?.tabs ?? []) {
        const mark = tab.active ? '*' : ' ';
        const can = tab.attachable ? '' : ' (not attachable)';
        console.log(`${mark} ${String(tab.tabId).padStart(5)}  ${tab.title || '(untitled)'} — ${tab.url}${can}`);
      }
    }
  } else if (name === 'attach') {
    const tabId = positional[0] === undefined ? undefined : Number(positional[0]);
    const answer = await command('attach', tabId === undefined ? {} : { tabId });
    if (json) console.log(JSON.stringify(answer.result ?? answer, null, 2));
    else if (errorOf(answer)) fail(errorOf(answer));
    else {
      const r = answer.result;
      console.log(`attached tab ${r.tabId} · ${r.title || '(untitled)'} · ${r.url}`);
      console.log('now: node bridge/cli.mjs snap');
    }
  } else if (name === 'detach') {
    const tabId = positional[0] === undefined ? undefined : Number(positional[0]);
    printAnswer(await command('detach', tabId === undefined ? {} : { tabId }));
  } else if (name === 'open') {
    if (!positional[0]) fail('open needs a URL');
    else printAnswer(await command('call', { tool: 'tabs', args: { action: 'open', url: positional[0] } }));
  } else if (name === 'snap' || name === 'snapshot' || name === 'observe') {
    const args = {
      ...(values.mode ? { mode: values.mode } : {}),
      ...(values.scope ? { scope: values.scope } : {}),
      ...(values.window ? { window: values.window } : {}),
      ...(values.tab !== undefined ? { tabId: number('tab') } : {}),
    };
    await call('snapshot', args);
  } else if (name === 'find') {
    await call('find', {
      ...(values.role ? { role: values.role } : {}),
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.text !== undefined ? { text: values.text } : {}),
      ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
      ...(values.within !== undefined ? { within: values.within } : {}),
    });
  } else if (name === 'read') {
    await call('read', {
      ...(values.ref ? { ref: values.ref } : {}),
      ...(values.max !== undefined ? { maxChars: Number(values.max) } : {}),
      ...(values.format ? { format: values.format } : {}),
    });
  } else if (name === 'click') {
    const target = targetOf(values, positional);
    if (!target) fail('click needs a ref, a role and name, or x and y');
    else await call('click', { target });
  } else if (name === 'fill') {
    const target = targetOf(values, positional);
    const value = positional.slice(1).join(' ');
    if (!target || !value) fail('fill needs a ref and a value');
    else await call('set', { target, value, ...(values.submit === true ? { submit: true } : {}) });
  } else if (name === 'type') {
    const text = positional.join(' ');
    if (!text) fail('type needs text');
    else await call('type', { text, ...(values.ref ? { target: { ref: values.ref } } : {}) });
  } else if (name === 'press') {
    if (!positional[0]) fail('press needs a key or chord');
    else await call('press', { keys: positional[0] });
  } else if (name === 'hover') {
    const target = targetOf(values, positional);
    if (!target) fail('hover needs a ref');
    else await call('hover', { target });
  } else if (name === 'scroll') {
    await call('scroll', {
      ...(values.to ? { to: values.to } : {}),
      ...(values.px !== undefined || values.pages !== undefined
        ? {
            by: {
              ...(values.px !== undefined ? { px: Number(values.px) } : {}),
              ...(values.pages !== undefined ? { pages: Number(values.pages) } : {}),
            },
          }
        : {}),
      ...(values.ref ? { target: { ref: values.ref } } : {}),
    });
  } else if (name === 'wait') {
    await call('wait', {
      ...(values.text !== undefined ? { text: values.text } : {}),
      ...(values['text-gone'] !== undefined ? { textGone: values['text-gone'] } : {}),
      ...(values.url !== undefined ? { url: values.url } : {}),
      ...(values.ms !== undefined ? { ms: Number(values.ms) } : {}),
    });
  } else if (name === 'nav' || name === 'navigate') {
    const to = positional[0];
    if (!to) fail('nav needs a URL, back, forward or reload');
    else if (['back', 'forward', 'reload'].includes(to)) await call('navigate', { action: to });
    else await call('navigate', { url: to });
  } else if (name === 'shot' || name === 'screenshot') {
    const answer = await command('call', {
      tool: 'screenshot',
      args: {
        ...(values.full === true ? { fullPage: true } : {}),
        ...(values.ref ? { ref: values.ref } : {}),
        ...(values.labels === true ? { labels: true } : {}),
      },
    });
    const error = errorOf(answer);
    if (error) fail(error);
    else if (answer.shot) {
      const wanted = positional[0] ? resolve(positional[0]) : null;
      if (wanted && existsSync(answer.shot)) copyFileSync(answer.shot, wanted);
      const data = answer.result?.data ?? {};
      console.log(
        `${wanted ? `saved ${wanted}` : `saved ${answer.shot}`}${data.width ? ` · ${data.width}×${data.height}` : ''}`,
      );
    } else {
      // A screenshot the bridge could not save still carries its receipt text.
      printAnswer(answer);
    }
  } else if (name === 'upload') {
    if (!positional.length) fail('upload needs at least one file path');
    else
      await call('upload', {
        paths: positional.map(p => resolve(p)),
        ...(values.ref ? { target: { ref: values.ref } } : {}),
      });
  } else if (name === 'dialog') {
    const accept = positional[0] !== 'dismiss';
    await call('handle_dialog', { accept, ...(values.text !== undefined ? { promptText: String(values.text) } : {}) });
  } else if (name === 'call') {
    const tool = positional.shift();
    if (!tool) fail('call needs a tool name');
    else await call(tool, argsJson(values, positional));
  } else if (name === 'events') {
    let since = Number(values.since ?? 0);
    const follow = values.follow === undefined ? 0 : Number(values.follow) * 1000;
    if (!follow) {
      const body = await events({ since });
      console.log(JSON.stringify(body, null, 2));
    } else {
      const deadline = Date.now() + follow;
      while (Date.now() < deadline) {
        const body = await events({ since, waitMs: Math.min(20_000, deadline - Date.now()) });
        for (const event of body.events ?? []) {
          if (event.type === 'result') continue;
          console.log(JSON.stringify(event));
          since = event.id;
        }
      }
    }
  } else if (name === 'stop') {
    printAnswer(await command('abort'));
  } else if (name === 'mcp-config') {
    const file = resolve(import.meta.dirname, 'mcp.mjs');
    console.log(JSON.stringify({ mcpServers: { nanobrowser: { command: process.execPath, args: [file] } } }, null, 2));
  } else {
    fail(`unknown command "${name}"\n\n${usage}`, 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1);
}
