import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPromptResources,
  PromptResourcesWorker,
} from "../../src/agents/durable/prompt_resources";
import { fauxHost } from "./fixtures/durable_host/host";

const STUB = new URL(
  "./fixtures/durable_host/prompt_thread_stub.ts",
  import.meta.url,
);
const THREAD_TEST_MS = 30_000;
const workers: PromptResourcesWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
});

function roots() {
  const root = mkdtempSync(join(tmpdir(), "prompt-resources-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), "Repo rules.\n");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "skills", "notes"), { recursive: true });
  writeFileSync(
    join(agentDir, "skills", "notes", "SKILL.md"),
    "---\nname: notes\ndescription: Take notes.\n---\nBody.\n",
  );
  return { root, repo, agentDir };
}

function worker() {
  const fallbacks: string[] = [];
  const made = new PromptResourcesWorker(
    (error) => fallbacks.push(error.message),
    STUB,
  );
  workers.push(made);
  return { worker: made, fallbacks };
}

test(
  "a slow read leaves the event loop free and returns the same resources",
  async () => {
    const { repo, agentDir } = roots();
    const { worker: made, fallbacks } = worker();
    const value = await made.load(repo, agentDir, []);
    expect(value).toEqual(await loadPromptResources(repo, agentDir, []));
    expect(value.contextFiles.map((file) => file.content)).toContain(
      "Repo rules.\n",
    );
    expect(value.skills.map((skill) => skill.name)).toEqual(["notes"]);
    expect(fallbacks).toEqual([]);
  },
  THREAD_TEST_MS,
);

test(
  "a thread that dies falls back to the synchronous read, reports it, and is replaced",
  async () => {
    const { root, repo, agentDir } = roots();
    const { worker: made, fallbacks } = worker();
    const died = join(root, "die");
    expect(await made.load(died, agentDir, [])).toEqual(
      await loadPromptResources(died, agentDir, []),
    );
    expect(fallbacks).toEqual([
      "prompt resources thread failed: thread crashed",
    ]);
    expect(await made.load(repo, agentDir, [])).toEqual(
      await loadPromptResources(repo, agentDir, []),
    );
    expect(fallbacks).toHaveLength(1);
  },
  THREAD_TEST_MS,
);

// Regression: #2161 read error unnecessarily replaced healthy prompt worker
test(
  "a read that throws falls back, and the same thread serves the next call",
  async () => {
    const { repo, agentDir } = roots();
    const fallbacks: string[] = [];
    const made = new PromptResourcesWorker((error) =>
      fallbacks.push(error.message),
    );
    workers.push(made);
    const threadId = () =>
      (made as unknown as { thread?: { worker: { threadId: number } } }).thread
        ?.worker.threadId;
    await made.load(repo, agentDir, []);
    const first = threadId();
    const bad = [null as unknown as string];
    const failure = await made
      .load(repo, agentDir, bad)
      .catch((error) => error);
    let expected: unknown;
    try {
      await loadPromptResources(repo, agentDir, bad);
    } catch (error) {
      expected = error;
    }
    expect(String(failure)).toBe(String(expected));
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toStartWith("prompt resources read failed: TypeError");
    expect(await made.load(repo, agentDir, [])).toEqual(
      await loadPromptResources(repo, agentDir, []),
    );
    expect(first).toBeNumber();
    expect([threadId()]).toEqual([first]);
  },
  THREAD_TEST_MS,
);

test(
  "concurrent project reads return each caller's own instructions",
  async () => {
    const first = roots(),
      second = roots();
    writeFileSync(join(first.repo, "AGENTS.md"), "@one.md");
    for (const [name, next] of [
      ["one", "two"],
      ["two", "three"],
      ["three", "four"],
    ])
      writeFileSync(join(first.repo, `${name}.md`), `@${next}.md`);
    writeFileSync(join(first.repo, "four.md"), "First project only");
    const made = new PromptResourcesWorker(() => {});
    workers.push(made);
    const actual = await Promise.all([
      made.load(first.repo, first.agentDir, []),
      made.load(second.repo, second.agentDir, []),
    ]);
    expect(actual).toEqual(
      await Promise.all([
        loadPromptResources(first.repo, first.agentDir, []),
        loadPromptResources(second.repo, second.agentDir, []),
      ]),
    );
  },
  THREAD_TEST_MS,
);

test("a read that the host's close overtakes starts no thread", async () => {
  const { root, repo, agentDir } = roots();
  const { host } = fauxHost(join(root, "data"));
  const loaded = host.promptResources(repo, agentDir, []);
  await host.close();
  expect(await loaded).toEqual(await loadPromptResources(repo, agentDir, []));
  expect((host as unknown as { promptWorker: unknown }).promptWorker).toBe(
    null,
  );
});
