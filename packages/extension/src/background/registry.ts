import { ALIAS_RE, type Env, EnvSchema, HOST_RE } from '@sn-mcp/shared';

/**
 * Minimal instance registry (T-004; extended in T-010).
 *
 * The registry is user-managed: only the popup (a user gesture) adds or removes entries.
 * Each entry is bound to exactly one https origin, and registering it requests host
 * permission for that origin only. Nothing here ever looks at the active tab to pick a target.
 *
 * This module is pure apart from the injected `RegistryStorage`, so it can be unit-tested
 * without Chrome APIs.
 */

export interface InstanceEntry {
  alias: string;
  host: string;
  label: string;
  env: Env;
  addedAt: string;
}

export interface RegistryStorage {
  load(): Promise<unknown>;
  save(entries: InstanceEntry[]): Promise<void>;
}

export const REGISTRY_STORAGE_KEY = 'registry.v1';
export const MAX_INSTANCES = 20;
export const MAX_LABEL_LENGTH = 80;

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Host names only: IP literals (last label all digits) are not ServiceNow instance hosts. */
export function isValidInstanceHost(host: string): boolean {
  return HOST_RE.test(host) && !/\.[0-9]+$/.test(host);
}

/** The exact host-permission pattern requested for an instance. Never a wildcard host. */
export function originPattern(host: string): string {
  if (!isValidInstanceHost(host)) throw new Error(`invalid host: ${host}`);
  return `https://${host}/*`;
}

/**
 * Accepts either a bare host ("dev123.service-now.com") or a full URL pasted from the address
 * bar. Only https on the default port is accepted; credentials, ports and other schemes are
 * rejected rather than stripped.
 */
export function parseInstanceHost(input: string): RegistryResult<string> {
  const raw = input.trim();
  if (raw === '') return fail('Enter the instance URL or host name.');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('Not a valid URL or host name.');
  }
  if (url.protocol !== 'https:') return fail('Only https:// instances are supported.');
  if (url.username || url.password) return fail('URLs with credentials are not accepted.');
  if (url.port !== '') return fail('Custom ports are not supported.');
  const host = url.hostname.toLowerCase();
  if (!isValidInstanceHost(host)) return fail(`"${host}" is not a valid host name.`);
  return { ok: true, value: host };
}

/** Display hint only. It never registers anything or chooses a target. */
export function looksLikeServiceNow(host: string): boolean {
  return /\.service-now\.com$/.test(host) || /\.servicenowservices\.com$/.test(host);
}

/** Unclassified instances get PROD treatment everywhere (ARCHITECTURE §5.1). */
export function effectiveEnv(env: Env): 'dev' | 'test' | 'prod' {
  return env === 'unclassified' ? 'prod' : env;
}

export interface RegisterInput {
  alias: string;
  host: string;
  label?: string;
  env: string;
}

/** Validates a new entry against the current registry. Pure; does not touch storage. */
export function validateNewEntry(
  entries: readonly InstanceEntry[],
  input: RegisterInput,
  now: Date = new Date(),
): RegistryResult<InstanceEntry> {
  const alias = input.alias.trim();
  if (!ALIAS_RE.test(alias)) {
    return fail(
      'Alias must be 1–32 chars: lowercase letters, digits, "-", starting with a letter.',
    );
  }
  if (!isValidInstanceHost(input.host)) return fail('Invalid host.');
  const env = EnvSchema.safeParse(input.env);
  if (!env.success) return fail('Choose an environment.');
  const label = (input.label ?? '').trim();
  if (label.length > MAX_LABEL_LENGTH)
    return fail(`Label is limited to ${MAX_LABEL_LENGTH} chars.`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  if (/[\u0000-\u001f\u007f-\u009f]/.test(label)) return fail('Label contains control characters.');
  if (entries.some((e) => e.alias === alias)) return fail(`Alias "${alias}" is already used.`);
  if (entries.some((e) => e.host === input.host)) {
    return fail(`${input.host} is already registered.`);
  }
  if (entries.length >= MAX_INSTANCES) return fail(`At most ${MAX_INSTANCES} instances.`);
  return {
    ok: true,
    value: { alias, host: input.host, label, env: env.data, addedAt: now.toISOString() },
  };
}

/** Drops malformed stored entries instead of trusting storage contents. */
export function sanitizeStored(raw: unknown): InstanceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: InstanceEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.alias === 'string' &&
      ALIAS_RE.test(e.alias) &&
      typeof e.host === 'string' &&
      isValidInstanceHost(e.host) &&
      typeof e.label === 'string' &&
      e.label.length <= MAX_LABEL_LENGTH &&
      EnvSchema.safeParse(e.env).success &&
      typeof e.addedAt === 'string' &&
      !out.some((x) => x.alias === e.alias || x.host === e.host)
    ) {
      out.push({
        alias: e.alias,
        host: e.host,
        label: e.label,
        env: e.env as Env,
        addedAt: e.addedAt,
      });
    }
  }
  return out;
}

export class Registry {
  constructor(private readonly storage: RegistryStorage) {}

  async list(): Promise<InstanceEntry[]> {
    return sanitizeStored(await this.storage.load());
  }

  async add(entry: InstanceEntry): Promise<RegistryResult<InstanceEntry>> {
    const entries = await this.list();
    const checked = validateNewEntry(entries, entry, new Date(entry.addedAt));
    if (!checked.ok) return checked;
    await this.storage.save([...entries, checked.value]);
    return checked;
  }

  async remove(alias: string): Promise<InstanceEntry | undefined> {
    const entries = await this.list();
    const found = entries.find((e) => e.alias === alias);
    if (found) await this.storage.save(entries.filter((e) => e.alias !== alias));
    return found;
  }
}

/** chrome.storage.local adapter (extension contexts only; there are no content scripts). */
export function chromeRegistryStorage(): RegistryStorage {
  return {
    async load() {
      const data = await chrome.storage.local.get(REGISTRY_STORAGE_KEY);
      return data[REGISTRY_STORAGE_KEY];
    },
    async save(entries) {
      await chrome.storage.local.set({ [REGISTRY_STORAGE_KEY]: entries });
    },
  };
}
