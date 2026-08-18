import { CLIENT_SOURCES } from "./clients.js";

/**
 * Classifies the MCP server definitions discovered across every coding client
 * (see clients.ts) into a transport this package can open.
 *
 * Two kinds of server live only in the config files, never in a Keychain:
 *   - **stdio** servers — a local subprocess (`command`/`args`), with any
 *     secrets in `env`. No OAuth, no token to store.
 *   - **API-key HTTP/SSE** servers — a URL plus a static `headers` map
 *     (typically `Authorization: Bearer …`). The key sits in the config, so the
 *     OAuth dance never happens.
 *
 * OAuth HTTP servers appear here too (a bare url with no headers); for those the
 * token is in the client's credential store and the resolver looks it up there.
 */

export type StdioServer = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  client: string;
  source: string;
};

export type HttpServer = {
  name: string;
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  client: string;
  source: string;
};

export type ServerConfig = StdioServer | HttpServer;

/** Expand `${VAR}` from the environment, as the clients do in these fields. */
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

function classify(name: string, raw: any, client: string, source: string): ServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type: string | undefined = typeof raw.type === "string" ? raw.type : undefined;
  // Gemini CLI uses `httpUrl` for streamable HTTP; treat it as `url`.
  const url: string | undefined =
    typeof raw.url === "string" ? raw.url : typeof raw.httpUrl === "string" ? raw.httpUrl : undefined;

  // stdio: an explicit type, or a `command` with no url.
  if (type === "stdio" || (!type && raw.command && !url)) {
    if (typeof raw.command !== "string") return undefined;
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map((a: unknown) => expand(String(a))) : [],
      env: expandMap(raw.env),
      client,
      source,
    };
  }

  // http / sse: an explicit type, or a bare url/httpUrl.
  if (type === "http" || type === "sse" || url) {
    if (!url) return undefined;
    return {
      name,
      transport: type === "sse" ? "sse" : "http",
      url: expand(url),
      headers: expandMap(raw.headers),
      client,
      source,
    };
  }
  return undefined;
}

/**
 * Every MCP server every known coding client has configured, keyed by name.
 * Across clients the earlier one in CLIENT_SOURCES wins on a name collision;
 * Claude is first, so it is authoritative.
 */
export function readServerConfigs(cwd: string = process.cwd()): Map<string, ServerConfig> {
  const out = new Map<string, ServerConfig>();
  for (const src of CLIENT_SOURCES) {
    let raws;
    try {
      raws = src.collect(cwd);
    } catch {
      continue; // a broken client config must not sink discovery for the rest
    }
    for (const { name, raw, source } of raws) {
      if (out.has(name)) continue; // earlier client wins
      const cfg = classify(name, raw, src.client, source);
      if (cfg) out.set(name, cfg);
    }
  }
  return out;
}
