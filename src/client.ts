import { getCredential, type McpCredential } from "./credentials.js";

/** Protocol version we advertise. Override with MCP_PROTOCOL_VERSION. */
export const DEFAULT_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION ?? "2025-06-18";

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A minimal Streamable-HTTP MCP client.
 *
 * Deliberately dependency-free: it speaks JSON-RPC over `fetch`, accepts either
 * a JSON or an SSE response body, and carries the `Mcp-Session-Id` the server
 * hands back at initialize.
 */
export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;

  constructor(
    readonly serverUrl: string,
    private readonly accessToken: string,
    readonly protocolVersion: string = DEFAULT_PROTOCOL_VERSION,
  ) {}

  /** Build a client from the token Claude Code currently holds for `serverName`. */
  static async fromClaudeCode(
    serverName: string,
    protocolVersion: string = DEFAULT_PROTOCOL_VERSION,
  ): Promise<McpClient> {
    const cred: McpCredential = await getCredential(serverName);
    return new McpClient(cred.serverUrl, cred.accessToken, protocolVersion);
  }

  /** Build a client for a raw URL, with an optional token. Use for endpoints
   *  Claude Code does not hold a credential for — e.g. connectors, whose
   *  tools/list is served unauthenticated. */
  static fromUrl(url: string, token = "", protocolVersion: string = DEFAULT_PROTOCOL_VERSION): McpClient {
    return new McpClient(url, token, protocolVersion);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    // Some endpoints (e.g. claude.ai connectors) serve tools/list unauthenticated.
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  /** Pull the first JSON-RPC payload out of a JSON or SSE body. */
  private static parseBody(contentType: string, body: string): JsonRpcResponse | undefined {
    if (contentType.includes("text/event-stream")) {
      for (const line of body.split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          return JSON.parse(payload) as JsonRpcResponse;
        } catch {
          /* keep scanning: a chunk may be split across lines */
        }
      }
      return undefined;
    }
    if (!body.trim()) return undefined;
    return JSON.parse(body) as JsonRpcResponse;
  }

  private async rpc(method: string, params?: unknown, isNotification = false): Promise<any> {
    const id = isNotification ? undefined : this.nextId++;
    const res = await fetch(this.serverUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        `${this.serverUrl} rejected the token (HTTP ${res.status}). Claude Code owns the refresh — ` +
          `start it, or run \`claude mcp login <server>\`, then retry.`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new McpError(`${this.serverUrl} returned HTTP ${res.status}: ${await res.text()}`, res.status);
    }
    if (isNotification) return undefined;

    const parsed = McpClient.parseBody(res.headers.get("content-type") ?? "", await res.text());
    if (!parsed) throw new McpError(`No JSON-RPC payload in the response to ${method}.`);
    if (parsed.error) {
      throw new McpError(`${method} failed: ${parsed.error.message}`, parsed.error.code, parsed.error.data);
    }
    return parsed.result;
  }

  /** initialize + notifications/initialized. Idempotent. */
  async connect(): Promise<any> {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "claude-codemode", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<ToolDefinition[]> {
    await this.connect();
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.connect();
    return (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
  }
}

/** One-shot convenience: connect, call, return. */
export async function callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const client = await McpClient.fromClaudeCode(serverName);
  return client.callTool(toolName, args);
}

/** One-shot convenience: connect, list tools, return. */
export async function listTools(serverName: string): Promise<ToolDefinition[]> {
  const client = await McpClient.fromClaudeCode(serverName);
  return client.listTools();
}

/**
 * Best-effort unwrap of a tool result to plain text, for scripts that just want
 * the answer. Returns undefined when the result carries no text content.
 */
export function resultText(result: ToolResult): string | undefined {
  const parts = (result.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string");
  return parts.length ? parts.map((c) => c.text).join("\n") : undefined;
}
