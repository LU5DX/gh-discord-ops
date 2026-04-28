/**
 * /merge <pr> [strategy] — merge a PR.
 *
 * Default strategy: squash. Other valid values: merge, rebase. The strategy
 * choices are constrained at the slash-command level, so by the time this
 * handler runs the value is already validated.
 *
 * Common errors surfaced:
 *   - 405: PR is not in a mergeable state (conflicts, required reviews, etc).
 *   - 409: head ref doesn't match expected (someone pushed during the merge).
 *   - 422: validation (e.g., draft PR can't be merged).
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import { mergePullRequest, GitHub, GitHubError } from "../github";

type MergeStrategy = "merge" | "squash" | "rebase";

const VALID_STRATEGIES: MergeStrategy[] = ["merge", "squash", "rebase"];

export async function handleMerge(
  gh: GitHub,
  prArg: string,
  strategyArg: string | undefined,
  shortcuts: ShortcutMap,
): Promise<{ content: string }> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) {
    return {
      content:
        "Couldn't parse the PR argument. Use a full GitHub URL or `<shortcut> <number>`.",
    };
  }
  const strategy: MergeStrategy =
    strategyArg && VALID_STRATEGIES.includes(strategyArg as MergeStrategy)
      ? (strategyArg as MergeStrategy)
      : "squash";

  try {
    const result = await mergePullRequest(
      gh,
      target.owner,
      target.repo,
      target.number,
      strategy,
    );
    return {
      content:
        `✅ Merged \`${target.owner}/${target.repo}\` PR #${target.number} ` +
        `via **${strategy}** (sha: \`${result.sha.slice(0, 7)}\`).`,
    };
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ Merge failed (${e.status}): ${e.details ?? e.message}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }
}
