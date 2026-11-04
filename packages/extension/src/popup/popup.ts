/**
 * Popup: instance registry (T-004, T-010) and access approvals (T-007).
 *
 * Registering an instance requests host permission for that exact origin only
 * (`https://<host>/*`). `chrome.permissions.request` must run inside the click's user gesture,
 * so all validation before it is synchronous against the registry loaded when the popup opened.
 * The entry itself is then saved by the service worker, which also invalidates grants on edits
 * and removals. A tab suggestion (activeTab: only the tab the popup was opened on) only fills
 * in the form; it never registers anything. All rendering uses textContent.
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
  suggestionFromTabUrl,
  validateNewEntry,
} from '../background/registry.js';

const registry = new Registry(chromeRegistryStorage());
let entries: InstanceEntry[] = [];
const ENV_OPTIONS: [InstanceEntry['env'], string][] = [
  ['unclassified', 'Unclassified (treated as PROD)'],
  ['dev', 'DEV'],
  ['test', 'TEST'],
  ['prod', 'PROD'],
];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  return node;
}

function button(text: string, onClick: () => void, secondary = false): HTMLButtonElement {
  const b = make('button', { text, className: secondary ? 'secondary' : '' });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function setMessage(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const m = el<HTMLParagraphElement>('message');
  m.textContent = text;
  m.className = kind;
}

function ask(message: unknown): Promise<
  { ok: boolean; message?: string } & Partial<PopupState> & {
      invalidated?: number;
      permissionRemoved?: boolean;
    }
> {
  return chrome.runtime.sendMessage(message);
}

async function render(): Promise<void> {
  entries = await registry.list();
  const list = el<HTMLUListElement>('instances');
  list.replaceChildren();
  el('empty').hidden = entries.length > 0;
  for (const entry of entries) {
    const li = make('li');
    li.dataset.alias = entry.alias;
    const badge = make('span', {
      className: `env ${effectiveEnv(entry.env)}`,
      text: entry.env === 'unclassified' ? 'UNCLASSIFIED' : entry.env.toUpperCase(),
    });
    const info = make('div', { className: 'info' });
    info.append(
      make('div', { text: entry.label ? `${entry.alias} — ${entry.label}` : entry.alias }),
      make('div', { className: 'host', text: entry.host }),
    );
    const granted = await chrome.permissions.contains({ origins: [originPattern(entry.host)] });
    if (!granted) {
      info.append(
        make('div', {
          className: 'perm-missing',
          text: 'Host permission missing — remove and register again.',
        }),
      );
    }
    const actions = make('div', { className: 'row-actions' });
    actions.append(
      button('Edit', () => showEdit(li, info, entry), true),
      button('Remove', () => showRemove(li, info, entry), true),
    );
    li.append(badge, info, actions);
    list.append(li);
  }
  await renderSuggestion();
}

function closePanels(li: HTMLElement): void {
  for (const p of li.querySelectorAll('.panel')) p.remove();
}

function showEdit(li: HTMLElement, info: HTMLElement, entry: InstanceEntry): void {
  closePanels(li);
  const panel = make('div', { className: 'panel' });
  const label = make('input');
  label.type = 'text';
  label.maxLength = 80;
  label.value = entry.label;
  label.placeholder = 'Label';
  const env = make('select');
  for (const [value, text] of ENV_OPTIONS) {
    const o = make('option', { text });
    o.value = value;
    o.selected = value === entry.env;
    env.append(o);
  }
  const note = make('div', {
    className: 'muted',
    text: 'Changing the environment ends any active access to this instance.',
  });
  panel.append(
    label,
    env,
    note,
    button('Save', () => {
      void ask({
        type: 'popup.registry.edit',
        alias: entry.alias,
        label: label.value,
        env: env.value,
      }).then(async (r) => {
        if (!r?.ok) return setMessage(r?.message ?? 'Edit failed.', 'error');
        const ended = r.invalidated ? ` Ended ${r.invalidated} active access item(s).` : '';
        setMessage(`Updated ${entry.alias}.${ended}`, 'ok');
        await render();
        void renderAccess();
      });
    }),
    button('Cancel', () => panel.remove(), true),
  );
  info.append(panel);
}

function showRemove(li: HTMLElement, info: HTMLElement, entry: InstanceEntry): void {
  closePanels(li);
  const panel = make('div', { className: 'panel' });
  const box = make('input');
  box.type = 'checkbox';
  box.checked = true;
  const lbl = make('label', { className: 'check' });
  lbl.append(box, document.createTextNode(` Also remove Chrome's access to ${entry.host}`));
  panel.append(
    make('div', { text: `Remove ${entry.alias}? Any active access to it ends now.` }),
    lbl,
    button('Confirm remove', () => {
      void ask({
        type: 'popup.registry.remove',
        alias: entry.alias,
        removeHostPermission: box.checked,
      }).then(async (r) => {
        if (!r?.ok) return setMessage(r?.message ?? 'Remove failed.', 'error');
        const parts = [`Removed ${entry.alias}.`];
        if (r.invalidated) parts.push(`Ended ${r.invalidated} active access item(s).`);
        if (r.permissionRemoved) parts.push(`Revoked access to ${entry.host}.`);
        setMessage(parts.join(' '), 'ok');
        await render();
        void renderAccess();
      });
    }),
    button('Cancel', () => panel.remove(), true),
  );
  info.append(panel);
}

/** activeTab: Chrome exposes only the URL of the tab the popup was opened on. */
async function renderSuggestion(): Promise<void> {
  const box = el('suggestion');
  box.replaceChildren();
  box.hidden = true;
  let url: string | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab?.url;
  } catch {
    return;
  }
  const host = suggestionFromTabUrl(url, entries);
  if (!host) return;
  box.append(
    make('span', { text: `This tab looks like a ServiceNow instance: ${host}` }),
    button(
      'Use it',
      () => {
        el<HTMLInputElement>('url').value = host;
        el<HTMLInputElement>('alias').focus();
        setMessage('Filled in from the current tab. Choose an alias and environment.', '');
      },
      true,
    ),
  );
  box.hidden = false;
}

function onSubmit(event: SubmitEvent): void {
  event.preventDefault();
  const host = parseInstanceHost(el<HTMLInputElement>('url').value);
  if (!host.ok) {
    setMessage(host.error, 'error');
    return;
  }
  const input = {
    alias: el<HTMLInputElement>('alias').value,
    host: host.value,
    label: el<HTMLInputElement>('label').value,
    env: el<HTMLSelectElement>('env').value,
  };
  const checked = validateNewEntry(entries, input);
  if (!checked.ok) {
    setMessage(checked.error, 'error');
    return;
  }
  const entry = checked.value;
  // First async call — still inside the user gesture. Exactly one origin is requested.
  chrome.permissions.request({ origins: [originPattern(entry.host)] }).then(
    async (granted) => {
      if (!granted) return setMessage(`Access to ${entry.host} was not granted.`, 'error');
      const saved = await ask({ type: 'popup.registry.add', entry: input });
      if (!saved?.ok) return setMessage(saved?.message ?? 'Registration failed.', 'error');
      el<HTMLFormElement>('register').reset();
      const hint = looksLikeServiceNow(entry.host)
        ? ''
        : ' (custom domain — check it is your ServiceNow instance)';
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
