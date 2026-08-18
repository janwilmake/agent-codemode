#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { McpClient, resultText } from "./client.js";
import { listCredentials, expiresAtMs, isExpired, CredentialError } from "./credentials.js";
import { generateModule } from "./codegen.js";

const USAGE = `claude-codemode — call the MCP servers Claude Code is authenticated to

  claude-codemode servers                       list servers with a stored token
  claude-codemode tools <server>                list a server's tools
  claude-codemode call <server> <tool> [args]   call a tool
  claude-codemode types <server> [--out file]   generate a .ts types module for a server

Arguments for "call" (combine freely; later values win):
  --json '{"a":1}'      whole argument object as JSON
  --arg key=value       one string argument
  --arg key:=1          one JSON-valued argument (number, bool, array, object)

Options:
  --text                print only the text content of the result
  --raw                 print the whole JSON-RPC result (default)
  -h, --help            this message

Examples:
  claude-codemode servers
  claude-codemode tools linear
  claude-codemode call linear list_issues --arg team="Hyre Ops" --arg state=Todo --text
  claude-codemode call linear list_issues --json '{"team":"Hyre Ops","limit":5}'

Notes:
  Tokens are read fresh from the macOS Keychain on every run and are never
  printed. Claude Code owns token refresh: if one has expired, start Claude Code
  or run \`claude mcp login <server>\`.
`;

function parseCallArgs(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--json needs a value");
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--json must be a JSON object");
      }
      Object.assign(args, parsed);
    } else if (a === "--arg") {
      const pair = argv[++i];
      if (pair === undefined) throw new Error("--arg needs key=value or key:=json");
      const jsonSep = pair.indexOf(":=");
      const strSep = pair.indexOf("=");
      if (jsonSep !== -1 && (strSep === -1 || jsonSep < strSep)) {
        args[pair.slice(0, jsonSep)] = JSON.parse(pair.slice(jsonSep + 2));
      } else if (strSep !== -1) {
        args[pair.slice(0, strSep)] = pair.slice(strSep + 1);
      } else {
        throw new Error(`--arg "${pair}" is not key=value or key:=json`);
      }
    } else if (a === "--text" || a === "--raw") {
      // handled by the caller
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return args;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = argv;

  if (command === "servers") {
    const creds = await listCredentials();
    if (creds.length === 0) {
      process.stderr.write("No MCP servers have a stored token.\n");
      return 1;
    }
    for (const c of creds) {
      const exp = expiresAtMs(c);
      const state = isExpired(c)
        ? "EXPIRED"
        : exp
          ? `expires ${new Date(exp).toISOString()}`
          : "no expiry recorded";
      process.stdout.write(`${c.serverName.padEnd(22)} ${state.padEnd(34)} ${c.serverUrl}\n`);
    }
    return 0;
  }

  if (command === "tools") {
    const server = rest[0];
    if (!server) throw new Error("usage: claude-codemode tools <server>");
    const tools = await (await McpClient.fromClaudeCode(server)).listTools();
    process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
    return 0;
  }

  if (command === "types") {
    const server = rest[0];
    if (!server) throw new Error("usage: claude-codemode types <server> [--out file]");
    const outIdx = rest.indexOf("--out");
    const out = outIdx !== -1 ? rest[outIdx + 1] : undefined;
    const tools = await (await McpClient.fromClaudeCode(server)).listTools();
    const mod = generateModule(server, tools);
    if (out) {
      await writeFile(out, mod.source);
      process.stderr.write(`wrote ${mod.methods.length} typed methods to ${out}\n`);
    } else {
      process.stdout.write(mod.source);
    }
    return 0;
  }

  if (command === "call") {
    const [server, tool, ...argv2] = rest;
    if (!server || !tool) throw new Error("usage: claude-codemode call <server> <tool> [args]");
    const wantText = argv2.includes("--text");
    const args = parseCallArgs(argv2);
    const result = await (await McpClient.fromClaudeCode(server)).callTool(tool, args);
    if (wantText) {
      const text = resultText(result);
      process.stdout.write((text ?? JSON.stringify(result)) + "\n");
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    // A tool that reports its own failure must not look like success.
    return result.isError ? 2 : 0;
  }

  throw new Error(`unknown command "${command}". Run --help.`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${err instanceof CredentialError ? "credential error" : "error"}: ${msg}\n`);
    process.exit(1);
  });
