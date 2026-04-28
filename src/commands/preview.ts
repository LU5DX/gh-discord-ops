/**
 * /preview <pr> — show a Discord embed summarising a PR.
 *
 * Embed contents:
 *   - Title: "PR #N: <title> (state)"
 *   - URL link to the PR on GitHub
 *   - Body excerpt (truncated to keep within Discord's 4096-char embed limit)
 *   - Stats line: +additions / -deletions across N files
 *   - Files modified field: first ~10 file names
 *   - Mergeable / draft state line
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import {
  getPullRequest,
  listPullFiles,
  GitHub,
  GitHubError,
} from "../github";

const MAX_BODY_CHARS = 1500;
const MAX_FILES_LISTED = 10;

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

const COLOR_OPEN = 0x57f287;     // green
const COLOR_DRAFT = 0x99aab5;    // grey
const COLOR_MERGED = 0xa371f7;   // purple
const COLOR_CLOSED = 0xed4245;   // red

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function pickColor(state: string, draft: boolean, merged: boolean): number {
  if (merged) return COLOR_MERGED;
  if (state === "closed") return COLOR_CLOSED;
  if (draft) return COLOR_DRAFT;
  return COLOR_OPEN;
}

function stateLabel(state: string, draft: boolean, merged: boolean): string {
  if (merged) return "merged";
  if (state === "closed") return "closed";
  if (draft) return "draft";
  return "open";
}

export async function handlePreview(
  gh: GitHub,
  prArg: string,
  shortcuts: ShortcutMap,
): Promise<{ content?: string; embeds?: DiscordEmbed[] }> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the PR argument. Use a full GitHub URL or `<shortcut> <number>`. " +
        "Run `/help` to see configured shortcuts.",
    };
  }

  let pr: Awaited<ReturnType<typeof getPullRequest>>;
  let files: Awaited<ReturnType<typeof listPullFiles>>;
  try {
    [pr, files] = await Promise.all([
      getPullRequest(gh, target.owner, target.repo, target.number),
      listPullFiles(gh, target.owner, target.repo, target.number, MAX_FILES_LISTED + 1),
    ]);
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n\`\`\`\n${e.details ?? ""}\n\`\`\`` };
    }
    return { content: `❌ Unexpected error: ${(e as Error).message}` };
  }

  const fileNames = files.slice(0, MAX_FILES_LISTED).map((f) => `\`${f.filename}\``);
  const overflow = files.length > MAX_FILES_LISTED;
  const filesField =
    fileNames.length > 0
      ? fileNames.join("\n") + (overflow ? `\n_… and ${pr.changed_files - MAX_FILES_LISTED} more_` : "")
      : "_(none)_";

  const stateStr = stateLabel(pr.state, pr.draft, pr.merged);
  const mergeable =
    pr.merged
      ? "✅ already merged"
      : pr.mergeable === null
        ? "⏳ checking mergeable…"
        : pr.mergeable
          ? `✅ mergeable (${pr.mergeable_state})`
          : `❌ not mergeable (${pr.mergeable_state})`;

  const description = pr.body
    ? truncate(pr.body, MAX_BODY_CHARS)
    : "_(no body)_";

  const embed: DiscordEmbed = {
    title: `[${target.owner}/${target.repo}] PR #${pr.number}: ${pr.title}`,
    url: pr.html_url,
    description,
    color: pickColor(pr.state, pr.draft, pr.merged),
    fields: [
      { name: "State", value: stateStr, inline: true },
      { name: "Author", value: pr.user.login, inline: true },
      { name: "Branch", value: `${pr.head.ref} → ${pr.base.ref}`, inline: true },
      {
        name: "Stats",
        value: `+${pr.additions} -${pr.deletions} across ${pr.changed_files} file(s)`,
        inline: false,
      },
      { name: "Mergeable", value: mergeable, inline: false },
      { name: "Files", value: filesField, inline: false },
    ],
    footer: { text: "Use /diff to see a file's changes, /approve to approve, /merge to merge." },
  };

  return { embeds: [embed] };
}
