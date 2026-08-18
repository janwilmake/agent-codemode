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
 * The registry of servers whose shape is known at compile time. Empty here on
 * purpose — `codemode types` fills it in, by emitting a declaration merge into
 * this interface for each server it generates:
 *
 *   declare module "agent-codemode" {
 *     interface McpServers { linear: LinearClient }
 *   }
 *
 * Import that generated module anywhere in your program and `mcp.linear` is
 * typed from then on, with no cast at the call site. Servers that aren't in
 * here still work — they fall through to the index signature below and take
 * `Record<string, unknown>` arguments.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface McpServers {}

/**
 * `mcp.<server>.<method>(args)`. Server handles are created lazily and cached,
 * so `mcp.linear` returns the same proxy each time and reuses one MCP session.
 *
 * A declared server wins over the index signature, so a generated type really
 * does constrain the call — `mcp.linear.listIssues({ bogus: 1 })` is an error,
 * not a silent pass through the untyped fallback.
 */
export const mcp: McpServers & Record<string, DynamicServer> = new Proxy(
  {},
  {
    get(target: Record<string, DynamicServer>, serverName: string) {
      if (typeof serverName !== "string") return undefined;
      return (target[serverName] ??= makeServerProxy(serverName));
    },
  },
) as McpServers & Record<string, DynamicServer>;
