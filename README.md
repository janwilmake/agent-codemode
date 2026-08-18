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

Requires Node 18+ and macOS.

## What works

Verified end to end against a live install:

| Kind | Example | Status |
| --- | --- | --- |
| Remote HTTP MCP (OAuth) | `linear`, `axiom`, `fastmail` | ✅ works |
| Self-hosted remote MCP | `hyre-prod`, `hyre-staging` | ✅ works |
| Plugin MCP | `plugin:slack:slack` | ✅ works |
| claude.ai connector | `claude.ai Gmail`, `claude.ai Google Calendar` | ❌ not yet — see below |
| stdio MCP (local subprocess) | — | ❌ not yet |

**claude.ai connectors** are configured under a `claude.ai config` scope and have
no entry in the `mcpOAuth` store; they authenticate through the account-level
`claudeAiOauth` token instead. Supporting them means a different code path.

**stdio servers** need the subprocess spawned and JSON-RPC spoken over
stdin/stdout rather than HTTP. No auth involved — just a second transport.

## How it works

Claude Code keeps a JSON blob in the macOS Keychain under the service
`Claude Code-credentials`. Inside it, `mcpOAuth` is keyed by
`<serverName>|<urlHash>` and each entry carries `serverUrl`, `accessToken`,
`refreshToken`, `clientId`, `issuer` and `expiresAt`.

This package reads that entry, then speaks Streamable HTTP MCP: `initialize`,
carry the returned `Mcp-Session-Id`, `notifications/initialized`, then
`tools/list` or `tools/call`. Responses may come back as JSON or as SSE; both
are handled.

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
claude-codemode servers                       list servers with a stored token
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
