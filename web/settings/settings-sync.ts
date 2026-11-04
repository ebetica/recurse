// Remote values and refusal reasons are text, never markup.
import { api } from "../api.js";

/** A remote sheet's sync action and operator-confirmed preview. */
export function settingsSyncControl(label: string): {
  button: HTMLButtonElement;
  panel: HTMLElement;
} {
  const panel = document.createElement("div");
  panel.className = "remote-sync";
  const description = document.createElement("p");
  description.className = "remotes-description";
  description.textContent =
    "Only effort levels, default efforts, context window and theme are copied. Passwords and sign-ins are not copied.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-row";
  button.textContent = "Sync settings from home";
  const content = document.createElement("div");
  content.setAttribute("role", "status");
  panel.append(description, content);
  const request = async (body?: unknown) => {
    const response = await api(
      `/api/backends/${encodeURIComponent(label)}/settings-sync`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data.detail === "string" ? data.detail : "Sync failed",
      );
    return data;
  };
  const failure = (error: unknown) => {
    content.textContent =
      error instanceof Error ? error.message : "Sync failed";
    button.hidden = false;
    button.disabled = false;
  };
  button.onclick = async () => {
    button.disabled = true;
    content.textContent = "Loading preview…";
    try {
      const preview = await request();
      content.textContent = "";
      const list = document.createElement("ul");
      list.className = "group";
      for (const item of preview.items) {
        const row = document.createElement("li");
        row.className = "item";
        row.textContent = `${item.item}: ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)} · ${item.status}${item.reason ? `: ${item.reason}` : ""}`;
        list.append(row);
      }
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary";
      button.hidden = true;
      confirm.textContent = `Apply settings to ${label}`;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancel";
      cancel.onclick = () => {
        content.textContent = "";
        button.hidden = false;
        button.disabled = false;
      };
      confirm.onclick = async () => {
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          const data = await request({
            preview: preview.preview,
            signature: preview.signature,
          });
          list.textContent = "";
          for (const result of data.results) {
            const row = document.createElement("li");
            row.className = "item";
            row.textContent = `${result.item}: ${result.status}`;
            list.append(row);
          }
          confirm.remove();
          cancel.remove();
          button.hidden = false;
          button.disabled = false;
        } catch (error) {
          failure(error);
        }
      };
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(confirm, cancel);
      content.append(list, actions);
    } catch (error) {
      failure(error);
    }
  };
  return { button, panel };
}
