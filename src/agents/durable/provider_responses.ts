// Mask credentials at the Pi provider call, where auth is already resolved.
import type {
  AnyModel,
  AssistantMessage,
  AssistantMessageEvent,
  Provider,
  ProviderRequestOptions,
  ToolCall,
} from "@earendil-works/pi-ai";

export type ChatStream = ReturnType<Provider["streamSimple"]>;

/** Only the conversation turn opts in to the original error, off the reply. */
export const TURN_ERROR_TEXT = Symbol("original conversation error");
export interface TurnErrorText {
  replies: WeakMap<AssistantMessage, string>;
  rejected?: { raw: string; masked: string };
}
type TurnOptions = ProviderRequestOptions & {
  [TURN_ERROR_TEXT]?: TurnErrorText;
};

export function rememberTurnError(
  options: TurnOptions | undefined,
  raw: AssistantMessage,
  safe: AssistantMessage,
): void {
  if (
    raw.stopReason === "error" &&
    raw.errorMessage !== undefined &&
    raw.errorMessage !== safe.errorMessage
  )
    options?.[TURN_ERROR_TEXT]?.replies.set(safe, raw.errorMessage);
}

/** Pi's lazy stream copies a thrown error's message into a new reply. */
export function maskProviderFailure(
  options: TurnOptions | undefined,
  raw: string,
  redact: (text: string) => string,
): Error {
  const masked = redact(raw);
  const turn = options?.[TURN_ERROR_TEXT];
  if (turn && raw !== masked) turn.rejected = { raw, masked };
  return new Error(masked);
}

function maskFields<T extends object>(
  reply: T,
  redact: (text: string) => string,
  names: readonly (keyof T)[],
): T {
  let safe = reply;
  for (const name of names) {
    const raw = reply[name];
    if (typeof raw !== "string") continue;
    const masked = redact(raw);
    if (masked !== raw) {
      if (safe === reply) safe = { ...reply };
      Object.assign(safe, { [name]: masked });
    }
  }
  return safe;
}

/** A request's literal credentials and how JSON renders those same bytes. */
export function credentialMask(credentials: string[]) {
  const patterns = [
    ...new Set(
      credentials
        .filter(Boolean)
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  let mask = "[redacted]";
  for (
    let code = 0x2588;
    patterns.some(
      (key) =>
        mask.includes(key) ||
        key.includes(mask[0]!) ||
        key.includes(mask.at(-1)!),
    );
    code++
  )
    mask = String.fromCharCode(code);
  const containsKey = (text: string) =>
    patterns.some((key) => text.includes(key));
  const redact = (text: string) => {
    if (!containsKey(text)) return text;
    const safe = patterns.reduce<string>(
      (value, key) => value.replaceAll(key, mask),
      text,
    );
    return containsKey(safe) ? mask : safe;
  };
  return { patterns, mask, redact };
}

/** Rewrite strings in provider metadata, including arbitrary detail keys. */
export function credentialFields(
  redact: (text: string) => string,
  renameFields: boolean,
) {
  const fields = <T extends object>(
    value: T,
    keep: readonly string[] = [],
  ): T =>
    Object.fromEntries(
      Object.entries(value).map(([name, item]) =>
        keep.includes(name)
          ? [name, item]
          : [renameFields ? redact(name) : name, metadata(item)],
      ),
    ) as T;
  const metadata = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(metadata);
    if (value && typeof value === "object") return fields(value);
    return value;
  };
  return fields;
}

export function mapStreamMessages(
  stream: ChatStream,
  map: (message: AssistantMessage, terminal: boolean) => AssistantMessage,
  handlers?: {
    failure: (error: unknown) => Error;
    event?: (event: AssistantMessageEvent) => AssistantMessageEvent;
  },
): ChatStream {
  const mapEvent =
    handlers?.event ??
    ((event: AssistantMessageEvent): AssistantMessageEvent =>
      event.type === "done"
        ? { ...event, message: map(event.message, true) }
        : event.type === "error"
          ? { ...event, error: map(event.error, true) }
          : { ...event, partial: map(event.partial, false) });
  return new Proxy(stream, {
    get(response, key) {
      if (key === "result")
        return async () => {
          try {
            return map(await response.result(), true);
          } catch (error) {
            throw handlers ? handlers.failure(error) : error;
          }
        };
      if (key === Symbol.asyncIterator)
        return async function* () {
          try {
            for await (const event of response) yield mapEvent(event);
          } catch (error) {
            throw handlers ? handlers.failure(error) : error;
          }
        };
      const value = Reflect.get(response, key, response);
      return typeof value === "function" ? value.bind(response) : value;
    },
  });
}

function requestCredentials(
  options: ProviderRequestOptions | undefined,
): string[] {
  const values = [options?.apiKey];
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    if (!value) continue;
    switch (name.toLowerCase()) {
      case "authorization":
      case "proxy-authorization":
      case "cf-aig-authorization":
        values.push(
          /^(?:Bearer|Basic)\s+(.+)$/i.exec(value.trim())?.[1] ?? value,
        );
        break;
      case "api-key":
      case "x-api-key":
      case "x-goog-api-key":
        values.push(value);
        break;
    }
  }
  return values.flatMap((value) =>
    value ? [value, value.trim()].filter(Boolean) : [],
  );
}

/** Mask the resolved values even if one is also a Pi retry marker. */
export function withProviderErrors(provider: Provider): Provider {
  return new Proxy(provider, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      const streaming =
        key === "stream" || key === "streamSimple" || key === "fetchDeferred";
      if (
        !streaming &&
        key !== "cancelDeferred" &&
        key !== "classify" &&
        key !== "generateImages"
      )
        return method.bind(target);
      return (
        model: AnyModel,
        input: unknown,
        options?: ProviderRequestOptions,
      ) => {
        const credentials = requestCredentials(options);
        const call = () => method.call(target, model, input, options);
        if (!credentials.length) return call();
        const { redact } = credentialMask(credentials);
        const failure = (error: unknown) =>
          maskProviderFailure(
            options,
            error instanceof Error ? error.message : String(error),
            redact,
          );
        const fields = credentialFields(redact, false);
        const detailFields = credentialFields(redact, true);
        if (!streaming)
          return (async () => {
            try {
              const result = await call();
              return key === "cancelDeferred"
                ? result
                : maskFields(result, redact, ["errorMessage", "responseId"]);
            } catch (error) {
              throw failure(error);
            }
          })();
        const toolMetadata = (block: ToolCall) =>
          maskFields(block, redact, [
            "id",
            "name",
            "namespace",
            "thoughtSignature",
            "argumentsError",
          ]);
        const map = (reply: AssistantMessage, terminal: boolean) => {
          let safe = maskFields(reply, redact, [
            "errorMessage",
            "rawStopReason",
            "responseId",
            "responseModel",
            "providerThinkingLevel",
          ]);
          if (reply.deferred) {
            const deferred = fields(reply.deferred, [
              "provider",
              "modelId",
              "api",
            ]);
            safe = { ...safe, deferred };
          }
          const failed =
            terminal &&
            (reply.stopReason === "error" || reply.stopReason === "aborted");
          const content = reply.content.map((block) => {
            if (failed) return fields(block, ["type"]);
            if (block.type === "toolCall") return toolMetadata(block);
            return block.type === "text"
              ? maskFields(block, redact, ["textSignature"])
              : maskFields(block, redact, ["thinkingSignature"]);
          });
          if (content.some((block, index) => block !== reply.content[index]))
            safe = { ...safe, content };
          if (reply.diagnostics) {
            const diagnostics = reply.diagnostics.map((diagnostic) => {
              const safe = fields(diagnostic, ["details"]);
              if (diagnostic.details)
                safe.details = detailFields(diagnostic.details);
              return safe;
            });
            safe = { ...safe, diagnostics };
          }
          if (terminal) rememberTurnError(options, reply, safe);
          return safe;
        };
        try {
          return mapStreamMessages(call(), map, {
            failure,
            event: (event) => {
              if (event.type === "done")
                return { ...event, message: map(event.message, true) };
              if (event.type === "error")
                return { ...event, error: map(event.error, true) };
              return {
                ...event,
                partial: map(event.partial, false),
                ...(event.type === "toolcall_end" && {
                  toolCall: toolMetadata(event.toolCall),
                }),
              };
            },
          });
        } catch (error) {
          throw failure(error);
        }
      };
    },
  });
}
