// Inbound connections share Remotes; only public metadata reaches the UI.
import { api } from "../api.js";
import { lastSeen } from "../backends/tree.js";

interface ConnectedHome {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
}

export function buildConnectedHomes(body: HTMLElement): void {
  const heading = document.createElement("h4");
  heading.textContent = "Homes with access to this instance";
  const description = document.createElement("p");
  description.className = "remotes-description";
  description.textContent =
    "These other Recurse instances can view and message agents here. Revoke access to stop an instance from connecting.";
  const list = document.createElement("div");
  body.append(heading, description, list);
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
        const name = document.createElement("strong");
        name.textContent = home.name;
        const status = document.createElement("div");
        status.textContent = `Access allowed · ${lastSeen(home.last_used)}`;
        status.title = `Created ${new Date(home.created * 1000).toLocaleString()}${home.last_used === null ? "" : ` · Last used ${new Date(home.last_used * 1000).toLocaleString()}`}`;
        info.append(name, status);
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "ghost";
        revoke.textContent = "Revoke access";
        revoke.onclick = async () => {
          revoke.disabled = true;
          try {
            const result = await api(
              `/api/backend-keys/${encodeURIComponent(home.id)}`,
              { method: "DELETE" },
            );
            if (!result.ok) throw new Error("Could not revoke connected home");
            await refresh();
          } catch {
            revoke.disabled = false;
            revoke.textContent = "Revoke failed — retry";
          }
        };
        layout.append(info, revoke);
        row.append(layout);
        list.append(row);
      }
    } catch {
      list.textContent =
        "Could not load incoming connections. Reopen Settings to retry.";
    }
  };
  void refresh();
}
