// Fetch/auth and per-client health: only core failures start outages.
// Authenticated successes recover; aborts/optional failures are neutral.
// Home 401s reload; stale-cookie failures first verify a renewed session.
// Caller cancellation owns streamed bodies even after headers settle health.
import { ConnectionHealth, type RequestOutcome } from "./connection/health.js";
import { interactionTrace } from "./interaction-timing.js";

interface ApiHealthOptions {
  availability?: "core" | "optional";
  timeoutMs?: number;
  renewsSession?: boolean;
}

let sessionGeneration = 0;
const sessionChanges = new Set<Promise<void>>();
let sessionCheck: Promise<boolean> | null = null;

function currentSessionWorks(): Promise<boolean> {
  return (sessionCheck ??= fetch("/api/status?session-check", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
    .then(
      (response) => response.status === 200,
      () => false,
    )
    .finally(() => {
      sessionCheck = null;
    }));
}

const monotonicNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
const browserOnline = (): boolean =>
  typeof navigator === "undefined" || navigator.onLine !== false;

export const connectionHealth = new ConnectionHealth(
  monotonicNow,
  browserOnline(),
);

export function responseOutcome(status: number): RequestOutcome {
  if (status === 401) return "auth-expired";
  if ((status >= 200 && status < 300) || status === 304) return "success";
  if (status >= 500) return "unavailable";
  return "neutral";
}

async function apiRequest<T>(
  health: ConnectionHealth,
  home: boolean,
  path: string,
  opts: RequestInit,
  healthOptions: ApiHealthOptions,
  consume?: (response: Response) => Promise<T>,
): Promise<{ response: Response; data: T | undefined }> {
  const availability = healthOptions.availability || "optional";
  const request = health.begin(availability);
  const generation = sessionGeneration;
  let finishSessionChange: (() => void) | undefined;
  const sessionChange =
    home && healthOptions.renewsSession
      ? new Promise<void>((resolve) => {
          finishSessionChange = resolve;
        })
      : null;
  if (sessionChange) sessionChanges.add(sessionChange);
  const controller = new AbortController();
  const callerSignal = opts.signal;
  let callerAborted = callerSignal?.aborted || false;
  let timedOut = false;
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerAborted) controller.abort();
  // Invariant: Core reads are intentionally shorter than the poller's wedge
  // escape. Optional uploads/provider exchanges keep their existing
  // browser-managed lifetime unless a caller explicitly supplies a timeout.
  const timeoutMs =
    healthOptions.timeoutMs ??
    (availability === "core" || sessionChange ? 10_000 : 0);
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : 0;
  try {
    const headers = new Headers(opts.headers);
    const trace = interactionTrace();
    if (trace && !headers.has("x-recurse-trace"))
      headers.set("x-recurse-trace", trace);
    const response = await fetch(path, {
      ...opts,
      headers,
      signal: callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal,
    });
    // Invariant: Keep timeout/abort ownership through body consumption. Headers
    // cannot settle health or release a probe whose body is stuck.
    if (sessionChange && response.ok) sessionGeneration++;
    const data = consume ? await consume(response) : undefined;
    let outcome =
      !home && response.status === 424
        ? "auth-expired"
        : !home && response.status === 401
          ? "neutral"
          : responseOutcome(response.status);
    if (home && outcome === "auth-expired" && !sessionChange) {
      await Promise.all(sessionChanges);
      // Invariant: Old-cookie reads may finish after a credential write. Only
      // a fresh authenticated response can suppress their expired-session UI.
      if (generation !== sessionGeneration && (await currentSessionWorks()))
        outcome = "neutral";
    }
    const authWasExpired = health.snapshot().phase === "auth-expired";
    health.settle(
      !home && response.status === 502
        ? { ...request, availability: "core" }
        : request,
      outcome,
    );
    if (
      home &&
      outcome === "auth-expired" &&
      !authWasExpired &&
      health.snapshot().phase === "auth-expired"
    ) {
      // Invariant: 401 is the server's expired-cookie response. Its 403
      // responses are authenticated request/CSRF errors, classified as neutral
      // above rather than either session expiry or a disconnected server.
      if (typeof window !== "undefined") {
        const expired = new Event("recurse:auth-expired", { cancelable: true });
        if (window.dispatchEvent(expired)) window.location.reload();
      } else if (typeof location !== "undefined") {
        location.reload();
      }
    }
    return { response, data };
  } catch (error) {
    if (callerAborted || (!timedOut && controller.signal.aborted))
      health.settle(request, "cancelled");
    else health.settle(request, "unavailable");
    throw error;
  } finally {
    if (sessionChange) {
      sessionChanges.delete(sessionChange);
      finishSessionChange?.();
    }
    if (timeout) clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function createApiClient(health: ConnectionHealth, home: boolean) {
  const api = async (
    path: string,
    opts: RequestInit = {},
    healthOptions: ApiHealthOptions = {},
  ): Promise<Response> =>
    (await apiRequest(health, home, path, opts, healthOptions)).response;
  const apiJson = async <T>(
    path: string,
    opts: RequestInit = {},
    healthOptions: ApiHealthOptions = {},
  ): Promise<{ response: Response; data: T }> => {
    const result = await apiRequest(
      health,
      home,
      path,
      opts,
      healthOptions,
      (response) => response.json() as Promise<T>,
    );
    return { response: result.response, data: result.data as T };
  };
  const jpost = (
    path: string,
    body?: unknown,
    healthOptions?: ApiHealthOptions,
  ): Promise<Response> =>
    api(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      },
      healthOptions,
    );
  return { api, apiJson, jpost };
}

export const { api, apiJson, jpost } = createApiClient(connectionHealth, true);
