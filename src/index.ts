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
  CREDENTIALS_FILE,
  type McpCredential,
} from "./credentials.js";

export { mcp, type DynamicServer, type McpServers } from "./proxy.js";

export { PACKAGE_NAME, PACKAGE_VERSION, CLIENT_INFO } from "./version.js";

export { type McpSession } from "./session.js";

export { StdioMcpClient } from "./stdio-client.js";

export {
  readServerConfigs,
  type ServerConfig,
  type StdioServer,
  type HttpServer,
} from "./config.js";

export {
  CLIENT_SOURCES,
  home,
  appConfigDir,
  type ClientSource,
  type RawServer,
} from "./clients.js";

export {
  openSession,
  listServers,
  tokenExpiry,
  resolveName,
  shortName,
  type DiscoveredServer,
  type AuthKind,
} from "./resolver.js";

export {
  generateModule,
  ifaceName,
  schemaToTs,
  toCamel,
  toPascal,
  type GeneratedModule,
} from "./codegen.js";
