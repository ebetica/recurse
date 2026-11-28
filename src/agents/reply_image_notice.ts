// Check finalized replies for missing local image files without opening them.
// Checks are best effort and not persisted: restarting before admission can lose a notice.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolveImagePath } from "../image_path";
import {
  isFlatAttachmentUrl,
  isScopedAttachmentUrl,
  localImagePath,
} from "../image_reference";

const MAX_IMAGES = 8;
const MAX_ACTIVE = 4;
const MAX_WAITING = 64;

type Check = {
  text: string;
  current(): boolean;
  writeNote(text: string): Promise<void>;
};

async function imagePaths(reply: string): Promise<Map<string, string>> {
  const [{ parseFragment }, { parseMessageMarkdown }] = await Promise.all([
    import("parse5"),
    import("../message_markdown"),
  ]);
  const paths = new Map<string, string>();
  const nodes = parseFragment(parseMessageMarkdown(reply)).childNodes.reverse();
  while (nodes.length && paths.size < MAX_IMAGES) {
    const node = nodes.pop()!;
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        nodes.push(node.childNodes[i]!);
    if (!("tagName" in node) || node.tagName !== "img") continue;
    const href = node.attrs.find(({ name }) => name === "src")?.value.trim();
    if (!href || isFlatAttachmentUrl(href) || isScopedAttachmentUrl(href))
      continue;
    const path = localImagePath(href);
    if (path !== null && !paths.has(path)) paths.set(path, href);
  }
  return paths;
}

async function readableImageFile(cwd: string, path: string): Promise<boolean> {
  const location = resolveImagePath(cwd, path);
  if (location === null) return false;
  try {
    if (!(await stat(location)).isFile()) return false;
    await access(location, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class ReplyImageNotices {
  private readonly ready = new Map<string, Check>();
  private readonly active = new Map<string, Check | null>();

  constructor(
    private readonly cwd: (cid: string) => Promise<string | null>,
    private readonly spawn: (
      work: (signal: AbortSignal) => Promise<void>,
    ) => Promise<void>,
  ) {}

  check(cid: string, next: Check): void {
    if (this.active.has(cid)) this.active.set(cid, next);
    else if (this.ready.has(cid) || this.ready.size < MAX_WAITING)
      this.ready.set(cid, next);
    this.start();
  }

  private start(): void {
    while (this.active.size < MAX_ACTIVE) {
      const first = this.ready.entries().next().value;
      if (!first) return;
      const [cid, check] = first;
      this.ready.delete(cid);
      this.active.set(cid, null);
      const done = () => {
        const next = this.active.get(cid);
        this.active.delete(cid);
        if (next?.current()) this.ready.set(cid, next);
        this.start();
      };
      void this.spawn((signal) => this.inspect(cid, check, signal)).then(
        done,
        done,
      );
    }
  }

  private async inspect(
    cid: string,
    check: Check,
    signal: AbortSignal,
  ): Promise<void> {
    const current = () => !signal.aborted && check.current();
    if (!current()) return;
    const paths = await imagePaths(check.text);
    if (!paths.size || !current()) return;
    const cwd = await this.cwd(cid);
    if (!cwd) return;
    const missing: string[] = [];
    for (const [path, href] of paths) {
      if (!current()) return;
      if (!(await readableImageFile(cwd, path)))
        missing.push(JSON.stringify(href));
    }
    if (missing.length && current())
      await check.writeNote(
        `Images in your last reply could not be opened: ${missing.join(", ")}. Check the path, publish the file, or remove the reference.`,
      );
  }
}
