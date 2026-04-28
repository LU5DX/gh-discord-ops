/**
 * /diff <pr> [path] — show file diff(s) for a PR.
 *
 * Two modes:
 *   - Without `path`: list all changed files with their stats. Useful for
 *     "what's in this PR?" at a glance, beyond what /preview shows.
 *   - With `path`: show the unified diff for that single file in a
 *     ```ansi code block with explicit color escapes per line.
 *
 * Why ansi + content (not embed):
 *   ```diff blocks render +/- colors on desktop but not on Discord mobile.
 *   ```ansi works on both — *but* only when the block is in the message
 *   `content` field. Inside an embed `description`, mobile clients still
 *   strip the colors. So we put the ANSI block in content and reserve
 *   the embed for the title/link to the file on GitHub.
 *
 * Content has a 2000-char hard limit (vs 4096 in embeds). With ANSI
 * escapes the raw patch caps around 1700 chars before we hit the limit.
 */

import { parseRepoTarget, ShortcutMap } from "../repos";
import {
  listPullFiles,
  getPullRequest,
  GitHub,
  GitHubError,
  PullFile,
} from "../github";

const MAX_PATCH_CHARS = 1700;

const ANSI_RED = "[0;31m";
const ANSI_GREEN = "[0;32m";
const ANSI_CYAN = "[0;36m";
const ANSI_RESET = "[0m";

function colorizePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return line;
      if (line.startsWith("+")) return `${ANSI_GREEN}${line}${ANSI_RESET}`;
      if (line.startsWith("-")) return `${ANSI_RED}${line}${ANSI_RESET}`;
      if (line.startsWith("@@")) return `${ANSI_CYAN}${line}${ANSI_RESET}`;
      return line;
    })
    .join("\n");
}

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

/**
 * Autocomplete handler for the `path` option of /diff.
 *
 * Discord sends an APPLICATION_COMMAND_AUTOCOMPLETE interaction (type 4)
 * each time the user types in an autocomplete-enabled field. We need to
 * return up to 25 `{ name, value }` choices within ~3s.
 *
 * For /diff: read the already-entered `pr` value, fetch its files, and
 * fuzzy-filter by the substring the user has typed so far.
 *
 * Discord limits both `name` and `value` to 100 chars. Paths longer than
 * that get filtered out (rare in practice).
 */
export async function handleDiffPathAutocomplete(
  gh: GitHub,
  prArg: string,
  typed: string,
  shortcuts: ShortcutMap,
): Promise<Array<{ name: string; value: string }>> {
  const target = parseRepoTarget(prArg, shortcuts);
  if (!target) return [];

  let files: PullFile[];
  try {
    files = await listPullFiles(gh, target.owner, target.repo, target.number, 100);
  } catch {
    return [];
  }

  const needle = typed.toLowerCase();
  return files
    .filter((f) => f.filename.length <= 100)
    .filter((f) => needle === "" || f.filename.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((f) => ({ name: f.filename, value: f.filename }));
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
): { content?: string; embeds: DiscordEmbed[] } {
  const fileUrl = `${pr.html_url}/files#diff-${encodeURIComponent(file.filename)}`;
  const embed: DiscordEmbed = {
    title: `[${owner}/${repo}] PR #${pr.number} — ${file.filename}`,
    url: fileUrl,
    description: `**${file.status}** (+${file.additions} / -${file.deletions})`,
  };

  if (!file.patch) {
    return {
      content: "_(no patch available — file may be binary, too large, or only metadata changed)_",
      embeds: [embed],
    };
  }

  const truncated = truncate(file.patch, MAX_PATCH_CHARS);
  const content = "```ansi\n" + colorizePatch(truncated) + "\n```";

  return { content, embeds: [embed] };
}
