import { createRequire } from 'node:module';

/** Single source of truth: the version npm publishes, read at runtime from package.json. */
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION = version;
