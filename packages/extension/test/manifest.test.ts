import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;
const extensionId = readFileSync(join(root, 'EXTENSION_ID'), 'utf8').trim();

/** Independent re-implementation of Chrome's ID derivation (not shared with the generator). */
function idFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (d) => 'abcdefghijklmnop'[Number.parseInt(d, 16)] as string);
}

describe('manifest.json', () => {
  it('is MV3 with a module service worker and a popup', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect((manifest.action as Record<string, unknown>).default_popup).toBe('popup.html');
  });

  it('has exactly the approved permission set', () => {
    expect([...(manifest.permissions as string[])].sort()).toEqual(
      ['nativeMessaging', 'notifications', 'scripting', 'storage'].sort(),
    );
  });

  it('requests no host access up front; hosts are optional and https only', () => {
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['https://*/*']);
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it('has no cookies permission and no external connectivity surface', () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/cookies/i);
    for (const key of [
      'externally_connectable',
      'content_scripts',
      'web_accessible_resources',
      'content_security_policy',
      'oauth2',
      'declarative_net_request',
      'update_url',
    ]) {
      expect(manifest[key], key).toBeUndefined();
    }
    for (const perm of [
      'tabs',
      'activeTab',
      'webRequest',
      'debugger',
      'declarativeNetRequest',
      'history',
      '<all_urls>',
    ]) {
      expect(manifest.permissions as string[]).not.toContain(perm);
    }
  });

  it('has a pinned public key whose derived ID equals EXTENSION_ID', () => {
    expect(typeof manifest.key).toBe('string');
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(idFromKey(manifest.key as string)).toBe(extensionId);
  });

  it('contains a public key only (SPKI DER), never a private key', () => {
    const der = Buffer.from(manifest.key as string, 'base64');
    // SPKI for RSA starts with SEQUENCE + rsaEncryption OID; a PKCS#8 private key would not fit
    // in this size and would contain a version INTEGER first.
    expect(der.length).toBeLessThan(600);
    expect(der.toString('hex')).toContain('2a864886f70d010101');
    expect(JSON.stringify(manifest)).not.toMatch(/PRIVATE KEY/);
  });
});

describe('entry points', () => {
  it.each(['src/background/index.ts', 'src/popup/popup.ts', 'src/diagnostics/diagnostics.ts'])(
    '%s imports the CSP/zod setup first',
    (file) => {
      const src = readFileSync(join(root, file), 'utf8');
      const firstImport = src.match(/^import .*$/m)?.[0];
      expect(firstImport).toBe("import '../csp.js';");
    },
  );

  it('popup requests host permission only via originPattern (single exact origin)', () => {
    const src = readFileSync(join(root, 'src/popup/popup.ts'), 'utf8');
    const requests = src.match(/chrome\.permissions\.request\(\{[^}]*\}\)/g) ?? [];
    expect(requests).toEqual([
      'chrome.permissions.request({ origins: [originPattern(entry.host)] })',
    ]);
  });
});
