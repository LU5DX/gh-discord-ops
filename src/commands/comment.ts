/**
 * /comment <target> <text> — post a comment on a PR or issue.
 *
 * Returns the comment URL on success, or the error from GitHub on failure.
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import { postIssueComment, GitHub, GitHubError } from "../github";

export async function handleComment(
  gh: GitHub,
  targetArg: string,
  text: string,
  shortcuts: ShortcutMap,
): Promise<{ content: string }> {
  const target = parseRepoTarget(targetArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the target argument. Use a full GitHub URL or `<shortcut> <number>`.",
    };
  }
  if (!text || text.trim().length === 0) {
    return { content: "❌ Comment text is empty." };
  }

  try {
    const comment = await postIssueComment(
      gh,
      target.owner,
      target.repo,
      target.number,
      text,
    );
    return {
      content:
        `✅ Comment posted on \`${target.owner}/${target.repo}\` ` +
        `${target.kind === "issues" ? "issue" : "#"}${target.number}: ${comment.html_url}`,
    };
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }
}
