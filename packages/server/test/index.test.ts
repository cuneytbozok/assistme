import { describe, expect, it } from 'vitest';
import { SERVER_PROTOCOL_VERSION } from '../src/index.js';

describe('@sn-mcp/server', () => {
  it('uses the shared protocol version', () => {
    expect(SERVER_PROTOCOL_VERSION).toBe(1);
  });
});
