/**
 * DEV_DIAGNOSTICS only: message handler for the T-005 diagnostics page.
 * Accepts messages only from this extension's own diagnostics page, and only for a registered
 * instance whose host permission is granted.
 */
import { originPattern, type Registry } from './registry.js';
import { runSpike, USERNAME_RE } from './session.js';

export interface DiagnosticsRequest {
  type: 'diagnostics.run';
  alias: string;
  kind: 'full' | 'expiry';
  userName?: string;
}

export function installDiagnosticsHandler(registry: Registry): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = message as Partial<DiagnosticsRequest> | null;
    if (m?.type !== 'diagnostics.run') return false;
    const fromDiagnosticsPage =
      sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL('diagnostics.html') &&
      sender.tab !== undefined;
    if (!fromDiagnosticsPage) {
      sendResponse({ ok: false, error: 'sender not allowed' });
      return false;
    }
    void (async () => {
      try {
        const entry = (await registry.list()).find((e) => e.alias === m.alias);
        if (!entry) throw new Error('instance not registered');
        if (!(await chrome.permissions.contains({ origins: [originPattern(entry.host)] }))) {
          throw new Error('host permission not granted');
        }
        if (m.kind !== 'full' && m.kind !== 'expiry') throw new Error('invalid kind');
        if (m.userName !== undefined && m.userName !== '' && !USERNAME_RE.test(m.userName)) {
          throw new Error('invalid user name');
        }
        const report = await runSpike(entry.host, {
          kind: m.kind,
          ...(m.userName ? { userName: m.userName } : {}),
        });
        sendResponse({ ok: true, report: { ...report, alias: entry.alias, env: entry.env } });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });
}
