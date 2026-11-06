/**
 * get_record (T-025): exactly one record, by sys_id or by a unique match. Never guesses: several
 * matches give AMBIGUOUS_MATCH with candidates and the call that lists them all. Long fields
 * follow the preview/omitted contract; `expand_references` adds compact referenced records.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { FieldPathSchema, isDeniedTable } from '@sn-mcp/shared';
import { z } from 'zod';
import {
  compactRecord,
  compactValue,
  defaultProjection,
  fitRecord,
  recordLink,
  stripSensitive,
} from '../compact.js';
import { planQuery } from '../query-guard.js';
import { dataResponse, type Omission } from '../response.js';
import { toolError } from '../results.js';
import {
  FieldListInput,
  InstanceInput,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  SysIdInput,
  TableInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import { MatchInput, resolveSysId } from './record-lookup.js';
import {
  mapConcurrent,
  maxCharsInput,
  RESPONSE_OVERHEAD_CHARS,
  resolveMaxChars,
  SnClient,
} from './support.js';

const EXPAND_CONCURRENCY = 4;
/** Field types that point at a record through another field, so their table isn't known here. */
const INDIRECT_REFERENCE_TYPES = new Set(['document_id']);

interface Expanded {
  field: string;
  table: string;
  sys_id: string;
  source: string;
  link?: string;
  summary: Record<string, unknown>;
}

export function registerGetRecord(server: McpServer, ctx: ToolContext): void {
  const { scopes, config, meta, metaContext, metadataError, requireScope } = ctx;
  server.registerTool(
    'get_record',
    {
      description:
        'Fetches exactly one record (`data.record`) by `sys_id`, or by `match` {field: value, …} where all must hold (e.g. {"number": "INC0010001"}). Several matches give AMBIGUOUS_MATCH with `total`, up to 5 candidates and `list_all` (the query_records call that lists them): it never guesses. `fields` defaults to all. `expand_references` (true, or a list of reference fields) adds compact referenced records in `data.references`. Long fields come as previews; `omitted` has the get_field_content call for the full text.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        table: TableInput,
        sys_id: SysIdInput.optional(),
        match: MatchInput.optional().describe(
          'Field values that identify one record, e.g. {"number": "INC0010001"}',
        ),
        fields: FieldListInput.optional(),
        display_value: z
          .enum(['all', 'true', 'false'])
          .optional()
          .describe('false (default): stored values; true: display values; all: both'),
        expand_references: z
          .union([z.boolean(), z.array(FieldPathSchema).min(1).max(50)])
          .optional()
          .describe('true for every reference field, or a list of reference fields'),
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const id = requireScope(args.scope_id);
      if (typeof id !== 'string') return id;
      const hints: string[] = [];
      const maxChars = resolveMaxChars(args.max_chars, config, hints);
      const target = scopes.resolveTarget(id, args.instance);
      if (!target.ok) return toolError(target.code, target.message, target.hint);
      const { table } = args;
      const denied = config.extraDeniedTables;
      if (isDeniedTable(table, denied)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      const mc = metaContext(id, target.instance);
      const sn = new SnClient(ctx, id, target.instance);
      let known: Awaited<ReturnType<typeof meta.fields>>;
      let projection: string[] | undefined;
      let sysId: string;
      try {
        known = await meta.fields(mc, table);
        projection = args.fields ? [...new Set(['sys_id', ...args.fields])] : undefined;
        await planQuery(
          meta,
          mc,
          { table, ...(projection ? { fields: projection } : {}) },
          { highVolumeTables: [], extraDeniedTables: denied },
        );
        const resolved = await resolveSysId({
          ctx,
          sn,
          mc,
          table,
          lookup: {
            ...(args.sys_id !== undefined ? { sys_id: args.sys_id } : {}),
            ...(args.match !== undefined ? { match: args.match } : {}),
          },
          known,
        });
        if (!resolved.ok) return resolved.result;
        sysId = resolved.sysId;
        hints.push(...resolved.hints);
      } catch (e) {
        return metadataError(e, id);
      }

      const got = await sn.get({
        table,
        sysId,
        ...(projection ? { fields: projection } : {}),
        displayValue: args.display_value ?? 'all',
      });
      if (!got.ok) {
        if (got.code === 'NOT_FOUND') {
          return toolError(
            'NOT_FOUND',
            `No readable record ${sysId} in ${table}.`,
            'Check the sys_id and table. The record may not exist, or the signed-in user may not be able to read it. Extended tables: the record may live on a child table.',
          );
        }
        return sn.fail(got);
      }
      const shapeOpts = { table, scopeId: id, previewChars: config.fieldPreviewChars };
      const {
        records: [clean],
        stripped,
      } = stripSensitive([got.row], known);
      const shaped = compactRecord(clean as Record<string, unknown>, shapeOpts);
      const budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      const fitted = fitRecord(shaped.record, shaped.omitted, budget, shapeOpts);
      const omitted: Omission[] = [...fitted.omitted];
      if (stripped.length > 0) {
        omitted.push({
          kind: 'fields',
          reason: 'sensitive',
          fields: stripped,
          note: 'Credential fields are never returned by this connector.',
        });
      }

      // References: compact summaries, within what's left of the budget.
      const references: Expanded[] = [];
      if (args.expand_references) {
        const requested = Array.isArray(args.expand_references)
          ? args.expand_references
          : undefined;
        const all = Object.keys(fitted.record).filter((k) => !k.includes('.'));
        const targets: { field: string; refTable: string; refId: string }[] = [];
        for (const field of requested ?? all) {
          const info = known.get(field);
          const raw = compactValue(fitted.record[field]);
          const value =
            raw && typeof raw === 'object' && 'v' in raw ? (raw as { v: unknown }).v : raw;
          if (info && INDIRECT_REFERENCE_TYPES.has(info.type) && value) {
            hints.push(
              `${field} is a ${info.type}: its table is held in another field. Call get_record with that table and sys_id ${String(value)}.`,
            );
            continue;
          }
          if (!info?.reference) {
            if (requested) hints.push(`${field} is not a reference field, so it wasn't expanded.`);
            continue;
          }
          if (typeof value !== 'string' || value === '') continue;
          if (isDeniedTable(info.reference, denied)) {
            omitted.push({
              kind: 'reference',
              reason: 'table_denied',
              field,
              table: info.reference,
              note: 'This table may contain credentials and is blocked.',
            });
            continue;
          }
          targets.push({ field, refTable: info.reference, refId: value });
        }
        const summaries = await mapConcurrent(targets, EXPAND_CONCURRENCY, async (t) => {
          try {
            const refKnown = await meta.fields(mc, t.refTable);
            const r = await sn.get({
              table: t.refTable,
              sysId: t.refId,
              fields: defaultProjection(refKnown),
              displayValue: 'all',
            });
            if (!r.ok) return { t, failed: r.code as string };
            const { records } = stripSensitive([r.row], refKnown);
            const summary = compactRecord(records[0] as Record<string, unknown>, {
              ...shapeOpts,
              table: t.refTable,
            });
            return { t, summary: summary.record };
          } catch {
            return { t, failed: 'METADATA_UNREADABLE' };
          }
        });
        let remaining =
          budget - JSON.stringify(fitted.record).length - JSON.stringify(omitted).length;
        for (const s of summaries) {
          const next = {
            tool: 'get_record',
            args: {
              scope_id: id,
              table: s.t.refTable,
              sys_id: s.t.refId,
              ...(args.instance ? { instance: args.instance } : {}),
            },
          };
          if ('failed' in s) {
            omitted.push({
              kind: 'reference',
              reason: s.failed === 'ACL_DENIED' ? 'acl_denied' : 'unavailable',
              code: s.failed,
              field: s.t.field,
              next,
            });
            continue;
          }
          const entry: Expanded = {
            field: s.t.field,
            table: s.t.refTable,
            sys_id: s.t.refId,
            source: `table ${s.t.refTable}`,
            ...(sn.host ? { link: recordLink(sn.host, s.t.refTable, s.t.refId) } : {}),
            summary: s.summary as Record<string, unknown>,
          };
          const cost = JSON.stringify(entry).length + 1;
          if (cost > remaining) {
            omitted.push({ kind: 'reference', reason: 'response_budget', field: s.t.field, next });
            continue;
          }
          remaining -= cost;
          references.push(entry);
        }
      }

      return dataResponse({
        provenance: sn.provenance(`table ${table}`),
        data: { record: fitted.record, ...(references.length > 0 ? { references } : {}) },
        omitted,
        hints,
        ...(sn.host ? { links: [recordLink(sn.host, table, sysId)] } : {}),
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
