/**
 * /approve <pr> [message] — submit an APPROVE review on a PR.
 *
 * GitHub returns 422 if you try to approve your own PR (most common reason
 * this errors). The error message is surfaced verbatim so the user knows
 * why.
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import { approvePullRequest, GitHub, GitHubError } from "../github";

export async function handleApprove(
  gh: GitHub,
  prArg: string,
  message: string | undefined,
  shortcuts: ShortcutMap,
): Promise<{ content: string }> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the PR argument. Use a full GitHub URL or `<shortcut> <number>`.",
    };
  }
  try {
    const review = await approvePullRequest(
      gh,
      target.owner,
      target.repo,
      target.number,
      message,
    );
    return {
      content:
        `✅ Approved \`${target.owner}/${target.repo}\` PR #${target.number}: ${review.html_url}`,
    };
  } catch (e) {
    if (e instanceof GitHubError) {
      const note =
        e.status === 422
          ? "\n\n_(Reminder: GitHub doesn't allow approving your own PRs. " +
            "If you want to mark a self-authored PR as ready, set `auto_merge` " +
            "or just merge it directly.)_"
          : "";
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}${note}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }
}
