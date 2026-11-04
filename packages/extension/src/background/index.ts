/**
 * MV3 service worker: connects to the native broker, authorizes and executes forwarded
 * requests, and serves the popup.
 */
import '../csp.js';
import { type ExtensionToBroker, PROTOCOL_VERSION, protocolError } from '@sn-mcp/shared';
import { handleForward } from './authz.js';
import { ChromeTokenProvider, Executor } from './executor.js';
import { browserGrantDeps, chromeGrantStorage, Grants } from './grants.js';
import { handlePopupMessage, isPopupSender } from './popup-api.js';
import { BridgePort, type BridgeState, chromeConnect } from './port.js';
import { chromeRegistryStorage, REGISTRY_STORAGE_KEY, Registry } from './registry.js';

const registry = new Registry(chromeRegistryStorage());
const grants = new Grants(chromeGrantStorage(), browserGrantDeps);
const tokens = new ChromeTokenProvider();
const executor = new Executor({ fetch: (...a) => fetch(...a), tokens });
let bridgeState: BridgeState = { state: 'connecting' };

async function updateBadge(): Promise<void> {
  const { pending } = await grants.snapshot();
  await chrome.action.setBadgeText({ text: pending.length > 0 ? String(pending.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0b63ce' });
}

async function sendRegistryUpdate(): Promise<void> {
  const instances = (await registry.list()).map((e) => ({
    alias: e.alias,
    label: e.label.slice(0, 64),
    host: e.host,
    env: e.env,
    ...(e.envName ? { envName: e.envName } : {}),
    connection: 'unknown' as const,
  }));
  port.send({ v: PROTOCOL_VERSION, kind: 'registry.update', instances });
}

function respond(message: ExtensionToBroker): void {
  if (port.send(message)) return;
  if (message.kind === 'response') {
    // Withheld by the credential guard (or invalid): answer with an error instead.
    port.send({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: message.id,
      ok: false,
      error: protocolError('SN_API_ERROR', 'The response was withheld by the extension.'),
    });
  }
}

const port = new BridgePort({
  connect: chromeConnect,
  lastError: () => chrome.runtime.lastError?.message,
  onState: (s) => {
    bridgeState = s;
  },
  onReady: () => void sendRegistryUpdate(),
  secrets: () => tokens.knownSecrets(),
  onMessage: (m) => {
    if (m.kind !== 'forward') return;
    void handleForward(m, {
      grants,
      registry: () => registry.list(),
      hasPermission: (origin) => chrome.permissions.contains({ origins: [origin] }),
      execute: (host, op) => executor.run(host, op),
      onPendingChanged: () => void updateBadge(),
    }).then((response) => {
      if (response) respond(response);
    });
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isPopupSender(sender, chrome.runtime.id, chrome.runtime.getURL('popup.html'))) return false;
  void handlePopupMessage(message, {
    grants,
    registry: () => registry.list(),
    registryStore: registry,
    hasPermission: (origin) => chrome.permissions.contains({ origins: [origin] }),
    removePermission: (origin) => chrome.permissions.remove({ origins: [origin] }),
    bridgeState: () => bridgeState,
    onChanged: () => void updateBadge(),
  }).then(sendResponse);
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
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
port.start();
void updateBadge();
