// Type-only declarations for JSON imports — actual values are loaded
// lazily via require() below. This isolates the CommonJS require() to a
// single well-documented location so the rest of the codebase is ESM-clean.

/** Lazy version reader for the SDK and this app.
 *
 *  Why lazy + require(): the project's tsconfig sets `rootDir: ./src`,
 *  so `import pkg from '../../package.json'` would fail at compile time
 *  (file is outside rootDir). And `import sdkPkg from
 *  '@nemesis-oss/dhanhq-sdk/package.json'` requires `resolveJsonModule`
 *  (now enabled) but still triggers a TS7042 warning under some module
 *  resolution modes. Using `require()` here keeps the lookup lazy (no
 *  module-load cost at import time, only when /api/control/state is first
 *  called) and works in CommonJS without any config dance.
 *
 *  Cached after first call — `require()` itself caches, but the
 *  destructure + return is cheap to redo either way; caching is mostly
 *  to keep the function's return type stable for callers that memoize.
 */
let cached: { node: string; sdk: string; app: string } | null = null;

export function getRuntimeVersions(): { node: string; sdk: string; app: string } {
  if (cached) return cached;
  let sdkVersion = 'unknown';
  let appVersion = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdkVersion = require('@nemesis-oss/dhanhq-sdk/package.json').version;
  } catch { /* SDK package.json not resolvable — dev/stub environment */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    appVersion = require('../../package.json').version;
  } catch { /* repo package.json not resolvable — running from dist/ */ }
  cached = {
    node: process.version,
    sdk: sdkVersion,
    app: appVersion,
  };
  return cached;
}
