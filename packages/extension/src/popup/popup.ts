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
import { ALIAS_RE, GRANT_TTL_MINUTES, SAFEGUARD_DEFAULTS, SAFEGUARD_RANGES } from '@sn-mcp/shared';
import { type PolicyEnv, policyEnv, TTL_CHOICES } from '../background/grants.js';
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
import { type ConnectionState, describeState } from '../background/session.js';
import {
  SAFEGUARD_LABELS,
  type SafeguardKey,
  type SafeguardOverrides,
  type SettingsState,
} from '../background/settings.js';

type Env = InstanceEntry['env'];

const registry = new Registry(chromeRegistryStorage());
let entries: InstanceEntry[] = [];
let connections: Record<string, ConnectionState> = {};

function statusLine(state: ConnectionState, host: string): HTMLDivElement {
  const line = make('div', { className: `status ${state}` });
  line.append(make('span', { className: 'dot' }), describeState(state, host));
  return line;
}

/** Updates status lines in place (the instance list is not rebuilt on every refresh). */
function applyConnections(next: Record<string, ConnectionState>): void {
  connections = next;
  for (const li of document.querySelectorAll<HTMLLIElement>('#instances li[data-alias]')) {
    const alias = li.dataset.alias ?? '';
    const entry = entries.find((e) => e.alias === alias);
    const old = li.querySelector('.status');
    if (!entry || !old) continue;
    const state = next[alias] ?? 'unknown';
    if (!old.classList.contains(state)) old.replaceWith(statusLine(state, entry.host));
  }
}
const ENV_OPTIONS: [Env, string][] = [
  ['dev', 'DEV'],
  ['test', 'TEST'],
  ['prod', 'PROD'],
  ['unclassified', 'Other'],
];

// --- small DOM helpers ------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  node.append(...children);
  return node;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = make('button', { text, className });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const ICONS = {
  edit: 'M11.5 2.5l2 2L6 12H4v-2l7.5-7.5z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5',
};

function iconButton(
  icon: keyof typeof ICONS,
  title: string,
  onClick: () => void,
  extra = '',
): HTMLButtonElement {
  const b = make('button', { className: `icon ${extra}`, title });
  b.type = 'button';
  b.setAttribute('aria-label', title);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[icon]);
  svg.append(path);
  b.append(svg);
  b.addEventListener('click', onClick);
  return b;
}

function envBadge(env: Env, envName?: string): HTMLSpanElement {
  const text = env === 'unclassified' ? (envName ?? 'Other').toUpperCase() : env.toUpperCase();
  return make('span', {
    className: `env ${effectiveEnv(env)}`,
    text,
    title:
      env === 'unclassified'
        ? `${envName ?? 'Other'} — other environment, PROD rules apply`
        : `${text} instance`,
  });
}

/** Name field for the "Other" environment; hidden unless Other is selected. */
function envNameInput(initial = ''): HTMLLabelElement {
  const input = make('input');
  input.type = 'text';
  input.maxLength = 16;
  input.placeholder = 'e.g. UAT, SIT, Staging';
  input.value = initial;
  input.className = 'env-name';
  return make(
    'label',
    { className: 'field env-name-field' },
    make('span', { text: 'Environment name' }),
    input,
  );
}

/** Segmented env picker; `container.dataset.value` holds the selection. */
function segmented(container: HTMLElement, value: Env | '', onChange?: (v: Env) => void): void {
  container.replaceChildren();
  container.dataset.value = value;
  container.setAttribute('role', 'group');
  for (const [v, text] of ENV_OPTIONS) {
    const b = make('button', { text });
    b.type = 'button';
    b.setAttribute('aria-pressed', String(v === value));
    b.addEventListener('click', () => {
      container.dataset.value = v;
      for (const other of container.querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      onChange?.(v);
    });
    container.append(b);
  }
}

function envHint(env: Env): string {
  const ttl = GRANT_TTL_MINUTES[env].default;
  if (env === 'unclassified') {
    return `Other environments get PROD rules: you type the host to approve, and access lasts ${ttl} min.`;
  }
  if (effectiveEnv(env) === 'prod') {
    return `PROD rules: you type the host to approve, and access lasts ${ttl} min.`;
  }
  return `Each approval lasts up to ${ttl / 60} h.`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function setMessage(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const m = el<HTMLDivElement>('message');
  m.textContent = text;
  m.className = `toast ${kind}`;
  m.hidden = text === '';
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => (m.hidden = true), kind === 'error' ? 7000 : 4000);
}

function ask(message: unknown): Promise<
  { ok: boolean; message?: string } & Partial<PopupState> & {
      invalidated?: number;
      permissionRemoved?: boolean;
    }
> {
  return chrome.runtime.sendMessage(message);
}

function remaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// --- instances --------------------------------------------------------------------------

async function render(): Promise<void> {
  entries = await registry.list();
  const list = el<HTMLUListElement>('instances');
  list.replaceChildren();
  el('empty').hidden = entries.length > 0 || isFormOpen();
  for (const entry of entries) list.append(await renderInstance(entry));
  await renderSuggestion();
}

async function renderInstance(entry: InstanceEntry): Promise<HTMLLIElement> {
  const li = make('li', { className: 'inst' });
  li.dataset.alias = entry.alias;
  const main = make(
    'div',
    { className: 'inst-main' },
    make(
      'div',
      { className: 'inst-title' },
      make('span', { text: entry.alias }),
      ...(entry.label ? [make('span', { className: 'label', text: entry.label })] : []),
    ),
    make('div', { className: 'inst-host mono', text: entry.host, title: entry.host }),
  );
  const granted = await chrome.permissions.contains({ origins: [originPattern(entry.host)] });
  const state: ConnectionState = granted
    ? (connections[entry.alias] ?? 'unknown')
    : 'no_permission';
  main.append(statusLine(state, entry.host));
  const actions = make(
    'div',
    { className: 'inst-actions' },
    iconButton('edit', `Edit ${entry.alias}`, () => showEdit(li, entry)),
    iconButton('trash', `Remove ${entry.alias}`, () => showRemove(li, entry), 'danger-hover'),
  );
  li.append(
    make('div', { className: 'inst-row' }, envBadge(entry.env, entry.envName), main, actions),
  );
  return li;
}

function closePanels(li: HTMLElement): void {
  for (const p of li.querySelectorAll('.panel')) p.remove();
}

function showEdit(li: HTMLElement, entry: InstanceEntry): void {
  const wasOpen = li.querySelector('.panel.edit');
  closePanels(li);
  if (wasOpen) return;
  const label = make('input');
  label.type = 'text';
  label.maxLength = 80;
  label.value = entry.label;
  label.placeholder = 'e.g. My PDI';
  const env = make('div', { className: 'segmented' });
  const warn = make('div', { className: 'warn', text: '' });
  const hint = make('small', { className: 'hint', text: envHint(entry.env) });
  const nameField = envNameInput(entry.envName ?? '');
  const nameInput = nameField.querySelector('input') as HTMLInputElement;
  nameField.hidden = entry.env !== 'unclassified';
  segmented(env, entry.env, (v) => {
    hint.textContent = envHint(v);
    nameField.hidden = v !== 'unclassified';
    if (v === 'unclassified') nameInput.focus();
    warn.textContent = v !== entry.env ? 'Saving a new environment ends active access to it.' : '';
  });
  const save = (): void => {
    void ask({
      type: 'popup.registry.edit',
      alias: entry.alias,
      label: label.value,
      env: env.dataset.value,
      envName: env.dataset.value === 'unclassified' ? nameInput.value : '',
    }).then(async (r) => {
      if (!r?.ok) return setMessage(r?.message ?? 'Could not save.', 'error');
      const ended = r.invalidated ? ' Active access to it was ended.' : '';
      setMessage(`Saved ${entry.alias}.${ended}`, 'ok');
      await render();
      void renderAccess();
    });
  };
  for (const input of [label, nameInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') closePanels(li);
    });
  }
  const panel = make(
    'div',
    { className: 'panel edit' },
    make('label', { className: 'field' }, make('span', { text: 'Label' }), label),
    make('div', { className: 'field' }, make('span', { text: 'Environment' }), env, hint),
    nameField,
    warn,
    make(
      'div',
      { className: 'buttons' },
      button('Cancel', 'ghost small', () => closePanels(li)),
      button('Save', 'primary small', save),
    ),
  );
  li.append(panel);
  label.focus();
}

function showRemove(li: HTMLElement, entry: InstanceEntry): void {
  const wasOpen = li.querySelector('.panel.remove');
  closePanels(li);
  if (wasOpen) return;
  const box = make('input');
  box.type = 'checkbox';
  box.checked = true;
  const panel = make(
    'div',
    { className: 'panel remove danger-zone' },
    make(
      'div',
      {},
      make('strong', { text: `Remove ${entry.alias}?` }),
      ' Any active access to it ends now.',
    ),
    make('label', { className: 'check' }, box, `Also remove Chrome's access to ${entry.host}`),
    make(
      'div',
      { className: 'buttons' },
      button('Cancel', 'ghost small', () => closePanels(li)),
      button('Remove', 'danger small', () => {
        void ask({
          type: 'popup.registry.remove',
          alias: entry.alias,
          removeHostPermission: box.checked,
        }).then(async (r) => {
          if (!r?.ok) return setMessage(r?.message ?? 'Could not remove.', 'error');
          const parts = [`Removed ${entry.alias}.`];
          if (r.invalidated) parts.push('Active access ended.');
          if (r.permissionRemoved) parts.push(`Chrome no longer has access to ${entry.host}.`);
          setMessage(parts.join(' '), 'ok');
          await render();
          void renderAccess();
        });
      }),
    ),
  );
  li.append(panel);
}

// --- add form ---------------------------------------------------------------------------

function isFormOpen(): boolean {
  return !el('register').hidden;
}

function setFormOpen(open: boolean): void {
  el('register').hidden = !open;
  el('add-toggle').textContent = open ? 'Close' : '+ Add';
  el('empty').hidden = open || entries.length > 0;
  if (open) el<HTMLInputElement>('url').focus();
}

function resetForm(): void {
  el<HTMLFormElement>('register').reset();
  const env = el('env');
  segmented(env, '', (v) => {
    el('env-hint').textContent = envHint(v);
    el('env-name-field').hidden = v !== 'unclassified';
    if (v === 'unclassified') el<HTMLInputElement>('env-name').focus();
  });
  el('env-hint').textContent = 'Pick one. PROD and Other get the strictest approval rules.';
  el('env-name-field').hidden = true;
}

/** Alias proposal from the host's first label, only if it is valid and unused. */
function proposeAlias(host: string): string {
  const first = host.split('.')[0] ?? '';
  return ALIAS_RE.test(first) && !entries.some((e) => e.alias === first) ? first : '';
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
    make(
      'div',
      { className: 'text' },
      make('div', { text: 'This tab looks like a ServiceNow instance' }),
      make('span', { className: 'mono', text: host }),
    ),
    button('Add it', 'primary small', () => {
      setFormOpen(true);
      el<HTMLInputElement>('url').value = host;
      const alias = el<HTMLInputElement>('alias');
      if (!alias.value) alias.value = proposeAlias(host);
      alias.focus();
      alias.select();
      box.hidden = true;
    }),
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
    env: el('env').dataset.value ?? '',
    envName:
      el('env').dataset.value === 'unclassified' ? el<HTMLInputElement>('env-name').value : '',
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
      if (!granted) return setMessage(`Chrome access to ${entry.host} was not allowed.`, 'error');
      const saved = await ask({ type: 'popup.registry.add', entry: input });
      if (!saved?.ok) return setMessage(saved?.message ?? 'Could not add the instance.', 'error');
      resetForm();
      setFormOpen(false);
      const hint = looksLikeServiceNow(entry.host)
        ? ''
        : ' Custom domain — make sure it is your ServiceNow instance.';
      setMessage(`Added ${entry.alias}.${hint}`, 'ok');
      await render();
    },
    (err: unknown) => setMessage(`Permission request failed: ${String(err)}`, 'error'),
  );
}

el<HTMLFormElement>('register').addEventListener('submit', onSubmit);
el('add-toggle').addEventListener('click', () => setFormOpen(!isFormOpen()));
el('revoke-all').addEventListener('click', () => {
  void ask({ type: 'popup.revokeAll' }).then((r) => {
    setMessage(r?.ok ? 'Revoked all access.' : 'Could not revoke.', r?.ok ? 'ok' : 'error');
    void renderAccess();
  });
});
el('register-cancel').addEventListener('click', () => {
  resetForm();
  setFormOpen(false);
});
resetForm();
void render().then(() => {
  if (entries.length === 0) setFormOpen(true);
});
void renderAccess();
// The user opened the popup: check instances with an open tab once (one read-only request each).
void ask({ type: 'popup.checkStatus' }).then((r) => {
  if (r?.connections) applyConnections(r.connections);
});
setInterval(() => void renderAccess(), 2000);

// --- access requests and grants (served by the service worker) ---------------------------

interface PopupState {
  ok: boolean;
  bridge: { state: string; reason?: string; retryInMs?: number };
  connections?: Record<string, ConnectionState>;
  pending: {
    requestId: string;
    approvalCode: string;
    clientLabel: { name: string; pid: number; cwd?: string };
    instances: string[];
    mode: 'single' | 'compare';
    purpose: string;
    createdAt: number;
    expiresAt: number;
  }[];
  grants: {
    grantId: string;
    clientLabel: { name: string; pid: number };
    instances: string[];
    mode: 'single' | 'compare';
    env: PolicyEnv;
    purpose: string;
    approvedAt: number;
    expiresAt: number;
  }[];
}

/** Per-request UI state that must survive the 2 s refresh (chosen TTL, typed hosts). */
const draft = new Map<string, { ttl?: number; typed: Map<string, string> }>();

function ttlLabel(min: number): string {
  return min < 60 ? `${min} min` : `${min / 60} h`;
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function bridgeView(b: PopupState['bridge']): { pill: string; cls: string; detail?: string } {
  switch (b.state) {
    case 'connected':
      return { pill: 'Connected', cls: 'ok' };
    case 'conflict':
      return {
        pill: 'In use',
        cls: 'bad',
        detail: 'Another Chrome profile is using the connector. Use one profile at a time.',
      };
    case 'connecting':
      return { pill: 'Connecting', cls: '' };
    default:
      return /not found/i.test(b.reason ?? '')
        ? {
            pill: 'Not installed',
            cls: 'bad',
            detail: 'The local helper is not installed. Run: npm run install-native-host',
          }
        : {
            pill: 'Offline',
            cls: 'bad',
            detail: `Can't reach the local helper. Retrying in ${Math.max(1, Math.round((b.retryInMs ?? 0) / 1000))} s.`,
          };
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
  if (state.connections) applyConnections(state.connections);
  const view = bridgeView(state.bridge);
  el('bridge').className = `pill ${view.cls}`;
  el('bridge-text').textContent = view.pill;
  const detail = el('bridge-detail');
  detail.textContent = view.detail ?? '';
  detail.hidden = !view.detail;

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
  el('revoke-all').hidden = grants.length < 2;
  for (const g of grants) {
    const instEntries = g.instances.map((a) => entries.find((e) => e.alias === a));
    const li = make(
      'li',
      { className: `grant${g.env === 'prod' ? ' prod' : ''}` },
      make(
        'div',
        { className: 'badges' },
        ...instEntries.map((e) => (e ? envBadge(e.env, e.envName) : make('span'))),
      ),
      make(
        'div',
        { className: 'inst-main' },
        make(
          'div',
          { className: 'inst-title' },
          make('span', { text: g.instances.join(g.mode === 'compare' ? ' ⇄ ' : ', ') }),
          make('span', {
            className: 'label',
            text: `${remaining(g.expiresAt - Date.now())} left`,
          }),
        ),
        make('div', {
          className: 'grant-purpose',
          text: g.purpose.slice(0, 120),
          title: g.purpose.slice(0, 200),
        }),
        make('div', {
          className: 'sub',
          text: `${g.clientLabel.name} · approved ${clock(g.approvedAt)}`,
        }),
      ),
      button('Revoke', 'danger-text small', () => {
        void ask({ type: 'popup.revoke', grantId: g.grantId }).then(() => {
          setMessage(`Revoked access to ${g.instances.join(', ')}.`, 'ok');
          void renderAccess();
        });
      }),
    );
    grantList.append(li);
  }
  for (const id of draft.keys()) {
    if (!pending.some((r) => r.requestId === id)) draft.delete(id);
  }
}

function renderRequest(r: PopupState['pending'][number]): HTMLLIElement {
  const instanceEntries = r.instances.map((a) => entries.find((e) => e.alias === a));
  const known = instanceEntries.filter((e): e is InstanceEntry => e !== undefined);
  const policy = known.length === instanceEntries.length ? policyEnv(known) : 'prod';
  const isProd = policy === 'prod';
  const d = draft.get(r.requestId) ?? { typed: new Map<string, string>() };
  draft.set(r.requestId, d);
  const li = make('li', { className: `card req${isProd ? ' prod' : ''}` });
  li.dataset.requestId = r.requestId;

  const head = make(
    'div',
    { className: 'req-head' },
    make('div', { className: 'code', text: formatCode(r.approvalCode) }),
    make(
      'div',
      { className: 'req-meta' },
      make('div', { text: `${r.clientLabel.name} · ${clock(r.createdAt)}` }),
      make('div', { text: `expires in ${remaining(r.expiresAt - Date.now())}` }),
    ),
  );
  const targets = instanceEntries.map((e, i) =>
    e
      ? make(
          'div',
          { className: 'target' },
          envBadge(e.env, e.envName),
          make(
            'div',
            { className: 'inst-main' },
            make('div', { className: 'inst-title' }, make('span', { text: e.alias })),
            make('div', { className: 'inst-host mono', text: e.host }),
          ),
        )
      : make('div', { className: 'target', text: r.instances[i] ?? '' }),
  );
  const purpose = make(
    'div',
    { className: 'purpose' },
    make('small', { text: 'Reason given by Claude (unverified)' }),
    r.purpose.slice(0, 200),
  );

  const parts: Node[] = [
    head,
    make('div', {
      className: 'hint',
      text:
        r.mode === 'compare'
          ? 'wants to compare, read-only, these two instances:'
          : 'wants read-only access to',
    }),
    ...targets,
    purpose,
  ];

  // Duration (fixed at approval; there is no renewal).
  const choices = TTL_CHOICES[policy];
  const fallback = GRANT_TTL_MINUTES[policy].default;
  d.ttl ??= fallback;
  const ttlGroup = make('div', { className: 'segmented', title: 'How long access lasts' });
  ttlGroup.style.gridTemplateColumns = `repeat(${choices.length}, 1fr)`;
  for (const min of choices) {
    const b = make('button', { text: ttlLabel(min) });
    b.type = 'button';
    b.setAttribute('aria-pressed', String(min === d.ttl));
    b.addEventListener('click', () => {
      d.ttl = min;
      for (const o of ttlGroup.querySelectorAll('button')) {
        o.setAttribute('aria-pressed', String(o === b));
      }
    });
    ttlGroup.append(b);
  }
  parts.push(
    make(
      'div',
      { className: 'field' },
      make('span', { text: isProd ? 'Access lasts (no renewal)' : 'Access lasts' }),
      ttlGroup,
    ),
  );

  const typedInputs: HTMLInputElement[] = [];
  for (const e of known.filter((x) => effectiveEnv(x.env) === 'prod')) {
    const input = make('input');
    input.type = 'text';
    input.placeholder = e.host;
    input.value = d.typed.get(e.host) ?? '';
    input.addEventListener('input', () => d.typed.set(e.host, input.value));
    typedInputs.push(input);
    parts.push(
      make(
        'label',
        { className: 'field' },
        make('span', { text: `Strict rules: type ${e.alias}'s host to approve` }),
        input,
      ),
    );
  }
  const approve = (): void => {
    void ask({
      type: 'popup.approve',
      requestId: r.requestId,
      typedHosts: typedInputs.map((i) => i.value),
      ttlMinutes: d.ttl,
    }).then((res) => {
      if (!res?.ok) setMessage(res?.message ?? 'Approval failed.', 'error');
      else {
        draft.delete(r.requestId);
        setMessage(`Approved for ${ttlLabel(d.ttl ?? fallback)}. Claude can now use it.`, 'ok');
      }
      (document.activeElement as HTMLElement | null)?.blur();
      void renderAccess();
    });
  };
  for (const input of typedInputs) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') approve();
    });
  }
  parts.push(
    make(
      'div',
      { className: 'buttons' },
      button('Deny', 'ghost', () => {
        void ask({ type: 'popup.deny', requestId: r.requestId }).then(() => {
          setMessage('Request denied.', 'ok');
          void renderAccess();
        });
      }),
      button('Approve', 'primary', approve),
    ),
  );
  li.append(...parts);
  return li;
}

// --- settings (T-019) --------------------------------------------------------------------

/** Display units: seconds, MB, count. Stored values are ms, bytes, count. */
const UNITS: Record<SafeguardKey, { unit: string; short: string; factor: number }> = {
  requestTimeoutMs: { unit: 'seconds', short: 'Timeout (s)', factor: 1000 },
  maxResponseBytes: { unit: 'MB', short: 'Max response (MB)', factor: 1024 * 1024 },
  maxConcurrentPerInstance: { unit: 'requests', short: 'Parallel requests', factor: 1 },
};
const SETTING_KEYS = Object.keys(SAFEGUARD_DEFAULTS) as SafeguardKey[];
let settingsInputs: { alias?: string; key: SafeguardKey; input: HTMLInputElement }[] = [];

function settingsRow(
  key: SafeguardKey,
  value: number | undefined,
  fallback: number,
  alias?: string,
): Node[] {
  const { unit, factor, short } = UNITS[key];
  const r = SAFEGUARD_RANGES[key];
  const input = make('input');
  input.type = 'number';
  input.min = String(r.min / factor);
  input.max = String(r.max / factor);
  input.step = '1';
  input.placeholder = String(fallback / factor);
  input.value = value === undefined ? '' : String(value / factor);
  const range = `${SAFEGUARD_LABELS[key]}: ${r.min / factor}–${r.max / factor} ${unit}`;
  input.title = range;
  settingsInputs.push({ ...(alias ? { alias } : {}), key, input });
  return [make('label', { text: short, title: range }), input];
}

function renderSettings(state: SettingsState): void {
  settingsInputs = [];
  const global = el('settings-global');
  global.replaceChildren();
  for (const k of SETTING_KEYS) {
    global.append(...settingsRow(k, state.global[k], SAFEGUARD_DEFAULTS[k]));
  }
  const inst = el('settings-instances');
  inst.replaceChildren();
  if (entries.length > 0) {
    inst.append(
      make('div', { className: 'hint', text: 'Per-instance overrides (empty = global value):' }),
    );
  }
  for (const e of entries) {
    const grid = make('div', { className: 'settings-grid' });
    for (const k of SETTING_KEYS) {
      const fallback = state.global[k] ?? SAFEGUARD_DEFAULTS[k];
      grid.append(...settingsRow(k, state.perInstance[e.alias]?.[k], fallback, e.alias));
    }
    const count = Object.keys(state.perInstance[e.alias] ?? {}).length;
    const box = make('details', { className: 'override' });
    box.open = count > 0;
    const title = count > 0 ? `${e.alias} · ${count} override${count > 1 ? 's' : ''}` : e.alias;
    box.append(make('summary', { text: title }), grid);
    inst.append(box);
  }
}

function collectSettings(): SettingsState | string {
  const state: SettingsState = { global: {}, perInstance: {} };
  for (const { alias, key, input } of settingsInputs) {
    const raw = input.value.trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${SAFEGUARD_LABELS[key]}: not a number.`;
    const v = Math.round(n * UNITS[key].factor);
    let target: SafeguardOverrides = state.global;
    if (alias) {
      const existing = state.perInstance[alias] ?? {};
      state.perInstance[alias] = existing;
      target = existing;
    }
    target[key] = v;
  }
  return state;
}

async function loadSettings(): Promise<void> {
  const r = (await ask({ type: 'popup.settings.get' })) as {
    ok: boolean;
    settings?: SettingsState;
  };
  if (r?.ok && r.settings) renderSettings(r.settings);
}

el('settings').addEventListener('toggle', () => {
  if ((el('settings') as HTMLDetailsElement).open) void loadSettings();
});
el('settings-save').addEventListener('click', () => {
  const state = collectSettings();
  if (typeof state === 'string') return setMessage(state, 'error');
  void ask({ type: 'popup.settings.set', settings: state }).then((r) => {
    if (!r?.ok) return setMessage(r?.message ?? 'Could not save settings.', 'error');
    setMessage('Settings saved. They apply to the next request.', 'ok');
    void loadSettings();
  });
});
el('settings-reset').addEventListener('click', () => {
  void ask({ type: 'popup.settings.set', settings: { global: {}, perInstance: {} } }).then((r) => {
    if (r?.ok) {
      setMessage('Settings reset to defaults.', 'ok');
      void loadSettings();
    }
  });
});
