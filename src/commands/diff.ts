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

/** Worst-case raw-patch size before colorization. Picked so that even a
 *  patch of 100% short +/- lines (max ANSI overhead) fits under Discord's
 *  2000-char content limit. A second hard check below truncates further
 *  if the colorized result still overshoots. */
const MAX_PATCH_CHARS = 1200;
const CONTENT_HARD_LIMIT = 1980;

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

interface DiscordButton {
  type: 2; // BUTTON
  label: string;
  style: 1 | 2 | 3 | 4; // 1=primary, 2=secondary, 3=success, 4=danger
  custom_id: string;
}

interface DiscordActionRow {
  type: 1; // ACTION_ROW
  components: DiscordButton[];
}

type DiffReply = {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
};

/**
 * Encode the state needed to navigate to file index `idx` of a PR's files.
 * Discord's button custom_id has a 100-char limit; we keep this short.
 *
 * Format: dn:<owner>:<repo>:<pr>:<idx>
 *   "dn" = diff_nav (abbreviated to leave room for long owner/repo names)
 */
function encodeNavId(owner: string, repo: string, prNumber: number, idx: number): string {
  return `dn:${owner}:${repo}:${prNumber}:${idx}`;
}

export interface DiffNavState {
  owner: string;
  repo: string;
  prNumber: number;
  idx: number;
}

export function decodeNavId(customId: string): DiffNavState | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || parts[0] !== "dn") return null;
  const [, owner, repo, prStr, idxStr] = parts;
  const prNumber = parseInt(prStr, 10);
  const idx = parseInt(idxStr, 10);
  if (!Number.isFinite(prNumber) || !Number.isFinite(idx)) return null;
  return { owner, repo, prNumber, idx };
}

function navButtons(
  owner: string,
  repo: string,
  prNumber: number,
  idx: number,
  total: number,
): DiscordActionRow[] {
  if (total <= 1) return [];
  const prevIdx = (idx - 1 + total) % total;
  const nextIdx = (idx + 1) % total;
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          label: "⬅ Prev",
          style: 2,
          custom_id: encodeNavId(owner, repo, prNumber, prevIdx),
        },
        {
          type: 2,
          label: "Next ➡",
          style: 2,
          custom_id: encodeNavId(owner, repo, prNumber, nextIdx),
        },
      ],
    },
  ];
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
): Promise<DiffReply> {
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
  const exactIdx = files.findIndex((f) => f.filename === pathArg);
  if (exactIdx >= 0) {
    return showSingleFile(target.owner, target.repo, pr, files, exactIdx);
  }

  // Try a fuzzy "endsWith" match before giving up — useful when the
  // user types just the filename without the directory prefix.
  const candidateIdxs = files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.filename.endsWith(pathArg));
  if (candidateIdxs.length === 1) {
    return showSingleFile(target.owner, target.repo, pr, files, candidateIdxs[0].i);
  }
  if (candidateIdxs.length > 1) {
    return {
      content:
        `Multiple files match "\`${pathArg}\`":\n` +
        candidateIdxs.map(({ f }) => `- \`${f.filename}\``).join("\n") +
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

/**
 * Handler for the prev/next navigation buttons attached to a single-file
 * diff. Called when Discord sends a MESSAGE_COMPONENT interaction whose
 * custom_id we encoded via {@link encodeNavId}.
 *
 * Re-fetches the PR's files (the worker is stateless), validates the
 * (owner, repo) is in the configured whitelist, and renders the file at
 * the requested index. Returns the same shape as showSingleFile so the
 * caller can decide between "send" and "update" interaction responses.
 */
export async function handleDiffNav(
  gh: GitHub,
  state: DiffNavState,
  shortcuts: ShortcutMap,
): Promise<DiffReply> {
  const allowed = new Set(Object.values(shortcuts));
  if (!allowed.has(`${state.owner}/${state.repo}`)) {
    return { content: "❌ Repo no longer in scope." };
  }

  let pr: Awaited<ReturnType<typeof getPullRequest>>;
  let files: PullFile[];
  try {
    [pr, files] = await Promise.all([
      getPullRequest(gh, state.owner, state.repo, state.prNumber),
      listPullFiles(gh, state.owner, state.repo, state.prNumber, 100),
    ]);
  } catch (e) {
    if (e instanceof GitHubError) {
      return { content: `❌ GitHub error: ${e.message}\n${e.details ?? ""}` };
    }
    return { content: `❌ ${(e as Error).message}` };
  }

  if (files.length === 0) return { content: "_(no files in PR)_" };
  const idx = ((state.idx % files.length) + files.length) % files.length;
  return showSingleFile(state.owner, state.repo, pr, files, idx);
}

function showSingleFile(
  owner: string,
  repo: string,
  pr: { number: number; html_url: string },
  files: PullFile[],
  idx: number,
): DiffReply {
  const file = files[idx];
  const total = files.length;
  const fileUrl = `${pr.html_url}/files#diff-${encodeURIComponent(file.filename)}`;
  const position = total > 1 ? ` · file ${idx + 1}/${total}` : "";
  const embed: DiscordEmbed = {
    title: `[${owner}/${repo}] PR #${pr.number} — ${file.filename}`,
    url: fileUrl,
    description: `**${file.status}** (+${file.additions} / -${file.deletions})${position}`,
  };
  const components = navButtons(owner, repo, pr.number, idx, total);

  if (!file.patch) {
    return {
      content: "_(no patch available — file may be binary, too large, or only metadata changed)_",
      embeds: [embed],
      components,
    };
  }

  const truncated = truncate(file.patch, MAX_PATCH_CHARS);
  let content = "```ansi\n" + colorizePatch(truncated) + "\n```";

  // Belt-and-suspenders: ANSI overhead is line-count-dependent, so the
  // raw-char cap above can still produce content >2000. Discord silently
  // rejects anything over the limit ("This interaction failed"). Cut more
  // aggressively if needed, on a newline boundary so we don't split an
  // ANSI escape in half.
  if (content.length > CONTENT_HARD_LIMIT) {
    const head = "```ansi\n";
    const tail = `${ANSI_RESET}\n... (truncated; see full file on GitHub)\n` + "```";
    const bodyBudget = CONTENT_HARD_LIMIT - head.length - tail.length;
    const colored = colorizePatch(truncated);
    const cut = colored.lastIndexOf("\n", bodyBudget);
    const safeBody = cut > 0 ? colored.slice(0, cut) : colored.slice(0, bodyBudget);
    content = head + safeBody + tail;
  }

  return { content, embeds: [embed], components };
}
