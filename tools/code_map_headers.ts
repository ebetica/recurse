/** Read the leading description shared by the code map and source header check. */

export const HEADER_BYTES = 8192;

const SOURCE = /\.(?:[cm]?[jt]sx?|css|html?|sh|bash|py)$/i;
const SLASH_LINE = /^\/\/([^\r\n]*)/;
const HASH_LINE = /^#([^\r\n]*)/;
const BLOCK = /^\/\*\*?([\s\S]*?)\*\//;
const HTML = /^<!--([\s\S]*?)-->/;
const DIRECTIVE =
  /^(?:@ts-|oxlint-|eslint-|prettier-ignore\b|shellcheck\b|(?:color|font|svg)-check:\s*allow\b|\/\s*<reference\b)/i;

export function isHeaderSource(file: string): boolean {
  return SOURCE.test(file);
}

export function isLicenseComment(text: string): boolean {
  return /(?:@license\b|SPDX-License-Identifier:|(?:^|\n)\s*Copyright\b|^(?:MIT License|Apache License|GNU (?:General|Lesser) Public License|Licensed under\b|Permission is hereby granted\b))/i.test(
    text,
  );
}

/** Return the first nonempty line of a leading source comment, not a directive. */
export function sourceHeader(file: string, text: string): string | undefined {
  let rest = text.replace(/^\uFEFF?#![^\n]*(?:\n|$)/, "").trimStart();
  const html = /\.html?$/i.test(file);
  const hash = /\.(?:sh|bash|py)$/i.test(file);
  const slash = /\.[cm]?[jt]sx?$/i.test(file);
  if (html) rest = rest.replace(/^<!doctype[^>]*>/i, "").trimStart();
  for (;;) {
    const comment =
      (html ? HTML : hash ? HASH_LINE : BLOCK).exec(rest) ??
      (slash ? SLASH_LINE.exec(rest) : null);
    if (!comment) return;
    const lines = comment[1]!
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\*\s?/, ""));
    const first = lines.find(Boolean);
    const license = isLicenseComment(lines.join("\n").trim());
    if (first && !license && !DIRECTIVE.test(first)) return first;
    rest = rest.slice(comment[0].length);
    if (license && (hash || comment[0].startsWith("//")))
      rest = rest.replace(/^(?:\r?\n[ \t]*(?:\/\/|#)[^\r\n]*)+/, "");
    rest = rest.trimStart();
  }
}
