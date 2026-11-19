// Home-only name and icon editor sheet, applied to the shell after reload.
import { api, apiJson, jpost } from "../api.js";
import { settingsDetail } from "./layout.js";

export function buildBrandingSection(body: HTMLElement): void {
  body.innerHTML = `
    <form class="brand-settings">
      <div class="group">
        <label class="item field">App name<input name="name" type="text" maxlength="80" required></label>
        <div class="item actions"><button class="secondary" type="button" name="reset-name">Reset to default</button><button class="primary" type="submit">Save name</button></div>
        <label class="item field">App icon (PNG or SVG, up to 1 MiB)<input name="icon" type="file" accept="image/png,image/svg+xml,.png,.svg"></label>
        <div class="item actions"><button class="secondary" type="button" name="reset-icon">Reset to default</button></div>
      </div>
      <p class="hint">Reload the page to see changes.</p><p class="msg" role="status"></p>
    </form>`;
  const form = body.querySelector<HTMLFormElement>("form")!;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]')!;
  const icon = form.querySelector<HTMLInputElement>('input[name="icon"]')!;
  const msg = form.querySelector<HTMLElement>(".msg")!;
  const resetName = form.querySelector<HTMLButtonElement>(
    '[name="reset-name"]',
  )!;
  const resetIcon = form.querySelector<HTMLButtonElement>(
    '[name="reset-icon"]',
  )!;
  let loading = true;
  const detail = settingsDetail(body, "Name and icon", () =>
    loading ? "Checking…" : name.value,
  );
  type Branding = { name: string; detail?: string };
  const show = (response: Response, value: Branding, saved = false) => {
    if (!response.ok)
      throw new Error(value.detail || "Couldn't save name and icon.");
    name.value = value.name;
    detail.refresh();
    if (saved) msg.textContent = "Saved. Reload the page to see changes.";
  };
  const setDisabled = (disabled: boolean) => {
    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input,button"))
      control.disabled = disabled;
  };
  const run = async (work: () => Promise<Response>) => {
    setDisabled(true);
    msg.textContent = "";
    try {
      const response = await work();
      show(response, (await response.json()) as Branding, true);
    } catch (error) {
      msg.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setDisabled(false);
    }
  };
  // Invariant: every control waits for the stored name, so neither typing nor
  // a finished Save or Reset can be replaced by it. The load has a deadline,
  // so a stalled response unlocks the form with an error.
  setDisabled(true);
  void apiJson<Branding>(
    "/api/settings/branding",
    {},
    { availability: "optional", timeoutMs: 10_000 },
  )
    .then(({ response, data }) => show(response, data))
    .catch(() => {
      msg.textContent = "Couldn't load name and icon.";
    })
    .finally(() => {
      loading = false;
      detail.refresh();
      setDisabled(false);
    });
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = name.value;
    void run(() => jpost("/api/settings/branding", { name: value }));
  };
  resetName.onclick = () => {
    void run(() => jpost("/api/settings/branding", { name: null }));
  };
  resetIcon.onclick = () => {
    void run(() => jpost("/api/settings/branding", { icon: null }));
  };
  icon.onchange = () => {
    const file = icon.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      msg.textContent = "Choose an icon up to 1 MiB.";
      icon.value = "";
      return;
    }
    void run(() =>
      api("/api/settings/branding/icon", { method: "POST", body: file }),
    ).finally(() => (icon.value = ""));
  };
}
