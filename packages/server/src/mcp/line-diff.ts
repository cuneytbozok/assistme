/**
 * Line diff for compare_records (T-032): Myers' algorithm over the lines between the common
 * prefix and suffix, printed as a unified diff with 3 context lines.
 *
 * The edit search is bounded so two very different long scripts can't exhaust memory: past
 * MAX_EDIT_DISTANCE the middle is reported as one replacement. The diff is still correct and
 * complete, only not minimal, and `minimal: false` says so.
 */

export interface DiffOp {
  t: ' ' | '-' | '+';
  line: string;
}

const MAX_EDIT_DISTANCE = 2000;
const CONTEXT = 3;

function myers(a: readonly string[], b: readonly string[]): DiffOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const size = 2 * max + 3;
  const offset = max + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const i = k + offset;
      let x =
        k === -d || (k !== d && (v[i - 1] as number) < (v[i + 1] as number))
          ? (v[i + 1] as number)
          : (v[i - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[i] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        return backtrack(a, b, trace);
      }
    }
    trace.push(v.slice(offset - d - 1, offset + d + 2));
  }
  return undefined;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    // Each saved row holds k from -d-1 to d+1 of the V array *after* step d; the choice made at
    // step d depends on the row before it.
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number) => prev[k + d] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: ' ', line: a[x] as string });
    }
    if (down) {
      y--;
      ops.push({ t: '+', line: b[y] as string });
    } else {
      x--;
      ops.push({ t: '-', line: a[x] as string });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: ' ', line: a[x] as string });
  }
  return ops.reverse();
}

export function diffLines(
  a: readonly string[],
  b: readonly string[],
): { ops: DiffOp[]; minimal: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const found = midA.length === 0 && midB.length === 0 ? [] : myers(midA, midB);
  const middle = found ?? [
    ...midA.map((line): DiffOp => ({ t: '-', line })),
    ...midB.map((line): DiffOp => ({ t: '+', line })),
  ];
  const ctx = (line: string): DiffOp => ({ t: ' ', line });
  return {
    ops: [...a.slice(0, start).map(ctx), ...middle, ...a.slice(endA).map(ctx)],
    minimal: found !== undefined,
  };
}

/** Unified diff lines (`@@ -l,n +l,n @@`, then ` `/`-`/`+` lines); empty when nothing differs. */
export function unifiedDiff(a: string, b: string): { lines: string[]; minimal: boolean } {
  const { ops, minimal } = diffLines(a.split('\n'), b.split('\n'));
  const out: string[] = [];
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  while (i < ops.length) {
    if ((ops[i] as DiffOp).t === ' ') {
      i++;
      lineA++;
      lineB++;
      continue;
    }
    // A hunk: from CONTEXT lines before this change to CONTEXT lines after the last change that
    // is close enough to share the hunk.
    const lead = Math.min(CONTEXT, i === 0 ? 0 : countContextBefore(ops, i));
    let end = i;
    let last = i;
    while (end < ops.length) {
      if ((ops[end] as DiffOp).t !== ' ') last = end;
      else if (end - last > CONTEXT * 2) break;
      end++;
    }
    const stop = Math.min(ops.length, last + CONTEXT + 1);
    const hunk = ops.slice(i - lead, stop);
    const countA = hunk.filter((o) => o.t !== '+').length;
    const countB = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${lineA - lead},${countA} +${lineB - lead},${countB} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    lineA += hunk.filter((o) => o.t !== '+').length - lead;
    lineB += hunk.filter((o) => o.t !== '-').length - lead;
    i = stop;
  }
  return { lines: out, minimal };
}

function countContextBefore(ops: readonly DiffOp[], i: number): number {
  let n = 0;
  for (let j = i - 1; j >= 0 && (ops[j] as DiffOp).t === ' '; j--) n++;
  return n;
}

/** Applies unified diff lines to `a`. Used by tests to prove a diff is exact. */
export function applyUnified(a: string, lines: readonly string[]): string {
  const src = a.split('\n');
  const out: string[] = [];
  let at = 0;
  for (const l of lines) {
    const header = /^@@ -(\d+),(\d+) /.exec(l);
    if (header) {
      const from = Number(header[1]) - 1;
      out.push(...src.slice(at, from));
      at = from;
      continue;
    }
    const kind = l[0];
    const text = l.slice(1);
    if (kind === '+') out.push(text);
    else {
      if (src[at] !== text) throw new Error(`diff does not apply at line ${at + 1}`);
      if (kind === ' ') out.push(text);
      at++;
    }
  }
  out.push(...src.slice(at));
  return out.join('\n');
}
