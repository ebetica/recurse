import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { buildInstance } from "../../src/agents/instance";
import { Config } from "../../src/config";
import { until } from "./fixtures/durable_host/host";
import { seedPiModelList } from "./pi_model_list_fixture";
import { appWorld } from "./web_app_support";

// Feature: #3690 tell the agent about a missing image without starting a turn.
test("a missing reply image adds one platform note for the next turn", async () => {
  const { root, env } = appWorld();
  seedPiModelList(join(root, "data", "config"));
  const instance = await buildInstance({
    config: new Config({ env }),
    sink: { write() {} },
  });
  const { create, delivery, durable } = instance;
  const workdir = join(root, "target");
  const noticeFor = (path: string) =>
    `Images in your last reply could not be opened: "${path}". Check the path, publish the file, or remove the reference.`;
  const notice = noticeFor("missing.png");
  const stamp = (text: string) => `[recurse-origin: platform]\n${text}`;
  const stampedNotice = stamp(notice);
  const nextAnswer = "![Outdated](outdated.png)";
  const newerAnswer = "![Updated](updated.png)";
  const staleReady = Promise.withResolvers<void>();
  const releaseStale = Promise.withResolvers<void>();
  const replyFinished = durable.deps.replyFinished!;
  durable.deps.replyFinished = (cid, text, current, write) =>
    replyFinished(cid, text, current, async (note) => {
      if (note === noticeFor("outdated.png")) {
        staleReady.resolve();
        await releaseStale.promise;
      }
      await write(note);
    });
  const initial = [
    "![Missing](missing.png)",
    "![Local][plot]",
    "![Web](https://example.invalid/plot.svg)",
    "![Inline](data:image/gif;base64,R0lGODlhAQABAAAAACw=)",
    "`![Example](example.png)`",
    "\\(![TeX](math.png)\\)",
    "![Blocked](<java&#9;script:alert>)",
    "",
    "[plot]: <&#32;valid%20plot&amp;legend.svg&#32;>",
  ].join("\n");
  const nextInputs: string[][] = [];
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 6 }, () => (request) => {
      const input = request.messages.at(-1)?.content;
      if (typeof input === "string" && input.includes("Show the plots"))
        return fauxAssistantMessage(
          input.startsWith("[recurse-origin: operator]")
            ? initial
            : "Unexpected origin",
        );
      if (typeof input === "string" && input.includes("turn started"))
        return fauxAssistantMessage("Report received");
      if (
        typeof input === "string" &&
        input.includes("Continue the plot discussion")
      ) {
        nextInputs.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => String(message.content)),
        );
        return fauxAssistantMessage(nextAnswer);
      }
      if (typeof input === "string" && input.includes("Show the updated plot"))
        return fauxAssistantMessage(newerAnswer);
      return fauxAssistantMessage("Unexpected turn");
    }),
  );
  durable.deps.models = models;
  durable.deps.settings = () => ["faux/faux-1", "off"];
  try {
    await writeFile(
      join(workdir, "valid plot&legend.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await instance.start();
    await until(() => instance.lifecycle.readinessSnapshot().ready);
    const parent = String((await create.create({ title: "Parent" })).id);
    const child = String(
      (await create.create({ title: "Plot maker", parent, workdir })).id,
    );
    const rows = async (cid: string) =>
      (await durable.view(cid)).blocks as {
        text: string;
        role: string;
        origin: string;
      }[];
    await delivery.deliver(child, "Show the plots", { origin: "operator" });
    await until(
      async () =>
        (await rows(parent)).some((row) => row.text === "Report received") &&
        !durable.reportHolds.mayHaveUnreportedReply(child),
    );
    await until(() => !instance.tasks.names().includes("reply_image_notice"));
    const childRows = await rows(child);
    expect(
      childRows
        .filter((row) => row.origin === "platform")
        .map((row) => row.text),
    ).toEqual([stampedNotice]);
    expect(durable.reportHolds.settled(child)).toBe(true);
    expect(
      childRows
        .filter((row) => row.role === "assistant")
        .map((row) => row.text),
    ).toEqual([initial]);
    expect(faux.state.callCount).toBe(2);
    const transcript = await durable.transcript(child, { limit: 50 });
    expect(JSON.stringify(transcript)).toContain(JSON.stringify(stampedNotice));
    const parentInputs = (await rows(parent)).filter(
      (row) => row.role === "user",
    );
    expect(parentInputs).toHaveLength(1);
    expect(parentInputs[0]!.text).not.toContain(notice);
    await delivery.deliver(child, "Continue the plot discussion", {
      origin: "operator",
    });
    await until(async () =>
      (await rows(child)).some((row) => row.text === nextAnswer),
    );
    expect(nextInputs).toHaveLength(1);
    expect(
      nextInputs[0]!.filter((text) => text.startsWith(stampedNotice)),
    ).toHaveLength(1);
    await staleReady.promise;
    await delivery.deliver(child, "Show the updated plot", {
      origin: "operator",
    });
    await until(async () =>
      (await rows(child)).some((row) => row.text === newerAnswer),
    );
    releaseStale.resolve();
    const lastNotice = stamp(noticeFor("updated.png"));
    await until(async () =>
      (await rows(child)).some((row) => row.text === lastNotice),
    );
    expect(
      (await rows(child))
        .filter((row) => row.origin === "platform")
        .map((row) => row.text),
    ).toEqual([stampedNotice, lastNotice]);
  } finally {
    releaseStale.resolve();
    await instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
