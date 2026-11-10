// Slash platform commands call endpoints, never enter model prompts. They share
// skill autocomplete but remain labeled actions; composer.ts executes.

import { actionStatusText } from "../thread-render/thread-markers.js";

export interface ComposerCommand {
  name: string;
  description: string;
}

// Order = the order shown in the autocomplete's Actions group.
export const COMPOSER_COMMANDS: ComposerCommand[] = [
  {
    name: "compact",
    description: "Summarize context and continue with less history · Action",
  },
  {
    name: "clear",
    description: "Delete this history and start fresh · Action",
  },
  {
    name: "btw",
    description:
      "Ask a read-only side conversation that starts from here · Action",
  },
  {
    name: "rename",
    description: "Rename this conversation · Action",
  },
  {
    name: "revive",
    description:
      "Bring back a deleted or cleared agent with its history · Action",
  },
];

// Conversation-free actions remain available in drafts; revive opens a finder.
const GLOBAL_COMMANDS = new Set(["revive"]);

const COMMAND_NAMES = new Set(COMPOSER_COMMANDS.map((c) => c.name));

// The dedicated endpoint each command posts to, under /api/conversations/{id}/.
export const COMPOSER_COMMAND_ENDPOINT: Record<string, string> = {
  compact: "compact",
  clear: "clear",
  btw: "side",
  rename: "rename",
};

export interface ComposerCommandMatch {
  name: string;
  question?: string;
}

/** Match bare actions and the text owned by /btw and /rename. */
export function matchComposerCommand(
  text: string,
): ComposerCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  for (const name of ["btw", "rename"]) {
    if (body === name) return { name, question: "" };
    if (body.startsWith(`${name} `))
      return { name, question: body.slice(name.length + 1).trim() };
  }
  return COMMAND_NAMES.has(body) ? { name: body } : null;
}

export interface CommandContext {
  isDraft: boolean;
  hasParent: boolean;
}

export function availableCommands(ctx: CommandContext): ComposerCommand[] {
  if (ctx.isDraft)
    return COMPOSER_COMMANDS.filter((c) => GLOBAL_COMMANDS.has(c.name));
  return COMPOSER_COMMANDS;
}

// Commands whose name matches the typed partial, prefix hits first — mirrors
// the skill picker's ordering so the merged menu reads consistently.
export function matchingCommands(
  query: string,
  ctx: CommandContext,
  includePlatformActions = true,
): ComposerCommand[] {
  if (!includePlatformActions) return [];
  const folded = query.toLowerCase();
  return availableCommands(ctx)
    .filter((c) => c.name.toLowerCase().includes(folded))
    .sort((a, b) => {
      const ar = a.name.toLowerCase().startsWith(folded) ? 0 : 1;
      const br = b.name.toLowerCase().startsWith(folded) ? 0 : 1;
      return ar - br || a.name.localeCompare(b.name);
    });
}

// Drops held rows only for confirmed immediately applied Clear of this cid.
// Failures, queued actions and other commands keep history until application.
export function shouldDropHeldThread(
  name: string,
  ok: boolean,
  queued: boolean,
): boolean {
  return ok && !queued && name === "clear";
}

export function commandFeedback(
  name: string,
  data: {
    queued?: boolean;
  },
): string {
  if (name === "compact" || name === "clear")
    return actionStatusText(name, !!data.queued) || "Done";
  return "Done";
}
