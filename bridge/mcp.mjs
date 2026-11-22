#!/usr/bin/env node
// Nanobrowser as an MCP server over stdio: the tools an agent sees are the layer's own catalogue, forwarded unchanged
// through the bridge, plus the few calls that set up a tab to work in.
//
//   { "mcpServers": { "nanobrowser": { "command": "node", "args": ["<repo>/bridge/mcp.mjs"] } } }
//
// Start bridge/server.mjs (this does it when it is not running), load dist/ in Chrome and turn the local agent
// bridge on in Settings → General. Without the extension the tools still list, from the cached catalogue.
import { existsSync, readFileSync } from 'node:fs';
import { BASE, command, errorOf, status, tools } from './lib.mjs';

const VERSION = '1.0.0';
let buffer = '';
let cached = { at: 0, tools: [] };

// --------------------------------------------------------------- tools

const BRIDGE_TOOLS = [
  {
    name: 'browser_status',
    description:
      'Check that the Nanobrowser extension and the bridge are running. Use this first when a browser call fails with "not connected".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_list_tabs',
    description:
      'List the tabs open in Chrome, with their tabId. Pass a tabId to browser_attach to let the agent act on that tab. Tabs marked attachable:false (chrome://, chrome-extension://, the store) cannot be driven.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_attach',
    description:
      'Share a tab with the agent so the other browser_* tools can act on it. Without a tabId the active tab is used. browser_open opens and attaches in one step.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'A tabId from browser_list_tabs' } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_focus',
    description:
      'Bring a tab to the front: make it the visible tab of its window and raise that window, so the person can watch. The layer itself never focuses a window; this is the one call that does.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_detach',
    description: "Stop acting on a tab and release Chrome's debugger from it.",
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a new tab and attach it. A blank tab is opened when no URL is given.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_call',
    description:
      'Call any browser-control tool by its raw name with raw JSON arguments. Rarely needed: each tool has its own browser_* name.',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string' }, args: { type: 'object' } },
      required: ['tool'],
      additionalProperties: false,
    },
  },
];

async function layerTools() {
  if (cached.tools.length && Date.now() - cached.at < 60_000) return cached.tools;
  try {
    const body = await tools();
    if (body.tools?.length) cached = { at: Date.now(), tools: body.tools };
  } catch {
    // The bridge may not be up yet; the tool list still has the setup tools.
  }
  return cached.tools;
}

async function toolList() {
  const layer = await layerTools();
  const forwarded = layer.map(tool => ({
    name: `browser_${tool.name}`,
    description: `${tool.description}${tool.capability && tool.capability !== 'core' ? ` (needs the "${tool.capability}" capability, enabled for local agents)` : ''}`,
    inputSchema:
      tool.schema && typeof tool.schema === 'object' && tool.schema.type
        ? tool.schema
        : { type: 'object', properties: {}, additionalProperties: true },
  }));
  return [...BRIDGE_TOOLS, ...forwarded];
}

// --------------------------------------------------------------- results

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function format(answer) {
  const error = errorOf(answer);
  if (error) return textResult(`nanobrowser: ${error}`, true);
  const result = answer?.result;
  const content = [];
  if (answer.shot && existsSync(answer.shot)) {
    content.push({ type: 'image', data: readFileSync(answer.shot).toString('base64'), mimeType: 'image/png' });
  }
  if (result && typeof result === 'object' && typeof result.text === 'string') {
    content.push({ type: 'text', text: result.text });
    return { content, ...(result.ok === false ? { isError: true } : {}) };
  }
  content.push({ type: 'text', text: JSON.stringify(result ?? answer, null, 2) });
  return { content };
}

async function callTool(name, args) {
  if (name === 'browser_status') {
    const body = await status();
    const text = body.extension
      ? `Nanobrowser is connected at ${BASE}. ${body.panels?.length ?? 0} panel(s) polling.`
      : `The bridge is running at ${BASE}, but the Nanobrowser extension is not connected. Load dist/ unpacked in Chrome and turn on Settings → General → Local agent bridge.`;
    return textResult(text, !body.extension);
  }
  if (name === 'browser_list_tabs') return format(await command('tabs'));
  if (name === 'browser_attach') {
    return format(await command('attach', args?.tabId === undefined ? {} : { tabId: Number(args.tabId) }));
  }
  if (name === 'browser_focus') {
    return format(await command('focus', args?.tabId === undefined ? {} : { tabId: Number(args.tabId) }));
  }
  if (name === 'browser_detach') {
    return format(await command('detach', args?.tabId === undefined ? {} : { tabId: Number(args.tabId) }));
  }
  if (name === 'browser_open') {
    return format(await command('call', { tool: 'tabs', args: { action: 'open', url: args?.url ?? '' } }));
  }
  if (name === 'browser_call') {
    if (!args?.tool) return textResult('browser_call needs a tool name', true);
    return format(await command('call', { tool: args.tool, args: args.args ?? {} }, { waitMs: 110_000 }));
  }
  const tool = name.replace(/^browser_/, '');
  if (!tool || tool === name) return textResult(`Unknown tool ${name}`, true);
  const waitMs = tool === 'wait' ? 110_000 : 55_000;
  return format(await command('call', { tool, args: args ?? {} }, { waitMs }));
}

// --------------------------------------------------------------- stdio JSON-RPC

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nanobrowser', title: 'Nanobrowser', version: VERSION },
        instructions:
          'Nanobrowser drives the real Chrome you are logged into, through its extension. Call browser_status first. To act on a page, call browser_attach (or browser_open with a URL), then browser_snapshot: it returns refs such as e12 that every other tool takes as a target. Prefer a ref over coordinates. Actions are real input events; there is no approval card, because the person started the agent.',
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') return isRequest ? reply(id, {}) : undefined;
    if (method === 'tools/list') {
      const list = await toolList();
      return reply(id, { tools: list });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      if (!name) return replyError(id, -32602, 'tools/call needs a name');
      const result = await callTool(name, params?.arguments ?? {});
      return reply(id, result);
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'resources/templates/list') return reply(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    if (method === 'logging/setLevel') return isRequest ? reply(id, {}) : undefined;
    if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (isRequest) replyError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function onMessage(message) {
  if (message?.jsonrpc !== '2.0') return;
  void handle(message);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // A malformed line is not a request; MCP clients do not send those.
    }
  }
});
// stdin closing ends the server; nothing else is held open, so the process exits once the last reply is written.

// The bridge is started by the first call that needs it (lib.mjs). Starting it here would race the
// client's initialize, and a client that only lists tools does not need it.

process.stderr.write(`nanobrowser: MCP server ${VERSION}, bridge at ${BASE}\n`);
