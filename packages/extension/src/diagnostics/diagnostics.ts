/** DEV_DIAGNOSTICS page for the T-005 session spike. Renders results as text only. */
import '../csp.js';
import { chromeRegistryStorage, Registry } from '../background/registry.js';

const registry = new Registry(chromeRegistryStorage());
const runs: unknown[] = [];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function show(): void {
  el('out').textContent = runs.length === 0 ? 'No results yet.' : JSON.stringify(runs, null, 2);
}

async function run(kind: 'full' | 'expiry', label: string): Promise<void> {
  const alias = el<HTMLSelectElement>('instance').value;
  const userName = el<HTMLInputElement>('user').value.trim();
  el('status').textContent = `${label}: running…`;
  let response: { ok: boolean; report?: unknown; error?: string };
  try {
    response = ((await chrome.runtime.sendMessage({
      type: 'diagnostics.run',
      alias,
      kind,
      userName,
    })) as typeof response | undefined) ?? {
      ok: false,
      error: 'No response from the background script. Reload the extension on chrome://extensions.',
    };
  } catch (e) {
    response = {
      ok: false,
      error: `${String(e)} — reload the extension on chrome://extensions, then reload this page.`,
    };
  }
  runs.push({ label, ...(response.ok ? { report: response.report } : { error: response.error }) });
  el('status').textContent = `${label}: ${response.ok ? 'done' : `failed — ${response.error}`}`;
  show();
}

async function init(): Promise<void> {
  const select = el<HTMLSelectElement>('instance');
  for (const e of await registry.list()) {
    const o = document.createElement('option');
    o.value = e.alias;
    o.textContent = `${e.alias} (${e.env}) — ${e.host}`;
    select.append(o);
  }
  el('run-full').addEventListener('click', () => void run('full', 'run 1 (logged in)'));
  el('run-full-2').addEventListener('click', () => void run('full', 'run 2 (after re-login)'));
  el('run-expiry').addEventListener('click', () => void run('expiry', 'run 3 (logged out)'));
  el('copy').addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(runs, null, 2)).then(() => {
      el('status').textContent = 'Results copied to the clipboard.';
    });
  });
}

void init();
