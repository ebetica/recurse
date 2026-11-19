// One recorded startup pass freezes pre-existing ladder choices; per-record
// versions make an interrupted pass safe to resume without retuning its writes.
import { join } from "node:path";
import {
  EFFORT_MIN_LEVEL,
  EFFORT_MAX_LEVEL,
  THINKING_LEVELS,
  type Thinking,
  type Config,
} from "../../config";
import { atomicJson, readJson } from "../../utils";
import type { ConversationRecord } from "./conversation_store";

export function validLevel(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EFFORT_MIN_LEVEL &&
    value <= EFFORT_MAX_LEVEL
    ? value
    : null;
}

export function conversationModelSettings(
  config: Config,
  record: ConversationRecord,
): [string, string] {
  const model = record.model;
  const effort = record.effort;
  if (
    typeof model === "string" &&
    typeof effort === "string" &&
    THINKING_LEVELS.includes(effort as Thinking)
  )
    return [model, effort];
  if (validLevel(record.level) !== null)
    throw new Error(
      "No recorded model. Pick an effort level again for this conversation.",
    );
  const resolved = config.chatSettings(
    typeof model === "string" ? model : null,
  );
  return [
    resolved[0],
    typeof effort === "string" && THINKING_LEVELS.includes(effort as Thinking)
      ? effort
      : resolved[1],
  ];
}

export async function migrateConversationModelChoices(input: {
  dataDir: string;
  complete: boolean;
  rows: ReadonlyMap<string, ConversationRecord>;
  config: Config;
  save(cid: string, row: ConversationRecord): Promise<void>;
}): Promise<number> {
  const marker = join(input.dataDir, "conversation-model-choices.json");
  if (await readJson(marker)) return 0;
  if (!input.complete)
    throw new Error("conversation model choices require a complete scan");
  let rewritten = 0;
  for (const [cid, current] of input.rows) {
    if (current.model_choice_version === 1) continue;
    const row: ConversationRecord = { ...current, model_choice_version: 1 };
    const level =
      validLevel(row.level) ??
      (!("model" in row) ? input.config.defaultEffortLevel() : null);
    if (level !== null) {
      [row.model, row.effort] = input.config.resolveEffortLevel(level);
      row.level = level;
    } else
      [row.model, row.effort] = conversationModelSettings(input.config, row);
    const pending = row.pending_model;
    if (pending && typeof pending === "object" && !Array.isArray(pending)) {
      const choice = pending as ConversationRecord;
      if (
        typeof choice.model === "string" &&
        (choice.effort == null || choice.effort === "default")
      ) {
        try {
          const selectedLevel = validLevel(choice.level);
          const selected =
            selectedLevel === null
              ? null
              : input.config.resolveEffortLevel(selectedLevel);
          row.pending_model = {
            ...choice,
            effort:
              selected?.[0] === input.config.canonicalModelId(choice.model)
                ? selected[1]
                : (input.config.ladderHome(choice.model)?.[2] ??
                  input.config.chatSettings(choice.model)[1]),
          };
        } catch {
          row.pending_model = { ...choice, effort: null };
        }
      }
    }
    await input.save(cid, row);
    rewritten += 1;
  }
  await atomicJson(marker, { version: 1, rewritten });
  return rewritten;
}
