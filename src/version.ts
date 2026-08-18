import { createRequire } from "node:module";

/**
 * Name and version as published, read from the manifest rather than copied into
 * the source. Both go out in `clientInfo` on every `initialize`, so a server's
 * logs name the caller — and a duplicated literal would drift from the manifest
 * on the first release that forgot it.
 */
const manifest = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;

/** What this package announces itself as during the MCP handshake. */
export const CLIENT_INFO = { name: PACKAGE_NAME, version: PACKAGE_VERSION } as const;
