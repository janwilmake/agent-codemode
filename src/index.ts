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
