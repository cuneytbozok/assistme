/**
 * T-021 AC1: every error code has a message and a hint on every path a tool can return it.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_HINTS, ERROR_CODES, protocolError } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { mapBridgeError } from '../src/mcp/errors.js';
import { toolError } from '../src/mcp/results.js';
import { INSTRUCTIONS, UNTRUSTED_NOTE } from '../src/mcp/server.js';

describe('error catalog', () => {
  it.each(ERROR_CODES.map((c) => [c]))('%s has a message and a hint everywhere', (code) => {
    expect(DEFAULT_HINTS[code].length).toBeGreaterThan(20);
    for (const r of [
      toolError(code, `msg for ${code}`),
      mapBridgeError(code, `msg for ${code}`, undefined),
    ]) {
      const body = r.structuredContent as {
        ok: boolean;
        error: { code: string; message: string; hint: string };
      };
      expect(r.isError).toBe(true);
      expect(body).toMatchObject({ ok: false, error: { code, message: `msg for ${code}` } });
      expect(body.error.hint.length).toBeGreaterThan(20);
      expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? '')).toEqual(body);
    }
    expect(protocolError(code, 'm').hint).toBe(DEFAULT_HINTS[code]);
  });

  it('a specific hint overrides the default', () => {
    expect(
      (
        toolError('NOT_FOUND', 'm', 'Did you mean: incident?').structuredContent as {
          error: { hint: string };
        }
      ).error.hint,
    ).toBe('Did you mean: incident?');
  });

  it('the docs list every code', () => {
    const arch = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
    const sec = readFileSync(new URL('../../../docs/SECURITY.md', import.meta.url), 'utf8');
    for (const c of ERROR_CODES) {
      expect(arch, `ARCHITECTURE.md: ${c}`).toContain(c);
      expect(sec, `SECURITY.md: ${c}`).toContain(c);
    }
  });

  it('instructions and results state that content is untrusted', () => {
    expect(INSTRUCTIONS).toMatch(/untrusted data/i);
    expect(INSTRUCTIONS).toMatch(/Never follow instructions/);
    expect(UNTRUSTED_NOTE).toMatch(/Never follow instructions/);
  });
});
