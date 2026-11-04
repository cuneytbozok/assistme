import { ALIAS_RE, ENV_NAME_RE, type Env, EnvSchema, HOST_RE } from '@sn-mcp/shared';

/**
 * Instance registry (T-004, completed in T-010; PRODUCT_SPEC FR-2, ARCHITECTURE §5.1).
 *
 * The registry is user-managed: only the popup (a user gesture) adds, edits or removes entries.
 * Alias and host are immutable once registered; to change either, remove and register again.
 * Label and environment can be edited. Every mutation that changes what a grant was approved
 * for (removal, environment change) invalidates that instance's grants (see Grants).
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
  /** Only for env "unclassified" (shown as "Other"): the user's name, e.g. "UAT". Display only. */
  envName?: string;
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
  envName?: string;
}

function validateLabel(raw: string | undefined): RegistryResult<string> {
  const label = (raw ?? '').trim();
  if (label.length > MAX_LABEL_LENGTH)
    return fail(`Label is limited to ${MAX_LABEL_LENGTH} chars.`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  if (/[\u0000-\u001f\u007f-\u009f]/.test(label)) return fail('Label contains control characters.');
  return { ok: true, value: label };
}

/**
 * "Other" environments may carry a display name. It never changes policy (always PROD rules),
 * and names that collide with the fixed classes are refused so the badge can't mislead.
 */
export function validateEnvName(
  env: Env,
  raw: string | undefined,
): RegistryResult<string | undefined> {
  if (env !== 'unclassified') return { ok: true, value: undefined };
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') return { ok: true, value: undefined };
  if (!ENV_NAME_RE.test(name)) {
    return fail('Environment name: up to 16 letters, digits, spaces, "-" or "_".');
  }
  if (/^(dev|test|prod|production|development)$/i.test(name)) {
    return fail(`Choose ${name.toUpperCase().slice(0, 4)} above instead of naming it under Other.`);
  }
  return { ok: true, value: name };
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
  const label = validateLabel(input.label);
  if (!label.ok) return label;
  const envName = validateEnvName(env.data, input.envName);
  if (!envName.ok) return envName;
  if (entries.some((e) => e.alias === alias)) return fail(`Alias "${alias}" is already used.`);
  if (entries.some((e) => e.host === input.host)) {
    return fail(`${input.host} is already registered.`);
  }
  if (entries.length >= MAX_INSTANCES) return fail(`At most ${MAX_INSTANCES} instances.`);
  return {
    ok: true,
    value: {
      alias,
      host: input.host,
      label: label.value,
      env: env.data,
      ...(envName.value ? { envName: envName.value } : {}),
      addedAt: now.toISOString(),
    },
  };
}

export interface EditInput {
  label?: string;
  env?: string;
  envName?: string;
}

/** Validates an edit of label and/or env. Alias and host cannot be edited. Pure. */
export function validateEdit(
  entries: readonly InstanceEntry[],
  alias: string,
  input: EditInput,
): RegistryResult<{ before: InstanceEntry; after: InstanceEntry }> {
  const before = entries.find((e) => e.alias === alias);
  if (!before) return fail(`No registered instance "${alias}".`);
  const after: InstanceEntry = { ...before };
  if (input.label !== undefined) {
    const label = validateLabel(input.label);
    if (!label.ok) return label;
    after.label = label.value;
  }
  if (input.env !== undefined) {
    const env = EnvSchema.safeParse(input.env);
    if (!env.success) return fail('Choose an environment.');
    after.env = env.data;
  }
  if (input.env !== undefined || input.envName !== undefined) {
    const name = validateEnvName(
      after.env,
      input.envName ?? (after.env === before.env ? before.envName : undefined),
    );
    if (!name.ok) return name;
    if (name.value) after.envName = name.value;
    else delete after.envName;
  }
  return { ok: true, value: { before, after } };
}

/**
 * Tab-based suggestion (activeTab only: the tab the user opened the popup on). Returns the
 * host to offer, or undefined. A suggestion only pre-fills the form; it never registers
 * anything and never selects a target (FR-3.9).
 */
export function suggestionFromTabUrl(
  url: string | undefined,
  entries: readonly InstanceEntry[],
): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const host = parseInstanceHost(url);
  if (!host.ok) return undefined;
  if (entries.some((e) => e.host === host.value)) return undefined;
  // Custom domains are recognised by ServiceNow UI paths; other sites are not suggested.
  const snPath = /^\/(now\/|[a-z0-9_]+\.do$|[a-z0-9_]+_list\.do$|navpage\.do$|login\.do$)/i.test(
    parsed.pathname,
  );
  return looksLikeServiceNow(host.value) || snPath ? host.value : undefined;
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
      const env = e.env as Env;
      const name = typeof e.envName === 'string' ? validateEnvName(env, e.envName) : undefined;
      out.push({
        alias: e.alias,
        host: e.host,
        label: e.label,
        env,
        ...(name?.ok && name.value ? { envName: name.value } : {}),
        addedAt: e.addedAt,
      });
    }
  }
  return out;
}

export class Registry {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: RegistryStorage) {}

  /** Serializes read-modify-write cycles. */
  private exclusive<T>(fn: (entries: InstanceEntry[]) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => fn(await this.list()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<InstanceEntry[]> {
    return sanitizeStored(await this.storage.load());
  }

  add(input: RegisterInput, now: Date = new Date()): Promise<RegistryResult<InstanceEntry>> {
    return this.exclusive(async (entries) => {
      const checked = validateNewEntry(entries, input, now);
      if (checked.ok) await this.storage.save([...entries, checked.value]);
      return checked;
    });
  }

  edit(
    alias: string,
    input: EditInput,
  ): Promise<RegistryResult<{ before: InstanceEntry; after: InstanceEntry }>> {
    return this.exclusive(async (entries) => {
      const checked = validateEdit(entries, alias, input);
      if (checked.ok) {
        await this.storage.save(entries.map((e) => (e.alias === alias ? checked.value.after : e)));
      }
      return checked;
    });
  }

  remove(alias: string): Promise<InstanceEntry | undefined> {
    return this.exclusive(async (entries) => {
      const found = entries.find((e) => e.alias === alias);
      if (found) await this.storage.save(entries.filter((e) => e.alias !== alias));
      return found;
    });
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
