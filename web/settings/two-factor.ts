// Account-only two-factor setup; confirmation removes the setup secret.
import { api, jpost } from "../api.js";
import { settingsDetail } from "./layout.js";

export function buildTwoFactorSection(body: HTMLElement): void {
  body.dataset.themeProtected = "two-factor-sign-in";
  let enabled = false;
  let action = "setup";
  const editor = document.createElement("div");
  body.append(editor);
  const detail = settingsDetail(body, "Two-factor sign-in", () =>
    enabled ? "On" : "Off",
  );
  const render = () => {
    action = enabled ? "disable" : "setup";
    editor.innerHTML = `<form autocomplete="off">
      <div class="group">
        <label class="item field">Current password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
        <div class="two-factor-setup" hidden>
          <span>Authenticator setup key</span><pre class="setup-key cmd"></pre>
          <a class="setup-link link settings-row">Open authenticator app</a>
        </div>
        <label class="item field code-field" ${enabled ? "" : "hidden"}>Authenticator or recovery code<input name="code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" maxlength="64" ${enabled ? "required" : ""}></label>
      </div>
      <div class="actions"><p class="msg" role="status"></p><button class="primary" type="submit">${enabled ? "Turn off two-factor sign-in" : "Set up two-factor sign-in"}</button></div>
    </form>`;
    detail.refresh();
    const form = editor.querySelector("form")!;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    const code = form.elements.namedItem("code") as HTMLInputElement;
    const button = form.querySelector("button")!;
    const message = form.querySelector<HTMLElement>(".msg")!;
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      message.textContent = "";
      try {
        const response = await jpost(
          "/api/settings/two-factor",
          {
            action,
            password: password.value,
            code: code.value,
          },
          { renewsSession: action !== "setup" },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            typeof data.detail === "string"
              ? data.detail
              : "Could not change two-factor sign-in",
          );
        if (action === "setup") {
          form.querySelector<HTMLElement>(".two-factor-setup")!.hidden = false;
          form.querySelector(".setup-key")!.textContent = data.secret;
          form.querySelector<HTMLAnchorElement>(".setup-link")!.href = data.url;
          form.querySelector<HTMLElement>(".code-field")!.hidden = false;
          code.required = true;
          action = "enable";
          button.textContent = "Turn on two-factor sign-in";
          code.focus();
        } else {
          enabled = data.enabled;
          password.value = "";
          code.value = "";
          if (enabled) {
            editor.innerHTML = `<p>Save these codes now; each works once and they won't be shown again.</p><pre class="recovery-codes cmd"></pre><button type="button">Done</button>`;
            editor.querySelector("pre")!.textContent =
              data.recovery_codes.join("\n");
            editor.querySelector("button")!.onclick = render;
            detail.refresh();
          } else render();
        }
      } catch (error) {
        code.value = "";
        message.className = "msg err";
        message.textContent =
          error instanceof Error ? error.message : "Network error. Try again.";
      } finally {
        button.disabled = false;
      }
    };
  };
  api("/api/settings/two-factor")
    .then(async (response) => {
      if (!response.ok) throw new Error();
      enabled = (await response.json()).enabled;
      render();
    })
    .catch(() => {
      editor.textContent =
        "Could not load two-factor sign-in. Reopen Settings to retry.";
    });
}
