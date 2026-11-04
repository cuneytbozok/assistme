/**
 * Popup: minimal registry UI (T-004).
 *
 * Registering an instance requests host permission for that exact origin only
 * (`https://<host>/*`). `chrome.permissions.request` must run inside the click's user gesture,
 * so all validation before it is synchronous against the registry loaded when the popup opened.
 * All rendering uses textContent; nothing is parsed as HTML.
 */
import '../csp.js';
import {
  chromeRegistryStorage,
  effectiveEnv,
  type InstanceEntry,
  looksLikeServiceNow,
  originPattern,
  parseInstanceHost,
  Registry,
  validateNewEntry,
} from '../background/registry.js';

const registry = new Registry(chromeRegistryStorage());
let entries: InstanceEntry[] = [];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function setMessage(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const m = el<HTMLParagraphElement>('message');
  m.textContent = text;
  m.className = kind;
}

async function render(): Promise<void> {
  entries = await registry.list();
  const list = el<HTMLUListElement>('instances');
  list.replaceChildren();
  el('empty').hidden = entries.length > 0;
  for (const entry of entries) {
    const li = document.createElement('li');

    const badge = document.createElement('span');
    const env = effectiveEnv(entry.env);
    badge.className = `env ${env}`;
    badge.textContent = entry.env === 'unclassified' ? 'UNCLASSIFIED' : entry.env.toUpperCase();

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.textContent = entry.label ? `${entry.alias} — ${entry.label}` : entry.alias;
    const host = document.createElement('div');
    host.className = 'host';
    host.textContent = entry.host;
    info.append(title, host);

    const granted = await chrome.permissions.contains({ origins: [originPattern(entry.host)] });
    if (!granted) {
      const warn = document.createElement('div');
      warn.className = 'perm-missing';
      warn.textContent = 'Host permission missing — remove and register again.';
      info.append(warn);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => void removeEntry(entry));

    li.append(badge, info, remove);
    list.append(li);
  }
}

async function removeEntry(entry: InstanceEntry): Promise<void> {
  await registry.remove(entry.alias);
  await chrome.permissions.remove({ origins: [originPattern(entry.host)] });
  setMessage(`Removed ${entry.alias} and revoked access to ${entry.host}.`, 'ok');
  await render();
}

function onSubmit(event: SubmitEvent): void {
  event.preventDefault();
  const host = parseInstanceHost(el<HTMLInputElement>('url').value);
  if (!host.ok) {
    setMessage(host.error, 'error');
    return;
  }
  const checked = validateNewEntry(entries, {
    alias: el<HTMLInputElement>('alias').value,
    host: host.value,
    label: el<HTMLInputElement>('label').value,
    env: el<HTMLSelectElement>('env').value,
  });
  if (!checked.ok) {
    setMessage(checked.error, 'error');
    return;
  }
  const entry = checked.value;
  // First async call — still inside the user gesture. Exactly one origin is requested.
  chrome.permissions.request({ origins: [originPattern(entry.host)] }).then(
    async (granted) => {
      if (!granted) return setMessage(`Access to ${entry.host} was not granted.`, 'error');
      const saved = await registry.add(entry);
      if (!saved.ok) return setMessage(saved.error, 'error');
      el<HTMLFormElement>('register').reset();
      const hint = looksLikeServiceNow(entry.host)
        ? ''
        : ' (host does not look like *.service-now.com — check it is correct)';
      setMessage(`Registered ${entry.alias} → ${entry.host}${hint}.`, 'ok');
      await render();
    },
    (err: unknown) => setMessage(`Permission request failed: ${String(err)}`, 'error'),
  );
}

el<HTMLFormElement>('register').addEventListener('submit', onSubmit);
void render();
