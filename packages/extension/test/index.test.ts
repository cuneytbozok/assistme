import { describe, expect, it } from 'vitest';
import { EXTENSION_PROTOCOL_VERSION } from '../src/index.js';

describe('@sn-mcp/extension', () => {
  it('uses the shared protocol version', () => {
    expect(EXTENSION_PROTOCOL_VERSION).toBe(1);
  });
});
