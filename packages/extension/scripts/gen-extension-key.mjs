#!/usr/bin/env node
/**
 * Generates the extension's signing key pair and pins a stable extension ID.
 *
 *   node packages/extension/scripts/gen-extension-key.mjs [--force]
 *
 * - Writes the PUBLIC key (base64 DER SPKI) into manifest.json `key`.
 * - Writes the derived ID to EXTENSION_ID.
 * - The PRIVATE key is discarded: an unpacked extension needs only the public `key` to get a
 *   stable ID. Nothing secret is written to disk or printed.
 *
 * Re-running changes the extension ID, which invalidates the native-messaging host manifest
 * (`allowed_origins`). It therefore refuses to overwrite an existing key unless --force is given.
 *
 * ID derivation (Chrome): SHA-256 of the DER public key, first 32 hex digits, each digit 0–f
 * mapped to a–p.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const idPath = join(root, 'EXTENSION_ID');

export function extensionIdFromPublicKey(base64Der) {
  const hex = createHash('sha256').update(Buffer.from(base64Der, 'base64')).digest('hex');
  return [...hex.slice(0, 32)]
    .map((d) => String.fromCharCode(97 + Number.parseInt(d, 16)))
    .join('');
}

function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.key && !process.argv.includes('--force')) {
    console.error(
      'manifest.json already has a key. Re-running changes the extension ID and breaks the\n' +
        'native host allowed_origins. Pass --force if that is really intended.',
    );
    process.exit(1);
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const key = Buffer.from(der).toString('base64');
  const id = extensionIdFromPublicKey(key);

  // Keep `key` near the top of the manifest for readability.
  const { manifest_version, name, version, ...rest } = manifest;
  delete rest.key;
  const out = { manifest_version, name, version, key, ...rest };
  writeFileSync(manifestPath, `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(idPath, `${id}\n`);
  console.log(`Extension ID: ${id}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
