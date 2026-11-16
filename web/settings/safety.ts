// Server-owned reviewer choice; saved unavailable models remain explicit.
import { settingsClient } from "./target.js";

type Result = {
  passed: number;
  total: number;
  falseAllows: number;
  medianMs: number;
  p90Ms: number;
};

export function buildSafetySection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  const field = document.createElement("div");
  field.className = "field safety-model-field";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Safety review model");
  select.disabled = true;
  field.append(select);
  const warning = document.createElement("p");
  warning.className = "msg err";
  const message = document.createElement("p");
  message.className = "msg";
  body.append(field, warning, message);
  api("/api/settings/safety-review-model")
    .then(async (response) => {
      if (!response.ok) throw new Error();
      const state = (await response.json()) as {
        model: string | null;
        invalid: boolean;
        default_model: string;
        models: { id: string; label: string }[];
        results: Record<string, Result>;
      };
      const resultText = (id: string) => {
        const result = state.results[id];
        return result
          ? `${result.passed}/${result.total} correct · ${(result.medianMs / 1000).toFixed(1)} s`
          : "Not tested";
      };
      const invalidChoice = "invalid-saved-choice";
      const selectedValue = () =>
        state.invalid ? invalidChoice : (state.model ?? "");
      const choices = [
        ...(state.invalid
          ? [{ id: invalidChoice, label: "Invalid saved choice" }]
          : []),
        { id: "", label: "Same as level 1" },
        ...state.models,
      ];
      if (state.model && !choices.some((choice) => choice.id === state.model))
        choices.push({
          id: state.model,
          label: `${state.model} (unavailable)`,
        });
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.id;
        option.disabled = choice.id === invalidChoice;
        option.textContent = `${choice.label} — ${resultText(choice.id || state.default_model)}`;
        select.append(option);
      }
      select.value = selectedValue();
      const refresh = () => {
        if (select.value === invalidChoice) {
          if (!message.textContent)
            message.textContent =
              "The saved safety review model is invalid. Choose a model to restore review.";
          warning.textContent = "";
          return;
        }
        const id = select.value || state.default_model;
        warning.textContent = state.results[id]?.falseAllows
          ? "This model has allowed risky actions in testing and may let risky actions through."
          : "";
      };
      refresh();
      select.disabled = false;
      select.onchange = async () => {
        select.disabled = true;
        try {
          const response = await jpost("/api/settings/safety-review-model", {
            model: select.value || null,
          });
          if (!response.ok) throw new Error();
          state.model = select.value || null;
          state.invalid = false;
          message.textContent = "Saved. Applies to the next run.";
        } catch {
          select.value = selectedValue();
          message.textContent =
            "Couldn't save the safety review model. Try again.";
        } finally {
          refresh();
          select.disabled = false;
        }
      };
    })
    .catch(() => {
      message.textContent = "Couldn't load safety review models. Try again.";
    });
}
