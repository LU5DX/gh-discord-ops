/**
 * /diff <pr> [path] — show file diff(s) for a PR.
 *
 * Two modes:
 *   - Without `path`: list all changed files with their stats. Useful for
 *     "what's in this PR?" at a glance, beyond what /preview shows.
 *   - With `path`: show the unified diff for that single file in a
 *     ```diff code block (Discord renders +/- coloring).
 *
 * Discord's embed description has a 4096-char limit. Patches commonly run
 * over that. We truncate at ~3800 chars (leaving headroom for fences and
 * a "truncated" notice) and link to the file on GitHub for the full view.
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import {
  listPullFiles,
  getPullRequest,
  GitHub,
  GitHubError,
  PullFile,
} from "../github";

const MAX_PATCH_CHARS = 3800;

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 50) + "\n... (truncated; see full file on GitHub)";
}

function formatFileList(files: PullFile[]): string {
  return files
    .map((f) => `- \`${f.filename}\` — ${f.status} (+${f.additions} / -${f.deletions})`)
    .join("\n");
}

export async function handleDiff(
  gh: GitHub,
  prArg: string,
  pathArg: string | undefined,
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
  let files: PullFile[];
  try {
    [pr, files] = await Promise.all([
      getPullRequest(gh, target.owner, target.repo, target.number),
      // Fetch up to 100 files. Larger PRs need pagination, deferred to v2.
      listPullFiles(gh, target.owner, target.repo, target.number, 100),
    ]);
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }

  // Mode 1: no path → list of files.
  if (!pathArg) {
    const list =
      files.length === 0
        ? "_(no files changed)_"
        : truncate(formatFileList(files), 3900);
    return {
      embeds: [
        {
          title: `[${target.owner}/${target.repo}] PR #${pr.number} files`,
          url: pr.html_url,
          description:
            list +
            (files.length > 0
              ? `\n\n_Pass a path to see the diff: \`/diff <pr> <path>\`_`
              : ""),
        },
      ],
    };
  }

  // Mode 2: single-file diff.
  const match = files.find((f) => f.filename === pathArg);
  if (!match) {
    // Try a fuzzy "endsWith" match before giving up — useful when the
    // user types just the filename without the directory prefix.
    const candidates = files.filter((f) => f.filename.endsWith(pathArg));
    if (candidates.length === 1) {
      return showSingleFile(gh, target.owner, target.repo, pr, candidates[0]);
    }
    if (candidates.length > 1) {
      return {
        content:
          `Multiple files match "\`${pathArg}\`":\n` +
          candidates.map((c) => `- \`${c.filename}\``).join("\n") +
          `\n\nPass the full path to disambiguate.`,
      };
    }
    return {
      content:
        `Path "\`${pathArg}\`" not found in PR #${pr.number}.\n\n` +
        `Available files:\n` +
        files.slice(0, 20).map((f) => `- \`${f.filename}\``).join("\n") +
        (files.length > 20 ? `\n_(... and ${files.length - 20} more)_` : ""),
    };
  }

  return showSingleFile(gh, target.owner, target.repo, pr, match);
}

function showSingleFile(
  _gh: GitHub,
  owner: string,
  repo: string,
  pr: { number: number; html_url: string },
  file: PullFile,
): { embeds: DiscordEmbed[] } {
  const fileUrl = `${pr.html_url}/files#diff-${encodeURIComponent(file.filename)}`;
  const patch = file.patch ?? "_(no patch available — file may be binary, too large, or only metadata changed)_";
  const body =
    "```diff\n" + truncate(patch, MAX_PATCH_CHARS) + "\n```";

  return {
    embeds: [
      {
        title: `[${owner}/${repo}] PR #${pr.number} — ${file.filename}`,
        url: fileUrl,
        description:
          `**${file.status}** (+${file.additions} / -${file.deletions})\n\n${body}`,
      },
    ],
  };
}
