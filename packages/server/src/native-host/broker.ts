/**
 * The broker: relays requests from authenticated MCP-server clients (Unix socket) to the
 * extension (native-messaging stdio), and responses back (ARCHITECTURE §4, ADR-001).
 *
 * It is a dumb, untrusted relay: the extension re-validates everything. Its own job is
 * client authentication, request-ID rewriting (no cross-delivery), a per-client in-flight cap,
 * size limits and lifecycle. It never replays a request.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import {
  AUTH_TIMEOUT_MS,
  AuthSchema,
  BROKER_MAX_IN_FLIGHT_PER_CLIENT,
  BrokerToExtensionSchema,
  ClientToBrokerSchema,
  type ErrorCode,
  ExtensionToBrokerSchema,
  HelloSchema,
  MAX_UPSTREAM_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  protocolError,
  type RequestEnvelope,
} from '@sn-mcp/shared';
import {
  AuthFailureLimiter,
  brokerProof,
  clientProof,
  newNonce,
  proofsEqual,
  removeBrokerKey,
  writeBrokerKey,
} from './auth.js';
import type { CaptureWriter } from './capture.js';
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  MAX_FROM_EXTENSION_BYTES,
  MAX_TO_EXTENSION_BYTES,
} from './framing.js';
import type { Logger } from './logger.js';
import {
  acquireLock,
  checkSocketFile,
  ensureRuntimeDir,
  prepareSocketPath,
} from './socket-guard.js';

export interface BrokerOptions {
  dir: string;
  uid: number;
  extIn: Readable;
  extOut: Writable;
  logger: Logger;
  authTimeoutMs?: number;
  maxInFlightPerClient?: number;
  /** Safety net if the extension never answers (> the extension's max request timeout). */
  pendingTimeoutMs?: number;
  limiter?: AuthFailureLimiter;
  /** Dev-only traffic capture (T-009). */
  capture?: CaptureWriter;
}

type ClientState = 'await_hello' | 'await_auth' | 'authenticated' | 'closed';

interface ClientConn {
  n: number;
  socket: Socket;
  decoder: FrameDecoder;
  state: ClientState;
  clientNonce?: string;
  brokerNonce?: string;
  keyId?: string;
  label?: { name: string; pid: number; cwd?: string };
  /** original id → broker id */
  inFlight: Map<string, string>;
  authTimer?: NodeJS.Timeout;
}

interface Pending {
  client: ClientConn;
  originalId: string;
  kind: RequestEnvelope['kind'];
  startedAt: number;
  timer: NodeJS.Timeout;
}

const v = PROTOCOL_VERSION;

export class Broker {
  private server?: Server;
  private socketPath?: string;
  private socketIno?: number;
  private key?: Buffer;
  private releaseLock?: () => void;
  private readonly clients = new Set<ClientConn>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  /**
   * Per-process id prefix (T-014). Chrome starts a new broker on every reconnect; a late answer
   * from an operation forwarded by a previous broker must never match a request of this one.
   */
  private readonly idPrefix = `b${randomBytes(6).toString('base64url')}`;
  private clientSeq = 0;
  private stopped = false;
  private stopping?: Promise<void>;
  private readonly limiter: AuthFailureLimiter;
  private readonly authTimeoutMs: number;
  private readonly maxInFlight: number;
  private readonly pendingTimeoutMs: number;

  constructor(private readonly o: BrokerOptions) {
    this.limiter = o.limiter ?? new AuthFailureLimiter();
    this.authTimeoutMs = o.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.maxInFlight = o.maxInFlightPerClient ?? BROKER_MAX_IN_FLIGHT_PER_CLIENT;
    this.pendingTimeoutMs = o.pendingTimeoutMs ?? 330_000;
  }

  get path(): string | undefined {
    return this.socketPath;
  }

  /** Throws BrokerStartError (UNSAFE_PATH / BROKER_CONFLICT). Cleans up after itself on failure. */
  async start(): Promise<void> {
    const { dir, uid } = this.o;
    ensureRuntimeDir(dir, uid);
    this.releaseLock = acquireLock(dir, uid);
    try {
      const path = await prepareSocketPath(dir, uid);
      this.key = writeBrokerKey(dir);
      this.server = createServer((s) => this.onConnection(s));
      this.server.maxConnections = 64;
      const previous = process.umask(0o077);
      try {
        await new Promise<void>((resolve, reject) => {
          this.server?.once('error', reject);
          this.server?.listen(path, () => resolve());
        });
      } finally {
        process.umask(previous);
      }
      chmodSync(path, 0o600);
      checkSocketFile(path, uid);
      this.socketPath = path;
      this.socketIno = lstatSync(path).ino;
    } catch (e) {
      this.cleanupFiles();
      throw e;
    }
    this.wireExtension();
    this.sendToExtension({ v, kind: 'broker.status', state: 'ready' });
    this.o.logger.log('broker.started');
  }

  /** Idempotent: every caller awaits the same shutdown. */
  stop(reason: string): Promise<void> {
    this.stopping ??= this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.stopped = true;
    this.o.logger.log('broker.stopping', { reason, inFlight: this.pending.size });
    for (const [brokerId, p] of this.pending) {
      clearTimeout(p.timer);
      this.sendError(p.client, p.originalId, 'BRIDGE_UNAVAILABLE', 'The broker is shutting down.');
      this.pending.delete(brokerId);
    }
    for (const c of this.clients) {
      this.sendToClient(c, { v, kind: 'broker.status', state: 'shutting_down' });
      this.closeClient(c, 'shutdown');
    }
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.cleanupFiles();
    this.o.logger.log('broker.stopped');
  }

  private cleanupFiles(): void {
    if (this.socketPath && this.socketIno !== undefined) {
      try {
        if (lstatSync(this.socketPath).ino === this.socketIno) unlinkSync(this.socketPath);
      } catch {
        // already gone
      }
    }
    if (this.key) removeBrokerKey(this.o.dir, this.key);
    this.releaseLock?.();
    this.releaseLock = undefined;
  }

  // --- extension side ------------------------------------------------------------------------

  private wireExtension(): void {
    const decoder = new FrameDecoder(MAX_FROM_EXTENSION_BYTES);
    this.o.extIn.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (e) {
        this.o.logger.log('ext.frame_error', {
          code: e instanceof FrameError ? e.code : 'UNKNOWN',
        });
        void this.stop('invalid frame from extension');
        return;
      }
      for (const m of messages) this.onExtensionMessage(m);
    });
    this.o.extIn.once('end', () => void this.stop('stdin closed'));
    this.o.extIn.once('close', () => void this.stop('stdin closed'));
  }

  private onExtensionMessage(raw: unknown): void {
    const parsed = ExtensionToBrokerSchema.safeParse(raw);
    if (!parsed.success) {
      this.o.logger.log('ext.invalid_message');
      return;
    }
    const m = parsed.data;
    this.o.capture?.record('ext>broker', m);
    switch (m.kind) {
      case 'ping':
        this.sendToExtension({ v, kind: 'pong', id: m.id });
        return;
      case 'pong':
        return;
      case 'registry.update':
        for (const c of this.clients) if (c.state === 'authenticated') this.sendToClient(c, m);
        return;
      case 'response': {
        const p = this.pending.get(m.id);
        if (!p) {
          this.o.logger.log('ext.unknown_response');
          return;
        }
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        p.client.inFlight.delete(p.originalId);
        if (p.client.state !== 'authenticated') return; // client went away: drop
        this.sendToClient(p.client, { ...m, id: p.originalId });
        this.o.logger.log('request.done', {
          kind: p.kind,
          client: p.client.keyId?.slice(0, 8),
          durationMs: Date.now() - p.startedAt,
          code: m.ok ? 'ok' : m.error.code,
        });
        return;
      }
    }
  }

  private sendToExtension(message: unknown): boolean {
    const checked = BrokerToExtensionSchema.safeParse(message);
    if (!checked.success) {
      this.o.logger.log('ext.refused_outbound');
      return false;
    }
    this.o.capture?.record('broker>ext', checked.data);
    try {
      this.o.extOut.write(encodeFrame(checked.data, MAX_TO_EXTENSION_BYTES));
      return true;
    } catch {
      this.o.logger.log('ext.write_failed');
      return false;
    }
  }

  // --- client side ---------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    if (this.stopped || this.limiter.isLimited()) {
      this.o.logger.log('client.refused', {
        reason: this.stopped ? 'stopping' : 'auth_rate_limited',
      });
      socket.destroy();
      return;
    }
    const c: ClientConn = {
      n: ++this.clientSeq,
      socket,
      decoder: new FrameDecoder(MAX_UPSTREAM_MESSAGE_BYTES),
      state: 'await_hello',
      inFlight: new Map(),
    };
    this.clients.add(c);
    c.authTimer = setTimeout(() => {
      if (c.state !== 'authenticated') this.rejectAuth(c, 'auth_timeout');
    }, this.authTimeoutMs);
    socket.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = c.decoder.push(chunk);
      } catch (e) {
        this.o.logger.log('client.frame_error', {
          code: e instanceof FrameError ? e.code : 'UNKNOWN',
        });
        if (c.state === 'authenticated') this.closeClient(c, 'frame_error');
        else this.rejectAuth(c, 'frame_error');
        return;
      }
      for (const m of messages) {
        if (c.state === 'closed') return;
        this.onClientMessage(c, m);
      }
    });
    socket.on('error', () => this.closeClient(c, 'socket_error'));
    socket.on('close', () => this.closeClient(c, 'socket_closed'));
  }

  private onClientMessage(c: ClientConn, raw: unknown): void {
    if (c.state === 'await_hello') {
      const hello = HelloSchema.safeParse(raw);
      if (!hello.success || !this.key) {
        this.rejectAuth(c, 'bad_hello');
        return;
      }
      c.clientNonce = hello.data.clientNonce;
      c.keyId = hello.data.clientKeyId;
      c.label = hello.data.label;
      c.brokerNonce = newNonce();
      c.state = 'await_auth';
      this.sendToClient(c, {
        v,
        kind: 'challenge',
        brokerNonce: c.brokerNonce,
        brokerProof: brokerProof(this.key, c.clientNonce),
      });
      return;
    }
    if (c.state === 'await_auth') {
      const auth = AuthSchema.safeParse(raw);
      if (!auth.success || !this.key || !c.brokerNonce || !c.clientNonce) {
        this.rejectAuth(c, 'bad_auth');
        return;
      }
      const expected = clientProof(this.key, c.brokerNonce, c.clientNonce);
      if (!proofsEqual(auth.data.clientProof, expected)) {
        this.rejectAuth(c, 'wrong_proof');
        return;
      }
      clearTimeout(c.authTimer);
      c.state = 'authenticated';
      this.sendToClient(c, { v, kind: 'auth_ok' });
      this.o.logger.log('client.authenticated', {
        client: c.keyId?.slice(0, 8),
        clientName: c.label?.name,
        clients: this.authenticatedCount(),
      });
      return;
    }
    if (c.state !== 'authenticated') return;

    const parsed = ClientToBrokerSchema.safeParse(raw);
    if (!parsed.success) {
      this.o.logger.log('client.invalid_message', { client: c.keyId?.slice(0, 8) });
      this.closeClient(c, 'invalid_message');
      return;
    }
    const m = parsed.data;
    this.o.capture?.record('client>broker', m);
    if (m.kind === 'hello' || m.kind === 'auth') {
      this.closeClient(c, 'protocol_violation');
      return;
    }
    if (m.kind === 'ping') {
      this.sendToClient(c, { v, kind: 'pong', id: m.id });
      return;
    }
    this.forward(c, m);
  }

  private forward(c: ClientConn, request: RequestEnvelope): void {
    if (c.inFlight.has(request.id)) {
      this.sendError(
        c,
        request.id,
        'INVALID_INPUT',
        'A request with this id is already in flight.',
      );
      return;
    }
    if (c.inFlight.size >= this.maxInFlight) {
      this.sendError(
        c,
        request.id,
        'RATE_LIMITED',
        `More than ${this.maxInFlight} requests in flight for this client.`,
      );
      return;
    }
    if (!c.keyId || !c.label) return;
    const brokerId = `${this.idPrefix}_${++this.seq}`;
    // Register before sending: the answer may arrive before sendToExtension returns.
    const timer = setTimeout(() => {
      if (!this.pending.delete(brokerId)) return;
      c.inFlight.delete(request.id);
      this.sendError(c, request.id, 'TIMEOUT', 'The extension did not answer in time.');
    }, this.pendingTimeoutMs);
    this.pending.set(brokerId, {
      client: c,
      originalId: request.id,
      kind: request.kind,
      startedAt: Date.now(),
      timer,
    });
    c.inFlight.set(request.id, brokerId);
    const sent = this.sendToExtension({
      v,
      kind: 'forward',
      client: { keyId: c.keyId, label: c.label },
      request: { ...request, id: brokerId },
    });
    if (!sent) {
      clearTimeout(timer);
      this.pending.delete(brokerId);
      c.inFlight.delete(request.id);
      this.sendError(c, request.id, 'BRIDGE_UNAVAILABLE', 'Could not forward the request.');
      return;
    }
    this.o.logger.log('request.forwarded', {
      kind: request.kind,
      client: c.keyId.slice(0, 8),
      inFlight: c.inFlight.size,
    });
  }

  private sendError(c: ClientConn, id: string, code: ErrorCode, message: string): void {
    this.sendToClient(c, {
      v,
      kind: 'response',
      id,
      ok: false,
      error: protocolError(code, message),
    });
  }

  private sendToClient(c: ClientConn, message: unknown): void {
    if (c.state === 'closed' || c.socket.destroyed) return;
    if (c.state === 'authenticated') this.o.capture?.record('broker>client', message);
    try {
      c.socket.write(encodeFrame(message));
    } catch {
      this.closeClient(c, 'write_failed');
    }
  }

  private rejectAuth(c: ClientConn, reason: string): void {
    if (c.state === 'closed') return;
    this.limiter.recordFailure();
    this.o.logger.log('client.auth_failed', { reason });
    this.closeClient(c, reason);
  }

  private closeClient(c: ClientConn, reason: string): void {
    if (c.state === 'closed') return;
    const wasAuthenticated = c.state === 'authenticated';
    c.state = 'closed';
    clearTimeout(c.authTimer);
    // Responses for this client's pending requests will be dropped; never replayed.
    for (const brokerId of c.inFlight.values()) {
      const p = this.pending.get(brokerId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(brokerId);
      }
    }
    c.inFlight.clear();
    c.socket.destroy();
    this.clients.delete(c);
    if (wasAuthenticated) {
      this.o.logger.log('client.closed', { client: c.keyId?.slice(0, 8), reason });
    }
  }

  private authenticatedCount(): number {
    let n = 0;
    for (const c of this.clients) if (c.state === 'authenticated') n++;
    return n;
  }
}
