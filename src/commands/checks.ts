/**
 * /checks <pr> — show CI check status for a PR's head commit.
 *
 * Output: an embed listing each check run with its status, conclusion,
 * and link. Color-coded by overall result (green=all pass, red=any fail,
 * yellow=any in progress).
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import {
  getPullRequest,
  getCheckRunsForRef,
  GitHub,
  GitHubError,
  CheckRun,
} from "../github";

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

const COLOR_PASS = 0x57f287;
const COLOR_FAIL = 0xed4245;
const COLOR_RUN = 0xfee75c;
const COLOR_NEUTRAL = 0x99aab5;

function emojiFor(run: CheckRun): string {
  if (run.status !== "completed") return "⏳";
  switch (run.conclusion) {
    case "success":
      return "✅";
    case "failure":
    case "timed_out":
    case "cancelled":
      return "❌";
    case "neutral":
    case "skipped":
      return "➖";
    case "action_required":
      return "⚠️";
    default:
      return "❔";
  }
}

function summarize(runs: CheckRun[]): { color: number; line: string } {
  if (runs.length === 0) return { color: COLOR_NEUTRAL, line: "no checks" };
  const inProgress = runs.filter((r) => r.status !== "completed").length;
  const failed = runs.filter(
    (r) =>
      r.status === "completed" &&
      r.conclusion !== null &&
      ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion),
  ).length;
  const passed = runs.filter((r) => r.status === "completed" && r.conclusion === "success").length;
  if (failed > 0) return { color: COLOR_FAIL, line: `${failed} failing, ${passed} passing` };
  if (inProgress > 0) return { color: COLOR_RUN, line: `${inProgress} in progress, ${passed} passing` };
  return { color: COLOR_PASS, line: `${passed}/${runs.length} passing` };
}

export async function handleChecks(
  gh: GitHub,
  prArg: string,
  shortcuts: ShortcutMap,
): Promise<{ content?: string; embeds?: DiscordEmbed[] }> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the PR argument. Use a full GitHub URL or `<shortcut> <number>`.",
    };
  }
  let pr: Awaited<ReturnType<typeof getPullRequest>>;
  let runs: CheckRun[];
  try {
    pr = await getPullRequest(gh, target.owner, target.repo, target.number);
    const resp = await getCheckRunsForRef(gh, target.owner, target.repo, pr.head.sha);
    runs = resp.check_runs;
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }

  const summary = summarize(runs);
  const lines = runs.map((r) => {
    const status = r.status === "completed" ? r.conclusion ?? "?" : r.status;
    return `${emojiFor(r)} [${r.name}](${r.html_url}) — ${status}`;
  });

  return {
    embeds: [
      {
        title: `[${target.owner}/${target.repo}] PR #${pr.number} checks`,
        url: pr.html_url,
        description:
          (lines.join("\n") || "_no checks reported for the head commit_") +
          `\n\n**Summary**: ${summary.line}`,
        color: summary.color,
      },
    ],
  };
}
