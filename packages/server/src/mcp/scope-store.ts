/**
 * What this MCP-server process knows about the scopes it claimed (in memory only; T-012).
 *
 * The extension stays authoritative and re-checks every request. This store only:
 * - resolves the target instance when a single-instance scope is used without `instance`;
 * - narrows early (a known scope used for an instance it doesn't cover, or after its expiry);
 * - attaches provenance (scope suffix, expiry).
 * It never widens anything, and no tool lists its contents.
 */
import type { ErrorCode } from '@sn-mcp/shared';

export interface KnownScope {
  instances: string[];
  mode: 'single' | 'compare';
  expiresAt: string;
}

export type TargetResolution =
  | { ok: true; instance: string; known?: KnownScope }
  | { ok: false; code: ErrorCode; message: string; hint?: string };

export class ScopeStore {
  private readonly scopes = new Map<string, KnownScope>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(scopeId: string, scope: KnownScope): void {
    this.scopes.set(scopeId, { ...scope, instances: [...scope.instances] });
  }

  get(scopeId: string): KnownScope | undefined {
    return this.scopes.get(scopeId);
  }

  forget(scopeId: string): void {
    this.scopes.delete(scopeId);
  }

  /**
   * Picks the instance a data tool targets. Unknown scopes (e.g. claimed before a server
   * restart) are still forwarded when an instance is given; the extension then decides.
   */
  resolveTarget(scopeId: string, instance?: string): TargetResolution {
    const known = this.scopes.get(scopeId);
    if (known && Date.parse(known.expiresAt) <= this.now()) {
      this.scopes.delete(scopeId);
      return {
        ok: false,
        code: 'SCOPE_EXPIRED',
        message: 'This scope expired.',
        hint: 'Call request_scope again; the user must approve a new request.',
      };
    }
    if (instance !== undefined) {
      if (known && !known.instances.includes(instance)) {
        return {
          ok: false,
          code: 'INSTANCE_NOT_IN_SCOPE',
          message: `This scope covers ${known.instances.join(', ')}, not "${instance}".`,
          hint: `Request a scope for "${instance}" with request_scope.`,
        };
      }
      return { ok: true, instance, ...(known ? { known } : {}) };
    }
    if (!known) {
      return {
        ok: false,
        code: 'SCOPE_UNKNOWN',
        message: 'Unknown scope_id for this connector session.',
        hint: 'Use the scope_id returned by claim_scope in this conversation, or request a new scope.',
      };
    }
    if (known.instances.length !== 1) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `This compare scope covers ${known.instances.join(' and ')}; pass "instance".`,
      };
    }
    return { ok: true, instance: known.instances[0] as string, known };
  }
}
