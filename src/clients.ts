import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The coding clients that keep MCP server definitions in config files, and
 * where each one keeps them. Config discovery is client-agnostic: almost every
 * client uses the same `{ command/args/env }` or `{ url/headers/type }` schema,
 * so adding a client is one entry in CLIENT_SOURCES below.
 *
 * This module finds and reads the files. config.ts classifies what they hold.
 * Reading a client's OAuth *tokens* is a separate, per-client problem — see
 * credentials.ts and CONTRIBUTING.md.
 */

/** Home dir, honouring $HOME/$USERPROFILE so tests and Windows both work. */
export function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** Per-OS base dir for application config. */
export function appConfigDir(): string {
  if (process.platform === "darwin") return join(home(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(home(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(home(), ".config");
}

export interface RawServer {
  name: string;
  raw: unknown;
  /** Where it was found, e.g. "cursor:~/.cursor/mcp.json". */
  source: string;
}

/**
 * One coding client. `collect` returns its MCP server defs, already merged
 * across that client's own config files. Add a client by adding one of these.
 */
export interface ClientSource {
  /** Stable id, shown by `servers`. */
  client: string;
  collect(cwd: string): RawServer[];
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or malformed — skip quietly
  }
}

function short(path: string): string {
  return path.startsWith(home()) ? "~" + path.slice(home().length) : path;
}

/** Turn a `{ name: def }` map into RawServer[], tagged with its source. */
function entries(map: unknown, client: string, path: string): RawServer[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([name, raw]) => ({ name, raw, source: `${client}:${short(path)}` }));
}

/** Read one `{ [key]: {name: def} }`-shaped file (default key `mcpServers`). */
function fromFile(path: string, client: string, key = "mcpServers"): RawServer[] {
  const json = readJson(path);
  if (!json) return [];
  const map = json[key] ?? (key === "mcpServers" ? json : undefined);
  return entries(map, client, path);
}

/**
 * The client registry. Order is precedence: on a name collision across clients,
 * the earlier client wins (Claude is authoritative). Each client still merges
 * its own files internally with last-wins.
 *
 * To add a client: append a ClientSource. Point `collect` at its config files
 * and return the raw server defs — classify() handles the rest, as long as the
 * defs use the common `command/args/env` or `url/headers/type` shape.
 */
export const CLIENT_SOURCES: ClientSource[] = [
  {
    client: "claude",
    collect(cwd) {
      const merged = new Map<string, RawServer>(); // last-wins within Claude
      const globalPath = join(home(), ".claude.json");
      const global = readJson(globalPath);
      if (global) {
        for (const r of entries(global.mcpServers, "claude", globalPath)) merged.set(r.name, r);
        const proj = global.projects?.[cwd];
        if (proj) for (const r of entries(proj.mcpServers, "claude", globalPath)) merged.set(r.name, r);
      }
      const dot = join(cwd, ".mcp.json");
      const dotJson = readJson(dot);
      if (dotJson) for (const r of entries(dotJson.mcpServers ?? dotJson, "claude", dot)) merged.set(r.name, r);
      return [...merged.values()];
    },
  },
  {
    client: "cursor",
    collect(cwd) {
      return [
        ...fromFile(join(home(), ".cursor", "mcp.json"), "cursor"),
        ...fromFile(join(cwd, ".cursor", "mcp.json"), "cursor"),
      ];
    },
  },
  {
    client: "windsurf",
    collect() {
      return fromFile(join(home(), ".codeium", "windsurf", "mcp_config.json"), "windsurf");
    },
  },
  {
    client: "vscode",
    collect(cwd) {
      // Project file uses the "servers" key; user settings.json nests it under "mcp".
      const settings = readJson(join(appConfigDir(), "Code", "User", "settings.json"));
      return [
        ...fromFile(join(cwd, ".vscode", "mcp.json"), "vscode", "servers"),
        ...entries(settings?.mcp?.servers, "vscode", join(appConfigDir(), "Code", "User", "settings.json")),
      ];
    },
  },
  {
    client: "gemini",
    collect() {
      return fromFile(join(home(), ".gemini", "settings.json"), "gemini");
    },
  },
  // TODO(contributor): Codex CLI keeps servers in ~/.codex/config.toml under
  // [mcp_servers.<name>]. It needs a TOML parse, which the others do not, so it
  // is left as a stub rather than pulling in a TOML dependency. See CONTRIBUTING.md.
];
