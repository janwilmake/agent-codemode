import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads the MCP server definitions Claude Code keeps in its config files, as
 * opposed to the OAuth tokens it keeps in the Keychain (see credentials.ts).
 *
 * Two kinds of server live only here, never in the Keychain:
 *   - **stdio** servers — a local subprocess, launched by `command`/`args`,
 *     with any secrets passed through `env`. No OAuth, no token to store.
 *   - **API-key HTTP/SSE** servers — a URL plus a static `headers` map
 *     (typically `Authorization: Bearer …`). The key sits in the config, so
 *     the OAuth dance never happens and the Keychain stays empty for them.
 *
 * OAuth HTTP servers appear here too (as a bare url with no headers); for those
 * the token is in the Keychain and the resolver falls back to it.
 */

export type StdioServer = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  source: string;
};

export type HttpServer = {
  name: string;
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  source: string;
};

export type ServerConfig = StdioServer | HttpServer;

/** Expand `${VAR}` from the environment, as Claude Code does in these fields. */
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function expandMap(map: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (typeof v === "string") out[k] = expand(v);
  }
  return out;
}

function classify(name: string, raw: any, source: string): ServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type: string | undefined = typeof raw.type === "string" ? raw.type : undefined;

  // stdio: an explicit type, or a `command` with no url.
  if (type === "stdio" || (!type && raw.command && !raw.url)) {
    if (typeof raw.command !== "string") return undefined;
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map((a: unknown) => expand(String(a))) : [],
      env: expandMap(raw.env),
      source,
    };
  }

  // http / sse: an explicit type, or a bare `url`.
  if (type === "http" || type === "sse" || (!type && raw.url)) {
    if (typeof raw.url !== "string") return undefined;
    return {
      name,
      transport: type === "sse" ? "sse" : "http",
      url: expand(raw.url),
      headers: expandMap(raw.headers),
      source,
    };
  }
  return undefined;
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or malformed — not this reader's problem to report
  }
}

/**
 * Every MCP server Claude Code has configured, keyed by name. Sources are read
 * global → project → `.mcp.json`, and a later source with the same name wins —
 * the same last-wins order Claude Code applies.
 */
export function readServerConfigs(cwd: string = process.cwd()): Map<string, ServerConfig> {
  const out = new Map<string, ServerConfig>();
  const add = (servers: Record<string, unknown> | undefined, source: string) => {
    for (const [name, raw] of Object.entries(servers ?? {})) {
      const cfg = classify(name, raw, source);
      if (cfg) out.set(name, cfg);
    }
  };

  const global = readJson(join(homedir(), ".claude.json"));
  if (global) {
    add(global.mcpServers, "~/.claude.json");
    const proj = global.projects?.[cwd];
    if (proj) add(proj.mcpServers, `~/.claude.json → projects[${cwd}]`);
  }

  const dotMcp = readJson(join(cwd, ".mcp.json"));
  if (dotMcp) add(dotMcp.mcpServers ?? dotMcp, ".mcp.json");

  return out;
}
