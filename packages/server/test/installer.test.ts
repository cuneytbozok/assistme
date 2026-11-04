import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from '@sn-mcp/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyInstall,
  assertSafeAncestors,
  InstallError,
  planInstall,
  uninstall,
} from '../src/install/installer.js';
import { makeTempDir } from './helpers.js';

const uid = process.getuid?.() as number;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostScript = join(root, 'dist', 'bin', 'native-host.js');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const t = makeTempDir();
  cleanups.push(t.cleanup);
  mkdirSync(t.dir, { recursive: true, mode: 0o700 });
  // A host script copy inside the temp tree, so ancestor checks see only safe directories.
  const script = join(t.dir, 'native-host.js');
  writeFileSync(script, '// stub\n');
  return {
    base: t.dir,
    paths: {
      nodePath: process.execPath,
      hostScript: script,
      installDir: join(t.dir, 'install'),
      manifestDir: join(t.dir, 'NativeMessagingHosts'),
    },
  };
}

describe('installer', () => {
  it('AC9: writes a manifest with exactly one allowed origin, plus a 0755 wrapper', () => {
    const { paths } = setup();
    const plan = planInstall(paths, uid);
    applyInstall(plan);
    const manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: plan.wrapperPath,
      type: 'stdio',
      allowed_origins: [EXTENSION_ORIGIN],
    });
    expect(plan.manifestPath.endsWith(`${NATIVE_HOST_NAME}.json`)).toBe(true);
    expect(lstatSync(plan.wrapperPath).mode & 0o777).toBe(0o755);
    expect(lstatSync(plan.manifestPath).mode & 0o777).toBe(0o644);
    const wrapper = readFileSync(plan.wrapperPath, 'utf8');
    expect(wrapper.startsWith('#!/bin/sh\n')).toBe(true);
    expect(wrapper).toContain(`exec '`);
    expect(wrapper).toContain('"$@"');

    expect(uninstall(paths).sort()).toEqual([plan.manifestPath, plan.wrapperPath].sort());
    expect(existsSync(plan.manifestPath)).toBe(false);
  });

  it('refuses paths under group/world-writable or foreign-owned directories', () => {
    const { base, paths } = setup();
    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(() => planInstall({ ...paths, installDir: join(open, 'install') }, uid)).toThrow(
      InstallError,
    );
    expect(() => planInstall({ ...paths, manifestDir: join(open, 'm') }, uid)).toThrow(/writable/);
    expect(() => assertSafeAncestors(join(base, 'x', 'y'), uid + 1)).toThrow(/another user/);
    expect(() => planInstall({ ...paths, installDir: 'relative/dir' }, uid)).toThrow(/absolute/);
    expect(() => planInstall({ ...paths, hostScript: join(base, 'missing.js') }, uid)).toThrow(
      /not found/,
    );
  });

  it('accepts directories group-writable by admin/wheel (Homebrew), refuses other writable groups', () => {
    const { base } = setup();
    const staff = join(base, 'staffdir');
    mkdirSync(staff);
    chmodSync(staff, 0o775); // owned by our primary group (staff), group-writable
    expect(() => assertSafeAncestors(join(staff, 'x'), uid)).toThrow(/writable/);
    const admin = join(base, 'admindir');
    mkdirSync(admin);
    try {
      chownSync(admin, uid, 80);
    } catch {
      return; // not a member of admin on this machine; the refusal case above still ran
    }
    chmodSync(admin, 0o775);
    expect(() => assertSafeAncestors(join(admin, 'x'), uid)).not.toThrow();
  });

  it('quotes paths with spaces and single quotes in the wrapper', () => {
    const { base, paths } = setup();
    const odd = join(base, "it's a dir");
    mkdirSync(odd, { mode: 0o700 });
    const script = join(odd, 'host.js');
    writeFileSync(script, '');
    const plan = planInstall({ ...paths, hostScript: script }, uid);
    expect(plan.wrapperContent).toContain(`'${odd.replace(/'/g, `'\\''`)}/host.js'`);
  });

  it('CLI --dry-run prints the plan and writes nothing', () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const out = execFileSync(
      process.execPath,
      [join(root, 'dist', 'bin', 'install-native-host.js'), '--dry-run'],
      {
        env: { ...process.env, HOME: t.dir },
        encoding: 'utf8',
      },
    );
    expect(out).toContain(EXTENSION_ORIGIN);
    expect(out).toContain('Dry run: nothing written.');
    expect(out).toContain(hostScript);
    expect(existsSync(join(t.dir, 'Library'))).toBe(false);
  });
});
