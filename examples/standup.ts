/**
 * Three MCP servers, one script, zero API keys.
 *
 *   npx tsx examples/standup.ts
 *
 * Reads your Linear issues, your Axiom event counts and your Slack channel,
 * and prints the standup digest they add up to. Notice what is *not* in this
 * file: no tokens, no client IDs, no OAuth redirect, no `.env`. Every one of
 * these servers was authenticated once, by your coding agent, and this script
 * borrows that.
 *
 * Nothing here is written back. Sending the digest is behind `--post`.
 */

// In your own project this is `from "codemode"`; inside this repo it is the source.
import { mcp, resultText } from "../src/index.js";

const DATASET = process.env.CODEMODE_AXIOM_DATASET ?? "sample-http-logs";
const ASSIGNEE = process.env.CODEMODE_LINEAR_ASSIGNEE ?? "me";
const CHANNEL = process.env.CODEMODE_SLACK_CHANNEL ?? "general";
const post = process.argv.includes("--post");

/** MCP returns prose in `content[]`. Most servers put JSON in there as text. */
function json<T>(result: { content?: unknown }): T | undefined {
  const text = resultText(result as Parameters<typeof resultText>[0]);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

interface Issue {
  id: string;
  status: string;
  priority?: { name: string };
}

async function linearIssues(): Promise<Issue[]> {
  const res = await mcp.linear.listIssues({ assignee: ASSIGNEE, limit: 50 });
  const parsed = json<{ issues?: Issue[] }>(res);
  return (parsed?.issues ?? []).filter((i) => i.status !== "Done" && i.status !== "Canceled");
}

async function axiomEvents(): Promise<string> {
  const res = await mcp.axiom.queryDataset({
    apl: `['${DATASET}'] | where _time > ago(24h) | summarize count()`,
  });
  // The result is a CSV block; the count is the one numeric cell in it.
  const count = resultText(res as Parameters<typeof resultText>[0])?.match(/"?([\d,]+)"?\s*$/m);
  return count?.[1] ?? "unknown";
}

async function slackChannel(): Promise<string | undefined> {
  const res = await mcp.slack.slackSearchChannels({ query: CHANNEL });
  const text = resultText(res as Parameters<typeof resultText>[0]) ?? "";
  // The permalink arrives inside a JSON string, so its slashes are escaped.
  return text.match(/archives\\?\/(C[A-Z0-9]+)/)?.[1];
}

function tally(issues: Issue[]): string {
  const byStatus = new Map<string, number>();
  for (const i of issues) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1);
  return [...byStatus].map(([s, n]) => `${n} ${s}`).join(" · ") || "nothing open";
}

async function main(): Promise<void> {
  // Three different servers, three different auth mechanisms, one await.
  const [issues, events, channelId] = await Promise.all([
    linearIssues(),
    axiomEvents(),
    slackChannel(),
  ]);

  const urgent = issues.filter((i) => i.priority?.name === "Urgent" || i.priority?.name === "High");

  console.log(`\x1b[1mlinear\x1b[0m   ${issues.length} open · ${tally(issues)}`);
  console.log(`\x1b[1maxiom\x1b[0m    ${events} events in ${DATASET} / 24h`);
  console.log(`\x1b[1mslack\x1b[0m    #${CHANNEL} → ${channelId ?? "not found"}`);

  const watch = urgent.slice(0, 5).map((i) => i.id);
  const more = urgent.length - watch.length;

  const digest = [
    `*Standup* — ${issues.length} open, ${urgent.length} high priority`,
    `${events} events in the last 24h.`,
    watch.length ? `Watch: ${watch.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` : "Nothing urgent.",
  ].join("\n");

  console.log(`\n${digest}\n`);

  if (!post) {
    console.log("\x1b[2m(dry run — pass --post to send this to Slack)\x1b[0m");
    return;
  }
  if (!channelId) throw new Error(`no Slack channel matched "${CHANNEL}"`);
  await mcp.slack.slackSendMessage({ channel_id: channelId, message: digest });
  console.log(`posted to #${CHANNEL}`);
}

main().catch((err: unknown) => {
  console.error(`standup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
