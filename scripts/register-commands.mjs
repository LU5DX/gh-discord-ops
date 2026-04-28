/**
 * One-off script to register the bot's slash commands with Discord.
 *
 * Run after editing the COMMANDS array, or whenever you bring up a new
 * Discord application:
 *
 *     # Set env vars (or use a .env file with `node --env-file=.env`):
 *     export DISCORD_APP_ID=...
 *     export DISCORD_BOT_TOKEN=...
 *     export DISCORD_GUILD_ID=...      # optional: register guild-scoped (instant)
 *     # Without DISCORD_GUILD_ID, registers globally (up to 1h propagation).
 *
 *     node scripts/register-commands.mjs
 *
 * Discord docs: https://discord.com/developers/docs/interactions/application-commands
 *
 * Plain .mjs JavaScript: no build step needed, runs on any modern Node.
 */

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional

if (!APP_ID || !BOT_TOKEN) {
  console.error(
    "ERROR: set DISCORD_APP_ID and DISCORD_BOT_TOKEN env vars first.",
  );
  process.exit(2);
}

// Slash commands. Each maps to a handler in src/index.ts.
//
// Option types: 3=STRING, 4=INTEGER, 5=BOOLEAN, 6=USER, 7=CHANNEL, 8=ROLE.
// Most of our commands take a `pr` argument that accepts either an integer
// PR number or a full URL — STRING is more flexible than INTEGER for that.
const COMMANDS = [
  {
    name: "help",
    description: "List all available bot commands",
  },
  {
    name: "preview",
    description: "Show a summary of a PR (title, body, files, status)",
    options: [
      {
        name: "pr",
        description: "PR number (with shortcut like 'en') or full GitHub URL",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "diff",
    description: "Show file diff(s) for a PR",
    options: [
      {
        name: "pr",
        description: "PR number (with shortcut) or full GitHub URL",
        type: 3,
        required: true,
      },
      {
        name: "path",
        description: "Optional: only show diff for this file path",
        type: 3,
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: "comment",
    description: "Post a comment on a PR or issue",
    options: [
      {
        name: "target",
        description: "PR/issue number (with shortcut) or full GitHub URL",
        type: 3,
        required: true,
      },
      {
        name: "text",
        description: "The comment body",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "approve",
    description: "Review a PR with APPROVE",
    options: [
      {
        name: "pr",
        description: "PR number (with shortcut) or full GitHub URL",
        type: 3,
        required: true,
      },
      {
        name: "message",
        description: "Optional approval message",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "merge",
    description: "Merge a PR",
    options: [
      {
        name: "pr",
        description: "PR number (with shortcut) or full GitHub URL",
        type: 3,
        required: true,
      },
      {
        name: "strategy",
        description: "Merge strategy (default: squash)",
        type: 3,
        required: false,
        choices: [
          { name: "squash", value: "squash" },
          { name: "merge", value: "merge" },
          { name: "rebase", value: "rebase" },
        ],
      },
    ],
  },
  {
    name: "checks",
    description: "Show CI check status for a PR",
    options: [
      {
        name: "pr",
        description: "PR number (with shortcut) or full GitHub URL",
        type: 3,
        required: true,
      },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

console.log(`Registering ${COMMANDS.length} command(s) ${GUILD_ID ? "in guild " + GUILD_ID : "globally"} ...`);

const res = await fetch(url, {
  method: "PUT", // PUT replaces the entire command set; POST adds individually
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
console.log(`OK. Registered ${data.length} command(s):`);
for (const cmd of data) console.log(`  /${cmd.name} — ${cmd.description}`);
