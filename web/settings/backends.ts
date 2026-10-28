// Remote sign-in exchanges a password once; lists and status contain no keys.
import { api } from "../api.js";
import { lastSeen } from "../backends/tree.js";
import { settingsSyncControl } from "./settings-sync.js";
import { buildConnectedHomes } from "./backend-keys.js";

interface Backend {
  label: string;
  url: string;
  state: string;
  reason: string | null;
  last_contact: number | null;
}
export function buildConnectedBackends(body: HTMLElement): void {
  body.className = "remotes-settings";
  const description = document.createElement("p");
  description.className = "remotes-description";
  description.textContent =
    "A remote is another Recurse instance whose agents appear in your sidebar and can message yours. Sign in with its existing password; the password is used once and not saved.";
  const list = document.createElement("div");
  const message = document.createElement("p");
  message.className = "msg";
  message.setAttribute("role", "status");
  message.hidden = true;
  const say = (text: string, error = false) => {
    message.textContent = text;
    message.classList.toggle("err", error);
    message.hidden = !text;
  };
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "Add a remote";
  add.setAttribute("aria-expanded", "false");
  const form = document.createElement("form");
  form.className = "remote-add";
  form.hidden = true;
  form.autocomplete = "off";
  form.id = "remote-add-form";
  add.setAttribute("aria-controls", form.id);
  add.onclick = () => {
    form.hidden = !form.hidden;
    add.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) inputs[0]!.focus();
  };
  const inputs = [
    "Remote name",
    "Remote address",
    "Password for that Recurse instance",
  ].map((name, index) => {
    const field = document.createElement("label");
    field.className = "field";
    field.textContent = name;
    const input = document.createElement("input");
    input.name = ["label", "url", "password"][index]!;
    input.type = ["text", "url", "password"][index]!;
    input.required = index !== 2;
    if (index === 0) {
      input.pattern = "[A-Za-z0-9._-]{1,32}";
      input.maxLength = 32;
    }
    if (index === 1) input.placeholder = "https://recurse.example.com";
    if (index === 2) {
      input.autocomplete = "current-password";
      input.setAttribute("data-1p-ignore", "true");
      input.setAttribute("data-lpignore", "true");
      input.setAttribute("data-bwignore", "true");
      input.maxLength = 4096;
    }
    field.append(input);
    form.append(field);
    return input;
  });
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Connect remote";
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(submit);
  form.append(actions);
  const incoming = document.createElement("div");
  incoming.className = "remote-incoming";
  body.append(description, list, add, form, message, incoming);
  buildConnectedHomes(incoming);
  const result = async (response: Response) => {
    const data = await response.json();
    if (!response.ok) {
      const detail =
        typeof data.detail === "string" ? data.detail : "Request failed";
      throw new Error(detail.charAt(0).toUpperCase() + detail.slice(1));
    }
    return data;
  };
  const refresh = async () => {
    window.dispatchEvent(new Event("recurse:refresh-remotes"));
    try {
      const rows = (await result(await api("/api/backends"))) as Backend[];
      list.textContent = "";
      for (const backend of rows) {
        const row = document.createElement("div");
        row.className = "remote-entry";
        const heading = document.createElement("div");
        heading.className = "row";
        const info = document.createElement("div");
        info.className = "remote-info";
        const name = document.createElement("strong");
        name.textContent = backend.label;
        const address = document.createElement("div");
        address.textContent = backend.url;
        const status = document.createElement("p");
        status.className = "msg";
        status.setAttribute("role", "status");
        status.textContent =
          backend.state === "connected"
            ? "Signed in"
            : backend.state === "key_revoked"
              ? "Sign-in revoked. Disconnect and add this remote again."
              : backend.state === "unreachable"
                ? backend.reason === "Health check pending"
                  ? "Signed in"
                  : `Offline · ${lastSeen(backend.last_contact)}`
                : backend.reason === "Needs sign-in"
                  ? ""
                  : backend.reason
                    ? backend.reason.charAt(0).toUpperCase() +
                      backend.reason.slice(1)
                    : "";
        if (backend.last_contact !== null)
          status.title = new Date(backend.last_contact * 1000).toLocaleString();
        status.hidden = !status.textContent;
        status.classList.toggle(
          "err",
          backend.state === "key_revoked" || backend.state === "pending",
        );
        info.append(name, address);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.textContent =
          backend.state === "pending" ? "Dismiss" : "Disconnect";
        button.onclick = async () => {
          button.disabled = true;
          try {
            const data = await result(
              await api(`/api/backends/${encodeURIComponent(backend.label)}`, {
                method: "DELETE",
              }),
            );
            say(data.warning ?? "");
            await refresh();
          } catch (error) {
            say(
              error instanceof Error ? error.message : "Disconnect failed",
              true,
            );
            button.disabled = false;
          }
        };
        heading.append(info, button);
        row.append(heading, status);
        if (backend.state === "pending") {
          const signIn = document.createElement("form");
          signIn.className = "remote-sign-in";
          signIn.autocomplete = "off";
          const field = document.createElement("label");
          field.className = "field";
          field.textContent = `Password for ${backend.label}`;
          const password = document.createElement("input");
          password.type = "password";
          password.autocomplete = "current-password";
          password.setAttribute("data-1p-ignore", "true");
          password.setAttribute("data-lpignore", "true");
          password.setAttribute("data-bwignore", "true");
          password.maxLength = 4096;
          password.setAttribute("aria-label", `Password for ${backend.label}`);
          field.append(password);
          const submit = document.createElement("button");
          submit.type = "submit";
          submit.className = "primary";
          submit.textContent = "Sign in";
          signIn.append(field, submit);
          signIn.onsubmit = async (event) => {
            event.preventDefault();
            submit.disabled = true;
            button.disabled = true;
            submit.textContent = "Signing in…";
            status.hidden = true;
            const payload = { password: password.value };
            password.value = "";
            try {
              await result(
                await api(
                  `/api/backends/${encodeURIComponent(backend.label)}/sign-in`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(payload),
                  },
                ),
              );
              await refresh();
            } catch (error) {
              status.textContent =
                error instanceof Error ? error.message : "Sign-in failed";
              status.classList.add("err");
              status.hidden = false;
              password.focus();
            } finally {
              payload.password = "";
              password.value = "";
              submit.disabled = false;
              button.disabled = false;
              submit.textContent = "Sign in";
            }
          };
          row.append(signIn);
        } else row.append(settingsSyncControl(backend.label));
        list.append(row);
      }
    } catch (error) {
      say(
        error instanceof Error
          ? error.message
          : "Could not load remotes. Reopen Settings to retry.",
        true,
      );
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Connecting…";
    say("");
    const payload = {
      label: inputs[0]!.value,
      url: inputs[1]!.value,
      password: inputs[2]!.value,
    };
    inputs[2]!.value = "";
    try {
      await result(
        await api("/api/backends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      form.reset();
      form.hidden = true;
      add.setAttribute("aria-expanded", "false");
      await refresh();
    } catch (error) {
      say(error instanceof Error ? error.message : "Connect failed", true);
    } finally {
      payload.password = "";
      inputs[2]!.value = "";
      submit.disabled = false;
      submit.textContent = "Connect remote";
    }
  };
  void refresh();
}
