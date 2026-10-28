/** Apply the app theme at serve time, before the Artifact's page styles. */
import { FONT_MONO, FONT_SANS } from "../themes/fonts";
import { defaultThemeCss } from "../themes";

/** Map generated app declarations to the stable Artifact variable names. */
export function artifactVariables(css: string): Record<string, string> {
  const tokens = Object.fromEntries(
    [...css.matchAll(/--([\w-]+):([^;}]+)/g)].map((m) => [m[1]!, m[2]!]),
  );
  const variables: Record<string, string> = {};
  for (const key of [
    "bg",
    "panel",
    "panel-2",
    "border",
    "text",
    "muted",
    "accent",
    "accent-dim",
    "code-bg",
    "danger",
  ])
    variables[`--${key}`] = tokens[key]!;
  variables["--warning"] = tokens.warn!;
  variables["--success"] = tokens.running!;
  const charts = [
    ...new Set(
      [
        "accent",
        "info",
        "running",
        "warn",
        "danger",
        "syntax-name",
        "syntax-type",
        "accent-hover",
        "syntax-tag",
        "syntax-string",
      ].map((key) => tokens[key]!),
    ),
  ].slice(0, 6);
  charts.forEach((color, index) => (variables[`--chart-${index + 1}`] = color));
  return {
    ...variables,
    "--radius": "8px",
    "--font-sans": FONT_SANS,
    "--font-mono": FONT_MONO,
  };
}

/** Preserve system media blocks while translating each generated palette. */
export function themeStyle(css = defaultThemeCss): string {
  const mapped = css.replace(/:root\{([^}]+)\}/g, (_, declarations: string) => {
    const scheme = declarations.match(/color-scheme:([^;]+)/)![1];
    return `:root{color-scheme:${scheme};${Object.entries(
      artifactVariables(declarations),
    )
      .map(([name, value]) => `${name}:${value};`)
      .join("")}}`;
  });
  return (
    `<style id="recurse-theme">${mapped}` +
    "html{background:var(--bg);color:var(--text);font:14px/1.5 var(--font-sans)}" + // font-check: allow Artifact document body
    "body{margin:0;background:var(--bg);color:var(--text)}code,kbd,pre,samp{font-family:var(--font-mono)}</style>"
  );
}

/** Replace legacy build-time themes without changing stored Artifact bytes. */
export function themedHtml(html: string, css: string): string {
  const clean = new HTMLRewriter()
    .on("style#recurse-theme", {
      element(element) {
        element.remove();
      },
    })
    .transform(html);
  return prependToHead(clean, themeStyle(css));
}

// Insert markup ahead of the page's own head content: at the start of <head>,
// else just before the first element after <html>. Bun's HTML rewriter parses
// the page, so comments, attribute values, and script text are never mistaken
// for tags.
export function prependToHead(html: string, markup: string): string {
  let placed = false;
  const out = new HTMLRewriter()
    .on("*", {
      element(element) {
        if (placed || element.tagName === "html") return;
        placed = true;
        if (element.tagName === "head") element.prepend(markup, { html: true });
        else element.before(markup, { html: true });
      },
    })
    .transform(html);
  return placed ? out : out + markup;
}
