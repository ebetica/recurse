import { expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { filesSurface, openListedFile, showFilesList } from "./files_support";
import type { Locator, Request } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  drainedServerLog,
  dispatchArtifactSelection,
  postFixture,
  type BrowserTest,
} from "./common";

async function completed(base: string, agent: string) {
  await browserExpect
    .poll(
      async () =>
        (await postFixture(base, "file-edit-captures", { agent })).running,
    )
    .toBe(false);
  return postFixture(base, "file-edit-captures", { agent });
}

async function filesContaining(
  root: string,
  needle: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path).catch(() => Buffer.alloc(0))).includes(needle))
      found.push(path);
  }
  return found;
}

async function edgesHit(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [
      [box.left + 8, box.top + 8],
      [box.right - 8, box.top + 8],
      [box.left + 8, box.bottom - 8],
      [box.right - 8, box.bottom - 8],
    ].every(([x, y]) =>
      element.contains(element.ownerDocument.elementFromPoint(x!, y!)),
    );
  });
}

async function pathEndsHit(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    let text = element.querySelector("bdi")!.firstChild!;
    while (text.nodeType !== element.TEXT_NODE) text = text.nextSibling!;
    return [0, text.textContent!.length - 1].every((index) => {
      const range = element.ownerDocument.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const box = range.getBoundingClientRect();
      return element.contains(
        element.ownerDocument.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    });
  });
}

export const tests: BrowserTest[] = [
  // Regression: #3391 read-only source viewers share safe syntax tokens without changing file text.
  async function test_source_file_viewers_highlight_without_interpreting_html(
    browser,
    base,
    data,
  ) {
    const workdir = await mkdtemp(join(data, "data", "source-preview-"));
    const source = `import { readFile } from "node:fs/promises";

export async function loadConfiguration(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  const html = '<img src=x onerror="globalThis.sourcePreviewRan = true">';
  return text || html;
}
`;
    await writeFile(join(workdir, "configuration.ts"), source);
    const shots = join(
      process.env.RECURSE_AGENT_TMPDIR || tmpdir(),
      "shots",
      "source-preview",
    );
    await mkdir(shots, { recursive: true });
    for (const width of [412, 1280]) {
      const fixture = await postFixture(base, "seed-file-edit", {
        agent: `source-preview-${width}`,
        workdir,
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      let releaseSyntax!: () => void;
      const syntaxGate = new Promise<void>((resolve) => {
        releaseSyntax = resolve;
      });
      try {
        const page = await context.newPage();
        await page.route(
          "**/static/document-preview.worker.js",
          async (route) => {
            await syntaxGate;
            await route.continue();
          },
        );
        await page.goto(`${base}#agent=${fixture.agent}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .locator("#input:enabled")
          .fill(`Reply only Open ${join(workdir, "configuration.ts")}`);
        await page.locator("#send").click();
        await page.locator(".msg.assistant a[data-file-path]").last().click();
        const code = page.locator(".explorer-source code");
        await browserExpect(code).toHaveText(source);
        await browserExpect(code).toHaveAttribute(
          "data-source-syntax",
          "loading",
        );
        await code.evaluate((element) => {
          const selection = element.ownerDocument.getSelection()!;
          const range = element.ownerDocument.createRange();
          const start = element.textContent!.indexOf("return");
          range.setStart(element.firstChild!, start);
          range.setEnd(element.firstChild!, start + "return".length);
          selection.removeAllRanges();
          selection.addRange(range);
        });
        releaseSyntax();
        await browserExpect(code).toHaveAttribute(
          "data-source-syntax",
          "plain",
        );
        expect(
          await code.evaluate((element) =>
            element.ownerDocument.getSelection()!.toString(),
          ),
        ).toBe("return");
        await code.evaluate((element) =>
          element.ownerDocument.getSelection()!.removeAllRanges(),
        );
        const initialComment = page.locator(
          ".report-comment-popover:not([hidden])",
        );
        await initialComment
          .locator("textarea")
          .fill("Keep this source text literal.");
        await initialComment
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        const initialCard = page.locator(".report-comment");
        await initialCard.waitFor();
        await browserExpect(initialCard.locator("blockquote")).toHaveText(
          "return",
        );
        await browserExpect(initialCard.locator("textarea")).toHaveValue(
          "Keep this source text literal.",
        );
        await page.locator(".report-sendbar-clear:visible").click();
        await code.locator(".hljs-keyword").first().waitFor();
        await page.screenshot({ path: join(shots, `after-${width}.png`) });
        expect(await code.locator("img").count()).toBe(0);
        expect(
          await page.evaluate(() => (globalThis as any).sourcePreviewRan),
        ).toBeUndefined();
        await browserExpect(code).toHaveText(source);
        if (width === 412) {
          await page.goBack();
          await page.locator("#pane-fab").click();
          await page.locator('.pane-menu-item[data-pane="explorer"]').click();
        } else await page.locator('.rail-btn[data-pane="explorer"]').click();
        await page
          .locator('.explorer-row[data-path="configuration.ts"]')
          .click();
        await page.locator(".explorer-source .hljs-keyword").first().waitFor();
        await dispatchArtifactSelection(
          page,
          width === 412 ? "touch" : "mouse",
          "return text || html;",
          page.locator(".explorer-source"),
        );
        const popover = page.locator(".report-comment-popover:not([hidden])");
        await popover.locator("textarea").fill("Explain the return value.");
        await popover
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        expect(
          (
            await page
              .locator(".explorer-source mark.report-cmark")
              .allTextContents()
          ).join(""),
        ).toBe("return text || html;");
        await browserExpect(page.locator(".explorer-source")).toHaveText(
          source,
        );
        await page.locator(".report-sendbar-send:visible").click();
        await browserExpect(
          page.locator(".explorer-source mark.report-cmark"),
        ).toHaveCount(0);
        await completed(base, fixture.agent);
        await page.goto(`${base}#agent=${fixture.agent}`, {
          waitUntil: "domcontentloaded",
        });
        await postFixture(base, "publish-source-previews", {
          agent: fixture.agent,
          text: source,
        });
        await page
          .getByRole("button", {
            name: "Open configuration.ts in Files",
            exact: true,
          })
          .click();
        const published = filesSurface(page).locator(".files-source");
        await published.locator(".hljs-keyword").first().waitFor();
        await browserExpect(published).toHaveText(source);
        expect(await published.locator("img").count()).toBe(0);
        for (const name of ["configuration.txt", "large.ts"]) {
          await showFilesList(page);
          await openListedFile(page, name);
          const plain = filesSurface(page).locator(
            '.files-source[data-source-syntax="plain"]',
          );
          await plain.waitFor();
          await browserExpect(plain).toHaveText(
            name === "large.ts"
              ? "export const value = 1;\n".repeat(2001)
              : source,
          );
          expect(await plain.locator(".source-token, img").count()).toBe(0);
        }
        const store = {
          artifactsDir: join(data, "data", "artifact_repos"),
          trashDir: join(data, "data", "trash"),
        };
        const artifact = await artifacts.create(store, {
          owner: fixture.agent,
          title: "Source files",
        });
        await writeFile(
          join(String(artifact.repo_path), "index.md"),
          "[Source](configuration.ts)\n\n[XML](configuration.xml)\n",
        );
        await writeFile(
          join(String(artifact.repo_path), "configuration.ts"),
          source,
        );
        await writeFile(
          join(String(artifact.repo_path), "configuration.xml"),
          '<item attr="value">literal text</item>\n',
        );
        await artifacts.publish(store, fixture.agent, String(artifact.id));
        await page.goto(
          `${base}#agent=${fixture.agent}&artifact=${artifact.id}`,
        );
        await page.getByRole("link", { name: "Source", exact: true }).click();
        const sibling = page.locator(".file-tab:visible .report-doc pre");
        await sibling.locator(".hljs-keyword").first().waitFor();
        await browserExpect(sibling).toHaveText(source);
        expect(await sibling.locator("img").count()).toBe(0);
        if (width === 412) await page.goBack();
        else await page.locator('.dv-tab[data-dock-panel="report"]').click();
        await page.getByRole("link", { name: "XML", exact: true }).click();
        const xml = page.locator(".file-tab:visible .report-doc pre");
        await xml.locator(".hljs-tag .hljs-string").first().waitFor();
        await xml.locator(".hljs-tag .hljs-attr").first().waitFor();
        await browserExpect(xml).toHaveText(
          '<item attr="value">literal text</item>\n',
        );
        expect(await xml.locator("item").count()).toBe(0);
      } finally {
        releaseSyntax();
        await context.close();
      }
    }
  },
  // Feature: #3384 reply file paths open an editor; saves stay unseen.
  async function test_reply_file_paths_open_an_editor_that_saves_to_disk(
    browser,
    base,
    data,
    serverPid,
  ) {
    const temporary = await mkdtemp(join(data, "data", "browser-file-edit-"));
    const shots = join(
      process.env.RECURSE_AGENT_TMPDIR || tmpdir(),
      "shots",
      "file-edit",
    );
    await mkdir(shots, { recursive: true });
    for (const width of [1280, 412]) {
      const workdir = join(temporary, `project-${width}`);
      const secrets = join(temporary, `secrets-${width}`);
      await mkdir(workdir, { recursive: true });
      await mkdir(secrets);
      await writeFile(join(workdir, "config.txt"), "mode = draft\n");
      const target = join(secrets, ".env");
      const secret = `sk-browser-secret-${width}-${crypto.randomUUID()}`;
      const marker = `file-edit-sent-marker-${crypto.randomUUID()}`;
      const fixture = await postFixture(base, "seed-file-edit", {
        agent: `file-edit-${width}`,
        workdir,
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const browserRequests: Array<Promise<string>> = [];
      const captureRequest = (request: Request) => {
        const url = new URL(request.url());
        if (
          request.method() === "PUT" &&
          url.pathname === `/api/conversations/${fixture.agent}/tree/file` &&
          url.searchParams.get("path") === target
        )
          return;
        browserRequests.push(
          request.allHeaders().then((headers) =>
            JSON.stringify({
              method: request.method(),
              url: request.url(),
              headers,
              body: request.postData(),
            }),
          ),
        );
      };
      page.on("request", captureRequest);
      try {
        await page.goto(`${base}#agent=${fixture.agent}`, {
          waitUntil: "domcontentloaded",
        });
        const input = page.locator("#input:enabled");
        await input.fill(
          `Reply only Please paste the API key into ${target} and check config.txt then tell me. ${marker}`,
        );
        await page.locator("#send").click();
        const reply = page.locator(".msg.assistant .content").last();
        const link = reply.locator(`a[data-file-path="${target}"]`);
        await link.waitFor();
        await browserExpect(reply).toContainText(marker);
        await completed(base, fixture.agent);
        expect(
          await reply.locator('a[data-file-path="config.txt"]').count(),
        ).toBe(0);
        await page.screenshot({ path: join(shots, `${width}-reply.png`) });
        await link.click();
        const view = page.locator(".pane-col.file-tab .explorer").last();
        await view.getByText("This file doesn’t exist yet.").waitFor();
        await page.screenshot({ path: join(shots, `${width}-missing.png`) });
        await view.getByRole("button", { name: "Create file" }).click();
        const editor = view.getByRole("textbox", { name: "File text" });
        await editor.fill(`API_KEY=${secret}\n`);
        const save = view.getByRole("button", { name: "Save" });
        await page.screenshot({ path: join(shots, `${width}-editing.png`) });
        if (width === 412) expect(await edgesHit(save)).toBe(true);
        await save.click();
        await view.getByText("Saved.").waitFor();
        expect(await readFile(target, "utf8")).toBe(`API_KEY=${secret}\n`);
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        await view.locator(".explorer-source", { hasText: secret }).waitFor();
        await view.getByRole("button", { name: "Edit" }).click();
        await editor.fill(`API_KEY=${secret}-rotated\n`);
        await writeFile(target, "CHANGED_ELSEWHERE=1\n");
        await save.click();
        await view
          .getByText("The file changed on disk since you opened it.")
          .waitFor();
        await page.screenshot({ path: join(shots, `${width}-conflict.png`) });
        await view.getByRole("button", { name: "Overwrite" }).click();
        await view.getByText("Saved.").waitFor();
        expect(await readFile(target, "utf8")).toBe(
          `API_KEY=${secret}-rotated\n`,
        );
        if (width === 1280) await page.keyboard.press("i");
        else await page.goBack();
        await input.fill("Reply only Thanks, the key is in place.");
        await page.locator("#send").click();
        await page
          .locator(".msg.assistant .content", { hasText: "key is in place" })
          .waitFor();
        expect(
          await page.getByText(`I edited ${target}`, { exact: true }).count(),
        ).toBe(2);
        const observed = await completed(base, fixture.agent);
        expect(observed.providerRequests.length).toBeGreaterThan(0);
        for (const request of observed.providerRequests) {
          expect(request).toContain(marker);
          expect(request).not.toContain(secret);
        }
        expect(observed.capture).toContain(marker);
        expect(observed.capture).not.toContain(secret);
        const network = (await Promise.all(browserRequests)).join("\n");
        expect(network).toContain(marker);
        expect(network).not.toContain(secret);
        const log = await drainedServerLog(base, serverPid);
        expect(log).toContain("browser-log-barrier-");
        expect(log).not.toContain(secret);
        expect(await filesContaining(data, secret)).toEqual([target]);
      } finally {
        page.off("request", captureRequest);
        await Promise.all(browserRequests);
        await context.close();
      }
    }
    console.log(`File editor screenshots: ${shots}`);
  },
  // Regression: #3384 canonical destinations and prompt warnings precede edits; changed symlinks cannot redirect saves.
  async function test_file_editor_canonical_aliases_changed_links_and_prompt_warning(
    browser,
    base,
    data,
  ) {
    const root = await mkdtemp(join(data, "data", "canonical-file-edit-"));
    const workdir = join(root, "project");
    const other = join(root, "other");
    await mkdir(workdir);
    await mkdir(other);
    const canonical = join(workdir, "innocent.txt");
    const instructions = join(workdir, "AGENTS.md");
    const bidiPath = join(workdir, "innocent\u202etxt");
    await writeFile(canonical, "innocent original\n");
    await writeFile(bidiPath, "unambiguous text\n");
    await writeFile(join(other, "innocent.txt"), "other original\n");
    await writeFile(instructions, "Use the project conventions.\n");
    const fileAlias = join(root, "innocent-alias.txt");
    const directoryAlias = join(root, "folder-alias");
    await symlink(canonical, fileAlias);
    await symlink(workdir, directoryAlias);
    const directoryFile = join(directoryAlias, "innocent.txt");
    const shots = join(
      process.env.RECURSE_AGENT_TMPDIR || tmpdir(),
      "shots",
      "file-edit",
    );
    await mkdir(shots, { recursive: true });
    for (const width of [1280, 412]) {
      const fixture = await postFixture(base, "seed-file-edit", {
        agent: `canonical-file-edit-${width}`,
        workdir,
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        const page = await context.newPage();
        await page.goto(`${base}#agent=${fixture.agent}`);
        await page
          .locator("#input:enabled")
          .fill(
            `Reply only Open ${canonical} and ${fileAlias} and ${directoryFile} and ${instructions} and ${bidiPath}`,
          );
        await page.locator("#send").click();
        const reply = page.locator(".msg.assistant .content").last();
        await reply.locator(`a[data-file-path="${instructions}"]`).waitFor();
        await completed(base, fixture.agent);
        for (const requested of [canonical, fileAlias, directoryFile]) {
          await reply.locator(`a[data-file-path="${requested}"]`).click();
          const view = page.locator(".explorer:visible").last();
          const header = view.locator(".explorer-filename");
          await browserExpect(header).toHaveText(canonical);
          await browserExpect(header).toHaveAttribute("title", canonical);
          if (requested !== canonical)
            await view
              .getByText(`Opens ${requested} → saves to ${canonical}`, {
                exact: true,
              })
              .waitFor();
          await view.getByRole("button", { name: "Edit", exact: true }).click();
          await view.getByRole("textbox", { name: "File text" }).waitFor();
          await browserExpect.poll(() => pathEndsHit(header)).toBe(true);
          await page.screenshot({
            path: join(
              shots,
              `${width}-${requested === canonical ? "canonical" : requested === fileAlias ? "file-alias" : "directory-alias"}.png`,
            ),
          });
          if (requested === directoryFile) {
            await view
              .getByRole("textbox", { name: "File text" })
              .fill("must not be redirected\n");
            await unlink(directoryAlias);
            await symlink(other, directoryAlias);
            try {
              const saved = page.waitForResponse(
                (response) =>
                  response.request().method() === "PUT" &&
                  new URL(response.url()).pathname.endsWith("/tree/file"),
              );
              await view
                .getByRole("button", { name: "Save", exact: true })
                .click();
              const response = await saved;
              expect(
                new URL(response.url()).searchParams.get("canonicalPath"),
              ).toBe(canonical);
              expect(response.status()).toBe(409);
              await browserExpect(view.getByRole("alert")).toContainText(
                /changed|reopen/i,
              );
              await browserExpect(
                view.getByRole("button", { name: "Overwrite", exact: true }),
              ).toHaveCount(0);
              expect(await readFile(canonical, "utf8")).toBe(
                "innocent original\n",
              );
              expect(await readFile(join(other, "innocent.txt"), "utf8")).toBe(
                "other original\n",
              );
              await page.screenshot({
                path: join(shots, `${width}-changed-link.png`),
              });
            } finally {
              await unlink(directoryAlias);
              await symlink(workdir, directoryAlias);
            }
          }
          await view
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          if (width === 1280) await page.keyboard.press("i");
          else await page.goBack();
        }
        await browserExpect(reply).toContainText(bidiPath);
        await browserExpect(
          reply.locator(`a[data-file-path="${bidiPath}"]`),
        ).toHaveCount(0);
        await reply.locator(`a[data-file-path="${instructions}"]`).click();
        const view = page.locator(".explorer:visible").last();
        await browserExpect(view.locator(".explorer-filename")).toHaveText(
          instructions,
        );
        await view.getByText(/contents.*sent to.*model/i).waitFor();
        await view.getByRole("button", { name: "Edit", exact: true }).click();
        await view.getByText(/contents.*sent to.*model/i).waitFor();
        await page.screenshot({
          path: join(shots, `${width}-prompt-warning.png`),
        });
      } finally {
        await context.close();
      }
    }
    console.log(`Canonical file editor screenshots: ${shots}`);
  },
  // Regression: #3384 requested and canonical Markdown names warn before creation or editing.
  async function test_missing_markdown_warns_before_creation(
    browser,
    base,
    data,
  ) {
    const workdir = await mkdtemp(join(data, "data", "missing-prompt-edit-"));
    await mkdir(join(workdir, "docs"));
    const imported = join(workdir, "docs", "new.md");
    const unrelated = join(workdir, "NOTES.Md");
    const alias = join(workdir, "notes.MD");
    const trailing = join(workdir, "x.markdown.");
    await writeFile(join(workdir, "private.txt"), "safe original\n");
    await symlink(join(workdir, "private.txt"), alias);
    await writeFile(trailing, "safe original\n");
    await writeFile(join(workdir, "AGENTS.md"), "@docs/new.md\n");
    for (const width of [1280, 412]) {
      const fixture = await postFixture(base, "seed-file-edit", {
        agent: `missing-prompt-edit-${width}`,
        workdir,
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        const page = await context.newPage();
        await page.goto(`${base}#agent=${fixture.agent}`);
        await page
          .locator("#input:enabled")
          .fill(
            `Reply only Open \`${imported}\` and \`${unrelated}\` and \`${alias}\` and \`${trailing}\``,
          );
        await page.locator("#send").click();
        const reply = page.locator(".msg.assistant .content").last();
        await completed(base, fixture.agent);
        for (const path of [imported, unrelated, alias, trailing]) {
          await reply.locator(`a[data-file-path="${path}"]`).click();
          const view = page.locator(".explorer:visible").last();
          const missing = path === imported || path === unrelated;
          if (missing)
            await view.getByText("This file doesn’t exist yet.").waitFor();
          await browserExpect(view.getByRole("note")).toHaveText(
            "This file’s contents are sent to the model. Don’t save secrets here.",
          );
          await view
            .getByRole("button", {
              name: missing ? "Create file" : "Edit",
              exact: true,
            })
            .click();
          await view.getByRole("textbox", { name: "File text" }).waitFor();
          const header = view.locator(".explorer-filename");
          await browserExpect(header).toHaveText(
            path === alias ? join(workdir, "private.txt") : path,
          );
          await browserExpect.poll(() => pathEndsHit(header)).toBe(true);
          await browserExpect(view.getByRole("note")).toHaveText(
            "This file’s contents are sent to the model. Don’t save secrets here.",
          );
          await view
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          if (width === 1280) await page.keyboard.press("i");
          else await page.goBack();
        }
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #3384 canonical destinations visibly escape control and invisible characters without changing the real path.
  async function test_canonical_path_controls_are_visibly_escaped(
    browser,
    base,
    data,
  ) {
    const workdir = await mkdtemp(join(data, "data", "escaped-path-edit-"));
    const target = join(workdir, "innocent\u202Ename\n\u2028\u034F.env");
    const alias = join(workdir, "innocent-alias.txt");
    const shown = target
      .replace("\u202E", "\\u202E")
      .replace("\n", "\\u000A")
      .replace("\u2028", "\\u2028")
      .replace("\u034F", "\\u034F");
    await writeFile(target, "safe original\n");
    await symlink(target, alias);
    for (const width of [1280, 412]) {
      const fixture = await postFixture(base, "seed-file-edit", {
        agent: `escaped-path-edit-${width}`,
        workdir,
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        const page = await context.newPage();
        await page.goto(`${base}#agent=${fixture.agent}`);
        await page.locator("#input:enabled").fill(`Reply only Open ${alias}`);
        await page.locator("#send").click();
        await completed(base, fixture.agent);
        await page
          .locator(`.msg.assistant a[data-file-path="${alias}"]`)
          .click();
        const view = page.locator(".explorer:visible").last();
        const header = view.locator(".explorer-filename");
        await browserExpect(header).toHaveText(shown);
        await browserExpect(header).toHaveAttribute("title", shown);
        await browserExpect(view.locator(".explorer-alias")).toHaveText(
          `Opens ${alias} → saves to ${shown}`,
        );
        await view.getByRole("button", { name: "Edit", exact: true }).click();
        await browserExpect.poll(() => pathEndsHit(header)).toBe(true);
        await view
          .getByRole("textbox", { name: "File text" })
          .fill("safe changed\n");
        await view.getByRole("button", { name: "Save", exact: true }).click();
        await view.getByText("Saved.", { exact: true }).waitFor();
        expect(await readFile(target, "utf8")).toBe("safe changed\n");
      } finally {
        await context.close();
      }
    }
  },
];
