/**
 * Minimal grant model (T-007; completed in T-011). ARCHITECTURE §5.2–5.4, ADR-003.
 *
 * - Only the user creates grants, by approving a pending request in the popup.
 * - The approval code shown to Claude and in the popup ties the approval to the conversation.
 * - A request is claimable once, and only by the client (client_key_id) that made it.
 * - Scope ids are random bearer handles; only their SHA-256 is stored.
 * - Every operation re-checks scope, client binding, expiry and instance.
 * - State lives in chrome.storage.session (cleared when Chrome restarts).
 *
 * T-007 scope: single-instance grants with default TTLs; PROD/unclassified approval requires
 * typing the host. Compare mode, TTL choice, badges and revoke-all come in T-011.
 */
import {
  APPROVAL_CODE_ALPHABET,
  APPROVAL_CODE_LENGTH,
  type ErrorCode,
  GRANT_TTL_MINUTES,
  SCOPE_ID_RE,
  SCOPE_REQUEST_TTL_SECONDS,
} from '@sn-mcp/shared';
import { effectiveEnv, type InstanceEntry } from './registry.js';

export interface ClientLabel {
  name: string;
  pid: number;
  cwd?: string;
}

export interface ScopeRequestRecord {
  requestId: string;
  approvalCode: string;
  clientKeyId: string;
  clientLabel: ClientLabel;
  instances: string[];
  mode: 'single' | 'compare';
  purpose: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'claimed';
  approvedAt?: number;
  /** Set on approval; the grant's lifetime starts then. */
  ttlMinutes?: number;
}

export interface GrantRecord {
  grantId: string;
  scopeHash: string;
  clientKeyId: string;
  clientLabel: ClientLabel;
  instances: string[];
  mode: 'single' | 'compare';
  createdAt: number;
  expiresAt: number;
}

interface GrantState {
  requests: ScopeRequestRecord[];
  grants: GrantRecord[];
}

export interface GrantStorage {
  load(): Promise<unknown>;
  save(state: GrantState): Promise<void>;
}

export interface GrantDeps {
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  sha256Hex: (s: string) => Promise<string>;
}

export type ClaimValue =
  | { status: 'pending' | 'denied' | 'expired' | 'claimed' }
  | {
      status: 'approved';
      scopeId: string;
      instances: string[];
      mode: 'single' | 'compare';
      expiresAt: string;
    };

export type GrantResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

const err = (
  code: ErrorCode,
  message: string,
): { ok: false; code: ErrorCode; message: string } => ({
  ok: false,
  code,
  message,
});

/** After approval, the claim stays possible for this long. */
export const CLAIM_WINDOW_MS = SCOPE_REQUEST_TTL_SECONDS * 1000;
export const GRANT_TOMBSTONE_MS = 24 * 60 * 60_000;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unbiased code from the unambiguous alphabet (rejection sampling). */
export function makeApprovalCode(randomBytes: (n: number) => Uint8Array): string {
  const alphabet = APPROVAL_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < APPROVAL_CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < limit && code.length < APPROVAL_CODE_LENGTH) code += alphabet[b % alphabet.length];
    }
  }
  return code;
}

export function defaultTtlMinutes(env: InstanceEntry['env']): number {
  return GRANT_TTL_MINUTES[env].default;
}

function sanitizeState(raw: unknown): GrantState {
  const s = (raw ?? {}) as Partial<GrantState>;
  return {
    requests: Array.isArray(s.requests) ? s.requests : [],
    grants: Array.isArray(s.grants) ? s.grants : [],
  };
}

export class Grants {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: GrantStorage,
    private readonly deps: GrantDeps,
  ) {}

  /** Serializes read-modify-write cycles (the service worker interleaves async handlers). */
  private exclusive<T>(
    fn: (state: GrantState) => Promise<{ value: T; save: boolean }>,
  ): Promise<T> {
    const run = this.chain.then(async () => {
      const state = this.prune(sanitizeState(await this.storage.load()));
      const { value, save } = await fn(state);
      if (save) await this.storage.save(state);
      return value;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Drops expired requests (unless approved and within the claim window) and expired grants. */
  private prune(state: GrantState): GrantState {
    const now = this.deps.now();
    state.requests = state.requests.filter((r) => {
      if (r.status === 'approved') return (r.approvedAt ?? 0) + CLAIM_WINDOW_MS > now;
      if (r.status === 'pending') return r.expiresAt > now;
      return r.expiresAt + CLAIM_WINDOW_MS > now; // keep denied/claimed briefly to answer claims
    });
    // Expired grants stay as tombstones for a day so callers get SCOPE_EXPIRED, not SCOPE_UNKNOWN.
    state.grants = state.grants.filter((g) => g.expiresAt + GRANT_TOMBSTONE_MS > now);
    return state;
  }

  createRequest(
    client: { keyId: string; label: ClientLabel },
    input: { instances: string[]; mode: 'single' | 'compare'; purpose: string },
    registry: readonly InstanceEntry[],
  ): Promise<GrantResult<{ requestId: string; approvalCode: string; expiresInSeconds: number }>> {
    return this.exclusive<
      GrantResult<{ requestId: string; approvalCode: string; expiresInSeconds: number }>
    >(async (state) => {
      if (input.mode !== 'single' || input.instances.length !== 1) {
        return {
          value: err('INVALID_INPUT', 'Only single-instance scopes are available in this version.'),
          save: false,
        };
      }
      for (const alias of input.instances) {
        if (!registry.some((e) => e.alias === alias)) {
          return {
            value: err('INSTANCE_NOT_REGISTERED', `No registered instance "${alias}".`),
            save: false,
          };
        }
      }
      const now = this.deps.now();
      const record: ScopeRequestRecord = {
        requestId: `req_${base64url(this.deps.randomBytes(16))}`,
        approvalCode: makeApprovalCode(this.deps.randomBytes),
        clientKeyId: client.keyId,
        clientLabel: client.label,
        instances: [...input.instances],
        mode: input.mode,
        purpose: input.purpose,
        createdAt: now,
        expiresAt: now + SCOPE_REQUEST_TTL_SECONDS * 1000,
        status: 'pending',
      };
      state.requests.push(record);
      return {
        value: {
          ok: true,
          value: {
            requestId: record.requestId,
            approvalCode: record.approvalCode,
            expiresInSeconds: SCOPE_REQUEST_TTL_SECONDS,
          },
        },
        save: true,
      };
    });
  }

  /** User action (popup only). PROD/unclassified needs the host typed exactly. */
  approve(
    requestId: string,
    registry: readonly InstanceEntry[],
    typedHost?: string,
  ): Promise<GrantResult<true>> {
    return this.exclusive<GrantResult<true>>(async (state) => {
      const r = state.requests.find((x) => x.requestId === requestId && x.status === 'pending');
      if (!r) return { value: err('NOT_FOUND', 'The request is no longer pending.'), save: false };
      const entries = r.instances.map((a) => registry.find((e) => e.alias === a));
      if (entries.some((e) => !e)) {
        return { value: err('INSTANCE_NOT_REGISTERED', 'An instance was removed.'), save: false };
      }
      const resolved = entries as InstanceEntry[];
      for (const e of resolved) {
        if (effectiveEnv(e.env) === 'prod' && typedHost?.trim().toLowerCase() !== e.host) {
          return {
            value: err('INVALID_INPUT', `Type ${e.host} to approve access to a PROD instance.`),
            save: false,
          };
        }
      }
      r.status = 'approved';
      r.approvedAt = this.deps.now();
      r.ttlMinutes = Math.min(...resolved.map((e) => defaultTtlMinutes(e.env)));
      return { value: { ok: true, value: true }, save: true };
    });
  }

  deny(requestId: string): Promise<GrantResult<true>> {
    return this.exclusive<GrantResult<true>>(async (state) => {
      const r = state.requests.find((x) => x.requestId === requestId && x.status === 'pending');
      if (!r) return { value: err('NOT_FOUND', 'The request is no longer pending.'), save: false };
      r.status = 'denied';
      return { value: { ok: true, value: true }, save: true };
    });
  }

  /** Claim by the requesting client only, exactly once. Another client sees NOT_FOUND. */
  claim(clientKeyId: string, requestId: string): Promise<GrantResult<ClaimValue>> {
    return this.exclusive<GrantResult<ClaimValue>>(async (state) => {
      const r = state.requests.find((x) => x.requestId === requestId);
      if (!r || r.clientKeyId !== clientKeyId) {
        // Pruned (expired) requests and other clients' requests look the same.
        return { value: { ok: true, value: { status: 'expired' as const } }, save: false };
      }
      if (r.status !== 'approved') {
        return { value: { ok: true, value: { status: r.status } }, save: false };
      }
      const scopeId = `scp_${base64url(this.deps.randomBytes(16))}`;
      const now = this.deps.now();
      const expiresAt = (r.approvedAt ?? now) + (r.ttlMinutes ?? 15) * 60_000;
      state.grants.push({
        grantId: base64url(this.deps.randomBytes(12)),
        scopeHash: await this.deps.sha256Hex(scopeId),
        clientKeyId: r.clientKeyId,
        clientLabel: r.clientLabel,
        instances: [...r.instances],
        mode: r.mode,
        createdAt: now,
        expiresAt,
      });
      r.status = 'claimed';
      return {
        value: {
          ok: true,
          value: {
            status: 'approved' as const,
            scopeId,
            instances: [...r.instances],
            mode: r.mode,
            expiresAt: new Date(expiresAt).toISOString(),
          },
        },
        save: true,
      };
    });
  }

  /** Per-request check. Another client's scope is indistinguishable from an unknown one. */
  authorize(
    clientKeyId: string,
    scopeId: string,
    instance: string,
  ): Promise<GrantResult<GrantRecord>> {
    return this.exclusive<GrantResult<GrantRecord>>(async (state) => {
      if (!SCOPE_ID_RE.test(scopeId)) {
        return { value: err('SCOPE_UNKNOWN', 'Unknown scope. Request a new one.'), save: false };
      }
      const hash = await this.deps.sha256Hex(scopeId);
      const g = state.grants.find((x) => x.scopeHash === hash);
      if (!g || g.clientKeyId !== clientKeyId) {
        return { value: err('SCOPE_UNKNOWN', 'Unknown scope. Request a new one.'), save: false };
      }
      if (g.expiresAt <= this.deps.now()) {
        return {
          value: err('SCOPE_EXPIRED', 'The scope expired. Request a new one.'),
          save: false,
        };
      }
      if (!g.instances.includes(instance)) {
        return {
          value: err(
            'INSTANCE_NOT_IN_SCOPE',
            `Instance "${instance}" is not covered by this scope.`,
          ),
          save: false,
        };
      }
      return { value: { ok: true, value: g }, save: false };
    });
  }

  release(clientKeyId: string, scopeId: string): Promise<boolean> {
    return this.exclusive(async (state) => {
      const hash = await this.deps.sha256Hex(scopeId);
      const before = state.grants.length;
      state.grants = state.grants.filter(
        (g) => !(g.scopeHash === hash && g.clientKeyId === clientKeyId),
      );
      return { value: state.grants.length < before, save: true };
    });
  }

  /** User action (popup only). */
  revoke(grantId: string): Promise<boolean> {
    return this.exclusive(async (state) => {
      const before = state.grants.length;
      state.grants = state.grants.filter((g) => g.grantId !== grantId);
      return { value: state.grants.length < before, save: true };
    });
  }

  snapshot(): Promise<{ pending: ScopeRequestRecord[]; grants: GrantRecord[] }> {
    return this.exclusive(async (state) => ({
      value: {
        pending: state.requests.filter((r) => r.status === 'pending'),
        grants: state.grants
          .filter((g) => g.expiresAt > this.deps.now())
          .map((g) => ({ ...g, scopeHash: '' })), // never expose hashes to the UI
      },
      save: true,
    }));
  }

  clientStatus(
    clientKeyId: string,
    alias: string,
  ): Promise<{ pendingRequest: boolean; activeGrant: boolean }> {
    return this.exclusive(async (state) => ({
      value: {
        pendingRequest: state.requests.some(
          (r) =>
            r.clientKeyId === clientKeyId &&
            r.instances.includes(alias) &&
            (r.status === 'pending' || r.status === 'approved'),
        ),
        activeGrant: state.grants.some(
          (g) =>
            g.clientKeyId === clientKeyId &&
            g.instances.includes(alias) &&
            g.expiresAt > this.deps.now(),
        ),
      },
      save: false,
    }));
  }
}

export function chromeGrantStorage(): GrantStorage {
  const KEY = 'grants.v1';
  return {
    async load() {
      return (await chrome.storage.session.get(KEY))[KEY];
    },
    async save(state) {
      await chrome.storage.session.set({ [KEY]: state });
    },
  };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const browserGrantDeps: GrantDeps = {
  now: () => Date.now(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  sha256Hex,
};
