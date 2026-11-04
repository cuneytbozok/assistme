/**
 * Session lifecycle and connection status per instance (T-013, ADR-002 Path A).
 *
 * States (FR-2.4): connected · no_tab · session_expired · no_permission · unknown.
 * - Local signals (host permission, an open tab of the host) are checked on every status read
 *   and by a 30 s refresh; they never touch the network.
 * - Session state is learned from real requests (executor results). A host marked expired is
 *   re-probed (one read-only GET with the tab's current token) at most every 30 s while a tab
 *   is open, so a re-login is noticed without a new grant.
 * - No credential prompts: every ServiceNow request carries X-UserToken, and with that header
 *   ServiceNow answers 401 with `WWW-Authenticate: none` (not `Basic`), so Chrome never shows
 *   its sign-in dialog (verified 2026-11-04; ADR-002 addendum). Requests without a token are
 *   never sent (NO_INSTANCE_TAB).
 */
import type { ExecResult } from './executor.js';

export type ConnectionState =
  | 'connected'
  | 'no_tab'
  | 'session_expired'
  | 'no_permission'
  | 'unknown';

export interface SessionDeps {
  hasPermission: (host: string) => Promise<boolean>;
  hasTab: (host: string) => Promise<boolean>;
  /** One read-only probe request through the executor (GET sys_db_object, limit 1). */
  probe: (host: string) => Promise<ExecResult>;
  now: () => number;
}

export const STATUS_REFRESH_MS = 30_000;
export const EXPIRED_REPROBE_MS = 30_000;

interface Observed {
  state: 'connected' | 'session_expired';
  at: number;
}

export class SessionTracker {
  private readonly observed = new Map<string, Observed>();
  private readonly lastProbe = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<ConnectionState>>();

  constructor(private readonly deps: SessionDeps) {}

  /** Learns from a real request's outcome. Other errors don't change the session state. */
  record(host: string, result: ExecResult): void {
    if (result.ok) this.observed.set(host, { state: 'connected', at: this.deps.now() });
    else if (result.code === 'SESSION_EXPIRED') {
      this.observed.set(host, { state: 'session_expired', at: this.deps.now() });
    } else if (result.code === 'NO_INSTANCE_TAB') this.observed.delete(host);
  }

  forget(host: string): void {
    this.observed.delete(host);
    this.lastProbe.delete(host);
  }

  /** Current state from local signals plus what requests have shown. No network. */
  async status(host: string): Promise<ConnectionState> {
    if (!(await this.deps.hasPermission(host))) return 'no_permission';
    if (!(await this.deps.hasTab(host))) {
      this.observed.delete(host); // closing every tab ends what we knew about the session
      return 'no_tab';
    }
    return this.observed.get(host)?.state ?? 'unknown';
  }

  /**
   * Status, probing when useful: `unknown` hosts are probed only when `probeUnknown` is set
   * (the user opened the popup); expired hosts are re-probed at most every EXPIRED_REPROBE_MS.
   */
  async check(host: string, opts: { probeUnknown?: boolean } = {}): Promise<ConnectionState> {
    const local = await this.status(host);
    const now = this.deps.now();
    const due = now - (this.lastProbe.get(host) ?? 0) >= EXPIRED_REPROBE_MS;
    const shouldProbe =
      (local === 'session_expired' && due) || (local === 'unknown' && opts.probeUnknown === true);
    if (!shouldProbe) return local;
    const running = this.inflight.get(host);
    if (running) return running;
    const run = (async () => {
      this.lastProbe.set(host, now);
      const r = await this.deps.probe(host);
      this.record(host, r);
      return this.status(host);
    })().finally(() => this.inflight.delete(host));
    this.inflight.set(host, run);
    return run;
  }

  /** Statuses for many hosts (e.g. the 30 s refresh). Returns true if any state changed. */
  async refresh(
    hosts: readonly string[],
    previous: ReadonlyMap<string, ConnectionState>,
    opts: { probeUnknown?: boolean } = {},
  ): Promise<{ states: Map<string, ConnectionState>; changed: boolean }> {
    const states = new Map<string, ConnectionState>();
    for (const h of hosts) states.set(h, await this.check(h, opts));
    const changed =
      states.size !== previous.size || [...states].some(([h, s]) => previous.get(h) !== s);
    return { states, changed };
  }
}

/** Popup wording for a state (rendered as text). */
export function describeState(state: ConnectionState, host: string): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'no_tab':
      return `Open ${host} in a tab and sign in`;
    case 'session_expired':
      return 'Session expired. Sign in again in your ServiceNow tab';
    case 'no_permission':
      return 'No Chrome access to this site. Remove and add it again';
    default:
      return 'Tab open, not checked yet';
  }
}
