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
 * Policies (ARCHITECTURE §5.4, T-011):
 * - Single grants cover one instance; compare grants cover one fixed pair of distinct instances.
 * - The strictest instance decides: if any is PROD/unclassified, every PROD host must be typed,
 *   and the TTL is chosen from the PROD range (default 15 min, max 60).
 * - DEV/TEST: default 4 h, max 12 h. The user picks the TTL at approval; it can't be changed or
 *   renewed afterwards (a new request is needed).
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
  /** Set on approval: what the user approved (alias → host and env at that moment). */
  targets?: GrantTarget[];
}

/** The policy class a grant gets: the strictest of its instances. */
export type PolicyEnv = 'dev' | 'test' | 'prod';

/** The registry entry a grant was approved for. A grant never follows a changed entry. */
export interface GrantTarget {
  alias: string;
  host: string;
  env: InstanceEntry['env'];
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
  targets: GrantTarget[];
  /** Strictest effective env across the instances (prod if any is prod/unclassified). */
  env: PolicyEnv;
  /** Shown in the popup next to the grant (untrusted text from Claude; rendered as text). */
  purpose: string;
  approvedAt: number;
}

function policyOfTargets(targets: readonly GrantTarget[]): PolicyEnv {
  const envs = targets.map((t) => effectiveEnv(t.env));
  if (envs.length === 0 || envs.includes('prod')) return 'prod';
  return envs.includes('test') ? 'test' : 'dev';
}

/** True when the registry entry still matches exactly what the user approved. */
export function targetMatches(targets: readonly GrantTarget[], entry: InstanceEntry): boolean {
  return targets.some(
    (t) => t.alias === entry.alias && t.host === entry.host && t.env === entry.env,
  );
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

/** Strictest policy across entries: prod > test > dev. */
export function policyEnv(entries: readonly InstanceEntry[]): PolicyEnv {
  const envs = entries.map((e) => effectiveEnv(e.env));
  if (envs.includes('prod')) return 'prod';
  if (envs.includes('test')) return 'test';
  return 'dev';
}

/** TTL choices offered in the popup for a policy class (minutes; first is not the default). */
export const TTL_CHOICES: Record<PolicyEnv, readonly number[]> = {
  dev: [60, 240, 480, 720],
  test: [60, 240, 480, 720],
  prod: [15, 30, 60],
};

export interface ApproveOptions {
  /** Hosts the user typed to confirm PROD instances (each PROD host must be present). */
  typedHosts?: readonly string[];
  /** Chosen lifetime; must be within the policy's range. Default: the policy default. */
  ttlMinutes?: number;
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
      const distinct = new Set(input.instances).size === input.instances.length;
      if (
        !distinct ||
        (input.mode === 'single' && input.instances.length !== 1) ||
        (input.mode === 'compare' && input.instances.length !== 2)
      ) {
        return {
          value: err(
            'INVALID_INPUT',
            'A single scope covers exactly one instance; a compare scope covers two different instances.',
          ),
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

  /**
   * User action (popup only). Every PROD/unclassified instance needs its host typed exactly.
   * `confirm` may be a single typed host (shorthand) or full options.
   */
  approve(
    requestId: string,
    registry: readonly InstanceEntry[],
    confirm?: string | ApproveOptions,
  ): Promise<GrantResult<true>> {
    const opts: ApproveOptions =
      typeof confirm === 'string' ? { typedHosts: [confirm] } : (confirm ?? {});
    return this.exclusive<GrantResult<true>>(async (state) => {
      const r = state.requests.find((x) => x.requestId === requestId && x.status === 'pending');
      if (!r) return { value: err('NOT_FOUND', 'The request is no longer pending.'), save: false };
      const entries = r.instances.map((a) => registry.find((e) => e.alias === a));
      if (entries.some((e) => !e)) {
        return { value: err('INSTANCE_NOT_REGISTERED', 'An instance was removed.'), save: false };
      }
      const resolved = entries as InstanceEntry[];
      const typed = new Set((opts.typedHosts ?? []).map((h) => h.trim().toLowerCase()));
      for (const e of resolved) {
        if (effectiveEnv(e.env) === 'prod' && !typed.has(e.host)) {
          return {
            value: err('INVALID_INPUT', `Type ${e.host} to approve access to a PROD instance.`),
            save: false,
          };
        }
      }
      const policy = policyEnv(resolved);
      const range = GRANT_TTL_MINUTES[policy];
      const ttl = opts.ttlMinutes ?? range.default;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > range.max) {
        return {
          value: err('INVALID_INPUT', `Access can last at most ${range.max} min for this request.`),
          save: false,
        };
      }
      r.status = 'approved';
      r.approvedAt = this.deps.now();
      r.ttlMinutes = ttl;
      r.targets = resolved.map((e) => ({ alias: e.alias, host: e.host, env: e.env }));
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
        targets: (r.targets ?? []).map((t) => ({ ...t })),
        env: policyOfTargets(r.targets ?? []),
        purpose: r.purpose,
        approvedAt: r.approvedAt ?? now,
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

  /** User action (popup only): ends every grant and denies every open request. */
  revokeAll(): Promise<number> {
    return this.exclusive(async (state) => {
      let n = state.grants.filter((g) => g.expiresAt > this.deps.now()).length;
      state.grants = [];
      for (const r of state.requests) {
        if (r.status === 'pending' || r.status === 'approved') {
          r.status = 'denied';
          n++;
        }
      }
      return { value: n, save: true };
    });
  }

  /**
   * Registry changed (T-010): drops every grant, and denies every open request, that refers to
   * an alias no longer registered or whose host/env differ from what was approved. Called with
   * the new registry after every registry mutation, and on every storage change as a backstop.
   * Returns the number of grants and requests invalidated.
   */
  reconcile(registry: readonly InstanceEntry[]): Promise<number> {
    return this.exclusive(async (state) => {
      const valid = (alias: string, targets: readonly GrantTarget[] | undefined): boolean => {
        const e = registry.find((x) => x.alias === alias);
        if (!e) return false;
        return targets === undefined || targetMatches(targets, e);
      };
      let n = 0;
      state.grants = state.grants.filter((g) => {
        const keep = g.instances.every((a) => valid(a, g.targets ?? []));
        if (!keep) n++;
        return keep;
      });
      for (const r of state.requests) {
        if (r.status !== 'pending' && r.status !== 'approved') continue;
        if (!r.instances.every((a) => valid(a, r.targets))) {
          r.status = 'denied';
          n++;
        }
      }
      return { value: n, save: n > 0 };
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

/**
 * Badge: pending request count (blue). While any PROD grant is active the badge turns red and
 * shows "PROD" when nothing is pending (FR-3.6).
 */
export function badgeFor(
  pending: number,
  grants: readonly { env: string; expiresAt: number }[],
  now: number,
): { text: string; color: string } {
  const prodActive = grants.some((g) => g.env === 'prod' && g.expiresAt > now);
  return {
    text: pending > 0 ? String(pending) : prodActive ? 'PROD' : '',
    color: prodActive ? '#dc2626' : '#2563eb',
  };
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
