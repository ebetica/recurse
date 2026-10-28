// Browser connection-health wiring: one deduplicated /api/version probe serves
// the generation watcher, Retry button, lifecycle wakeups, and outage recovery.
import { homeBackend } from "./backends/backend.js";
import { embeddedFrameHidden } from "./state.js";
import { apiJson, connectionHealth } from "./api.js";
import { refreshTheme } from "./settings/themes.js";
import {
  HealthProbe,
  heartbeatNeedsSuppression,
  runConnectionHeartbeat,
  type ConnectionPhase,
  type ConnectionSnapshot,
} from "./connection/health.js";
import {
  generationDecision,
  generationNavigationUrl,
  matchingGenerationUrl,
} from "./connection/generation-recovery.js";

export const VERSION_PROBE_INTERVAL_MS = 5_000;

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes
    ? `${minutes}m ${rest.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export function startConnectionMonitoring(
  onRecover: () => void,
  generationReady: Promise<void>,
): void {
  const root = document.querySelector<HTMLElement>("#connection-status");
  const label = root?.querySelector<HTMLElement>(".connection-label");
  const announcement = document.querySelector<HTMLElement>(
    "#connection-announcement",
  );
  const retry = root?.querySelector<HTMLButtonElement>("button");
  // Invariant: Optional connection chrome may be missing in mixed generations.
  // Keep tree/thread polling usable; asset bootstrap owns shell recovery.
  if (!root || !label || !announcement || !retry) return;
  const loadedVersion = document.body.dataset.version || "";
  let previousPhase: ConnectionPhase | null = null;
  let indicatorWasVisible = false;
  const updateStatus = document.querySelector<HTMLElement>("#update-status");
  let recoveryPending = false;
  let manualRetry = false;
  let updateTarget: string | null = null;
  let generationEnabled = false;

  const clearUpdateStatus = () => {
    if (!updateStatus) return;
    updateStatus.textContent = "";
    updateStatus.classList.remove("on");
  };

  const showUpdateStatus = (message: string, target: string) => {
    if (!updateStatus) return;
    updateStatus.textContent = "";
    const text = document.createElement("span");
    text.textContent = message;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sm";
    button.textContent = "Retry update";
    button.addEventListener("click", () => attemptUpdate(target, false));
    updateStatus.append(text, button);
    updateStatus.classList.add("on");
  };

  function attemptUpdate(target: string, automatic: boolean): void {
    const ready = new Event("recurse:update-ready", { cancelable: true });
    if (!window.dispatchEvent(ready)) {
      showUpdateStatus(
        "Update ready — send or clear unsent work first.",
        target,
      );
      return;
    }
    if (
      automatic &&
      generationDecision(loadedVersion, target, window.location.search) ===
        "retry"
    ) {
      showUpdateStatus("The app update did not finish.", target);
      return;
    }
    window.location.replace(
      generationNavigationUrl(window.location.href, target, !automatic),
    );
  }

  const checkGeneration = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const { response, data } = await apiJson<{
        version?: string;
        api?: number;
        theme?: string;
      }>(
        "/api/version",
        { cache: "no-store", signal },
        { availability: "core", timeoutMs: 8_000 },
      );
      if (!response.ok) return false;
      homeBackend.apiVersion = data.api ?? null;
      void refreshTheme(data.theme, signal).catch(() => {});
      const current = data.version || "";
      // Invariant: Recovery wiring starts at boot, but stale-shell navigation
      // waits for current tree/thread completion. Failed initial reads leave
      // the usable shell and explicit connection recovery available.
      if (!generationEnabled) return true;
      const decision = generationDecision(
        loadedVersion,
        current,
        window.location.search,
      );
      if (decision === "match") {
        updateTarget = null;
        clearUpdateStatus();
        const clean = matchingGenerationUrl(
          window.location.href,
          loadedVersion,
          current,
        );
        if (clean) window.history.replaceState(window.history.state, "", clean);
      } else if (updateTarget !== current) {
        // Invariant: One automatic cache-busted navigation per mismatch. Unsent
        // work defers it to explicit retry; reload loops cannot starve reads.
        updateTarget = current;
        if (decision === "retry")
          showUpdateStatus("The app update did not finish.", current);
        else attemptUpdate(current, true);
      }
      return true;
    } catch {
      return false;
    }
  };

  const probe = new HealthProbe(connectionHealth, checkGeneration, () =>
    performance.now(),
  );

  const paint = (snapshot: ConnectionSnapshot) => {
    const visible =
      snapshot.phase === "disconnected" ||
      snapshot.phase === "offline" ||
      snapshot.phase === "auth-expired";
    root.classList.toggle("on", visible);
    root.dataset.state = snapshot.phase;
    retry.textContent = manualRetry
      ? "Retrying…"
      : snapshot.phase === "auth-expired"
        ? "Log in"
        : "Retry now";
    retry.disabled = manualRetry;
    retry.setAttribute("aria-busy", String(manualRetry));
    if (snapshot.phase === "disconnected") {
      label.textContent = `Disconnected · ${elapsedLabel(snapshot.elapsedMs)}`;
    } else if (snapshot.phase === "offline") {
      label.textContent = "Offline";
    } else if (snapshot.phase === "auth-expired") {
      label.textContent = "Session expired";
    }
    if (visible) recoveryPending = true;
    if (snapshot.phase === "connected") probe.noteHealthy();

    if (snapshot.phase !== previousPhase) {
      if (snapshot.phase === "disconnected") {
        announcement.textContent =
          "Disconnected from Recurse. Unsent messages are kept. Retry now is available.";
      } else if (snapshot.phase === "offline") {
        announcement.textContent =
          "This browser is offline. Unsent messages are kept.";
      } else if (snapshot.phase === "auth-expired") {
        announcement.textContent =
          "Your Recurse session expired. Unsent work is still shown. Log in when ready.";
      }
      previousPhase = snapshot.phase;
    }
    if (snapshot.phase === "connected" && recoveryPending) {
      recoveryPending = false;
      announcement.textContent = "Connected to Recurse.";
      onRecover();
      window.dispatchEvent(new Event("recurse:connection-restored"));
    }
    indicatorWasVisible = visible;
  };
  connectionHealth.subscribe(paint);

  const requestProbe = (
    force = false,
    suppressStale = false,
  ): Promise<boolean> | null =>
    embeddedFrameHidden() ? null : probe.request({ force, suppressStale });
  void generationReady.then(() => {
    generationEnabled = true;
    requestProbe(true);
  });
  retry.addEventListener("click", () => {
    if (connectionHealth.snapshot().phase === "auth-expired") {
      const login = new Event("recurse:login-requested", { cancelable: true });
      if (window.dispatchEvent(login)) window.location.reload();
      else
        announcement.textContent =
          "Unsent work could not be saved for login. Copy or clear it before continuing.";
      return;
    }
    manualRetry = true;
    announcement.textContent = "Retrying the connection to Recurse.";
    paint(connectionHealth.snapshot());
    const pending = requestProbe(true, false);
    const finished = (ok: boolean) => {
      manualRetry = false;
      const snapshot = connectionHealth.snapshot();
      paint(snapshot);
      if (!ok && snapshot.phase === "disconnected")
        announcement.textContent =
          "Still disconnected from Recurse. Retry is available.";
      else if (!ok && snapshot.phase === "offline")
        announcement.textContent =
          "This browser is still offline. Retry is available.";
    };
    if (pending) void pending.then(finished, () => finished(false));
    else finished(false);
  });

  const wake = () => {
    if (document.hidden) return;
    // Invariant: If timer throttling crossed the threshold while the page was
    // hidden, do not flash a never-before-shown stale label before this probe
    // resolves.
    requestProbe(true, !indicatorWasVisible);
  };
  // Invariant: Capture phase runs before conversation.ts's ordinary wake
  // listeners, so the suppressing probe is in place before a forced tree poll
  // can derive staleness.
  window.addEventListener("recurse:embedded-visibility", () => {
    if (embeddedFrameHidden()) probe.cancel();
    else wake();
  });
  document.addEventListener("visibilitychange", wake, { capture: true });
  window.addEventListener("focus", wake, { capture: true });
  window.addEventListener("pageshow", wake, { capture: true });
  window.addEventListener(
    "offline",
    () => {
      // Invariant: Pre-offline responses cannot validate a new hint.
      // Cancel to prevent dedup from erasing it with stale success.
      // Keep the banner neutral until a fresh authenticated probe fails.
      probe.cancel();
      connectionHealth.setOnline(false);
      requestProbe(true, !indicatorWasVisible);
    },
    { capture: true },
  );
  window.addEventListener(
    "online",
    () => {
      // Invariant: Suppress first while the model still says Offline, then
      // atomically expose reconnecting when it flips online — never an
      // intermediate stale label.
      requestProbe(true, true);
      connectionHealth.setOnline(true);
    },
    { capture: true },
  );
  window.addEventListener("pagehide", () => probe.cancel(), { capture: true });

  // Invariant: Version failures back off; normal authenticated reads recover.
  // Known mismatches stop automatic version traffic until explicit resolution.
  // After long timer gaps, suppress stale labels until a fresh probe settles.
  let lastHeartbeat = performance.now();
  window.setInterval(() => {
    if (embeddedFrameHidden()) return;
    const now = performance.now();
    const slept = now - lastHeartbeat > VERSION_PROBE_INTERVAL_MS * 3;
    lastHeartbeat = now;
    const suppressBeforeTick = heartbeatNeedsSuppression(
      slept,
      indicatorWasVisible,
      connectionHealth.snapshot().phase,
    );
    runConnectionHeartbeat(
      suppressBeforeTick,
      !!updateTarget,
      indicatorWasVisible,
      requestProbe,
      () => connectionHealth.tick(),
    );
  }, VERSION_PROBE_INTERVAL_MS);
  requestProbe(true);
}
