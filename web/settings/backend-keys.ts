// Inbound home rows open access details; only public metadata reaches the UI.
import { api } from "../api.js";
import { lastSeen } from "../backends/tree.js";
import { settingsDetail } from "./layout.js";

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
  const refresh = async () => {
    list.textContent = "Loading connections…";
    try {
      const response = await api("/api/backend-keys");
      if (!response.ok) throw new Error("Could not load connected homes");
      const homes = (await response.json()) as ConnectedHome[];
      list.textContent = homes.length ? "" : "No homes have access.";
      for (const home of homes) {
        const row = document.createElement("div");
        row.className = "remote-entry";
        const layout = document.createElement("div");
        layout.className = "row";
        const info = document.createElement("div");
        info.className = "remote-info";
        const status = document.createElement("div");
        status.textContent = [
          `Created ${new Date(home.created * 1000).toLocaleDateString()}`,
          lastSeen(home.last_used),
          home.url ?? (home.last_client && `from ${home.last_client}`),
          `agents here reach it as @${home.label}`,
        ]
          .filter((part) => part)
          .join(" · ");
        status.title = `Created ${new Date(home.created * 1000).toLocaleString()}${home.last_used === null ? "" : ` · Last used ${new Date(home.last_used * 1000).toLocaleString()}`}`;
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
        list.append(row);
        const detail = settingsDetail(
          row,
          home.name,
          () => `@${home.label} · ${lastSeen(home.last_used)}`,
        );
      }
    } catch {
      list.textContent =
        "Could not load incoming connections. Reopen Settings to retry.";
    }
  };
  void refresh();
}
