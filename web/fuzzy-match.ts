// Pure text ranking shared by the finders (agent references in the composer,
// model boxes in Settings). A candidate is ranked on its normalized title,
// the title's word tokens, and a normalized secondary id string. Lower tiers
// and scores rank first; null means no match.

export interface RankFields {
  normalizedTitle: string;
  normalizedId: string;
  tokens: string[];
}

export interface TextRank {
  tier: number;
  score: number;
}

/** Case-, accent-, and whitespace-folded text for matching. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export function titleTokens(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function fuzzySubsequence(needle: string, haystack: string): number | null {
  if (needle.length < 2) return null;
  let at = 0,
    first = -1,
    previous = -1,
    gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    at = found + char.length;
  }
  return (
    first * 4 + gaps * 3 + Math.max(0, haystack.length - needle.length) / 32
  );
}

/** Tiers: 0 title prefix, 1 token prefix, 2 substring (title before id),
 * 3 fuzzy subsequence, 4 empty query. `query` must already be normalized. */
export function textRank(fields: RankFields, query: string): TextRank | null {
  if (!query) return { tier: 4, score: 0 };
  const title = fields.normalizedTitle;
  if (title.startsWith(query))
    return { tier: 0, score: title === query ? -1 : title.length / 1_000 };
  const token = fields.tokens.findIndex((part) => part.startsWith(query));
  if (token >= 0)
    return { tier: 1, score: token + fields.tokens[token].length / 1_000 };
  const titleAt = title.indexOf(query);
  const idAt = fields.normalizedId.indexOf(query);
  if (titleAt >= 0 || idAt >= 0) {
    const best =
      titleAt < 0 ? idAt + 1 : idAt < 0 ? titleAt : Math.min(titleAt, idAt + 1);
    return { tier: 2, score: best };
  }
  const titleFuzzy = fuzzySubsequence(query, title);
  const idFuzzy = fuzzySubsequence(query, fields.normalizedId);
  const score =
    titleFuzzy == null
      ? idFuzzy
      : idFuzzy == null
        ? titleFuzzy
        : Math.min(titleFuzzy, idFuzzy + 1);
  return score == null ? null : { tier: 3, score };
}

export function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
