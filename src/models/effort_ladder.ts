// Resolve, save and report the effort ladder against the live model catalog.
import {
  isObject,
  valueError,
  type ConfigFiles,
  type Dict,
} from "../config_files";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVEL_RANGE,
  EFFORT_LEVELS,
  EFFORT_MIN_LEVEL,
  OPTIONAL_EFFORT_LEVELS,
  isEffortLevel,
} from "../effort_levels";
import { pyCompactJson } from "../utils/python-json";
import { DEFAULT_CHAT_MODEL, type ModelCatalog } from "./catalog";
import { validModelScopeKey } from "./model_id";
import { parseThinking, type Thinking } from "./thinking";

const EFFORT_LEVELS_VERSION = 1;
const TURN_MARKS_VERSION = 1;
type Ladder = Record<number, { model: string; reasoning: Thinking }>;

export class EffortLadder {
  private effortLevelsCache: {
    document: unknown;
    catalogRevision: number;
    providers: string;
    levels: Ladder;
  } | null = null;

  constructor(
    private readonly models: ModelCatalog,
    private readonly settingsFiles: ConfigFiles,
    private readonly paths: {
      EFFORT_LEVELS_FILE: string;
      AVAILABLE_MODELS_FILE: string;
    },
  ) {}

  private defaultLadder(authed: Set<string>): Ladder {
    const anthro: [string, Thinking][] = [
      ["anthropic/claude-haiku-5-5", "medium"],
      ["anthropic/claude-haiku-5-5", "xhigh"],
      ["anthropic/claude-sonnet-5-5", "medium"],
      ["anthropic/claude-opus-5-5", "medium"],
      ["anthropic/claude-opus-5-5", "xhigh"],
      ["anthropic/claude-fable-5-2", "high"],
    ];
    const codex: [string, Thinking][] = [
      ["openai-codex/gpt-6-luna", "high"],
      ["openai-codex/gpt-6.1-terra", "high"],
      ["openai-codex/gpt-6.1-sol", "medium"],
      ["openai-codex/gpt-6.1-sol", "xhigh"],
      ["openai-codex/gpt-6-astra", "high"],
      ["openai-codex/gpt-6-astra", "xhigh"],
    ];
    const mixed: [string, Thinking][] = [
      ["openai-codex/gpt-6-luna", "high"],
      ["openai-codex/gpt-6.1-sol", "low"],
      ["openai-codex/gpt-6.1-sol", "high"],
      ["anthropic/claude-opus-5-5", "high"],
      ["anthropic/claude-opus-5-5", "xhigh"],
      ["anthropic/claude-fable-5-2", "high"],
    ];
    let entries: [string, Thinking][];
    if (authed.has("anthropic") && authed.has("openai-codex")) entries = mixed;
    else if (authed.has("anthropic")) entries = anthro;
    else if (authed.has("openai-codex")) entries = codex;
    else {
      const best =
        this.models.signedInChatModels(authed)[0]?.id ??
        (this.models.isFileProviderModel(this.models.CHAT_MODEL)
          ? DEFAULT_CHAT_MODEL
          : this.models.CHAT_MODEL);
      const offered = this.models.modelReasoningLevels(best) ?? [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ];
      entries = EFFORT_LEVELS.map((_, index) => [
        best,
        offered[Math.max(0, offered.length - EFFORT_LEVELS.length + index)]!,
      ]);
    }
    return Object.fromEntries(
      entries.map(([model, reasoning], index) => [
        index + EFFORT_MIN_LEVEL,
        { model, reasoning },
      ]),
    );
  }

  private readEffortLevelsDoc(): Dict {
    const data = this.settingsFiles.json(this.paths.EFFORT_LEVELS_FILE);
    return isObject(data) ? data : {};
  }

  /** Level 1's pin or built-in default, without consulting Pi's list. */
  levelOneModel(): { model: string } | { authed: Set<string> } {
    const document = this.readEffortLevelsDoc();
    const pin = isObject(document.levels) ? document.levels["1"] : undefined;
    if (pin !== undefined)
      return {
        model: isObject(pin) && typeof pin.model === "string" ? pin.model : "",
      };
    const authed = this.models.authedModelProviders();
    if (authed.has("anthropic") || authed.has("openai-codex"))
      return { model: this.defaultLadder(authed)[EFFORT_MIN_LEVEL]!.model };
    return { authed };
  }

  effortLevels(): Record<number, { model: string; reasoning: string }> {
    return Object.fromEntries(
      Object.entries(this.resolvedEffortLevels()).map(([level, entry]) => [
        level,
        { ...entry },
      ]),
    );
  }

  private resolvedEffortLevels(): Ladder {
    const raw = this.settingsFiles.json(this.paths.EFFORT_LEVELS_FILE);
    const catalogRevision = this.models.revision();
    const authed = this.models.authedModelProviders();
    const providers = [...authed].sort().join("\0");
    const cached = this.effortLevelsCache;
    if (
      cached &&
      cached.document === raw &&
      cached.catalogRevision === catalogRevision &&
      cached.providers === providers
    )
      return cached.levels;
    const defaults = this.defaultLadder(authed);
    const document = isObject(raw) ? raw : {};
    const rawLevels = isObject(document.levels) ? document.levels : {};
    const resolved: Ladder = {};
    for (const level of EFFORT_LEVELS) {
      const defaultEntry = defaults[level]!;
      let model = defaultEntry.model;
      let reasoning = defaultEntry.reasoning;
      const entry = rawLevels[String(level)];
      if (isObject(entry)) {
        let candidate = entry.model;
        if (typeof candidate === "string")
          candidate = this.models.canonicalModelId(candidate);
        // Invariant: Keep the saved id even when Pi no longer lists it.
        // Durable resolves that exact id at runtime, without substituting another model.
        if (typeof candidate === "string" && validModelScopeKey(candidate))
          model = candidate;
        try {
          reasoning = parseThinking(entry.reasoning ?? reasoning);
        } catch {
          reasoning = defaultEntry.reasoning;
        }
      }
      resolved[level] = { model, reasoning };
    }
    this.effortLevelsCache = {
      document: raw,
      catalogRevision,
      providers,
      levels: resolved,
    };
    return resolved;
  }

  defaultEffortLevel(): number {
    const value = this.readEffortLevelsDoc().default_level;
    return isEffortLevel(value) ? value : DEFAULT_EFFORT_LEVEL;
  }

  resolveEffortLevel(level: unknown): [string, string] {
    if (!isEffortLevel(level))
      throw valueError(
        `effort level must be ${EFFORT_LEVEL_RANGE}, got ${this.pythonRepr(level)}`,
      );
    const resolved = this.resolvedEffortLevels()[level]!;
    return [resolved.model, resolved.reasoning];
  }

  private pythonRepr(value: unknown): string {
    if (typeof value === "string") return `'${value}'`;
    if (value === undefined || value === null) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    return String(value);
  }

  private thinkingOrNone(value: unknown): Thinking | null {
    if (typeof value !== "string") return null;
    try {
      return parseThinking(value);
    } catch {
      return null;
    }
  }

  private firstLadderLevel(
    levels: Record<number, { model: string; reasoning: string }>,
    match: (entry: { model: string; reasoning: string }) => boolean,
  ): number | null {
    for (const level of EFFORT_LEVELS) if (match(levels[level]!)) return level;
    return null;
  }

  ladderHome(
    model: unknown,
    reasoning: unknown = null,
  ): [number, string, string] | null {
    if (typeof model !== "string") return null;
    const canonical = this.models.canonicalModelId(model);
    const level = this.nearestEffortLevel(canonical, reasoning);
    const [resolvedModel, resolvedReasoning] = this.resolveEffortLevel(level);
    return resolvedModel === canonical
      ? [level, resolvedModel, resolvedReasoning]
      : null;
  }

  private nearestEffortLevel(
    model: unknown = null,
    reasoning: unknown = null,
  ): number {
    const levels = this.effortLevels();
    const want = this.thinkingOrNone(reasoning);
    if (typeof model === "string") {
      const canonical = this.models.canonicalModelId(model);
      if (want !== null) {
        const match = this.firstLadderLevel(
          levels,
          (entry) => entry.model === canonical && entry.reasoning === want,
        );
        if (match !== null) return match;
      }
      const exact = this.firstLadderLevel(
        levels,
        (entry) => entry.model === canonical,
      );
      if (exact !== null) return exact;
      if (want !== null) {
        const provider = this.models.providerOf(canonical);
        const match = this.firstLadderLevel(
          levels,
          (entry) =>
            this.models.providerOf(entry.model) === provider &&
            entry.reasoning === want,
        );
        if (match !== null) return match;
      }
    } else if (want !== null) {
      const match = this.firstLadderLevel(
        levels,
        (entry) => entry.reasoning === want,
      );
      if (match !== null) return match;
    }
    return this.defaultEffortLevel();
  }

  private validateEffortLevels(value: unknown): Dict {
    if (!isObject(value))
      throw valueError(
        `effort levels must map levels ${EFFORT_LEVEL_RANGE} to {model, reasoning}`,
      );
    if (!isObject(value.levels))
      throw valueError(
        `effort levels require a 'levels' map for levels ${EFFORT_LEVEL_RANGE}`,
      );
    const keys = EFFORT_LEVELS.map(String);
    if (Object.keys(value.levels).some((key) => !keys.includes(key)))
      throw valueError(`effort level keys must be ${EFFORT_LEVEL_RANGE}`);
    const ids = this.models.catalogModelIds();
    const stored = this.effortLevels();
    const raw = this.readEffortLevelsDoc().levels;
    const levels: Record<string, { model: string; reasoning: string }> = {};
    for (const level of EFFORT_LEVELS) {
      const key = String(level);
      if (
        OPTIONAL_EFFORT_LEVELS.includes(level) &&
        !Object.hasOwn(value.levels, key)
      ) {
        if (isObject(raw) && isObject(raw[level])) levels[key] = stored[level]!;
        continue;
      }
      const entry = value.levels[key];
      if (!isObject(entry))
        throw valueError(`effort level ${level} needs {model, reasoning}`);
      const model =
        typeof entry.model === "string"
          ? this.models.canonicalModelId(entry.model)
          : entry.model;
      if (
        typeof model !== "string" ||
        !validModelScopeKey(model) ||
        (ids !== null && !ids.has(model) && stored[level]!.model !== model)
      )
        throw valueError(
          `unsupported model for effort level ${level}: ${this.pythonRepr(model)}`,
        );
      let reasoning: Thinking;
      try {
        reasoning = parseThinking(entry.reasoning);
      } catch {
        throw valueError(
          `unsupported reasoning for effort level ${level}: ${this.pythonRepr(entry.reasoning)}`,
        );
      }
      levels[String(level)] = { model, reasoning };
    }
    const defaultLevel =
      value.default_level === undefined
        ? DEFAULT_EFFORT_LEVEL
        : value.default_level;
    if (!isEffortLevel(defaultLevel))
      throw valueError(`default_level must be ${EFFORT_LEVEL_RANGE}`);
    return {
      version: EFFORT_LEVELS_VERSION,
      default_level: defaultLevel,
      levels,
    };
  }

  async setEffortLevels(input: unknown): Promise<Dict> {
    return this.settingsFiles.write(this.paths.EFFORT_LEVELS_FILE, () => {
      const value = this.validateEffortLevels(input);
      return {
        text: pyCompactJson(value, {
          separators: "default",
          sortKeys: true,
          javascriptScalars: true,
        }),
        value,
      };
    });
  }

  /** Update one ladder entry against the latest committed Settings. */
  async setEffortLevel(
    level: unknown,
    model: unknown,
    reasoning: unknown,
  ): Promise<Dict> {
    if (!isEffortLevel(level))
      throw valueError(`level must be ${EFFORT_LEVEL_RANGE}`);
    return this.settingsFiles.write(this.paths.EFFORT_LEVELS_FILE, () => {
      const current = this.effortLevels();
      for (const optional of OPTIONAL_EFFORT_LEVELS) delete current[optional];
      const value = this.validateEffortLevels({
        default_level: this.defaultEffortLevel(),
        levels: { ...current, [level]: { model, reasoning } },
      });
      return {
        text: pyCompactJson(value, {
          separators: "default",
          sortKeys: true,
          javascriptScalars: true,
        }),
        value,
      };
    });
  }

  private readTurnMarks(): Record<string, { model: string; reason: string }> {
    const value = this.settingsFiles.json(this.paths.AVAILABLE_MODELS_FILE);
    if (!isObject(value) || !isObject(value.turn_marks)) return {};
    const out: Record<string, { model: string; reason: string }> = {};
    for (const level of EFFORT_LEVELS) {
      const mark = value.turn_marks[level];
      if (!isObject(mark)) continue;
      if (typeof mark.model === "string" && typeof mark.reason === "string")
        out[level] = {
          model: this.models.canonicalModelId(mark.model),
          reason: mark.reason,
        };
    }
    return out;
  }

  async noteLevelTurnFailure(
    level: unknown,
    reason: unknown,
    expectedModel?: string,
  ): Promise<void> {
    if (!isEffortLevel(level) || typeof reason !== "string" || !reason) return;
    const model = this.effortLevels()[level]!.model;
    if (expectedModel !== undefined && expectedModel !== model) return;
    await this.settingsFiles.writeJson(this.paths.AVAILABLE_MODELS_FILE, () => {
      const marks = this.readTurnMarks();
      marks[String(level)] = {
        model,
        reason: Array.from(reason).slice(0, 300).join(""),
      };
      return { version: TURN_MARKS_VERSION, turn_marks: marks };
    });
  }

  async noteLevelTurnSuccess(
    level: unknown,
    expectedModel?: string,
  ): Promise<void> {
    if (!isEffortLevel(level)) return;
    await this.settingsFiles.writeJson(this.paths.AVAILABLE_MODELS_FILE, () => {
      const marks = this.readTurnMarks();
      if (
        !Object.hasOwn(marks, String(level)) ||
        (expectedModel !== undefined &&
          marks[String(level)]?.model !== expectedModel)
      )
        return;
      delete marks[String(level)];
      return { version: TURN_MARKS_VERSION, turn_marks: marks };
    });
  }

  effortLevelReachability(): Record<
    number,
    { reachable: boolean; model: string; reasoning: string; reason: string }
  > {
    const authed = this.models.authedModelProviders();
    const ids = this.models.catalogModelIds();
    const marks = this.readTurnMarks();
    const out: Record<
      number,
      { reachable: boolean; model: string; reasoning: string; reason: string }
    > = {};
    for (const [levelKey, entry] of Object.entries(this.effortLevels())) {
      const level = Number(levelKey);
      const model = entry.model;
      let reachable: boolean;
      let reason: string;
      if (ids !== null && !ids.has(model)) {
        reason = `level ${level} model ${model} is not in Pi's model list`;
        reachable = false;
      } else if (
        !authed.has(this.models.providerOf(model)) &&
        !this.models.isFileProviderModel(model)
      ) {
        reason = `level ${level} model ${model} needs provider '${this.models.providerOf(model)}', which is not logged in`;
        reachable = false;
      } else if (marks[String(level)]?.model === model) {
        reason = `level ${level} model ${model} failed on the last turn: ${marks[String(level)]!.reason}`;
        reachable = false;
      } else {
        reason = "";
        reachable = true;
      }
      out[level] = { reachable, model, reasoning: entry.reasoning, reason };
    }
    return out;
  }
}
