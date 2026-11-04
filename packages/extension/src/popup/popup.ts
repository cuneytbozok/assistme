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
void renderAccess();
setInterval(() => void renderAccess(), 2000);

// --- access requests and grants (served by the service worker) ---------------------------

interface PopupState {
  ok: boolean;
  bridge: { state: string; reason?: string; retryInMs?: number };
  pending: {
    requestId: string;
    approvalCode: string;
    clientLabel: { name: string; pid: number; cwd?: string };
    instances: string[];
    purpose: string;
    expiresAt: number;
  }[];
  grants: {
    grantId: string;
    clientLabel: { name: string; pid: number };
    instances: string[];
    expiresAt: number;
  }[];
}

function ask(message: unknown): Promise<{ ok: boolean; message?: string } & Partial<PopupState>> {
  return chrome.runtime.sendMessage(message);
}

function bridgeText(b: PopupState['bridge']): [string, 'ok' | 'bad' | ''] {
  switch (b.state) {
    case 'connected':
      return ['Bridge: connected to the local broker', 'ok'];
    case 'conflict':
      return ['Bridge: another Chrome profile is using the broker', 'bad'];
    case 'connecting':
      return ['Bridge: connecting…', ''];
    default:
      return [
        /not found/i.test(b.reason ?? '')
          ? 'Bridge: native host not installed (npm run install-native-host)'
          : `Bridge: disconnected — retrying in ${Math.round((b.retryInMs ?? 0) / 1000)} s`,
        'bad',
      ];
  }
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function renderAccess(): Promise<void> {
  let state: Awaited<ReturnType<typeof ask>>;
  try {
    state = await ask({ type: 'popup.state' });
  } catch {
    return;
  }
  if (!state?.ok || !state.bridge) return;
  const [text, cls] = bridgeText(state.bridge);
  const b = el('bridge');
  b.textContent = text;
  b.className = cls || 'muted';

  const reqList = el<HTMLUListElement>('requests');
  const focused = document.activeElement?.closest?.('li')?.dataset.requestId;
  const pending = state.pending ?? [];
  el('requests-section').hidden = pending.length === 0;
  // Do not re-render while the user is typing a confirmation into a request.
  if (!focused) {
    reqList.replaceChildren();
    for (const r of pending) reqList.append(renderRequest(r));
  }

  const grantList = el<HTMLUListElement>('grants');
  grantList.replaceChildren();
  const grants = state.grants ?? [];
  el('grants-section').hidden = grants.length === 0;
  for (const g of grants) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const t = document.createElement('div');
    t.textContent = `${g.instances.join(', ')} — ${g.clientLabel.name} (pid ${g.clientLabel.pid})`;
    const exp = document.createElement('div');
    exp.className = 'host';
    exp.textContent = `until ${new Date(g.expiresAt).toLocaleTimeString()}`;
    info.append(t, exp);
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'secondary';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', () => {
      void ask({ type: 'popup.revoke', grantId: g.grantId }).then(() => renderAccess());
    });
    li.append(info, revoke);
    grantList.append(li);
  }
}

function renderRequest(r: PopupState['pending'][number]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'req';
  li.dataset.requestId = r.requestId;
  const instanceEntries = r.instances.map((a) => entries.find((e) => e.alias === a));
  const isProd = instanceEntries.some((e) => !e || effectiveEnv(e.env) === 'prod');

  const code = document.createElement('div');
  code.className = 'code';
  code.textContent = formatCode(r.approvalCode);
  const who = document.createElement('div');
  who.textContent = `${r.clientLabel.name} (pid ${r.clientLabel.pid}) wants read access to ${instanceEntries
    .map((e, i) => (e ? `${e.alias} [${e.env.toUpperCase()}] ${e.host}` : r.instances[i]))
    .join(', ')}`;
  const purpose = document.createElement('div');
  purpose.className = 'purpose';
  purpose.textContent = `Purpose (from Claude, unverified): ${r.purpose.slice(0, 200)}`;

  const actions = document.createElement('div');
  actions.className = 'actions';
  let typed: HTMLInputElement | undefined;
  if (isProd) {
    typed = document.createElement('input');
    typed.type = 'text';
    typed.placeholder = `Type ${instanceEntries[0]?.host ?? 'the host'} to approve`;
    actions.append(typed);
  }
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => {
    void ask({ type: 'popup.approve', requestId: r.requestId, typedHost: typed?.value }).then(
      (res) => {
        if (!res?.ok) setMessage(res?.message ?? 'Approval failed.', 'error');
        else setMessage('Approved. Claude can now claim this access.', 'ok');
        (document.activeElement as HTMLElement | null)?.blur();
        void renderAccess();
      },
    );
  });
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'secondary';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => {
    void ask({ type: 'popup.deny', requestId: r.requestId }).then(() => renderAccess());
  });
  actions.append(approve, deny);
  li.append(code, who, purpose, actions);
  return li;
}
