import { expect } from "bun:test";
import type { Locator } from "playwright";

export async function assertSchemeLinks(markdown: Locator): Promise<void> {
  for (const [name, href] of [
    ["Email", "mailto:reader@example.com"],
    ["Phone", "tel:+15551234567"],
    ["Local file", "file:///tmp/example"],
    ["Open editor", "vscode://file/x"],
    ["Notes", "obsidian://open?vault=notes"],
    ["Chat", "slack://open"],
    ["FTP", "ftp://files.example/report"],
    ["Custom script name", "otherscript:open"],
  ]) {
    const link = markdown.getByRole("link", { name, exact: true });
    expect(await link.getAttribute("href")).toBe(href);
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(await link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await link.getAttribute("class")).toBeNull();
    expect(
      await link.evaluate((element: any) =>
        element.nextElementSibling?.classList.contains("artifact-link-host"),
      ),
    ).not.toBeTrue();
  }
  for (const name of ["Unsafe script", "Unsafe vbscript", "Unsafe data"]) {
    const blocked = markdown.locator("a", { hasText: name });
    expect(await blocked.getAttribute("href")).toBeNull();
    expect(await blocked.getAttribute("class")).toBe("artifact-blocked-link");
    expect(
      await blocked.evaluate(
        (element: any) => element.nextElementSibling?.textContent,
      ),
    ).toBe(" (link blocked)");
  }
}

export async function assertDocumentLinks(markdown: Locator): Promise<void> {
  const directory = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
  const page = markdown.page();
  if (directory)
    await page.screenshot({
      path: `${directory}/link-references-${page.viewportSize()?.width}.png`,
    });
  for (const selector of [
    'a[id="cite_note-20"]',
    'a[name="cite_note-21"]',
    'a:has-text("Empty target")',
  ]) {
    const anchor = markdown.locator(selector);
    expect(await anchor.count()).toBe(1);
    expect(await anchor.getAttribute("class")).toBeNull();
    expect(
      await anchor.evaluate((element: any) =>
        element.nextElementSibling?.classList.contains("artifact-link-host"),
      ),
    ).not.toBeTrue();
  }
  await assertSchemeLinks(markdown);
  for (const name of [
    "doi",
    "10.1038/s41586-023-06720-2",
    "Nature",
    "doi.org",
    "https://doi.org/",
  ]) {
    const link = markdown.getByRole("link", { name, exact: true });
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(await link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(
      await link.evaluate((element: any) =>
        element.nextElementSibling?.classList.contains("artifact-link-host"),
      ),
    ).not.toBeTrue();
  }
  for (const [name, href] of [
    ["https://good.example", "https://evil.example/"],
    ["good.example/path", "https://evil.example/"],
    ["https://good.example/relative", "//evil.example/"],
    ["https://good.example/credentials", "https://user@evil.example/"],
  ]) {
    const link = markdown.getByRole("link", { name, exact: true });
    expect(await link.getAttribute("href")).toBe(href);
    expect(
      await link.evaluate(
        (element: any) => element.nextElementSibling?.textContent,
      ),
    ).toBe(" (evil.example)");
  }
  expect(await markdown.locator(".artifact-link-host").count()).toBe(7);
  for (const target of ["cite_note-20", "cite_note-21"]) {
    expect(await markdown.locator(`a[href="#${target}"]`).count()).toBe(1);
    expect(
      await markdown.locator(`a[id="${target}"], a[name="${target}"]`).count(),
    ).toBe(1);
  }
}
