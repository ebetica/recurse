// Match decoded paths/methods; HEAD is explicit, slash toggles redirect 307.
// Method mismatch uses first matching Allow; errors retain framework JSON.
// Record route templates for accounting. JS unsafe integers lose precision;
// Bun normalizes dot path segments.

import { STATUS_CODES } from "node:http";

export interface Exchange {
  /** Inner layers may replace this with a decoded or counted request. */
  request: Request;
  readonly url: ParsedUrl;
  /** Percent-decoded path, as ASGI `scope["path"]`. */
  readonly path: string;
  /** Peer after uvicorn's proxy-header rule. */
  readonly client: { readonly host: string; readonly port: number } | null;
  /** Stamped only by the private Tailscale Unix listener, never a header. */
  readonly tailscaleSocket?: boolean;
  readonly scheme: string;
  /** Matched route template, for logs; null before or without a match. */
  route: string | null;
  params: Record<string, string>;
  query: Record<string, string | number | boolean | null>;
  /** A route-specific request body bound set before decoding (auth). */
  bodyLimit: number | null;
  /** Free-form per-request state for later middlewares (principal, etc.). */
  readonly state: Record<string, unknown>;
  /** Lift Bun's idle timeout for this request (long routes). */
  disableTimeout(): void;
}

export type ParsedUrl = InstanceType<typeof URL>;

export type Handler = (ex: Exchange) => Promise<Response>;

const PHRASES: Record<number, string> = {
  413: "Request Entity Too Large",
  422: "Unprocessable Entity",
};

/** FastAPI's HTTPException: `{"detail": detail}` with optional headers. */
export class HttpError extends Error {
  readonly detail: unknown;
  constructor(
    readonly status: number,
    detail?: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    const phrase = PHRASES[status] ?? STATUS_CODES[status] ?? "";
    super(typeof detail === "string" ? detail : phrase);
    this.detail = detail === undefined ? phrase : detail;
  }
}

/** Starlette's JSONResponse bytes: compact, non-ASCII kept. */
export function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json",
    },
  });
}

export function errorResponse(error: HttpError): Response {
  if ([204, 304].includes(error.status) || error.status < 200)
    return new Response(null, { status: error.status, headers: error.headers });
  return jsonResponse({ detail: error.detail }, error.status, error.headers);
}

export type QueryType = "int" | "float" | "bool" | "str";
export interface QueryParam {
  readonly type: QueryType;
  /** Absent means optional with a null default. */
  readonly required?: boolean;
  readonly default?: string | number | boolean | null;
}

export interface RouteOptions {
  readonly query?: Readonly<Record<string, QueryParam>>;
  /** Requests that may legitimately outlast the idle timeout. */
  readonly longRunning?: boolean;
}

export interface Route extends RouteOptions {
  readonly methods: readonly string[];
  readonly path: string;
  readonly handler: Handler;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  let source = "";
  let last = 0;
  for (const match of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(:path)?\}/g)) {
    source += escape(path.slice(last, match.index));
    source += match[2] ? "(.*)" : "([^/]+)";
    names.push(match[1]!);
    last = match.index! + match[0].length;
  }
  source += escape(path.slice(last));
  return { pattern: new RegExp(`^${source}$`, "s"), names };
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const INT_RE = /^[+-]?[0-9]+(?:_[0-9]+)*(?:\.0*)?$/;
const FLOAT_RE =
  /^[+-]?(?:[0-9]+(?:_[0-9]+)*(?:\.(?:[0-9]+(?:_[0-9]+)*)?)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?$/;
const FLOAT_WORDS = new Map<string, number>([
  ["nan", NaN],
  ["+nan", NaN],
  ["-nan", NaN],
  ["inf", Infinity],
  ["+inf", Infinity],
  ["-inf", -Infinity],
  ["infinity", Infinity],
  ["+infinity", Infinity],
  ["-infinity", -Infinity],
]);
const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

interface Invalid {
  readonly type: string;
  readonly msg: string;
}

/** Pydantic v2 lax string coercion for the query types routes declare. */
export function coerceQuery(
  type: QueryType,
  raw: string,
): string | number | boolean | Invalid {
  if (type === "str") return raw;
  const text = raw.trim();
  if (type === "int") {
    if (!INT_RE.test(text))
      return {
        type: "int_parsing",
        msg: "Input should be a valid integer, unable to parse string as an integer",
      };
    return Math.trunc(Number(text.replaceAll("_", "")));
  }
  if (type === "float") {
    const word = FLOAT_WORDS.get(text.toLowerCase());
    if (word !== undefined) return word;
    if (!FLOAT_RE.test(text))
      return {
        type: "float_parsing",
        msg: "Input should be a valid number, unable to parse string as a number",
      };
    return Number(text.replaceAll("_", ""));
  }
  const lowered = raw.toLowerCase();
  if (TRUE.has(lowered)) return true;
  if (FALSE.has(lowered)) return false;
  return {
    type: "bool_parsing",
    msg: "Input should be a valid boolean, unable to interpret input",
  };
}

function parseQuery(
  route: Route,
  url: ParsedUrl,
): { values: Exchange["query"]; errors: unknown[] } {
  const values: Exchange["query"] = {};
  const errors: unknown[] = [];
  for (const [name, spec] of Object.entries(route.query ?? {})) {
    const all = url.searchParams.getAll(name);
    if (!all.length) {
      if (spec.required)
        errors.push({
          type: "missing",
          loc: ["query", name],
          msg: "Field required",
          input: null,
        });
      else values[name] = spec.default ?? null;
      continue;
    }
    // Invariant: FastAPI reads the last repeated value for a scalar parameter.
    const raw = all[all.length - 1]!;
    const value = coerceQuery(spec.type, raw);
    if (typeof value === "object")
      errors.push({ ...value, loc: ["query", name], input: raw });
    else values[name] = value;
  }
  return { values, errors };
}

/** Python urllib.parse.unquote: %XX bytes decoded as UTF-8 with replacement. */
export function unquote(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length; ) {
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const point = text.codePointAt(i)!;
      const char = String.fromCodePoint(point);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const REDIRECT_SAFE = new Set(":/%#?=@[]!$&'()*+,;");

/** Starlette RedirectResponse's `quote(url, safe=...)`. */
function quoteLocation(url: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(url)) {
    const char = String.fromCharCode(byte);
    out +=
      /[A-Za-z0-9_.~-]/.test(char) || REDIRECT_SAFE.has(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export class Router {
  private readonly table: Route[] = [];

  add(
    methods: readonly string[],
    path: string,
    handler: Handler,
    options: RouteOptions = {},
  ): void {
    const upper = methods.map((method) => method.toUpperCase());
    this.table.push({
      ...options,
      methods: upper,
      path,
      handler,
      ...compile(path),
    });
  }
  get(path: string, handler: Handler, options?: RouteOptions): void {
    this.add(["GET"], path, handler, options);
  }
  post(path: string, handler: Handler, options?: RouteOptions): void {
    this.add(["POST"], path, handler, options);
  }
  put(path: string, handler: Handler, options?: RouteOptions): void {
    this.add(["PUT"], path, handler, options);
  }
  delete(path: string, handler: Handler, options?: RouteOptions): void {
    this.add(["DELETE"], path, handler, options);
  }

  routes(): readonly Route[] {
    return this.table;
  }

  /** The route a path/method would reach, for pre-route middlewares. */
  match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string>; full: boolean } | null {
    let partial: { route: Route; params: Record<string, string> } | null = null;
    for (const route of this.table) {
      const found = route.pattern.exec(path);
      if (!found) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, index) => (params[name] = found[index + 1]!));
      if (route.methods.includes(method.toUpperCase()))
        return { route, params, full: true };
      partial ??= { route, params };
    }
    return partial && { ...partial, full: false };
  }

  readonly handle: Handler = async (ex) => {
    try {
      return await this.dispatch(ex);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error);
      throw error;
    }
  };

  private async dispatch(ex: Exchange): Promise<Response> {
    const found = this.match(ex.request.method, ex.path);
    if (found === null) {
      if (ex.path !== "/") {
        const path = ex.path.endsWith("/")
          ? ex.path.replace(/\/+$/, "")
          : `${ex.path}/`;
        if (this.match(ex.request.method, path) !== null) {
          const host = ex.request.headers.get("host") ?? ex.url.host;
          const query = ex.url.search;
          const location = quoteLocation(
            `${ex.scheme}://${host}${path}${query}`,
          );
          return new Response(null, {
            status: 307,
            headers: { location, "content-length": "0" },
          });
        }
      }
      throw new HttpError(404);
    }
    ex.route = found.route.path;
    ex.params = found.params;
    if (!found.full)
      throw new HttpError(405, undefined, {
        allow: found.route.methods.join(", "),
      });
    const { values, errors } = parseQuery(found.route, ex.url);
    if (errors.length) return jsonResponse({ detail: errors }, 422);
    ex.query = values;
    if (found.route.longRunning) ex.disableTimeout();
    return await found.route.handler(ex);
  }
}
