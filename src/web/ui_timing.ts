// Auth/CSRF remain in the normal request boundary. Telemetry is bounded/lossy.
import {
  TIMING_EVENTS,
  TIMING_STAGES,
  TIMING_TARGETS,
  sanitizeStall,
} from "./timing_labels";
import {
  INFO,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { HttpError, Router } from "./router";
export function registerUiTiming(router: Router, logger: RuntimeLogger): void {
  const labels = new Set([
    "main_thread_blocked",
    ...TIMING_STAGES,
    ...TIMING_EVENTS.flatMap((event) =>
      TIMING_TARGETS.map((target) => `${event}:${target}`),
    ),
  ]);
  let last = -Infinity;
  router.post("/api/ui-timing", async (ex) => {
    if (performance.now() - last < 1000)
      return new Response(null, { status: 204 });
    last = performance.now();
    const batch: unknown = await ex.request.json();
    if (!Array.isArray(batch) || batch.length > 100) throw new HttpError(400);
    for (const item of batch) {
      if (
        !item ||
        !labels.has(item.label) ||
        !Number.isFinite(item.ms) ||
        item.ms < 0 ||
        item.ms > 3_600_000 ||
        typeof item.conversation_id !== "string" ||
        !/^(?:[a-zA-Z0-9_-]{1,64}(?:\/[a-zA-Z0-9_-]{1,64})?)?$/.test(
          item.conversation_id,
        ) ||
        !/^(?:[a-f0-9]{32})?$/.test(item.trace_id)
      )
        throw new HttpError(400);
    }
    for (const item of batch) {
      const { label, ms, conversation_id, trace_id } = item;
      let stallFields;
      if (label === "main_thread_blocked") {
        const { markers, scripts, remote_statuses, ...counts } = sanitizeStall(
          item,
          new URL(ex.request.url).origin,
        );
        const scalar = (value: string) =>
          value.replace(/[^A-Za-z0-9_.:@/+,-]/g, "_").slice(0, 200);
        stallFields = {
          ms,
          ...counts,
          remote_statuses: scalar(remote_statuses.join(",")),
          ...Object.fromEntries(
            markers.map((m, i) => [`marker_${i}`, `${m.name}:${m.at}`]),
          ),
          ...Object.fromEntries(
            scripts.flatMap((s, i) => [
              [`script_${i}_url`, scalar(s.sourceURL)],
              [`script_${i}_function`, scalar(s.sourceFunctionName)],
            ]),
          ),
        };
      }
      logEvent(
        logger,
        INFO,
        label === "main_thread_blocked" ? label : "ui_timing",
        {
          conversation_id,
          fields:
            label === "main_thread_blocked"
              ? stallFields
              : {
                  label,
                  ms,
                  conversation_id: conversation_id || null,
                  trace_id: trace_id || null,
                },
        },
      );
    }
    return new Response(null, { status: 204 });
  });
}
