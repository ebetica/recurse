import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPage,
  mediaType,
  previewSnippet,
  safeName,
  type CollectionSnapshot,
  type SessionFilesContext,
} from "../../src/session_files";
import { Config } from "../../src/config";
import {
  VERSION,
  SOURCE_PUBLICATION,
  SOURCE_UPLOAD,
} from "../../src/agents/runtime/attachments/base";
import fixture from "./fixtures/session_files/cases.json";

interface FileFixture {
  manifest: Record<string, unknown>;
  hex: string;
}
interface ReplayCase {
  fn: string;
  [key: string]: unknown;
}
interface Harness {
  root: string;
  collection: string;
  config: Config;
  snapshot: CollectionSnapshot;
  context: SessionFilesContext;
  cleanup(): void;
}

type Bytes = Uint8Array<ArrayBuffer>;

function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

function fromHex(value: string): Bytes {
  const pairs = value.match(/.{2}/gu) ?? [];
  return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16)) as Bytes;
}

const cases = fixture.cases as ReplayCase[];
const recordedOwner = "recorded-owner";
const recordedTempKey = "20260924-recorded-owner";

function harness(
  testCase: Partial<ReplayCase> = {},
  overrides: Partial<SessionFilesContext> = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "session-files-ts-"));
  const config = new Config({
    env: {
      CHAT_DATA_DIR: join(root, "data"),
      RECURSE_TEMP_ROOT: join(root, "agent-temp"),
    },
    cwd: root,
    toolsDir: null,
  });
  const tempKey = (testCase.temp_key as string | undefined) ?? recordedTempKey;
  const owner = (testCase.owner as string | undefined) ?? recordedOwner;
  const collection = join(
    config.paths.AGENT_FILES_DIR,
    config.agentTempLeaf(tempKey),
    "uploads",
  );
  mkdirSync(collection, { recursive: true });
  const files = (testCase.files as FileFixture[] | undefined) ?? [];
  for (const item of files) {
    writeFileSync(
      join(collection, `${String(item.manifest.id)}.json`),
      JSON.stringify(item.manifest),
    );
    writeFileSync(
      join(collection, `${String(item.manifest.id)}.blob`),
      fromHex(item.hex),
    );
  }
  for (const id of (testCase.debris as string[] | undefined) ?? []) {
    writeFileSync(join(collection, `${id}.json`), "{not json", "utf8");
  }
  const session = testCase.session_jsonl;
  const sessionPath = join(root, "session.jsonl");
  if (typeof session === "string") writeFileSync(sessionPath, session, "utf8");
  const snapshot = { collection, owner, temp_key: tempKey };
  const context: SessionFilesContext = {
    config,
    boundSessionFile: () => (typeof session === "string" ? sessionPath : null),
    ...overrides,
  };
  return {
    root,
    collection,
    config,
    snapshot,
    context,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function replay(testCase: ReplayCase): Promise<unknown> {
  switch (testCase.fn) {
    case "safe_name":
      return safeName(testCase.value);
    case "list_page": {
      const local = harness(testCase);
      try {
        return await listPage(
          local.snapshot,
          local.context,
          testCase.session_id as string | null,
          null,
          testCase.limit,
          testCase.generation as number | null,
        );
      } finally {
        local.cleanup();
      }
    }
    default:
      throw new Error(`no replay for Python function ${testCase.fn}`);
  }
}

test.each(["safe_name"])("%s removes unsafe filename bytes", async (fn) => {
  for (const item of cases.filter((item) => item.fn === fn)) {
    expect(await replay(item)).not.toMatch(/[\\/\x00-\x1f\x7f]/);
  }
});

test("manifest debris exhausts only the bounded scan budget", async () => {
  const item = cases.find(
    (candidate) =>
      candidate.fn === "list_page" && Array.isArray(candidate.debris),
  )!;
  const page = (await replay(item)) as {
    files: unknown[];
    records: number;
    capped: boolean;
  };
  expect(page.files).toEqual([]);
  expect(page.records).toBe(0);
  expect(page.capped).toBe(true);
});

function addUpload(
  collection: string,
  id: string,
  owner: string,
  name: string,
  bytes: Bytes,
  source = SOURCE_UPLOAD,
  toolCallId: string | null = null,
): void {
  const manifest: Record<string, unknown> = {
    version: VERSION,
    id,
    owner,
    blob: `${id}.blob`,
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type: mediaType(name),
    inline_media_type: null,
    created_at: 1790000000,
    published: true,
    source,
    run_id: source === SOURCE_PUBLICATION ? "c".repeat(32) : null,
    tool_call_id: source === SOURCE_PUBLICATION ? toolCallId : null,
    intent_sha256:
      source === SOURCE_PUBLICATION
        ? createHash("sha256").update("fixture").digest("hex")
        : "",
  };
  writeFileSync(join(collection, `${id}.json`), JSON.stringify(manifest));
  writeFileSync(join(collection, `${id}.blob`), bytes);
}

test("accepted files enforce owner and safe-preview boundaries without Pi history", async () => {
  const pageCase = cases.find((item) => item.fn === "list_page")!;
  const htmlCase = cases.find((item) => item.fn === "preview_snippet")!;
  const local = harness({
    ...pageCase,
    files: [
      ...(pageCase.files as FileFixture[]),
      ...(htmlCase.files as FileFixture[]),
    ],
  });
  try {
    const strictContext: SessionFilesContext = {
      ...local.context,
      boundSessionFile: () => {
        throw new Error("a storage listing must not read Pi history");
      },
    };
    const page = await listPage(
      local.snapshot,
      strictContext,
      "recorded-session",
    );
    expect(page.files.map((file) => file.name)).toContain("notes.txt");
    expect(page.files.map((file) => file.name)).toContain("agent.py");
    expect(page.files.map((file) => file.name)).toContain("active.html");
    expect(
      await previewSnippet(
        local.snapshot,
        strictContext,
        "upload",
        "a".repeat(32) + ".txt",
      ),
    ).not.toBeNull();
    expect(
      await previewSnippet(
        local.snapshot,
        strictContext,
        htmlCase.storage as string,
        htmlCase.attachment_id as string,
        htmlCase.proof as null,
      ),
    ).toBeNull();
    expect(page.files.map((file) => file.name)).not.toContain(
      "foreign-secret.txt",
    );
    expect(JSON.stringify(page)).not.toContain("private");
    const foreign = await previewSnippet(
      local.snapshot,
      local.context,
      "upload",
      "c".repeat(32),
    );
    expect(foreign).toBeNull();
  } finally {
    local.cleanup();
  }
});

// Feature: #2632 newest files precede older pages without insertion shifting the cursor.
test("pages order accepted files, and deletion removes metadata and preview access", async () => {
  const local = harness({
    owner: "page-owner",
    temp_key: "20260924-page-owner",
  });
  try {
    const ids = Array.from({ length: 10 }, (_, index) =>
      index.toString(16).padStart(32, "0"),
    );
    for (const [index, id] of ids.entries()) {
      addUpload(
        local.collection,
        id,
        "page-owner",
        `page-${index}.txt`,
        utf8(`body-${index}`),
      );
    }
    const page = await listPage(local.snapshot, local.context, null, null, 3);
    expect(page.files).toHaveLength(3);
    expect(page.records).toBe(3);
    expect(page.capped).toBe(false);
    expect(page.done).toBe(false);
    expect(page.cursor).not.toBeNull();
    const newestId = ids.at(-1)!;
    const manifestPath = join(local.collection, `${newestId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.created_at += 1;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const newestPage = await listPage(
      local.snapshot,
      local.context,
      null,
      null,
      3,
    );
    expect(newestPage.files[0]?.id).toBe(newestId);
    expect(newestPage.files[0]?.created_at).toBe(manifest.created_at);
    const seen = newestPage.files.map((file) => file.id);
    const addedId = "f".repeat(32);
    addUpload(
      local.collection,
      addedId,
      "page-owner",
      "inserted.txt",
      utf8("new"),
    );
    const addedPath = join(local.collection, `${addedId}.json`);
    const added = JSON.parse(readFileSync(addedPath, "utf8"));
    added.created_at = manifest.created_at + 1;
    writeFileSync(addedPath, JSON.stringify(added));
    let cursor = newestPage.cursor;
    while (cursor) {
      const older = await listPage(
        local.snapshot,
        local.context,
        null,
        cursor,
        3,
      );
      seen.push(...older.files.map((file) => file.id));
      cursor = older.cursor;
    }
    expect(seen).toEqual([newestId, ...ids.slice(0, -1)]);
    expect(new Set(seen).size).toBe(ids.length);
    expect(
      (await listPage(local.snapshot, local.context, null, null, 3)).files[0]
        ?.id,
    ).toBe(addedId);
    await expect(
      listPage(local.snapshot, local.context, null, "invalid"),
    ).rejects.toThrow("bad file cursor");

    const deleted = ids[0]!;
    unlinkSync(join(local.collection, `${deleted}.json`));
    unlinkSync(join(local.collection, `${deleted}.blob`));
    expect(
      await previewSnippet(local.snapshot, local.context, "upload", deleted),
    ).toBeNull();
    const afterDelete = await listPage(local.snapshot, local.context);
    expect(afterDelete.files.some((file) => file.id === deleted)).toBe(false);
  } finally {
    local.cleanup();
  }
});

test("a reap during a preview read returns no bytes", async () => {
  const local = harness({
    owner: "race-owner",
    temp_key: "20260924-race-owner",
  });
  const id = "f".repeat(32) + ".txt";
  addUpload(
    local.collection,
    id,
    "race-owner",
    "race.txt",
    utf8("must not escape"),
  );
  let entered!: () => void;
  let release!: () => void;
  const atCheck = new Promise<void>((resolve) => (entered = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  const session = join(local.root, "race.jsonl");
  const message = { role: "user", content: `see /api/attachments/${id}` };
  const line = { type: "message", id: "race", parentId: null, message };
  writeFileSync(session, `${JSON.stringify(line)}\n`);
  const context: SessionFilesContext = {
    ...local.context,
    boundSessionFile: async () => {
      entered();
      await hold;
      return session;
    },
  };
  const proof = [["s", session, "/cwd"], 0] as const;
  const read = (ctx: SessionFilesContext) =>
    previewSnippet(local.snapshot, ctx, "upload", id, proof);
  try {
    expect(
      await read({ ...context, boundSessionFile: () => session }),
    ).not.toBeNull();
    const preview = read(context);
    await atCheck;
    const parent = join(local.config.paths.AGENT_FILES_DIR);
    const retired = join(parent, ".retired-temp-key");
    renameSync(
      join(parent, local.config.agentTempLeaf(local.snapshot.temp_key)),
      retired,
    );
    release();
    expect(await preview).toBeNull();
    expect(existsSync(join(retired, "uploads", `${id}.blob`))).toBe(true);
  } finally {
    release();
    local.cleanup();
  }
});

test("collection, manifest, blob, and transcript symlinks or escapes fail closed", async () => {
  const local = harness({
    owner: "path-owner",
    temp_key: "20260924-path-owner",
  });
  try {
    const id = "1".repeat(32);
    const outside = join(local.root, "outside");
    mkdirSync(outside);
    const secret = utf8("outside secret bytes");
    addUpload(outside, id, "path-owner", "outside.txt", secret);

    const manifestLink = join(local.collection, `${id}.json`);
    symlinkSync(join(outside, `${id}.json`), manifestLink);
    expect((await listPage(local.snapshot, local.context)).files).toEqual([]);
    unlinkSync(manifestLink);

    writeFileSync(
      join(local.collection, `${id}.json`),
      JSON.stringify({
        version: VERSION,
        id,
        owner: "path-owner",
        blob: `${id}.blob`,
        name: "outside.txt",
        size: secret.length,
        sha256: createHash("sha256").update(secret).digest("hex"),
        media_type: "text/plain",
        inline_media_type: null,
        created_at: 1790000000,
        published: true,
        source: SOURCE_UPLOAD,
        run_id: null,
        tool_call_id: null,
        intent_sha256: "",
      }),
    );
    symlinkSync(
      join(outside, `${id}.blob`),
      join(local.collection, `${id}.blob`),
    );
    expect((await listPage(local.snapshot, local.context)).files).toEqual([]);
    expect(
      await previewSnippet(local.snapshot, local.context, "upload", id),
    ).toBeNull();
    unlinkSync(join(local.collection, `${id}.blob`));

    const traversal = JSON.parse(
      readFileSync(join(local.collection, `${id}.json`), "utf8"),
    ) as Record<string, unknown>;
    traversal.blob = "../../outside-secret";
    writeFileSync(
      join(local.collection, `${id}.json`),
      JSON.stringify(traversal),
    );
    writeFileSync(join(local.collection, `${id}.blob`), secret);
    expect((await listPage(local.snapshot, local.context)).files).toEqual([]);
    expect(
      await listPage(
        { ...local.snapshot, collection: outside },
        local.context,
      ).then((page) => page.files),
    ).toEqual([]);

    const sessionFile = join(local.root, "session.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "escape",
        parentId: null,
        message: { role: "user", content: `see /api/attachments/${id}` },
      })}\n`,
    );
    const sessionLink = join(local.root, "session-link.jsonl");
    symlinkSync(sessionFile, sessionLink);
    const proofContext: SessionFilesContext = {
      ...local.context,
      boundSessionFile: () => sessionLink,
    };
    expect(
      await previewSnippet(local.snapshot, proofContext, "upload", id, [
        ["session", sessionLink, "/cwd"],
        0,
      ]),
    ).toBeNull();
  } finally {
    local.cleanup();
  }
});

test("a collection symlink cannot redirect reads to another directory", async () => {
  const local = harness({
    owner: "symlink-owner",
    temp_key: "20260924-symlink-owner",
  });
  try {
    const target = join(local.root, "outside-collection");
    mkdirSync(target);
    addUpload(
      target,
      "2".repeat(32),
      "symlink-owner",
      "hidden.txt",
      utf8("hidden"),
    );
    const parked = join(local.root, "parked-collection");
    renameSync(local.collection, parked);
    symlinkSync(target, local.collection, "dir");
    expect((await listPage(local.snapshot, local.context)).files).toEqual([]);
    expect(
      await previewSnippet(
        local.snapshot,
        local.context,
        "upload",
        "2".repeat(32),
      ),
    ).toBeNull();
  } finally {
    local.cleanup();
  }
});
