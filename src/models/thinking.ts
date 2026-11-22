// Reasoning values accepted in model Settings and persisted conversations.
import { valueError } from "../config_files";

export const Thinking = {
  OFF: "off",
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
  MAX: "max",
} as const;
export const THINKING_LEVELS = Object.values(Thinking);
export type Thinking = (typeof Thinking)[keyof typeof Thinking];

export function parseThinking(value: unknown): Thinking {
  if (
    typeof value === "string" &&
    THINKING_LEVELS.includes(value as Thinking)
  ) {
    return value as Thinking;
  }
  throw valueError(`'${String(value)}' is not a valid Thinking`);
}
