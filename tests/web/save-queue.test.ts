import { expect, test } from "bun:test";
import {
  queueSettingsSave,
  readAfterSettingsSaves,
} from "../../web/settings/save-queue.js";

test("settings saves run in order and reads wait for every queued save", async () => {
  const events: string[] = [];
  const save = (name: string, held: Promise<void> = Promise.resolve()) => {
    return async () => {
      events.push(`${name} sent`);
      await held;
      events.push(`${name} stored`);
    };
  };
  const first = Promise.withResolvers<void>();
  void queueSettingsSave("", save("first", first.promise));
  void queueSettingsSave("", save("second"));
  let reads = 0;
  const read = readAfterSettingsSaves("", async () => {
    events.push("read");
    if (++reads === 1) void queueSettingsSave("", save("during read"));
    return reads;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["first sent"]);
  await queueSettingsSave("Laptop", save("other backend"));
  expect(events).toEqual([
    "first sent",
    "other backend sent",
    "other backend stored",
  ]);
  first.resolve();
  expect(await read).toBe(2);
  expect(events).toEqual([
    "first sent",
    "other backend sent",
    "other backend stored",
    "first stored",
    "second sent",
    "second stored",
    "read",
    "during read sent",
    "during read stored",
    "read",
  ]);
});
