import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TouchedPrs, toolPrs } from "../../src/agents/touched_prs";
import { TaskSet } from "../../src/utils/tasks";
import { fixtureStore } from "./fixtures/conversation_store/spec";
import events from "./fixtures/touched_prs/events.json";
import urls from "./fixtures/touched_prs/urls.json";

const url = "https://github.com/ebetica/recurse/pull/2069";

test("extracts recorded tool arguments/results and explicit gh selectors only", () => {
  for (const event of events) expect(toolPrs(event)).toEqual([url]);
  for (const command of [
    "gh pr view 2069 -R ebetica/recurse --json title,state,url",
    "gh api repos/ebetica/recurse/pulls/2069",
    "gh pr view --repo='ebetica/recurse' 2069",
    "gh pr merge 2069 -Rebetica/recurse",
  ])
    expect(
      toolPrs({ type: "tool_execution_start", args: { command } }),
    ).toEqual([url]);
  expect(
    toolPrs({
      type: "tool_execution_end",
      result: {
        details: {
          calls: [
            { args: { command: "gh pr diff 2069 --repo ebetica/recurse" } },
          ],
        },
      },
    }),
  ).toEqual([url]);
  for (const command of [
    "gh pr view 2069",
    "gh pr comment --repo ebetica/recurse --body 2069",
    "https://github.com/ebetica/recurse/issues/2069",
    "https://github.com.evil/ebetica/recurse/pull/2069",
    "https://github.com/ebetica/recurse/pull/0",
  ])
    expect(
      toolPrs({ type: "tool_execution_start", args: { command } }),
    ).toEqual([]);
  expect(toolPrs({ type: "message_end", message: { content: url } })).toEqual(
    [],
  );
});

test("caps observations and preserves current-ancestor propagation across stale saves", async () => {
  const path = await mkdtemp(join(tmpdir(), "touched-prs-"));
  const store = fixtureStore(path);
  try {
    store.applyAgentMetadata({
      root: { id: "root", model: null },
      parent: { id: "parent", parent: "root", model: null },
      child: { id: "child", parent: "parent", model: null },
      other: { id: "other", model: null },
    });
    const stale = store.load("parent")!;
    const recorder = new TouchedPrs(store, new TaskSet());
    recorder.observe("child", {
      type: "tool_execution_end",
      result: { content: urls },
    });
    await recorder.drain();
    for (const cid of ["child", "parent", "root"])
      expect(store.load(cid)!.touched_prs).toEqual(urls.slice(1));
    await store.save(stale);
    expect(store.load("parent")!.touched_prs).toEqual(urls.slice(1));
    const moved = store.load("child")!;
    moved.parent = "other";
    await store.save(moved);
    recorder.observe("child", events[0]!);
    await recorder.drain();
    expect(store.load("other")!.touched_prs).toEqual([url]);
    expect(store.load("parent")!.touched_prs).toEqual(urls.slice(1));
  } finally {
    await store.agentStore.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("a closed owner cannot strand PR admissions for live conversations", async () => {
  const path = await mkdtemp(join(tmpdir(), "touched-prs-"));
  const store = fixtureStore(path);
  try {
    store.applyAgentMetadata({
      closed: { id: "closed", model: null },
      live: { id: "live", model: null },
    });
    expect(await store.agentStore.close("closed")).toBe(true);
    expect(store.load("closed")).not.toBeNull();
    const recorder = new TouchedPrs(store, new TaskSet());
    recorder.observe("closed", events[0]!);
    await recorder.drain();
    recorder.observe("live", events[0]!);
    await recorder.drain();
    expect(store.load("live")!.touched_prs).toEqual([url]);
  } finally {
    await store.agentStore.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
