import { afterEach, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SessionIndex,
  clearSessionHeaderCache,
} from "../../src/coding_backend/session_index";
import { captureFixture } from "./fixture_subprocess";
import fixture from "./fixtures/session_index/cases.json";

type Spec = Record<string, any>;
interface Case {
  name: string;
  input: {
    spec: Spec[];
  };
}
const cases = fixture.cases as unknown as Case[];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  clearSessionHeaderCache();
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recurse-session-index-"));
  roots.push(root);
  mkdirSync(join(root, "pi_sessions"));
  return root;
}

async function build(root: string, spec: Spec[]): Promise<void> {
  for (const item of spec) {
    const path = join(root, item.path);
    mkdirSync(dirname(path), { recursive: true });
    if (item.kind === "dir") mkdirSync(path, { recursive: true });
    else if (item.kind === "link") symlinkSync(item.target, path);
    else if (item.kind === "hardlink") linkSync(join(root, item.target), path);
    else if (item.kind === "fifo") {
      expect((await captureFixture(["mkfifo", path])).exitCode).toBe(0);
    } else {
      const data =
        "header" in item
          ? Buffer.from(JSON.stringify(item.header) + "\n")
          : "hex" in item
            ? Buffer.from(item.hex, "hex")
            : Buffer.from(
                item.text.replace(
                  "{PAD}",
                  (item.pad_char ?? "p").repeat(item.pad ?? 0),
                ),
              );
      writeFileSync(path, new Uint8Array(data));
    }
  }
}

for (const item of cases.filter((c) => c.name === "conversation_bindings")) {
  test("session bindings require matching file ID and cwd", async () => {
    const root = makeRoot();
    await build(root, item.input.spec);
    const index = new SessionIndex(join(root, "pi_sessions"));
    const path = join(root, "pi_sessions/2026-01-01T00-00-00_s-aaaa.jsonl");
    expect(await index.boundSessionFile("s-bbbb", path, "/w1")).toBeNull();
    expect(await index.boundSessionFile("s-aaaa", path, "/w2")).toBeNull();
    for (const file of item.input.spec) {
      const accepted = join(root, file.path);
      expect(
        await index.boundSessionFile(file.header.id, accepted, file.header.cwd),
      ).toBe(accepted);
    }
  });
}

test("session headers reject lone-surrogate UTF-8", async () => {
  const root = makeRoot();
  const text = '{"type":"session","id":"s-sur","cwd":"/';
  await build(root, [
    {
      path: "pi_sessions/x_s-sur.jsonl",
      kind: "file",
      hex:
        Buffer.from(text).toString("hex") +
        "edb3bf" +
        Buffer.from('"}\n').toString("hex"),
    },
  ]);
  const index = new SessionIndex(join(root, "pi_sessions"));
  const file = join(root, "pi_sessions/x_s-sur.jsonl");
  expect(await index.sessionHeader(file)).toBeNull();
});

test("a replaced session root is not trusted: symlinked store is unavailable", async () => {
  const root = makeRoot();
  await build(root, [
    {
      path: "real/x_s-a.jsonl",
      kind: "file",
      header: { type: "session", id: "s-a", cwd: "/w" },
    },
  ]);
  symlinkSync(join(root, "real"), join(root, "linked"));
  const index = new SessionIndex(join(root, "linked"));
  const file = join(root, "linked/x_s-a.jsonl");
  expect(await index.boundSessionFile("s-a", file, "/w")).toBeNull();
  const direct = new SessionIndex(join(root, "real"));
  const real = join(root, "real/x_s-a.jsonl");
  expect(await direct.boundSessionFile("s-a", real, "/w")).toBe(real);
  const unsafe = cases.find((item) => item.name === "unsafe_leaves")!;
  await build(root, unsafe.input.spec);
  const acceptedSpec = cases.find(
    (item) => item.name === "conversation_bindings",
  )!.input.spec[0];
  await build(root, [acceptedSpec]);
  const leaves = new SessionIndex(join(root, "pi_sessions"));
  const accepted = join(root, acceptedSpec.path);
  expect(
    await leaves.boundSessionFile(
      acceptedSpec.header.id,
      accepted,
      acceptedSpec.header.cwd,
    ),
  ).toBe(accepted);
  for (const item of unsafe.input.spec.filter((file) =>
    file.path.startsWith("pi_sessions/"),
  )) {
    expect(await leaves.sessionHeader(join(root, item.path))).toBeNull();
  }
});

test("the header cache re-reads a rewritten leaf", async () => {
  const root = makeRoot();
  const path = join(root, "pi_sessions", "x_s-c.jsonl");
  writeFileSync(
    path,
    JSON.stringify({ type: "session", id: "s-c", cwd: "/one" }) + "\n",
  );
  const index = new SessionIndex(join(root, "pi_sessions"));
  expect((await index.sessionHeader(path))?.cwd).toBe("/one");
  writeFileSync(
    path,
    JSON.stringify({ type: "session", id: "s-c", cwd: "/two!" }) + "\n",
  );
  expect((await index.sessionHeader(path))?.cwd).toBe("/two!");
  const formats = cases.find((item) => item.name === "header_quirks")!;
  await build(root, formats.input.spec);
  for (const item of formats.input.spec) {
    expect(await index.sessionHeader(join(root, item.path))).not.toBeNull();
  }
  const bom = join(root, formats.input.spec[0].path);
  expect((await index.sessionHeader(bom))?.n).toBeNaN();
  const oversize = cases.find((item) => item.name === "bad_header_oversize")!;
  await build(root, oversize.input.spec);
  expect(
    await index.sessionHeader(join(root, oversize.input.spec[0].path)),
  ).toBeNull();
});
