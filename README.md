# gh-discord-ops

Discord slash-command bot for GitHub ops. Lets you preview, comment on,
approve, and merge PRs from Discord without leaving the channel where the
GitHub→Discord webhook embeds appear.

**Stack**: Cloudflare Workers (free tier) + Discord interactions + GitHub
REST API. Zero npm runtime dependencies — just `fetch` and `crypto.subtle`.

**Auth model (v1)**: bot calls GitHub with the owner's PAT. All GitHub
actions are attributed to the PAT owner. A future v2 may switch to a
GitHub App with OAuth for proper bot identity.

**Setup walkthrough**: see [`docs/implementation-guide.md`](docs/implementation-guide.md)
for end-to-end instructions (Discord application, Cloudflare Worker
deployment, secret configuration, slash command registration, testing).

## Commands

| Command | What it does |
|---|---|
| `/help` | List all commands |
| `/preview <pr>` | Show PR summary (title, body, files, status checks) |
| `/diff <pr> [path]` | Show file diff for a PR. Path autocompletes; prev/next buttons walk the file list |
| `/comment <target> <text>` | Post a comment on a PR or issue |
| `/review <pr> <path> <line> <comment>` | Inline review comment on a specific line of a PR's diff |
| `/approve <pr> [message]` | Review the PR with APPROVE |
| `/merge <pr> [strategy]` | Merge a PR (squash / merge / rebase) |
| `/checks <pr>` | Show CI check status |

The `<pr>` and `<target>` arguments accept either:
- A full GitHub URL: `https://github.com/<owner>/<repo>/pull/12`
- A shortcut + number: e.g. `main 12` if you've defined a `main` shortcut

## Repos in scope

The bot enforces a whitelist of repos it will act on — anything else is
rejected with "out of scope". This is so a leaked PAT can't be used to
act on arbitrary repos via the bot.

When you fork this repo, edit `src/repos.ts` to define your own
`SHORTCUTS` map: each entry maps a short alias (typed as the first part
of the `pr` argument) to a `"owner/repo"` pair. Repos NOT in the map
can still be addressed by full URL — the URL parser checks against the
same whitelist.

## Setup

One-time setup. Captures the credentials and deploys the worker.

### 1. Create Discord application

- https://discord.com/developers/applications → New Application
- Name: `gh-discord-ops`
- From **General Information** copy: `APPLICATION ID`, `PUBLIC KEY`
- From **Bot** copy: `BOT TOKEN` (kept secret; only used for command registration)
- **OAuth2 → URL Generator**: scopes `applications.commands` + `bot`,
  bot permissions `Send Messages` + `Embed Links`. Visit the generated URL,
  install the bot in your server.

### 2. Get your Discord user ID

In Discord: Settings → Advanced → enable **Developer Mode**. Then right-click
your username anywhere → **Copy User ID**.

### 3. Register slash commands with Discord

```sh
export DISCORD_APP_ID=...
export DISCORD_BOT_TOKEN=...
export DISCORD_GUILD_ID=...     # your server ID (optional but faster)
node scripts/register-commands.mjs
```

`DISCORD_GUILD_ID` makes commands appear instantly in just that server.
Without it they register globally and propagate within ~1 hour.

### 4. Deploy the worker to Cloudflare

```sh
npm install                 # one-time, installs wrangler

# Set worker secrets (each prompts for the value):
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_OWNER_ID
wrangler secret put GITHUB_PAT

wrangler deploy
```

The deploy prints a `*.workers.dev` URL.

### 5. Wire the worker URL back into Discord

In the Discord developer portal, your application's **General Information**
tab has an **Interactions Endpoint URL** field. Paste the worker URL.
Discord sends a PING; if the worker returns PONG (it does — see
`src/index.ts`), Discord saves the URL.

After this, slash commands typed in your server reach the worker.

## Layout

```
.
├── src/
│   ├── index.ts          # worker entry: dispatches all interaction types
│   ├── verify.ts         # Ed25519 signature verification
│   ├── github.ts         # tiny REST wrapper (no @octokit dep)
│   ├── repos.ts          # URL/shortcut parsing + whitelist
│   └── commands/
│       ├── preview.ts
│       ├── diff.ts       # + path autocomplete + nav buttons + ANSI color
│       ├── comment.ts
│       ├── review.ts     # inline PR review comments
│       ├── approve.ts
│       ├── merge.ts
│       └── checks.ts
├── scripts/
│   └── register-commands.mjs   # one-off slash command registration
├── docs/
│   └── implementation-guide.md  # end-to-end setup walkthrough
├── wrangler.toml         # Cloudflare Worker config
├── package.json
├── tsconfig.json
└── README.md
```

## Add a new command

1. Add the command schema to `COMMANDS` in `scripts/register-commands.mjs`.
2. Add a handler case in `src/index.ts`.
3. `npm run register` (re-registers with Discord).
4. `npm run deploy` (re-deploys the worker).

## Status

v1 — all 8 commands implemented and in production use. `/diff` has
autocomplete + prev/next nav buttons + ANSI-colored diff body. See
`docs/implementation-guide.md` for setup details and design notes.
