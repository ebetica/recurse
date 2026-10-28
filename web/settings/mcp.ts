/** MCP reads/checks/sign-in live only while Settings is visible. */
import { settingsClient, settingsDirectUrl, settingsLabel } from "./target.js";
import { copyText } from "../tool_details.js";

interface ServerStatus {
  name: string;
  state: "connected" | "failed" | "needs-sign-in" | "disabled" | "not-used";
  checkedAt: number | null;
  signedIn?: boolean;
  toolCount?: number;
  reason?: string;
  checking?: boolean;
}

export function buildMcpStatus(body: HTMLElement): () => void {
  const { api, jpost } = settingsClient();
  const list = document.createElement("div");
  list.className = "mcp-status";
  list.setAttribute("aria-label", "MCP server status");
  const message = document.createElement("p");
  message.className = "msg err";
  message.setAttribute("role", "status");
  message.hidden = true;
  const say = (text: string) => {
    message.textContent = text;
    message.hidden = !text;
  };
  // Spec: Off-loopback HTTP requires a pasted loopback redirect;
  // providers refuse plain-HTTP callbacks elsewhere.
  const paste =
    location.protocol === "http:" &&
    !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(location.hostname);
  const originCallback = `${location.origin}/api/settings/mcp-servers/oauth-callback`;
  const callback = paste
    ? "http://127.0.0.1/mcp-oauth-callback"
    : originCallback;
  const callbackRow = document.createElement("div");
  callbackRow.className = "row";
  const callbackInput = document.createElement("input");
  callbackInput.readOnly = true;
  callbackInput.value = callback;
  callbackInput.setAttribute("aria-label", "OAuth callback URL");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary";
  copy.textContent = "Copy callback URL";
  copy.onclick = async () => {
    if (!(await copyText(callback))) say("Couldn't copy the callback URL.");
  };
  callbackRow.append(callbackInput, copy);
  // Spec: OAuth returns to its starting origin; remote sign-in uses
  // the remote page, while signing out works from here.
  const remote = settingsLabel();
  if (remote) {
    callbackRow.className = "hint";
    callbackRow.textContent = `Sign in to MCP servers on ${remote} from its own page: ${settingsDirectUrl()}`;
  }
  body.prepend(callbackRow, list, message);
  let servers: ServerStatus[] = [];
  const pending = new Set<string>();
  let pasting:
    | { name: string; url: string; redirectUrl: string; answer?: string }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  let revision = 0;
  const active = () =>
    body.isConnected &&
    document.querySelector("#settings-overlay")!.classList.contains("on") &&
    !body.closest<HTMLElement>(".settings-cat")!.hidden;
  const time = (value: number) => new Date(value).toLocaleString();
  const render = () => {
    list.replaceChildren();
    if (!servers.length) list.textContent = "No MCP servers configured.";
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "mcp-server";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = server.name;
      const state = document.createElement("span");
      state.className = "mcp-state";
      state.dataset.state = server.state;
      const checking = !!server.checking || pending.has(server.name);
      state.textContent = checking
        ? "Checking…"
        : {
            connected: "Connected",
            failed: "Failed",
            "needs-sign-in": "Needs sign-in",
            disabled: "Disabled",
            "not-used": "Not used",
          }[server.state];
      const detail = document.createElement("div");
      detail.className = "mcp-detail";
      detail.textContent = [
        server.toolCount === undefined ? "" : `${server.toolCount} tools`,
        server.reason,
        server.checkedAt === null
          ? "Never checked"
          : `Last checked: ${time(server.checkedAt)}`,
      ]
        .filter(Boolean)
        .join(" · ");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = checking ? "Checking…" : "Check";
      button.setAttribute("aria-label", `Check ${server.name}`);
      button.disabled = checking || server.state === "disabled";
      button.onclick = () =>
        act("check", "Couldn't check this server.", () => {});
      const act = async (
        path: string,
        failure: string,
        done: (body: { url?: string; redirectUrl?: string }) => void,
        extra: { url?: string } = {},
      ) => {
        pending.add(server.name);
        say("");
        render();
        try {
          const response = await jpost(`/api/settings/mcp-servers/${path}`, {
            name: server.name,
            ...extra,
          });
          const body = (await response.json()) as {
            detail?: string;
            url?: string;
            redirectUrl?: string;
          };
          if (!response.ok) throw new Error(body.detail || failure);
          done(body);
        } catch (error) {
          say(error instanceof Error ? error.message : failure);
        } finally {
          pending.delete(server.name);
          if (active()) void refresh();
        }
      };
      const account = document.createElement("button");
      account.type = "button";
      account.className = "secondary";
      account.textContent = server.signedIn ? "Sign out" : "Sign in";
      account.setAttribute(
        "aria-label",
        `${server.signedIn ? "Sign out of" : "Sign in to"} ${server.name}`,
      );
      account.disabled = checking;
      account.onclick = () =>
        server.signedIn
          ? act("sign-out", "Couldn't sign out of this server.", () => {})
          : act("sign-in", "Couldn't start sign-in.", (body) => {
              // Spec: Answers for any other redirect URI are pasted back.
              if (body.url && body.redirectUrl === originCallback)
                location.assign(body.url);
              else if (body.url)
                pasting = {
                  name: server.name,
                  url: body.url,
                  redirectUrl: body.redirectUrl ?? callback,
                };
            });
      info.append(name, state, detail);
      row.append(info);
      if (server.signedIn || (!remote && server.state === "needs-sign-in"))
        row.append(account);
      row.append(button);
      list.append(row);
      if (pasting?.name !== server.name || server.signedIn) continue;
      const form = document.createElement("form");
      form.className = "row mcp-paste";
      const open = document.createElement("a");
      open.className = "btn";
      open.href = pasting.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = `Open ${server.name} sign-in`;
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = `After approving, your browser shows an unreachable ${pasting.redirectUrl} page. Paste that page's full address here.`;
      const answer = document.createElement("input");
      answer.className = "text-field";
      answer.required = true;
      answer.autocomplete = "off";
      answer.value = pasting.answer ?? "";
      answer.oninput = () => {
        if (pasting) pasting.answer = answer.value;
      };
      answer.setAttribute(
        "aria-label",
        `Address after signing in to ${server.name}`,
      );
      const finish = document.createElement("button");
      finish.className = "btn";
      finish.type = "submit";
      finish.textContent = "Finish sign-in";
      finish.disabled = checking;
      form.onsubmit = (event) => {
        event.preventDefault();
        void act(
          "finish-sign-in",
          "Couldn't finish sign-in.",
          () => (pasting = undefined),
          { url: answer.value },
        );
      };
      form.append(open, hint, answer, finish);
      list.append(form);
    }
  };
  const refresh = async () => {
    clearTimeout(timer);
    if (!active()) return;
    const current = ++revision;
    try {
      const response = await api("/api/settings/mcp-servers/status");
      if (!response.ok) throw new Error("Couldn't load MCP server status.");
      const data = (await response.json()) as { servers: ServerStatus[] };
      if (current !== revision || !active()) return;
      servers = data.servers;
      render();
      if (servers.some((server) => server.checking))
        timer = setTimeout(() => void refresh(), 1000);
    } catch {
      if (current === revision && active())
        say("Couldn't load MCP server status. Reopen MCPs to try again.");
    }
  };
  const observer = new MutationObserver(() => {
    const next = active();
    if (!next) {
      clearTimeout(timer);
      revision++;
    }
    if (next && !visible) void refresh();
    visible = next;
    if (!body.isConnected) observer.disconnect();
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
    visible = active();
    if (visible) void refresh();
  });
  return () => {
    void refresh();
  };
}
