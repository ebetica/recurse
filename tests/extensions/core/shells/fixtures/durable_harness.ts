/**
 * A Durable Harness with the shell extension and a faux model: a user message
 * "RUN <json>" makes the model call bash with those arguments, "WAIT" calls
 * wait, and every other
 * input is answered with text. Shells stop through process_lifecycle's stopGroup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  createShells,
  type ShellsOptions,
} from "../../../../../src/extensions/core/shells/shells.ts";
import type { ShellConfig } from "../../../../../src/extensions/core/shells/registry.ts";
import { ProcessLifecycle } from "../../../../../src/process_lifecycle.ts";

export const lifecycle = new ProcessLifecycle({
  registry: {} as never,
  shellStateDir: "/nonexistent",
  termGraceMs: 500,
  killGraceMs: 500,
});

export const stopGroup: ShellsOptions["stopGroup"] = (group) =>
  lifecycle.stopGroup(group);

export function text(content: unknown): string {
  return typeof content === "string"
    ? content
    : ((content ?? []) as Array<{ text?: string }>)
        .map((block) => block.text ?? "")
        .join("");
}

export async function openShellHarness(
  storage: Storage,
  options: {
    cwd: string;
    config?: Partial<ShellConfig>;
    env?: Record<string, string>;
  } & Partial<ShellsOptions>,
) {
  const faux = fauxProvider({ tokensPerSecond: 50_000 });
  faux.setResponses(
    Array.from(
      { length: 500 },
      () =>
        (request: {
          messages: readonly { role: string; content: unknown }[];
        }) => {
          // Durable commits a request's system entries after its newest input.
          const last = request.messages
            .filter((message) => message.role !== "system")
            .at(-1);
          const run =
            last?.role === "user"
              ? /^RUN (.*)$/s.exec(text(last.content))
              : null;
          if (run)
            return fauxAssistantMessage(
              fauxToolCall("bash", JSON.parse(run[1]!)),
              { stopReason: "toolUse" },
            );
          if (last?.role === "user" && text(last.content) === "WAIT")
            return fauxAssistantMessage(fauxToolCall("wait", {}), {
              stopReason: "toolUse",
            });
          return fauxAssistantMessage(
            fauxText(last?.role === "toolResult" ? "done" : "noted"),
          );
        },
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const shells = createShells({
    scope: async () => ({
      key: "agent-1",
      cwd: options.cwd,
      env: options.env ?? {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: options.cwd,
      },
      config: options.config,
    }),
    stateDir:
      options.stateDir ?? mkdtempSync(join(tmpdir(), "pi-bg-shell-state-")),
    stopGroup: options.stopGroup ?? stopGroup,
    monitor: options.monitor ?? { debounceMs: 50, cooldownMs: 0 },
    report: (error) => reports.push(error),
  });
  const registry = createRegistry();
  registry.install(shells.extension);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  );
  const model = faux.getModel();
  const conversation: Conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, conversation, shells, reports };
}

/** Text of every user entry of the conversation, oldest first. */
export async function userTexts(conversation: Conversation): Promise<string[]> {
  const texts: string[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries({}, 200, cursor, context);
    for (const entry of page.items)
      if (entry.kind === "pi.user")
        texts.unshift(
          text((entry.model?.[0] as { content?: unknown })?.content),
        );
    cursor = page.next;
  } while (cursor);
  return texts;
}
