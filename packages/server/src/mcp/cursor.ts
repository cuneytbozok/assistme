/**
 * Signed pagination cursors (T-023, ADR-006/ADR-011, ARCHITECTURE §8.3).
 *
 * A cursor is `base64url(JSON state).base64url(HMAC-SHA256)`, signed with a random per-process
 * key. It binds the instance, table, final query (including the sys_id tiebreak), projection,
 * display mode and offset. It does NOT bind the scope id: pagination survives re-approval of
 * an expired grant, while every request still needs a valid scope for that instance.
 * There is no offset ceiling. Anything tampered, foreign or for another instance → INVALID_INPUT.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const CursorStateSchema = z.strictObject({
  v: z.literal(1),
  /** Which tool continues with this cursor. */
  tool: z.string().max(40),
  instance: z.string().max(32),
  table: z.string().max(80),
  query: z.string().max(4000),
  /** Explicit projection, or "*" for every field. */
  fields: z.union([z.literal('*'), z.array(z.string().max(200)).max(200)]),
  displayValue: z.enum(['false', 'true', 'all']),
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Readable rows of the window at `offset` already returned (see paginate). */
  skip: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /**
   * The last 50 rows returned, as 10-character fingerprints run together, to skip them if a
   * changing table hands them back (paginate). Short because a cursor appears twice per result.
   */
  recent: z.string().max(500).optional(),
  /** Rows wanted per call (the original `limit`). */
  limit: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Rows already returned across earlier calls (for `page.returned_total`). */
  seen: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type CursorState = z.infer<typeof CursorStateSchema>;

/** Every composite tool's cursor names its tool and instance (T-029 onward). */
export interface ToolCursorBase {
  v: 1;
  tool: string;
  instance: string;
}

export class CursorError extends Error {}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class CursorCodec {
  constructor(private readonly key: Buffer = randomBytes(32)) {}

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.key).update(`sn-mcp-cursor:v1:${payload}`).digest();
  }

  encode(state: CursorState): string {
    const payload = b64(JSON.stringify(CursorStateSchema.parse(state)));
    return `${payload}.${b64(this.mac(payload))}`;
  }

  /** Verifies the signature and shape. Throws CursorError with a user-facing message. */
  decode(cursor: string): CursorState {
    const parsed = CursorStateSchema.safeParse(this.verify(cursor));
    if (!parsed.success) throw new CursorError('This cursor is unreadable.');
    return parsed.data;
  }

  /** Signs a composite tool's own state (it always names its tool and instance). */
  encodeState<S extends ToolCursorBase>(schema: z.ZodType<S>, state: S): string {
    const payload = b64(JSON.stringify(schema.parse(state)));
    return `${payload}.${b64(this.mac(payload))}`;
  }

  /** Verifies a composite tool's cursor: the signature, then the tool it belongs to, then shape. */
  decodeState<S extends ToolCursorBase>(schema: z.ZodType<S>, cursor: string, tool: string): S {
    const raw = this.verify(cursor) as { tool?: unknown };
    if (raw?.tool !== tool) {
      throw new CursorError(`This cursor belongs to ${String(raw?.tool)}, not ${tool}.`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new CursorError('This cursor is unreadable.');
    return parsed.data;
  }

  /** Checks the signature and returns the decoded JSON payload. */
  private verify(cursor: string): unknown {
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || cursor.length > 8000) {
      throw new CursorError('This is not a cursor issued by this connector.');
    }
    const [payload, sig] = parts as [string, string];
    const expected = this.mac(payload);
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'base64url');
    } catch {
      throw new CursorError('This cursor has been modified.');
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new CursorError(
        'This cursor has been modified, or was issued by a previous connector process. Start the query again without a cursor.',
      );
    }
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new CursorError('This cursor is unreadable.');
    }
  }
}
