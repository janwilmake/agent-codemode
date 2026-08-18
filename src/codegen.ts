import type { ToolDefinition } from "./client.js";

/**
 * A tiny JSON-Schema → TypeScript type emitter, scoped to the shapes MCP tool
 * inputSchemas actually use: object/properties/required, string/number/integer/
 * boolean/array, enum, const, oneOf/anyOf (including the `[{...},{null}]`
 * nullable idiom), items, additionalProperties. No $ref/$defs — none of the
 * servers surveyed emit them; if one appears it degrades to `unknown` rather
 * than guessing.
 */

type Schema = Record<string, any>;

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
]);

/** snake_case or kebab-case → camelCase. `list_issues` → `listIssues`. */
export function toCamel(name: string): string {
  return name.replace(/[_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/** camelCase → PascalCase. `listIssues` → `ListIssues`. */
export function toPascal(name: string): string {
  const camel = toCamel(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** PascalCase → camelCase. `SlackSlack` → `slackSlack`. */
function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * A server's identifier → the stem its generated names are built from.
 *
 * Plugin servers are named `plugin:<plugin>:<server>`, and the two halves are
 * usually the same word — `plugin:slack:slack`. Left alone that yields
 * `SlackSlackClient`, so repeated segments collapse to one.
 */
export function ifaceName(serverName: string): string {
  const segments = serverName.replace(/^plugin:/, "").split(":").filter(Boolean);
  const deduped = segments.filter((s, i) => s.toLowerCase() !== segments[i - 1]?.toLowerCase());
  return toPascal(deduped.join("-"));
}

/**
 * The per-tool half of an Args type name.
 *
 * Tools on a single-vendor server usually repeat the vendor in every name
 * (`slack_send_message`), which would stutter against the interface stem —
 * `SlackSlackSendMessageArgs`. Drop the stem when the tool name already leads
 * with it, unless that would leave nothing behind.
 */
function toolStem(iface: string, toolName: string): string {
  const pascal = toPascal(toolName);
  if (pascal.toLowerCase().startsWith(iface.toLowerCase())) {
    const rest = pascal.slice(iface.length);
    if (rest && /^[A-Z]/.test(rest)) return rest;
  }
  return pascal;
}

/** JSDoc is a hint, not a mirror of the server's prose. Some descriptions run to thousands of characters. */
const MAX_DOC = 240;

function docComment(text: unknown, pad = ""): string {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  const clipped = oneLine.length > MAX_DOC ? `${oneLine.slice(0, MAX_DOC).trimEnd()}…` : oneLine;
  return `${pad}/** ${clipped} */\n`;
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key) ? key : JSON.stringify(key);
}

function literal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "unknown";
}

function dedupeUnion(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (out.length === 0) return "unknown";
  if (out.includes("unknown")) return "unknown";
  return out.join(" | ");
}

/** Convert one schema node to a TS type expression. */
export function schemaToTs(schema: Schema | undefined, indent = 0): string {
  if (!schema || typeof schema !== "object") return "unknown";

  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum)) return dedupeUnion(schema.enum.map(literal));

  const combinator = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(combinator)) {
    return dedupeUnion(combinator.map((s: Schema) => schemaToTs(s, indent)));
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s: Schema) => schemaToTs(s, indent)).filter((p: string) => p !== "unknown");
    return parts.length ? parts.join(" & ") : "unknown";
  }

  // `type` may itself be an array, e.g. ["string","null"].
  if (Array.isArray(schema.type)) {
    return dedupeUnion(schema.type.map((t: string) => schemaToTs({ ...schema, type: t }, indent)));
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${schemaToTs(schema.items, indent)}>`;
    case "object":
    case undefined: {
      const props = schema.properties as Record<string, Schema> | undefined;
      if (props && Object.keys(props).length) return objectToTs(schema, indent);
      // free-form object
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Record<string, ${schemaToTs(schema.additionalProperties, indent)}>`;
      }
      if (schema.additionalProperties === false && !props) return "Record<string, never>";
      return schema.type === "object" ? "Record<string, unknown>" : "unknown";
    }
    default:
      return "unknown";
  }
}

function objectToTs(schema: Schema, indent: number): string {
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);

  const lines: string[] = [];
  for (const [key, sub] of Object.entries(props)) {
    const optional = !required.has(key) ? "?" : "";
    lines.push(`${docComment(sub.description, pad)}${pad}${quoteKey(key)}${optional}: ${schemaToTs(sub, indent + 1)};`);
  }
  return `{\n${lines.join("\n")}\n${closePad}}`;
}

export interface GeneratedModule {
  serverName: string;
  /** Valid TS module source: one Args interface per tool + a typed client map. */
  source: string;
  /** wire tool name → camelCase method name */
  methods: Array<{ wire: string; method: string; argsType: string }>;
}

/** Generate a `.ts` types module for one server's toolset. */
export function generateModule(serverName: string, tools: ToolDefinition[]): GeneratedModule {
  const iface = ifaceName(serverName);
  const parts: string[] = [];
  const methods: GeneratedModule["methods"] = [];

  parts.push(`// Generated by agent-codemode from ${serverName}'s tools/list. Do not edit by hand.`);
  parts.push(`import type { ToolResult } from "agent-codemode";`);
  parts.push("");

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const tool of sorted) {
    const method = toCamel(tool.name);
    const argsType = `${iface}${toolStem(iface, tool.name)}Args`;
    methods.push({ wire: tool.name, method, argsType });

    const doc = docComment(tool.description?.split("\n")[0]).trimEnd();
    if (doc) parts.push(doc);
    const body = schemaToTs(tool.inputSchema as Schema, 0);
    // An interface body must be an object literal; anything else needs a type alias.
    parts.push(
      body.startsWith("{")
        ? `export interface ${argsType} ${body}`
        : `export type ${argsType} = ${body};`,
    );
    parts.push("");
  }

  parts.push(`/** Type-safe client for the "${serverName}" MCP server. */`);
  parts.push(`export interface ${iface}Client {`);
  for (const m of methods) {
    parts.push(`  ${m.method}(args?: ${m.argsType}): Promise<ToolResult>;`);
  }
  parts.push(`}`);
  parts.push("");
  parts.push(`export const ${lowerFirst(iface)}Methods = {`);
  for (const m of methods) parts.push(`  ${m.method}: ${JSON.stringify(m.wire)},`);
  parts.push(`} as const;`);
  parts.push("");

  return { serverName, source: parts.join("\n") + "\n", methods };
}
