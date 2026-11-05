/**
 * compare_records: two records, on the two instances of a compare scope the user explicitly
 * approved (T-032, AC-8), or both on the one instance of a single-instance scope (T-042). Each side
 * must resolve to exactly one record. The result is a field diff plus a unified diff for scripts
 * and other long values, reachable through cursor pages however long it is. Provenance names both
 * sides.
 *
 * Two `sys_update_version` rows are two versions of a record: their XML `payload` is compared
 * element by element when both can be read, and as raw text when not (see update-payload.ts).
 *
 * Pages come from one snapshot held in the in-process cache (the extension confirms the scope
 * before each use), so a diff doesn't shift between pages. If the snapshot has expired, the
 * records are read again, and a hint says so if they changed.
 */
import { createHash } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  FieldPathSchema,
  isDeniedTable,
  isSensitiveFieldName,
  PASSWORD_INTERNAL_TYPES,
  SYS_ID_RE,
} from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue, isSensitiveField, recordLink } from '../compact.js';
import { indexLines } from '../field-cache.js';
import { unifiedDiff } from '../line-diff.js';
import type { FieldInfo } from '../metadata.js';
import { dataResponse, type Omission } from '../response.js';
import { provenance, toolError } from '../results.js';
import { parseUpdatePayload } from '../update-payload.js';
import {
  CursorInput,
  lean,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  TableInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import { MatchValue, resolveSysId } from './record-lookup.js';
import {
  countedMeta,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
  resolveMaxChars,
  SnClient,
} from './support.js';

const FieldName = z.string().regex(/^[a-z0-9_]{1,80}$/, 'invalid field name');
const SideInput = lean(z.record(FieldPathSchema, MatchValue), z.looseObject({}));

/** Bookkeeping that differs on every instance: left out of a default comparison, and listed. */
const SYSTEM_FIELDS = new Set([
  'sys_id',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_tags',
]);
const MAX_INLINE_VALUE = 200;
const VERSION_TABLE = 'sys_update_version';
const PAYLOAD = 'payload';
const PAYLOAD_PREFIX = 'payload.';

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('compare_records'),
  instance: z.string().max(32),
  instances: z.tuple([z.string().max(32), z.string().max(32)]),
  table: z.string().max(80),
  a: z.string().max(32),
  b: z.string().max(32),
  fields: z.array(z.string().max(80)).max(49).optional(),
  offset: z.int().min(0),
  digest: z.string().max(16),
});

/** One entry of the flat diff. Pages are slices of this list. */
type DiffItem =
  | { k: 'field'; field: string; a: unknown; b: unknown; same_display?: true }
  | { k: 'only'; side: 'a' | 'b'; field: string; value: unknown }
  | { k: 'hunks'; field: string; total_lines: number; minimal: boolean }
  | { k: 'line'; field: string; line: string };

interface Side {
  instance: string;
  env?: string;
  host?: string;
  sys_id: string;
  link?: string;
}

interface Snapshot {
  sides: { a: Side; b: Side };
  equal_fields: number;
  ignored_fields: string[];
  stripped: string[];
  items: DiffItem[];
}

const raw = (v: unknown): unknown => {
  const c = compactValue(v);
  return c && typeof c === 'object' && 'v' in c ? (c as { v: unknown }).v : c;
};
const display = (v: unknown): unknown => {
  const c = compactValue(v);
  return c && typeof c === 'object' && 'd' in c ? (c as { d: unknown }).d : c;
};
const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
const isLong = (v: unknown): boolean => {
  const t = asText(v);
  return t.length > MAX_INLINE_VALUE || t.includes('\n');
};

/**
 * Replaces `payload` on both rows with one `payload.<element>` entry per element. Field-level
 * credential protection isn't applied to these, as for the raw XML: the user's decision, recorded
 * in docs/SECURITY.md.
 */
function expandPayloads(
  rowA: Record<string, unknown>,
  rowB: Record<string, unknown>,
  explicit: string[] | undefined,
  hints: string[],
): {
  rowA: Record<string, unknown>;
  rowB: Record<string, unknown>;
  explicit: string[] | undefined;
} {
  const unchanged = { rowA, rowB, explicit };
  const textA = raw(rowA[PAYLOAD]);
  const textB = raw(rowB[PAYLOAD]);
  if (typeof textA !== 'string' || typeof textB !== 'string' || textA === textB) return unchanged;
  const a = parseUpdatePayload(textA);
  const b = parseUpdatePayload(textB);
  if (!a || !b || a.table !== b.table) {
    hints.push(
      `\`${PAYLOAD}\` was compared as raw text: it isn't one record in the expected XML form on both sides.`,
    );
    return unchanged;
  }
  hints.push(
    `\`${PAYLOAD}\` was compared element by element, as \`${PAYLOAD_PREFIX}<element>\`, without element attributes other than the record's action. Other records in it are compared as whole XML, as \`${PAYLOAD_PREFIX}record:<name>\`. For the XML itself, use get_field_content with field "${PAYLOAD}".`,
  );
  const expand = (row: Record<string, unknown>, fields: Map<string, string>) => {
    const { [PAYLOAD]: _payload, ...rest } = row;
    for (const [k, v] of fields) rest[`${PAYLOAD_PREFIX}${k}`] = v;
    return rest;
  };
  const elements = [...new Set([...a.fields.keys(), ...b.fields.keys()])]
    .sort()
    .map((k) => `${PAYLOAD_PREFIX}${k}`);
  return {
    rowA: expand(rowA, a.fields),
    rowB: expand(rowB, b.fields),
    explicit: explicit && [...explicit.filter((f) => f !== PAYLOAD), ...elements],
  };
}

function buildSnapshot(
  sides: { a: Side; b: Side },
  rowA: Record<string, unknown>,
  rowB: Record<string, unknown>,
  explicit: string[] | undefined,
): Omit<Snapshot, 'stripped'> {
  const keys = explicit ?? [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])].sort();
  const ignored: string[] = [];
  const items: DiffItem[] = [];
  let equal = 0;
  for (const field of keys) {
    // A payload's own bookkeeping can't be named in `fields`, so it's always left out, and listed.
    const bookkeeping = field.startsWith(PAYLOAD_PREFIX)
      ? SYSTEM_FIELDS.has(field.slice(PAYLOAD_PREFIX.length))
      : !explicit && SYSTEM_FIELDS.has(field);
    if (bookkeeping) {
      ignored.push(field);
      continue;
    }
    const inA = field in rowA;
    const inB = field in rowB;
    if (!inA || !inB) {
      if (inA || inB) {
        const side = inA ? 'a' : 'b';
        const value = compactValue((inA ? rowA : rowB)[field]);
        items.push({ k: 'only', side, field, value });
      }
      continue;
    }
    const a = raw(rowA[field]);
    const b = raw(rowB[field]);
    if (asText(a) === asText(b)) {
      equal++;
      continue;
    }
    if (isLong(a) || isLong(b)) {
      const { lines, minimal } = unifiedDiff(asText(a), asText(b));
      items.push({ k: 'hunks', field, total_lines: lines.length, minimal });
      for (const line of lines) items.push({ k: 'line', field, line });
      continue;
    }
    const sameDisplay = asText(display(rowA[field])) === asText(display(rowB[field]));
    items.push({
      k: 'field',
      field,
      a: compactValue(rowA[field]),
      b: compactValue(rowB[field]),
      ...(sameDisplay ? { same_display: true as const } : {}),
    });
  }
  return { sides, equal_fields: equal, ignored_fields: ignored, items };
}

/** Readable page: consecutive diff lines of a field are gathered under that field. */
function renderPage(items: DiffItem[]) {
  const fields: unknown[] = [];
  const onlyA: unknown[] = [];
  const onlyB: unknown[] = [];
  const diffs: { field: string; total_lines?: number; minimal?: false; lines: string[] }[] = [];
  for (const it of items) {
    if (it.k === 'field') {
      const { k: _k, ...rest } = it;
      fields.push(rest);
    } else if (it.k === 'only') {
      (it.side === 'a' ? onlyA : onlyB).push({ field: it.field, value: it.value });
    } else if (it.k === 'hunks') {
      diffs.push({
        field: it.field,
        total_lines: it.total_lines,
        ...(it.minimal ? {} : { minimal: false as const }),
        lines: [],
      });
    } else {
      const last = diffs.at(-1);
      if (last?.field === it.field) last.lines.push(it.line);
      else diffs.push({ field: it.field, lines: [it.line] });
    }
  }
  return {
    ...(fields.length > 0 ? { different_fields: fields } : {}),
    ...(diffs.length > 0 ? { diffs } : {}),
    ...(onlyA.length > 0 ? { only_on_a: onlyA } : {}),
    ...(onlyB.length > 0 ? { only_on_b: onlyB } : {}),
  };
}

export function registerCompareRecords(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError, requireScope, scopes } = ctx;

  /** Reads and diffs both sides. Returns the snapshot, or the tool error to return. */
  async function readBoth(o: {
    id: string;
    instances: [string, string];
    table: string;
    lookups: { a: Record<string, unknown>; b: Record<string, unknown> };
    fields: string[] | undefined;
    snA: SnClient;
    snB: SnClient;
    hints: string[];
  }): Promise<Snapshot | CallToolResult> {
    const { id, instances, table, lookups, fields, snA, snB, hints } = o;
    const oneInstance = instances[0] === instances[1];
    const sides = [
      { side: 'a' as const, sn: snA, instance: instances[0], lookup: lookups.a },
      { side: 'b' as const, sn: snB, instance: instances[1], lookup: lookups.b },
    ];
    const rows: Record<string, unknown>[] = [];
    const out: Side[] = [];
    const stripped = new Set<string>();
    const knowns: ReadonlyMap<string, FieldInfo>[] = [];
    for (const s of sides) {
      const mc = countedMeta(ctx.metaContext(id, s.instance), s.sn);
      let known: ReadonlyMap<string, FieldInfo>;
      try {
        known = await meta.fields(mc, table);
      } catch (e) {
        return metadataError(e, id);
      }
      knowns.push(known);
      const entries = Object.entries(s.lookup);
      const direct =
        entries.length === 1 && entries[0]?.[0] === 'sys_id' && typeof entries[0][1] === 'string';
      if (direct && !SYS_ID_RE.test(entries[0]?.[1] as string)) {
        return toolError('INVALID_INPUT', `match_${s.side}: invalid sys_id.`);
      }
      let sysId: string;
      try {
        const resolved = await resolveSysId({
          ctx,
          sn: s.sn,
          mc,
          table,
          lookup: direct
            ? { sys_id: entries[0]?.[1] as string }
            : { match: s.lookup as Record<string, string | number | boolean> },
          known,
          side: s.side,
        });
        if (!resolved.ok) return resolved.result;
        sysId = resolved.sysId;
        hints.push(...resolved.hints.map((h) => `Side ${s.side}: ${h}`));
      } catch (e) {
        return metadataError(e, id);
      }
      if (oneInstance && sysId === out[0]?.sys_id) {
        return toolError(
          'INVALID_INPUT',
          `match_a and match_b are the same record (${sysId}) on ${s.instance}: nothing to compare.`,
          'Make match_b find a different record.',
        );
      }
      const got = await s.sn.get({
        table,
        sysId,
        // sys_id keeps the list valid when none of the fields exist on this side.
        ...(fields ? { fields: ['sys_id', ...fields.filter((f) => known.has(f))] } : {}),
        displayValue: 'all',
      });
      if (!got.ok) {
        if (got.code === 'NOT_FOUND') {
          return toolError(
            'NOT_FOUND',
            `No readable record ${sysId} in ${table} (side ${s.side}, ${s.instance}).`,
            undefined,
            { side: s.side },
          );
        }
        return s.sn.fail(got);
      }
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(got.row)) {
        if (isSensitiveField(k, known)) stripped.add(k);
        else row[k] = v;
      }
      rows.push(row);
      out.push({
        instance: s.instance,
        ...(s.sn.env ? { env: s.sn.env } : {}),
        ...(s.sn.host ? { host: s.sn.host } : {}),
        sys_id: sysId,
        ...(s.sn.host ? { link: recordLink(s.sn.host, table, sysId) } : {}),
      });
    }
    if (fields) {
      for (const f of fields) {
        if (!knowns.some((k) => k.has(f))) {
          return toolError(
            'INVALID_FIELD',
            `Field "${f}" does not exist on ${table}${oneInstance ? '' : ' on either instance'}.`,
          );
        }
      }
    }
    const expanded =
      table === VERSION_TABLE
        ? expandPayloads(
            rows[0] as Record<string, unknown>,
            rows[1] as Record<string, unknown>,
            fields,
            hints,
          )
        : {
            rowA: rows[0] as Record<string, unknown>,
            rowB: rows[1] as Record<string, unknown>,
            explicit: fields,
          };
    const built = buildSnapshot(
      { a: out[0] as Side, b: out[1] as Side },
      expanded.rowA,
      expanded.rowB,
      expanded.explicit,
    );
    return { ...built, stripped: [...stripped].sort() };
  }

  server.registerTool(
    'compare_records',
    {
      description:
        'Compares two records: on a single-instance scope (`match_b` required), or across a compare scope\'s two instances (request_scope with two `instances`; `match_b` defaults to `match_a`). Two `sys_update_version` rows compare two versions. `match_a`: {"sys_id": "…"} or unique field values. Each side must be unique. Returns `different_fields`, unified `diffs`, `only_on_a`/`only_on_b`. Continue with `cursor`.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        table: TableInput.optional(),
        match_a: SideInput.optional(),
        match_b: SideInput.optional(),
        fields: lean(z.array(FieldName).min(1).max(49), z.array(z.string())).optional(),
        cursor: CursorInput,
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
      const known = scopes.get(id);
      if (!known) {
        return toolError(
          'SCOPE_UNKNOWN',
          'Unknown scope_id for this connector session.',
          'Request a compare scope with request_scope (two instances).',
        );
      }
      const expiry = scopes.resolveTarget(id, known.instances[0]);
      if (!expiry.ok) return toolError(expiry.code, expiry.message, expiry.hint);
      // A single-instance scope reads both sides from its one instance, and nothing here can name
      // another: the extension still checks every read against the scope.
      const [first, second] = known.instances as [string, string?];
      const single = known.mode === 'single' && second === undefined;
      if (!single && (known.mode !== 'compare' || second === undefined)) {
        return toolError('INVALID_INPUT', 'This scope does not cover what compare_records needs.');
      }
      const instances: [string, string] = [first, second ?? first];

      let state: z.infer<typeof StateSchema> | undefined;
      if (args.cursor !== undefined) {
        if (args.table || args.match_a || args.match_b || args.fields) {
          return toolError('INVALID_INPUT', 'Pass only scope_id and cursor to continue.');
        }
        try {
          state = ctx.cursors.decodeState(StateSchema, args.cursor, 'compare_records');
        } catch (e) {
          return toolError(
            'INVALID_INPUT',
            (e as Error).message,
            'Compare again without a cursor.',
          );
        }
        if (state.instances[0] !== instances[0] || state.instances[1] !== instances[1]) {
          return toolError('INVALID_INPUT', 'This cursor is for a different pair of instances.');
        }
      }
      const table = state?.table ?? args.table;
      if (table === undefined) {
        return toolError('INVALID_INPUT', 'table is required (or pass a cursor).');
      }
      if (isDeniedTable(table, config.extraDeniedTables)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      const fields = state?.fields ?? args.fields;
      for (const f of fields ?? []) {
        if (isSensitiveFieldName(f)) {
          return toolError(
            'FORBIDDEN_OPERATION',
            `"${f}" is a credential field and can't be read or compared.`,
          );
        }
      }
      const lookups = state
        ? { a: { sys_id: state.a }, b: { sys_id: state.b } }
        : args.match_a
          ? { a: args.match_a, b: args.match_b ?? args.match_a }
          : undefined;
      if (!lookups) return toolError('INVALID_INPUT', 'match_a is required (or pass a cursor).');
      if (single && !state && !args.match_b) {
        return toolError(
          'INVALID_INPUT',
          'On a single-instance scope, match_b is required: both records are on one instance.',
          'To compare one record across two instances, call request_scope with instances: [first, second]. The user must approve the comparison.',
        );
      }

      const snA = new SnClient(ctx, id, instances[0]);
      const snB = single ? snA : new SnClient(ctx, id, instances[1]);
      const cacheKeyFor = (x: string, y: string) =>
        `${id}|compare|${table}|${x}|${y}|${(fields ?? []).join(',')}`;
      let snapshot: Snapshot | undefined;
      if (state) {
        const cached = ctx.fieldCache.get(cacheKeyFor(state.a, state.b));
        if (cached) {
          // The extension decides every read, for both instances.
          for (const instance of new Set(instances)) {
            const check = await ctx.call(
              'scope.check',
              { kind: 'scope.check', scopeId: id, instance },
              id,
            );
            if (!check.ok) {
              ctx.fieldCache.forgetScope(id);
              return check.error;
            }
          }
          snapshot = JSON.parse(cached.value) as Snapshot;
        }
      }
      if (!snapshot) {
        const read = await readBoth({ id, instances, table, lookups, fields, snA, snB, hints });
        if ('content' in read) return read;
        snapshot = read;
        ctx.fieldCache.set(
          cacheKeyFor(read.sides.a.sys_id, read.sides.b.sys_id),
          indexLines(JSON.stringify(read)),
        );
      }
      const digest = createHash('sha256')
        .update(JSON.stringify(snapshot))
        .digest('base64url')
        .slice(0, 16);
      if (state && state.digest !== digest) {
        hints.push(
          'The records changed since the first page (their local copy expired and a new read differs), so this page is from a newer read. Compare again without a cursor for a consistent result.',
        );
      }

      // Slice the flat list to the budget. A diff line too long to fit alone is cut and reported.
      const items = snapshot.items;
      const offset = state?.offset ?? 0;
      const page: DiffItem[] = [];
      const omitted: Omission[] = [];
      let budget = maxChars - RESPONSE_OVERHEAD_CHARS - JSON.stringify(snapshot.sides).length;
      let i = offset;
      for (; i < items.length; i++) {
        const it = items[i] as DiffItem;
        const cost = JSON.stringify(it).length;
        if (cost > budget) {
          if (page.length > 0) break;
          if (it.k === 'line') {
            const cut = Math.max(100, budget - 100);
            page.push({ ...it, line: `${it.line.slice(0, cut)}…` });
            omitted.push({
              kind: 'field',
              reason: 'response_budget',
              field: it.field,
              note: 'One diff line was too long for this result and was cut. Read the field on each side with next.',
              next: ['a', 'b'].map((s) => ({
                tool: 'get_field_content',
                args: {
                  scope_id: id,
                  instance: snapshot.sides[s as 'a' | 'b'].instance,
                  table,
                  sys_id: snapshot.sides[s as 'a' | 'b'].sys_id,
                  field: it.field.startsWith(PAYLOAD_PREFIX) ? PAYLOAD : it.field,
                },
              })),
            });
            continue;
          }
        }
        budget -= cost;
        page.push(it);
      }
      const cursor =
        i < items.length
          ? ctx.cursors.encodeState(StateSchema, {
              v: 1,
              tool: 'compare_records',
              instance: instances[0],
              instances,
              table,
              a: snapshot.sides.a.sys_id,
              b: snapshot.sides.b.sys_id,
              ...(fields ? { fields } : {}),
              offset: i,
              digest,
            })
          : undefined;
      if (cursor) {
        omitted.unshift(
          moreOmission(
            'compare_records',
            id,
            cursor,
            'response_budget',
            `${items.length - i} of ${items.length} diff entries remain. Follow next.`,
          ),
        );
      }
      if (snapshot.stripped.length > 0) {
        omitted.push({
          kind: 'fields',
          reason: 'sensitive',
          fields: snapshot.stripped,
          note: 'Credential fields are never returned or compared.',
        });
      }
      return dataResponse({
        provenance: provenance({
          instance: single ? first : instances.join(','),
          scopeId: id,
          source: single ? `table ${table}` : `table ${table} on both instances`,
        }),
        data: {
          table,
          a: snapshot.sides.a,
          b: snapshot.sides.b,
          identical: items.length === 0,
          equal_fields: snapshot.equal_fields,
          ...(snapshot.ignored_fields.length > 0
            ? { ignored_fields: snapshot.ignored_fields }
            : {}),
          ...renderPage(page),
        },
        omitted,
        page: {
          returned: page.length,
          returned_total: i,
          ...(cursor ? { next_cursor: cursor } : {}),
          total: items.length,
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: single ? snA.requests : snA.requests + snB.requests,
      });
    },
  );
}
