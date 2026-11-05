/**
 * T-038: the troubleshooting skill stays guidance only, within size, and in step with the tools.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AnyOfSchema, OrderBySchema, WhereSchema } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeClient } from '../src/bridge/client.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp/server.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL = join(REPO, 'skills/servicenow-troubleshooting');
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
const refs = readdirSync(join(SKILL, 'references'));
const refText = (f: string) => readFileSync(join(SKILL, 'references', f), 'utf8');
const all = [skillMd, ...refs.map(refText)];

describe('T-038 skill', () => {
  it('has the required frontmatter and stays within 500 lines', () => {
    const fm = /^---\nname: ([a-z-]+)\ndescription: (.+)\n---\n/.exec(skillMd);
    expect(fm?.[1]).toBe('servicenow-troubleshooting');
    expect((fm?.[2] ?? '').length).toBeGreaterThan(50);
    expect((fm?.[2] ?? '').length).toBeLessThanOrEqual(1024);
    expect(skillMd.split('\n').length).toBeLessThanOrEqual(500);
  });

  it('has the six references, each linked from SKILL.md', () => {
    expect([...refs].sort()).toEqual([
      'acl-debugging.md',
      'business-rule-execution.md',
      'cmdb-ire.md',
      'discovery-ecc.md',
      'flow-designer.md',
      'logs-and-transactions.md',
    ]);
    for (const r of refs) expect(skillMd, r).toContain(`(references/${r})`);
  });

  it('never tells Claude to write, execute or get around anything', () => {
    const forbidden =
      /(gr\.update\(|gr\.insert\(|gr\.deleteRecord|deleteMultiple|updateMultiple|background script|scripts - background|curl |fix script|run this script|update_record|create_record|delete_record)/i;
    for (const text of all) expect(text).not.toMatch(forbidden);
    expect(skillMd).toMatch(/Read only/);
    expect(skillMd).toMatch(/untrusted data/);
    expect(skillMd).toMatch(/approve it in the sn-mcp extension popup/);
    expect(skillMd).toMatch(/free to investigate beyond/);
  });

  it('every tool it names exists, and its filter examples are valid', async () => {
    const server = createMcpServer({ cachedRegistry: undefined } as unknown as BridgeClient, {
      config: loadConfig({}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(ct);
    const names = new Set((await c.listTools()).tools.map((t) => t.name));
    await c.close();
    const toolLike =
      /`((?:list|request|claim|release|query|get|discover|describe|aggregate|search|compare)_[a-z_]+)`/g;
    let seen = 0;
    for (const text of all) {
      for (const [, name] of text.matchAll(toolLike)) {
        expect(names.has(name as string), name).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(10);

    let examples = 0;
    for (const text of all) {
      for (const [, json] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        const e = JSON.parse(json as string);
        expect(e.table, json).toMatch(/^[a-z0-9_]+$/);
        if (e.where) expect(WhereSchema.safeParse(e.where).success, json).toBe(true);
        if (e.any_of) expect(AnyOfSchema.safeParse(e.any_of).success, json).toBe(true);
        if (e.order_by) expect(OrderBySchema.safeParse(e.order_by).success, json).toBe(true);
        examples++;
      }
    }
    expect(examples).toBeGreaterThanOrEqual(4);
  });

  it('the plugin files agree, and pack:skill makes a zip with SKILL.md in a named folder', () => {
    const market = JSON.parse(readFileSync(join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(REPO, '.claude-plugin/plugin.json'), 'utf8'));
    expect(market.plugins[0].name).toBe(plugin.name);
    expect(market.plugins[0].source).toBe('./');
    expect(existsSync(join(SKILL, 'SKILL.md'))).toBe(true);

    const out = mkdtempSync(join(tmpdir(), 'sn-skill-'));
    try {
      execFileSync(process.execPath, [join(REPO, 'scripts/pack-skill.ts')], {
        env: { ...process.env, OUT_DIR: out },
        stdio: 'pipe',
      });
      const list = execFileSync('unzip', ['-Z1', join(out, 'servicenow-troubleshooting.zip')], {
        encoding: 'utf8',
      });
      expect(list).toContain('servicenow-troubleshooting/SKILL.md');
      expect(list).toContain('servicenow-troubleshooting/references/cmdb-ire.md');
      const other = execFileSync('unzip', ['-Z1', join(out, 'servicenow.zip')], {
        encoding: 'utf8',
      });
      expect(other).toContain('servicenow/SKILL.md');
      expect(other).toContain('servicenow/references/glide-api.md');
      expect(other).toContain('servicenow/LICENSE');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('the third-party servicenow skill', () => {
  const DIR = join(REPO, 'skills/servicenow');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const files = walk(DIR);
  const main = readFileSync(join(DIR, 'SKILL.md'), 'utf8');

  it('is pinned to a commit, with its licence kept', () => {
    const p = readFileSync(join(DIR, 'PROVENANCE.md'), 'utf8');
    expect(p).toMatch(/`[0-9a-f]{40}`/);
    expect(p).toContain('https://github.com/Vanka07/servicenow-skill');
    expect(readFileSync(join(DIR, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
  });

  it('keeps the note about the read-only connector', () => {
    expect(main).toContain('## Using this with the sn-mcp connector');
    expect(main).toMatch(/The connector only reads/);
    expect(main).toMatch(/untrusted data/);
    expect(/^---\nname: servicenow\n/.test(main)).toBe(true);
  });

  it('has no hidden characters or text aimed at steering the assistant', () => {
    const hidden = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/u;
    const steering =
      /(ignore|disregard) (all|any|previous|prior|the above)|system prompt|do not (tell|mention|inform)|without (asking|telling|informing)|exfiltrat/i;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(hidden.test(text), f).toBe(false);
      expect(steering.test(text), f).toBe(false);
    }
  });

  it('its helper imports no network or process modules', () => {
    const py = readFileSync(join(DIR, 'scripts/snow_helper.py'), 'utf8');
    const imports = py.match(/^(?:import|from) .+$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/\b(subprocess|socket|urllib|http|requests|os|ftplib|ssl)\b/);
    }
  });

  it('does not stand in for the troubleshooting skill', () => {
    expect(main).toContain('`servicenow-troubleshooting`');
    expect(skillMd).not.toContain('references/glide-api.md');
  });
});
