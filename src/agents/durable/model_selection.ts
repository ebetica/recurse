// Parse and validate conversation model choices; failures are actionable,
// never a provider fallback.
import type { Models } from "@earendil-works/pi-ai";

/** An unavailable or malformed conversation model selection. */
export class ModelSelectionError extends Error {
  constructor(model: string) {
    super(
      `${model ? `Model ${model} is unavailable.` : "No model is selected for this conversation."} Pick another effort level in the model picker, or fix its model in Settings > Effort ladder.`,
    );
    this.name = "ModelSelectionError";
  }
  override toString(): string {
    return this.message;
  }
}

// An unknown model fails the conversation; it never runs on another provider.
export function requireModel(
  models: Models,
  model: { provider: string; modelId: string },
): void {
  if (models.getModel(model.provider, model.modelId) === undefined)
    throw new ModelSelectionError(`${model.provider}/${model.modelId}`);
}

/** "provider/model" as Durable's model reference. */
export function modelRef(model: unknown): {
  provider: string;
  modelId: string;
} {
  const text = typeof model === "string" ? model : "";
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1)
    throw new ModelSelectionError(text);
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}
