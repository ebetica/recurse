import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ERROR,
  RotatingFileSink,
  RuntimeLogger,
  logEvent,
  logException,
  type RuntimeLogRecord,
  safeTraceback,
} from "../../src/observability/runtime_logging";
import fixture from "./fixtures/runtime_logging/cases.json";

interface Case {
  fn: string;
  event?: string;
  fields?: Record<string, unknown>;
  conversation_id?: string | null;
  run_id?: string | null;
  exception?: unknown;
}

const cases = fixture.cases as Case[];

function replay(c: Case): unknown {
  const records: RuntimeLogRecord[] = [];
  const target = new RuntimeLogger(
    "recurse.fixture",
    { write: (record) => records.push(record) },
    0,
    () => new Date("2024-01-02T03:04:05.000Z"),
  );
  if (c.fn === "log_event") {
    logEvent(target, ERROR, c.event!, {
      conversation_id: c.conversation_id,
      run_id: c.run_id,
      fields: c.fields,
    });
  } else if (c.fn === "log_exception") {
    logException(target, c.event!, c.exception, {
      conversation_id: c.conversation_id,
      run_id: c.run_id,
      fields: c.fields,
    });
  } else {
    throw new Error(`unknown fixture function: ${c.fn}`);
  }
  const record = records[0]!;
  return {
    level: record.level,
    message: record.message,
    conversation_id: record.conversation_id,
    run_id: record.run_id,
    ...(record.exception === undefined ? {} : { exception: record.exception }),
  };
}

test("secret-bearing metadata and exception values never reach sink output", () => {
  for (const c of cases) {
    const output = JSON.stringify(replay(c));
    for (const secret of [
      "synthetic-token",
      "synthetic secret",
      "synthetic secret in deep exception",
      "synthetic-key",
      "synthetic-header",
      "user content",
      "Authorization Bearer synthetic",
      "outer secret.py",
    ]) {
      expect(output).not.toContain(secret);
    }
  }
});

test("native JS error stacks omit messages and full paths", () => {
  const error = new Error("Authorization: Bearer synthetic-token");
  error.name = "RuntimeError";
  error.stack =
    "RuntimeError: Authorization: Bearer synthetic-token\n" +
    "    at load_secret (/private/Authorization Bearer synthetic/secret.py:42:3)\n" +
    "    at nested (bad api key path.py:55:7)";
  const output = safeTraceback(error);

  expect(output).not.toContain("Authorization");
  expect(output).not.toContain("synthetic-token");
  expect(output).not.toContain("/private/");
});

test("even a tiny configured limit bounds one oversized record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recurse-small-log-"));
  const sink = await RotatingFileSink.open(join(directory, "recurse.log"), {
    maxBytes: 10,
    backupCount: 1,
  });
  const target = new RuntimeLogger(
    "recurse.test",
    sink,
    0,
    () => new Date("2024-01-02T03:04:05.000Z"),
  );
  try {
    target.log(20, "x".repeat(20));
    await sink.flush();
    const sizes = await Promise.all(
      (await readdir(directory)).map(
        async (file) => (await stat(join(directory, file))).size,
      ),
    );
    expect(sizes).toEqual([10]);
    await sink.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotating sink retains only bounded active and backup files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recurse-runtime-log-"));
  const path = join(directory, "recurse.log");
  const sink = await RotatingFileSink.open(path, {
    maxBytes: 500,
    backupCount: 2,
  });
  const target = new RuntimeLogger(
    "recurse.test",
    sink,
    0,
    () => new Date("2024-01-02T03:04:05.000Z"),
  );
  try {
    for (let index = 0; index < 12; index += 1) {
      logEvent(target, 20, "rotation_probe", {
        fields: {
          access_token: "Bearer synthetic-token with spaces",
          index,
          state: "x".repeat(60),
        },
      });
    }
    target.log(20, `event=oversize_probe payload=${"λ".repeat(2_000)}`);
    await sink.flush();
    const files = (await readdir(directory)).filter((name) =>
      name.startsWith("recurse.log"),
    );
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    const fileStats = await Promise.all(
      files.map(async (file) => stat(join(directory, file))),
    );
    const persisted = (
      await Promise.all(
        files.map((file) => readFile(join(directory, file), "utf8")),
      )
    ).join("");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(fileStats.every((item) => (item.mode & 0o777) === 0o600)).toBe(true);
    expect(fileStats.every((item) => item.size <= 500)).toBe(true);
    expect(
      fileStats.reduce((sum, item) => sum + item.size, 0),
    ).toBeLessThanOrEqual(3 * 500 + 512);
    expect(persisted).toContain(
      "2024-01-02T03:04:05Z level=INFO logger=recurse.test",
    );
    expect(persisted).toContain("access_token=<redacted>");
    expect(persisted).not.toContain("synthetic-token");
    expect(persisted).toContain("<log record truncated>");
    expect(persisted).not.toContain("�");
    await sink.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
