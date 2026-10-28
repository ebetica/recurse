// Operator failure sentences strip JSON/absolute paths, cap at 200 code points.
// Caller provider/model wins over scraped IDs; bare unconfigured words never
// count as IDs. Known faults map to actionable sentences; raw text stays in
// details/logs. No exception prefixes or unavailable Pi-CLI advice.

/** Cap for a displayed failure reason: the row names the failure. */
const SENTENCE_MAX = 200;

/** Python's Unicode `\w`, for use inside a character class. */
const W = String.raw`\p{L}\p{N}_`;
/** Python's Unicode `\s` (str.isspace), for use inside a character class. */
const S = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const re = (source: string, flags = "u") =>
  new RegExp(source.replaceAll(String.raw`\s`, `[${S}]`), flags);

const ERROR_CLASS_PREFIX_RE = re(String.raw`^\s*[${W}.]*Error(\([^)]*\))?:\s*`);
// Path stripping preserves Pi-CLI advice and sentence punctuation.
const ABSOLUTE_PATH_RE = re(
  String.raw`(?<![${W}])/[${W}.~@\-]+(?:[/.][${W}.~@\-]+)+(?:[^${S}"']*[${W}~@/\-])?`,
  "gu",
);
const SEE_DOCS_RE = re(String.raw`\s*See:\s*[^${S}].*$`, "su");
// Provider API status takes precedence and survives raw JSON bodies.
const API_ERROR_RE = re(
  String.raw`([${W}.\-]+)\s+API error\s*\(([0-9]{3})\)`,
  "iu",
);
const HTTP_STATUS_RE = re(String.raw`^\s*([0-9]{3})(?:\s|$)`);
// Strip JSON before sentence splitting so embedded punctuation cannot split it.
const JSON_BODY_RE = /\{[^{}]*\}/gu;
// pi-ai text for OpenAI content_filter and Anthropic sensitive stops.
const CONTENT_FILTER_RE =
  /finish_reason: content_filter|stopped with: sensitive/iu;

const PROVIDER_NAME = String.raw`([${W}.\-]+)`;
const AUTH_PROVIDER_RES = [
  String.raw`no api key found for\s+['"]?${PROVIDER_NAME}`,
  String.raw`provider\s+['"]?${PROVIDER_NAME}['"]?\s+(is\s+)?not configured`,
  String.raw`(?:for|from|on)\s+provider\s+['"]?${PROVIDER_NAME}`,
].map((source) => re(source, "iu"));
const EXPLICIT_PROVIDER_RE = AUTH_PROVIDER_RES[2]!;
const MODEL_NAME_RES = [
  String.raw`['"]model['"]\s*:\s*['"]([^'"${S},;]+)['"]`,
  String.raw`[Tt]he model\s+['"]([^'"]+)['"]`,
  String.raw`model\s+['"]?([${W}.:/\-]+)['"]?`,
  String.raw`unknown model\s*[:]?\s*['"]?([${W}.:/\-]+)['"]?`,
].map((source) => re(source, "iu"));
const PROVIDER_PREFIX_RE = re(String.raw`^[${W}.\-]+$`);
const SENTENCE_BREAK_RE = re(String.raw`(?<=[.!?])\s+`);
const WHITESPACE_RE = re(String.raw`\s+`, "gu");
const EDGE_WHITESPACE_RE = re(String.raw`^\s+|\s+$`, "gu");
const WEBSOCKET_RE = re(String.raw`websocket(?:\s+error|\s+closed)?`, "iu");
const CONNECTION_RES = [
  String.raw`(?:connection|socket)\s+(?:closed|dropped|lost|reset|refused)`,
  String.raw`(?:econn(?:reset|refused)|network|transport)`,
].map((source) => re(source, "iu"));
const TIMEOUT_RE = re(String.raw`(?:timed?\s+out|timeout)`, "iu");

const AUTH_MARKERS = [
  "no api key",
  "api key not configured",
  "api key is missing",
  "missing api key",
  "provider not configured",
  "not logged in",
  "no credentials",
  "missing credentials",
  "not authenticated",
  "authentication failed",
  "unauthorized",
  "invalid api key",
  "api key rejected",
  "api key was rejected",
  "expired api key",
];
const REJECTED_KEY_MARKERS = ["invalid", "rejected", "expired"];
const MODEL_MARKERS = [
  "unknown model",
  "model not found",
  "no such model",
  "unsupported model",
  "model not available",
  "model is not available",
  "model not supported",
  "model is not supported",
];

export type KnownModels = ReadonlySet<string>;

export interface FailureContext {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly knownModels?: KnownModels | null;
}

function hasAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function rstrip(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

/** Python's `str(raw or "")` for the string-ish values callers pass. */
function rawText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return raw ? String(raw) : "";
}

/** Python's `str.strip()`: trims Python's whitespace set, not JavaScript's. */
function strip(text: string): string {
  return text.replace(EDGE_WHITESPACE_RE, "");
}

function stripErrorClass(raw: unknown): string {
  return strip(rawText(raw).replace(ERROR_CLASS_PREFIX_RE, ""));
}

/** The provider named by an auth failure, if any (verbatim, no paths). */
function authProvider(text: string): string | null {
  for (const pattern of AUTH_PROVIDER_RES) {
    const match = pattern.exec(text);
    if (match) return rstrip(match[1]!, ".");
  }
  return null;
}

/** The (provider, status) a `<Name> API error (<status>)` prefix names. */
function apiErrorRefs(text: string): [string | null, number | null] {
  const match = API_ERROR_RE.exec(text);
  if (match === null) return [null, null];
  return [rstrip(match[1]!, "."), Number(match[2])];
}

// A scraped model name is only an id when shaped like one: a `provider/model`
// namespace, an id separator (`-_.:`), or a caller-supplied known id. A bare
// English word never counts.
function looksLikeModelId(
  name: string,
  known: KnownModels | null | undefined,
): boolean {
  if (!name) return false;
  if (name.includes("/")) return true;
  if (known?.has(name)) return true;
  return [..."-_.:"].some((sep) => name.includes(sep));
}

/** The (model, provider) a model failure names, verbatim when present. */
function modelRefs(
  text: string,
  known: KnownModels | null | undefined,
): [string | null, string | null] {
  let model: string | null = null;
  for (const pattern of MODEL_NAME_RES) {
    const match = pattern.exec(text);
    if (match) {
      const candidate = rstrip(match[1]!, ".,;:");
      if (looksLikeModelId(candidate, known)) model = candidate;
      break;
    }
  }
  const match = EXPLICIT_PROVIDER_RE.exec(text);
  return [model, match ? rstrip(match[1]!, ".") : null];
}

/** The configured provider namespaced in a `provider/model` id, if any. */
function providerFromModel(model: string | null | undefined): string | null {
  if (!model || !model.includes("/")) return null;
  const prefix = rstrip(strip(model.split("/", 1)[0]!), ".,;:");
  return prefix && PROVIDER_PREFIX_RE.test(prefix) ? prefix : null;
}

// The provider a failure sentence names: the caller's provider, then the
// caller-supplied or scraped model id's namespace, then a provider the text
// names explicitly; the `<Name> API error` wire client only as a last resort.
function failureProvider(
  text: string,
  apiProvider: string | null,
  context: FailureContext,
): string | null {
  if (context.provider) return context.provider;
  const [scraped, explicit] = modelRefs(text, context.knownModels);
  return (
    providerFromModel(context.model) ||
    providerFromModel(scraped) ||
    authProvider(text) ||
    explicit ||
    apiProvider
  );
}

/** The fixed sentence for a provider HTTP status, if one is mapped. */
function apiStatusSentence(
  text: string,
  apiProvider: string | null,
  status: number | null,
  context: FailureContext,
): string | null {
  const provider = () => failureProvider(text, apiProvider, context);
  if (status === 401 || status === 403) {
    const name = provider();
    return name
      ? `Provider ${name} rejected the API key. Check it in Settings.`
      : "The configured API key was rejected. Check it in Settings.";
  }
  if (status === 413) {
    const name = provider();
    const subject = name ? `Provider ${name}` : "The provider";
    return `${subject} rejected a request that was too large. Compact the conversation or reduce its content.`;
  }
  if (status === 429) {
    const name = provider();
    return name
      ? `Provider ${name} is rate limiting requests. Try again shortly.`
      : "The provider is rate limiting requests. Try again shortly.";
  }
  if (status !== null && status >= 500 && status <= 599) {
    const name = provider();
    return name
      ? `Provider ${name} returned a server error. Try again.`
      : "The provider returned a server error. Try again.";
  }
  return null;
}

/** The model-unavailable sentence, when the failure names one. */
function modelSentence(
  text: string,
  flat: string,
  apiProvider: string | null,
  apiStatus: number | null,
  context: FailureContext,
): string | null {
  const lowered = text.toLowerCase();
  if (
    !(
      apiStatus === 404 ||
      hasAny(lowered, MODEL_MARKERS) ||
      hasAny(flat, MODEL_MARKERS) ||
      (flat.includes("model") &&
        (flat.includes("not found") || flat.includes("not available")))
    )
  ) {
    return null;
  }
  const model =
    context.model || modelRefs(text, context.knownModels)[0] || null;
  const provider = failureProvider(text, apiProvider, { ...context, model });
  if (model && provider) {
    // Invariant: Only a caller-supplied short id gains its namespace: scraped
    // text already states the model verbatim (`glm-5` stays `glm-5` even beside
    // `from provider z-ai`).
    const shown =
      model.includes("/") || !context.model ? model : `${provider}/${model}`;
    return `Model ${shown} is not available from provider ${provider}. Choose another model.`;
  }
  if (model) return `Model ${model} is not available. Choose another model.`;
  if (provider) {
    return `The selected model is not available from provider ${provider}. Choose another model.`;
  }
  return "The requested model is not available. Choose another model.";
}

function flatten(lowered: string): string {
  // Invariant: Underscore/dash-joined codes (`model_not_found`) match the same
  // markers once flattened; extraction still reads the raw text.
  return lowered.replaceAll("_", " ").replaceAll("-", " ");
}

/** The shared mapping; `empty` names the text-less failure. */
function describe(
  text: string,
  empty: string,
  context: FailureContext,
): string {
  const lowered = text.toLowerCase();
  const flat = flatten(lowered);
  let [apiProvider, apiStatus] = apiErrorRefs(text);
  if (apiStatus === null) {
    const match = HTTP_STATUS_RE.exec(text);
    apiStatus = match ? Number(match[1]) : null;
  }
  const status = apiStatusSentence(text, apiProvider, apiStatus, context);
  if (status !== null) return status;
  if (CONTENT_FILTER_RE.test(text))
    return "The provider's content filter blocked this reply.";
  if (hasAny(lowered, AUTH_MARKERS)) {
    const provider = failureProvider(text, null, context);
    if (hasAny(lowered, REJECTED_KEY_MARKERS)) {
      return provider
        ? `The API key for provider ${provider} was rejected. Check it in Settings.`
        : "The configured API key was rejected. Check it in Settings.";
    }
    return provider
      ? `No API key is configured for provider ${provider}. Add one in Settings.`
      : "No API key is configured. Add one in Settings.";
  }
  const model = modelSentence(text, flat, apiProvider, apiStatus, context);
  if (model !== null) return model;
  // Invariant: Sentences split after JSON bodies are stripped, so a body cannot
  // split the boundary; paths are stripped after the split, so a path at a
  // boundary cannot eat its punctuation; the first surviving sentence then
  // collapses to one line.
  const cleaned = text
    .replace(JSON_BODY_RE, "")
    .replace(JSON_BODY_RE, "")
    .replace(SEE_DOCS_RE, "");
  const sentences = cleaned
    .split(SENTENCE_BREAK_RE)
    .map(strip)
    .filter((part) => part && !part.includes("/login"));
  const first = strip(
    (sentences[0] ?? "")
      .replace(ABSOLUTE_PATH_RE, "")
      .replace(WHITESPACE_RE, " "),
  );
  if (!first) return empty;
  return Array.from(first).slice(0, SENTENCE_MAX).join("");
}

// Bounded provider-side reason, else null for abort/local/unknown faults.
// Use display precedence: HTTP status, auth markers, then model availability.
export function providerOutageKind(
  raw: unknown,
  context: FailureContext = {},
): string | null {
  const text = stripErrorClass(raw);
  if (!text) return null;
  const lowered = text.toLowerCase();
  const [apiProvider, apiStatus] = apiErrorRefs(text);
  if (apiStatus === 401 || apiStatus === 403) {
    return "provider authentication failed";
  }
  if (apiStatus === 429) return "provider is rate limiting requests";
  if (apiStatus !== null && apiStatus >= 500 && apiStatus <= 599) {
    return "provider server error";
  }
  if (hasAny(lowered, AUTH_MARKERS)) return "provider authentication failed";
  const model = modelSentence(
    text,
    flatten(lowered),
    apiProvider,
    apiStatus,
    context,
  );
  return model !== null ? "model was not available" : null;
}

/** The live working-row text while Pi waits before a retry. */
export function retryingStatus(attempt: unknown, maximum: unknown): string {
  // Invariant: Python rejects the float 2.0 here; JavaScript numbers cannot
  // tell 2.0 from 2, so integral floats count. Callers pass Pi's integer
  // counters.
  const valid =
    Number.isInteger(attempt) &&
    Number.isInteger(maximum) &&
    (attempt as number) > 0 &&
    (maximum as number) >= (attempt as number);
  return valid
    ? `Connection dropped; retrying (attempt ${attempt} of ${maximum})…`
    : "Connection dropped; retrying…";
}

/** The transient transport failure a raw error names, if any. */
export function retryReason(raw: unknown): string | null {
  const text = rawText(raw);
  if (WEBSOCKET_RE.test(text)) return "WebSocket error";
  if (CONNECTION_RES.some((pattern) => pattern.test(text))) {
    return "connection error";
  }
  return TIMEOUT_RE.test(text) ? "timeout" : null;
}

// pi-ai raw provider stops for refusals and safety filters.
const REFUSAL_STOPS = new Set([
  "refusal",
  "sensitive",
  "content_filter",
  "incomplete.content_filter",
  "content_filtered",
  "guardrail_intervened",
  "SAFETY",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
]);

/** Is a terminal assistant message a refusal or filter block? */
export function isRefusal(message: {
  stopReason?: unknown;
  rawStopReason?: unknown;
}): boolean {
  return (
    message.stopReason === "error" &&
    typeof message.rawStopReason === "string" &&
    REFUSAL_STOPS.has(message.rawStopReason)
  );
}

/** A muted history line for a transient provider/transport failure. */
export function retriedNotice(raw: unknown): string {
  const reason = retryReason(raw);
  return reason
    ? `Connection dropped (${reason}); retried`
    : "Connection dropped; retried";
}

/**
 * One operator sentence for a failed send's row. The full raw text stays in
 * the logged `direct_send_failed` event and on the row's `error_detail`.
 */
export function describeSendFailure(raw: unknown): string {
  return describe(
    stripErrorClass(raw),
    "The send failed before Pi accepted it.",
    {},
  );
}

// One operator sentence for a failed turn's visible reason. `provider` and
// `model` are what ran the turn and win over anything scraped from the text;
// `knownModels` lets a bare scraped word still count when the operator
// configured it. The raw text stays in the Pi session file.
export function describeTurnFailure(
  raw: unknown,
  context: FailureContext = {},
): string {
  return describe(stripErrorClass(raw), "The turn failed.", context);
}
