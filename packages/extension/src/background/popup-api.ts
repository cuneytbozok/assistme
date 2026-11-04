/**
 * Popup → service worker messages. Grant- and registry-mutating actions are accepted only from
 * this extension's own popup page (no tab, exact URL). Everything else is ignored (AC5).
 *
 * Registry mutations run here (not in the popup) so that grant invalidation happens in the same
 * place, right after the change is stored (T-010 AC2). Host permission is requested by the popup
 * (it needs the click's user gesture); `registry.add` refuses entries whose origin is not granted.
 */
import type { Grants } from './grants.js';
import type { BridgeState } from './port.js';
import { type InstanceEntry, originPattern, type Registry } from './registry.js';

export type PopupMessage =
  | { type: 'popup.state' }
  | {
      type: 'popup.registry.add';
      entry: { alias: string; host: string; label?: string; env: string; envName?: string };
    }
  | { type: 'popup.registry.edit'; alias: string; label?: string; env?: string; envName?: string }
  | { type: 'popup.registry.remove'; alias: string; removeHostPermission: boolean }
  | { type: 'popup.approve'; requestId: string; typedHost?: string }
  | { type: 'popup.deny'; requestId: string }
  | { type: 'popup.revoke'; grantId: string };

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

export function isPopupSender(sender: SenderLike, runtimeId: string, popupUrl: string): boolean {
  return sender.id === runtimeId && sender.url === popupUrl && sender.tab === undefined;
}

export interface PopupApiDeps {
  grants: Grants;
  registry: () => Promise<InstanceEntry[]>;
  registryStore?: Registry;
  hasPermission?: (origin: string) => Promise<boolean>;
  removePermission?: (origin: string) => Promise<boolean>;
  bridgeState: () => BridgeState;
  onChanged: () => void;
}

export async function handlePopupMessage(raw: unknown, d: PopupApiDeps): Promise<unknown> {
  const m = raw as Partial<PopupMessage> | null;
  switch (m?.type) {
    case 'popup.state': {
      const snap = await d.grants.snapshot();
      return {
        ok: true,
        bridge: d.bridgeState(),
        pending: snap.pending,
        grants: snap.grants,
        registry: await d.registry(),
      };
    }
    case 'popup.approve': {
      if (typeof m.requestId !== 'string') return { ok: false, message: 'invalid request' };
      const r = await d.grants.approve(
        m.requestId,
        await d.registry(),
        typeof m.typedHost === 'string' ? m.typedHost : undefined,
      );
      d.onChanged();
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    }
    case 'popup.deny': {
      if (typeof m.requestId !== 'string') return { ok: false, message: 'invalid request' };
      const r = await d.grants.deny(m.requestId);
      d.onChanged();
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    }
    case 'popup.revoke': {
      if (typeof m.grantId !== 'string') return { ok: false, message: 'invalid grant' };
      const revoked = await d.grants.revoke(m.grantId);
      d.onChanged();
      return { ok: revoked };
    }
    case 'popup.registry.add': {
      const e = m.entry;
      if (!d.registryStore || !d.hasPermission || typeof e !== 'object' || e === null) {
        return { ok: false, message: 'invalid request' };
      }
      if (typeof e.alias !== 'string' || typeof e.host !== 'string' || typeof e.env !== 'string') {
        return { ok: false, message: 'invalid request' };
      }
      let origin: string;
      try {
        origin = originPattern(e.host);
      } catch {
        return { ok: false, message: 'Invalid host.' };
      }
      if (!(await d.hasPermission(origin))) {
        return { ok: false, message: `Access to ${e.host} was not granted.` };
      }
      const r = await d.registryStore.add({
        alias: e.alias,
        host: e.host,
        env: e.env,
        ...(typeof e.label === 'string' ? { label: e.label } : {}),
        ...(typeof e.envName === 'string' ? { envName: e.envName } : {}),
      });
      d.onChanged();
      return r.ok ? { ok: true, entry: r.value } : { ok: false, message: r.error };
    }
    case 'popup.registry.edit': {
      if (!d.registryStore || typeof m.alias !== 'string') {
        return { ok: false, message: 'invalid request' };
      }
      const r = await d.registryStore.edit(m.alias, {
        ...(typeof m.label === 'string' ? { label: m.label } : {}),
        ...(typeof m.env === 'string' ? { env: m.env } : {}),
        ...(typeof m.envName === 'string' ? { envName: m.envName } : {}),
      });
      if (!r.ok) return { ok: false, message: r.error };
      const invalidated = await d.grants.reconcile(await d.registry());
      d.onChanged();
      return { ok: true, entry: r.value.after, invalidated };
    }
    case 'popup.registry.remove': {
      if (!d.registryStore || typeof m.alias !== 'string') {
        return { ok: false, message: 'invalid request' };
      }
      const removed = await d.registryStore.remove(m.alias);
      if (!removed) return { ok: false, message: `No registered instance "${m.alias}".` };
      const invalidated = await d.grants.reconcile(await d.registry());
      let permissionRemoved = false;
      const origin = originPattern(removed.host);
      if (
        m.removeHostPermission === true &&
        d.removePermission &&
        (!d.hasPermission || (await d.hasPermission(origin)))
      ) {
        permissionRemoved = await d.removePermission(origin);
      }
      d.onChanged();
      return { ok: true, invalidated, permissionRemoved };
    }
    default:
      return undefined;
  }
}
