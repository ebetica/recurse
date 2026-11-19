import { expect, test } from "bun:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  indexModels,
  MODEL_FINDER_LIMIT,
  searchModelsByRoute,
  type FinderModel,
} from "../../web/models/finder.js";

const catalog = (
  provider: Parameters<typeof getBuiltinModels>[0],
  route: string,
): FinderModel[] =>
  getBuiltinModels(provider).map((model) => ({
    id: `${provider}/${model.id}`,
    label: model.name,
    route,
    context_window: model.contextWindow,
    reasoning_levels: null,
  }));

test("the finder splits its rows evenly and keeps the current model last in its route", () => {
  const openai = catalog("openai", "OpenAI API");
  const openrouter = catalog("openrouter", "OpenRouter");
  const index = indexModels([...openai, ...openrouter]);
  const unchosen = searchModelsByRoute(index, "");
  expect(
    unchosen.map((group) => [group.route, group.models.length, group.total]),
  ).toEqual([
    ["OpenAI API", 25, openai.length],
    ["OpenRouter", 25, openrouter.length],
  ]);
  const shown = new Set(unchosen[1]!.models.map((model) => model.id));
  const cut = openrouter.find((model) => !shown.has(model.id))!;
  const chosen = searchModelsByRoute(index, "", MODEL_FINDER_LIMIT, cut.id);
  expect(chosen[0]!.models).toEqual(unchosen[0]!.models);
  expect(chosen[1]!.models).toEqual([...unchosen[1]!.models.slice(0, 24), cut]);
  const subscription = catalog("openai-codex", "ChatGPT subscription");
  const uneven = searchModelsByRoute(
    indexModels([...subscription, ...openrouter]),
    "",
  );
  expect(uneven.map((group) => group.models.length)).toEqual([
    subscription.length,
    MODEL_FINDER_LIMIT - subscription.length,
  ]);
});
