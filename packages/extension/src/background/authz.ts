/**
 * Handles requests forwarded by the (untrusted) broker. Every sn.op is authorized against the
 * grant store on every call: scope hash, client binding, expiry, and instance coverage.
 */
import {
  type ErrorCode,
  ForwardSchema,
  PROTOCOL_VERSION,
  protocolError,
  type ResponseEnvelope,
  type Result,
} from '@sn-mcp/shared';
import type { ExecResult } from './executor.js';
import type { Grants } from './grants.js';
import { type InstanceEntry, originPattern } from './registry.js';

export interface AuthzDeps {
  grants: Grants;
  registry: () => Promise<InstanceEntry[]>;
  hasPermission: (origin: string) => Promise<boolean>;
  execute: (host: string, op: unknown) => Promise<ExecResult>;
  onPendingChanged?: () => void;
}

const v = PROTOCOL_VERSION;

function errorResponse(id: string, code: ErrorCode, message: string): ResponseEnvelope {
  return { v, kind: 'response', id, ok: false, error: protocolError(code, message) };
}

function okResponse(id: string, result: Result): ResponseEnvelope {
  return { v, kind: 'response', id, ok: true, result };
}

/** Returns the response to send back, or undefined if the message was not a valid forward. */
export async function handleForward(
  raw: unknown,
  d: AuthzDeps,
): Promise<ResponseEnvelope | undefined> {
  const parsed = ForwardSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { client, request } = parsed.data;
  const id = request.id;
  try {
    switch (request.kind) {
      case 'registry.get': {
        const instances = [];
        for (const e of await d.registry()) {
          instances.push({
            alias: e.alias,
            label: e.label.slice(0, 64),
            host: e.host,
            env: e.env,
            connection: 'unknown' as const,
            thisClient: await d.grants.clientStatus(client.keyId, e.alias),
          });
        }
        return okResponse(id, { type: 'registry.get', instances });
      }
      case 'scope.request': {
        const r = await d.grants.createRequest(
          { keyId: client.keyId, label: client.label },
          { instances: request.instances, mode: request.mode, purpose: request.purpose },
          await d.registry(),
        );
        if (!r.ok) return errorResponse(id, r.code, r.message);
        d.onPendingChanged?.();
        return okResponse(id, { type: 'scope.request', ...r.value });
      }
      case 'scope.claim': {
        const r = await d.grants.claim(client.keyId, request.requestId);
        if (!r.ok) return errorResponse(id, r.code, r.message);
        d.onPendingChanged?.();
        return okResponse(id, { type: 'scope.claim', ...r.value });
      }
      case 'scope.release': {
        const released = await d.grants.release(client.keyId, request.scopeId);
        return okResponse(id, { type: 'scope.release', released });
      }
      case 'sn.op': {
        const grant = await d.grants.authorize(client.keyId, request.scopeId, request.instance);
        if (!grant.ok) return errorResponse(id, grant.code, grant.message);
        const entry = (await d.registry()).find((e) => e.alias === request.instance);
        if (!entry) {
          return errorResponse(
            id,
            'INSTANCE_NOT_REGISTERED',
            `No registered instance "${request.instance}".`,
          );
        }
        if (!(await d.hasPermission(originPattern(entry.host)))) {
          return errorResponse(
            id,
            'INSTANCE_NOT_REGISTERED',
            `Host permission for ${entry.host} was removed.`,
          );
        }
        const r = await d.execute(entry.host, request.op);
        if (!r.ok) return errorResponse(id, r.code, r.message);
        return okResponse(id, {
          type: 'sn.op',
          instance: entry.alias,
          host: entry.host,
          env: entry.env,
          status: r.status,
          body: r.body,
          ...(r.totalCount !== undefined ? { totalCount: r.totalCount } : {}),
          bytes: r.bytes,
        });
      }
    }
  } catch {
    return errorResponse(id, 'SN_API_ERROR', 'Internal extension error.');
  }
}
