import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient, readServerConfigs, openSession, listServers } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "echo-server.mjs");
let passed = 0;
const ok = (m) => {
  passed++;
  console.log("ok - " + m);
};

// 1. stdio transport, driven directly
{
  const c = new StdioMcpClient("node", [fixture]);
  const tools = await c.listTools();
  assert.equal(tools.length, 1, "expected one tool");
  assert.equal(tools[0].name, "echo");
  ok("stdio: listTools returns echo");

  const res = await c.callTool("echo", { message: "hi there" });
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text.includes("hi there"), `unexpected: ${text}`);
  ok("stdio: callTool echoes the message");
  c.close();
}

// 2. config discovery: a stdio and an API-key server from a temp .mcp.json
{
  const dir = mkdtempSync(join(tmpdir(), "ccm-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "echo-local": { command: "node", args: [fixture] },
        "acme-api": {
          type: "http",
          url: "https://api.acme.test/mcp",
          headers: { Authorization: "Bearer ${ACME_KEY}" },
        },
      },
    }),
  );
  process.env.ACME_KEY = "sekret";

  const cfgs = readServerConfigs(dir);
  assert.equal(cfgs.get("echo-local")?.transport, "stdio");
  ok("config: stdio server discovered");

  const api = cfgs.get("acme-api");
  assert.equal(api?.transport, "http");
  assert.equal(api?.headers.Authorization, "Bearer sekret");
  ok("config: api-key header discovered and ${VAR} expanded");

  // 3. resolver picks stdio and runs it, resolved purely by name
  const s = await openSession("echo-local", { cwd: dir });
  const res = await s.callTool("echo", { message: "via-config" });
  assert.ok((res.content?.[0]?.text ?? "").includes("via-config"));
  ok("resolver: openSession spawns the stdio server by name");
  await s.close();

  // 4. resolver builds an API-key HTTP session (no live server to call)
  const h = await openSession("acme-api", { cwd: dir });
  assert.equal(h.label, "https://api.acme.test/mcp");
  ok("resolver: openSession builds an api-key http session");
  await h.close();
}

// 5. discovery against the real machine config
{
  const servers = await listServers();
  assert.ok(servers.length > 0, "no servers discovered");
  ok(`discovery: listServers found ${servers.length} real servers`);
}

// 6. multi-client discovery + cross-platform credential file, via a fake HOME
{
  const origHome = process.env.HOME;
  const fake = mkdtempSync(join(tmpdir(), "ccm-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ccm-cwd-"));
  mkdirSync(join(fake, ".cursor"), { recursive: true });
  mkdirSync(join(fake, ".gemini"), { recursive: true });
  mkdirSync(join(fake, ".claude"), { recursive: true });
  writeFileSync(
    join(fake, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "cursor-echo": { command: "node", args: [fixture] },
        "cursor-oauth": { type: "http", url: "https://c.example/mcp" },
      },
    }),
  );
  writeFileSync(
    join(fake, ".gemini", "settings.json"),
    JSON.stringify({ mcpServers: { "gemini-api": { httpUrl: "https://g.example/mcp", headers: { "X-Key": "k" } } } }),
  );
  writeFileSync(
    join(fake, ".claude", ".credentials.json"),
    JSON.stringify({
      mcpOAuth: {
        "filecred|abc": {
          serverName: "filecred",
          serverUrl: "https://f.example/mcp",
          accessToken: "tok",
          expiresAt: Date.now() + 3_600_000,
        },
      },
    }),
  );
  process.env.HOME = fake;
  try {
    const cfgs = readServerConfigs(cwd);
    assert.equal(cfgs.get("cursor-echo")?.client, "cursor");
    assert.equal(cfgs.get("cursor-echo")?.transport, "stdio");
    ok("multi-client: cursor stdio server discovered");
    assert.equal(cfgs.get("gemini-api")?.client, "gemini");
    assert.equal(cfgs.get("gemini-api")?.transport, "http"); // httpUrl → http
    ok("multi-client: gemini httpUrl+header server discovered");

    await assert.rejects(() => openSession("cursor-oauth", { cwd }), /not implemented/);
    ok("stub: non-claude OAuth server yields a clear 'not implemented' error");

    const found = await listServers(cwd);
    const fc = found.find((s) => s.name === "filecred");
    assert.ok(fc && fc.tokenState === "live", "credentials file not read");
    ok("cross-platform: ~/.claude/.credentials.json credential read");
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
}

console.log(`\n${passed} checks passed`);
