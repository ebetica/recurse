// Settings saves the reviewer separately from the effort levels. Its row
// names the model and the route that pays for it, like the level rows.
import {
  createModelBox,
  indexModels,
  showModelRoute,
} from "../models/index.js";
import { settingsDetail } from "./layout.js";
import { settingsClient } from "./target.js";

const ENDPOINT = "/api/settings/safety-review-model";
const DEFAULT = "Same as level 1";
const INVALID = "Invalid saved choice";

export function buildSafetyReviewRow(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  let summary = "Checking…";
  const message = document.createElement("p");
  message.className = "msg";
  message.textContent = summary;
  message.setAttribute("role", "status");
  body.append(message);
  const detail = settingsDetail(body, "Safety review", () => summary, {
    alwaysSheet: true,
  });
  const confirmation = document.createElement("p");
  confirmation.className = "msg ok";
  confirmation.setAttribute("role", "status");
  body.append(confirmation);
  api(ENDPOINT)
    .then(async (response) => {
      if (!response.ok) throw new Error();
      const state = (await response.json()) as {
        model: string | null;
        invalid: boolean;
        route?: string;
        models: { id: string; label: string; route?: string }[];
      };
      const models = [{ id: "", label: DEFAULT, route: "" }, ...state.models];
      const labels = new Map(models.map(({ id, label }) => [id, label]));
      const routes = new Map(models.map(({ id, route }) => [id, route ?? ""]));
      const row = body.querySelector(":scope > .settings-row")!;
      const invalid = "invalid-saved-choice";
      let saved = state.invalid ? invalid : (state.model ?? "");
      const nameOf = (id: string) =>
        id === invalid ? INVALID : (labels.get(id) ?? `${id} (unavailable)`);
      const box = createModelBox({
        label: "Safety review model",
        index: indexModels(
          models.map((model) => ({
            ...model,
            route: model.route ?? "",
            context_window: null,
            reasoning_levels: null,
          })),
        ),
        value: saved,
        nameOf,
        onPick: async ({ id }) => {
          if (id === saved) {
            detail.close();
            return;
          }
          box.input.disabled = true;
          confirmation.textContent = "";
          message.className = "msg";
          message.textContent = "Saving…";
          try {
            const response = await jpost(ENDPOINT, { model: id || null });
            if (!response.ok) throw new Error();
            saved = id;
            summary = nameOf(saved);
            detail.refresh();
            showModelRoute(row, routes.get(saved) ?? "");
            message.textContent = "Changes apply to the next run.";
            detail.close();
            confirmation.textContent = "Saved. Applies to the next run.";
          } catch {
            box.setValue(saved);
            message.className = "msg err";
            message.textContent =
              "Couldn't save the safety review model. Try again.";
          } finally {
            box.input.disabled = false;
          }
        },
      });
      box.input.autofocus = true;
      message.before(box.element);
      summary = nameOf(saved);
      detail.refresh();
      showModelRoute(row, routes.get(saved) ?? state.route ?? "");
      message.textContent = state.invalid
        ? "Choose a model to restore safety review."
        : "Changes apply to the next run.";
    })
    .catch(() => {
      summary = "Couldn't load";
      detail.refresh();
      message.className = "msg err";
      message.textContent =
        "Couldn't load safety review models. Reopen Models to try again.";
    });
}
