import { McpClient } from "./client.js";
import { StdioMcpClient } from "./stdio-client.js";
import { readServerConfigs } from "./config.js";
import { listCredentials, isExpired, expiresAtMs } from "./credentials.js";
import type { McpSession } from "./session.js";

/**
 * Open a live session for a server by name, picking the transport for it:
 *   - **stdio** config  → spawn the subprocess.
 *   - **http/sse with headers** (API key) → HTTP with those headers.
 *   - **http/sse without headers, or not in config** → HTTP with the OAuth
 *     token Claude Code stored in the Keychain.
 *
 * So one call reaches every kind of server Claude Code can, regardless of how
 * it authenticates.
 */
export async function openSession(name: string, opts: { cwd?: string } = {}): Promise<McpSession> {
  const cfg = readServerConfigs(opts.cwd).get(name);
  if (cfg) {
    if (cfg.transport === "stdio") return StdioMcpClient.fromConfig(cfg);
    if (Object.keys(cfg.headers).length > 0) return McpClient.fromUrlWithHeaders(cfg.url, cfg.headers);
    // http/sse with no headers → OAuth; fall through to the Keychain.
  }
  return McpClient.fromClaudeCode(name);
}

export type AuthKind = "oauth" | "header" | "env" | "none";

export interface DiscoveredServer {
  name: string;
  transport: "http" | "sse" | "stdio";
  auth: AuthKind;
  /** URL for HTTP, launch command for stdio. */
  detail: string;
  /** For OAuth servers whose token is in the Keychain. */
  tokenState?: "live" | "expired" | "missing";
  source: string;
}

/**
 * Every server Claude Code can reach, merged from the config files and the
 * Keychain, so `claude-mcp servers` shows the full picture regardless of how
 * each one authenticates.
 */
export async function listServers(cwd?: string): Promise<DiscoveredServer[]> {
  const configs = readServerConfigs(cwd);
  const creds = await listCredentials().catch(() => []);
  const credByName = new Map(creds.map((c) => [c.serverName, c]));
  const out = new Map<string, DiscoveredServer>();

  for (const cfg of configs.values()) {
    if (cfg.transport === "stdio") {
      out.set(cfg.name, {
        name: cfg.name,
        transport: "stdio",
        auth: Object.keys(cfg.env).length > 0 ? "env" : "none",
        detail: [cfg.command, ...cfg.args].join(" "),
        source: cfg.source,
      });
    } else if (Object.keys(cfg.headers).length > 0) {
      out.set(cfg.name, {
        name: cfg.name,
        transport: cfg.transport,
        auth: "header",
        detail: cfg.url,
        source: cfg.source,
      });
    } else {
      const cred = credByName.get(cfg.name);
      out.set(cfg.name, {
        name: cfg.name,
        transport: cfg.transport,
        auth: "oauth",
        detail: cfg.url,
        tokenState: !cred ? "missing" : isExpired(cred) ? "expired" : "live",
        source: cfg.source,
      });
    }
  }

  // Keychain servers that never appeared in the config files.
  for (const cred of creds) {
    if (out.has(cred.serverName)) continue;
    out.set(cred.serverName, {
      name: cred.serverName,
      transport: "http",
      auth: "oauth",
      detail: cred.serverUrl,
      tokenState: isExpired(cred) ? "expired" : "live",
      source: "Keychain",
    });
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** ISO expiry for an OAuth server's Keychain token, or undefined. */
export async function tokenExpiry(name: string): Promise<string | undefined> {
  const cred = (await listCredentials().catch(() => [])).find((c) => c.serverName === name);
  const ms = cred && expiresAtMs(cred);
  return ms ? new Date(ms).toISOString() : undefined;
}
