import { describe, expect, test } from "bun:test";
import {
  safePrUrl,
  summaryLineHtml,
} from "../../web/thread-render/turn-summary";
import type { TurnSummary } from "../../web/types";

const summary = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  tools: 0,
  shell: 0,
  read_files: 0,
  edit_files: 0,
  added: 0,
  removed: 0,
  write_files: 0,
  agents: 0,
  searches: 0,
  web: 0,
  prs: [],
  truncated: false,
  ...over,
});

describe("turn summary line", () => {
  // test-check-allow: T9 Safe PR links and #2343 mixed evidence guard.
  test("links only validated PR metadata and falls back to plain text", () => {
    const link = "https://github.com/example-org/recurse/pull/836";
    expect(
      summaryLineHtml(
        summary({ prs: [836], pr_links: [{ number: 836, url: link }] }),
      ),
    ).toContain(`<a href="${link}"`);
    expect(
      summaryLineHtml(
        summary({
          prs: [836],
          pr_links: [{ number: 836, url: "javascript:alert(1)" }],
        }),
      ),
    ).toBe("PR #836");
    expect(summaryLineHtml(summary({ prs: [836] }))).toBe("PR #836");
    expect(safePrUrl(836, link)).toBe(link);
    expect(
      safePrUrl(836, "https://github.com/example-org/recurse/pull/837"),
    ).toBeNull();
  });
});
