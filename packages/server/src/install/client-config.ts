/**
 * Exact STDIO registration values for clients the user registers by hand (ADR-014).
 *
 * The command is an absolute Node path because desktop apps don't get the shell's PATH. The label
 * in SN_MCP_CLIENT_NAME is only what the popup shows: identity is the per-process client key.
 */
import { realpathSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';
import { INSTRUCTIONS } from '../mcp/server.js';

export const SERVER_ENTRY = 'packages/server/dist/bin/mcp-server.js';
export const CHATGPT_DESKTOP_LABEL = 'ChatGPT Desktop';
export const MISTRAL_VIBE_LABEL = 'Mistral Vibe';

export interface StdioClientConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The engine's defaults are 10 s and 60 s; one paged read can take longer than a minute. */
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

/**
 * process.execPath is the resolved path, which on Homebrew names the version and breaks on the next
 * upgrade. Prefer the PATH entry that leads to the same Node.
 */
export function stableNodePath(
  execPath: string = process.execPath,
  pathVar: string = process.env.PATH ?? '',
): string {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      if (realpathSync(candidate) === realpathSync(execPath)) return candidate;
    } catch {
      // not in this folder
    }
  }
  return execPath;
}

function stdioConfig(
  label: string,
  repoRoot: string,
  nodePath: string,
  platform: NodeJS.Platform,
): StdioClientConfig {
  const path = platform === 'win32' ? win32 : posix;
  return {
    name: 'sn-mcp',
    command: nodePath,
    args: [path.join(repoRoot, ...SERVER_ENTRY.split('/'))],
    env: { SN_MCP_CLIENT_NAME: label },
    cwd: repoRoot,
    startupTimeoutSec: 30,
    toolTimeoutSec: 360,
  };
}

export function chatGptDesktopConfig(
  repoRoot: string,
  nodePath: string = stableNodePath(),
  platform: NodeJS.Platform = process.platform,
): StdioClientConfig {
  return stdioConfig(CHATGPT_DESKTOP_LABEL, repoRoot, nodePath, platform);
}

export function mistralVibeConfig(
  repoRoot: string,
  nodePath: string = stableNodePath(),
  platform: NodeJS.Platform = process.platform,
): StdioClientConfig {
  return stdioConfig(MISTRAL_VIBE_LABEL, repoRoot, nodePath, platform);
}

/** The values, in the order of the fields in ChatGPT Desktop's "add MCP server" form. */
export function renderStdioForm(c: StdioClientConfig): string {
  return [
    `Name:                  ${c.name}`,
    'Type:                  STDIO',
    `Command:               ${c.command}`,
    `Arguments:             ${c.args.join(' ')}`,
    ...Object.entries(c.env).map(([k, v]) => `Environment variable:  ${k} = ${v}`),
    `Working directory:     ${c.cwd}`,
  ].join('\n');
}

/** The same registration as a `config.toml` block. JSON strings are valid TOML basic strings. */
export function renderConfigToml(c: StdioClientConfig): string {
  const q = JSON.stringify;
  return [
    `[mcp_servers.${c.name}]`,
    `command = ${q(c.command)}`,
    `args = [${c.args.map((a) => q(a)).join(', ')}]`,
    `cwd = ${q(c.cwd)}`,
    `startup_timeout_sec = ${c.startupTimeoutSec}`,
    `tool_timeout_sec = ${c.toolTimeoutSec}`,
    '',
    `[mcp_servers.${c.name}.env]`,
    ...Object.entries(c.env).map(([k, v]) => `${k} = ${q(v)}`),
    '',
  ].join('\n');
}

/**
 * The block for `~/.vibe/config.toml` (ADR-016).
 *
 * Vibe doesn't pass the server's `instructions` to its model, so `prompt` carries them: it reaches
 * the model as connector guidance when the model searches for tools. `vibe mcp add` can't set it.
 * `command` is an array because Vibe splits a string on spaces.
 */
export function renderVibeConfigToml(c: StdioClientConfig): string {
  const q = JSON.stringify;
  return [
    '[[mcp_servers]]',
    `name = ${q(c.name)}`,
    'transport = "stdio"',
    `command = [${q(c.command)}]`,
    `args = [${c.args.map((a) => q(a)).join(', ')}]`,
    `cwd = ${q(c.cwd)}`,
    `startup_timeout_sec = ${c.startupTimeoutSec}`,
    `tool_timeout_sec = ${c.toolTimeoutSec}`,
    `prompt = ${q(INSTRUCTIONS)}`,
    '',
    '[mcp_servers.env]',
    ...Object.entries(c.env).map(([k, v]) => `${k} = ${q(v)}`),
    '',
  ].join('\n');
}
