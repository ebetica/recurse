// The Settings footer shows the selected Recurse's release and, locally, update
// status. POST /api/settings/update/check checks now instead of waiting until due;
// POST /api/settings/update installs. Closing the footer cancels its requests
// and polling, not background work.
import { api } from "../api.js";
import { settingsClient, settingsLabel } from "./target.js";

interface UpdateStatus {
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

/** Older servers can serve this bundle before restarting into the update. */
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
function updateStatusText(status: UpdateStatus): [string, boolean] {
  const update = status.update;
  if (update?.state === "updating") return ["Downloading the update…", false];
  if (update?.state === "building")
    return ["Building the new version; this one keeps running…", false];
  if (update?.state === "waiting")
    return ["Update installed. Restart Recurse to apply it now.", false];
  if (update?.state === "restarting")
    return [
      "Restarting; unfinished replies resume when Recurse is back…",
      false,
    ];
  if (update?.state === "failed")
    return [
      "Update failed. Run `recurse update` in a terminal to see why.",
      true,
    ];
  if (status.skipped) return [status.skipped, false];
  if (status.checking) return ["Checking for updates…", false];
  if (status.error)
    return [
      "Couldn't check for updates. Run `recurse update --check` in a terminal to see why.",
      true,
    ];
  if (!status.installed) return ["", false];
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
  text.addEventListener("blur", () => (text.tabIndex = -1));
  const check = document.createElement("button");
  check.type = "button";
  check.className = "btn";
  check.textContent = "Check for updates";
  check.hidden = true;
  const update = document.createElement("button");
  update.type = "button";
  update.className = "btn primary update-now";
  update.textContent = "Update now";
  update.hidden = true;
  footer.replaceChildren(version, text, check, update);
  void showRelease(version, label);
  if (!label) followUpdates(text, check, update, reads.signal);
}

function followUpdates(
  text: HTMLElement,
  check: HTMLButtonElement,
  update: HTMLButtonElement,
  signal: AbortSignal,
): void {
  let polling = false;
  const say = (message: string, error: boolean) => {
    text.textContent = message;
    text.classList.toggle("err", error);
    text.setAttribute("aria-busy", "false");
  };
  // Invariant: Unavailable buttons keep focus until hidden; then the status
  // line takes focus and joins the tab order only until focus leaves it.
  const showButton = (
    button: HTMLButtonElement,
    hidden: boolean,
    disabled: boolean,
  ) => {
    const focused = document.activeElement === button;
    button.hidden = hidden;
    if (focused && hidden) {
      text.tabIndex = 0;
      text.focus();
    }
    button.setAttribute("aria-disabled", String(disabled));
  };
  const show = (status: UpdateStatus) => {
    say(...updateStatusText(status));
    const state = status.update?.state ?? "";
    const updating = IN_PROGRESS.includes(state);
    const offerUpdate =
      state === "failed" ||
      updating ||
      Boolean(status.available && status.available !== status.installed);
    update.textContent = state === "failed" ? "Try again" : "Update now";
    showButton(
      update,
      Boolean(status.skipped) || !offerUpdate,
      updating || status.checking,
    );
    showButton(check, Boolean(status.skipped) || offerUpdate, status.checking);
    if (status.checking || updating) void follow();
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
  const start = async (kind: "check" | "update") => {
    const checking = kind === "check";
    const button = checking ? check : update;
    if (button.hidden || button.getAttribute("aria-disabled") === "true")
      return;
    button.setAttribute("aria-disabled", "true");
    if (checking) say("Checking for updates…", false);
    try {
      const path = checking
        ? "/api/settings/update/check"
        : "/api/settings/update";
      const response = await api(path, { method: "POST", signal });
      if (!response.ok) {
        const { detail } = (await response.json().catch(() => ({}))) as {
          detail?: string;
        };
        if (signal.aborted) return;
        say(
          detail ||
            (checking
              ? "Couldn't start the update check."
              : "Couldn't start the update."),
          true,
        );
      } else {
        const status = (await response.json()) as UpdateStatus;
        if (!signal.aborted) show(status);
        return;
      }
    } catch {
      if (signal.aborted) return;
      say("Network error. Try again.", true);
    }
    button.setAttribute("aria-disabled", "false");
  };
  check.addEventListener("click", () => void start("check"));
  update.addEventListener("click", () => void start("update"));
}
