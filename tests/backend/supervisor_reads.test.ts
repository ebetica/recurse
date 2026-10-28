import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentError,
  AttachmentNotFound,
} from "../../src/agents/runtime/attachments/base";
import { historyGeneration } from "../../src/agents/history_claim";
import {
  SupervisorReads,
  type FileOps,
  type ReadsDeps,
} from "../../src/agents/supervisor/reads";
import { CompletedReplyStorageUnavailable } from "../../src/agents/view/reader";
import fixture from "./fixtures/supervisor_reads/cases.json";

type Json = Record<string, unknown>;
interface Op extends Json {
  op: string;
  cid?: string;
  during?: string;
  worker?: Json;
}
interface Scenario {
  name: string;
  files?: Record<string, string>;
  convs: Record<string, Json>;
  nodes?: Record<string, Json>;
  rebound?: string[];
  published?: Json;
  pending_actions?: Record<string, string[]>;
  clock?: number;
  ops: Op[];
}
interface Case {
  scenario: Scenario;
  results: { op: Op; out: unknown; calls: unknown[]; logs: unknown[] }[];
}

const SESSION = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

class Harness {
  calls: unknown[] = [];
  blobs: { text: string; closed: boolean }[] = [];
  logs: unknown[] = [];
  clock: number;
  paths = new Map<string, string>();
  convs = new Map<string, Json>();
  saved: Map<string, Json>;
  rebound: Set<string>;
  nodes = new Map<string, any>();
  during: string | null = null;
  epoch = 0;
  worker: Json | undefined;
  instances = new Map<string, string>();
  reads: SupervisorReads;

  constructor(
    readonly scenario: Scenario,
    readonly root: string,
  ) {
    this.clock = scenario.clock ?? 0;
    for (const [name, text] of Object.entries(scenario.files ?? {})) {
      const path = join(root, `${name}.jsonl`);
      writeFileSync(path, text);
      this.paths.set(name, path);
    }
    for (const [cid, conv] of Object.entries(scenario.convs)) {
      const copy = { ...conv };
      if ("session_file" in copy)
        copy.session_file = this.path(String(copy.session_file));
      this.convs.set(cid, copy);
    }
    this.saved = new Map(this.convs);
    this.rebound = new Set((scenario.rebound ?? []).map((n) => this.path(n)));
    for (const [cid, spec] of Object.entries(scenario.nodes ?? {}))
      this.nodes.set(cid, this.node(spec));
    this.reads = new SupervisorReads(this.deps());
  }

  path(name: string): string {
    return this.paths.get(name) ?? join(this.root, `${name}.jsonl`);
  }
  rel(value: unknown): string {
    return String(value).replace(`${this.root}/`, "<ROOT>/");
  }

  node(spec: Json): any {
    const inbox = (spec.inbox as Json[] | undefined) ?? [];
    return {
      reaping: Boolean(spec.reaping),
      inboxMessages: () => inbox.map((row) => ({ ...row })),
    };
  }

  mutate(kind: string): void {
    if (kind === "bump_epoch") this.epoch += 1;
    else if (kind === "drop") this.convs.clear();
  }
  fire(): void {
    if (this.during !== null) {
      const kind = this.during;
      this.during = null;
      this.mutate(kind);
    }
  }
  async stub<T>(
    name: string,
    fallback: Json | undefined,
    args: unknown,
  ): Promise<T> {
    this.calls.push([name, args]);
    const spec = this.worker ?? fallback ?? {};
    if (typeof spec.during === "string") this.mutate(spec.during);
    if (spec.raise === "ValueError") throw new RangeError("bad");
    if (spec.raise === "AttachmentError") throw new AttachmentError("corrupt");
    if (spec.raise === "NotFound") throw new AttachmentNotFound("missing");
    if (spec.raise === "RuntimeError") throw new Error("worker failed");
    return (spec.return ?? null) as T;
  }

  deps(): ReadsDeps {
    const snap = (value: { owner: string; temp_key: string } | null) =>
      value === null ? null : { owner: value.owner, temp_key: value.temp_key };
    const files: FileOps = {
      listPage: (async (
        s: any,
        _c: unknown,
        sid: unknown,
        cursor: unknown,
        limit: unknown,
        gen: unknown,
      ) =>
        this.stub("list_page", undefined, [
          snap(s),
          sid,
          cursor,
          limit,
          gen,
        ])) as any,
      previewSnippet: (async (
        s: any,
        _c: unknown,
        storage: unknown,
        id: unknown,
        proof: any,
      ) =>
        this.stub("preview_snippet", undefined, [
          snap(s),
          storage,
          id,
          proof === null
            ? null
            : [[proof[0][0], this.rel(proof[0][1]), proof[0][2]], proof[1]],
        ])) as any,
      openDownload: (async (_col: string, owner: string, id: string) => {
        const value = await this.stub<[Json, string] | null>(
          "read_download",
          undefined,
          [owner, id],
        );
        if (value === null) return null;
        const blob = { text: value[1], closed: false };
        this.blobs.push(blob);
        return {
          manifest: value[0],
          size: value[1].length,
          blob: { ...blob, close: async () => void (blob.closed = true) },
        };
      }) as any,
      removeFile: (async (
        _col: string,
        owner: string,
        id: string,
        counters: unknown,
      ) =>
        this.stub("remove_file", undefined, [
          owner,
          id,
          counters !== null,
        ])) as any,
      publishedCallFiles: (async (_col: string, owner: string) => {
        this.calls.push(["published_call_index", owner]);
        return Object.fromEntries(
          Object.entries(this.scenario.published ?? {}).map(([call, file]) => [
            call,
            [file],
          ]),
        );
      }) as any,
    };
    return {
      claims: {
        metadataSnapshot: (cid) => {
          const conv = this.convs.get(cid);
          return conv ? { ...conv } : null;
        },
        existing: (cid) => this.nodes.get(cid) ?? null,
        topologyEpoch: () => this.epoch,
        dataDir: () => "/data",
        binding: (sessionId, sessionFile, cwd) => ({
          sessionId,
          sessionFile,
          cwd,
        }),
      },
      config: {
        paths: { AGENT_FILES_DIR: "/data/tmp" },
        agentTempLeaf: (key: string) => key,
      } as any,
      sessionFiles: {} as any,
      boundSessionFile: async (_sid, file) => {
        this.calls.push(["bound_session_file", this.rel(file)]);
        this.fire();
        if (
          typeof file !== "string" ||
          this.rebound.has(file) ||
          !existsSync(file)
        )
          return null;
        return file;
      },
      pendingActions: (cid) => [
        ...(this.scenario.pending_actions?.[cid] ?? []),
      ],
      prompts: {
        readTurnPromptValues: async (input) => {
          this.fire();
          return this.stub(
            "read_turn_prompt_values",
            { return: { prompt: "turn" } },
            {
              session_id: input.sessionId,
              recorded_file: this.rel(input.recordedFile),
              recorded_cwd: input.recordedCwd,
              offset: input.offset,
              conv_id: input.conv.id,
              snap: snap(input.snap),
              max_session_bytes: input.maxSessionBytes,
              live_context_messages: input.liveContextMessages,
            },
          );
        },
        readPromptValues: async (conv) => {
          this.fire();
          return this.stub(
            "read_prompt_values",
            { return: { system: "base" } },
            conv.id,
          );
        },
      },
      contextUsage: {
        readContextUsageValues: async (conv, sample, sid, file, cwd) => {
          this.fire();
          return this.stub(
            "read_context_usage_values",
            { return: { used: 1 } },
            [conv.id, sample, sid, this.rel(file), cwd],
          );
        },
      },
      lstatSize: async (path) => (await lstat(path)).size,
      logWarning: (event, fields) => this.logs.push([event, fields]),
      monotonic: () => this.clock,
      sleep: async (seconds) => {
        this.calls.push(["sleep", seconds]);
        this.clock += seconds;
      },
      composeLoaded: () => {},
      files,
    };
  }

  instance(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (!this.instances.has(value))
      this.instances.set(value, `<i${this.instances.size}>`);
    return this.instances.get(value);
  }
}

function cursorView(page: Json | null): unknown {
  if (page === null || typeof page.next_cursor !== "string") return page;
  const fields = JSON.parse(
    Buffer.from(page.next_cursor, "base64url").toString("utf8"),
  ) as unknown[];
  fields[2] = "<digest>";
  return { ...page, next_cursor: fields };
}

const snapOut = (value: { owner: string; temp_key: string } | null) =>
  value === null ? null : { owner: value.owner, temp_key: value.temp_key };

async function replay(row: Case): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sup-reads-"));
  temps.push(root);
  const h = new Harness(row.scenario, root);
  const offsets = new Map<string, number>();
  for (const [name, text] of Object.entries(row.scenario.files ?? {})) {
    let position = 0;
    for (const line of text.split(/(?<=\n)/)) {
      if (line && (JSON.parse(line) as Json).type === "compaction")
        offsets.set(name, position);
      position += Buffer.byteLength(line);
    }
  }
  let lastPage: Json | null = null;
  let lastReplies: Json | null = null;
  for (const result of row.results) {
    const op = result.op;
    const cid = op.cid ?? "";
    h.calls = [];
    h.logs = [];
    h.during = op.during ?? null;
    h.worker = op.worker;
    let out: unknown = null;
    switch (op.op) {
      case "window": {
        let before = (op.before as string | undefined) ?? null;
        if (before === "<prev-first>")
          before = String(((lastPage!.blocks as Json[])[0] as Json).id);
        let instance = (op.instance as string | undefined) ?? null;
        if (instance === "<prev-instance>")
          instance = String(lastPage!.instance_id);
        const page = await h.reads.readViewWindow(cid, {
          before,
          limit: (op.limit as number | undefined) ?? 50,
          since: (op.since as number | undefined) ?? null,
          instance,
        });
        if (page.status === "ready") lastPage = page;
        out = op.summary
          ? { status: page.status, blocks: (page.blocks as unknown[]).length }
          : {
              ...page,
              ...("instance_id" in page
                ? { instance_id: h.instance(page.instance_id) }
                : {}),
            };
        break;
      }
      case "events": {
        let last = op.last_event_id as string | null;
        if (last === "<prev>")
          last = `${String(lastPage!.instance_id)}:${String(lastPage!.revision)}`;
        const [status, body] = await h.reads.readViewEvents(cid, last);
        let text = Buffer.from(body).toString("utf8");
        for (const [raw, alias] of h.instances)
          text = text.split(raw).join(alias);
        out = [
          status,
          text.length < 600
            ? text
            : { sha256: createHash("sha256").update(text).digest("hex") },
        ];
        if (status === 200) {
          const data = JSON.parse(text.split("data: ")[1]!) as Json;
          for (const [raw, alias] of h.instances)
            if (alias === data.instance_id)
              lastPage = { ...data, instance_id: raw };
        }
        break;
      }
      case "replies": {
        let cursor = op.cursor as string | null;
        if (cursor === "<prev-next>")
          cursor = lastReplies!.next_cursor as string;
        try {
          const page = await h.reads.readCompletedReplies(cid, cursor, {
            wait: op.wait ?? 0,
            batchLimit: op.batch_limit ?? 20,
          });
          if (page !== null) lastReplies = page;
          out = cursorView(page);
        } catch (error) {
          if (!(error instanceof CompletedReplyStorageUnavailable)) throw error;
          out = { raises: "CompletedReplyStorageUnavailable" };
        }
        break;
      }
      case "marker": {
        const offset =
          op.offset === "<compaction>"
            ? offsets.get("main")!
            : Number(op.offset);
        const generation =
          op.generation === "<current>"
            ? historyGeneration(SESSION)
            : ((op.generation as number | undefined) ?? null);
        out = await h.reads.readMarkerSummary(cid, offset, generation);
        break;
      }
      case "file_snapshot":
        out = snapOut(h.reads.fileSnapshot(cid));
        break;
      case "file_page":
        out = await h.reads.composeFilePage(
          cid,
          (op.cursor as string | undefined) ?? null,
          op.limit ?? 1000,
          (op.generation as number | undefined) ?? null,
        );
        break;
      case "file_preview":
        out = await h.reads.composeFilePreview(
          cid,
          "upload",
          "u".repeat(32),
          (op.offset as number | undefined) ?? null,
        );
        break;
      case "file_download": {
        const [status, value] = await h.reads.composeFileDownload(
          cid,
          "f".repeat(32),
        );
        out = [
          status,
          value === null ? null : [value.manifest, (value.blob as any).text],
        ];
        await value?.blob.close();
        expect(h.blobs.filter((blob) => !blob.closed)).toEqual([]);
        break;
      }
      case "file_delete":
        out = await h.reads.composeFileDelete(cid, "f".repeat(32));
        break;
      case "turn_prompt":
        out = await h.reads.readTurnPrompt(cid, Number(op.offset));
        break;
      case "context_usage":
      case "base_prompt":
        try {
          out =
            op.op === "context_usage"
              ? await h.reads.readContextUsage(cid)
              : await h.reads.readBasePrompt(cid);
        } catch (error) {
          out = { raises: (error as Error).message };
        }
        break;
      case "rebind":
        h.rebound.add(h.path(String(op.file)));
        break;
      case "restore":
        h.convs.clear();
        for (const [key, value] of h.saved) h.convs.set(key, value);
        break;
      case "clock":
        h.clock += Number(op.advance);
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    const hostile = Boolean(
      op.during ||
      op.worker?.during ||
      row.scenario.name === "unresolvable-binding-fails-closed" ||
      row.scenario.name === "gone-and-reaping-owners",
    );
    if (hostile) {
      if (op.op === "window") expect((out as Json).blocks).toEqual([]);
      else if (op.op === "events")
        expect(String((out as unknown[])[1])).not.toMatch(
          /"blocks"\s*:\s*\[\s*\{/,
        );
      else if (op.op === "replies")
        expect((out as Json | null)?.replies ?? []).toEqual([]);
      else if (op.op === "file_page") expect((out as unknown[])[1]).toBeNull();
      else if (op.op === "file_delete") {
        expect(out).toEqual([404, false]);
      } else if (op.op !== "restore") expect(out).toBeNull();
    } else if (op.worker?.raise || op.claim === false) {
      for (const key of ["prompt", "system", "used"])
        expect(out).not.toHaveProperty(key);
    }
    expect({ op, out, calls: h.calls, logs: h.logs }).toEqual(result);
  }
}

test("thinking reads fail closed for an unbound conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "sup-thinking-"));
  temps.push(root);
  const h = new Harness(
    {
      name: "unbound-thinking",
      convs: { u: { id: "u", status: "idle" } },
      ops: [],
    },
    root,
  );
  expect(await h.reads.readThinkingText("u", 0)).toBeNull();
  expect(h.calls).toEqual([]);
});

for (const row of (fixture as unknown as { cases: Case[] }).cases)
  test(`supervisor reads: ${row.scenario.name}`, () => replay(row));

test("a download whose owner changes while it opens closes its blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "sup-download-race-"));
  temps.push(root);
  const h = new Harness(
    {
      name: "download-race",
      convs: { f: { id: "f", status: "idle", tmp_key: "20260925-fixture" } },
      ops: [],
    },
    root,
  );
  h.worker = {
    return: [{ id: "f".repeat(32), name: "a.bin", size: 3 }, "abc"],
    during: "drop",
  };
  const [status, value] = await h.reads.composeFileDownload(
    "f",
    "f".repeat(32),
  );
  expect([status, value]).toEqual([404, null]);
  expect(h.blobs.map((blob) => blob.closed)).toEqual([true]);
});
