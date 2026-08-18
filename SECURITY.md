# Security

## What this package does with your credentials

- It **reads** them. It never writes, refreshes, rotates or deletes them.
- It never transmits a token anywhere except to the MCP server that issued it.
- It never caches a token, on disk or in memory across calls. Every call
  re-reads the credential store, because Claude Code refreshes on its own
  schedule and a cached token goes stale silently.
- It never prints one. `codemode servers` shows a name, a transport and an
  expiry — never secret material.
- An expired token raises a loud error. It never degrades into an empty result.

## The thing worth knowing about your machine

This is the part to read before you install anything, including this.

On macOS, Claude Code stores every MCP OAuth token in a single Keychain item —
service `Claude Code-credentials`. That item is readable, without a prompt, by
any process running as you that Claude Code itself could have spawned. That
includes this package. It also includes every hook you have configured, every
MCP server that runs as a local subprocess, every `npx` package one of those
pulls in, and every shell command an agent decides to run.

So: **every MCP token you hold — production included — is readable by any
process started from a Claude Code session.** That is a property of how the
credential store works, not something this package introduces. Removing this
package does not change it. This package is simply an honest, readable
demonstration of it.

Two practical consequences:

1. **Treat your agent's MCP server list as a blast radius.** A server you
   authenticate for convenience is a server any code your agent runs can reach
   with your identity. If `hyre-prod` is one `npx` away from an untrusted
   postinstall script, that is worth knowing deliberately rather than
   discovering later.
2. **Prefer read-scoped tokens where the server offers them.** Most MCP servers
   issue one token for everything they can do. Where a server distinguishes
   scopes, take the narrow one.

## Scope of this package's own risk

This package adds no network listener, no daemon, no background process, and no
persistent state. It runs, reads a credential, makes one JSON-RPC call to the
server that credential belongs to, and exits.

The one capability it adds that you did not already have is *convenience* —
calling those servers without a model deciding to. That is the point, and it is
also the thing to be deliberate about: a script with your Linear token can close
tickets at 3am with no one reading the diff. Write your gates so that the
destructive path is explicit, the way
[`examples/standup.ts`](./examples/standup.ts) keeps sending behind `--post`.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/janwilmake/agent-codemode/issues) for
anything non-sensitive. For something you would rather not post publicly, email
**jan@wilmake.com**.
