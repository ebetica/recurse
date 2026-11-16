import { join } from "node:path";
import {
  type AssistantMessage,
  type UserMessage,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type Fixture, type Routes, hex, nowSeconds } from "../fixture";

export function routes(fx: Fixture): Routes {
  const { instance, load, save, rootAgentId, once } = fx;
  const { reads } = instance;
  const {
    create,
    sayDurable,
    sayDurableHistory,
    compactDurableHistory,
    helperApplyClear,
    waitTurn,
  } = fx.agents;
  const { user, toolResult, seedHistory, seedUpload } = fx.history;
  const contextAgents = new Set<string>();
  const realReadContextUsage = reads.readContextUsage.bind(reads);
  reads.readContextUsage = async (cid: string) => {
    const view = await realReadContextUsage(cid);
    if (view && contextAgents.has(cid)) {
      view.model = "openai-codex/gpt-5.6-sol";
      view.model_label = "GPT-5.6 Sol";
      view.usage_model = "openai-codex/gpt-5.6-sol";
      view.context_window = 372_000;
      view.unused_tokens = 30_200;
      view.estimated_tokens = {
        system: 100_000,
        prompts: 20_000,
        messages: 80_000,
        tool_calls: 40_000,
        tool_outputs: 101_800,
      };
    }
    return view;
  };

  return {
    "seed-stale-thread": async () => {
      const cid = rootAgentId();
      await waitTurn(cid);
      const conv = load(cid)!;
      const stale = await seedUpload(
        cid,
        new TextEncoder().encode("stale attachment\n"),
        "stale.txt",
      );
      const marker = `STALE CLEARED ROW #${hex(8)}`;
      await seedHistory(
        cid,
        [
          user(
            `seed stale row\n[stale.txt](/api/conversations/${cid}/attachments/${stale.id})`,
          ),
          fauxAssistantMessage(marker),
        ],
        { replace: true },
      );
      conv.updated = nowSeconds();
      await save(conv);
      return { ok: true, marker };
    },
    "synchronous-clear": async () => {
      if (!(await helperApplyClear(rootAgentId())))
        throw new Error("clear did not land");
      return { ok: true };
    },
    "seed-bulk-thread": async () => {
      const cid = rootAgentId();
      await waitTurn(cid);
      const conv = load(cid)!;
      const stale = await seedUpload(
        cid,
        new TextEncoder().encode("stale attachment\n"),
        "stale.txt",
      );
      const messages: Array<UserMessage | AssistantMessage> = [];
      for (let n = 0; n < 300; n++)
        messages.push(
          user(`bulk filler ${n} ` + "x".repeat(1024)),
          fauxAssistantMessage(`bulk answer ${n} ` + "y".repeat(1024)),
        );
      const marker = `STALE CLEARED ROW #${hex(8)}`;
      messages.push(
        user(
          `seed stale row\n[stale.txt](/api/conversations/${cid}/attachments/${stale.id})`,
        ),
        fauxAssistantMessage(marker),
      );
      await seedHistory(cid, messages, { replace: true });
      conv.updated = nowSeconds();
      await save(conv);
      return { ok: true, marker };
    },
    "seed-reveal-backfill": async () => {
      const cid = `reveal-backfill-${hex(8)}`;
      await create(cid, "Reveal backfill", rootAgentId());
      const commentary =
        "Stage0 reveal-backfill marker: the eye must load this reply.";
      const filler = Array.from(
        { length: 220 },
        (_, n) =>
          `filler line ${n} pads the running tail so the viewport fills. token ${cid} end.`,
      ).join(" ");
      const read = fauxToolCall("read", { path: "web/conversation.ts" });
      const fetch = fauxToolCall("bash", { command: "git fetch origin main" });
      const grep = fauxToolCall("grep", { pattern: "turn-eye" });
      const fetchAgain = fauxToolCall("bash", {
        command: "git fetch origin main",
      });
      const agentNote = (body: string) =>
        `[recurse-origin: agent]\n[recurse-from: kid123]\n[recurse-from-name: Kid]\n${body}`;
      const conv = load(cid)!;
      await seedHistory(
        cid,
        [
          user("Please fix the frontend reveal bug."),
          fauxAssistantMessage(
            [fauxText("Reviewing the reveal path now."), read],
            { stopReason: "toolUse" },
          ),
          toolResult(read, "read ok"),
          fauxAssistantMessage([fauxText(commentary), fetch], {
            stopReason: "toolUse",
          }),
          toolResult(fetch, "fetch ok"),
          user(agentNote("Child report one: baseline green.")),
          fauxAssistantMessage([grep], { stopReason: "toolUse" }),
          toolResult(grep, "grep ok"),
          user(agentNote("Child report two: fixtures ready.")),
          fauxAssistantMessage([fetchAgain], { stopReason: "toolUse" }),
          toolResult(fetchAgain, "fetch ok"),
          fauxAssistantMessage(filler),
        ],
        { replace: true },
      );
      conv.status = "running";
      conv.updated = nowSeconds();
      await save(conv);
      reads.viewCache.drop(cid);
      return { agent: cid };
    },
    "import-recorded-pi": async () => {
      const agent = `imported-pi-${hex(6)}`;
      const result = await instance.durable.importPi(
        {
          id: agent,
          session_id: "recorded-pi",
          session_file: join(
            import.meta.dir,
            "../../fixtures/imported-pi.jsonl",
          ),
        },
        {
          state: () => ({ running: false, queued: 0 }),
          publish: (commit) => commit(),
        },
        new AbortController().signal,
      );
      if (result.status !== "imported") throw new Error(JSON.stringify(result));
      await create(agent, "Imported Pi history");
      return { agent };
    },
    "seed-side-history": async () => {
      const cid = "side-history";
      await create(cid, "Side history");
      for (let n = 0; n < 70; n += 1)
        await sayDurable(
          cid,
          `Side history question ${n}`,
          `Side history answer ${n}`,
        );
      return { agent: cid };
    },
    "seed-durable-history": async (body) => {
      body = body as {
        agent?: string;
        neighbours?: number;
      };
      const cid = body.agent ?? "durable-history";
      await create(cid, "Durable history");
      for (let n = 0; n < (body.neighbours ?? 0); n += 1)
        await create(`${cid}-${n}`, `Neighbour ${n}`, rootAgentId());
      await create(`${cid}-kid`, "Kid", cid);
      for (let n = 0; n < 60; n += 1) await sayDurableHistory(cid, n);
      await compactDurableHistory(cid, "Summary of turns 0-19.");
      for (let n = 60; n < 70; n += 1) await sayDurableHistory(cid, n);
      return { agent: cid };
    },
    "durable-history-more": async (body) => {
      body = body as {
        agent: string;
        from: number;
        to: number;
        compact?: boolean;
        report?: boolean;
      };
      for (let n = body.from; n < body.to; n += 1)
        await sayDurableHistory(body.agent, n, body.report);
      if (body.compact)
        await compactDurableHistory(body.agent, `Summary before ${body.to}.`);
      return { ok: true };
    },
    "seed-context-viewer": async () => {
      const rootId = rootAgentId();
      contextAgents.add(rootId);
      const conv = load(rootId)!;
      await once({ agent: "context-other" }, () =>
        create("context-other", "Context other", rootId),
      );
      conv.model = "openai-codex/gpt-5.6-sol";
      conv.latest_context_usage = {
        input: 41_800,
        output: 1_200,
        cacheRead: 298_000,
        cacheWrite: 2_000,
        selectors: ["openai-codex/gpt-5.6-sol"],
        selectorPartial: false,
      };
      await save(conv);
      await seedHistory(
        rootId,
        [
          user("Browser context category input"),
          fauxAssistantMessage("Browser context category response"),
        ],
        { replace: true },
      );
      return { ok: true };
    },
  };
}
