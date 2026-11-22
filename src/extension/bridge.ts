// The local agent bridge: a loopback relay an agent on this machine drives the layer through.
//
// The extension cannot accept a connection, so it long-polls the bridge (bridge/server.mjs) and answers with what the
// layer did. The bridge only relays: every action still goes through this worker, through the same session, gates and
// receipts the side panel's agent uses. The session is its own: actions from the bridge never land in a conversation.
//
// Turned on in Settings → General → Local agent bridge. Without the bridge running, the loop retries quietly and
// everything else works as before.
import type { Controller, Session } from '@src/browser-control';
import { argsJsonSchema } from '@src/browser-control';
import { controllerReady } from './layer';
import {
  BRIDGE_PANEL_KEY,
  BRIDGE_TOKEN_KEY,
  BRIDGE_URL,
  bridgeStatusStorage,
  type BridgeStatus,
} from '@src/store/bridge';
import { settingsStorage, siteRulesStorage } from '@src/store/settings';

/** A command as the bridge hands it over. */
interface BridgeCommand {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface DoneEntry {
  at: number;
  result?: unknown;
  error?: string | null;
}

const POLL_WAIT_MS = 20_000;
const POLL_TIMEOUT_MS = POLL_WAIT_MS + 8_000;
const RETRY_MS = 2_000;
/** After a disconnect, the status is written at most this often while retrying. */
const STATUS_THROTTLE_MS = 10_000;
const DONE_KEY = 'nb.bridge.done';
const DONE_TTL_MS = 10 * 60_000;
const DONE_MAX = 200;
const ALARM = 'nb.bridge.watchdog';
const LABELS = ['[Nanobrowser note', 'browser-state', 'agent-notes'];

let enabled = false;
let running = false;
let connected = false;
let token: string | null = null;
let panelId = '';
let pollAbort: AbortController | null = null;
let currentCall: AbortController | null = null;
let chain: Promise<void> = Promise.resolve();
let epoch = 0;
let lastError: string | null = null;
let lastStatusWrite = 0;

let sessionReady: Promise<{ controller: Controller; session: Session }> | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function setStatus(patch: Partial<BridgeStatus> = {}, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastStatusWrite < STATUS_THROTTLE_MS && !('connected' in patch) && !('enabled' in patch)) return;
  lastStatusWrite = now;
  try {
    await bridgeStatusStorage.set(previous => ({
      ...previous,
      enabled,
      connected,
      url: BRIDGE_URL,
      panelId,
      error: lastError,
      ...patch,
    }));
  } catch (error) {
    console.warn('[bridge] status write failed', error);
  }
}

async function ensurePanelId(): Promise<string> {
  if (panelId) return panelId;
  try {
    const stored = await chrome.storage.session.get(BRIDGE_PANEL_KEY);
    const saved = stored[BRIDGE_PANEL_KEY];
    if (typeof saved === 'string' && saved) panelId = saved;
  } catch {
    // Storage may be unavailable during a worker start; an in-memory id still works for this run.
  }
  if (!panelId) panelId = crypto.randomUUID();
  void chrome.storage.session.set({ [BRIDGE_PANEL_KEY]: panelId }).catch(() => undefined);
  return panelId;
}

/** The layer session the bridge drives. One, created on first use, with its own tabs. */
async function layer(): Promise<{ controller: Controller; session: Session }> {
  if (sessionReady) return sessionReady;
  sessionReady = (async () => {
    const controller = await controllerReady;
    const session = controller.createSession({
      // The agent runs on the user's machine, so the session gets what a local pilot needs: screenshots and
      // coordinate targets, CSS selectors, and files from disk. No `human`: there is no one to answer ask_user.
      capabilities: ['vision', 'selector', 'files'],
      // The person at the keyboard is the one who started the agent: nothing asks for approval it cannot see.
      confirm: 'never',
      uploadSources: ['paths', 'attachments'],
      boundary: { labels: LABELS },
    });
    // The user's blocked sites apply here too; the bridge is no way around a rule set in Settings.
    try {
      const rules = await siteRulesStorage.get();
      const blocked = Object.entries(rules)
        .filter(([, entry]) => entry.rule === 'block')
        .map(([site]) => site);
      if (blocked.length) await session.setUrlPolicy({ ...session.urlPolicy, blocked });
    } catch {
      // No rules stored yet.
    }
    controller.onAudit(entry => {
      if (entry.sessionId === session.id) void event('audit', entry);
    });
    return { controller, session };
  })();
  return sessionReady;
}

// ------------------------------------------------------------------ the bridge connection

async function readToken(): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(BRIDGE_TOKEN_KEY);
    return typeof stored[BRIDGE_TOKEN_KEY] === 'string' ? stored[BRIDGE_TOKEN_KEY] : null;
  } catch {
    return null;
  }
}

/** The bridge hands its token to a chrome-extension:// origin only; the extension keeps it. */
async function pair(): Promise<string> {
  const response = await fetch(`${BRIDGE_URL}/pair`, { headers: { 'x-nanobrowser-pair': '1' } });
  if (!response.ok) throw new Error(`the bridge refused pairing (${response.status})`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('the bridge sent no token');
  token = body.token;
  await chrome.storage.local.set({ [BRIDGE_TOKEN_KEY]: body.token });
  return body.token;
}

async function poll(t: string): Promise<BridgeCommand | null> {
  const abort = new AbortController();
  pollAbort = abort;
  const timer = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({
      panel: await ensurePanelId(),
      wait: String(POLL_WAIT_MS),
      label: `nanobrowser ${chrome.runtime.getManifest().version}`,
      version: chrome.runtime.getManifest().version,
    });
    const response = await fetch(`${BRIDGE_URL}/ext/poll?${query}`, {
      headers: { 'x-bridge-token': t },
      signal: abort.signal,
    });
    if (response.status === 401) {
      // The bridge restarted with another token: forget it and pair again on the next pass.
      token = null;
      await chrome.storage.local.remove(BRIDGE_TOKEN_KEY).catch(() => undefined);
      throw new Error('the bridge did not accept the pairing token');
    }
    if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
    const body = (await response.json()) as { cmd?: BridgeCommand | null };
    return body.cmd ?? null;
  } finally {
    clearTimeout(timer);
    if (pollAbort === abort) pollAbort = null;
  }
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  let warned: string | null = null;
  try {
    while (running && enabled) {
      try {
        const t = token ?? (await readToken()) ?? (await pair());
        const cmd = await poll(t);
        if (!running || !enabled) break;
        if (!connected) console.info('[bridge] connected to', BRIDGE_URL);
        connected = true;
        lastError = null;
        warned = null;
        await setStatus({ lastSeenAt: new Date().toISOString(), connected: true });
        if (cmd) void handle(cmd);
      } catch (error) {
        if (!running || !enabled) break;
        if (connected) console.info('[bridge] disconnected', messageOf(error));
        connected = false;
        lastError = messageOf(error);
        if (warned !== lastError) {
          // The bridge is optional: once per distinct failure, not on every retry.
          console.info('[bridge]', lastError);
          warned = lastError;
        }
        await setStatus({ connected: false, error: lastError }, true);
        await sleep(RETRY_MS);
      }
    }
  } finally {
    running = false;
  }
}

/** Stops the loop and aborts what is in flight. The bridge stays untouched; it may be stopped by itself. */
function stop(): void {
  running = false;
  epoch++;
  currentCall?.abort();
  pollAbort?.abort();
}

async function sync(): Promise<void> {
  const settings = await settingsStorage.get();
  enabled = settings.localBridge;
  if (!enabled) {
    stop();
    connected = false;
    lastError = null;
    await setStatus({ connected: false, lastSeenAt: null }, true);
    return;
  }
  await setStatus({}, true);
  void loop();
}

/** Called once at worker start: the switch, the watchdog that restarts a sleeping worker's loop, and the loop. */
export function listenForBridge(): void {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void sync();
  });
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }).catch(() => undefined);
  settingsStorage.subscribe(() => void sync());
  void sync();
}

// ------------------------------------------------------------------ commands

function handle(cmd: BridgeCommand): void {
  // Abort and ping answer at once; everything else is queued, so two agents never interleave page actions.
  if (cmd.type === 'abort') {
    epoch++;
    currentCall?.abort();
    void sendResult(cmd.id, { ok: true, text: 'Aborted.' }, null);
    return;
  }
  if (cmd.type === 'ping') {
    void sendResult(cmd.id, { ok: true, pong: Date.now() }, null);
    return;
  }
  const mine = epoch;
  chain = chain.then(async () => {
    if (mine !== epoch) {
      await sendResult(cmd.id, undefined, 'aborted');
      return;
    }
    await run(cmd);
  });
}

async function run(cmd: BridgeCommand): Promise<void> {
  let done: Record<string, DoneEntry> = {};
  try {
    const stored = await chrome.storage.session.get(DONE_KEY);
    done = (stored[DONE_KEY] as Record<string, DoneEntry>) ?? {};
  } catch {
    // No de-duplication available; the command still runs once.
  }
  // A redelivered command (the worker slept after taking it) is answered from the record, not run again.
  const previous = done[cmd.id];
  if (previous) return sendResult(cmd.id, previous.result, previous.error ?? null);

  let result: unknown;
  let error: string | null = null;
  try {
    result = await execute(cmd);
  } catch (caught) {
    error = messageOf(caught);
  }
  await rememberDone(cmd.id, { at: Date.now(), result, error });
  await sendResult(cmd.id, result, error);
  await setStatus({ lastCommand: cmd.type, lastCommandAt: new Date().toISOString() });
}

async function rememberDone(id: string, entry: DoneEntry): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(DONE_KEY);
    const done = (stored[DONE_KEY] as Record<string, DoneEntry>) ?? {};
    done[id] = entry;
    const cut = Date.now() - DONE_TTL_MS;
    for (const [key, value] of Object.entries(done)) if (value.at < cut) delete done[key];
    const keys = Object.keys(done);
    for (const key of keys.slice(0, Math.max(0, keys.length - DONE_MAX))) delete done[key];
    await chrome.storage.session.set({ [DONE_KEY]: done });
  } catch {
    // The record is a guard against a rare redelivery, not state anything depends on.
  }
}

async function sendResult(id: string, result: unknown, error: string | null): Promise<void> {
  try {
    const response = await fetch(`${BRIDGE_URL}/ext/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': token ?? '' },
      body: JSON.stringify({ id, result: result ?? null, error: error ? { message: error } : null }),
    });
    if (!response.ok) console.info('[bridge] result was not accepted', response.status);
  } catch (caught) {
    console.info('[bridge] result could not be posted', messageOf(caught));
  }
}

async function event(type: string, data: unknown): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/ext/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': token ?? '' },
      body: JSON.stringify({ panel: panelId, type, data }),
    });
  } catch {
    // Events are for the agent's log; a dropped one changes nothing.
  }
}

/** The visible tab, or the first tab, when the bridge attaches and the agent named none. */
async function activeTabId(): Promise<number | null> {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id !== undefined) return focused.id;
  const [anyActive] = await chrome.tabs.query({ active: true });
  if (anyActive?.id !== undefined) return anyActive.id;
  const [first] = await chrome.tabs.query({});
  return first?.id ?? null;
}

function tabIdOf(cmd: BridgeCommand): number | undefined {
  return typeof cmd.tabId === 'number' ? cmd.tabId : undefined;
}

async function execute(cmd: BridgeCommand): Promise<unknown> {
  const { controller, session } = await layer();
  switch (cmd.type) {
    case 'status': {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        session: { id: session.id, tabs: session.tabIds(), activeTabId: session.activeTabId },
        tabs: tabs.filter(t => t.id !== undefined).length,
        bridge: { panelId, url: BRIDGE_URL, connected },
      };
    }

    case 'tools':
      return {
        ok: true,
        tools: session.listTools().map(spec => ({
          name: spec.name,
          description: spec.description,
          capability: spec.capability,
          readOnly: typeof spec.readOnly === 'boolean' ? spec.readOnly : 'depends',
          schema: argsJsonSchema(spec),
        })),
      };

    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs
          .filter(t => t.id !== undefined)
          .map(t => ({
            tabId: t.id,
            windowId: t.windowId,
            active: !!t.active,
            url: t.url ?? '',
            title: t.title ?? '',
            status: t.status,
            attachable: !!t.url && !/^(chrome|edge|devtools|chrome-extension|about):/i.test(t.url),
          })),
        activeTabId: await activeTabId(),
      };
    }

    case 'attach': {
      const tabId = tabIdOf(cmd) ?? (await activeTabId());
      if (tabId === null) throw new Error('There is no tab to attach. Open one first, or pass a tabId.');
      await session.share(tabId);
      // Fail with the layer's own reason now, rather than on the first action: a page the debugger cannot attach to
      // (a store page, a chrome:// page) is named here.
      await controller.attach(tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const state = { tabId, url: tab?.url ?? '', title: tab?.title ?? '', activeTabId: session.activeTabId };
      void event('state', { ...state, tabs: session.tabIds() });
      return { ok: true, ...state, tabs: session.tabIds() };
    }

    case 'focus': {
      // Make a tab the visible one and raise its window. The layer's own `tabs select` activates the tab but never
      // focuses a window; an agent that wants the person to watch asks for this.
      const tabId = tabIdOf(cmd) ?? session.activeTabId ?? (await activeTabId());
      if (tabId === null) throw new Error('There is no tab to focus. Open one first, or pass a tabId.');
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      if (session.hasTab(tabId)) session.setActive(tabId);
      return { ok: true, tabId, windowId: tab.windowId, url: tab.url ?? '', title: tab.title ?? '' };
    }

    case 'detach': {
      const tabId = tabIdOf(cmd) ?? session.activeTabId;
      if (tabId === null) throw new Error('No tab is attached.');
      if (!session.hasTab(tabId)) throw new Error(`Tab ${tabId} is not attached.`);
      await session.unshareTab(tabId);
      void event('state', { detached: tabId, tabs: session.tabIds() });
      return { ok: true, detached: tabId, tabs: session.tabIds(), activeTabId: session.activeTabId };
    }

    case 'call': {
      const tool = typeof cmd.tool === 'string' ? cmd.tool : '';
      if (!tool) throw new Error('call needs a tool name.');
      const args = cmd.args && typeof cmd.args === 'object' ? cmd.args : {};
      const abort = new AbortController();
      currentCall = abort;
      try {
        return await session.call(tool, args, { signal: abort.signal });
      } finally {
        if (currentCall === abort) currentCall = null;
      }
    }

    default:
      throw new Error(`Unknown bridge command "${cmd.type}".`);
  }
}
