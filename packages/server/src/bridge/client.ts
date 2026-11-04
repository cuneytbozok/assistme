/**
 * Bridge client used by the MCP server (ARCHITECTURE §4.5).
 *
 * - One random client key per MCP-server process; its SHA-256 (client_key_id) is what grants
 *   are bound to, so it survives reconnects but never outlives the process.
 * - Lazy connect on first use; reconnect on the next call after a disconnect (the broker key
 *   rotates on every broker start, so every connect re-authenticates).
 * - Requests in flight when the connection drops fail with BRIDGE_UNAVAILABLE and are never
 *   replayed.
 */
import { randomBytes } from 'node:crypto';
import {
  type ErrorCode,
  PROTOCOL_VERSION,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@sn-mcp/shared';
import { defaultRuntimeDir } from '../native-host/socket-guard.js';
import { type AuthenticatedConnection, BridgeAuthError, connectToBroker } from './handshake.js';

/** A request without the envelope fields the client fills in. */
export type BridgeRequest = RequestEnvelope extends infer R
  ? R extends { v: number; id: string }
    ? Omit<R, 'v' | 'id'>
    : never
  : never;

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeClientOptions {
  dir?: string;
  label: { name: string; pid: number; cwd?: string };
  connectTimeoutMs?: number;
  /** Client-side safety net; the broker and extension enforce their own timeouts first. */
  requestTimeoutMs?: number;
}

export class BridgeClient {
  private readonly clientKey = randomBytes(16);
  private conn?: AuthenticatedConnection;
  private connecting?: Promise<AuthenticatedConnection>;
  private readonly pending = new Map<
    string,
    {
      conn: AuthenticatedConnection;
      resolve: (r: ResponseEnvelope) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private seq = 0;
  private readonly dir: string;

  constructor(private readonly o: BridgeClientOptions) {
    this.dir = o.dir ?? defaultRuntimeDir();
  }

  get keyIdPrefix(): string | undefined {
    return this.conn?.keyId.slice(0, 8);
  }

  private async connection(): Promise<AuthenticatedConnection> {
    if (this.conn && !this.conn.isOpen()) this.conn = undefined;
    if (this.conn) return this.conn;
    this.connecting ??= (async () => {
      try {
        const conn = await connectToBroker(
          this.dir,
          { clientKey: this.clientKey, label: this.o.label },
          this.o.connectTimeoutMs ?? 2000,
        );
        conn.onMessage((m) => {
          if (m.kind === 'broker.status' && m.state === 'shutting_down') {
            // Stop using this connection now; its close event may arrive later.
            if (this.conn === conn) this.conn = undefined;
            return;
          }
          if (m.kind !== 'response') return;
          const p = this.pending.get(m.id);
          if (!p || p.conn !== conn) return;
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          p.resolve(m);
        });
        conn.onClose(() => {
          if (this.conn === conn) this.conn = undefined;
          // Only this connection's requests fail; never those sent on a newer connection.
          for (const [id, p] of this.pending) {
            if (p.conn !== conn) continue;
            clearTimeout(p.timer);
            p.reject(
              new BridgeError(
                'BRIDGE_UNAVAILABLE',
                'The connection to the Chrome bridge was lost.',
              ),
            );
            this.pending.delete(id);
          }
        });
        this.conn = conn;
        return conn;
      } catch (e) {
        if (e instanceof BridgeAuthError) {
          throw new BridgeError(
            'BRIDGE_UNAVAILABLE',
            e.code === 'BROKER_AUTH_FAILED'
              ? 'Could not authenticate to the Chrome bridge.'
              : 'The Chrome bridge is not running. Open Chrome with the sn-mcp extension enabled.',
          );
        }
        throw new BridgeError('BRIDGE_UNAVAILABLE', 'The Chrome bridge is not reachable.');
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Sends one request. Never retried or replayed by this client. */
  async request(request: BridgeRequest): Promise<ResponseEnvelope> {
    const conn = await this.connection();
    const id = `m${++this.seq}`;
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('TIMEOUT', 'No answer from the Chrome bridge in time.'));
      }, this.o.requestTimeoutMs ?? 340_000);
      this.pending.set(id, { conn, resolve, reject, timer });
      conn.send({ v: PROTOCOL_VERSION, id, ...request });
    });
  }

  close(): void {
    this.conn?.close();
    this.conn = undefined;
  }
}
