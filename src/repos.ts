/**
 * Repo addressing: parses the user's `pr` / `target` argument into a
 * concrete (owner, repo, number) tuple, accepting either:
 *
 *   - A full GitHub URL: `https://github.com/<owner>/<repo>/pull/12`
 *     (also accepts /issues/12 since `comment` may target an issue).
 *   - A shortcut + number: e.g. `<shortcut> 12`. Shortcuts are configured
 *     per deployment via the REPO_SHORTCUTS_JSON Worker secret.
 *
 * Returns null if the input doesn't match either form, or if the URL points
 * to a repo outside the configured shortcut whitelist.
 *
 * The whitelist is "any repo named in the SHORTCUTS map". Full-URL inputs
 * are checked against it too, so a leaked PAT can't be used to act on
 * arbitrary repos via the bot.
 */

export type ShortcutMap = Record<string, string>;

export interface RepoTarget {
  owner: string;
  repo: string;
  number: number;
  /** "pull" or "issues" — preserved from URL form; defaults to "pull" for shortcut form. */
  kind: "pull" | "issues";
}

/**
 * Parse the JSON string from the REPO_SHORTCUTS_JSON secret into a map.
 * Returns an empty map on missing / malformed input (the bot still works
 * for full-URL inputs whose repo happens to also be in the empty map …
 * which it isn't, so effectively the bot rejects everything until you
 * configure shortcuts).
 */
export function parseShortcutMap(json: string | undefined | null): ShortcutMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ShortcutMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v)) {
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function parseRepoTarget(
  input: string,
  shortcuts: ShortcutMap,
): RepoTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const allowed = new Set(Object.values(shortcuts));

  // Form 1: full URL.
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/i,
  );
  if (urlMatch) {
    const [, owner, repo, kind, numStr] = urlMatch;
    const fullName = `${owner}/${repo}`;
    if (!allowed.has(fullName)) return null;
    const number = parseInt(numStr, 10);
    if (!Number.isFinite(number) || number <= 0) return null;
    return { owner, repo, number, kind: kind.toLowerCase() as "pull" | "issues" };
  }

  // Form 2: shortcut + number, separated by whitespace.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2) return null;
  const [shortcut, numStr] = parts;
  const fullName = shortcuts[shortcut.toLowerCase()];
  if (!fullName) return null;
  const number = parseInt(numStr, 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  const [owner, repo] = fullName.split("/");
  return { owner, repo, number, kind: "pull" };
}

export function listShortcuts(shortcuts: ShortcutMap): string {
  const entries = Object.entries(shortcuts);
  if (entries.length === 0) return "(none configured — set REPO_SHORTCUTS_JSON)";
  return entries.map(([k, v]) => `\`${k}\` → ${v}`).join(", ");
}
