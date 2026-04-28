/**
 * Thin GitHub REST API wrapper.
 *
 * Uses fetch() with a personal access token. No SDK dependency — keeps
 * the worker bundle small and avoids version drift with @octokit.
 *
 * Each function returns either a typed payload on success, or throws a
 * GitHubError with status + message extracted from the API response.
 */

const API_BASE = "https://api.github.com";

export class GitHubError extends Error {
  status: number;
  details?: string;
  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.details = details;
  }
}

export interface GitHub {
  pat: string;
}

export function makeGitHub(pat: string): GitHub {
  return { pat };
}

async function ghFetch(
  gh: GitHub,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${gh.pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-discord-ops/0.1",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function ghJson<T>(
  gh: GitHub,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await ghFetch(gh, path, init);
  if (!res.ok) {
    let details: string | undefined;
    try {
      const body = await res.json<{ message?: string; errors?: unknown }>();
      details = body.message ?? JSON.stringify(body);
    } catch {
      details = await res.text();
    }
    throw new GitHubError(
      res.status,
      `GitHub API ${res.status} ${res.statusText}`,
      details,
    );
  }
  return res.json<T>();
}

// Type definitions for the responses we use. Subset of the full API shape.

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  merged: boolean;
  user: { login: string };
  html_url: string;
  base: { ref: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  review_comments: number;
}

export interface PullFile {
  filename: string;
  status: string;  // "added" | "modified" | "removed" | "renamed" | etc
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface CheckRun {
  name: string;
  status: string;     // "queued" | "in_progress" | "completed"
  conclusion: string | null;  // "success" | "failure" | "neutral" | etc
  html_url: string;
}

export interface CheckRunsResponse {
  total_count: number;
  check_runs: CheckRun[];
}

export interface IssueComment {
  id: number;
  html_url: string;
  body: string;
}

export interface ReviewResponse {
  id: number;
  state: string;
  html_url: string;
}

export interface MergeResponse {
  sha: string;
  merged: boolean;
  message: string;
}

// API methods.

export function getPullRequest(
  gh: GitHub,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  return ghJson<PullRequest>(gh, `/repos/${owner}/${repo}/pulls/${number}`);
}

export function listPullFiles(
  gh: GitHub,
  owner: string,
  repo: string,
  number: number,
  perPage = 30,
): Promise<PullFile[]> {
  return ghJson<PullFile[]>(
    gh,
    `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${perPage}`,
  );
}

export function getCheckRunsForRef(
  gh: GitHub,
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckRunsResponse> {
  return ghJson<CheckRunsResponse>(
    gh,
    `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
  );
}

export function postIssueComment(
  gh: GitHub,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<IssueComment> {
  // Issue comments and PR comments share the same endpoint
  // (PRs are issues for purposes of comments).
  return ghJson<IssueComment>(
    gh,
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
}

export function approvePullRequest(
  gh: GitHub,
  owner: string,
  repo: string,
  number: number,
  message?: string,
): Promise<ReviewResponse> {
  return ghJson<ReviewResponse>(
    gh,
    `/repos/${owner}/${repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "APPROVE",
        body: message ?? "",
      }),
    },
  );
}

export function mergePullRequest(
  gh: GitHub,
  owner: string,
  repo: string,
  number: number,
  strategy: "merge" | "squash" | "rebase" = "squash",
): Promise<MergeResponse> {
  return ghJson<MergeResponse>(
    gh,
    `/repos/${owner}/${repo}/pulls/${number}/merge`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merge_method: strategy }),
    },
  );
}
