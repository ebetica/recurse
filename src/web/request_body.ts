// Strict FastAPI-compatible JSON object validation shared by HTTP routes.
// Non-JSON decoding stays route-specific, including UTF-8 BOM handling.

import { pyStrip } from "../auth/provider_store";
import { parsePythonJson } from "../utils/py_compact_json";
import { HttpError, type Exchange } from "./router";

/** Validate an object without parsing non-JSON content types as JSON. */
export async function jsonObjectBody(
  ex: Exchange,
  required: boolean,
  decodeNonJson: (bytes: Uint8Array) => string = (bytes) =>
    Buffer.from(bytes).toString("utf8"),
): Promise<Record<string, unknown> | null> {
  const bytes = new Uint8Array(await ex.request.arrayBuffer());
  let body: unknown = null;
  if (bytes.length) {
    // Invariant: FastAPI 0.139 strict_content_type: only application/json or
    // +json is parsed; a missing or other type is raw text (dict_type 422).
    // This also refuses cross-site text/plain simple requests.
    const header = ex.request.headers.get("content-type");
    const parts = (
      header ? pyStrip(header.split(";")[0]!).toLowerCase() : ""
    ).split("/");
    const [main, sub] = parts;
    const isJson =
      parts.length === 2 &&
      main === "application" &&
      !!sub &&
      (sub === "json" || sub.endsWith("+json"));
    if (isJson) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, "There was an error parsing the body");
      }
      try {
        body = parsePythonJson(text);
      } catch {
        throw new HttpError(422, [
          {
            type: "json_invalid",
            loc: ["body", 0],
            msg: "JSON decode error",
            input: {},
            ctx: { error: "Expecting value" },
          },
        ]);
      }
    } else body = decodeNonJson(bytes);
  }
  if (body === null) {
    if (!required) return null;
    throw new HttpError(422, [
      { type: "missing", loc: ["body"], msg: "Field required", input: null },
    ]);
  }
  if (typeof body !== "object" || Array.isArray(body))
    throw new HttpError(422, [
      {
        type: "dict_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary",
        input: body,
      },
    ]);
  return body as Record<string, unknown>;
}
