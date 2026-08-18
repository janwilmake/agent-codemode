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
  name = await resolveName(name, opts);
  const cfg = readServerConfigs(opts.cwd).get(name);
  if (cfg) {
    if (cfg.transport === "stdio") return StdioMcpClient.fromConfig(cfg);
    if (Object.keys(cfg.headers).length > 0) return McpClient.fromUrlWithHeaders(cfg.url, cfg.headers);
    // http/sse with no headers → OAuth. Only Claude's tokens are readable today.
    if (cfg.client !== "claude") {
      throw new Error(
        `"${name}" is an OAuth server from ${cfg.client}. Inheriting ${cfg.client}'s OAuth tokens ` +
          `is not implemented yet — contributions welcome (see CONTRIBUTING.md). Its stdio and ` +
          `API-key servers already work.`,
      );
    }
  }
  return McpClient.fromClaudeCode(name);
}

/**
 * The short name for a server, for people who do not want to type
 * `plugin:slack:slack`. Strips the `plugin:` marker and collapses the repeated
 * segments plugin servers tend to have, so `plugin:slack:slack` → `slack`.
 */
export function shortName(name: string): string {
  const segments = name.replace(/^plugin:/, "").split(":").filter(Boolean);
  const deduped = segments.filter((s, i) => s.toLowerCase() !== segments[i - 1]?.toLowerCase());
  return deduped.join(":");
}

/**
 * Accept a short name wherever a full one is expected — `mcp.slack` for
 * `plugin:slack:slack`. An exact name always wins, so nothing that worked
 * before changes meaning. An ambiguous short name is an error rather than a
 * coin flip: silently talking to the wrong server is worse than not starting.
 */
export async function resolveName(name: string, opts: { cwd?: string } = {}): Promise<string> {
  const known = await listServers(opts.cwd).catch((): DiscoveredServer[] => []);
  if (known.some((s) => s.name === name)) return name;

  const matches = known.filter((s) => shortName(s.name) === name);
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1) {
    throw new Error(
      `"${name}" is ambiguous — it matches ${matches.map((m) => `"${m.name}"`).join(", ")}. Use the full name.`,
    );
  }
  // Unknown to discovery, but it may still be a valid Keychain entry; let the
  // transport produce the real error rather than guessing one here.
  return name;
}

export type AuthKind = "oauth" | "header" | "env" | "none";

export interface DiscoveredServer {
  name: string;
  /** Which coding client configured it, e.g. "claude", "cursor". */
  client: string;
  transport: "http" | "sse" | "stdio";
  auth: AuthKind;
  /** URL for HTTP, launch command for stdio. */
  detail: string;
  /**
   * For OAuth servers: whether the token can be read. `unsupported` means the
   * server belongs to a client whose OAuth store this package cannot read yet.
   */
  tokenState?: "live" | "expired" | "missing" | "unsupported";
  source: string;
}

/**
 * Every server Claude Code can reach, merged from the config files and the
 * Keychain, so `codemode servers` shows the full picture regardless of how
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
        client: cfg.client,
        transport: "stdio",
        auth: Object.keys(cfg.env).length > 0 ? "env" : "none",
        detail: [cfg.command, ...cfg.args].join(" "),
        source: cfg.source,
      });
    } else if (Object.keys(cfg.headers).length > 0) {
      out.set(cfg.name, {
        name: cfg.name,
        client: cfg.client,
        transport: cfg.transport,
        auth: "header",
        detail: cfg.url,
        source: cfg.source,
      });
    } else {
      // OAuth: only Claude's token store is readable today.
      const cred = credByName.get(cfg.name);
      const tokenState =
        cfg.client !== "claude" ? "unsupported" : !cred ? "missing" : isExpired(cred) ? "expired" : "live";
      out.set(cfg.name, {
        name: cfg.name,
        client: cfg.client,
        transport: cfg.transport,
        auth: "oauth",
        detail: cfg.url,
        tokenState,
        source: cfg.source,
      });
    }
  }

  // Credential-store servers that never appeared in the config files.
  for (const cred of creds) {
    if (out.has(cred.serverName)) continue;
    out.set(cred.serverName, {
      name: cred.serverName,
      client: "claude",
      transport: "http",
      auth: "oauth",
      detail: cred.serverUrl,
      tokenState: isExpired(cred) ? "expired" : "live",
      source: "credential store",
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
