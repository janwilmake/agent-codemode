import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The macOS Keychain item Claude Code writes its credentials to. */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface McpCredential {
  /** Server name as configured in Claude Code, e.g. "linear". */
  serverName: string;
  /** Absolute MCP endpoint, e.g. "https://mcp.linear.app/mcp". */
  serverUrl: string;
  accessToken: string;
  /**
   * Present, but do not build on it. Claude Code re-runs dynamic client
   * registration on launch and orphans the previous clientId/refreshToken
   * (anthropics/claude-code#59460), so a refresh you attempt yourself may fail
   * against a client the issuer no longer knows.
   */
  refreshToken?: string;
  clientId?: string;
  issuer?: string;
  scope?: string;
  /** Epoch. Unit is normalised to milliseconds by {@link expiresAtMs}. */
  expiresAt?: number;
}

export class CredentialError extends Error {}

/** Redact a secret for display. Never log a raw token. */
export function redact(secret: string): string {
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

/** Normalise an epoch that may be in seconds or milliseconds. */
export function expiresAtMs(cred: McpCredential): number | undefined {
  if (cred.expiresAt === undefined) return undefined;
  // Seconds-since-epoch for any plausible date is < 1e11; ms is > 1e12.
  return cred.expiresAt < 1e11 ? cred.expiresAt * 1000 : cred.expiresAt;
}

export function isExpired(cred: McpCredential, skewMs = 30_000): boolean {
  const exp = expiresAtMs(cred);
  if (exp === undefined) return false; // no expiry recorded: assume usable
  return Date.now() + skewMs >= exp;
}

async function readKeychainBlob(): Promise<unknown> {
  if (process.platform !== "darwin") {
    throw new CredentialError(
      `Only macOS is supported (found ${process.platform}). Claude Code stores ` +
        `MCP credentials in the macOS Keychain; other platforms use a different store.`,
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch {
    throw new CredentialError(
      `Could not read the "${KEYCHAIN_SERVICE}" keychain item. Is Claude Code installed and signed in?`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new CredentialError(`The "${KEYCHAIN_SERVICE}" keychain item is not JSON.`);
  }
}

/**
 * Read every MCP credential Claude Code currently holds.
 *
 * Re-read this on every call rather than caching. Claude Code refreshes tokens
 * on its own schedule, so a cached copy goes stale under you.
 */
export async function listCredentials(): Promise<McpCredential[]> {
  const blob = await readKeychainBlob();
  const mcpOAuth = (blob as Record<string, unknown>)?.mcpOAuth;
  if (!mcpOAuth || typeof mcpOAuth !== "object") return [];

  const out: McpCredential[] = [];
  for (const [key, raw] of Object.entries(mcpOAuth as Record<string, any>)) {
    if (!raw?.accessToken) continue;
    // Keys look like "<serverName>|<urlHash>".
    const serverName = raw.serverName ?? key.split("|")[0];
    if (!raw.serverUrl) continue;
    out.push({
      serverName,
      serverUrl: raw.serverUrl,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      clientId: raw.clientId,
      issuer: raw.issuer,
      scope: raw.scope,
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    });
  }
  return out.sort((a, b) => a.serverName.localeCompare(b.serverName));
}

/** Read one server's credential, newest-wins if a name appears twice. */
export async function getCredential(serverName: string): Promise<McpCredential> {
  const all = await listCredentials();
  const matches = all.filter((c) => c.serverName === serverName);
  if (matches.length === 0) {
    const names = all.map((c) => c.serverName).join(", ") || "(none)";
    throw new CredentialError(
      `No stored credential for MCP server "${serverName}". Known servers: ${names}. ` +
        `If it is configured but never authenticated, run: claude mcp login ${serverName}`,
    );
  }
  const cred = matches.reduce((a, b) => ((expiresAtMs(b) ?? 0) > (expiresAtMs(a) ?? 0) ? b : a));
  if (isExpired(cred)) {
    throw new CredentialError(
      `The stored access token for "${serverName}" has expired. Claude Code owns the refresh; ` +
        `start Claude Code (or run: claude mcp login ${serverName}) so it mints a fresh one.`,
    );
  }
  return cred;
}
