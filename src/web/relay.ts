// Handlers enqueue/read ephemeral sends; instance tasks deliver/poll.
// Link-derived senders and one retry-stable id preserve provenance and dedup.
// Only named local agents access outcomes; credentials stay private.
// Offline sends fail, never queue; reads/outcomes are bounded and expire.
import type { ConnectedBackends } from "../backends/connected";
import { requireLocalAgent } from "./backends";
import {
  RelayInbox,
  type RelayRequest,
  type RelayOutcome as Outcome,
} from "./relay_inbox";
import {
  deliverRelayed,
  type SupervisorDelivery,
} from "../agents/supervisor/delivery";
import {
  RemoteCallError,
  RemoteResponseTooLarge,
} from "../backends/remote_client";
import { SERVICE_MESSAGE_MAX_CHARS } from "../auth/service";
import { CLIENT_KEY_RE } from "../agents/supervisor/delivery";
import { jsonDictBody } from "./login";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

export function registerRelayRoutes(
  router: Router,
  backends: ConnectedBackends,
  agents: { title(cid: string): string | undefined },
  spawn: (name: string, work: (signal: AbortSignal) => Promise<void>) => void,
  delivery: SupervisorDelivery,
): void {
  const inbox = new RelayInbox();
  inbox.register(router);
  const polls = new Map<string, AbortController>();
  spawn("relay-polls", async (signal) => {
    const stop = () => {
      for (const controller of polls.values()) controller.abort();
    };
    signal.addEventListener("abort", stop, { once: true });
    const unsubscribe = backends.subscribe(() => {
      const labels = backends.connectedLabels();
      for (const [label, controller] of polls)
        if (!labels.includes(label)) {
          controller.abort();
          polls.delete(label);
        }
      for (const label of labels)
        if (!polls.has(label) && !signal.aborted) {
          const controller = new AbortController();
          polls.set(label, controller);
          spawn(`relay-poll-${label}`, async (shutdown) => {
            const abort = () => controller.abort();
            shutdown.addEventListener("abort", abort, { once: true });
            let backoff = 5000;
            try {
              while (!controller.signal.aborted) {
                try {
                  const advertised = [
                    backends.homeLabel,
                    ...backends.connectedLabels().filter((l) => l !== label),
                  ];
                  const response = await backends.poll(
                    label,
                    advertised,
                    controller.signal,
                  );
                  if (response.status !== 200) throw new Error("poll failed");
                  const rows = (response.data as { requests?: unknown } | null)
                    ?.requests;
                  if (!Array.isArray(rows) || rows.length > 100)
                    throw new Error("invalid poll");
                  for (const raw of rows) {
                    const row = raw as RelayRequest;
                    if (
                      !row ||
                      typeof row.id !== "string" ||
                      typeof row.agent !== "string" ||
                      typeof row.sender !== "string" ||
                      !CLIENT_KEY_RE.test(row.id) ||
                      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.agent) ||
                      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.sender) ||
                      !advertised.includes(row.label) ||
                      typeof row.content !== "string" ||
                      Array.from(row.content).length >
                        SERVICE_MESSAGE_MAX_CHARS ||
                      (row.title !== null && typeof row.title !== "string") ||
                      typeof row.interrupt !== "boolean"
                    )
                      throw new Error("invalid relay request");
                    const outcome: Outcome = {
                      state: "pending",
                      reason: null,
                      message_id: null,
                    };
                    try {
                      if (row.label === backends.homeLabel) {
                        const mid = await deliverRelayed(
                          delivery,
                          row.agent,
                          row.content,
                          {
                            sender: `${row.sender}@${label}`,
                            title: row.title,
                          },
                          row.id,
                          row.interrupt,
                        );
                        outcome.state = mid === null ? "failed" : "delivered";
                        outcome.message_id = mid;
                        outcome.reason =
                          mid === null
                            ? `${row.agent} not found on ${row.label}`
                            : null;
                        if (mid !== null) delivery.requestRun(row.agent);
                      } else {
                        await sendRemote(
                          row.label,
                          row.agent,
                          {
                            content: row.content,
                            interrupt: row.interrupt,
                            client_message_id: row.id,
                            relayed_from: {
                              agent: row.sender,
                              title: row.title,
                              backend: label,
                            },
                          },
                          outcome,
                          controller.signal,
                        );
                      }
                    } catch {
                      outcome.state = "unconfirmed";
                      outcome.reason = "delivery could not be confirmed";
                    }
                    await backends.relay(
                      label,
                      `/api/relay/requests/${row.id}/result`,
                      {
                        state: outcome.state,
                        ...(outcome.reason ? { reason: outcome.reason } : {}),
                        ...(outcome.message_id
                          ? { message_id: outcome.message_id }
                          : {}),
                      },
                      5000,
                      controller.signal,
                    );
                  }
                  backoff = 5000;
                } catch {
                  if (!controller.signal.aborted)
                    await new Promise<void>((resolve) => {
                      const done = () => {
                        clearTimeout(timer);
                        controller.signal.removeEventListener("abort", done);
                        resolve();
                      };
                      const timer = setTimeout(done, backoff);
                      controller.signal.addEventListener("abort", done, {
                        once: true,
                      });
                    });
                  backoff = Math.min(60_000, backoff * 2);
                }
              }
            } finally {
              shutdown.removeEventListener("abort", abort);
            }
          });
        }
    });
    try {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    } finally {
      unsubscribe();
      stop();
      signal.removeEventListener("abort", stop);
    }
  });
  const requests = new Map<
    string,
    { owner: string; label: string; outcome: Outcome }
  >();
  const caller = (ex: Exchange): string => requireLocalAgent(ex, agents);
  router.get(
    "/api/relay/transcript/{label}/{cid}",
    async (ex) => {
      caller(ex);
      const { label, cid } = ex.params;
      if (
        !/^[A-Za-z0-9._-]{1,32}$/.test(label!) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cid!)
      )
        throw new HttpError(422, "invalid remote target");
      const query = new URLSearchParams();
      for (const name of ["limit", "before", "after"])
        if (ex.query[name] != null) query.set(name, String(ex.query[name]));
      let response;
      try {
        response = await backends.transcript(label!, cid!, query);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof RemoteResponseTooLarge)
          throw new HttpError(413, error.message);
        throw new HttpError(502, `${label} is unreachable`);
      }
      if (response.status === 401)
        throw new HttpError(
          424,
          `${label}'s key was revoked: reconnect in Settings`,
        );
      if (response.status === 404)
        throw new HttpError(404, `${cid} not found on ${label}`);
      if (response.status !== 200 || !response.data)
        throw new HttpError(
          502,
          `${label} transcript unavailable (${response.status})`,
        );
      return jsonResponse(response.data);
    },
    {
      query: {
        limit: { type: "int", default: 20 },
        before: { type: "int" },
        after: { type: "int" },
      },
    },
  );
  router.post("/api/relay/messages", async (ex) => {
    const owner = caller(ex);
    const body = await jsonDictBody(ex);
    const target =
      typeof body.target === "string" &&
      /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})@([A-Za-z0-9._-]{1,32})$/.exec(
        body.target,
      );
    if (!target) throw new HttpError(422, "invalid remote target");
    const agent = target[1]!;
    const label = target[2]!;
    if (typeof body.content !== "string" || !body.content.trim())
      throw new HttpError(422, "message must be nonempty text");
    if (Array.from(body.content).length > SERVICE_MESSAGE_MAX_CHARS)
      throw new HttpError(413, "message is too large");
    if (
      Object.keys(body).some(
        (key) => !["target", "content", "interrupt"].includes(key),
      ) ||
      (body.interrupt !== undefined && typeof body.interrupt !== "boolean")
    )
      throw new HttpError(
        422,
        "relayed messages are text only with optional interrupt",
      );
    const direct = backends.connectedLabels().includes(label);
    if (direct) backends.relayReady(label);
    else inbox.route(label);
    if (
      requests.size >= 1000 ||
      [...requests.values()].filter((r) => r.label === label).length >= 100
    )
      throw new HttpError(429, `too many messages in flight to ${label}`);
    const id = crypto.randomUUID();
    const outcome: Outcome = {
      state: "pending",
      reason: null,
      message_id: null,
    };
    requests.set(id, { owner, label, outcome });
    const payload = {
      content: body.content,
      interrupt: body.interrupt === true,
      client_message_id: id,
      relayed_from: {
        agent: owner,
        title: agents.title(owner),
        backend: backends.homeLabel,
      },
    };
    spawn(`relay-${id}`, async (signal) => {
      try {
        if (!direct) {
          await inbox.submit(
            {
              id,
              agent,
              label,
              sender: owner,
              title: agents.title(owner) ?? null,
              content: body.content as string,
              interrupt: body.interrupt === true,
            },
            outcome,
            signal,
          );
          return;
        }
        await sendRemote(label, agent, payload, outcome, signal);
      } finally {
        if (outcome.state === "pending") outcome.state = "failed";
        const timer = setTimeout(() => requests.delete(id), 5 * 60_000);
        timer.unref();
      }
    });
    return jsonResponse({ id }, 202);
  });
  async function sendRemote(
    label: string,
    agent: string,
    payload: unknown,
    outcome: Outcome,
    signal: AbortSignal,
  ) {
    const deadline = performance.now() + 30_000;
    let possiblySent = false;
    try {
      try {
        await backends.checkRelay(label, signal);
      } catch (error) {
        outcome.reason =
          error instanceof Error
            ? error.message
            : backends.offlineReason(label);
        return;
      }
      while (!signal.aborted && performance.now() < deadline) {
        try {
          const response = await backends.relay(
            label,
            `/api/conversations/${agent}/deliver`,
            payload,
            Math.min(10_000, deadline - performance.now()),
            signal,
          );
          if (response.status >= 200 && response.status < 300) {
            const mid = (response.data as { message_id?: unknown } | null)
              ?.message_id;
            if (typeof mid === "string") {
              outcome.state = "delivered";
              outcome.message_id = mid;
              return;
            }
            possiblySent = true;
          } else if (
            possiblySent &&
            response.status >= 400 &&
            response.status < 500
          ) {
            outcome.state = "unconfirmed";
            outcome.reason = "connection dropped during delivery";
            return;
          } else if (response.status === 401) {
            outcome.reason = `${label}'s key was revoked: reconnect in Settings`;
            return;
          } else if (response.status === 404) {
            outcome.reason = `${agent} not found on ${label}`;
            return;
          } else if (response.status >= 400 && response.status < 500) {
            const detail = (response.data as { detail?: unknown } | null)
              ?.detail;
            outcome.reason =
              typeof detail === "string"
                ? detail
                : `${label} refused delivery (${response.status})`;
            return;
          } else if (response.status !== 503) {
            possiblySent = true;
          }
        } catch (error) {
          if (error instanceof HttpError) {
            outcome.state = possiblySent ? "unconfirmed" : "failed";
            outcome.reason = error.message;
            return;
          }
          if (error instanceof RemoteCallError && error.unsent) {
            if (!possiblySent) {
              outcome.reason = backends.offlineReason(label);
              return;
            }
          } else possiblySent = true;
        }
        if (!signal.aborted)
          await Bun.sleep(
            Math.min(500, Math.max(0, deadline - performance.now())),
          );
      }
      outcome.state = possiblySent ? "unconfirmed" : "failed";
      outcome.reason = possiblySent
        ? "connection dropped during delivery"
        : `${label} is not ready`;
    } finally {
      if (outcome.state === "pending") outcome.state = "failed";
    }
  }
  router.get("/api/relay/messages/{id}", async (ex) => {
    const owner = caller(ex);
    const id = ex.params.id!;
    if (!CLIENT_KEY_RE.test(id)) throw new HttpError(422, "invalid message id");
    const row = requests.get(id);
    if (!row || row.owner !== owner)
      throw new HttpError(404, "message not found");
    return jsonResponse(row.outcome);
  });
}
