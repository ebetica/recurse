// Pure URL policy for rolling frontend upgrades. Browser wiring lives in
// connection.ts; this module makes the one-automatic-navigation bound explicit
// and independently testable.

export const GENERATION_PARAM = "_recurse_generation";
export const GENERATION_RETRY_PARAM = "_recurse_retry";

export type GenerationDecision = "match" | "navigate" | "retry";

export function generationDecision(
  loaded: string,
  current: string,
  search: string,
): GenerationDecision {
  if (!loaded || !current || loaded === current) return "match";
  const params = new URLSearchParams(search);
  return params.get(GENERATION_PARAM) === current ? "retry" : "navigate";
}

export function generationNavigationUrl(
  href: string,
  target: string,
  manual = false,
  retryToken = Date.now().toString(),
): string {
  const url = new URL(href);
  url.searchParams.set(GENERATION_PARAM, target);
  if (manual) url.searchParams.set(GENERATION_RETRY_PARAM, retryToken);
  else url.searchParams.delete(GENERATION_RETRY_PARAM);
  return url.href;
}

export function matchingGenerationUrl(
  href: string,
  loaded: string,
  current: string,
): string | null {
  if (!loaded || !current || loaded !== current) return null;
  const url = new URL(href);
  if (
    !url.searchParams.has(GENERATION_PARAM) &&
    !url.searchParams.has(GENERATION_RETRY_PARAM)
  )
    return null;
  url.searchParams.delete(GENERATION_PARAM);
  url.searchParams.delete(GENERATION_RETRY_PARAM);
  return url.href;
}
