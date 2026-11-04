/**
 * Length-prefixed JSON framing (ARCHITECTURE §4).
 *
 * Chrome native messaging uses a 4-byte message length in native byte order (little-endian on
 * every platform we support) followed by UTF-8 JSON. The broker uses the same framing on the
 * Unix socket, so there is one codec for both hops.
 */

/** Chrome's limit for host → extension messages. */
export const MAX_TO_EXTENSION_BYTES = 1024 * 1024;
/** Chrome's limit for extension → host messages. */
export const MAX_FROM_EXTENSION_BYTES = 64 * 1024 * 1024;

export class FrameError extends Error {
  constructor(
    readonly code: 'FRAME_TOO_LARGE' | 'INVALID_JSON',
    message: string,
  ) {
    super(message);
  }
}

export function encodeFrame(message: unknown, maxBytes = Number.POSITIVE_INFINITY): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) {
    throw new FrameError('FRAME_TOO_LARGE', `frame of ${body.length} bytes exceeds ${maxBytes}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. Rejects a frame as soon as its header announces more than `maxBytes`,
 * before buffering the body.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  /** Feeds bytes; returns every complete message. Throws FrameError on a bad frame. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        throw new FrameError(
          'FRAME_TOO_LARGE',
          `frame of ${length} bytes exceeds ${this.maxBytes}`,
        );
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch {
        throw new FrameError('INVALID_JSON', 'frame body is not valid JSON');
      }
    }
    return out;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}
