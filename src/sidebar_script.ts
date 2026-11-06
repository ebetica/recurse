// The sidebar script: config/sidebar.js, else web/sidebar/default_sidebar.js.
// A new script must run on the current rows in a worker thread
// (sidebar_dry_run.worker.ts) before saving. config/sidebar-history.json keeps
// the last 10 versions, newest first, with who made each; null is built-in.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArrangementError,
  checkSections,
  checkNewAgent,
} from "../web/sidebar/arrangement.ts";
import { sidebarRows, type RowSource } from "../web/sidebar/rows.ts";
import { MAX_SCRIPT_BYTES, type ScriptResult } from "../web/sidebar/sandbox.ts";

export const DEFAULT_SCRIPT = join(
  import.meta.dir,
  "../web/sidebar/default_sidebar.js",
);
const KEEP = 10;
/** The dry run's bound, including the worker's engine start. */
const DRY_RUN_MS = 5000;

export interface ScriptVersion {
  at: number;
  by: string;
  script: string | null;
}
export interface TreeSource extends RowSource {
  parent?: string | null;
  side_of?: string | null;
}

export class SidebarScriptError extends Error {}

export class SidebarScript {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly tree: () => TreeSource[],
    private readonly now = () => Date.now() / 1000,
  ) {}

  private get file() {
    return join(this.dir, "sidebar.js");
  }
  private get historyFile() {
    return join(this.dir, "sidebar-history.json");
  }

  /** The custom script, or null for the built-in one. */
  async script(): Promise<string | null> {
    return readFile(this.file, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  }

  async history(): Promise<ScriptVersion[]> {
    const text = await readFile(this.historyFile, "utf8").catch(() => "[]");
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.slice(0, KEEP) : [];
    } catch {
      return [];
    }
  }

  /** The sidebar_script view: the script in use and earlier versions. */
  async view() {
    const script = await this.script();
    return {
      custom: script !== null,
      script: script ?? (await readFile(DEFAULT_SCRIPT, "utf8")),
      history: (await this.history()).map(({ at, by, script }) => ({
        at,
        by,
        custom: script !== null,
      })),
    };
  }

  /**
   * Save `script` (null: the built-in one) after a dry run on the current
   * rows; returns each section's title and row count.
   */
  set(script: string | null, by: string) {
    return this.serial(async () => {
      const sections = script === null ? [] : await this.dryRun(script);
      await this.save(script, by, await this.history());
      return sections;
    });
  }

  /** Go back to the version before the current one. */
  undo(by: string) {
    return this.serial(async () => {
      const [current, ...older] = await this.history();
      if (!current) throw new SidebarScriptError("There is nothing to undo.");
      await this.save(older[0]?.script ?? null, by, older.slice(1));
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.writes.then(work, work);
    this.writes = turn.catch(() => {});
    return turn;
  }

  private async save(
    script: string | null,
    by: string,
    older: ScriptVersion[],
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (script === null) await rm(this.file, { force: true });
    else await writeAtomic(this.file, script);
    const version = { at: this.now(), by, script };
    await writeAtomic(
      this.historyFile,
      JSON.stringify([version, ...older].slice(0, KEEP)),
    );
  }

  private async dryRun(script: string) {
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES)
      throw new SidebarScriptError("The script is over 16 KB.");
    const now = this.now();
    const rows = sidebarRows(this.tree(), now);
    const worker = new Worker(
      join(import.meta.dir, "sidebar_dry_run.worker.ts"),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<ScriptResult>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new SidebarScriptError("The script did not finish.")),
          DRY_RUN_MS,
        );
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ script, rows, now });
      });
      if ("error" in result)
        throw new SidebarScriptError(
          result.line === null
            ? result.error
            : `${result.error} (line ${result.line})`,
        );
      checkNewAgent(result.newAgent);
      return checkSections(result.sections, rows).map((section) => ({
        title: section.title,
        rows: section.ids.length,
      }));
    } catch (error) {
      if (error instanceof ArrangementError)
        throw new SidebarScriptError(error.message);
      throw error;
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
