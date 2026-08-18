import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { McpError, DEFAULT_PROTOCOL_VERSION, type ToolDefinition, type ToolResult } from "./client.js";
import type { McpSession } from "./session.js";
import type { StdioServer } from "./config.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

/**
 * MCP over stdio: spawn the server as a subprocess and exchange
 * newline-delimited JSON-RPC on its stdin/stdout. No token and no OAuth — the
 * subprocess gets whatever secrets it needs through `env`, exactly as Claude
 * Code launches it.
 *
 * Framing is one JSON message per line (the MCP stdio contract), not the
 * Content-Length framing LSP uses.
 */
export class StdioMcpClient implements McpSession {
  readonly label: string;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private initialized = false;
  private stdoutBuf = "";
  private stderrTail = "";
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
    readonly protocolVersion: string = DEFAULT_PROTOCOL_VERSION,
  ) {
    this.label = [command, ...args].join(" ");
  }

  static fromConfig(cfg: StdioServer): StdioMcpClient {
    return new StdioMcpClient(cfg.command, cfg.args, cfg.env);
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    child.on("error", (e) =>
      this.failAll(new McpError(`failed to spawn "${this.command}": ${e.message}`)),
    );
    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
      this.failAll(
        new McpError(
          `stdio server "${this.label}" exited (code=${code} signal=${signal})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    this.child = child;
    return child;
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // some servers log plain text to stdout; ignore non-JSON lines
      }
      if (typeof msg.id !== "number") continue; // notifications and string-id messages: ignore
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new McpError(msg.error.message, msg.error.code, msg.error.data));
      else waiter.resolve(msg.result);
    }
  }

  private rpc(method: string, params?: unknown, isNotification = false): Promise<any> {
    const child = this.ensureChild();
    if (!child.stdin.writable) {
      return Promise.reject(new McpError(`stdio server "${this.label}" is not accepting input`));
    }
    if (isNotification) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      return Promise.resolve(undefined);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async connect(): Promise<any> {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "agent-codemode", version: "0.1.0" },
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

  close(): void {
    this.failAll(new McpError(`stdio server "${this.label}" closed`));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
    this.initialized = false;
  }
}
