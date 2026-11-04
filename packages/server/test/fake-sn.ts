/**
 * In-memory fake ServiceNow Table API for tests (mock; never evidence of real connectivity).
 * Evaluates encoded queries with the shared parser: =, !=, IN, NOT IN, LIKE, NOT LIKE,
 * STARTSWITH, ENDSWITH, ISEMPTY, ISNOTEMPTY, <, <=, >, >=, ^OR, ^NQ, ORDERBY/ORDERBYDESC.
 * Dot-walked fields (`super_class.name`) follow `{table, sys_id}` references.
 */
import { parseEncodedQuery, type Term } from '@sn-mcp/shared';

export type Row = Record<string, unknown> & { sys_id: string };
export type Ref = { table: string; sys_id: string };

export class FakeServiceNow {
  readonly tables = new Map<string, Row[]>();
  readonly calls: {
    table: string;
    query: string;
    fields?: string[];
    limit: number;
    offset: number;
  }[] = [];
  private seq = 0;

  insert(table: string, row: Record<string, unknown>): Row {
    const r = { sys_id: (++this.seq).toString(16).padStart(32, '0'), ...row } as Row;
    const list = this.tables.get(table) ?? [];
    list.push(r);
    this.tables.set(table, list);
    return r;
  }

  ref(table: string, row: Row): Ref {
    return { table, sys_id: row.sys_id };
  }

  /** Raw value of a (possibly dot-walked) field. References are stored as Ref objects. */
  value(row: Row, path: string): unknown {
    let cur: unknown = row;
    for (const seg of path.split('.')) {
      if (cur && typeof cur === 'object' && 'table' in cur && 'sys_id' in cur && !(seg in cur)) {
        const ref = cur as Ref;
        cur = this.tables.get(ref.table)?.find((x) => x.sys_id === ref.sys_id);
      }
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur && typeof cur === 'object' && 'sys_id' in cur) return (cur as Ref).sys_id;
    return cur;
  }

  private match(row: Row, t: Term): boolean {
    const raw = this.value(row, t.field);
    const v = raw == null ? '' : String(raw);
    const list = t.value.split(',');
    switch (t.operator) {
      case '=':
        return v === t.value;
      case '!=':
        return v !== t.value;
      case 'IN':
        return list.includes(v);
      case 'NOT IN':
        return !list.includes(v);
      case 'LIKE':
        return v.toLowerCase().includes(t.value.toLowerCase());
      case 'NOT LIKE':
        return !v.toLowerCase().includes(t.value.toLowerCase());
      case 'STARTSWITH':
        return v.toLowerCase().startsWith(t.value.toLowerCase());
      case 'ENDSWITH':
        return v.toLowerCase().endsWith(t.value.toLowerCase());
      case 'ISEMPTY':
        return v === '';
      case 'ISNOTEMPTY':
        return v !== '';
      case '<':
        return v < t.value;
      case '<=':
        return v <= t.value;
      case '>':
        return v > t.value;
      case '>=':
        return v >= t.value;
      default:
        throw new Error(`fake SN: operator ${t.operator} not implemented`);
    }
  }

  /** Mirrors GET /api/now/table/{table}: returns rows (projected) and the total count. */
  list(req: { table: string; query?: string; fields?: string[]; limit: number; offset: number }) {
    this.calls.push({ ...req, query: req.query ?? '' });
    let rows = [...(this.tables.get(req.table) ?? [])];
    if (req.query) {
      const p = parseEncodedQuery(req.query, { profile: 'enforce', allowTextSearch: true });
      if (!p.ok) throw new Error(`fake SN: bad query ${req.query}`);
      const groups = p.value.groups;
      if (groups.length > 0) {
        rows = rows.filter((row) =>
          groups.some((g) => {
            let acc = true;
            g.forEach((t, i) => {
              const m = this.match(row, t);
              acc = i === 0 ? m : t.join === 'OR' ? acc || m : acc && m;
            });
            return acc;
          }),
        );
      }
      for (const o of [...p.value.orderBy].reverse()) {
        rows.sort((a, b) => {
          const x = String(this.value(a, o.field) ?? '');
          const y = String(this.value(b, o.field) ?? '');
          const c = x.localeCompare(y, 'en', { numeric: true });
          return o.descending ? -c : c;
        });
      }
    }
    const total = rows.length;
    const page = rows.slice(req.offset, req.offset + req.limit).map((row) => {
      if (!req.fields) {
        return Object.fromEntries(Object.keys(row).map((k) => [k, this.value(row, k) ?? '']));
      }
      return Object.fromEntries(req.fields.map((f) => [f, this.value(row, f) ?? '']));
    });
    return { rows: page, total };
  }
}

/** A small dictionary: task ← incident, sys_user, cmn_department, with choices. */
export function dictionaryFixture(): FakeServiceNow {
  const sn = new FakeServiceNow();
  const task = sn.insert('sys_db_object', { name: 'task', label: 'Task', super_class: '' });
  sn.insert('sys_db_object', {
    name: 'incident',
    label: 'Incident',
    super_class: sn.ref('sys_db_object', task),
  });
  sn.insert('sys_db_object', {
    name: 'problem',
    label: 'Problem',
    super_class: sn.ref('sys_db_object', task),
  });
  sn.insert('sys_db_object', { name: 'sys_user', label: 'User', super_class: '' });
  sn.insert('sys_db_object', { name: 'cmn_department', label: 'Department', super_class: '' });
  sn.insert('sys_db_object', {
    name: 'incident_task',
    label: 'Incident Task',
    super_class: sn.ref('sys_db_object', task),
  });

  const dict = (name: string, element: string, type: string, extra: Record<string, unknown> = {}) =>
    sn.insert('sys_dictionary', {
      name,
      element,
      column_label: element.replace(/_/g, ' '),
      internal_type: type,
      reference: '',
      max_length: type === 'string' ? '160' : '32',
      mandatory: 'false',
      display: 'false',
      ...extra,
    });
  sn.insert('sys_dictionary', { name: 'task', element: '', internal_type: 'collection' }); // the table row
  dict('task', 'number', 'string', { display: 'true', max_length: '40' });
  dict('task', 'short_description', 'string');
  dict('task', 'state', 'integer');
  dict('task', 'priority', 'integer');
  dict('task', 'assigned_to', 'reference', { reference: 'sys_user' });
  dict('task', 'sys_created_on', 'glide_date_time');
  dict('task', 'sys_id', 'GUID');
  dict('incident', 'caller_id', 'reference', { reference: 'sys_user', mandatory: 'true' });
  dict('incident', 'category', 'string');
  dict('incident', 'state', 'integer', { column_label: 'Incident state' }); // overrides task.state
  dict('sys_user', 'user_name', 'string', { display: 'true' });
  dict('sys_user', 'name', 'string');
  dict('sys_user', 'manager', 'reference', { reference: 'sys_user' });
  dict('sys_user', 'department', 'reference', { reference: 'cmn_department' });
  dict('cmn_department', 'name', 'string', { display: 'true' });

  // T-020: credential material in the dictionary.
  sn.insert('sys_db_object', {
    name: 'discovery_credentials',
    label: 'Credentials',
    super_class: '',
  });
  sn.insert('sys_db_object', { name: 'u_api_config', label: 'API config', super_class: '' });
  dict('sys_user', 'user_password', 'password2');
  dict('incident', 'u_cred_ref', 'reference', { reference: 'discovery_credentials' });
  dict('discovery_credentials', 'name', 'string');
  dict('u_api_config', 'u_label', 'string');
  dict('u_api_config', 'u_endpoint', 'string');
  dict('u_api_config', 'u_auth', 'password2'); // a password type with a harmless name

  const choice = (
    name: string,
    element: string,
    value: string,
    label: string,
    sequence: number,
    extra = {},
  ) =>
    sn.insert('sys_choice', {
      name,
      element,
      value,
      label,
      sequence: String(sequence),
      inactive: 'false',
      language: 'en',
      ...extra,
    });
  choice('task', 'state', '1', 'Open', 1);
  choice('task', 'state', '3', 'Closed', 3);
  choice('incident', 'state', '1', 'New', 1);
  choice('incident', 'state', '2', 'In Progress', 2);
  choice('incident', 'state', '7', 'Closed', 7);
  choice('incident', 'state', '9', 'Legacy', 9, { inactive: 'true' });
  choice('incident', 'state', '1', 'Nouveau', 1, { language: 'fr' });
  choice('task', 'priority', '1', 'Critical', 1);
  return sn;
}

const METADATA_TABLES = new Set(['sys_db_object', 'sys_dictionary', 'sys_choice']);
let sharedDictionary: FakeServiceNow | undefined;

/**
 * For mock extensions: answers metadata reads (sys_db_object/sys_dictionary/sys_choice) from
 * the dictionary fixture; returns undefined for any other operation (a "data" read).
 */
export function answerMetadata(
  op: unknown,
): { ok: true; status: 200; body: Record<string, unknown>[]; bytes: number } | undefined {
  const o = op as {
    kind?: string;
    table?: string;
    query?: string;
    fields?: string[];
    limit?: number;
    offset?: number;
  };
  if (o?.kind !== 'table.list' || !o.table || !METADATA_TABLES.has(o.table)) return undefined;
  sharedDictionary ??= dictionaryFixture();
  const { rows } = sharedDictionary.list({
    table: o.table,
    ...(o.query ? { query: o.query } : {}),
    ...(o.fields ? { fields: o.fields } : {}),
    limit: o.limit ?? 1000,
    offset: o.offset ?? 0,
  });
  return { ok: true, status: 200, body: rows, bytes: JSON.stringify(rows).length };
}
