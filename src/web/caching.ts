// Weak body ETags revalidate pre-compression bytes with 304 responses.
// Authenticated payloads are private/no-cache; generation-pinned assets
// immutable.

import { createHash } from "node:crypto";

export const PRIVATE_REVALIDATE = "private, no-cache";
export const IMMUTABLE_YEAR = "private, max-age=31536000, immutable";

export function weakEtag(body: Uint8Array | string): string {
  return `W/"${createHash("sha256").update(body).digest("hex")}"`;
}

/** RFC 9110 If-None-Match: an exact echo of our validator, or `*`. */
export function ifNoneMatchMatches(
  headerValue: string | null | undefined,
  etag: string,
): boolean {
  if (!headerValue) return false;
  const candidates = headerValue.split(",").map((item) => item.trim());
  return candidates.includes("*") || candidates.includes(etag);
}

function finish(
  request: Request,
  response: Response,
  body: Uint8Array | string,
  cacheControl: string,
): Response {
  const etag = weakEtag(body);
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag))
    return new Response(null, {
      status: 304,
      headers: { "cache-control": cacheControl, etag },
    });
  response.headers.set("cache-control", cacheControl);
  response.headers.set("etag", etag);
  return response;
}

/** JSON payload with a weak ETag; 304 when the client already holds it. */
export function conditionalJson(
  request: Request,
  payload: unknown,
  options: {
    readonly cacheControl?: string;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
): Response {
  const body = JSON.stringify(payload);
  return finish(
    request,
    new Response(body, {
      headers: {
        ...options.extraHeaders,
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      },
    }),
    body,
    options.cacheControl ?? PRIVATE_REVALIDATE,
  );
}

/** Raw bytes (HTML shell, static assets) with a weak ETag; 304 on match. */
export function conditionalBytes(
  request: Request,
  body: Uint8Array | string,
  mediaType: string,
  cacheControl: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const contentType = mediaType.startsWith("text/")
    ? `${mediaType}; charset=utf-8`
    : mediaType;
  const bytes: Uint8Array =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const response = new Response(bytes, {
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      ...extraHeaders,
    },
  });
  return finish(request, response, bytes, cacheControl);
}
