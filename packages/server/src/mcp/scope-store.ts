/**
 * What this MCP-server process knows about the scopes it claimed (in memory only).
 * The extension stays authoritative; this only maps a scope_id to its instances so tools can
 * default the target instance. Scope ids are never listed by any tool.
 */
export interface KnownScope {
  instances: string[];
  mode: 'single' | 'compare';
  expiresAt: string;
}

export class ScopeStore {
  private readonly scopes = new Map<string, KnownScope>();

  remember(scopeId: string, scope: KnownScope): void {
    this.scopes.set(scopeId, scope);
  }

  get(scopeId: string): KnownScope | undefined {
    return this.scopes.get(scopeId);
  }

  forget(scopeId: string): void {
    this.scopes.delete(scopeId);
  }
}
