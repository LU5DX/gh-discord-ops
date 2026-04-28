/**
 * /review <pr> <path> <line> <comment> — post an inline review comment
 * on a specific line of a PR's diff.
 *
 * Mirrors what GitHub's "comment on a line" UI does inside the Files
 * Changed tab. The comment is attached to the RIGHT side (new content)
 * of the diff. GitHub rejects (422) if the line isn't part of the PR's
 * actual changes — we surface that as a friendly error.
 *
 * The `path` option uses the same autocomplete handler as /diff, so
 * mobile users get the file dropdown instead of typing paths by hand.
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import {
  getPullRequest,
  postPullReviewComment,
  GitHub,
  GitHubError,
} from "../github";

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
}

export async function handleReview(
  gh: GitHub,
  prArg: string,
  path: string,
  line: number,
  comment: string,
  shortcuts: ShortcutMap,
): Promise<{ content?: string; embeds?: DiscordEmbed[] }> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the PR argument. Use a full GitHub URL or `<shortcut> <number>`.",
    };
  }

  if (!Number.isInteger(line) || line <= 0) {
    return { content: "❌ `line` must be a positive integer." };
  }
  if (!comment.trim()) {
    return { content: "❌ `comment` cannot be empty." };
  }

  let pr: Awaited<ReturnType<typeof getPullRequest>>;
  try {
    pr = await getPullRequest(gh, target.owner, target.repo, target.number);
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }

  try {
    const posted = await postPullReviewComment(
      gh,
      target.owner,
      target.repo,
      target.number,
      {
        body: comment,
        commit_id: pr.head.sha,
        path,
        line,
      },
    );
    return {
      embeds: [
        {
          title: `[${target.owner}/${target.repo}] PR #${pr.number} — comment posted`,
          url: posted.html_url,
          description:
            `📍 \`${path}\` line **${line}**\n\n` +
            `> ${comment.length > 200 ? comment.slice(0, 200) + "…" : comment}`,
        },
      ],
    };
  } catch (e) {
    if (e instanceof GitHubError) {
      // 422 typically means the line isn't part of the diff (i.e. user
      // tried to comment on an unchanged line). Surface that helpfully.
      if (e.status === 422) {
        return {
          content:
            `❌ GitHub rejected the comment (422). Most likely \`${path}\` ` +
            `line ${line} isn't part of this PR's diff — pick a line that ` +
            `was added or modified.\n\nDetails: ${e.details ?? ""}`,
        };
      }
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }
}
