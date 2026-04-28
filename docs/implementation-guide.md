# GitHub ↔ Discord Integration — Implementation Guide

This guide walks through building two independent integrations that put your
GitHub workflow inside Discord. Aimed at solo developers and small teams who
want a low-friction Discord-as-control-surface for their repos.

1. **Discord's built-in GitHub webhook** — automatic embeds in a Discord
   channel when PRs, issues, and pushes happen on a GitHub repo. No code
   to write; ~5 min of clicking. Section 1 below.
2. **Custom slash-command bot** — `/preview`, `/comment`, `/approve`,
   `/merge`, `/diff`, `/checks` against your repos, callable from any
   channel. Cloudflare Worker, Discord interactions, GitHub PAT.
   ~6 hours of work the first time, mostly setup not code. Section 2 below.

The two integrations complement each other: GitHub events flow *into*
Discord via the webhook, you act on them *out* of Discord via the bot.

This guide is reproducible from scratch — pick any application name, any
shortcuts, any set of repos. This repo (`gh-discord-ops`) has the working
scaffold you can clone as a starting point and adapt to your naming.

---

## Table of contents

- [Section 1: GitHub webhook → Discord embeds](#section-1-github-webhook--discord-embeds)
  - [What it does](#what-it-does)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
  - [Verification](#verification)
  - [Maintenance and rotation](#maintenance-and-rotation)
- [Section 2: Custom Discord ops bot](#section-2-custom-discord-ops-bot)
  - [Architecture](#architecture)
  - [Auth model](#auth-model)
  - [Prerequisites](#prerequisites-1)
  - [Step 1: create the Discord application](#step-1-create-the-discord-application)
  - [Step 2: invite the bot to your server](#step-2-invite-the-bot-to-your-server)
  - [Step 3: collect the IDs you need](#step-3-collect-the-ids-you-need)
  - [Step 4: scaffold the Cloudflare Worker project](#step-4-scaffold-the-cloudflare-worker-project)
  - [Step 5: implement signature verification and command dispatch](#step-5-implement-signature-verification-and-command-dispatch)
  - [Step 6: implement command handlers](#step-6-implement-command-handlers)
  - [Step 7: register slash commands with Discord](#step-7-register-slash-commands-with-discord)
  - [Step 8: deploy the Worker and wire the endpoint URL](#step-8-deploy-the-worker-and-wire-the-endpoint-url)
  - [Step 9: test](#step-9-test)
- [Common errors](#common-errors)
- [Maintenance, rotation, and extension](#maintenance-rotation-and-extension)
- [Cost and limits](#cost-and-limits)

---

## Section 1: GitHub webhook → Discord embeds

### What it does

When a PR is opened, an issue is commented, a push lands, etc., Discord
renders a clean embed in your chosen channel:

```
[org/repo] Pull request opened: #42 Fix layout regression on small screens
Summary
Fixes #41
What was changed
Header truncates correctly when the viewport is below 360px wide.
Files modified
  src/components/Header.tsx
  src/styles/header.css
  src/components/Header.tsx | 6 ++++--
  src/styles/header.css     | 4 ++--
  2 files changed, 6 insertions(+), 4 deletions(-)
---
Opened automatically by your CI bot
```

The header (`[org/repo] Pull request opened: ...`) is auto-formatted by
Discord. The body comes from the PR description rendered as markdown.
If your PR body uses `## Summary`, `## What was changed`, etc., the
embed gets that structure for free.

### Prerequisites

- A Discord server you administer.
- A Discord channel for these embeds. (Recommend a dedicated channel like
  `#github-events` so embeds don't drown out conversation.)
- Repo admin access on each GitHub repo you want to integrate.

### Setup

For each `(repo, channel)` pair, ~5 minutes.

#### 1. Create a Discord webhook in the target channel

In Discord:

1. Right-click the channel → **Edit Channel**.
2. **Integrations** → **Webhooks** → **New Webhook**.
3. Name it (e.g., `GitHub events`). Optionally set an avatar.
4. **Copy Webhook URL**. It looks like:

   ```
   https://discord.com/api/webhooks/<webhook_id>/<token>
   ```

   Save this somewhere private; treat it like a password (anyone with
   the URL can post to that channel as the webhook bot).

#### 2. Append `/github` to the URL

Discord exposes a special endpoint that auto-renders GitHub events when
you append `/github` to a webhook URL:

```
https://discord.com/api/webhooks/<webhook_id>/<token>/github
                                                       ^^^^^^
```

This is the URL you give to GitHub.

#### 3. Configure the webhook in the GitHub repo

For each repo:

1. Go to `https://github.com/<owner>/<repo>/settings/hooks/new`.
2. **Payload URL**: paste the URL with `/github` appended.
3. **Content type**: `application/json`.
4. **Secret**: leave blank (Discord doesn't validate secrets on the
   `/github` endpoint).
5. **SSL verification**: Enable (default).
6. **Which events?** Select **"Let me select individual events"** and
   tick at least:
   - `Pull requests`
   - `Issues`
   - `Pushes`
   - (Optional: `Issue comments`, `Pull request reviews`, `Releases` —
     each adds noise but useful events.)
7. **Active**: ✅ (default).
8. Click **Add webhook**.

Repeat per repo.

If you prefer scripted setup, you can do it via the GitHub API. Note:
PowerShell mangles the bracket syntax that `gh api -f` uses for nested
fields, so use the JSON-via-stdin form:

```powershell
$webhook = "https://discord.com/api/webhooks/<id>/<token>/github"
$body = @{
  name = "web"
  active = $true
  config = @{
    url = $webhook
    content_type = "json"
  }
  events = @("pull_request", "issues", "push")
} | ConvertTo-Json -Compress
$body | gh api -X POST repos/<owner>/<repo>/hooks --input -
```

In Bash the `--field`/`-f` form works without quoting issues:

```bash
gh api -X POST repos/<owner>/<repo>/hooks \
  --field name=web \
  --field active=true \
  --field config[url]="$WEBHOOK" \
  --field config[content_type]=json \
  --field events[]=pull_request \
  --field events[]=issues \
  --field events[]=push
```

### Verification

GitHub fires a `ping` event to the webhook the moment you create it.
Verify it succeeded:

```bash
gh api repos/<owner>/<repo>/hooks/<hook_id>/deliveries \
  --jq '.[0] | {event, status, status_code, delivered_at}'
```

You want to see `status: "OK"` and `status_code: 204`. (Discord
acknowledges with 204 No Content even though it doesn't render anything
visible for the ping event.)

End-to-end check: open a test issue in the repo. Discord should show
an `[org/repo] Issue opened: #N <title>` embed within seconds. Close
the issue afterwards.

### Maintenance and rotation

- **Webhook URL doesn't expire.** No periodic renewal needed.
- **Rotation** if leaked: in Discord, delete the webhook and create a
  new one (gives a new URL). Update the GitHub repo's webhook config
  with the new URL. Old URL goes immediately dead.
- **Recent deliveries**: GitHub's webhook page on a repo shows the last
  N requests with their full payload and Discord's response. Useful
  for debugging when an event seems to have not fired.

---

## Section 2: Custom Discord ops bot

### Architecture

```
Discord client                                       GitHub
     |                                                 ^
     | (1) /preview en 12                              |
     v                                                 |
  Discord servers                                      |
     |                                                 |
     | (2) HTTPS POST with Ed25519 signature           |
     v                                                 |
  Cloudflare Worker (this code)                        |
     |  - verify signature against PUBLIC_KEY          |
     |  - check caller's user ID == OWNER_ID           |
     |  - dispatch to command handler                  |
     |  - call GitHub REST API with PAT --------------->
     |                                                 |
     | (3) JSON response (embed)                       |
     v                                                 |
  Discord client renders the embed
```

Per request: Discord signs with Ed25519, our worker verifies the signature
using the application's public key (which is what the dev portal calls
`PUBLIC_KEY`). If the signature is valid, the worker is the only thing
that knows the user ran the command — there's no shared secret to leak.

### Auth model

- **GitHub side**: a single Personal Access Token (PAT) acts as the bot's
  identity. Every comment, review, merge is attributed to the PAT owner.
  Pros: simple. Cons: bot identity = your identity (if someone else uses
  the bot, their actions look like yours).
  - The recommended pattern for solo developers.
  - For teams, switch to a GitHub App with OAuth-on-behalf-of-user. Out
    of scope for this v1 guide.
- **Discord side**: signature verification + owner-ID check. Only the
  Discord user whose ID matches `DISCORD_OWNER_ID` can invoke commands.
  Anyone else gets a polite "❌ not authorized" reply.

### Prerequisites

- A Cloudflare account (free tier is more than enough). Sign up at
  [cloudflare.com](https://cloudflare.com).
- A Discord account with a server you administer.
- Node.js installed locally (any LTS — used for `wrangler` and the
  `register-commands.mjs` script).
- A GitHub PAT with the right scopes (see Step 4).

### Step 1: create the Discord application

1. Go to <https://discord.com/developers/applications>.
2. Click **New Application**, name it (e.g., `<your-handle>-ops`), accept terms.
3. On the **General Information** page:
   - Note the **APPLICATION ID** (also called Client ID).
   - Note the **PUBLIC KEY** (lower in the page; ~64 hex chars).
4. **Bot** tab in the left sidebar:
   - Discord auto-creates a bot user. Click **Reset Token** (or **Copy
     Token** if it's brand new). Save the token in a password manager.
     This is the **BOT TOKEN**; it's a real secret (anyone with it can
     act as the bot).
   - Disable **Public Bot** toggle (we don't want random installs).
   - Note the warning Discord shows: *"Private bots cannot have a
     default authorization link."* This is informational, not an error
     — for a private bot you generate the install URL manually in step 2.

> Common gotcha: if the **Save Changes** banner is stuck and won't go
> away, make sure the **Default Install Settings** section's
> **Install Link** is set to `None` (private bots can't use Discord's
> auto-generated link).

### Step 2: invite the bot to your server

Still in the developer portal:

1. **OAuth2** → **URL Generator**.
2. **Scopes**: tick `applications.commands` and `bot`.
3. Once `bot` is ticked, a **Bot Permissions** section appears below.
   Tick `Send Messages` and `Embed Links`. Leave everything else off.
4. Copy the **Generated URL** at the bottom of the page.
5. Open that URL in a browser. Discord prompts you to choose a server.
   Pick yours, click **Authorize**.

The bot now appears in your server's member list, but it's not yet
listening to anything (we haven't registered slash commands or wired
up the worker).

### Step 3: collect the IDs you need

You'll need four numeric IDs for the rest of the setup. None of them
are secrets — they're just identifiers.

| ID | Where to find it |
|---|---|
| `APPLICATION_ID` | Discord dev portal → your app → General Information |
| `PUBLIC_KEY` | Same page, lower |
| `OWNER_ID` (your Discord user ID) | See below |
| `GUILD_ID` (your server's ID) | See below |

To get **OWNER_ID** and **GUILD_ID**:

1. In Discord: **Settings** (gear icon next to your username, bottom
   left) → **Advanced** → toggle **Developer Mode** on.
2. Close Settings.
3. **Right-click your own avatar/name** in the bottom-left of the
   client window → **Copy User ID**. That's `OWNER_ID`.
4. **Right-click the server icon** in the left sidebar → **Copy Server
   ID**. That's `GUILD_ID`.

> If "Copy User ID" doesn't appear in the right-click menu, Developer
> Mode is not actually on. Re-check the toggle and try a fresh
> right-click.

### Step 4: scaffold the Cloudflare Worker project

Layout we'll build:

```
.
├── src/
│   ├── index.ts          # worker entry: dispatches commands
│   ├── verify.ts         # Ed25519 signature verification
│   ├── github.ts         # GitHub REST API wrapper
│   ├── repos.ts          # repo addressing (URL parser + shortcuts)
│   └── commands/
│       ├── preview.ts
│       ├── diff.ts
│       ├── comment.ts
│       ├── approve.ts
│       ├── merge.ts
│       └── checks.ts
├── scripts/
│   └── register-commands.mjs   # one-off slash command registration
├── wrangler.toml
├── package.json
├── tsconfig.json
└── README.md
```

The actual files are in this repo — clone it as a starting template
or copy what you need. The skeleton fits in ~300 lines of TypeScript
+ ~150 lines of registration script.

Project-creation steps:

```bash
# Empty directory, init git, etc.
mkdir my-discord-ops && cd my-discord-ops
git init

# Initialize with our scaffold (copy from this repo or create from scratch)

# Install wrangler:
npm init -y
npm install --save-dev wrangler typescript @cloudflare/workers-types
```

#### Generate the GitHub PAT

The PAT goes into the worker as a secret in step 8. Generate it now so
you have it ready.

1. <https://github.com/settings/personal-access-tokens> → **Generate new
   token** → **Fine-grained personal access token**.
2. **Token name**: e.g., `discord-ops-bot`.
3. **Expiration**: 1 year (recommended; set a calendar reminder to
   renew).
4. **Repository access**: **Only select repositories** → pick the
   exact repos the bot will operate on. (Less is more — minimize the
   blast radius if the token leaks.)
5. **Permissions** → **Repository permissions**:
   - **Contents**: Read and write (for merges and comment edits)
   - **Pull requests**: Read and write
   - **Issues**: Read and write
   - **Metadata**: Read (default, can't disable)
   - Leave everything else at "No access".
6. **Generate token**, copy it (`github_pat_...`).

### Step 5: implement signature verification and command dispatch

The worker is one file — `src/index.ts` — that:
1. Receives the HTTP POST from Discord.
2. Reads the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers
   plus the raw body.
3. Verifies the signature against the application's public key using
   `crypto.subtle.verify(...)` (Web Crypto API).
4. Parses the JSON body.
5. If `type === 1` (PING): responds with `{ type: 1 }` (PONG). Discord
   uses this when you first wire the endpoint URL.
6. If `type === 2` (APPLICATION_COMMAND): looks at `data.name`,
   dispatches to a per-command handler.
7. Returns `{ type: 4, data: { content: "...", flags: 64 } }` so
   replies are ephemeral (only the invoker sees them).

The full implementation is in `src/index.ts` and `src/verify.ts` of
this repo; reuse them.

### Step 6: implement command handlers

Each command is a single file under `src/commands/` exporting a
function that takes the GitHub client + parsed arguments and returns
either a `{ content }` (plain text) or `{ embeds }` (Discord embeds).

We use a tiny GitHub REST wrapper (`src/github.ts`, ~200 lines) instead
of `@octokit/rest`. Cuts the bundle size and avoids version drift.

The repo addressing (`src/repos.ts`) accepts two forms for each `pr`
or `target` argument:

- A full GitHub URL: `https://github.com/<owner>/<repo>/pull/12`
- A shortcut + number: `<shortcut> 12`. Define your shortcuts at the
  top of `src/repos.ts`. We also enforce a whitelist of allowed repos
  so a leaked PAT can't be used to act on arbitrary repos.

### Step 7: register slash commands with Discord

Discord requires you to declare your slash commands ahead of time. The
`scripts/register-commands.mjs` file POSTs your `COMMANDS` array to
the Discord API (PUT, which replaces the entire command set
atomically).

```bash
export DISCORD_APP_ID=<your-app-id>
export DISCORD_BOT_TOKEN=<your-bot-token>   # secret
export DISCORD_GUILD_ID=<your-server-id>    # optional but recommended
node scripts/register-commands.mjs
```

`DISCORD_GUILD_ID` makes the commands appear in *that* server only,
within seconds. Without it, registration is global and Discord caches
it for up to an hour. For initial development always use `DISCORD_GUILD_ID`
— iteration becomes painful otherwise.

To add a new command later: edit the `COMMANDS` array, run
`node scripts/register-commands.mjs` again. The PUT semantics replace
the whole set, so deleted entries are removed cleanly.

> **Slash commands vs. plain text.** When typing in Discord, slash
> commands appear in a coloured autocomplete popup as you type `/`.
> The arguments are filled in as separate labelled fields, not as one
> string. If you type `/preview en 12` as a single line of text and
> hit Enter, Discord treats it as a normal message — your bot is not
> invoked. Always pick the command from the autocomplete dropdown.

### Step 8: deploy the Worker and wire the endpoint URL

#### 8a. Authenticate with Cloudflare

```bash
npx wrangler login
```

A browser window opens for OAuth. Click Authorize quickly — wrangler
runs a local callback server (typically on `localhost:8976`) that
times out after about 30 seconds.

> If the browser shows "Firefox can't connect to the server at
> localhost:8976" after you click Authorize, wrangler's local server
> already exited. Re-run `wrangler login` and Authorize faster. As a
> fallback, use API token auth instead of OAuth:
>
> 1. Go to <https://dash.cloudflare.com/profile/api-tokens> → Create
>    Token → "Edit Cloudflare Workers" template.
> 2. Copy the token.
> 3. `export CLOUDFLARE_API_TOKEN=<token>`. Wrangler will pick it up.

#### 8b. Set up your workers.dev subdomain

If this is the first Worker in your Cloudflare account, you need to
choose a subdomain like `<you>.workers.dev`. In the dashboard:

1. **Compute** in the sidebar (formerly **Workers & Pages**; the
   dashboard reorganized recently — Workers now lives under Compute).
2. There will be a prompt to choose a subdomain on first use. Pick
   something short and memorable; it applies to *all* Workers in your
   account.

#### 8c. Set the Worker secrets

Three secrets, each prompts for its value (it isn't echoed in the
terminal nor stored in shell history):

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY    # paste your PUBLIC_KEY
npx wrangler secret put DISCORD_OWNER_ID      # paste your OWNER_ID
npx wrangler secret put GITHUB_PAT            # paste the PAT from step 4
```

For each, if wrangler asks "There doesn't seem to be a Worker called
`<name>`. Do you want to create a new Worker?" — answer **Y**. Wrangler
creates an empty Worker first; the actual code is uploaded by `deploy`.

#### 8d. Deploy

```bash
npx wrangler deploy
```

The output ends with a URL like
`https://<worker-name>.<your-subdomain>.workers.dev`. That's the
**Interactions Endpoint URL** Discord will use.

#### 8e. Wire the endpoint URL into Discord

1. <https://discord.com/developers/applications> → your app.
2. **General Information** → **Interactions Endpoint URL** field.
3. Paste the worker URL.
4. Click **Save Changes**.

Discord immediately POSTs a PING to the URL, expects PONG. If the
worker's signature verification + PING handler are wired right (use
the code in this repo), Discord saves the URL. If something's wrong,
the field stays unsaved and Discord shows an error like
"Interactions Endpoint URL could not be verified".

To debug a verification failure: tail the worker's logs in real time:

```bash
npx wrangler tail
```

Then click Save Changes again. The tail shows the incoming POST and
any error or status code returned. Common issues:
- `DISCORD_PUBLIC_KEY` mismatch → 401 returned, Discord rejects.
- Worker not deployed → 404 or DNS failure.
- Worker deployed but throws on PING → 500 returned.

### Step 9: test

In any channel of your server, type `/`. Discord's autocomplete
popup should show all your commands. Pick `/help`, send. Within ~1
second you should see an ephemeral reply listing the commands.

If `/help` works, every command using GitHub (`/preview`, `/comment`,
etc.) should also work — they share signature verification, owner
authorization, and dispatch. The only differences are the GitHub API
calls, which fail loud (the bot replies with the error message).

End-to-end test against a real issue or PR:

```
/comment
  target: <shortcut> <issue-or-pr-number>      OR a full URL
  text:   test from the bot
```

The bot replies with `✅ Comment posted on <repo> #N: <link>`. Click
the link to verify the comment is on GitHub.

---

## Common errors

A reference of issues we hit during the original implementation, with
fixes.

### `Save` button greyed out / "private bots cannot have a default authorization link"

The **Default Install Settings** section's **Install Link** field is
set to "Discord Provided Link", which conflicts with **Public Bot:
OFF**. Change Install Link to **None** and Save Changes will work.

### `wrangler login` browser shows "can't connect to localhost:8976"

Wrangler's local OAuth callback server timed out (~30s). Either click
Authorize faster on the next attempt, or use API token auth instead
(see step 8a).

### `wrangler deploy` says "You need to register a workers.dev subdomain before publishing"

First-time Cloudflare Workers user. Go to the dashboard, **Compute**
section (formerly **Workers & Pages**), and there's a prompt to choose
a subdomain. Pick one, save, re-run `wrangler deploy`.

### `gh api -F config[url]=...` silently fails on PowerShell

PowerShell mangles the bracket syntax. Use the JSON-via-stdin form or
do it via the GitHub web UI. Or run from `bash` instead.

### Slash commands typed as text don't trigger the bot

You typed `/preview en 12` as a regular message instead of selecting
the command from the autocomplete dropdown. Discord only sends
slash-command interactions when you pick the command from the dropdown
and fill in its labelled fields.

### Discord shows "The application did not respond"

The worker exceeded Discord's 3-second response budget, or threw an
unhandled exception. Tail the worker (`npx wrangler tail`), reproduce
the error, read the log. Most likely an unhandled exception in a
command handler — wrap GitHub API calls in try/catch and return an
error reply explicitly.

### GitHub API returns 404 on a repo or issue you know exists

Either:
- The PAT doesn't have access to that repo (fine-grained PATs only
  see the repos you list during creation; check at
  <https://github.com/settings/personal-access-tokens>).
- The number you specified doesn't exist in that repo (e.g., issue
  #5 in repo A is not the same as #5 in repo B).

---

## Maintenance, rotation, and extension

### PAT rotation (annually)

Set a calendar reminder for ~11 months after creation.

```bash
# Generate a new fine-grained PAT in the GitHub UI, then:
npx wrangler secret put GITHUB_PAT       # paste the new one

# Revoke the old PAT in GitHub (Settings → Developer settings →
# Personal access tokens → Fine-grained → click the old one → Revoke).
```

### Bot token rotation (only if leaked)

The bot token is only used by `register-commands.mjs`, never by the
running Worker. If it leaks: regenerate in the Discord dev portal
(**Bot** → **Reset Token**), update your shell env var when running
`register-commands.mjs`. No worker redeploy needed.

### Adding a new command

1. Add an entry to the `COMMANDS` array in
   `scripts/register-commands.mjs` — name, description, options.
2. Add a new case to the dispatch switch in `src/index.ts`.
3. Implement a handler in `src/commands/<name>.ts`.
4. `node scripts/register-commands.mjs` to push the schema.
5. `npx wrangler deploy` to push the implementation.

### Removing a command

Drop its entry from `COMMANDS`, run `register-commands.mjs` again. The
PUT semantics remove deleted commands from Discord's registry. Then
delete the handler file and the dispatch case at your leisure.

### Promoting to a GitHub App (v2)

Once you outgrow the "PAT acts as me" model — e.g., when the bot does
something on behalf of a user other than yourself, or you want clear
"this was the bot, not me" audit trails — switch to a GitHub App with
OAuth installation tokens. Significant rewrite of `src/github.ts` to
use installation tokens; auth flow becomes a separate route in the
worker. Out of scope for this v1 guide.

---

## Cost and limits

### Cloudflare Workers free tier

- **100,000 requests/day** — for a personal ops bot you'll send maybe
  20–100/day. Free.
- **10ms CPU per invocation** — our handlers are well under (~5ms
  worst case for a GitHub round-trip).
- No egress charges.

### Discord interactions

- **3-second response window** on the initial reply. If your handler
  takes longer (rare for simple GitHub calls), use the deferred-response
  pattern (`type: 5` then PATCH later). Not implemented in this v1
  bot — none of our calls go over 1s.
- **Slash command count**: 100 per app, plenty for our 7.

### GitHub API

- **Authenticated rate limit**: 5,000 requests/hour per token. Each
  bot command makes 1–2 calls. You'd need to spam `/preview` ~80
  times/minute for an hour to hit the limit.

---

## See also

- [Discord interactions docs](https://discord.com/developers/docs/interactions/overview)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Discord's GitHub webhook integration ref](https://discord.com/developers/docs/topics/webhook-formats)
