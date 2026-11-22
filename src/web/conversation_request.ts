// Request parsing shared by operator and service conversation routes.

import { jsonObjectBody } from "./request";
import type { Exchange } from "./router";

type Rec = Record<string, unknown>;

export const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";
export const isValueError = (error: unknown) =>
  errorName(error) === "ValueError";
export const codePoints = (text: string) => Array.from(text).length;

/** Conversation bodies strip the UTF-8 BOM even when not parsed as JSON. */
export async function dictBody(
  ex: Exchange,
  required: false,
): Promise<Rec | null>;
export async function dictBody(ex: Exchange, required?: true): Promise<Rec>;
export async function dictBody(
  ex: Exchange,
  required = true,
): Promise<Rec | null> {
  return jsonObjectBody(ex, required, (bytes) =>
    new TextDecoder().decode(bytes),
  );
}

export const noStore = { "cache-control": "no-store" };
export const header = (ex: Exchange, name: string) =>
  ex.request.headers.get(name);
export const queryStr = (ex: Exchange, name: string) => {
  const value = ex.query[name];
  return value === null || value === undefined ? null : String(value);
};
