/**
 * Must be the first import of every extension entry point.
 *
 * MV3's CSP forbids eval. zod v4 otherwise probes `new Function("")` on first object parse; the
 * throw is caught, but Chrome still reports a CSP violation on chrome://extensions. `jitless`
 * skips the probe and the JIT entirely.
 */
import { config } from 'zod';

config({ jitless: true });
