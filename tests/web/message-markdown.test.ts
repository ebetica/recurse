import { expect, test } from "bun:test";
import { parseMessageMarkdown } from "../../web/util/message-markdown.js";

// test-check-allow: T9 Active HTML must remain escaped literal prose.
test("HTML blocks, raw-text elements and attributes render as literal prose", () => {
  const html = parseMessageMarkdown(
    '<title>Heading</title>\n\nAfter the heading.\n\n<script>alert(1)</script>\n\n<img src="/bad" onerror="bad()">',
  );
  expect(html).toContain("&lt;title&gt;Heading&lt;/title&gt;");
  expect(html).toContain("After the heading.");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain(
    "&lt;img src=&quot;/bad&quot; onerror=&quot;bad()&quot;&gt;",
  );
});
