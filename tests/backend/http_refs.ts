import {
  exchange,
  normalise,
  requestBytes,
  type BodySpec,
  type CaseRequest,
  type NormalisedResponse,
} from "./http_corpus";

const TIME_KEYS = new Set([
  "ts",
  "created",
  "updated",
  "created_at",
  "updated_at",
  "mtime",
]);
const SHA_RE = /\b[0-9a-f]{40}\b/g;
const HEX32_RE = /\b[0-9a-f]{32}\b/g;
const DATE_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?/g;

export interface RefCase {
  readonly name: string;
  readonly request: CaseRequest;
  readonly response: NormalisedResponse;
  readonly save?: Record<string, string>;
  readonly until?: string;
  readonly setup?: Record<string, unknown>;
}

export class Refs {
  readonly values = new Map<string, string>();

  put(name: string, value: unknown): void {
    this.values.set(name, String(value));
  }

  resolve(text: string): string {
    for (const [name, value] of this.values)
      text = text.replaceAll(`<@${name}>`, value);
    return text;
  }

  request(spec: CaseRequest): CaseRequest {
    const body = (item: BodySpec): BodySpec => {
      if (Array.isArray(item)) return item.map(body);
      if (item && typeof item === "object" && "text" in item)
        return { ...item, text: this.resolve(item.text) };
      return item;
    };
    return {
      ...spec,
      path: this.resolve(spec.path),
      headers: (spec.headers ?? []).map(
        ([n, v]) => [n, this.resolve(v)] as const,
      ),
      ...(spec.body === undefined ? {} : { body: body(spec.body) }),
    };
  }

  text(value: string): string {
    const saved = [...this.values].sort((a, b) => b[1].length - a[1].length);
    for (const [name, item] of saved)
      if (item) value = value.replaceAll(item, `<@${name}>`);
    return value
      .replace(SHA_RE, "<sha>")
      .replace(HEX32_RE, "<hex32>")
      .replace(DATE_RE, "<date>");
  }

  walk(value: unknown, key?: string): unknown {
    if (key !== undefined && TIME_KEYS.has(key) && typeof value === "number")
      return "<time>";
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [this.text(k), this.walk(v, k)]),
      );
    return value;
  }

  normalise(response: NormalisedResponse): NormalisedResponse {
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([k, v]) => [k, this.text(v)]),
    );
    return {
      status: response.status,
      headers,
      body: this.walk(response.body),
    };
  }
}

function pick(response: NormalisedResponse, path: string): unknown {
  if (path.startsWith("header:")) return response.headers[path.slice(7)];
  let value = (response.body as { json: unknown }).json as any;
  for (const part of path.split("."))
    value = Array.isArray(value) ? value[Number(part)] : value[part];
  if (value === undefined) throw new Error(`cannot save ${path}`);
  return value;
}

export async function runRefCases(
  port: number,
  cases: readonly RefCase[],
  refs: Refs,
  options: {
    setup?: (spec: Record<string, unknown>) => void | Promise<void>;
    expect?: (
      item: RefCase,
      got: NormalisedResponse,
    ) => string | null | undefined;
  } = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const item of cases) {
    if (item.setup) await options.setup?.(item.setup);
    const request = refs.request(item.request);
    const deadline = Date.now() + 5000;
    let response: NormalisedResponse;
    for (;;) {
      response = normalise(
        await exchange(port, requestBytes(request)),
        request.method,
      );
      if (
        item.until === undefined ||
        JSON.stringify(response.body).includes(item.until) ||
        Date.now() > deadline
      )
        break;
      await Bun.sleep(20);
    }
    for (const [name, path] of Object.entries(item.save ?? {})) {
      try {
        refs.put(name, pick(response, path));
      } catch {
        problems.push(`${item.name}: cannot save ${path}`);
      }
    }
    const got = refs.normalise(response);
    const custom = options.expect?.(item, got);
    if (custom !== undefined) {
      if (custom !== null) problems.push(`${item.name}: ${custom}`);
      continue;
    }
    if (!Bun.deepEquals(got, item.response))
      problems.push(
        `${item.name}:\n  want ${JSON.stringify(item.response)}\n  got  ${JSON.stringify(got)}`,
      );
  }
  return problems;
}
