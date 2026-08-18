export {
  McpClient,
  McpError,
  callTool,
  listTools,
  resultText,
  DEFAULT_PROTOCOL_VERSION,
  type ToolDefinition,
  type ToolResult,
} from "./client.js";

export {
  listCredentials,
  getCredential,
  isExpired,
  expiresAtMs,
  redact,
  CredentialError,
  KEYCHAIN_SERVICE,
  type McpCredential,
} from "./credentials.js";

export { mcp, type DynamicServer } from "./proxy.js";

export { type McpSession } from "./session.js";

export { StdioMcpClient } from "./stdio-client.js";

export {
  readServerConfigs,
  type ServerConfig,
  type StdioServer,
  type HttpServer,
} from "./config.js";

export {
  openSession,
  listServers,
  tokenExpiry,
  type DiscoveredServer,
  type AuthKind,
} from "./resolver.js";

export {
  generateModule,
  schemaToTs,
  toCamel,
  toPascal,
  type GeneratedModule,
} from "./codegen.js";
