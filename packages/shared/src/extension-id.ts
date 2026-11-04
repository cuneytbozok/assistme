/**
 * Stable Chrome extension ID, derived from the public `key` in packages/extension/manifest.json
 * (T-004). The native host accepts launches only from this origin, and the installer writes it as
 * the single `allowed_origins` entry. A test in the extension package keeps the two in sync.
 */
export const EXTENSION_ID = 'clipfeocpiljpcngmjpdbegciimchbol';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
/** Native-messaging host name (lowercase, dots; Chrome's naming rules). */
export const NATIVE_HOST_NAME = 'com.snmcp.bridge';
