/**
 * What a tool module needs from the server: the bridge, scope store, cursor codec, settings,
 * metadata, and the helpers that turn bridge outcomes into tool results.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { BridgeClient, BridgeRequest } from '../../bridge/client.js';
import type { ServerConfig } from '../../config.js';
import type { CursorCodec } from '../cursor.js';
import type { FieldCache } from '../field-cache.js';
import type { MetaContext, MetadataService } from '../metadata.js';
import type { ScopeStore } from '../scope-store.js';
import type { Ok } from './common.js';

export type CallOutcome<T extends string> =
  | { ok: false; error: CallToolResult; code?: string }
  | { ok: true; value: Ok<T> };

export interface ToolContext {
  bridge: BridgeClient;
  scopes: ScopeStore;
  cursors: CursorCodec;
  config: ServerConfig;
  meta: MetadataService;
  fieldCache: FieldCache;
  metaContext: (scopeId: string, instance: string) => MetaContext;
  metadataError: (e: unknown, scopeId: string) => CallToolResult;
  call: <T extends string>(
    type: T,
    request: BridgeRequest,
    scopeId?: string,
  ) => Promise<CallOutcome<T>>;
  requireScope: (scopeId: string | undefined) => CallToolResult | string;
}
