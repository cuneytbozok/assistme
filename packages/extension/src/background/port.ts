/**
 * Native-messaging port to the broker (ARCHITECTURE §4.5).
 *
 * - connectNative on service-worker start; exponential backoff (1 s → 60 s) on disconnect.
 * - 20 s heartbeat; an open port also keeps the MV3 service worker alive. No inbound message
 *   for 60 s (a hung host) → the port is dropped and reconnected (T-014).
 * - Every connection has a generation number. A forwarded request's response is sent only on
 *   the connection it arrived on; after a reconnect, late answers are dropped (never replayed
 *   to a new broker, whose request ids could otherwise collide).
 * - `broker.status: conflict` (another Chrome profile owns the broker) is surfaced and retried
 *   slowly.
 * - Every outbound message is schema-checked and passed through the credential guard: a
 *   message containing a known session token is never sent.
 */
import {
  type BrokerToExtension,
  BrokerToExtensionSchema,
  type ExtensionToBroker,
  ExtensionToBrokerSchema,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  protocolError,
} from '@sn-mcp/shared';
import { containsSecret } from './executor.js';

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export type BridgeState =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'conflict' }
  | { state: 'disconnected'; reason: string; retryInMs: number };

export interface PortDeps {
  connect: () => PortLike;
  lastError: () => string | undefined;
  /** `generation` identifies the connection the message arrived on (see `respond`). */
  onMessage: (m: BrokerToExtension, generation: number) => void;
  onReady: () => void;
  onState: (s: BridgeState) => void;
  secrets: () => readonly string[];
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  now?: () => number;
}

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
export const CONFLICT_RETRY_MS = 60_000;

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
}

export class BridgePort {
  private port?: PortLike;
  private attempt = 0;
  private heartbeat?: unknown;
  private retryTimer?: unknown;
  private conflict = false;
  private pingSeq = 0;
  private generation = 0;
  private lastInbound = 0;
  blockedSends = 0;
  droppedStale = 0;

  constructor(private readonly d: PortDeps) {}

  start(): void {
    if (this.port || this.retryTimer !== undefined) return;
    this.connect();
  }

  private timers() {
    return {
      setTimeout: this.d.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
      clearTimeout: this.d.clearTimeout ?? ((h: unknown) => clearTimeout(h as number)),
      setInterval: this.d.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms)),
      clearInterval: this.d.clearInterval ?? ((h: unknown) => clearInterval(h as number)),
    };
  }

  private connect(): void {
    this.retryTimer = undefined;
    this.conflict = false;
    this.d.onState({ state: 'connecting' });
    let port: PortLike;
    try {
      port = this.d.connect();
    } catch (e) {
      this.scheduleRetry(String(e));
      return;
    }
    this.port = port;
    const gen = ++this.generation;
    const now = this.d.now ?? (() => Date.now());
    this.lastInbound = now();
    port.onMessage.addListener((m) => {
      if (gen !== this.generation) return; // a message from a connection we already dropped
      this.lastInbound = now();
      this.onMessage(m, gen);
    });
    port.onDisconnect.addListener(() => {
      if (gen === this.generation && this.port === port) this.onDisconnect();
    });
    const t = this.timers();
    this.heartbeat = t.setInterval(() => {
      if (now() - this.lastInbound > HEARTBEAT_TIMEOUT_MS) {
        this.drop(port, 'heartbeat timeout');
        return;
      }
      this.send({ v: PROTOCOL_VERSION, kind: 'ping', id: `hb${++this.pingSeq}` });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Abandons a connection that stopped answering; `onDisconnect` may never fire for it. */
  private drop(port: PortLike, reason: string): void {
    if (this.port !== port) return;
    this.generation++; // anything still arriving on it is ignored
    try {
      port.disconnect();
    } catch {
      // already gone
    }
    this.onDisconnect(reason);
  }

  private onMessage(raw: unknown, gen: number): void {
    const parsed = BrokerToExtensionSchema.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.kind === 'broker.status') {
      if (m.state === 'ready') {
        this.attempt = 0;
        this.d.onState({ state: 'connected' });
        this.d.onReady();
      } else if (m.state === 'conflict') {
        this.conflict = true;
        this.d.onState({ state: 'conflict' });
      }
      return;
    }
    if (m.kind === 'ping') {
      this.send({ v: PROTOCOL_VERSION, kind: 'pong', id: m.id });
      return;
    }
    if (m.kind === 'pong') return;
    this.d.onMessage(m, gen);
  }

  private onDisconnect(forced?: string): void {
    const reason = forced ?? this.d.lastError() ?? 'disconnected';
    const t = this.timers();
    if (this.heartbeat !== undefined) t.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.port = undefined;
    if (this.conflict) {
      this.retryTimer = t.setTimeout(() => this.connect(), CONFLICT_RETRY_MS);
      return;
    }
    this.scheduleRetry(reason);
  }

  private scheduleRetry(reason: string): void {
    const delay = backoffMs(this.attempt++);
    this.d.onState({ state: 'disconnected', reason, retryInMs: delay });
    this.retryTimer = this.timers().setTimeout(() => this.connect(), delay);
  }

  /**
   * Sends the response to a forwarded request, but only on the connection the request came in
   * on. If the credential guard (or the schema) blocks it, an error response without the
   * content is sent instead, so the caller still gets an answer.
   */
  respond(message: ExtensionToBroker, generation: number): boolean {
    if (generation !== this.generation || !this.port) {
      this.droppedStale++;
      return false;
    }
    if (this.send(message)) return true;
    if (message.kind !== 'response') return false;
    return this.send({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: message.id,
      ok: false,
      error: protocolError('SN_API_ERROR', 'The response was withheld by the extension.'),
    });
  }

  /** Schema check + credential guard. Returns false when the message was not sent. */
  send(message: ExtensionToBroker): boolean {
    const checked = ExtensionToBrokerSchema.safeParse(message);
    if (!checked.success) return false;
    if (containsSecret(JSON.stringify(checked.data), this.d.secrets())) {
      this.blockedSends++;
      return false;
    }
    if (!this.port) return false;
    try {
      this.port.postMessage(checked.data);
      return true;
    } catch {
      return false;
    }
  }
}

export function chromeConnect(): PortLike {
  return chrome.runtime.connectNative(NATIVE_HOST_NAME) as unknown as PortLike;
}
