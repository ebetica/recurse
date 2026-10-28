// Bounded in-memory handoff to connected homes. Open polls count as presence;
// claims expire after ten seconds, but the same request id survives re-offer.
// Settle sends within 30s; retain settled entries for five minutes.
import { validBackendKeyName } from "../auth/backend_keys";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

export interface RelayRequest {
  id: string;
  agent: string;
  label: string;
  sender: string;
  title: string | null;
  content: string;
  interrupt: boolean;
}
export interface RelayOutcome {
  state: "pending" | "delivered" | "failed" | "unconfirmed";
  reason: string | null;
  message_id: string | null;
}
export class RelayInbox {
  private readonly homes = new Map<
    string,
    { name: string; labels: string[]; seen: number; open: number }
  >();
  private readonly rows = new Map<
    string,
    {
      request: RelayRequest;
      outcome: RelayOutcome;
      claimant?: string;
      claimed: number;
    }
  >();
  private readonly wakes = new Set<() => void>();

  private pruneHomes(): void {
    for (const [id, home] of this.homes)
      if (!home.open && Date.now() - home.seen > 30_000) this.homes.delete(id);
  }
  route(label: string): void {
    this.pruneHomes();
    const homes = [...this.homes.values()].filter((h) =>
      h.labels.includes(label),
    );
    if (!homes.length)
      throw new HttpError(409, `no connected home routes to ${label}`);
    if (homes.length > 1)
      throw new HttpError(
        409,
        `conflicting homes route to ${label}: ${homes.map((h) => h.name).join(", ")}`,
      );
    if (
      [...this.rows.values()].filter((r) => r.request.label === label).length >=
      100
    )
      throw new HttpError(429, `too many messages to ${label}`);
  }
  async submit(
    request: RelayRequest,
    outcome: RelayOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const row = { request, outcome, claimed: 0 };
    this.rows.set(request.id, row);
    for (const wake of this.wakes) wake();
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (outcome.state === "pending") {
          outcome.state = row.claimed ? "unconfirmed" : "failed";
          outcome.reason = row.claimed
            ? "the home disconnected before confirming; the message may have arrived"
            : `no connected home routes to ${request.label}`;
        }
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.wakes.delete(check);
        resolve();
      };
      const check = () => {
        if (outcome.state !== "pending") finish();
      };
      const timer = setTimeout(finish, 30_000);
      this.wakes.add(check);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
    const timer = setTimeout(() => this.rows.delete(request.id), 5 * 60_000);
    timer.unref();
  }
  register(router: Router): void {
    const caller = (ex: Exchange) => {
      const method = String(ex.state.auth_method);
      if (!["backend-key", "cookie", "tailscale", "local"].includes(method))
        throw new HttpError(403, "connected home required");
      const homeId = ex.request.headers.get("x-recurse-home");
      const homeName = ex.request.headers.get("x-recurse-home-name");
      if (
        method !== "backend-key" &&
        (!homeId ||
          !/^[A-Za-z0-9._-]{1,64}$/.test(homeId) ||
          !validBackendKeyName(homeName))
      )
        throw new HttpError(422, "home identity required");
      return {
        id:
          method === "backend-key"
            ? String(ex.state.backend_key_id)
            : `operator:${homeId}`,
        name:
          method === "backend-key"
            ? String(ex.state.principal).slice("backend-key:".length)
            : homeName!,
      };
    };
    router.get(
      "/api/relay/requests",
      async (ex) => {
        const who = caller(ex);
        const query = new URL(ex.request.url).searchParams;
        const labels = [...new Set((query.get("labels") ?? "").split(","))];
        const wait = Number(query.get("wait") ?? 25);
        if (
          !labels.length ||
          labels.length > 100 ||
          !labels.every(validBackendKeyName) ||
          !Number.isFinite(wait) ||
          wait < 0 ||
          wait > 25
        )
          throw new HttpError(422, "invalid labels or wait");
        this.pruneHomes();
        if (
          [...this.homes.values()].reduce((n, h) => n + h.open, 0) >= 100 ||
          (!this.homes.has(who.id) && this.homes.size >= 100)
        )
          throw new HttpError(429, "too many connected homes");
        const home = this.homes.get(who.id) ?? {
          ...who,
          labels,
          seen: Date.now(),
          open: 0,
        };
        home.labels = labels;
        home.seen = Date.now();
        home.open++;
        this.homes.set(who.id, home);
        const claim = () => {
          const found: RelayRequest[] = [];
          let bytes = 0;
          if (ex.request.signal.aborted) return found;
          for (const row of this.rows.values()) {
            if (
              row.outcome.state !== "pending" ||
              !labels.includes(row.request.label) ||
              (row.claimed && Date.now() - row.claimed < 10_000)
            )
              continue;
            bytes += Buffer.byteLength(JSON.stringify(row.request));
            if (bytes > 240 * 1024 || found.length >= 100) break;
            row.claimant = who.id;
            row.claimed = Date.now();
            found.push(row.request);
          }
          return found;
        };
        try {
          let requests = claim();
          if (!requests.length && wait)
            requests = await new Promise<RelayRequest[]>((resolve) => {
              const done = (rows: RelayRequest[]) => {
                clearTimeout(timer);
                clearInterval(reoffer);
                this.wakes.delete(wake);
                ex.request.signal.removeEventListener("abort", abort);
                resolve(rows);
              };
              const wake = () => {
                const rows = claim();
                if (rows.length) done(rows);
              };
              const abort = () => done([]);
              const timer = setTimeout(() => done([]), wait * 1000);
              const reoffer = setInterval(wake, 1000);
              this.wakes.add(wake);
              ex.request.signal.addEventListener("abort", abort, {
                once: true,
              });
              if (ex.request.signal.aborted) abort();
            });
          return jsonResponse({ requests });
        } finally {
          home.open--;
          home.seen = Date.now();
        }
      },
      { longRunning: true },
    );
    router.post("/api/relay/requests/{id}/result", async (ex) => {
      const who = caller(ex);
      const body = await jsonDictBody(ex);
      if (
        typeof body.state !== "string" ||
        !["delivered", "failed", "unconfirmed"].includes(body.state) ||
        (body.reason !== undefined &&
          (typeof body.reason !== "string" || body.reason.length > 4096)) ||
        (body.message_id !== undefined &&
          (typeof body.message_id !== "string" || body.message_id.length > 128))
      )
        throw new HttpError(422, "invalid relay result");
      const row = this.rows.get(ex.params.id!);
      if (!row || row.claimant !== who.id)
        throw new HttpError(404, "request not found");
      if (row.outcome.state === "pending") {
        row.outcome.state = body.state as RelayOutcome["state"];
        row.outcome.reason = (body.reason as string) ?? null;
        row.outcome.message_id = (body.message_id as string) ?? null;
        for (const wake of this.wakes) wake();
      }
      return jsonResponse({ ok: true });
    });
  }
}
