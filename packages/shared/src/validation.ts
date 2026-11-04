import { z } from 'zod';
import { APPROVAL_CODE_ALPHABET, APPROVAL_CODE_LENGTH, MAX_DOT_WALK_DEPTH } from './limits.js';

/**
 * Identifier formats shared by protocol schemas and query validation.
 * T-003 extends this module with query value normalization.
 */

/** ServiceNow table name: lowercase, digits, underscore (covers u_ and x_<scope>_ tables). */
export const TABLE_NAME_RE = /^[a-z0-9_]{1,80}$/;
/** Field name with optional dot-walk (max 3 hops after the first segment). */
export const FIELD_PATH_RE = new RegExp(
  `^[a-z0-9_]{1,80}(\\.[a-z0-9_]{1,80}){0,${MAX_DOT_WALK_DEPTH}}$`,
);
export const SYS_ID_RE = /^[0-9a-f]{32}$/;
/** Instance alias chosen by the user in the extension. Matched exactly, never fuzzily. */
export const ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** User-chosen name for an "other" environment (e.g. UAT, SIT, Staging). Display only. */
export const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/;
/** Hostname only — no scheme, port, path or credentials. */
export const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 32 random bytes, base64url without padding. */
export const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
export const HEX256_RE = /^[0-9a-f]{64}$/;
/** 128-bit random, base64url (22 chars), prefixed. */
export const SCOPE_ID_RE = /^scp_[A-Za-z0-9_-]{22}$/;
export const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{22}$/;
export const APPROVAL_CODE_RE = new RegExp(
  `^[${APPROVAL_CODE_ALPHABET}]{${APPROVAL_CODE_LENGTH}}$`,
);
/** Rejects C0 control characters and DEL (used for free text shown to the user). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
export const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001f\u007f]*$/;

export const TableNameSchema = z.string().regex(TABLE_NAME_RE, 'invalid table name');
export const FieldPathSchema = z.string().regex(FIELD_PATH_RE, 'invalid field name');
export const SysIdSchema = z.string().regex(SYS_ID_RE, 'invalid sys_id');
export const AliasSchema = z.string().regex(ALIAS_RE, 'invalid instance alias');
export const EnvNameSchema = z.string().regex(ENV_NAME_RE, 'invalid environment name');
export const HostSchema = z.string().regex(HOST_RE, 'invalid host');
export const MessageIdSchema = z.string().regex(MESSAGE_ID_RE, 'invalid message id');
export const NonceSchema = z.string().regex(NONCE_RE, 'invalid nonce');
export const Hex256Schema = z.string().regex(HEX256_RE, 'invalid 256-bit hex value');
export const ScopeIdSchema = z.string().regex(SCOPE_ID_RE, 'invalid scope id');
export const RequestIdSchema = z.string().regex(REQUEST_ID_RE, 'invalid request id');
export const ApprovalCodeSchema = z.string().regex(APPROVAL_CODE_RE, 'invalid approval code');
