import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/index.js';

describe('@sn-mcp/shared', () => {
  it('exposes the bridge protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
