import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
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

console.log(`\n${passed} checks passed`);
