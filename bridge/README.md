# Local agent bridge

An agent running on this computer — Claude Code, Cursor, pi, Codex, a script — can drive the Chrome you are logged
into, through this extension. It observes the page, clicks, types, navigates and takes screenshots with the same
browser-control layer the side-panel agent uses. No model is involved in the bridge, and Chrome's DevTools protocol is
never exposed to another process: the extension is the only thing that touches a tab.

This is the one addition this fork makes to Nanobrowser. Upstream says an MCP bridge is out of scope for now;
`src/browser-control/protocol/schemas.ts` was already written so its requests "can be forwarded unchanged".

```
  agent (MCP client or CLI)
        │  HTTP, 127.0.0.1:8788, x-bridge-token
        ▼
  bridge/server.mjs ──────────────┐
        │  commands   ▲ results   │  bridge/.token, bridge/.shots, bridge/.tools.json
        ▼             │           │
  extension service worker (src/extension/bridge.ts)
        │  long poll  ▲           │
        ▼             │           │
  browser-control layer ── chrome.debugger ── the tab you attached
```

Why a relay: an extension cannot accept an inbound connection, so the worker polls the bridge instead. The bridge
only queues and forwards; every action still runs in the worker, inside the layer's own session, refs, actionability
checks and receipts.

## Setup

1. Build and load the extension.

   ```powershell
   pnpm install
   pnpm build
   ```

   `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.

2. Turn the bridge on in **Settings → General → Local agent bridge**. It is on by default in this fork; the card shows
   whether the extension is polling.

3. Start the bridge.

   ```powershell
   pnpm bridge          # node bridge/server.mjs
   ```

   It prints the token and writes it to `bridge/.token`. The extension pairs itself over
   `GET /pair` (a `chrome-extension://` origin only); no token has to be pasted anywhere.

That is the whole setup. The bridge can be started before or after Chrome; the extension retries quietly, and a
Chrome restart reattaches on its own.

## An MCP client

Point any MCP client at the stdio server. `node bridge/cli.mjs mcp-config` prints the JSON with absolute paths:

```json
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\GitHub\\nanobrowser\\bridge\\mcp.mjs"]
    }
  }
}
```

Claude Code, one line:

```powershell
claude mcp add nanobrowser -- node "C:\Users\you\Documents\GitHub\nanobrowser\bridge\mcp.mjs"
```

Clients that are not MCP-capable can call the CLI from a shell (below). The MCP server starts `server.mjs` itself if
nothing answers.

The tools are:

- `browser_status` — is the extension connected?
- `browser_list_tabs`, `browser_attach`, `browser_detach`, `browser_open` — choose the tab to work in.
- `browser_snapshot`, `browser_find`, `browser_read` — observe; refs such as `a12` come from `browser_snapshot`.
- `browser_click`, `browser_set`, `browser_fill_form`, `browser_type`, `browser_press`, `browser_hover`,
  `browser_scroll`, `browser_wait`, `browser_navigate`, `browser_upload`, `browser_handle_dialog`,
  `browser_screenshot`, `browser_tabs` — the layer's own catalogue, forwarded unchanged.
- `browser_call` — any layer tool by its raw name, for tools added later.

A typical first move:

```
browser_status
browser_open        { "url": "https://example.com" }
browser_snapshot    { "mode": "interactive" }
browser_click       { "target": { "ref": "a4" } }
```

## The CLI

```powershell
node bridge/cli.mjs status
node bridge/cli.mjs tabs
node bridge/cli.mjs open https://example.com
node bridge/cli.mjs snap
node bridge/cli.mjs find --role button --name Save
node bridge/cli.mjs click a12
node bridge/cli.mjs fill a3 "ada@example.com"
node bridge/cli.mjs read --max 4000
node bridge/cli.mjs shot page.png --full
node bridge/cli.mjs nav back
node bridge/cli.mjs wait --text "Saved" --ms 5000
node bridge/cli.mjs upload C:\temp\invoice.pdf
node bridge/cli.mjs call scroll '{"by":{"px":600}}'
node bridge/cli.mjs events --follow 20
node bridge/cli.mjs stop
```

`--json` prints the layer's raw result. The full list is `node bridge/cli.mjs help`.

## What the agent may do

The bridge session is **not** a conversation, so the side panel's approval cards are not in the loop: the person who
started the agent already said what may happen. The session is made with:

- `capabilities: ['vision', 'selector', 'files']` — screenshots and coordinate targets, CSS selector targets, and
  `upload` from disk. No `human` (`ask_user` has nobody to ask) and no `eval`/`devtools`.
- `confirm: 'never'` — classified writes (submit, send, delete, upload) run without a card.
- The user's **blocked sites** from Settings still apply, and a blocked site fails before any action.
- Observations still mask password, card, security-code and one-time-code values; they are never returned.

That is the same trade-off browser-cowork makes, and it is worth being explicit: an agent you point at the bridge can
submit forms and press buttons in your logged-in session. Attach only tabs you mean to give it. Stop it with
`stop`, detach the tab, or switch the card off in Settings.

Transport: the server binds `127.0.0.1` only. Requests with an `Origin` that is not a `chrome-extension://` page are
refused, so a web page cannot reach it; the agent token lives in `bridge/.token` (mode 0600), is never committed, and
is rotated when the file is deleted. Nothing leaves the machine.

## How it survives a sleeping service worker

Chrome stops an idle worker after ~30 s. The extension holds a 20-second long poll open, which keeps it alive, and a
`chrome.alarms` watchdog every 30 s restarts the loop if the worker was stopped anyway. A command that the worker took
but never answered is offered again after 30 s; the worker records the id it has already answered, so a redelivery is
answered from the record instead of being dispatched twice.

Commands run one at a time; `abort` and `ping` are handled immediately, and `abort` also cancels calls already queued.
Worker restarts lose the shared-tab set: call `browser_attach` again (the MCP tools are stateless, so this is one
extra call).

## Limits

- `chrome.debugger` shows Chrome's yellow "being debugged" bar, and an open DevTools panel on the same tab wins the
  attachment. Close DevTools for tabs an agent uses.
- The bridge drives the tab it was told to attach; it does not follow tab switches on its own. `browser_open` and
  `browser_tabs` are how a tab joins.
- If the side panel's agent and the bridge hold the same tab, both work through the same controller and locks; they do
  not corrupt each other, but they can interleave. Prefer a separate tab.
- Frames are observed and clickable by coordinate; elements inside cross-origin frames are not listed as refs.
- The bridge keeps the last 1,000 events and 200 results in memory; nothing is persisted except screenshots.

## Troubleshooting

**`browser_status` says the extension is not connected.** The bridge is up but no worker is polling: check that
`dist/` is loaded in Chrome (not the store version), that Settings → General → Local agent bridge is on, and that
nothing else holds port 8788.

**Port already in use.** `NANOBROWSER_BRIDGE_PORT` changes the server; the extension's port is fixed at 8788, so use
that one. Find the holder with `netstat -ano | findstr 8788`.

**The token changed.** Delete `bridge/.token` and restart the server; the extension gets a 401, pairs again, and keeps
going without a reload.

**`pair` is refused.** Only extension pages may pair. A local script should read `bridge/.token` instead.

**The worker seems asleep.** Give the watchdog up to 30 s; the first command may then take one extra round trip.

## Verification

```powershell
node --test bridge/test/server.test.mjs bridge/test/mcp.test.mjs   # relay and MCP, no browser
node bridge/test/e2e.mjs                                         # real Chrome, built extension, CLI
```

The end-to-end script needs `dist/` (`pnpm build`), stable Chrome for Testing (`pnpm install-chrome`) and port 8788
free. It opens fixture pages, observes them, fills a field, clicks, reads, screenshots, drives the CLI, detaches, and
prints PASS/FAIL per step.

## Files

| File | Role |
|---|---|
| `bridge/server.mjs` | Loopback relay: pairing, command queue, long polls, redelivery, results, events, screenshots |
| `bridge/cli.mjs` | One command per call, for a person or a shell |
| `bridge/mcp.mjs` | MCP over stdio; tools generated from the layer's catalogue |
| `bridge/lib.mjs` | Token, auto-start, request and argument helpers |
| `src/extension/bridge.ts` | The worker side: polling, an own session, command execution, de-duplication |
| `src/store/bridge.ts` | Shared status for the settings card (`nb.bridge.status`) |
| `src/options/GeneralSection.tsx` | The switch and the connection line |
| `bridge/test/` | Relay, MCP and end-to-end tests |
