export type StopIdGenerator = "random_uuid" | "get_random_values" | "fallback";

export interface StopIdResult {
  id: string;
  generator: StopIdGenerator;
}

export interface StopIdRuntime {
  // Test crypto override; explicit undefined disables the generator.
  crypto?: unknown;
  now?: () => number;
  random?: () => number;
}

const STOP_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const RANDOM_BYTES = 16;
let fallbackCounter = 0;

function globalCrypto(): unknown {
  try {
    return globalThis.crypto;
  } catch {
    return undefined;
  }
}

function method(
  source: unknown,
  name: "randomUUID" | "getRandomValues",
): unknown {
  if (
    source === null ||
    (typeof source !== "object" && typeof source !== "function")
  )
    return undefined;
  try {
    return (source as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function compactId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.replaceAll("-", "");
  return STOP_ID_RE.test(id) ? id : null;
}

function randomUuidId(source: unknown): string | null {
  const generate = method(source, "randomUUID");
  if (typeof generate !== "function") return null;
  try {
    return compactId(Reflect.apply(generate, source, []));
  } catch {
    return null;
  }
}

function randomValuesId(source: unknown): string | null {
  const fill = method(source, "getRandomValues");
  if (typeof fill !== "function") return null;
  try {
    const bytes = new Uint8Array(RANDOM_BYTES);
    Reflect.apply(fill, source, [bytes]);
    let id = "";
    for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
    return compactId(id);
  } catch {
    return null;
  }
}

function runtimeNumber(
  runtime: StopIdRuntime,
  name: "now" | "random",
  fallback: () => number,
): number {
  try {
    const candidate = runtime[name];
    const value =
      typeof candidate === "function"
        ? Reflect.apply(candidate, runtime, [])
        : fallback();
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function nextFallbackId(runtime: StopIdRuntime): string {
  fallbackCounter =
    fallbackCounter >= Number.MAX_SAFE_INTEGER ? 1 : fallbackCounter + 1;
  const now = Math.floor(Math.abs(runtimeNumber(runtime, "now", Date.now)));
  const random = Math.min(
    0.9999999997671694,
    Math.max(0, runtimeNumber(runtime, "random", Math.random)),
  );
  const entropy = Math.floor(random * 0x1_0000_0000);
  return `stop-${now.toString(36)}-${fallbackCounter.toString(36)}-${entropy.toString(36)}`;
}

/** Generate a compact Stop id without relying on secure-context-only APIs. */
export function createStopId(runtime: StopIdRuntime = {}): StopIdResult {
  let options: StopIdRuntime = runtime;
  try {
    if (!options || typeof options !== "object") options = {};
  } catch {
    options = {};
  }
  let source: unknown;
  try {
    source = Object.prototype.hasOwnProperty.call(options, "crypto")
      ? options.crypto
      : globalCrypto();
  } catch {
    source = undefined;
  }
  const randomUuid = randomUuidId(source);
  if (randomUuid) return { id: randomUuid, generator: "random_uuid" };
  const randomValues = randomValuesId(source);
  if (randomValues) return { id: randomValues, generator: "get_random_values" };
  return { id: nextFallbackId(options), generator: "fallback" };
}

// Logs only a non-sensitive generator enum; logging never blocks Stop.
export function reportStopIdFallback(generator: StopIdGenerator): void {
  if (generator !== "get_random_values" && generator !== "fallback") return;
  try {
    console.info("stop_request_id_fallback", { generator });
  } catch {}
}
