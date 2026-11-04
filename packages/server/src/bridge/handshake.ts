/**
 * Client side of the broker handshake (ARCHITECTURE §4.3). Used by the MCP server (T-008).
 *
 * Verifies the broker's proof before proving itself, so a process squatting on the socket path
 * without the current key is detected and nothing is sent to it.
 */

import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  AUTH_TIMEOUT_MS,
  AuthOkSchema,
  type BrokerToClient,
  BrokerToClientSchema,
  ChallengeSchema,
  PROTOCOL_VERSION,
} from '@sn-mcp/shared';
import {
  brokerProof,
  clientKeyId,
  clientProof,
  currentUid,
  newNonce,
  proofsEqual,
  readBrokerKey,
} from '../native-host/auth.js';
import { encodeFrame, FrameDecoder, MAX_FROM_EXTENSION_BYTES } from '../native-host/framing.js';
import { checkSocketFile, SOCKET_FILE } from '../native-host/socket-guard.js';

export class BridgeAuthError extends Error {
  constructor(
    readonly code: 'BROKER_AUTH_FAILED' | 'BRIDGE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

export interface ClientIdentity {
  clientKey: Buffer;
  label: { name: string; pid: number; cwd?: string };
}

export interface AuthenticatedConnection {
  keyId: string;
  send(message: unknown): void;
  onMessage(listener: (m: BrokerToClient) => void): void;
  onClose(listener: () => void): void;
  /** False once the socket is closed or no longer writable. */
  isOpen(): boolean;
  close(): void;
}

export async function connectToBroker(
  dir: string,
  identity: ClientIdentity,
  timeoutMs = AUTH_TIMEOUT_MS,
): Promise<AuthenticatedConnection> {
  const uid = currentUid();
  const path = join(dir, SOCKET_FILE);
  let key: Buffer;
  try {
    checkSocketFile(path, uid);
    key = readBrokerKey(dir, uid);
  } catch (e) {
    throw new BridgeAuthError(
      'BRIDGE_UNAVAILABLE',
      `broker not available: ${(e as Error).message}`,
    );
  }
  const socket: Socket = connect(path);
  const decoder = new FrameDecoder(MAX_FROM_EXTENSION_BYTES);
  const queue: unknown[] = [];
  let waiter: ((m: unknown) => void) | undefined;
  let listener: ((m: BrokerToClient) => void) | undefined;
  const closeListeners: (() => void)[] = [];
  let authenticated = false;

  const fail = (code: BridgeAuthError['code'], msg: string): never => {
    socket.destroy();
    throw new BridgeAuthError(code, msg);
  };

  socket.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const m of messages) {
      if (!authenticated) {
        if (waiter) {
          const w = waiter;
          waiter = undefined;
          w(m);
        } else queue.push(m);
        continue;
      }
      const parsed = BrokerToClientSchema.safeParse(m);
      if (parsed.success) listener?.(parsed.data);
    }
  });
  socket.on('close', () => {
    for (const l of closeListeners) l();
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(undefined);
    }
  });
  socket.on('error', () => {});

  const next = (): Promise<unknown> =>
    new Promise((resolve) => {
      if (queue.length > 0) return resolve(queue.shift());
      const timer = setTimeout(() => {
        waiter = undefined;
        resolve(undefined);
      }, timeoutMs);
      waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', (e) => reject(new BridgeAuthError('BRIDGE_UNAVAILABLE', String(e))));
  });

  const keyId = clientKeyId(identity.clientKey);
  const clientNonce = newNonce();
  socket.write(
    encodeFrame({
      v: PROTOCOL_VERSION,
      kind: 'hello',
      clientNonce,
      clientKeyId: keyId,
      label: identity.label,
    }),
  );
  const challenge = ChallengeSchema.safeParse(await next());
  if (!challenge.success) return fail('BROKER_AUTH_FAILED', 'no valid challenge from broker');
  if (!proofsEqual(challenge.data.brokerProof, brokerProof(key, clientNonce))) {
    return fail('BROKER_AUTH_FAILED', 'broker proof mismatch (not the real broker)');
  }
  socket.write(
    encodeFrame({
      v: PROTOCOL_VERSION,
      kind: 'auth',
      clientProof: clientProof(key, challenge.data.brokerNonce, clientNonce),
    }),
  );
  const ok = AuthOkSchema.safeParse(await next());
  if (!ok.success) return fail('BROKER_AUTH_FAILED', 'broker did not accept authentication');
  authenticated = true;
  for (const m of queue.splice(0)) {
    const parsed = BrokerToClientSchema.safeParse(m);
    if (parsed.success) listener?.(parsed.data);
  }

  return {
    keyId,
    send: (message) => socket.write(encodeFrame(message)),
    onMessage: (l) => {
      listener = l;
    },
    onClose: (l) => {
      closeListeners.push(l);
    },
    isOpen: () => !socket.destroyed && socket.writable,
    close: () => socket.destroy(),
  };
}
