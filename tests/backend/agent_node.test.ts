import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cancelled, abortable } from "../../src/utils/tasks";
import { buildWorld } from "./fixtures/agent_node/world";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function unitWorld() {
  const root = mkdtempSync(join(tmpdir(), "agent-node-unit-"));
  roots.push(root);
  const world = buildWorld({
    root,
    sink: { write: () => {} },
    scheduler: null,
  });
  return { root, world };
}

test("agent_node: cancelDrive aborts and joins; reap fences new admission", async () => {
  const { world } = unitWorld();
  const cid = "cancel-reap-node";
  await world.conversations.save({ id: cid, title: "t" });
  const node = world.nodes.node(cid, world.agentStore);
  node.submit("submission", { role: "user", content: "x", id: "m-x" });

  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const task = node.startDrive(async (signal) => {
    entered();
    await abortable(new Promise<never>(() => {}), signal);
  });
  await started;
  expect(node.cancelDrive()).toBe(task);
  await expect(task).rejects.toBeInstanceOf(Cancelled);
  expect(node.turnTask).toBeNull();
  expect(node.pendingIntents().map((entry) => entry.id)).toEqual(["m-x"]);

  let reapEntered!: () => void;
  const waiting = new Promise<void>((resolve) => (reapEntered = resolve));
  const reapTask = node.startDrive(async (signal) => {
    reapEntered();
    await abortable(new Promise<never>(() => {}), signal);
  });
  await waiting;
  expect(node.beginReap()).toBe(true);
  expect(node.submit("submission", { id: "m-y" })).toBeNull();
  expect(await node.quiesceMember()).toEqual([true, null]);
  await expect(reapTask).rejects.toBeInstanceOf(Cancelled);
  expect(node.turnTask).toBeNull();
  expect(node.pendingIntents().map((entry) => entry.id)).toEqual(["m-x"]);
});
