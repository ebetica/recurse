import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  retireConversationDetails,
  retireDetached,
} from "../../src/tool_details";

const temp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tool-details-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const owner = (cid: string) =>
  createHash("sha256").update(cid, "utf8").digest("hex");

test("an owner directory is retired to trash; other shapes are left", async () => {
  const details = join(temp, "tool_details");
  const trash = join(temp, "trash");
  mkdirSync(details, { recursive: true });
  mkdirSync(trash, { recursive: true });
  mkdirSync(join(details, owner("dir")));
  writeFileSync(join(details, owner("dir"), "payload"), "x");
  writeFileSync(join(details, owner("file")), "x");
  symlinkSync(join(details, owner("dir")), join(details, owner("link")));

  await retireConversationDetails("file", details, trash);
  await retireConversationDetails("link", details, trash);
  await retireConversationDetails("missing", details, trash);
  await retireConversationDetails("", details, trash);
  await retireConversationDetails("x".repeat(513), details, trash);
  expect(readdirSync(trash)).toEqual([]);

  await retireConversationDetails("dir", details, trash);
  expect(existsSync(join(details, owner("dir")))).toBe(false);
  expect(existsSync(join(details, owner("file")))).toBe(true);
  expect(lstatSync(join(details, owner("link"))).isSymbolicLink()).toBe(true);
  const retired = readdirSync(trash);
  expect(retired.length).toBe(1);
  expect(readFileSync(join(trash, retired[0]!, "payload"), "utf8")).toBe("x");
});

test("retireDetached hands legacy .reap-* directories to trash", async () => {
  const details = join(temp, "detached");
  const trash = join(temp, "detached-trash");
  mkdirSync(trash, { recursive: true });
  expect(await retireDetached(details, trash)).toBe(false);
  mkdirSync(join(details, "keep"), { recursive: true });
  expect(await retireDetached(details, trash)).toBe(false);
  mkdirSync(join(details, ".reap-old"));
  writeFileSync(join(details, ".reap-old", "payload"), "x");
  expect(await retireDetached(details, trash)).toBe(true);
  expect(readdirSync(details)).toEqual(["keep"]);
  expect(readdirSync(trash).length).toBe(1);
});
