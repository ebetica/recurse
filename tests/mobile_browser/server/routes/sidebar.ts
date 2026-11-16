import { type Fixture, type Routes, hex } from "../fixture";

export function routes(fx: Fixture): Routes {
  const { instance, load, save, rootAgentId } = fx;
  const { conversations } = instance;
  const { create } = fx.agents;
  return {
    "seed-shared-trees": async () => {
      const ids = Array.from({ length: 6 }, () => hex(12));
      for (const [index, id] of ids.entries())
        await save({
          id,
          title: `Shared tree fixture ${index}`,
          parent: index % 2 ? ids[index - 1]! : null,
          updated: Date.now() / 1000 - index,
          backend: "durable",
        });
      return { ids };
    },
    "seed-sidebar-compact": async () => {
      const root = rootAgentId();
      const titles = [
        "Modal deploy tool",
        "Test strict",
        "Pi upgrade",
        "Dev full check",
        "iPhone WebKit tests",
        "Design system audit",
        "Isolated browser check",
        "Deploy verification",
        "Keyboard navigation",
      ];
      for (const [index, title] of titles.entries())
        await save({
          id: `compact-sidebar-${index}`,
          title,
          parent: root,
          updated: Date.now() / 1000 - index,
          backend: "durable",
        });
      return { root };
    },
    "seed-sidebar-order": async (body) => {
      const { phase } = body as { phase: number };
      const now = Date.now() / 1000;
      const operatorAt = now - (phase ? 60 : 300);
      for (const [id, operatorMessageAt, updated] of [
        ["operator-recent", operatorAt, operatorAt],
        ["agent-active", now - 3600, now - 30],
        ["no-operator", null, now - 120],
      ] as const) {
        if (!phase)
          await save({
            id,
            title: id,
            parent: null,
            updated,
            backend: "durable",
          });
        conversations.saveActivity(id, updated, operatorMessageAt ?? undefined);
      }
      return { operator_message_at: operatorAt };
    },
    "seed-sidebar-sections": async () => {
      const now = Date.now() / 1000;
      const rows = {
        fresh: ["Fresh idle", now - 60, "idle"],
        stale: ["Stale idle", now - 3 * 86400, "idle"],
        busy: ["Busy worker", now - 5, "running"],
        archived: ["Archived earlier", now - 7200, "idle"],
      } as const;
      const ids: Record<string, string> = {};
      for (const [key, [title, updated, status]] of Object.entries(rows)) {
        ids[key] = `sections-${key}-${hex(6)}`;
        await create(ids[key], title, null);
        await save({ ...load(ids[key])!, updated, status });
      }
      const child = `sections-child-${hex(6)}`;
      await create(child, "PR child", ids.fresh);
      await conversations.updatePrs(child, () => [
        {
          repo: "ebetica/recurse-dev",
          number: 42,
          url: "https://github.com/ebetica/recurse-dev/pull/42",
          title: "Sidebar fixture",
          state: "open",
          checks: "pass",
          source: "created",
          detected_at: now,
        },
      ]);
      ids.child = child;
      ids.grandchild = `sections-grandchild-${hex(6)}`;
      await create(ids.grandchild, "PR grandchild", child);
      return ids;
    },
    "save-sidebar-script": async (body) => {
      const { script, by } = body as Record<string, string>;
      return { sections: await instance.sidebarScript.set(script!, by!) };
    },
  };
}
