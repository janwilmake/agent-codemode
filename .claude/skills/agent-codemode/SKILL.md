---
name: agent-codemode
description: Call the MCP servers this machine's coding agent is already authenticated to — from a shell script or from TypeScript, with no model in the loop. Use when a task needs data from an MCP server (Linear, Slack, Axiom, Fastmail, a self-hosted one), when several MCP calls should be composed into one script instead of a chain of tool calls, when generating type-safe bindings for a server, or when the user asks about the `agent-codemode` / `codemode` command.
---

# agent-codemode

`claude mcp` can add, list and log in to MCP servers. It cannot **call** them.
This fills that gap: it reads the OAuth token the coding agent already stored,
and speaks JSON-RPC to the server directly. No API keys, no OAuth flow, no model
relaying the request.

Two surfaces — a CLI (`agent-codemode`, aliased `codemode`) and a TypeScript
library — plus a codegen that emits type-safe bindings.

## When to reach for this

**Reach for it whenever you would otherwise make several MCP tool calls in a
row.** If a task needs a list from one server, a filter, and then a write to
another, that is one script — not twenty round trips through the model, each
paying for the previous result on the way in and the next argument on the way
out. Write the script, run it, read back the answer.

Also reach for it when:

- A shell one-liner needs a single fact from a server and a full tool call is
  overkill.
- You want `mcp.linear.listIssues({ … })` with autocomplete and compile-time
  argument checking.
- The work should keep running later — from cron, or as a CI gate — with no
  model involved at all.

Do **not** reach for it to call a claude.ai connector (Gmail, Calendar). See
Limits.

## Install

```bash
npm install -g agent-codemode      # also installs a shorter `codemode` alias
```

Requires Node 18+. macOS is fully supported; on Linux/Windows the stdio and
API-key servers work and OAuth is read from `~/.claude/.credentials.json`.

If the command is not found after a global install, the npm global bin directory
is not on `PATH`. Call it by full path, or use `npx agent-codemode …`. **Do not
edit the user's shell profile without asking.**

## Using the CLI

```bash
agent-codemode servers                     # servers with a live token + expiry
agent-codemode tools linear                # a server's tools (JSON)
agent-codemode call linear list_issues --arg assignee=me --arg state=Todo --text
agent-codemode call linear list_issues --json '{"assignee":"me","limit":5}'
```

`call` arguments:

- `--arg key=value` — one string argument
- `--arg key:=1` — one JSON-valued argument (number, bool, array, object)
- `--json '{…}'` — the whole argument object at once
- `--text` — print only the text content (default prints the full JSON-RPC result)

Server names can be shortened when unambiguous, so `call slack …` reaches
`plugin:slack:slack`. An ambiguous short name is an error, not a guess.

Exit codes: `0` ok, `1` error (credential/transport/usage), `2` the tool itself
reported `isError`. Never infer success from a pipeline's exit status — check
the JSON.

## Using the library

```ts
import { mcp, callTool, resultText, McpClient } from "agent-codemode";

// the proxy — no codegen needed, arguments are Record<string, unknown>
const res = await mcp.linear.listIssues({ assignee: "me" });
const data = JSON.parse(resultText(res) ?? "{}");

// one-shot, by wire name
await callTool("linear", "list_issues", { assignee: "me", state: "Todo" });

// or hold one session across several calls
const client = await McpClient.fromClaudeCode("linear");
await client.connect();
await client.callTool("list_issues", { assignee: "me" });
```

Several servers compose in one script, because each authenticated itself
already — there is nothing to put in a `.env`:

```ts
const [issues, events, channel] = await Promise.all([
  mcp.linear.listIssues({ assignee: "me", limit: 50 }),
  mcp.axiom.queryDataset({ apl: "['prod'] | where _time > ago(24h) | summarize count()" }),
  mcp.slack.slackSearchChannels({ query: "general" }),
]);
```

## Type-safe bindings: `mcp.<server>.<tool>(args)`

Generate a `.ts` module from a server's live tool spec:

```bash
agent-codemode types linear --out src/mcp-types/linear.ts
agent-codemode types --all --out src/mcp-types      # every server + an index.ts barrel
```

Each generated module registers itself with `mcp` by merging into the
`McpServers` interface, so importing it is the entire setup — **there is no cast
and no type argument at the call site**:

```ts
import "./mcp-types";                    // side-effect import; registers every server
import { mcp } from "agent-codemode";

const issues = await mcp.linear.listIssues({ assignee: "me", state: "In Progress" });
//                              ^ autocompleted   ^ a wrong key or type is a compile error
```

A generated module carries one `Args` interface per tool (JSON-Schema → TS,
descriptions as JSDoc clipped to a sane length, `enum`/`const` as literal
unions, the `[{…},{null}]` idiom as `T | null`), a `<Server>Client` interface,
and the `declare module` block that registers both the wire name and the short
alias. Servers you never generated still work — they fall through to an index
signature and take `Record<string, unknown>`. The types are a pure overlay.

### Regenerating

The types are a snapshot of `tools/list`. **Regenerate whenever a server is
added, logged into, or ships new tools**, or the types drift from what the
server actually accepts:

```json
{ "scripts": { "mcp:types": "agent-codemode types --all --out src/mcp-types" } }
```

`types --all` skips servers it cannot reach (an expired token, say), names each
one it skipped, and fails only if nothing at all could be generated. Run
`agent-codemode servers` first to see what will be generated and each token's
expiry.

## Three kinds of server, one `openSession(name)`

| Kind | Where the credential lives | How it is reached |
| --- | --- | --- |
| **OAuth HTTP** (`linear`, `axiom`) | macOS Keychain, `mcpOAuth` map | read the token, speak Streamable-HTTP MCP |
| **API-key HTTP/SSE** | config file `headers` (a static `Authorization`) | send those headers instead of a Bearer |
| **stdio** (local subprocess) | config file `command`/`args`/`env` | spawn the process, JSON-RPC over stdin/stdout |

The OAuth token is read fresh on every call. API-key and stdio configs come from
`~/.claude.json` (top-level `mcpServers` and per-project) and `.mcp.json`, with
`${VAR}` expanded from the environment.

```ts
import { openSession, listServers } from "agent-codemode";

const s = await openSession("some-server"); // transport resolved for you
const tools = await s.listTools();
await s.close();                            // stdio kills the child; http is a no-op
```

## Three rules the code enforces, and you should too

1. **Never cache the token.** The coding agent refreshes on its own schedule; a
   cached copy goes stale. The package re-reads per call.
2. **Never refresh it yourself.** The `refreshToken`/`clientId` are present, but
   Claude Code re-runs dynamic client registration on launch and orphans the
   previous pair, so your refresh may hit a client the issuer has forgotten. If
   a token has expired, start Claude Code or run `claude mcp login <server>`.
3. **An expired token is a loud error, never an empty result** — a gate that
   silently returns nothing because auth broke looks exactly like a gate that
   found no work.

A fourth, for anything you write with this: **keep the destructive path
explicit.** A script holding a live Linear token can close tickets at 3am with
nobody reading the diff. Put sending and writing behind a flag, the way
`examples/standup.ts` keeps posting behind `--post`.

## Limits (proven, not guessed)

- **claude.ai connectors (Gmail, Calendar) are out of scope.** Two independent
  reasons, both verified: their token lives only in claude.ai's backend and is
  absent from the local store; and the connector endpoint rejects any request
  whose `clientInfo.name` contains "claude". Working around either would be
  impersonation — don't.
- **Linux/Windows are best-effort, not yet verified.** The config-based servers
  are cross-platform and OAuth falls back to `~/.claude/.credentials.json`, but
  nobody has confirmed a full run. See CONTRIBUTING.md.
- **OAuth inheritance is Claude-only.** Other clients' servers are discovered
  (Cursor, Windsurf, VS Code, Gemini CLI — `agent-codemode servers` shows the
  `client` each came from) and their stdio and API-key servers run, but their
  OAuth servers show `unsupported` until someone adds that client's token store.

## Security

Tokens are read fresh and never printed. The package only ever reads
credentials — it never writes, refreshes, or transmits them anywhere but to the
server they belong to. Worth knowing regardless: any process the coding agent
spawns can already read that credential store without a prompt, so every MCP
token on the machine, production included, is readable by anything run from a
session. That is a property of the machine, not of this package. See
SECURITY.md.
