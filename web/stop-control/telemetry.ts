import { jpost } from "../api.js";
import type { StopIdGenerator } from "./id.js";

export type StopDiagnosticEvent =
  | "capture_installed"
  | "capture_seen"
  | "dispatch_started"
  | "request_initiated"
  | "request_id_fallback"
  | "request_result"
  | "request_failure";
export type StopDiagnosticInput =
  | "pointerdown"
  | "touchstart"
  | "click"
  | "keyboard";
export type StopDiagnosticPointer = "mouse" | "touch" | "pen" | "unknown";
export type StopDiagnosticResult =
  | "accepted"
  | "rejected"
  | "finished"
  | "lookup_failed"
  | "exception";

export interface StopDiagnosticFields {
  conversationId?: string | null;
  runId?: string | null;
  stopId?: string | null;
  generation?: string | null;
  input?: StopDiagnosticInput;
  pointerType?: StopDiagnosticPointer;
  result?: StopDiagnosticResult;
  status?: number | null;
  requestIdGenerator?: StopIdGenerator;
}

const ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_EVENTS = 32;
const WINDOW_MS = 60_000;
let windowStarted = 0;
let windowCount = 0;

function boundedId(value: string | null | undefined): string | undefined {
  return value && ID_RE.test(value) ? value : undefined;
}

function takeSlot(now: number): boolean {
  if (now - windowStarted >= WINDOW_MS) {
    windowStarted = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_EVENTS) return false;
  windowCount += 1;
  return true;
}

/** Best-effort, same-origin Stop breadcrumbs. Never await this transport. */
export function reportStopDiagnostic(
  event: StopDiagnosticEvent,
  fields: StopDiagnosticFields = {},
): void {
  const now = Date.now();
  if (!windowStarted) windowStarted = now;
  if (!takeSlot(now)) return;
  const body: Record<string, unknown> = { event };
  const conversationId = boundedId(fields.conversationId);
  const runId = boundedId(fields.runId);
  const stopId = boundedId(fields.stopId);
  const generation = boundedId(fields.generation);
  if (conversationId) body.conversation_id = conversationId;
  if (runId) body.run_id = runId;
  if (stopId) body.stop_id = stopId;
  if (generation) body.generation = generation;
  if (fields.input) body.input = fields.input;
  if (fields.pointerType) body.pointer_type = fields.pointerType;
  if (fields.result) body.result = fields.result;
  if (
    fields.status !== null &&
    fields.status !== undefined &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599
  )
    body.status = fields.status;
  if (fields.requestIdGenerator)
    body.request_id_generator = fields.requestIdGenerator;
  void jpost("/api/stop-diagnostics", body, {
    availability: "optional",
    timeoutMs: 2_000,
  }).catch(() => {
    // Invariant: Telemetry cannot hold up Stop or turn the connection indicator
    // red.
  });
}
