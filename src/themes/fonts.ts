/** The app's font stacks, read once from web/theme.css for server pages. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const THEME_CSS = readFileSync(
  join(import.meta.dir, "..", "..", "web", "theme.css"),
  "utf8",
);

/** The value of one custom property declared in web/theme.css. */
function token(name: string): string {
  return THEME_CSS.match(new RegExp(`--${name}:\\s*([^;]+);`))![1]!;
}

/** The UI sans-serif stack, var(--font-sans). */
export const FONT_SANS = token("font-sans");

/** The monospace stack, var(--font-mono). */
export const FONT_MONO = token("font-mono");
