// Explicit reviewers come from Pi's shipped catalog, not its mutable list.
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type StoredModelSignIns = ReadonlyMap<string, "api_key" | "oauth">;

// Only reviewed, fixed chat endpoints receive evidence from explicit pins.
const FIXED_CHAT_PROVIDERS = new Set([
  "anthropic",
  "meta",
  "openai",
  "openai-codex",
  "openrouter",
]);

export function shippedReviewModels(signIns?: StoredModelSignIns) {
  const available = builtinProviders()
    .filter((provider) => {
      if (!signIns) return true;
      const type = signIns.get(provider.id);
      if (provider.id === "openai" && type !== "api_key") return false;
      if (provider.id === "openai-codex" && type !== "oauth") return false;
      return type === "api_key"
        ? provider.auth.apiKey !== undefined
        : type === "oauth" && provider.auth.oauth !== undefined;
    })
    .flatMap((provider) =>
      (provider.getAllModels?.() ?? []).flatMap((model) =>
        model.type === "classifier" ||
        (model.type === "chat" && FIXED_CHAT_PROVIDERS.has(model.provider))
          ? [
              {
                provider: model.provider,
                providerLabel: provider.name,
                id: model.id,
                label: model.name,
                type: model.type,
              },
            ]
          : [],
      ),
    );
  // Invariant: A saved choice names one provider/model pair. If Pi ships both
  // a chat model and a classifier for that pair, use the classifier.
  const choices = new Map<string, (typeof available)[number]>();
  for (const model of available) {
    const key = `${model.provider}/${model.id}`;
    if (choices.get(key)?.type !== "classifier") choices.set(key, model);
  }
  return [...choices.values()];
}

export function signedInReviewModels(
  signedIn: StoredModelSignIns,
  routes: readonly (readonly [string, string])[],
) {
  const labels = new Map(routes);
  return shippedReviewModels(signedIn).map(
    ({ provider, providerLabel, id, label, type }) => ({
      id: `${provider}/${id}`,
      label: type === "classifier" ? `${label} · classifier` : label,
      route: labels.get(provider) ?? providerLabel,
    }),
  );
}
