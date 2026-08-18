import type { ToolDefinition, ToolResult } from "./client.js";

/**
 * The behaviour every MCP transport shares, so the proxy, codegen and CLI can
 * treat an HTTP+OAuth server, an HTTP server with a static API key, and a
 * local stdio subprocess the same way. `McpClient` (HTTP) and
 * `StdioMcpClient` (subprocess) both implement this.
 */
export interface McpSession {
  /** Human label for error messages — a URL or the launch command. */
  readonly label: string;
  /** initialize + notifications/initialized. Idempotent. */
  connect(): Promise<unknown>;
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Release resources. HTTP has none to release; stdio kills the child. */
  close(): void | Promise<void>;
}
