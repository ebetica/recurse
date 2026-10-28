// Home-only name and icon settings, applied to the shell after reload.
import { api, jpost } from "../api.js";

export function buildBrandingSection(body: HTMLElement): void {
  body.innerHTML = `
    <form class="brand-settings">
      <label>App name<input name="name" type="text" maxlength="80" required></label>
      <div class="row"><button class="primary" type="submit">Save name</button><button class="secondary" type="button" name="reset-name">Reset to default</button></div>
      <label>App icon (PNG or SVG, up to 1 MiB)<input name="icon" type="file" accept="image/png,image/svg+xml,.png,.svg"></label>
      <button class="secondary" type="button" name="reset-icon">Reset to default</button>
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
  const show = async (response: Response, saved = false) => {
    const value = (await response.json()) as { name: string; detail?: string };
    if (!response.ok)
      throw new Error(value.detail || "Couldn't save name and icon.");
    name.value = value.name;
    if (saved) msg.textContent = "Saved. Reload the page to see changes.";
  };
  const run = async (work: () => Promise<Response>) => {
    const controls = [
      ...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input,button",
      ),
    ];
    controls.forEach((control) => (control.disabled = true));
    msg.textContent = "";
    try {
      await show(await work(), true);
    } catch (error) {
      msg.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      controls.forEach((control) => (control.disabled = false));
    }
  };
  name.disabled = true;
  void api("/api/settings/branding")
    .then((response) => show(response))
    .catch(() => {
      msg.textContent = "Couldn't load name and icon.";
    })
    .finally(() => (name.disabled = false));
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
