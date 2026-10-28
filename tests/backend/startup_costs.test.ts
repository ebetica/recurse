import { expect, test } from "bun:test";
import { switchoverWorld, until } from "./fixtures/durable_host/host";

test("a slow open reports environment and storage costs with its maintenance owner", async () => {
  const messages: string[] = [];
  const world = await switchoverWorld({
    write: (record) => messages.push(record.message),
  });
  const { instance } = world;
  const cid = "open-costs";
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let guard: Promise<unknown> | undefined;
  try {
    await instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "recurse-test/scripted",
      effort: "off",
      workdir: world.root,
      status: "idle",
    });
    guard = instance.conversations.withTitleGuard(cid, async () => {
      reached();
      await released;
    });
    await held;
    expect(
      instance.lifecycle.launchMaintenanceJob("focused_open", async () => {
        await instance.durable.send(cid, "Report the measured open.", "costs");
        await until(() => instance.durable.runningCount() === 0);
      }),
    ).toBe(true);
    await Bun.sleep(300);
    release();
    await guard;
    await instance.lifecycle.settleMaintenanceJobs();
    expect(world.requests.length).toBeGreaterThan(0);
    const opened = messages.find(
      (message) =>
        message.startsWith("event=durable_open ") &&
        message.includes(`cid=${cid} `),
    );
    for (const name of [
      "env_ms",
      "env_clear_ms",
      "env_dir_ms",
      "env_temp_ms",
      "env_settings_ms",
      "env_safety_ms",
      "env_build_ms",
      "env_files_ms",
      "storage_native_ms",
      "storage_journal_mode_ms",
      "storage_pragmas_ms",
      "storage_stat_ms",
      "storage_migration_ms",
      "storage_metadata_ms",
      "storage_db_bytes",
      "storage_wal_bytes",
    ])
      expect(opened).toMatch(new RegExp(`\\b${name}=\\d+`));
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^event=maintenance_job_slow elapsed_ms=\d+ job=focused_open$/,
      ),
    );
    expect(messages.join("\n")).not.toContain("RECURSE_TEST_KEY");
  } finally {
    release();
    await guard;
    await world.close();
  }
}, 30_000);
