/**
 * MV3 service worker (T-004 skeleton).
 *
 * Later tasks add the native-messaging port (T-007), grants (T-011) and the request builder
 * (T-016). For now it only reports the registry state on install/startup so loading the
 * unpacked extension can be checked in the service-worker console.
 */
import '../csp.js';
import { PROTOCOL_VERSION } from '@sn-mcp/shared';
import { chromeRegistryStorage, Registry } from './registry.js';

const registry = new Registry(chromeRegistryStorage());

async function reportState(reason: string): Promise<void> {
  const entries = await registry.list();
  console.info(
    `[sn-mcp] ${reason}: protocol v${PROTOCOL_VERSION}, ${entries.length} registered instance(s)`,
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  void reportState(`installed (${details.reason})`);
});
chrome.runtime.onStartup.addListener(() => {
  void reportState('startup');
});
