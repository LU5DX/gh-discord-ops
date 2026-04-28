/**
 * Cloudflare Worker entry point for the Discord ops bot.
 *
 * Receives Discord interaction HTTP requests, verifies signatures, dispatches
 * to per-command handlers, returns the response Discord expects.
 *
 * Discord interaction protocol (the relevant subset for slash commands):
 *   - PING  (type 1) -> respond with PONG (type 1). One-time at endpoint setup.
 *   - APPLICATION_COMMAND (type 2) -> respond with CHANNEL_MESSAGE_WITH_SOURCE
 *     (type 4) carrying { content: "..." } or { embeds: [...] }.
 *
 * Authorization: only the user whose Discord ID matches DISCORD_OWNER_ID can
 * invoke commands. Anyone else gets a polite "not authorized" reply.
 */

import { verifyDiscordRequest } from "./verify";
import { makeGitHub } from "./github";
import { parseShortcutMap, listShortcuts, ShortcutMap } from "./repos";
import { handlePreview } from "./commands/preview";
import { handleChecks } from "./commands/checks";
import { handleComment } from "./commands/comment";
import { handleApprove } from "./commands/approve";
import { handleMerge } from "./commands/merge";
import { handleDiff } from "./commands/diff";

interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_OWNER_ID: string;
  GITHUB_PAT: string;
  /** JSON map of shortcut -> "owner/repo". Set via:
   *    wrangler secret put REPO_SHORTCUTS_JSON
   * Example value: {"main": "myorg/main", "infra": "myorg/infra"}
   * The values of this map are also the whitelist of repos the bot
   * accepts via full-URL inputs. */
  REPO_SHORTCUTS_JSON?: string;
}

// Discord interaction types (numeric per the API).
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

const EPHEMERAL_FLAG = 1 << 6; // 64. Makes a reply visible only to the invoker.

interface DiscordInteraction {
  type: number;
  data?: {
    name: string;
    options?: Array<{ name: string; value: string | number | boolean }>;
  };
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ephemeralReply(content: string): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  });
}

function ephemeralEmbedReply(payload: { content?: string; embeds?: unknown[] }): Response {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { ...payload, flags: EPHEMERAL_FLAG },
  });
}

function getStringOption(
  interaction: DiscordInteraction,
  name: string,
): string | undefined {
  const opt = interaction.data?.options?.find((o) => o.name === name);
  if (!opt) return undefined;
  return typeof opt.value === "string" ? opt.value : String(opt.value);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET") {
      return new Response("Discord ops bot — alive.", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const valid = await verifyDiscordRequest(
      request,
      rawBody,
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) {
      return new Response("Invalid request signature", { status: 401 });
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // PING handshake — Discord pings the endpoint when it's first registered.
    if (interaction.type === InteractionType.PING) {
      return jsonResponse({ type: InteractionResponseType.PONG });
    }

    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      return ephemeralReply(`Unsupported interaction type: ${interaction.type}`);
    }

    // Authorization: only the configured owner can run commands.
    const callerId = interaction.member?.user?.id ?? interaction.user?.id;
    if (callerId !== env.DISCORD_OWNER_ID) {
      return ephemeralReply(
        "❌ You are not authorized to use this bot. " +
          "Only the configured owner can run commands.",
      );
    }

    const commandName = interaction.data?.name;
    if (!commandName) {
      return ephemeralReply("Missing command name");
    }

    const gh = makeGitHub(env.GITHUB_PAT);
    const shortcuts: ShortcutMap = parseShortcutMap(env.REPO_SHORTCUTS_JSON);

    switch (commandName) {
      case "help":
        return ephemeralReply(
          "**Available commands**:\n" +
            "• `/preview <pr>` — show PR summary\n" +
            "• `/diff <pr> [path]` — list files or show a single file's diff\n" +
            "• `/comment <target> <text>` — add a comment to a PR or issue\n" +
            "• `/approve <pr> [message]` — review with APPROVE\n" +
            "• `/merge <pr> [strategy]` — merge a PR (squash/merge/rebase)\n" +
            "• `/checks <pr>` — show CI check status\n" +
            "• `/help` — this message\n\n" +
            "**Repo addressing**: full URL or `<shortcut> <number>`.\n" +
            "Configured shortcuts: " + listShortcuts(shortcuts),
        );
      case "preview": {
        const prArg = getStringOption(interaction, "pr");
        if (!prArg) return ephemeralReply("Missing `pr` argument.");
        return ephemeralEmbedReply(await handlePreview(gh, prArg, shortcuts));
      }
      case "diff": {
        const prArg = getStringOption(interaction, "pr");
        if (!prArg) return ephemeralReply("Missing `pr` argument.");
        const pathArg = getStringOption(interaction, "path");
        return ephemeralEmbedReply(await handleDiff(gh, prArg, pathArg, shortcuts));
      }
      case "comment": {
        const targetArg = getStringOption(interaction, "target");
        const text = getStringOption(interaction, "text");
        if (!targetArg || !text) {
          return ephemeralReply("Missing `target` or `text`.");
        }
        return ephemeralEmbedReply(await handleComment(gh, targetArg, text, shortcuts));
      }
      case "approve": {
        const prArg = getStringOption(interaction, "pr");
        if (!prArg) return ephemeralReply("Missing `pr` argument.");
        const message = getStringOption(interaction, "message");
        return ephemeralEmbedReply(await handleApprove(gh, prArg, message, shortcuts));
      }
      case "merge": {
        const prArg = getStringOption(interaction, "pr");
        if (!prArg) return ephemeralReply("Missing `pr` argument.");
        const strategy = getStringOption(interaction, "strategy");
        return ephemeralEmbedReply(await handleMerge(gh, prArg, strategy, shortcuts));
      }
      case "checks": {
        const prArg = getStringOption(interaction, "pr");
        if (!prArg) return ephemeralReply("Missing `pr` argument.");
        return ephemeralEmbedReply(await handleChecks(gh, prArg, shortcuts));
      }
      default:
        return ephemeralReply(`Unknown command: \`/${commandName}\``);
    }
  },
} satisfies ExportedHandler<Env>;
