// The local agent bridge's shared state: the address, and the status the settings page shows. The worker writes the
// status (src/extension/bridge.ts) and Settings → General reads it; neither imports the other's code.
import { createStorage } from './storage';

/** Fixed: the extension cannot read a port from the environment, and agents find it through the same constant. */
export const BRIDGE_PORT = 8788;
export const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
/** Where the extension keeps the pairing token the bridge gave it. */
export const BRIDGE_TOKEN_KEY = 'nb.bridge.token';
/** The worker's panel id, kept for the browser session so a restarted worker returns as the same panel. */
export const BRIDGE_PANEL_KEY = 'nb.bridge.panel';

export interface BridgeStatus {
  /** The user's switch in Settings → General. */
  enabled: boolean;
  /** The worker is polling the bridge right now. */
  connected: boolean;
  url: string;
  panelId: string;
  /** The last poll that the bridge answered. */
  lastSeenAt: string | null;
  lastCommandAt: string | null;
  lastCommand: string | null;
  /** Why the last connection attempt failed; null once one succeeds. */
  error: string | null;
}

export const DEFAULT_BRIDGE_STATUS: BridgeStatus = {
  enabled: false,
  connected: false,
  url: BRIDGE_URL,
  panelId: '',
  lastSeenAt: null,
  lastCommandAt: null,
  lastCommand: null,
  error: null,
};

export const bridgeStatusStorage = createStorage<BridgeStatus>('nb.bridge.status', DEFAULT_BRIDGE_STATUS, {
  liveUpdate: true,
});
