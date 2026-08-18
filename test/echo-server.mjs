// A minimal stdio MCP server for tests: newline-delimited JSON-RPC on
// stdin/stdout, one `echo` tool. Not a real integration — just enough of the
// protocol to prove StdioMcpClient speaks it.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "0.0.1" },
        },
      });
    case "notifications/initialized":
      return; // notifications get no reply
    case "tools/list":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the message back.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string", description: "text to echo" } },
                required: ["message"],
              },
            },
          ],
        },
      });
    case "tools/call":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "echo: " + (msg.params?.arguments?.message ?? "") }] },
      });
    default:
      if (typeof msg.id === "number") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
      }
  }
}
