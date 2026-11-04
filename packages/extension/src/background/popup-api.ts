/**
 * Popup → service worker messages. Grant-mutating actions are accepted only from this
 * extension's own popup page (no tab, exact URL). Everything else is ignored (AC5).
 */
import type { Grants } from './grants.js';
import type { BridgeState } from './port.js';
import type { InstanceEntry } from './registry.js';

export type PopupMessage =
  | { type: 'popup.state' }
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
    default:
      return undefined;
  }
}
