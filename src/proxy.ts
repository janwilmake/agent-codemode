import { type ToolResult } from "./client.js";
import { openSession } from "./resolver.js";
import type { McpSession } from "./session.js";
import { toCamel } from "./codegen.js";

/**
 * A runtime proxy that turns `mcp.linear.listIssues(args)` into a
 * tools/call on the "linear" server. The camelCase method name is mapped back
 * to the tool's wire name (listIssues → list_issues) by reversing the same
 * transform codegen uses, and confirmed against the server's live tool list.
 *
 * The generated `.d.ts` from `generateModule` gives the *types*; this gives the
 * *behaviour*. Cast the server handle to the generated `<Server>Client` type to
 * get both:
 *
 *   import type { LinearClient } from "./mcp-types/linear.js";
 *   const linear = mcp.linear as unknown as LinearClient;
 *   const issues = await linear.listIssues({ team: "Hyre Ops" });
 */
export interface DynamicServer {
  [method: string]: (args?: Record<string, unknown>) => Promise<ToolResult>;
}

async function resolveWireName(client: McpSession, method: string): Promise<string> {
  const tools = await client.listTools();
  // exact wire name, or the tool whose camelCased name matches the method
  const exact = tools.find((t) => t.name === method);
  if (exact) return exact.name;
  const byCamel = tools.find((t) => toCamel(t.name) === method);
  if (byCamel) return byCamel.name;
  throw new Error(
    `No tool on this server maps to "${method}". Available: ${tools.map((t) => toCamel(t.name)).join(", ")}`,
  );
}

function makeServerProxy(serverName: string): DynamicServer {
  let clientPromise: Promise<McpSession> | undefined;
  const client = () => (clientPromise ??= openSession(serverName));
  const wireCache = new Map<string, string>();

  return new Proxy({} as DynamicServer, {
    get(_target, prop: string) {
      if (typeof prop !== "string") return undefined;
      return async (args: Record<string, unknown> = {}) => {
        const c = await client();
        let wire = wireCache.get(prop);
        if (!wire) {
          wire = await resolveWireName(c, prop);
          wireCache.set(prop, wire);
        }
        return c.callTool(wire, args);
      };
    },
  });
}

/**
 * `mcp.<server>.<method>(args)`. Server handles are created lazily and cached,
 * so `mcp.linear` returns the same proxy each time and reuses one MCP session.
 */
export const mcp: Record<string, DynamicServer> = new Proxy(
  {},
  {
    get(target: Record<string, DynamicServer>, serverName: string) {
      if (typeof serverName !== "string") return undefined;
      return (target[serverName] ??= makeServerProxy(serverName));
    },
  },
);
