import { REFERENCE_LINKS } from "../../fixtures/reference_links";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { blobName } from "../../../../src/agents/runtime/attachments/store";
import { CHECKOUT_ROOT } from "../../../../src/build_dir";
import { type Fixture, type Routes, hex, nowSeconds } from "../fixture";

const wideMermaid = () =>
  Bun.file(join(import.meta.dir, "../../fixtures/wide_mermaid.md")).text();

export function routes(fx: Fixture): Routes {
  const { load, save, rootAgentId, once } = fx;
  const { instance } = fx;
  const { agentTemp } = instance;
  const {
    script,
    create,
    hold,
    release,
    submitDurable,
    helperApplyClear,
    appendNative,
    publishFiles,
    publishedId,
  } = fx.agents;
  const { user, seedHistory, seedUpload } = fx.history;
  const {
    PNG_1X1,
    NAVIGATION_IMAGES,
    navigationPng,
    rectanglePdf,
    japanesePdf,
    silentWav,
  } = fx.media;
  let autoOpenDraft = 0;
  const files = () =>
    once("seed-files-pane", async () => {
      await once({ agent: "files-empty" }, () =>
        create("files-empty", "Files empty agent", rootAgentId()),
      );
      await once({ agent: "files-demo" }, () =>
        create("files-demo", "Files demo agent", rootAgentId()),
      );
      const enc = new TextEncoder();
      const text = await seedUpload(
        "files-demo",
        enc.encode(
          `bounded browser text preview\nbounded again\n${"Notes on the browser preview. ".repeat(23).trim()}\n`,
        ),
        "browser-notes.txt",
      );
      const image = await seedUpload(
        "files-demo",
        PNG_1X1,
        "browser-image.png",
      );
      const emptyText = await seedUpload(
        "files-empty",
        enc.encode("empty agent first durable file\n"),
        "empty-agent.txt",
      );
      const conv = load("files-demo")!;
      conv.settled_attachment_ids = [text.id, image.id];
      await save(conv);
      await seedHistory(
        conv.id,
        [
          user(
            "Browser files source message\n" +
              `[browser-notes.txt](/api/conversations/files-demo/attachments/${text.id})\n` +
              `![browser-image.png](/api/conversations/files-demo/attachments/${image.id})`,
          ),
        ],
        { replace: true },
      );
      return {
        text: text.id,
        image: image.id,
        empty_text: emptyText.id,
        demo: "files-demo",
        empty: "files-empty",
      };
    });
  const published = (linked = false) =>
    once(
      linked ? "seed-linked-markdown" : "seed-published-markdown",
      async () => {
        const cid = linked ? "files-linked-markdown" : "files-published";
        await once({ agent: cid }, () =>
          create(cid, "Published files", rootAgentId()),
        );
        const directory = await mkdtemp(join(tmpdir(), "markdown-images-"));
        await publishFiles(
          cid,
          {
            ...(linked
              ? {
                  "architecture.md":
                    "# Files architecture\n\nSibling Files document.\n\n## Details\n\nPublished details.\n",
                }
              : {}),
            "diagram.svg":
              '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="400"><rect width="160" height="400" fill="teal"/><text x="12" y="40" fill="white">Shared image</text></svg>',
          },
          { directory },
        );
        const imagePath = join(directory, "path-image.svg");
        await writeFile(
          imagePath,
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="teal"/><text x="66" y="88" fill="white" font-size="24">Document image</text></svg>',
        );
        const id = await publishedId(
          cid,
          await publishFiles(
            cid,
            {
              "report.md":
                `# Weekly report\n\n${REFERENCE_LINKS}\n` +
                (linked ? "\n[Architecture](architecture.md#details)\n" : "") +
                '- shipped **previews**\n\n```mermaid\ngraph LR\n A[Files] --> B[Artifacts]\n```\n\nInline \\(x^2\\) and display math:\n\n\\[E = mc^2\\]\n\n![Local diagram](./diagram.svg)\n\n| Wide table | Value |\n| --- | --- |\n| WideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumnWideColumn | readable |\n\n<img src="https://example.com/x.png" alt="remote">\n<button class="external-image" data-external-image="https://example.invalid/tracker.png" data-image-alt="spoof">Expand details</button>\n' +
                `\n![Absolute path](${imagePath})\n\n![Unpublished relative path](./path-image.svg)\n`,
            },
            { directory },
          ),
        );
        const collection = await agentTemp.ensureUploadsDir(
          String(load(cid)!.tmp_key),
        );
        return {
          demo: cid,
          id,
          payload: join(collection, blobName(id)),
        };
      },
    );
  const mediaFiles = () =>
    once("seed-published-media", async () => {
      const cid = "files-published-media";
      await once({ agent: cid }, () =>
        create(cid, "Published media", rootAgentId()),
      );
      await publishFiles(cid, {
        "chart.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>',
      });
      await publishFiles(cid, { "tone.wav": silentWav() });
      await publishFiles(cid, { "clip.webm": "not a real video" });
      await publishFiles(cid, {
        "pixel.png": PNG_1X1,
        Makefile: "all:\n",
        ".env": "MODE=test\n",
      });
      return { demo: cid };
    });
  const pdf = () =>
    once("seed-published-pdf", async () => {
      const cid = "files-published-pdf";
      await once({ agent: cid }, () =>
        create(cid, "Published PDF", rootAgentId()),
      );
      await publishFiles(cid, { "slides.pdf": rectanglePdf(2) });
      await publishFiles(cid, { "broken.pdf": "not a PDF" });
      await publishFiles(cid, { "notes-ja.pdf": japanesePdf() });
      await publishFiles(cid, { "long.pdf": rectanglePdf(16) });
      return { demo: cid };
    });
  const images = () =>
    once("seed-image-navigation", async () => {
      const cid = "files-image-navigation";
      await once({ agent: cid }, () =>
        create(cid, "Files image navigation", rootAgentId()),
      );
      const names = ["nav-1.png", "nav-2.png", "nav-3.png"];
      const images = [];
      for (const [index, name] of names.entries())
        images.push(await seedUpload(cid, NAVIGATION_IMAGES[index], name));
      const conv = load(cid)!;
      conv.settled_attachment_ids = images.map((image) => image.id);
      await save(conv);
      await seedHistory(
        cid,
        [
          user(
            images
              .map(
                (image, index) =>
                  `![${names[index]}](/api/conversations/${cid}/attachments/${image.id})`,
              )
              .join("\n"),
          ),
        ],
        { replace: true },
      );
      return {
        demo: cid,
        image_ids: images.map((image) => image.id),
      };
    });
  return {
    "seed-files-pane": files,
    "seed-theme-surfaces": async () => {
      const cid = "theme-surfaces";
      await once({ agent: cid }, () =>
        create(cid, "Theme surfaces", rootAgentId()),
      );
      await seedHistory(
        cid,
        [
          user("Show a diagram and a long explanation."),
          fauxAssistantMessage(
            "```mermaid\ngraph LR\n A[Operator] --> B[Agent]\n B --> C[Result]\n```\n\n" +
              "**Readable text** with a [link](https://example.com) and inline `code`.\n\n".repeat(
                40,
              ),
          ),
        ],
        { replace: true },
      );
      return { demo: cid };
    },
    "publish-source-previews": async (body) => {
      const { agent, text } = body as { agent: string; text: string };
      await publishFiles(agent, {
        "configuration.ts": text,
        "configuration.txt": text,
        "large.ts": "export const value = 1;\n".repeat(2001),
      });
      return {};
    },
    "seed-html-files": async (body) => {
      const { html, fallbackFiles } = body as {
        html: string;
        fallbackFiles: Record<string, string>;
      };
      const cid = "html-files";
      await once({ agent: cid }, async () => {
        await create(cid, "HTML files", rootAgentId());
        await seedUpload(cid, new TextEncoder().encode(html), "uploaded.htm");
        await publishFiles(cid, {
          "report.html": html,
          ...fallbackFiles,
          "large.html": `<h1>Large file</h1>${"<p>Large report paragraph.</p>\n".repeat(12_000)}`,
        });
      });
      return { demo: cid };
    },
    "seed-published-markdown": () => published(),
    "seed-linked-markdown": () => published(true),
    "seed-published-media": mediaFiles,
    "seed-published-sizes": async () => {
      const cid = "files-published-sizes";
      await once({ agent: cid }, async () => {
        await create(cid, "Published sizes", rootAgentId());
        await publishFiles(cid, { "small.bin": new Uint8Array(1024) });
        await publishFiles(cid, {
          "large.bin": new Uint8Array(5 * 1024 * 1024),
        });
      });
      return { demo: cid };
    },
    "seed-files-newest-first": async () => {
      const cid = "files-newest-first";
      await once({ agent: cid }, async () => {
        await create(cid, "Newest files first", rootAgentId());
        await publishFiles(cid, { "report.md": "# Original report\n" });
        await seedUpload(
          cid,
          new TextEncoder().encode("Uploaded notes\n"),
          "notes.txt",
        );
        await publishFiles(cid, { "summary.md": "# Summary\n" });
        await publishFiles(cid, {
          "report.md":
            "# Updated report\n\n" + "Report paragraph.\n\n".repeat(100),
        });
      });
      return { demo: cid };
    },
    "publish-document-review": async (body) => {
      const { agent, text } = body as { agent: string; text: string };
      await once({ agent }, () =>
        create(agent, "Document review", rootAgentId()),
      );
      await publishFiles(agent, { "plan.md": text });
      return {};
    },
    "seed-published-versions": async () => {
      const cid = "files-published-versions";
      await once({ agent: cid }, async () => {
        await create(cid, "Published versions", rootAgentId());
        for (const draft of [1, 2, 3])
          await publishFiles(cid, { "report.md": `# Draft ${draft}\n` });
      });
      return { demo: cid };
    },
    "seed-published-bash": async () => {
      const cid = "files-published-bash";
      await once({ agent: cid }, async () => {
        await create(cid, "Published drafts");
        await publishFiles(
          cid,
          {
            "plan.md": "# Plan\n",
            "notes.txt": "notes",
          },
          { reply: "Both drafts are published." },
        );
      });
      return { demo: cid };
    },
    "seed-posted-quadrants": async (_body, request) => {
      const cid = `files-quadrants-${hex(4)}`;
      await create(cid, "Published quadrant image");
      const cwd = await mkdtemp(join(tmpdir(), "published-quadrants-"));
      await writeFile(
        join(cwd, "quadrants.png"),
        new Uint8Array(await request.arrayBuffer()),
      );
      script(cid).setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("publish", {
              paths: [join(cwd, "quadrants.png")],
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Quadrants published."),
        (context) => {
          const user = context.messages.findLast(
            (message) => message.role === "user",
          );
          const parts = Array.isArray(user?.content) ? user.content : [];
          return fauxAssistantMessage(
            `Acknowledged. Images: ${parts.filter((part) => part.type === "image").length}`,
          );
        },
      ]);
      await submitDurable(cid, "Publish the quadrant image.");
      return { demo: cid };
    },
    "seed-document-previews": async () => {
      const cid = `document-previews-${hex(4)}`;
      await create(cid, "Document previews");
      const files: Record<string, Uint8Array> = {};
      const names = [
        "preview.docx",
        "preview.xlsx",
        "preview.xls",
        "preview.ods",
        "preview.csv",
        "preview.tsv",
        "preview.pptx",
        "preview.ipynb",
        "limits.xlsx",
        "limits.pptx",
        "limits.ipynb",
        "expanded.docx",
      ];
      for (const name of names)
        files[name] = new Uint8Array(
          await readFile(
            join(CHECKOUT_ROOT, "tests/mobile_browser/fixtures", name),
          ),
        );
      files["oversized.docx"] = new Uint8Array(8 * 1024 * 1024 + 1);
      files["expanded.csv"] = files["expanded.docx"]!;
      await publishFiles(cid, files, {
        reply:
          "Documents published.\n\n```python\nprint('Notebook output')\n```",
      });
      return { demo: cid };
    },
    "seed-posted-pdf": async (_body, request) => {
      const cid = "files-posted-pdf";
      await once({ agent: cid }, () =>
        create(cid, "Posted PDF", rootAgentId()),
      );
      const body = new Uint8Array(await request.arrayBuffer());
      await publishFiles(cid, { "report.pdf": body });
      return { demo: cid };
    },
    "seed-published-pdf": pdf,
    "seed-published-later": async () => {
      const cid = "files-published-later";
      await once({ agent: cid }, () =>
        create(cid, "Later published files", rootAgentId()),
      );
      await publishFiles(cid, { "first.md": "# First file\n" });
      return { demo: cid };
    },
    "publish-later-file": async () => {
      const cid = "files-published-later";
      const name = `later-${hex(6)}.md`;
      const id = await publishedId(
        cid,
        await publishFiles(cid, { [name]: `# ${name}\n` }),
      );
      return { name, id };
    },
    "seed-files-auto-open": async () => {
      const cid = "files-auto-open";
      await once({ agent: cid }, async () => {
        await create(cid, "Auto-opened files", rootAgentId());
        await publishFiles(cid, { "earlier.md": "# Earlier\n" });
      });
      return { demo: cid };
    },
    "republish-auto-open": async (body) => {
      const { gate } = (body ?? {}) as { gate?: string };
      autoOpenDraft += 1;
      await publishFiles(
        "files-auto-open",
        { "report.md": `# Draft ${autoOpenDraft}\n` },
        { beforePublish: gate ? hold("files-auto-open", gate) : undefined },
      );
      return { draft: autoOpenDraft };
    },
    "seed-jump-images": async () => {
      const cid = "jump-images";
      await once({ agent: cid }, async () => {
        await create(cid, "Jump images", rootAgentId());
        for (const [n, image] of NAVIGATION_IMAGES.entries())
          await publishFiles(cid, { [`photo-${n}.png`]: image });
        for (let n = 0; n < 30; n += 1)
          await publishFiles(cid, { [`${n}.md`]: `# ${n}` });
      });
      return { demo: cid };
    },
    "seed-published-image-navigation": async () => {
      const cid = "published-image-navigation";
      await once({ agent: cid }, async () => {
        await create(cid, "Published image navigation");
        await publishFiles(
          cid,
          Object.fromEntries(
            Array.from({ length: 5 }, (_, index) => [
              `published-${index + 1}.png`,
              NAVIGATION_IMAGES[index % NAVIGATION_IMAGES.length],
            ]),
          ),
          { reply: "Both drafts are published." },
        );
        await publishFiles(
          cid,
          { "next-reply.png": NAVIGATION_IMAGES[0] },
          { reply: "Both drafts are published." },
        );
        await publishFiles(
          cid,
          { "published-2.png": NAVIGATION_IMAGES[2] },
          { reply: "Both drafts are published." },
        );
        const upload = await seedUpload(
          cid,
          NAVIGATION_IMAGES[1],
          "operator.png",
        );
        script(cid).setResponses([
          fauxAssistantMessage("Operator image received."),
          fauxAssistantMessage("Acknowledged."),
        ]);
        await submitDurable(
          cid,
          `![operator.png](/api/conversations/${cid}/attachments/${upload.id})`,
        );
      });
      return { demo: cid };
    },
    "seed-large-image-gallery": async () => {
      const cid = "large-image-gallery";
      await once({ agent: cid }, async () => {
        await create(cid, "Large image gallery");
        await publishFiles(
          cid,
          Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [
              `gallery-${index + 1}.png`,
              NAVIGATION_IMAGES[index % NAVIGATION_IMAGES.length],
            ]),
          ),
          { reply: "Both drafts are published." },
        );
      });
      return { demo: cid };
    },
    "seed-large-photo": async () => {
      const cid = "large-photo";
      await once({ agent: cid }, async () => {
        await create(cid, "Large photo");
        await publishFiles(
          cid,
          {
            "photo.png": navigationPng([120, 90, 60], 1, true),
          },
          { reply: "Both drafts are published." },
        );
      });
      return { demo: cid };
    },
    "seed-image-navigation": images,
    "append-empty-file": async () => {
      const filesFixture = await files();
      const conv = load("files-empty")!;
      const content = `First durable file\n[empty-agent.txt](/api/conversations/files-empty/attachments/${filesFixture.empty_text})`;
      conv.settled_attachment_ids = [filesFixture.empty_text];
      await appendNative(conv, content, "File recorded.");
      await save(conv);
      return { ok: true };
    },
    "remove-empty-file": async () => {
      if (!(await helperApplyClear("files-empty")))
        throw new Error("clear did not land");
      return { ok: true };
    },
    "append-files-message": async (body) => {
      const filesFixture = await files();
      const conv = load("files-demo")!;
      const { start } = body as { start: boolean };
      const content =
        "Browser files source message\n" +
        `[browser-notes.txt](/api/attachments/${filesFixture.text})\n` +
        `![browser-image.png](/api/attachments/${filesFixture.image})`;
      const held = hold(conv.id);
      const started = Promise.withResolvers<void>();
      script(conv.id).setResponses([
        fauxAssistantMessage(
          [
            fauxText("Files recorded."),
            fauxToolCall("bash", { command: "true" }),
          ],
          { stopReason: "toolUse" },
        ),
        async () => {
          started.resolve();
          await held;
          return fauxAssistantMessage("Files turn finished.");
        },
      ]);
      await instance.delivery.deliver(conv.id, content, { origin: "operator" });
      if (!start) await release(conv.id);
      await started.promise;
      await save({ ...load(conv.id)!, updated: nowSeconds() });
      return { ok: true };
    },
    "seed-mermaid-reply": async () => {
      const agent = `mermaid-reply-${hex(4)}`;
      await create(agent, "Diagram walkthrough");
      script(agent).setResponses([fauxAssistantMessage(await wideMermaid())]);
      return { agent };
    },
    "seed-published-diff": async () => {
      const agent = "published-diff";
      await once({ agent }, async () => {
        await create(agent, "Published diff");
        const cwd = await mkdtemp(join(tmpdir(), "published-diff-"));
        await writeFile(
          join(cwd, "old.py"),
          'def report():\n    return "old report with a sufficiently long description"\n'.repeat(
            650,
          ),
        );
        await writeFile(
          join(cwd, "new.py"),
          'def report():\n    return "new report with a sufficiently long description"\n'.repeat(
            650,
          ),
        );
        script(agent).setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: `cd ${JSON.stringify(cwd)}; printf '%s\\n' '-- old' > before.txt; printf '%s\\n' '++ new' > after.txt; git diff --no-index -- before.txt after.txt > review.diff; git diff --no-index -- old.py new.py >> review.diff; cp review.diff review.patch; cp review.diff review.txt`,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            [
              fauxToolCall("publish", {
                paths: ["review.diff", "review.patch", "review.txt"].map(
                  (name) => join(cwd, name),
                ),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("The Python diff is attached."),
        ]);
        await submitDurable(agent, "Publish the Python diff.");
      });
      return { demo: agent };
    },
  };
}
