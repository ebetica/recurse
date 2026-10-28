// Settings > Account > Updates (GET/POST /api/settings/update, served by
// src/recurse_update.ts) and the release in the Settings header. "Update now"
// asks the launcher to update and restart once turns finish; the page then
// reloads into the new version (web/connection.ts).
import { api, jpost } from "../api.js";
import { settingsClient, settingsLabel } from "./target.js";

export interface UpdateStatus {
  release: { version: string; commit: string | null };
  skipped: string | null;
  checking: boolean;
  channel: string | null;
  installed: string | null;
  available: string | null;
  checked_at: number | null;
  error: string | null;
  update: { state: string; detail: string | null } | null;
}

const IN_PROGRESS = ["updating", "building", "waiting", "restarting"];

/** Show the release of the Recurse being configured, when it reports one. */
export async function showRelease(
  element: HTMLElement,
  label: string,
): Promise<void> {
  element.hidden = true;
  try {
    const response = await settingsClient().api("/api/version", {
      cache: "no-store",
    });
    const { release } = (await response.json()) as {
      release?: { version?: string; commit?: string | null };
    };
    if (settingsLabel() !== label || !response.ok || !release?.version) return;
    element.textContent = `Recurse ${release.version}${
      release.commit ? ` (${release.commit})` : ""
    }`;
    element.hidden = false;
  } catch {
    if (settingsLabel() === label) element.hidden = true;
  }
}

function channelLabel(channel: string | null): string {
  if (channel === "release") return "newest release";
  if (channel?.startsWith("version ")) return `pinned to ${channel.slice(8)}`;
  if (channel?.startsWith("branch ")) return `tracking ${channel.slice(7)}`;
  return channel ?? "";
}

/** One sentence for the status, and whether it is an error. */
export function updateStatusText(status: UpdateStatus): [string, boolean] {
  const update = status.update;
  if (update?.state === "updating") return ["Updating the checkout…", false];
  if (update?.state === "building")
    return ["Building the new version; this one keeps running…", false];
  if (update?.state === "waiting")
    return [
      `Installed. Recurse restarts into it when ${
        update.detail ? `${update.detail} running turn(s)` : "running turns"
      } finish.`,
      false,
    ];
  if (update?.state === "restarting")
    return ["Restarting; this page reloads when Recurse is back…", false];
  if (update?.state === "failed")
    return [`Update failed: ${update.detail ?? "unknown error"}`, true];
  if (status.skipped) return [status.skipped, false];
  if (status.error)
    return [`Couldn't check for updates: ${status.error}`, true];
  if (!status.installed)
    return [status.checking ? "Checking for updates…" : "", false];
  const channel = channelLabel(status.channel);
  if (status.available && status.available !== status.installed)
    return [
      `Recurse ${status.available} is available (installed: ${status.installed}, ${channel}).`,
      false,
    ];
  const current =
    update?.state === "current" ? "Already up to date" : "Up to date";
  return [`${current}: ${status.installed} (${channel}).`, false];
}

export function buildUpdatesSection(body: HTMLElement): void {
  body.innerHTML = `
    <p class="hint update-status" role="status"></p>
    <div class="row"><button type="button" class="primary update-now" hidden>Update now</button></div>`;
  const text = body.querySelector<HTMLElement>(".update-status")!;
  const button = body.querySelector<HTMLButtonElement>(".update-now")!;
  let polling = false;
  const show = (status: UpdateStatus) => {
    const [message, error] = updateStatusText(status);
    text.textContent = message;
    text.classList.toggle("err", error);
    const state = status.update?.state ?? "";
    button.textContent = state === "failed" ? "Try again" : "Update now";
    button.hidden =
      Boolean(status.skipped) ||
      !(
        state === "failed" ||
        IN_PROGRESS.includes(state) ||
        (status.available && status.available !== status.installed)
      );
    button.disabled = IN_PROGRESS.includes(state);
    if (status.checking || IN_PROGRESS.includes(state)) void follow();
  };
  const read = async () => {
    const response = await api("/api/settings/update");
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as UpdateStatus;
  };
  // Invariant: Keep polling through the restart's outage; the reload into the
  // new version replaces this page, and closing Settings stops it.
  const follow = async () => {
    if (polling) return;
    polling = true;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!body.isConnected) break;
      let status: UpdateStatus;
      try {
        status = await read();
      } catch {
        continue;
      }
      polling = false;
      show(status);
      return;
    }
    polling = false;
  };
  read()
    .then(show)
    .catch(() => (text.textContent = "Couldn't read the update status."));
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await jpost("/api/settings/update", {});
      if (!response.ok) {
        const detail = (
          (await response.json().catch(() => ({}))) as {
            detail?: string;
          }
        ).detail;
        text.textContent = detail || "Couldn't start the update.";
        text.classList.add("err");
        button.disabled = false;
        return;
      }
      show((await response.json()) as UpdateStatus);
    } catch {
      text.textContent = "Network error. Try again.";
      text.classList.add("err");
      button.disabled = false;
    }
  });
}
