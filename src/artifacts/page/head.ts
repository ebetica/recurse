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
