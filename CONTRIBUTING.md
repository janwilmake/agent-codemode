# Contributing

Two kinds of contribution are especially wanted, and both are structured so you
can add them without touching the transports.

## Add a coding client's servers (config discovery)

Every client that keeps MCP servers in a config file can be supported by one
entry in `CLIENT_SOURCES` (see `src/clients.ts`). Most clients use the same
`{ command/args/env }` or `{ url/headers/type }` schema this package already
classifies, so `collect` just has to find the files and return the raw defs:

```ts
{
  client: "yourclient",
  collect(cwd) {
    return fromFile(join(home(), ".yourclient", "mcp.json"), "yourclient");
  },
}
```

- Use `home()` (not `os.homedir()`) and `appConfigDir()` for paths, so `$HOME`
  overrides work and Windows/Linux paths resolve.
- If the file nests servers under a different key, pass it: `fromFile(path,
  "yourclient", "servers")`. If the schema is exotic, write a small `collect`
  that returns `{ name, raw, source }[]` yourself.
- **Codex CLI** is the open stub: it keeps servers in `~/.codex/config.toml`
  under `[mcp_servers.<name>]`, which needs a TOML parse the JSON clients do
  not. Add it without pulling in a heavy dependency if you can.

Then add a fixture to `test/smoke.mjs` following the "multi-client discovery"
block: write a fake config under a temp `$HOME` and assert it is discovered.

## Add a client's OAuth tokens (credential inheritance)

Config discovery gives you a client's **stdio and API-key** servers for free.
Its **OAuth** servers need the token, and each client stores tokens
differently. Today only Claude Code's store is read (`src/credentials.ts`: the
macOS Keychain and `~/.claude/.credentials.json`). Other clients hit the clear
`not implemented` error from `openSession`.

To add one, teach `listCredentials()` a second source that returns
`McpCredential[]` for that client, then relax the `cfg.client !== "claude"`
guard in `src/resolver.ts` for it. Note that some stores are impractical: VS
Code keeps secrets in per-extension encrypted storage that is not readable from
outside the editor.

## Verify on Linux / Windows

The macOS Keychain is the only platform-specific path; everything else uses
`home()` and per-OS config dirs. On Linux/Windows, Claude Code writes
credentials to `~/.claude/.credentials.json`, which the package already reads.
If you run on those platforms, the most useful help is:

1. Run `npm test` and report the result.
2. Run `codemode servers` and confirm it lists your real servers with the
   right transports.
3. Confirm the credentials path (`CREDENTIALS_FILE()`), and open an issue if
   your client puts it elsewhere.

Proper per-OS tests are welcome once someone can run them for real.
