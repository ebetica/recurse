// The Settings footer: the chosen Recurse's release and, for this Recurse,
// its update status and Update now (GET/POST /api/settings/update, see
// src/recurse_update.ts); updating reloads the page (web/connection.ts).
// Showing or hiding the footer cancels the previous one's reads and polling.
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
async function showRelease(element: HTMLElement, label: string): Promise<void> {
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
  if (update?.state === "updating") return ["Downloading the update…", false];
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
    return [
      "Update failed. Run `recurse update` in a terminal to see why.",
      true,
    ];
  if (status.skipped) return [status.skipped, false];
  if (status.error)
    return [
      "Couldn't check for updates. Run `recurse update --check` in a terminal to see why.",
      true,
    ];
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

let active: AbortController | undefined;

/** Empty the footer and stop its reads, as when Settings closes. */
export function hideVersion(footer: HTMLElement): void {
  active?.abort();
  footer.replaceChildren();
}

/** Fill the footer for the Recurse chosen in Settings. */
export function showVersion(footer: HTMLElement, label: string): void {
  hideVersion(footer);
  const reads = (active = new AbortController());
  const version = document.createElement("span");
  version.className = "settings-version";
  version.title = "Recurse release and commit";
  const text = document.createElement("p");
  text.className = "update-status";
  text.setAttribute("role", "status");
  text.setAttribute("aria-busy", String(!label));
  text.tabIndex = -1;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn primary update-now";
  button.textContent = "Update now";
  button.hidden = true;
  footer.replaceChildren(version, text, button);
  void showRelease(version, label);
  if (!label) followUpdates(text, button, reads.signal);
}

function followUpdates(
  text: HTMLElement,
  button: HTMLButtonElement,
  signal: AbortSignal,
): void {
  let polling = false;
  let starting = false;
  const say = (message: string, error: boolean) => {
    text.textContent = message;
    text.classList.toggle("err", error);
    text.setAttribute("aria-busy", "false");
  };
  // Invariant: The button stays focusable while unavailable (aria-disabled),
  // and focus moves to the status line if the button disappears.
  const enable = (on: boolean) =>
    button.setAttribute("aria-disabled", String(!on));
  const show = (status: UpdateStatus) => {
    say(...updateStatusText(status));
    const state = status.update?.state ?? "";
    button.textContent = state === "failed" ? "Try again" : "Update now";
    const focused = document.activeElement === button;
    button.hidden =
      Boolean(status.skipped) ||
      !(
        state === "failed" ||
        IN_PROGRESS.includes(state) ||
        (status.available && status.available !== status.installed)
      );
    if (focused && button.hidden) text.focus();
    enable(!IN_PROGRESS.includes(state));
    if (status.checking || IN_PROGRESS.includes(state)) void follow();
  };
  const read = async () => {
    const response = await api("/api/settings/update", { signal });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as UpdateStatus;
  };
  // Invariant: Keep polling through the restart's outage; the reload into the
  // new version replaces this page, and closing Settings stops it.
  const follow = async () => {
    if (polling) return;
    polling = true;
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (signal.aborted) break;
      let status: UpdateStatus;
      try {
        status = await read();
      } catch {
        continue;
      }
      if (signal.aborted) break;
      polling = false;
      show(status);
      return;
    }
    polling = false;
  };
  read()
    .then((status) => !signal.aborted && show(status))
    .catch(
      () => signal.aborted || say("Couldn't read the update status.", true),
    );
  button.addEventListener("click", async () => {
    if (starting || button.getAttribute("aria-disabled") === "true") return;
    starting = true;
    enable(false);
    try {
      const response = await jpost("/api/settings/update", {});
      if (!response.ok) {
        const detail = (
          (await response.json().catch(() => ({}))) as {
            detail?: string;
          }
        ).detail;
        say(detail || "Couldn't start the update.", true);
        enable(true);
        return;
      }
      show((await response.json()) as UpdateStatus);
    } catch {
      say("Network error. Try again.", true);
      enable(true);
    } finally {
      starting = false;
    }
  });
}
