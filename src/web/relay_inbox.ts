// Bounded handoff to homes, told apart by backend key (keyed labels), not
// name: polls and callbacks are presence; claims expire after 10s; sends
// settle within 90s, and with a queue idle pollers sleep and unclaimed sends
// queue. A plain label shared by homes is refused, listing each one's address.
import { validBackendKeyName } from "../auth/backend_keys";
import type { HomeCallbacks, KeyInfo } from "../backends/home_callbacks";
import { keyedLabel } from "../backends/label";
import type { RelayQueue } from "./relay_queue";
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
/** Seconds a home waits before polling a sleeping instance again. */
export const SLEEP_SECONDS = 3600;
export interface HomeRoute {
  /** Home ids (backend key ids, or `operator:` ids) allowed to claim it. */
  ids: string[];
  /** Key ids registered for callback notices. */
  pushed: string[];
  name: string;
  /** The label the home polls with. */
  label: string;
  /** The address agents here use for it; queued requests carry it. */
  address: string;
  /** Polling or registered now, rather than known only from the queue. */
  live: boolean;
  url: string | null;
}
const ago = (seconds: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  return minutes < 60
    ? `${minutes} min ago`
    : minutes < 2880
      ? `${Math.floor(minutes / 60)} hr ago`
      : `${Math.floor(minutes / 1440)} days ago`;
};
/** What tells same-named homes apart, for the ambiguity error. */
function describe(agent: string, route: HomeRoute, key?: KeyInfo): string {
  const facts = [`home ${route.name}`];
  if (key) {
    facts.push(
      `connected ${new Date(key.created * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      key.last_used === null ? "never used" : `last used ${ago(key.last_used)}`,
    );
    if (route.url) facts.push(`at ${route.url}`);
    else if (key.last_client) facts.push(`from ${key.last_client}`);
  } else
    facts.push(
      "connected without a key, so it has no address of its own; set a password here and reconnect it",
    );
  return `${agent}@${route.address} (${facts.join(", ")})`;
}
export interface RelayOutcome {
  state: "pending" | "delivered" | "failed" | "unconfirmed" | "queued";
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
      queued?: boolean;
      homes: string[];
      address: string;
    }
  >();
  private readonly wakes = new Set<() => void>();
  constructor(
    private readonly callbacks?: HomeCallbacks,
    private readonly queue?: RelayQueue,
    private readonly idle: () => boolean = () => false,
    private readonly checkUrl?: string,
  ) {}
  /** Queue mode, nothing in flight and the instance idle: pollers may sleep. */
  private sleepy(): boolean {
    return (
      !!this.queue &&
      this.idle() &&
      ![...this.rows.values()].some(
        (r) => !r.queued && r.outcome.state === "pending",
      )
    );
  }

  private pruneHomes(): void {
    for (const [id, home] of this.homes)
      if (!home.open && Date.now() - home.seen > 30_000) this.homes.delete(id);
  }
  /**
   * The home `target` names: a keyed label names one home's key; a plain
   * label must belong to exactly one live or queued home.
   */
  async route(agent: string, target: string): Promise<HomeRoute> {
    const keys = await this.callbacks?.liveKeys();
    const pushed = (await this.callbacks?.homes()) ?? [];
    this.pruneHomes();
    const keyed = (id: string) => !id.startsWith("operator:");
    const live = [
      ...pushed.map((h) => ({ ...h, pushed: true })),
      ...[...this.homes]
        .filter(
          ([id]) =>
            !pushed.some((p) => p.id === id) &&
            (!keyed(id) || !keys || keys.has(id)),
        )
        .map(([id, h]) => ({ ...h, id, url: null, pushed: false })),
    ];
    const found = new Map<string, HomeRoute>();
    for (const exact of [true, false]) {
      for (const home of live) {
        const labels = home.labels.filter((l) =>
          exact
            ? keyed(home.id) && keyedLabel(l, home.id) === target
            : l === target,
        );
        if (labels.length > 1)
          throw new HttpError(
            409,
            `${target} matches ${home.name}'s labels ${labels.join(" and ")}; rename one of them on that home`,
          );
        const label = labels[0];
        if (label === undefined) continue;
        const group = home.url ?? home.id;
        const route = found.get(group) ?? {
          ids: [],
          pushed: [],
          name: home.name,
          label,
          address: keyed(home.id) ? keyedLabel(label, home.id) : label,
          live: true,
          url: home.url,
        };
        route.ids.push(home.id);
        if (home.pushed) route.pushed.push(home.id);
        found.set(group, route);
      }
      for (const queued of (await this.queue?.routes(target, exact)) ?? [])
        if (
          ![...found.values()].some((r) =>
            queued.key
              ? r.ids.includes(queued.key)
              : r.label === queued.label && r.ids.some((id) => !keyed(id)),
          )
        )
          found.set(`queue:${queued.address}`, {
            ids: queued.key ? [queued.key] : [],
            pushed: [],
            name: queued.name,
            label: queued.label,
            address: queued.address,
            live: false,
            url: null,
          });
      if (found.size) break;
    }
    const routes = [...found.values()];
    if (!routes.length)
      throw new HttpError(409, `no connected home routes to ${target}`);
    if (routes.length > 1)
      throw new HttpError(
        409,
        `${target} names ${routes.length} homes; send to one of: ${routes
          .map((r) =>
            describe(
              agent,
              r,
              r.ids.map((id) => keys?.get(id)).find((k) => k),
            ),
          )
          .join("; ")}`,
      );
    const route = routes[0]!;
    const twins = [...(keys?.values() ?? [])].filter(
      (k) =>
        !route.ids.includes(k.id) &&
        route.ids.some(
          (id) => keyed(id) && id.slice(0, 6) === k.id.slice(0, 6),
        ),
    );
    if (twins.length)
      throw new HttpError(
        409,
        `${target} could reach several homes whose connection keys start with ${twins[0]!.id.slice(0, 6)}: ${[
          ...route.ids.flatMap((id) => keys?.get(id) ?? []),
          ...twins,
        ]
          .map((k) => describe(agent, { ...route, name: k.name, url: null }, k))
          .join(
            "; ",
          )}; revoke all but one under Settings → Remotes → Homes with access to this instance and reconnect the others`,
      );
    if (
      [...this.rows.values()].filter((r) => r.address === route.address)
        .length >= 100
    )
      throw new HttpError(429, `too many messages to ${target}`);
    return route;
  }
  async submit(
    request: RelayRequest,
    route: HomeRoute,
    outcome: RelayOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    if (!route.live) return this.enqueue(request, route, outcome);
    const row = {
      request: { ...request, label: route.label },
      outcome,
      claimed: 0,
      homes: route.ids,
      address: route.address,
    };
    this.rows.set(request.id, row);
    for (const wake of this.wakes) wake();
    for (const id of route.pushed)
      if (!this.homes.get(id)?.open)
        void this.callbacks!.notify(
          id,
          () =>
            outcome.state === "pending" && Date.now() - row.claimed >= 10_000,
        ).catch(() => {});
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (outcome.state === "pending" && row.claimed) {
          outcome.state = "unconfirmed";
          outcome.reason =
            "the home disconnected before confirming; the message may have arrived";
        }
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.wakes.delete(check);
        resolve();
      };
      const check = () => {
        if (outcome.state !== "pending") finish();
      };
      const timer = setTimeout(finish, 90_000);
      this.wakes.add(check);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
    if (outcome.state === "pending") {
      this.rows.delete(request.id);
      return this.enqueue(request, route, outcome);
    }
    const timer = setTimeout(() => this.rows.delete(request.id), 5 * 60_000);
    timer.unref();
  }
  private async enqueue(
    request: RelayRequest,
    route: HomeRoute,
    outcome: RelayOutcome,
  ) {
    if (
      !(await this.queue?.routes(route.address, route.address !== route.label))
        ?.length
    ) {
      outcome.state = "failed";
      outcome.reason = `no connected home routes to ${request.label}`;
      return;
    }
    const dropped = await this.queue!.add({ ...request, label: route.address });
    for (const id of dropped) this.rows.delete(id);
    outcome.state = "queued";
    outcome.reason = `queued for ${route.name}, which gets it when it next polls${dropped.length ? `; dropped the ${dropped.length} oldest queued message(s) to stay within the queue limit` : ""}`;
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
        let slept = false;
        const claim = () => {
          const found: RelayRequest[] = [];
          let bytes = 0;
          if (ex.request.signal.aborted) return found;
          for (const row of this.rows.values()) {
            if (
              row.outcome.state !== "pending" ||
              !labels.includes(row.request.label) ||
              !row.homes.includes(who.id) ||
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
          if (this.queue) {
            const key = who.id.startsWith("operator:") ? null : who.id;
            await this.queue.learn(labels, who.name, key);
            for (const { request, address } of await this.queue.for(
              labels,
              key,
            ))
              if (!this.rows.has(request.id))
                this.rows.set(request.id, {
                  request,
                  outcome: { state: "pending", reason: null, message_id: null },
                  claimed: 0,
                  queued: true,
                  homes: [who.id],
                  address,
                });
          }
          let requests = claim();
          slept = !requests.length && this.sleepy();
          if (slept)
            return jsonResponse({
              requests,
              sleep_seconds: SLEEP_SECONDS,
              ...(this.checkUrl ? { check_url: this.checkUrl } : {}),
            });
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
          home.seen = slept ? 0 : Date.now();
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
      if (row.queued) {
        this.rows.delete(row.request.id);
        await this.queue!.remove(row.request.id);
      }
      return jsonResponse({ ok: true });
    });
  }
}
