// Inbound home rows open access details; only public metadata reaches the UI.
// The block stays hidden while no home has access. A new read cancels the
// one in flight; the list is aria-busy until it updates its rows in place.
import { api } from "../api.js";
import { lastSeen } from "../backends/tree.js";
import { arrangeRows, holdsFocus, settingsDetail } from "./layout.js";

interface ConnectedHome {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
  last_client: string | null;
  url: string | null;
  label: string;
}

export function buildConnectedHomes(body: HTMLElement): void {
  const heading = document.createElement("h4");
  heading.textContent = "Homes with access to this instance";
  const description = document.createElement("p");
  description.className = "remotes-description";
  description.textContent = "These homes can view and message agents here.";
  const list = document.createElement("div");
  list.className = "group";
  body.append(heading, list, description);
  body.hidden = true;
  let current: AbortController | undefined;
  type Entry = {
    row: HTMLElement;
    detail: ReturnType<typeof settingsDetail>;
    show(home: ConnectedHome): void;
  };
  const entries = new Map<string, Entry>();
  let lostFocus = false;
  const drop = (id: string) => {
    const entry = entries.get(id)!;
    lostFocus ||= holdsFocus(entry.row);
    entry.detail.close();
    entry.row.remove();
    entries.delete(id);
  };
  const refocus = () => {
    if (!lostFocus) return;
    lostFocus = false;
    const rows = body
      .closest(".settings-cat")
      ?.querySelectorAll<HTMLElement>(".settings-row");
    Array.from(rows ?? [])
      .find((row) => row.getClientRects().length)
      ?.focus();
  };
  const refresh = async () => {
    current?.abort();
    const read = (current = new AbortController());
    list.setAttribute("aria-busy", "true");
    if (!entries.size) list.textContent = "Loading connections…";
    try {
      const response = await api("/api/backend-keys", { signal: read.signal });
      if (!response.ok) throw new Error("Could not load connected homes");
      const homes = (await response.json()) as ConnectedHome[];
      if (read.signal.aborted) return;
      const ids = new Set(homes.map((home) => home.id));
      for (const id of Array.from(entries.keys())) if (!ids.has(id)) drop(id);
      for (const node of Array.from(list.childNodes))
        if (!entries.has((node as HTMLElement).dataset?.id ?? ""))
          node.remove();
      body.hidden = !homes.length;
      arrangeRows(
        list,
        homes.map((home) => {
          const entry = entries.get(home.id) ?? build(home);
          entry.show(home);
          return entry.row;
        }),
      );
      list.setAttribute("aria-busy", "false");
      refocus();
    } catch {
      if (read.signal.aborted) return;
      for (const id of Array.from(entries.keys())) drop(id);
      body.hidden = false;
      list.textContent =
        "Could not load incoming connections. Reopen Settings to retry.";
      list.setAttribute("aria-busy", "false");
      refocus();
    }
  };
  const build = (first: ConnectedHome): Entry => {
    let home = first;
    const row = document.createElement("div");
    row.dataset.id = home.id;
    row.className = "remote-entry";
    const layout = document.createElement("div");
    layout.className = "row";
    const info = document.createElement("div");
    info.className = "remote-info";
    const status = document.createElement("div");
    const show = (next: ConnectedHome) => {
      home = next;
      status.textContent = [
        `Created ${new Date(home.created * 1000).toLocaleDateString()}`,
        lastSeen(home.last_used),
        home.url ?? (home.last_client && `from ${home.last_client}`),
        `agents here reach it as @${home.label}`,
      ]
        .filter((part) => part)
        .join(" · ");
      status.title = `Created ${new Date(home.created * 1000).toLocaleString()}${home.last_used === null ? "" : ` · Last used ${new Date(home.last_used * 1000).toLocaleString()}`}`;
      detail.refresh();
    };
    info.append(status);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "settings-row danger";
    revoke.textContent = "Revoke access";
    revoke.onclick = async () => {
      revoke.disabled = true;
      try {
        const result = await api(
          `/api/backend-keys/${encodeURIComponent(home.id)}`,
          { method: "DELETE" },
        );
        if (!result.ok) throw new Error("Could not revoke connected home");
        detail.close();
        await refresh();
      } catch {
        revoke.disabled = false;
        revoke.textContent = "Revoke failed — retry";
      }
    };
    const buttons = document.createElement("span");
    buttons.className = "remote-buttons";
    buttons.append(revoke);
    layout.append(info, buttons);
    row.append(layout);
    const detail = settingsDetail(
      row,
      home.name,
      () => `@${home.label} · ${lastSeen(home.last_used)}`,
    );
    const entry = { row, detail, show };
    entries.set(home.id, entry);
    return entry;
  };
  void refresh();
}
