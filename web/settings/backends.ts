// Remote rows open detail sheets; sign-in and status never expose keys.
import { api } from "../api.js";
import { lastSeen } from "../backends/tree.js";
import { settingsSyncControl } from "./settings-sync.js";
import { buildConnectedHomes } from "./backend-keys.js";
import { arrangeRows, holdsFocus, settingsDetail } from "./layout.js";

function signInCode() {
  const field = document.createElement("label");
  field.className = "item field";
  field.textContent = "Authenticator or recovery code";
  field.hidden = true;
  const input = document.createElement("input");
  input.autocomplete = "one-time-code";
  input.maxLength = 64;
  input.spellcheck = false;
  field.append(input);
  return {
    field,
    input,
    show: () => {
      field.hidden = false;
      input.required = true;
    },
  };
}

interface Backend {
  label: string;
  url: string;
  state: string;
  reason: string | null;
  last_contact: number | null;
  compatibility: "compatible" | "older" | "incompatible" | "unknown";
  remote_api: number | null;
  remote_revision: number | null;
  remote_release: string | null;
}
export function buildConnectedBackends(body: HTMLElement): void {
  body.dataset.themeProtected = "remote-sign-in";
  body.className = "remotes-settings";
  const list = document.createElement("div");
  list.className = "group";
  const message = document.createElement("p");
  message.className = "msg";
  message.setAttribute("role", "status");
  message.hidden = true;
  const say = (text: string, error = false, target: HTMLElement = message) => {
    target.textContent = text;
    target.classList.toggle("err", error);
    target.hidden = !text;
  };
  const add = document.createElement("div");
  const form = document.createElement("form");
  form.className = "remote-add";
  form.autocomplete = "off";
  const formMessage = message.cloneNode() as HTMLElement;
  form.append(formMessage);
  const fields = document.createElement("div");
  fields.className = "group";
  form.append(fields);
  const inputs = [
    "Remote name",
    "Remote address",
    "Password for that Recurse instance",
  ].map((name, index) => {
    const field = document.createElement("label");
    field.className = "item field";
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
    fields.append(field);
    return input;
  });
  const code = signInCode();
  fields.append(code.field);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Connect remote";
  const connect = document.createElement("div");
  connect.className = "item actions";
  connect.append(submit);
  fields.append(connect);
  add.append(form);
  const addDetail = settingsDetail(add, "Add a remote");
  const incoming = document.createElement("div");
  incoming.className = "remote-incoming";
  body.append(list, message, add, incoming);
  buildConnectedHomes(incoming);
  const result = async (response: Response, needCode?: () => void) => {
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 428) needCode?.();
      const detail =
        typeof data.detail === "string" ? data.detail : "Request failed";
      throw new Error(detail.charAt(0).toUpperCase() + detail.slice(1));
    }
    return data;
  };
  type Entry = {
    pending: boolean;
    url: string;
    row: HTMLElement;
    status: HTMLElement;
    detail: ReturnType<typeof settingsDetail>;
  };
  const statuses = new Map<string, Entry>();
  // Invariant: every list read keeps each surviving remote's row and detail in
  // place; a remote that is gone, signed in or re-added at another address is
  // rebuilt, and focus left in its old row moves to "Add a remote".
  const drop = (label: string) => {
    const entry = statuses.get(label)!;
    const focused = holdsFocus(entry.row);
    entry.detail.close();
    entry.row.remove();
    statuses.delete(label);
    if (focused)
      add.querySelector<HTMLElement>(":scope > .settings-row")!.focus();
  };
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () =>
    body.isConnected &&
    document.querySelector("#settings-overlay")!.classList.contains("on") &&
    !body.closest<HTMLElement>(".settings-cat")!.hidden;
  const showStatus = (status: HTMLElement, backend: Backend) => {
    status.textContent =
      backend.state === "connected"
        ? ""
        : backend.state === "key_revoked"
          ? "Sign-in revoked. Disconnect and add this remote again."
          : backend.state === "unreachable"
            ? backend.reason === "Health check pending"
              ? ""
              : `Offline · ${lastSeen(backend.last_contact)}`
            : backend.reason === "Needs sign-in"
              ? ""
              : backend.reason
                ? backend.reason.charAt(0).toUpperCase() +
                  backend.reason.slice(1)
                : "";
    if (
      (backend.state === "connected" ||
        backend.reason === "Health check pending") &&
      backend.compatibility === "incompatible"
    )
      status.textContent = "Incompatible versions. Update both instances.";
    else if (
      (backend.state === "connected" ||
        backend.reason === "Health check pending") &&
      backend.compatibility === "older"
    )
      status.textContent = "Older version: some agent commands need an update.";
    status.title =
      backend.last_contact === null
        ? ""
        : new Date(backend.last_contact * 1000).toLocaleString();
    status.hidden = !status.textContent;
    status.classList.toggle(
      "err",
      backend.state === "key_revoked" ||
        backend.state === "pending" ||
        backend.compatibility === "incompatible",
    );
  };
  const refresh = async (): Promise<boolean> => {
    const current = ++revision;
    window.dispatchEvent(new Event("recurse:refresh-remotes"));
    try {
      const rows = (await result(await api("/api/backends"))) as Backend[];
      if (current === revision) reconcile(rows);
      return true;
    } catch (error) {
      say(
        error instanceof Error
          ? error.message
          : "Could not load remotes. Reopen Settings to retry.",
        true,
      );
      return false;
    }
  };
  const reconcile = (rows: Backend[]) => {
    const reopen: string[] = [];
    for (const [label, entry] of Array.from(statuses)) {
      const backend = rows.find((row) => row.label === label);
      if (backend?.url === entry.url) {
        if (entry.pending === (backend.state === "pending")) continue;
        if (entry.row.querySelector(":scope > dialog[open]"))
          reopen.push(label);
      }
      drop(label);
    }
    arrangeRows(
      list,
      rows.map((backend) => {
        const entry = statuses.get(backend.label) ?? build(backend);
        showStatus(entry.status, backend);
        entry.detail.refresh();
        return entry.row;
      }),
    );
    for (const label of reopen) statuses.get(label)?.detail.open();
  };
  const build = (backend: Backend): Entry => {
    const row = document.createElement("div");
    row.className = "remote-entry";
    const heading = document.createElement("div");
    heading.className = "row";
    const info = document.createElement("div");
    info.className = "remote-info";
    const address = document.createElement("div");
    address.textContent = backend.url;
    const status = document.createElement("p");
    status.className = "msg";
    status.setAttribute("role", "status");
    showStatus(status, backend);
    info.append(address);
    const buttons = document.createElement("span");
    buttons.className = "remote-buttons";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-row danger";
    button.textContent = backend.state === "pending" ? "Dismiss" : "Disconnect";
    button.onclick = async () => {
      button.disabled = true;
      try {
        const data = await result(
          await api(`/api/backends/${encodeURIComponent(backend.label)}`, {
            method: "DELETE",
          }),
        );
        detail.close();
        say(data.warning ?? "");
        await refresh();
      } catch (error) {
        say(
          error instanceof Error ? error.message : "Disconnect failed",
          true,
          status,
        );
        detail.refresh();
        button.disabled = false;
      }
    };
    buttons.append(button);
    heading.append(info, buttons);
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
      const code = signInCode();
      signIn.append(field, code.field, submit);
      signIn.onsubmit = async (event) => {
        event.preventDefault();
        submit.disabled = true;
        button.disabled = true;
        submit.textContent = "Signing in…";
        status.hidden = true;
        const payload = {
          url: backend.url,
          password: password.value,
          code: code.input.value,
        };
        password.value = "";
        code.input.value = "";
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
            code.show,
          );
          if (!(await refresh())) {
            status.textContent =
              "Signed in, but the list of remotes could not be refreshed. Reopen Settings to see it.";
            status.classList.remove("err");
            status.hidden = false;
            detail.refresh();
          }
        } catch (error) {
          status.textContent =
            error instanceof Error ? error.message : "Sign-in failed";
          status.classList.add("err");
          status.hidden = false;
          detail.refresh();
          password.focus();
        } finally {
          payload.password = "";
          payload.code = "";
          password.value = "";
          code.input.value = "";
          submit.disabled = false;
          button.disabled = false;
          submit.textContent = "Sign in";
        }
      };
      row.append(signIn);
    } else {
      const sync = settingsSyncControl(backend.label);
      buttons.prepend(sync.button);
      row.append(sync.panel);
    }
    list.append(row);
    const detail = settingsDetail(
      row,
      backend.label,
      () =>
        status.textContent ||
        (backend.state === "pending" ? "Needs sign-in" : "Connected"),
    );
    // Invariant: Opening a remote reads its current state, not the last poll's.
    row
      .querySelector(":scope > .settings-row")!
      .addEventListener("click", () => void poll());
    const entry = {
      pending: backend.state === "pending",
      url: backend.url,
      row,
      status,
      detail,
    };
    statuses.set(backend.label, entry);
    return entry;
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Connecting…";
    say("");
    say("", false, formMessage);
    const payload = {
      label: inputs[0]!.value,
      url: inputs[1]!.value,
      password: inputs[2]!.value,
      code: code.input.value,
    };
    inputs[2]!.value = "";
    code.input.value = "";
    try {
      await result(
        await api("/api/backends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        code.show,
      );
      form.reset();
      code.field.hidden = true;
      code.input.required = false;
      addDetail.close();
      await refresh();
    } catch (error) {
      say(
        error instanceof Error ? error.message : "Connect failed",
        true,
        formMessage,
      );
      addDetail.refresh();
    } finally {
      payload.password = "";
      payload.code = "";
      code.input.value = "";
      inputs[2]!.value = "";
      submit.disabled = false;
      submit.textContent = "Connect remote";
    }
  };
  let latestPoll = 0;
  // Invariant: Only the newest poll applies its answer and arms the timer.
  const poll = async () => {
    if (!active()) return;
    clearTimeout(timer);
    const current = revision;
    const read = ++latestPoll;
    try {
      const rows = (await result(await api("/api/backends"))) as Backend[];
      if (read === latestPoll && current === revision && active())
        reconcile(rows);
    } catch {
      // Invariant: A transient status read does not erase the last known state.
    } finally {
      if (read === latestPoll) {
        clearTimeout(timer);
        if (active()) timer = setTimeout(() => void poll(), 5000);
      }
    }
  };
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    if (!body.isConnected) observer.disconnect();
    else if (active()) timer = setTimeout(() => void poll(), 5000);
  });
  queueMicrotask(() => {
    if (!body.isConnected) return;
    observer.observe(document.querySelector("#settings-overlay")!, {
      attributes: true,
      attributeFilter: ["class"],
    });
    observer.observe(body.closest(".settings-cat")!, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    observer.observe(document.querySelector("#settings-sections")!, {
      childList: true,
    });
    if (active()) timer = setTimeout(() => void poll(), 5000);
  });
  void refresh();
}
