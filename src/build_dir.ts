// Checkout-owned generated tools live under .recurse; pinned Pi/fff
// dependencies
// live in node_modules with Bun patches. Source-defined paths prevent separate
// checkouts from sharing mutable executables.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sourceFile = realpathSync(fileURLToPath(import.meta.url));
export const CHECKOUT_ROOT = dirname(dirname(sourceFile));

function pythonPath(path: string): string {
  const prefix =
    path.startsWith("//") && !path.startsWith("///")
      ? "//"
      : path.startsWith("/")
        ? "/"
        : "";
  const body = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return body ? `${prefix}${body}` : prefix || ".";
}

function appendPath(path: string, child: string): string {
  const base = pythonPath(path);
  if (base === ".") return child;
  const parent = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${parent}/${child}`;
}

export const BUILD_DIR = appendPath(CHECKOUT_ROOT, ".recurse");

/** Return the build directory belonging to `checkout`. */
export function forCheckout(checkout: string): string {
  return appendPath(checkout, ".recurse");
}

/** The installed Pi package (`@earendil-works/pi-coding-agent`). */
export const PI_PACKAGE_ROOT = appendPath(
  CHECKOUT_ROOT,
  "node_modules/@earendil-works/pi-coding-agent",
);
