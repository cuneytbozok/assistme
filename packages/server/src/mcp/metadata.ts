/**
 * Table and dictionary metadata (T-017), read through the same scoped, read-only path as any
 * other data (`sn.op` table.list on sys_db_object / sys_dictionary / sys_choice).
 *
 * - Table: name, label, super_class chain (self first, base last).
 * - Fields: every sys_dictionary element of the chain; a child table's definition overrides an
 *   inherited one (e.g. incident.state over task.state).
 * - Dot-walks (`caller_id.manager.name`) resolve across reference fields.
 * - Choices on demand, from the most specific table in the chain that defines any.
 * - Cache per instance, TTL 15 min, single-flight (concurrent callers share one fetch);
 *   failures are not cached. In process only (ADR-010).
 * - All queries are built with the shared filter compiler, never by string concatenation.
 *
 * ServiceNow metadata is data from the instance: labels are shown as text, never interpreted.
 */
import { compileFilter, type ErrorCode, MAX_PAGE_SIZE, type Where } from '@sn-mcp/shared';

export type MetaRow = Record<string, unknown>;
export type MetaFetchResult =
  | { ok: true; rows: MetaRow[] }
  | { ok: false; code: ErrorCode; message: string; hint?: string };

/** One page of a table.list read (raw values, displayValue "false"). */
export type MetaFetch = (req: {
  table: string;
  query: string;
  fields: string[];
  limit: number;
  offset: number;
}) => Promise<MetaFetchResult>;

export interface MetaContext {
  /** Cache key for the instance (its host): metadata is per instance, not per scope. */
  instanceKey: string;
  fetch: MetaFetch;
}

export interface TableInfo {
  name: string;
  label: string;
  /** Self first, then each super class up to the base table. */
  chain: string[];
}

export interface FieldInfo {
  name: string;
  /** The table in the chain whose dictionary entry applies. */
  definedOn: string;
  label: string;
  type: string;
  reference?: string;
  maxLength?: number;
  mandatory: boolean;
  display: boolean;
}

export interface ChoiceInfo {
  value: string;
  label: string;
  sequence?: number;
}

export interface ReferencingField {
  table: string;
  field: string;
  type: string;
}

export interface ResolvedPath {
  path: string;
  field: FieldInfo;
  /** Tables visited, starting with the base table of the path. */
  tables: string[];
}

export class MetadataError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly suggestions?: string[],
  ) {
    super(message);
  }
}

export const METADATA_TTL_MS = 15 * 60_000;
const MAX_CHAIN_DEPTH = 20;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const bool = (v: unknown): boolean => v === true || v === 'true';

/** Levenshtein distance (small inputs only). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** Ranks candidates by closeness to `name` (edit distance, then substring, then length). */
export function closeMatches(name: string, candidates: readonly string[], max = 5): string[] {
  return [...new Set(candidates)]
    .filter((c) => c !== name)
    .map((c) => ({
      c,
      d: editDistance(name, c) - (c.includes(name) || name.includes(c) ? 2 : 0),
    }))
    .sort((x, y) => x.d - y.d || x.c.length - y.c.length || x.c.localeCompare(y.c))
    .slice(0, max)
    .map((x) => x.c);
}

export class MetadataService {
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = METADATA_TTL_MS,
  ) {}

  /** Single-flight, TTL-bounded memoization. Rejections are evicted at once. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { expires: this.now() + this.ttlMs, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  /** Drops everything cached for an instance (e.g. on user request). */
  invalidate(instanceKey: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${instanceKey}|`)) this.cache.delete(k);
  }

  private async rows(
    ctx: MetaContext,
    table: string,
    where: Where,
    fields: string[],
    order?: string,
  ): Promise<MetaRow[]> {
    const compiled = compileFilter({
      where,
      ...(order ? { order_by: [{ field: order, direction: 'asc' as const }] } : {}),
    });
    if (!compiled.ok) throw new MetadataError('INVALID_INPUT', compiled.error.message);
    const out: MetaRow[] = [];
    // Complete reads: page until a short page (no total cap, ADR-011).
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const r = await ctx.fetch({
        table,
        query: compiled.value.query,
        fields,
        limit: MAX_PAGE_SIZE,
        offset,
      });
      if (!r.ok) throw new MetadataError(r.code, r.message, r.hint);
      out.push(...r.rows);
      if (r.rows.length < MAX_PAGE_SIZE) return out;
    }
  }

  /** Table name, label and super_class chain. Unknown → NOT_FOUND with close matches. */
  table(ctx: MetaContext, name: string): Promise<TableInfo> {
    return this.cached(`${ctx.instanceKey}|table|${name}`, async () => {
      const chain: string[] = [];
      let label = '';
      let current: string | undefined = name;
      while (current) {
        if (chain.includes(current) || chain.length >= MAX_CHAIN_DEPTH) {
          throw new MetadataError('SN_API_ERROR', `The super_class chain of ${name} loops.`);
        }
        const [row] = await this.rows(
          ctx,
          'sys_db_object',
          [{ field: 'name', op: '=', value: current }],
          ['name', 'label', 'super_class.name'],
        );
        if (!row) {
          if (chain.length === 0) throw await this.unknownTable(ctx, name);
          break; // a super class we can't read; keep what we have
        }
        if (chain.length === 0) label = str(row.label);
        chain.push(current);
        const parent = str(row['super_class.name']);
        current = parent || undefined;
      }
      return { name, label, chain };
    });
  }

  private async unknownTable(ctx: MetaContext, name: string): Promise<MetadataError> {
    const fragment = name.replace(/^(u_|x_[a-z0-9]+_)/, '').slice(0, 6) || name;
    const where: Where = [
      {
        or: [
          { field: 'name', op: 'contains', value: fragment },
          { field: 'name', op: 'starts_with', value: name.slice(0, 3) },
          { field: 'label', op: 'contains', value: name.replace(/_/g, ' ') },
        ],
      },
    ];
    let candidates: string[] = [];
    try {
      const r = await ctx.fetch({
        table: 'sys_db_object',
        query: (compileFilter({ where }) as { ok: true; value: { query: string } }).value.query,
        fields: ['name'],
        limit: 200,
        offset: 0,
      });
      if (r.ok) candidates = r.rows.map((x) => str(x.name)).filter(Boolean);
    } catch {
      // suggestions are best effort
    }
    const suggestions = closeMatches(name, candidates);
    return new MetadataError(
      'NOT_FOUND',
      `No table named "${name}" on this instance.`,
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}?`
        : 'Use discover_tables to search table names and labels.',
      suggestions,
    );
  }

  /** All fields of a table including inherited ones; the most specific definition wins. */
  fields(ctx: MetaContext, table: string): Promise<Map<string, FieldInfo>> {
    return this.cached(`${ctx.instanceKey}|fields|${table}`, async () => {
      const info = await this.table(ctx, table);
      const rows = await this.rows(
        ctx,
        'sys_dictionary',
        [
          { field: 'name', op: 'in', value: info.chain },
          { field: 'element', op: 'is_not_empty' },
        ],
        [
          'name',
          'element',
          'column_label',
          'internal_type',
          'reference',
          'max_length',
          'mandatory',
          'display',
        ],
        'element',
      );
      const depth = new Map(info.chain.map((t, i) => [t, i]));
      const out = new Map<string, FieldInfo>();
      const best = new Map<string, number>();
      for (const r of rows) {
        const definedOn = str(r.name);
        const d = depth.get(definedOn);
        const element = str(r.element);
        if (d === undefined || !element) continue;
        const prior = best.get(element);
        if (prior !== undefined && prior <= d) continue; // a more specific table already defined it
        best.set(element, d);
        const maxLength = Number.parseInt(str(r.max_length), 10);
        const reference = str(r.reference);
        out.set(element, {
          name: element,
          definedOn,
          label: str(r.column_label),
          type: str(r.internal_type),
          ...(reference ? { reference } : {}),
          ...(Number.isFinite(maxLength) ? { maxLength } : {}),
          mandatory: bool(r.mandatory),
          display: bool(r.display),
        });
      }
      return out;
    });
  }

  /** Resolves `a.b.c` from `table`, following reference fields. Unknown → INVALID_FIELD. */
  /** Checks that `child` extends `parent`, for a `ref_<child>` segment. Returns `child`. */
  private async downcast(
    ctx: MetaContext,
    parent: string,
    child: string,
    walked: string[],
  ): Promise<string> {
    let info: TableInfo;
    try {
      info = await this.table(ctx, child);
    } catch (e) {
      if (e instanceof MetadataError && e.code === 'NOT_FOUND') {
        throw new MetadataError(
          'INVALID_FIELD',
          `"${walked.join('.')}": there is no table ${child} to downcast to.`,
        );
      }
      throw e;
    }
    if (!info.chain.includes(parent)) {
      throw new MetadataError(
        'INVALID_FIELD',
        `"${walked.join('.')}": ${child} doesn't extend ${parent}, so it can't downcast it.`,
      );
    }
    return child;
  }

  async resolvePath(ctx: MetaContext, table: string, path: string): Promise<ResolvedPath> {
    const segments = path.split('.');
    const tables = [table];
    let current = table;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const fields = await this.fields(ctx, current);
      // Every ServiceNow table has sys_id, even when a dictionary read doesn't list it.
      const f =
        fields.get(seg) ??
        (seg === 'sys_id'
          ? {
              name: 'sys_id',
              definedOn: current,
              label: 'Sys ID',
              type: 'GUID',
              mandatory: false,
              display: false,
            }
          : undefined);
      if (!f && seg.startsWith('ref_') && seg.length > 4) {
        // `ref_<table>` downcasts a reference to a child table (cmdb_ci.ref_cmdb_ci_server.os).
        current = await this.downcast(ctx, current, seg.slice(4), segments.slice(0, i + 1));
        if (i === segments.length - 1) {
          throw new MetadataError(
            'INVALID_FIELD',
            `"${path}" ends with ${seg}; name a field of ${current} after it.`,
          );
        }
        tables.push(current);
        continue;
      }
      if (!f) {
        const suggestions = closeMatches(seg, [...fields.keys()]);
        throw new MetadataError(
          'INVALID_FIELD',
          `Field "${segments.slice(0, i + 1).join('.')}" does not exist on ${current}.`,
          suggestions.length > 0
            ? `Did you mean: ${suggestions.map((s) => [...segments.slice(0, i), s].join('.')).join(', ')}?`
            : `Use describe_table on ${current} to see its fields.`,
          suggestions,
        );
      }
      if (i === segments.length - 1) return { path, field: f, tables };
      if (!f.reference) {
        throw new MetadataError(
          'INVALID_FIELD',
          `"${segments.slice(0, i + 1).join('.')}" is not a reference field, so it can't be dot-walked.`,
        );
      }
      current = f.reference;
      tables.push(current);
    }
    throw new MetadataError('INVALID_FIELD', 'Empty field path.');
  }

  /** Every dictionary field of the given internal types, on any table (cached per instance). */
  fieldsOfTypes(ctx: MetaContext, types: readonly string[]): Promise<ReferencingField[]> {
    return this.cached(`${ctx.instanceKey}|fieldsOfTypes|${types.join(',')}`, async () => {
      const rows = await this.rows(
        ctx,
        'sys_dictionary',
        [
          { field: 'internal_type', op: 'in', value: [...types] },
          { field: 'element', op: 'is_not_empty' },
        ],
        ['name', 'element', 'internal_type'],
        'name',
      );
      return rows
        .map((r) => ({ table: str(r.name), field: str(r.element), type: str(r.internal_type) }))
        .filter((r) => r.table && r.field)
        .sort((a, b) => a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
    });
  }

  /**
   * Every dictionary field that references this table or one of its ancestors (a reference to
   * cmdb_ci can point at a cmdb_ci_server record). Sorted by table, then field, so a cursor can
   * walk the list.
   */
  referencesTo(ctx: MetaContext, table: string): Promise<ReferencingField[]> {
    return this.cached(`${ctx.instanceKey}|referencesTo|${table}`, async () => {
      const info = await this.table(ctx, table);
      const rows = await this.rows(
        ctx,
        'sys_dictionary',
        [
          { field: 'reference', op: 'in', value: info.chain },
          { field: 'element', op: 'is_not_empty' },
        ],
        ['name', 'element', 'internal_type'],
        'name',
      );
      return rows
        .map((r) => ({ table: str(r.name), field: str(r.element), type: str(r.internal_type) }))
        .filter((r) => r.table && r.field)
        .sort((a, b) => a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
    });
  }

  /**
   * Every field's choices for a table in one read (for describe_table). For each field, the most
   * specific table in the chain that defines any wins, as in `choices`.
   */
  allChoices(ctx: MetaContext, table: string): Promise<Map<string, ChoiceInfo[]>> {
    return this.cached(`${ctx.instanceKey}|allChoices|${table}`, async () => {
      const info = await this.table(ctx, table);
      const rows = await this.rows(
        ctx,
        'sys_choice',
        [
          { field: 'name', op: 'in', value: info.chain },
          { field: 'inactive', op: '=', value: 'false' },
        ],
        ['name', 'element', 'value', 'label', 'sequence', 'language'],
        'sequence',
      );
      const depth = new Map(info.chain.map((t, i) => [t, i]));
      const out = new Map<string, ChoiceInfo[]>();
      const owner = new Map<string, number>();
      for (const r of rows) {
        if (str(r.language) && str(r.language) !== 'en') continue;
        const element = str(r.element);
        const d = depth.get(str(r.name));
        if (!element || d === undefined) continue;
        const prior = owner.get(element);
        if (prior !== undefined && prior < d) continue;
        if (prior === undefined || d < prior) out.set(element, []);
        owner.set(element, d);
        const seq = Number.parseInt(str(r.sequence), 10);
        out.get(element)?.push({
          value: str(r.value),
          label: str(r.label),
          ...(Number.isFinite(seq) ? { sequence: seq } : {}),
        });
      }
      return out;
    });
  }

  /** Choices for a field, from the most specific table in the chain that defines any. */
  choices(ctx: MetaContext, table: string, field: string): Promise<ChoiceInfo[]> {
    return this.cached(`${ctx.instanceKey}|choices|${table}|${field}`, async () => {
      const info = await this.table(ctx, table);
      const rows = await this.rows(
        ctx,
        'sys_choice',
        [
          { field: 'name', op: 'in', value: info.chain },
          { field: 'element', op: '=', value: field },
          { field: 'inactive', op: '=', value: 'false' },
        ],
        ['name', 'value', 'label', 'sequence', 'language'],
        'sequence',
      );
      const english = rows.filter((r) => !str(r.language) || str(r.language) === 'en');
      for (const t of info.chain) {
        const own = english.filter((r) => str(r.name) === t);
        if (own.length === 0) continue;
        return own.map((r) => {
          const seq = Number.parseInt(str(r.sequence), 10);
          return {
            value: str(r.value),
            label: str(r.label),
            ...(Number.isFinite(seq) ? { sequence: seq } : {}),
          };
        });
      }
      return [];
    });
  }
}
