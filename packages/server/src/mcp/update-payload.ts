/**
 * Reads the XML copy of a record in `sys_update_version.payload` (T-042), so two versions can be
 * diffed element by element instead of as XML text.
 *
 * Expected: `<record_update table="t"><t action="..."><field>value</field>...</t>...`, with scripts
 * in CDATA. Seen live (T-042): `t` is often followed by other records, such as
 * `sys_translated_text` and `sys_es_latest_script`, which are kept as whole XML under
 * `record:<name>`, so nothing is dropped. The root named its table on all 9 pairs of one live run,
 * but several records with no way to tell the main one return undefined. Anything else returns undefined, and the caller diffs the raw text instead, so another
 * form gives a less readable diff but never a wrong one.
 *
 * The content is untrusted: no DTDs or custom entities, one forward pass (no backtracking over the
 * payload), and only the five standard entities and numeric references are decoded. It's a reader
 * for this one shape, not a general XML parser. It filters nothing out: see docs/SECURITY.md.
 */

export interface UpdatePayload {
  /** The record's element name, normally its table. */
  table: string;
  /**
   * Element name → text. `@action` holds the record's action attribute, when present, and
   * `record:<name>` (`:2` for a repeat) the whole XML of any other record in the payload.
   */
  fields: Map<string, string>;
}

interface Element {
  name: string;
  attrs: string;
  start: number;
  end: number;
  /** The whole element, tags included. */
  outerStart: number;
  outerEnd: number;
}

const OPEN_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const CDATA = '<![CDATA[';
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function openTag(s: string, at: number) {
  OPEN_TAG.lastIndex = at;
  return OPEN_TAG.exec(s);
}

/** Skips a declaration, comment or CDATA section starting at `at`; undefined if unterminated. */
function skipSpecial(s: string, at: number, end: number): number | undefined {
  for (const [open, close] of [
    ['<?', '?>'],
    ['<!--', '-->'],
    [CDATA, ']]>'],
  ] as const) {
    if (s.startsWith(open, at)) {
      const stop = s.indexOf(close, at + open.length);
      return stop === -1 || stop >= end ? undefined : stop + close.length;
    }
  }
  return at;
}

/** Index of the `</name>` closing the element whose content starts at `from`. */
function findClose(s: string, name: string, from: number, end: number) {
  let depth = 1;
  let i = from;
  while (i < end) {
    const lt = s.indexOf('<', i);
    if (lt === -1 || lt >= end) return undefined;
    const skipped = skipSpecial(s, lt, end);
    if (skipped === undefined) return undefined;
    if (skipped !== lt) {
      i = skipped;
      continue;
    }
    if (s.startsWith(`</${name}`, lt)) {
      const gt = s.indexOf('>', lt);
      if (gt === -1 || gt >= end) return undefined;
      if (s.slice(lt + 2 + name.length, gt).trim() === '') {
        if (--depth === 0) return { close: lt, after: gt + 1 };
        i = gt + 1;
        continue;
      }
    }
    const nested = openTag(s, lt);
    if (nested?.[1] === name && nested[3] !== '/') depth++;
    i = nested ? lt + nested[0].length : lt + 1;
  }
  return undefined;
}

/** The elements directly inside [start, end), or undefined if anything else is there. */
function children(
  s: string,
  start: number,
  end: number,
  seen: string[] = [],
): Element[] | undefined {
  const out: Element[] = [];
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if (s.startsWith(CDATA, i)) return undefined;
    const skipped = skipSpecial(s, i, end);
    if (skipped === undefined) return undefined;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const tag = openTag(s, i);
    if (!tag) return undefined; // text, a DTD, or a malformed tag
    const name = tag[1] as string;
    const attrs = tag[2] as string;
    const after = i + tag[0].length;
    if (after > end) return undefined;
    if (tag[3] === '/') {
      out.push({ name, attrs, start: after, end: after, outerStart: i, outerEnd: after });
      seen.push(name);
      i = after;
      continue;
    }
    const closed = findClose(s, name, after, end);
    if (!closed) return undefined;
    out.push({
      name,
      attrs,
      start: after,
      end: closed.close,
      outerStart: i,
      outerEnd: closed.after,
    });
    seen.push(name);
    i = closed.after;
  }
  return out;
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (whole, e) => {
    if (e[0] !== '#') return ENTITIES[e] as string;
    const code =
      e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** An element's text: CDATA as is, the rest decoded. Nested markup stays as text. */
function textOf(s: string, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const at = s.indexOf(CDATA, i);
    if (at === -1 || at >= end) return out + decodeEntities(s.slice(i, end));
    out += decodeEntities(s.slice(i, at));
    const stop = s.indexOf(']]>', at + CDATA.length);
    if (stop === -1 || stop >= end) return out + s.slice(at, end);
    out += s.slice(at + CDATA.length, stop);
    i = stop + 3;
  }
  return out;
}

/** Why a payload does or doesn't parse: element names and actions only, never values. */
export interface PayloadShape {
  /** Where parsing stops. Undefined means the payload parses. */
  failed_at?: 'root' | 'root_content' | 'records' | 'record_content' | 'repeated';
  roots?: string[];
  root_table?: string;
  records?: { name: string; action?: string }[];
  elements?: number;
  /** The last element read before `record_content` failed, or the repeated one. */
  near?: string;
}

const MAX_SHAPE_RECORDS = 20;

function attr(attrs: string, name: 'action' | 'table'): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m?.[1] ?? m?.[2];
}

function nameLike(value: string | undefined): string | undefined {
  return value !== undefined && /^[\w-]{1,40}$/.test(value) ? value : undefined;
}

/** The record a payload is about: its only one, or the one its root names. Never a guess. */
function mainRecord(root: Element, records: Element[]): Element | undefined {
  if (records.length === 1) return records[0];
  const table = attr(root.attrs, 'table');
  const named = records.filter((r) => r.name === table);
  return named.length === 1 ? named[0] : undefined;
}

/** For diagnosis in the live scenarios, so a fallback can be explained without record content. */
export function describePayload(xml: string): PayloadShape {
  const roots = children(xml, 0, xml.length);
  if (!roots) return { failed_at: 'root' };
  const names = roots.map((r) => r.name).slice(0, MAX_SHAPE_RECORDS);
  const root = roots[0];
  if (roots.length !== 1 || root?.name !== 'record_update') {
    return { failed_at: 'root', roots: names };
  }
  const records = children(xml, root.start, root.end);
  if (!records) return { failed_at: 'root_content', roots: names };
  const rootTable = nameLike(attr(root.attrs, 'table'));
  const shape: PayloadShape = {
    roots: names,
    ...(rootTable ? { root_table: rootTable } : {}),
    records: records.slice(0, MAX_SHAPE_RECORDS).map((r) => {
      const action = nameLike(attr(r.attrs, 'action'));
      return { name: r.name, ...(action ? { action } : {}) };
    }),
  };
  const record = mainRecord(root, records);
  if (!record) return { ...shape, failed_at: 'records' };
  const seen: string[] = [];
  const elements = children(xml, record.start, record.end, seen);
  if (!elements) {
    const near = seen.at(-1);
    return {
      ...shape,
      failed_at: 'record_content',
      elements: seen.length,
      ...(near ? { near } : {}),
    };
  }
  const distinct = new Set<string>();
  for (const e of elements) {
    if (distinct.has(e.name)) {
      return { ...shape, failed_at: 'repeated', elements: elements.length, near: e.name };
    }
    distinct.add(e.name);
  }
  return { ...shape, elements: elements.length };
}

/** The record in a payload, or undefined when the payload isn't the expected shape. */
export function parseUpdatePayload(xml: string): UpdatePayload | undefined {
  const roots = children(xml, 0, xml.length);
  const root = roots?.[0];
  if (roots?.length !== 1 || root?.name !== 'record_update') return undefined;
  const records = children(xml, root.start, root.end);
  const record = records && mainRecord(root, records);
  if (!records || !record) return undefined;
  const elements = children(xml, record.start, record.end);
  if (!elements) return undefined;
  const fields = new Map<string, string>();
  const action = attr(record.attrs, 'action');
  if (action !== undefined) fields.set('@action', action);
  for (const e of elements) {
    // Repeated elements can't be keyed by name without losing one.
    if (fields.has(e.name)) return undefined;
    fields.set(e.name, textOf(xml, e.start, e.end));
  }
  const counts = new Map<string, number>();
  for (const other of records) {
    if (other === record) continue;
    const n = (counts.get(other.name) ?? 0) + 1;
    counts.set(other.name, n);
    const key = `record:${other.name}${n > 1 ? `:${n}` : ''}`;
    if (fields.has(key)) return undefined;
    fields.set(key, xml.slice(other.outerStart, other.outerEnd));
  }
  return { table: record.name, fields };
}
