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
  /** Rows wanted per call (the original `limit`). */
  limit: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Rows already returned across earlier calls (for `page.returned_total`). */
  seen: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type CursorState = z.infer<typeof CursorStateSchema>;

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
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new CursorError('This cursor is unreadable.');
    }
    const parsed = CursorStateSchema.safeParse(raw);
    if (!parsed.success) throw new CursorError('This cursor is unreadable.');
    return parsed.data;
  }
}
