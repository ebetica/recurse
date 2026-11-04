// Deferred settings share validation and connection operations with Settings.
// The bundled recurse-settings skill holds usage; schemas load on demand.
// Mutations require an operator request; file paths use the tool cwd.
// Tree links name local roots without granting access or changing state.
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  brandingFile,
  brandResponse,
  readIcon,
  writeBrand,
} from "../../../branding";
import {} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Config, EFFORT_MAX_LEVEL, EFFORT_MIN_LEVEL } from "../../../config";
import {
  readThemeSettings,
  themeDefaults,
  writeThemeSettings,
  type ThemePalette,
} from "../../../themes";
import type { SidebarScript } from "../../../sidebar_script";

function levels(config: Config) {
  const ladder = config.effortLevels();
  const reachability = config.effortLevelReachability();
  return {
    levels: Object.fromEntries(
      Array.from({ length: EFFORT_MAX_LEVEL }, (_, index) => {
        const level = index + EFFORT_MIN_LEVEL;
        const flag = reachability[level];
        return [
          String(level),
          {
            ...ladder[level]!,
            ...(flag && !flag.reachable
              ? { unreachable: flag.reason || "unreachable" }
              : {}),
          },
        ];
      }),
    ),
    default_level: config.defaultEffortLevel(),
  };
}

/** Import Ghostty palette keys; shared theme validation checks colours. */
function ghosttyPalette(name: string, text: string): ThemePalette {
  const result: ThemePalette = {
    name: name.trim(),
    background: "",
    foreground: "",
    palette: [],
  };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(background|foreground|palette)\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;
    const hex = (value: string) =>
      value.startsWith("#") ? value : `#${value}`;
    if (match[1] === "background" || match[1] === "foreground")
      result[match[1]] = hex(match[2]!);
    else {
      const slot = match[2]!.match(/^(\d+)\s*=\s*(\S+)$/);
      if (!slot || Number(slot[1]) > 15)
        throw new Error("Invalid Ghostty palette slot (expected 0-15).");
      result.palette[Number(slot[1])] = hex(slot[2]!);
    }
  }
  if (Array.from({ length: 16 }, (_, i) => result.palette[i]).some((c) => !c))
    throw new Error("Ghostty theme requires all 16 palette slots.");
  return result;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(`${name} is required for this action.`);
  return value;
}

export function createSettings(
  config: Config,
  loadConversation: (cid: string) => Record<string, unknown> | null,
  sidebar?: { script: SidebarScript; by: string },
  remotes?: {
    request(label: string, url: string): Promise<void>;
    list(): unknown;
  },
) {
  return defineExtension({
    name: "recurse-settings",
    tools: [
      defineTool({
        name: "recurse_settings",
        deferred: true,
        description:
          "Change Recurse settings; read the recurse-settings skill first.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("add_remote"),
            Type.Literal("list_remotes"),
            Type.Literal("set_name"),
            Type.Literal("reset_name"),
            Type.Literal("set_icon"),
            Type.Literal("reset_icon"),
            Type.Literal("share_link"),
            Type.Literal("levels"),
            Type.Literal("set_level"),
            Type.Literal("themes"),
            Type.Literal("select_theme"),
            Type.Literal("add_theme"),
            Type.Literal("remove_theme"),
            Type.Literal("sidebar_script"),
            Type.Literal("set_sidebar_script"),
            Type.Literal("undo_sidebar_script"),
            Type.Literal("reset_sidebar_script"),
          ]),
          label: Type.Optional(
            Type.String({ description: "Remote label for add_remote." }),
          ),
          url: Type.Optional(
            Type.String({ description: "Remote URL for add_remote." }),
          ),
          script: Type.Optional(
            Type.String({
              description:
                "The complete sidebar script for set_sidebar_script, inline.",
            }),
          ),
          conversations: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              maxItems: 100,
              description:
                "Local conversation ids for share_link; children resolve to their root trees.",
            }),
          ),
          level: Type.Optional(
            Type.Integer({
              minimum: EFFORT_MIN_LEVEL,
              maximum: EFFORT_MAX_LEVEL,
            }),
          ),
          model: Type.Optional(
            Type.String({ description: "Exact Pi model id for set_level." }),
          ),
          reasoning: Type.Optional(
            Type.String({
              description:
                "set_level reasoning: off, minimal, low, medium, high, xhigh or max.",
            }),
          ),
          name: Type.Optional(
            Type.String({
              description:
                "App name for set_name, or theme name for select_theme, add_theme or remove_theme. Select system to follow the device.",
            }),
          ),
          appearance: Type.Optional(
            Type.Union([
              Type.Literal("system"),
              Type.Literal("dark"),
              Type.Literal("light"),
            ]),
          ),
          dark: Type.Optional(
            Type.String({
              description:
                "Legacy dark palette name for select_theme; supply light too.",
            }),
          ),
          light: Type.Optional(
            Type.String({
              description:
                "Legacy light palette name for select_theme; supply dark too. Mismatched pairs keep dark.",
            }),
          ),
          path: Type.Optional(
            Type.String({
              description:
                "PNG/SVG file for set_icon or Ghostty palette file for add_theme; relative to current cwd. No stdin.",
            }),
          ),
        }),
        executionMode: "sequential",
        async execute(args, api) {
          let result: unknown;
          if (args.action === "add_remote" || args.action === "list_remotes") {
            if (!remotes) throw new Error("Remote settings are unavailable.");
            if (args.action === "add_remote") {
              const label = required(args.label, "label");
              const url = required(args.url, "url");
              await remotes.request(label, url);
              result = {
                ok: true,
                note: `Backend ${label} (${url}) needs sign-in: ask the operator to enter its password in Settings → Remotes.`,
              };
            } else result = remotes.list();
          } else if (args.action.endsWith("sidebar_script")) {
            if (!sidebar) throw new Error("The sidebar script is unavailable.");
            const { script, by } = sidebar;
            if (args.action === "set_sidebar_script")
              result = {
                sections: await script.set(required(args.script, "script"), by),
              };
            else if (args.action === "reset_sidebar_script")
              await script.set(null, by);
            else if (args.action === "undo_sidebar_script")
              await script.undo(by);
            result ??= await script.view();
          } else if (args.action === "share_link") {
            const conversations = required(args.conversations, "conversations");
            if (!conversations.length || conversations.length > 100)
              throw new Error("conversations must contain 1-100 ids.");
            const roots = new Set<string>();
            for (const target of conversations) {
              let cid = target;
              const seen = new Set<string>();
              while (true) {
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cid))
                  throw new Error(
                    "share_link requires local conversation ids.",
                  );
                if (seen.has(cid))
                  throw new Error(`Invalid ancestry for '${target}'.`);
                seen.add(cid);
                const row = loadConversation(cid);
                if (!row) throw new Error(`No live conversation '${cid}'.`);
                const parent = row.side_of || row.parent;
                if (!parent) break;
                if (typeof parent !== "string")
                  throw new Error(`Invalid ancestry for '${target}'.`);
                cid = parent;
              }
              roots.add(cid);
            }
            result = {
              url: `#trees=${[...roots].join(",")}`,
              note: "Append this fragment to this instance's public URL; existing sign-in is required.",
            };
          } else if (
            ["set_name", "reset_name", "set_icon", "reset_icon"].includes(
              args.action,
            )
          ) {
            const fields =
              args.action === "set_name"
                ? { name: required(args.name, "name") }
                : args.action === "reset_name"
                  ? { name: null }
                  : args.action === "reset_icon"
                    ? { icon: null }
                    : {
                        icon: await readIcon(
                          Bun.file(
                            resolve(api.env!.cwd, required(args.path, "path")),
                          ).stream(),
                        ),
                      };
            result = brandResponse(
              await writeBrand(brandingFile(config.paths.CONFIG_DIR), fields),
              config.displayName,
            );
          } else if (args.action === "levels") result = levels(config);
          else if (args.action === "set_level") {
            result = await config.setEffortLevel(
              required(args.level, "level"),
              required(args.model, "model"),
              required(args.reasoning, "reasoning"),
            );
          } else {
            const path = config.paths.THEMES_FILE;
            let settings = await readThemeSettings(path);
            if (args.action === "add_theme") {
              const file = required(args.path, "path");
              if (file === "-")
                throw new Error(
                  "A palette file is required; stdin is not supported.",
                );
              const palette = ghosttyPalette(
                required(args.name, "name"),
                await readFile(resolve(api.env!.cwd, file), "utf8"),
              );
              settings = await writeThemeSettings(path, {
                custom: [
                  ...settings.custom.filter((p) => p.name !== palette.name),
                  palette,
                ],
              });
            } else if (args.action === "remove_theme") {
              const name = required(args.name, "name").trim();
              if (!settings.custom.some((p) => p.name === name))
                throw new Error("Unknown custom theme.");
              const fields: Record<string, unknown> = {
                custom: settings.custom.filter((p) => p.name !== name),
              };
              for (const field of ["theme", "dark", "light"] as const)
                if (settings[field] === name)
                  fields[field] = themeDefaults[field];
              settings = await writeThemeSettings(path, fields);
            } else if (args.action === "select_theme") {
              const name = required(args.name, "name");
              if ((args.dark === undefined) !== (args.light === undefined))
                throw new Error("Supply both dark and light palette names.");
              settings = await writeThemeSettings(path, {
                theme:
                  name === "system" && args.dark === undefined
                    ? settings.theme
                    : name,
                ...(name === "system" && args.dark === undefined
                  ? { appearance: "system" }
                  : {}),
                ...(args.appearance === undefined
                  ? {}
                  : { appearance: args.appearance }),
                ...(args.dark === undefined
                  ? {}
                  : { dark: args.dark, light: args.light }),
              });
            }
            result = {
              theme: settings.theme,
              appearance: settings.appearance,
              themes: settings.themes.map(({ name, appearance }) => ({
                name,
                appearance,
              })),
              custom: settings.custom.map((p) => p.name),
              problems: settings.problems,
            };
          }
          return {
            output: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      }),
    ],
  });
}
