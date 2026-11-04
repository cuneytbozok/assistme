/**
 * User settings for per-request safeguards (T-019, ADR-011, ARCHITECTURE §8.2).
 *
 * Global values plus optional per-instance overrides, stored in chrome.storage.local. Only the
 * popup can change them (popup-api; the broker and MCP server have no message for it).
 * Defaults are the same for every environment: PROD is stricter only for authorization.
 */
import { SAFEGUARD_DEFAULTS, SAFEGUARD_RANGES } from '@sn-mcp/shared';

export type SafeguardKey = keyof typeof SAFEGUARD_DEFAULTS;
export type Safeguards = { [K in SafeguardKey]: number };
export type SafeguardOverrides = Partial<Safeguards>;

export interface SettingsState {
  global: SafeguardOverrides;
  perInstance: Record<string, SafeguardOverrides>;
}

export interface SettingsStorage {
  load(): Promise<unknown>;
  save(state: SettingsState): Promise<void>;
}

export const SETTINGS_STORAGE_KEY = 'settings.v1';
const KEYS = Object.keys(SAFEGUARD_DEFAULTS) as SafeguardKey[];

export const SAFEGUARD_LABELS: Record<SafeguardKey, string> = {
  requestTimeoutMs: 'Request timeout',
  maxResponseBytes: 'Maximum response size',
  maxConcurrentPerInstance: 'Parallel requests per instance',
};

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string };

function inRange(key: SafeguardKey, v: unknown): v is number {
  const r = SAFEGUARD_RANGES[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
}

/** Validates a set of overrides. Unknown keys and out-of-range values are refused, not clamped. */
export function validateOverrides(raw: unknown): SettingsResult<SafeguardOverrides> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Settings must be an object.' };
  }
  const out: SafeguardOverrides = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KEYS.includes(k as SafeguardKey)) return { ok: false, error: `Unknown setting "${k}".` };
    if (v === undefined || v === null) continue;
    const key = k as SafeguardKey;
    if (!inRange(key, v)) {
      const r = SAFEGUARD_RANGES[key];
      return {
        ok: false,
        error: `${SAFEGUARD_LABELS[key]} must be an integer from ${r.min} to ${r.max}.`,
      };
    }
    out[key] = v;
  }
  return { ok: true, value: out };
}

export function validateState(
  raw: unknown,
  aliases?: readonly string[],
): SettingsResult<SettingsState> {
  const s = (raw ?? {}) as Partial<SettingsState>;
  const g = validateOverrides(s.global ?? {});
  if (!g.ok) return g;
  const perInstance: Record<string, SafeguardOverrides> = {};
  if (typeof s.perInstance !== 'object' || s.perInstance === null) {
    if (s.perInstance !== undefined) return { ok: false, error: 'perInstance must be an object.' };
  } else {
    for (const [alias, o] of Object.entries(s.perInstance)) {
      if (aliases && !aliases.includes(alias))
        return { ok: false, error: `No registered instance "${alias}".` };
      const v = validateOverrides(o);
      if (!v.ok) return { ok: false, error: `${alias}: ${v.error}` };
      if (Object.keys(v.value).length > 0) perInstance[alias] = v.value;
    }
  }
  return { ok: true, value: { global: g.value, perInstance } };
}

/** default < global < per-instance. No environment input: same for DEV and PROD. */
export function effectiveSafeguards(state: SettingsState, alias: string | undefined): Safeguards {
  return { ...SAFEGUARD_DEFAULTS, ...state.global, ...(alias ? state.perInstance[alias] : {}) };
}

export class Settings {
  private cache?: SettingsState;

  constructor(private readonly storage: SettingsStorage) {}

  /** Stored state, re-validated on read (invalid parts are dropped). */
  async get(): Promise<SettingsState> {
    if (this.cache) return this.cache;
    const raw = (await this.storage.load()) as Partial<SettingsState> | undefined;
    const checked = validateState(raw ?? {});
    let state: SettingsState;
    if (checked.ok) state = checked.value;
    else {
      const g = validateOverrides(raw?.global ?? {});
      state = { global: g.ok ? g.value : {}, perInstance: {} };
    }
    this.cache = state;
    return state;
  }

  /** Popup only. Replaces the whole state after validation. */
  async set(raw: unknown, aliases: readonly string[]): Promise<SettingsResult<SettingsState>> {
    const checked = validateState(raw, aliases);
    if (!checked.ok) return checked;
    await this.storage.save(checked.value);
    this.cache = checked.value;
    return checked;
  }

  /** Drops a removed instance's overrides. */
  async forget(alias: string): Promise<void> {
    const s = await this.get();
    if (!(alias in s.perInstance)) return;
    const { [alias]: _gone, ...rest } = s.perInstance;
    await this.storage.save({ global: s.global, perInstance: rest });
    this.cache = { global: s.global, perInstance: rest };
  }

  /** Call when storage changed outside this object. */
  invalidate(): void {
    this.cache = undefined;
  }

  async forInstance(alias: string | undefined): Promise<Safeguards> {
    return effectiveSafeguards(await this.get(), alias);
  }
}

export function chromeSettingsStorage(): SettingsStorage {
  return {
    async load() {
      return (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
    },
    async save(state) {
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: state });
    },
  };
}
