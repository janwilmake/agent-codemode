# claude-codemode

Call the MCP servers **Claude Code is already authenticated to** — from a shell
script or from TypeScript. No API keys to create, no OAuth flow to implement, no
model in the loop.

`claude mcp` can add, list and log in to servers. It cannot *call* them. This
fills that gap:

```bash
claude-codemode servers                 # who has a live token
claude-codemode tools linear            # what can it do
claude-codemode call linear list_issues --arg team="Hyre Ops" --arg state=Todo --text
```

```ts
import { callTool, resultText } from "claude-codemode";

const result = await callTool("linear", "list_issues", { team: "Hyre Ops", state: "Todo" });
console.log(resultText(result));
```

## Why

An MCP server is a JSON-RPC endpoint. Claude Code has already done the OAuth
dance with yours and stored the tokens. So a script can talk to them directly —
which is what you want for cron jobs, gates and glue code, where paying a model
to relay a request is both slow and expensive.

## Install

```bash
npm install -g claude-codemode     # provides `claude-codemode` and `claude-mcp`
```

Requires Node 18+. macOS is fully supported. On Linux/Windows the config-based
servers (stdio, API-key) work as-is, and Claude's OAuth tokens are read from
`~/.claude/.credentials.json`; the macOS Keychain path is skipped. Help
verifying Linux/Windows is welcome — see CONTRIBUTING.md.

## What works

Verified end to end against a live install:

| Kind | Auth source | Example | Status |
| --- | --- | --- | --- |
| Remote HTTP MCP (OAuth) | Keychain | `linear`, `axiom`, `fastmail` | ✅ works |
| Self-hosted remote MCP | Keychain | `hyre-prod`, `hyre-staging` | ✅ works |
| Plugin MCP | Keychain | `plugin:slack:slack` | ✅ works |
| API-key HTTP/SSE MCP | config `headers` | `{ "type": "http", "headers": { … } }` | ✅ works |
| stdio MCP (local subprocess) | config `env` | `{ "command": "npx", … }` | ✅ works |
| claude.ai connector | claude.ai backend | `claude.ai Gmail`, `Google Calendar` | ❌ not yet — see below |

The OAuth rows read their token from the credential store. The API-key and
stdio rows read everything they need — a static header, or a launch command and
`env` — from the config files, where the client keeps them. `openSession(name)`
picks the right transport for each; the CLI does the same.

**It reads other coding clients too.** The config files scanned aren't only
Claude's — Cursor, Windsurf, VS Code, and Gemini CLI keep MCP servers in the
same schema, and this reads them all (see `claude-mcp servers`, which shows the
`client` each came from). So it inherits every client's **stdio and API-key**
servers. OAuth inheritance is Claude-only for now — other clients' OAuth servers
show as `unsupported` and are easy to add (CONTRIBUTING.md). Adding a client's
config is one entry in `src/clients.ts`.

**claude.ai connectors** are configured under a `claude.ai config` scope and have
no entry in the `mcpOAuth` store; they authenticate through the account-level
`claudeAiOauth` token, and the connector endpoint rejects any client whose name
contains "claude". Supporting them would mean impersonating Claude Code itself —
out of scope on purpose.

## How it works

Claude Code stores what a server needs in two places, and this package reads
both:

- **The macOS Keychain**, service `Claude Code-credentials`. Its `mcpOAuth` map
  is keyed `<serverName>|<urlHash>` and each entry carries `serverUrl`,
  `accessToken`, `refreshToken`, `clientId`, `issuer` and `expiresAt`. This is
  the OAuth HTTP servers.
- **The config files**, `~/.claude.json` (top-level `mcpServers` and
  per-project) and `.mcp.json`. A stdio server keeps its `command`, `args` and
  `env` here; an API-key server keeps its `url` and static `headers` here.
  `${VAR}` references in those fields are expanded from the environment, as
  Claude Code does.

For an HTTP server it speaks Streamable HTTP MCP — `initialize`, carry the
returned `Mcp-Session-Id`, `notifications/initialized`, then `tools/list` or
`tools/call`, accepting a JSON or an SSE response. For a stdio server it spawns
the subprocess and speaks the same JSON-RPC newline-framed over stdin/stdout.
One `McpSession` interface covers both.

## Three rules, learned the hard way

1. **Never cache the token.** Claude Code refreshes on its own schedule. This
   package re-reads the Keychain on every call, and so should you.
2. **Never try to refresh it yourself.** The `refreshToken` and `clientId` are
   right there, but Claude Code re-runs dynamic client registration on launch and
   orphans the previous pair
   ([claude-code#59460](https://github.com/anthropics/claude-code/issues/59460)),
   so your refresh may be rejected by a client the issuer has forgotten. If a
   token has expired, the fix is to start Claude Code, or
   `claude mcp login <server>`.
3. **An expired token is a loud error, never an empty result.** A gate that
   silently returns nothing because auth broke is indistinguishable from a gate
   that found no work — which is the failure that costs you a night.

## Security

- Tokens are read fresh and **never printed**. `servers` shows expiry, not secrets.
- Anything Claude Code spawns can already read this Keychain item without a
  prompt. That is a property of your machine, not of this package — but it is
  worth knowing that every MCP token you hold, production included, is readable
  by any process started from a Claude session.
- This package only ever *reads* credentials. It never writes, refreshes or
  transmits them anywhere except to the server they belong to.

## CLI

```
claude-codemode servers                       list every server (config + Keychain)
claude-codemode tools <server>                list a server's tools
claude-codemode call <server> <tool> [args]   call a tool

  --json '{"a":1}'      whole argument object as JSON
  --arg key=value       one string argument
  --arg key:=1          one JSON-valued argument (number, bool, array, object)
  --text                print only the text content of the result
```

Exit codes: `0` success, `1` error (credential, transport, usage), `2` the tool
itself reported `isError`.

## API

```ts
import {
  McpClient, callTool, listTools, resultText,
  listCredentials, getCredential, isExpired,
} from "claude-codemode";

// one-shot
const tools = await listTools("linear");

// or hold a session open across several calls
const client = await McpClient.fromClaudeCode("linear");
await client.connect();
const a = await client.callTool("list_issues", { team: "Hyre Ops" });
const b = await client.callTool("list_teams", {});
```

Set `MCP_PROTOCOL_VERSION` to advertise a different protocol revision.

## Licence

MIT
