import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { waitForPaneTransition } from "./pane_layout";
import { complexHtml } from "./fixtures/html_preview";

export async function openExplorer(page: Page, width: number): Promise<void> {
  const selector = '.pane-col[data-pane="explorer"]';
  if (!(await page.locator(selector).isVisible())) {
    if (width === 412) {
      await page.locator("#pane-fab").click();
      await page.locator('.pane-menu-item[data-pane="explorer"]').click();
    } else await page.locator('.rail-btn[data-pane="explorer"]').click();
  }
  await waitForPaneTransition(page, selector);
}

export async function seedExplorerWorkspace(
  temporary: string,
  probe: string,
  hintOrigin: string,
) {
  const root = join(temporary, "workspace".repeat(15), "workspace".repeat(15));
  await mkdir(join(root, "src"), { recursive: true });
  expect(root.length).toBeGreaterThan(256);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  const source =
    "export function application() {\n  return 'Read-only file preview';\n}\n".repeat(
      500,
    );
  await writeFile(join(root, "src", "application.ts"), source);
  const htmlSource = `<!doctype html><html><head>
<link rel="preconnect" href="${hintOrigin}">
<style>h1 { color: #156fa1; } #series { display: flex; gap: 1em; }</style></head><body>
<h1>Explorer HTML preview</h1>
<div id="series"><div>Revenue</div><div>Costs</div></div>
<p id="summary">Offline file content</p>
<img src="${probe}image.png">
<iframe title="Nested preview" src="${probe}frame.html"></iframe>
<form action="${probe}form"><button type="submit">Submit fixture</button></form>
<script>
const summary = document.getElementById('summary');
summary.textContent = 'Chart data prepared';
try { summary.dataset.parent = parent.document.title; }
catch { summary.dataset.parent = 'blocked'; }
document.forms[0].querySelector('button').onclick = () => { summary.dataset.formAttempt = 'done'; };
</script>
${`<!-- ${"Complete file, not only its first chunk. ".repeat(430)} -->`}
<p>End of file</p></body></html>`;
  const htmlPath = join(root, "src", "page.html");
  await writeFile(htmlPath, htmlSource);
  const complexPath = "src/z-complex.html";
  const complex = complexHtml(hintOrigin);
  await writeFile(join(root, complexPath), complex);
  const pickedPath = "src/pick `quoted`.ts";
  await writeFile(join(root, pickedPath), "export const picked = true;\n");
  await writeFile(
    join(root, "src", "😀app-types.ts"),
    "export type Application = { name: string };\n",
  );
  await writeFile(join(root, ".env"), "fixture only\n");
  await mkdir(join(root, "node_modules"));
  await writeFile(
    join(root, "node_modules", "application-ignored.ts"),
    "ignored\n",
  );
  await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      writeFile(join(root, `notes-${i}.md`), `# Note ${i}\n`),
    ),
  );
  const otherRoot = join(root, "other");
  await mkdir(otherRoot);
  await writeFile(join(otherRoot, "only-here.txt"), "Other conversation\n");
  expect(
    await Bun.spawn(["git", "init", "-q", root], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited,
  ).toBe(0);
  return {
    root,
    otherRoot,
    pickedPath,
    source,
    htmlPath,
    htmlSource,
    complexPath,
    complex,
  };
}

export function editExplorerHtml(htmlSource: string): string {
  return htmlSource.replace(
    "<p>End of file",
    "<p>Changed between reads</p><p>End of file",
  );
}
