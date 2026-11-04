/**
 * MV3 service worker: connects to the native broker, authorizes and executes forwarded
 * requests, and serves the popup.
 */
import '../csp.js';
import { PROTOCOL_VERSION } from '@sn-mcp/shared';
import { handleForward } from './authz.js';
import { ChromeTokenProvider, Executor } from './executor.js';
import { badgeFor, browserGrantDeps, chromeGrantStorage, Grants } from './grants.js';
import { handlePopupMessage, isPopupSender } from './popup-api.js';
import { BridgePort, type BridgeState, chromeConnect } from './port.js';
import {
  chromeRegistryStorage,
  originPattern,
  REGISTRY_STORAGE_KEY,
  Registry,
} from './registry.js';
import { type ConnectionState, SessionTracker, STATUS_REFRESH_MS } from './session.js';
import { chromeSettingsStorage, SETTINGS_STORAGE_KEY, Settings } from './settings.js';

const registry = new Registry(chromeRegistryStorage());
const grants = new Grants(chromeGrantStorage(), browserGrantDeps);
const tokens = new ChromeTokenProvider();
const settings = new Settings(chromeSettingsStorage());
const executor = new Executor({
  fetch: (...a) => fetch(...a),
  tokens,
  // Per-request safeguards from the user's settings (T-019): instance override > global > default.
  safeguards: async (host) =>
    settings.forInstance((await registry.list()).find((e) => e.host === host)?.alias),
  extraDeniedTables: async () => (await settings.get()).extraDeniedTables ?? [],
});
let bridgeState: BridgeState = { state: 'connecting' };
const PROBE_OP = { kind: 'probe' } as const;
const session = new SessionTracker({
  hasPermission: (host) => chrome.permissions.contains({ origins: [originPattern(host)] }),
  hasTab: async (host) => (await chrome.tabs.query({ url: `https://${host}/*` })).length > 0,
  probe: (host) => executor.run(host, PROBE_OP),
  now: () => Date.now(),
});
let connectionStates = new Map<string, ConnectionState>();

/** Runs an operation and lets the session tracker learn from its outcome. */
async function execute(host: string, op: unknown) {
  const r = await executor.run(host, op);
  session.record(host, r);
  void refreshConnections();
  return r;
}

/** Re-evaluates every instance's state; pushes registry.update when anything changed. */
async function refreshConnections(probe = false): Promise<Map<string, ConnectionState>> {
  const hosts = (await registry.list()).map((e) => e.host);
  const { states, changed } = await session.refresh(hosts, connectionStates, {
    probeUnknown: probe,
  });
  connectionStates = states;
  if (changed) void sendRegistryUpdate();
  return states;
}

async function updateBadge(): Promise<void> {
  const { pending, grants: active } = await grants.snapshot();
  const b = badgeFor(pending.length, active, Date.now());
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
}

/** Notifies about a new access request. Only fixed text, alias and code: never the purpose. */
async function notifyRequest(requestId: string): Promise<void> {
  const { pending } = await grants.snapshot();
  const r = pending.find((x) => x.requestId === requestId);
  if (!r) return;
  const code = `${r.approvalCode.slice(0, 4)}-${r.approvalCode.slice(4)}`;
  try {
    await chrome.notifications.create(`req:${r.requestId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Claude is asking for ServiceNow access',
      message: `${r.clientLabel.name.slice(0, 40)} → ${r.instances.join(' + ')} · code ${code}`,
      contextMessage: 'Click the extension icon to approve or deny.',
      priority: 2,
    });
  } catch {
    // Notifications are a convenience; the popup and badge remain authoritative.
  }
}

async function sendRegistryUpdate(): Promise<void> {
  const instances = (await registry.list()).map((e) => ({
    alias: e.alias,
    label: e.label.slice(0, 64),
    host: e.host,
    env: e.env,
    ...(e.envName ? { envName: e.envName } : {}),
    connection: connectionStates.get(e.host) ?? ('unknown' as const),
  }));
  port.send({ v: PROTOCOL_VERSION, kind: 'registry.update', instances });
}

const port = new BridgePort({
  connect: chromeConnect,
  lastError: () => chrome.runtime.lastError?.message,
  onState: (s) => {
    bridgeState = s;
  },
  onReady: () => void sendRegistryUpdate(),
  secrets: () => tokens.knownSecrets(),
  onMessage: (m, generation) => {
    if (m.kind !== 'forward') return;
    void handleForward(m, {
      grants,
      registry: () => registry.list(),
      hasPermission: (origin) => chrome.permissions.contains({ origins: [origin] }),
      execute,
      onPendingChanged: () => void updateBadge(),
      connection: (host) => session.status(host),
    }).then((response) => {
      if (response) port.respond(response, generation);
      if (response?.ok && response.result.type === 'scope.request') {
        void notifyRequest(response.result.requestId);
      }
    });
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isPopupSender(sender, chrome.runtime.id, chrome.runtime.getURL('popup.html'))) return false;
  void handlePopupMessage(message, {
    grants,
    registry: () => registry.list(),
    registryStore: registry,
    settings,
    hasPermission: (origin) => chrome.permissions.contains({ origins: [origin] }),
    removePermission: (origin) => chrome.permissions.remove({ origins: [origin] }),
    bridgeState: () => bridgeState,
    onChanged: () => void updateBadge(),
    connections: async ({ probe }) => {
      const states = await refreshConnections(probe);
      const out: Record<string, ConnectionState> = {};
      for (const e of await registry.list()) out[e.alias] = states.get(e.host) ?? 'unknown';
      return out;
    },
  }).then(sendResponse);
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_STORAGE_KEY in changes) settings.invalidate();
  if (area !== 'local' || !(REGISTRY_STORAGE_KEY in changes)) return;
  // Backstop for any registry write: grants never outlive or follow a changed entry.
  void registry
    .list()
    .then((entries) => grants.reconcile(entries))
    .then(() => updateBadge());
  void sendRegistryUpdate();
});
chrome.runtime.onInstalled.addListener(() => port.start());
chrome.runtime.onStartup.addListener(() => port.start());
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('req:')) return;
  void chrome.action.openPopup().catch(() => undefined);
  void chrome.notifications.clear(id);
});
port.start();
void updateBadge();
// Keeps the PROD badge honest when grants expire while the popup is closed.
setInterval(() => void updateBadge(), 30_000);
// Connection status: local checks every 30 s, plus on tab and permission changes (T-013).
setInterval(() => void refreshConnections(), STATUS_REFRESH_MS);
let tabTimer: ReturnType<typeof setTimeout> | undefined;
const soon = () => {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(() => void refreshConnections(), 1000);
};
chrome.tabs.onRemoved.addListener(soon);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') soon();
});
chrome.permissions.onRemoved.addListener(soon);
chrome.permissions.onAdded.addListener(soon);
