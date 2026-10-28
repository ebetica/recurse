// Read fresh prompt resources in order on one shared Worker.
// Failures report onFallback and read on-loop; dead threads are replaced.
// @ imports add bounded depth-first Markdown entries without changing sources.
// Refuse hidden files, symlinks and imports inside the Recurse agent directory.
import {
  loadProjectContextFiles,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Worker } from "node:worker_threads";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export interface PromptResources {
  contextFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
}

export type PromptResourcesRequest = {
  cwd: string;
  agentDir: string;
  skillPaths: string[];
};

async function expandContextImports(
  files: PromptResources["contextFiles"],
  agentDir: string,
): Promise<PromptResources["contextFiles"]> {
  const output: PromptResources["contextFiles"] = [];
  const seen = new Set<string>();
  const blocked = await realpath(agentDir).catch(() => resolve(agentDir));
  let remaining = 256 * 1024;
  let attempts = 128;
  const visit = async (file: (typeof files)[number], depth: number) => {
    const key = await realpath(file.path).catch(() => resolve(file.path));
    if (seen.has(key)) return;
    seen.add(key);
    output.push(file);
    if (depth === 4) return;
    const prose = file.content.replace(
      /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[\t ]*(?:\n|$)|(?![\s\S]))|(`+)[\s\S]*?\2|^(?: {4}|\t).*$/gm,
      " ",
    );
    for (const match of prose.matchAll(/(?:^|[\s(])@((?:\\ |[^\s`"'<>])+)/g)) {
      if (attempts-- <= 0 || remaining <= 0) return;
      const name = match[1]!.replaceAll("\\ ", " ");
      if (!name.endsWith(".md")) continue;
      const path = name.startsWith("~/")
        ? resolve(homedir(), name.slice(2))
        : resolve(dirname(file.path), name);
      if (path.split(sep).some((part) => part.startsWith("."))) continue;
      try {
        const canonical = await realpath(path);
        const fromBlocked = relative(blocked, canonical);
        if (
          canonical !== path ||
          seen.has(canonical) ||
          (!fromBlocked.startsWith(`..${sep}`) &&
            fromBlocked !== ".." &&
            !isAbsolute(fromBlocked))
        )
          continue;
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let content: string;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > Math.min(64 * 1024, remaining))
            continue;
          const buffer = new Uint8Array(Math.min(64 * 1024, remaining) + 1);
          const { bytesRead } = await handle.read(buffer);
          if (bytesRead > Math.min(64 * 1024, remaining)) continue;
          remaining -= bytesRead;
          content = new TextDecoder().decode(buffer.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
        await visit({ path, content }, depth + 1);
      } catch {}
    }
  };
  for (const file of files) await visit(file, 0);
  return output;
}

export async function loadPromptResources(
  cwd: string,
  agentDir: string,
  skillPaths: string[],
): Promise<PromptResources> {
  return {
    contextFiles: await expandContextImports(
      loadProjectContextFiles({ cwd, agentDir }),
      agentDir,
    ),
    skills: loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true })
      .skills,
  };
}

type Thread = {
  worker: Worker;
  waiting: Array<PromiseWithResolvers<PromptResources>>;
};

export class PromptResourcesWorker {
  private thread: Thread | undefined;
  private closed = false;

  constructor(
    private readonly onFallback: (error: Error) => void,
    private readonly url = new URL(
      "./prompt_resources_thread.ts",
      import.meta.url,
    ),
  ) {}

  private start(): Thread {
    const thread: Thread = { worker: new Worker(this.url), waiting: [] };
    const failed = (error: Error) => {
      if (this.thread === thread) this.thread = undefined;
      for (const waiter of thread.waiting.splice(0)) waiter.reject(error);
    };
    thread.worker.on("error", (error: Error) =>
      failed(new Error(`prompt resources thread failed: ${error.message}`)),
    );
    thread.worker.on("exit", (code) =>
      failed(new Error(`prompt resources thread exited (${code})`)),
    );
    // Invariant: The thread answers one read at a time, in order.
    thread.worker.on(
      "message",
      (reply: PromptResources | { error: string }) => {
        const waiter = thread.waiting.shift();
        if ("error" in reply)
          waiter?.reject(
            new Error(`prompt resources read failed: ${reply.error}`),
          );
        else waiter?.resolve(reply);
      },
    );
    return thread;
  }

  async load(
    cwd: string,
    agentDir: string,
    skillPaths: string[],
  ): Promise<PromptResources> {
    if (!this.closed)
      try {
        const thread = (this.thread ??= this.start());
        const waiter = Promise.withResolvers<PromptResources>();
        thread.worker.postMessage({
          cwd,
          agentDir,
          skillPaths,
        } satisfies PromptResourcesRequest);
        thread.waiting.push(waiter);
        return await waiter.promise;
      } catch (error) {
        if (!this.closed)
          this.onFallback(
            error instanceof Error ? error : new Error(String(error)),
          );
      }
    return loadPromptResources(cwd, agentDir, skillPaths);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.thread?.worker.terminate();
  }
}
