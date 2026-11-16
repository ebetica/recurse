import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type Fixture, type Routes, hex } from "../fixture";

export function routes(fx: Fixture): Routes {
  const { instance, load, rootAgentId } = fx;
  const { conversations, agentTemp } = instance;
  const {
    hold,
    release,
    script,
    create,
    submitDurable,
    sayDurable,
    appendNative,
  } = fx.agents;
  const { seedUpload } = fx.history;
  const { NAVIGATION_IMAGES } = fx.media;
  return {
    "seed-durable": async () => {
      await create("durable-demo", "Durable demo");
      const held = hold("durable-demo");
      script("durable-demo", 20).setResponses([
        fauxAssistantMessage(
          [
            fauxThinking("**Listing the files**\nI will run a short command."),
            fauxToolCall(
              "bash",
              { command: "printf 'tick 1\\n'; sleep 3; printf 'tick 2\\n'" },
              { id: "durable-bash" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        async () => {
          await held;
          return fauxAssistantMessage(
            [
              fauxText(
                "Durable answer: the command printed two ticks. " +
                  "It ran in the work directory. ".repeat(12) +
                  "This sentence streams slowly so the live answer shows.",
              ),
            ],
            {},
          );
        },
        fauxAssistantMessage("Second durable answer."),
      ]);
      return { agent: "durable-demo" };
    },
    "seed-live-publication": async () => {
      const agent = "live-publication";
      await create(agent, "Live publication");
      await seedUpload(agent, new Uint8Array([1]), "existing.txt");
      const cwd = await mkdtemp(join(tmpdir(), "live-publication-"));
      const paths = Array.from({ length: 5 }, (_, i) =>
        join(cwd, `live-report-${i}.txt`),
      );
      const nested = Array.from({ length: 5 }, (_, i) =>
        join(cwd, `nested-report-${i}.txt`),
      );
      const recovered = join(cwd, "recovered-report.txt");
      for (const path of [...paths, ...nested, recovered])
        await writeFile(path, "Published while the turn is running.\n");
      const gate = join(cwd, "advance");
      const finish = join(cwd, "release");
      const started = join(cwd, "started");
      void hold(agent, "advance", () => writeFile(gate, "advance"));
      void hold(agent, "finish", async () => {
        await release(agent, "advance");
        await writeFile(finish, "release");
      });
      const wait = (path: string) =>
        `while [ ! -e ${JSON.stringify(path)} ]; do sleep 0.05; done`;
      script(agent).setResponses([
        fauxAssistantMessage([fauxToolCall("publish", { paths })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `const held = tools.bash({command:${JSON.stringify(`touch ${JSON.stringify(started)}; ${wait(gate)}`)}}); await tools.bash({command:${JSON.stringify(wait(started))}}); await tools.publish({paths:${JSON.stringify(nested)}}); await held; await tools.publish({paths:[${JSON.stringify(recovered)}]}); await tools.bash({command:${JSON.stringify(wait(finish))}});`,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Publication finished."),
      ]);
      await instance.durable.setSafetyReviewOff(agent, true);
      return { agent };
    },
    "seed-visible-attachments": async () => {
      const agent = "visible-attachments";
      await create(agent, "Visible attachments");
      const conv = load(agent)!;
      const image = await seedUpload(
        agent,
        NAVIGATION_IMAGES[0],
        "report-image.png",
      );
      script(agent).setResponses([
        fauxAssistantMessage("I will collect reports."),
        ...["first-report.txt", "second-report.txt"].flatMap((name) => [
          fauxAssistantMessage(
            [
              fauxText(`Preparing ${name}.`),
              fauxToolCall("write", {
                path: name,
                content: "Published report\n",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxToolCall("publish", { paths: [name] })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(`${name} is ready.`),
        ]),
      ]);
      await appendNative(conv, "Collect reports.", "I will collect reports.");
      for (const name of ["first-report.txt", "second-report.txt"])
        await submitDurable(
          agent,
          `[recurse-origin: ${name.startsWith("first") ? "agent" : "platform"}]\n[recurse-from: child]\n![${name} image](/api/conversations/${agent}/attachments/${image.id})`,
        );
      return { agent };
    },
    "seed-folded-images": async () => {
      const agent = "folded-images";
      await create(agent, "Folded images");
      const image = await seedUpload(agent, NAVIGATION_IMAGES[0], "folded.png");
      const href = `/api/conversations/${agent}/attachments/${image.id}`;
      for (const origin of ["operator", "platform"]) {
        script(agent).setResponses([
          ...["first", "middle", "last"].map((part) =>
            fauxAssistantMessage(
              [
                fauxText(
                  `Hidden ${origin} ${part} prose.\n\n` +
                    (part === "middle"
                      ? `![${origin}-${part}][shot]\n\n[shot]: ${href}`
                      : `![${origin}-${part}](${href})`),
                ),
                fauxToolCall("bash", { command: "printf image-step" }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          fauxAssistantMessage(`${origin} images finished.`),
        ]);
        await submitDurable(
          agent,
          `[recurse-origin: ${origin}]\nShow the images.`,
        );
      }
      return { agent };
    },
    "seed-durable-queued-agent": async () => {
      await create("durable-queued", "Queued repro");
      const call = fauxToolCall("bash", { command: "sleep 8" });
      script("durable-queued").setResponses([
        fauxAssistantMessage([call], { stopReason: "toolUse" }),
        fauxAssistantMessage("PARENT_COMPLETE"),
      ]);
      return { agent: "durable-queued", sender: rootAgentId() };
    },
    "durable-platform-note": async () => {
      await instance.durable.send(
        "durable-queued",
        "[recurse-origin: platform]\nA platform update is waiting for the next boundary.",
        "queued-platform",
      );
      return { ok: true };
    },
    "seed-durable-inspector": async () => {
      const agent = "durable-inspector";
      await create(agent, "Inspector child");
      let delivered: unknown;
      script(agent).setResponses([
        (request) => {
          delivered = request.messages.find(
            (message) => message.role === "user",
          )?.content;
          return fauxAssistantMessage("Parent input received.");
        },
      ]);
      await instance.delivery.deliver(agent, "INSPECT_PARENT_INPUT", {
        origin: "agent",
        sender: rootAgentId(),
      });
      const end = Date.now() + 10000;
      while (delivered === undefined && Date.now() < end) await Bun.sleep(20);
      if (delivered === undefined)
        throw new Error("Parent input was not delivered");
      const { conversation } = await instance.durable.open(agent);
      const entries = await conversation.entries(
        {},
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const stored = entries.items.find(
        (entry) => entry.model?.[0]?.role === "user",
      )?.model?.[0]?.content;
      return { agent, delivered, stored };
    },
    "server-log": async () => {
      console.log("browser server stdout probe");
      console.error("browser server stderr probe");
      return { ok: true };
    },
    "seed-durable-thinking": async (body) => {
      const agent = body.agent ?? "durable-thinking";
      const recorded = await import("../../fixtures/thinking-stream.json");
      await create(agent, "Thinking stream");
      const held = hold(agent);
      script(agent, undefined, hold(agent, "commit")).setResponses([
        fauxAssistantMessage(
          [
            fauxThinking(recorded.thinking),
            fauxToolCall(
              "bash",
              { command: recorded.command },
              { id: "thinking-bash" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        async () => {
          await held;
          return fauxAssistantMessage(
            [
              fauxThinking(recorded.thinking),
              fauxToolCall(
                "bash",
                { command: "sleep 20" },
                { id: "thinking-bash" },
              ),
            ],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("Thinking stream finished."),
      ]);
      return { agent };
    },
    "durable-thinking-cleanup": async (body) => {
      const agent = body.agent ?? "durable-thinking";
      await release(agent, "commit");
      await release(agent);
      await release(agent, "finish");
      await instance.durable.stop(agent);
      await instance.durable.stopProcesses(agent);
      return { ok: true };
    },
    "seed-durable-clear": async () => {
      await create("durable-clear", "Durable clear");
      script("durable-clear").setResponses([
        fauxAssistantMessage("Before Durable clear."),
        fauxAssistantMessage("After Durable clear."),
      ]);
      return { agent: "durable-clear" };
    },
    "seed-durable-rejected": async (body) => {
      const agent = body.agent;
      const failure =
        body.kind === "overloaded"
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage:
                '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            })
          : {
              ...fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: "The model refused to complete the request",
              }),
              rawStopReason: "refusal",
            };
      await create(agent, "Durable rejected");
      script(agent).setResponses([
        fauxAssistantMessage("First answer."),
        ...Array.from(
          { length: body.kind === "overloaded" ? 4 : 1 },
          () => failure,
        ),
        (context) =>
          fauxAssistantMessage(
            JSON.stringify(context.messages).includes("Rejected question")
              ? "The rejected question is in my context."
              : "The rejected question is not in my context.",
          ),
      ]);
      return { agent };
    },
    "seed-script-read-diagnostics": async () => {
      const agent = `script-read-${hex(4)}`;
      await writeFile(
        join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            probe: {
              command: process.execPath,
              args: [
                join(
                  import.meta.dir,
                  "../../../backend/fixtures/mcp_probe_server.mjs",
                ),
              ],
            },
          },
        }),
      );
      await create(agent, "Script and read diagnostics");
      await instance.durable.setSafetyReviewOff(agent, true);
      const file = join(
        await mkdtemp(join(tmpdir(), "read-diagnostics-")),
        "note.txt",
      );
      await writeFile(file, "first\nsecond\nthird\n");
      script(agent).setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("read", { path: file, limit: 1 }),
            fauxToolCall("codemode", {
              code: `await tools.write({ path: ${JSON.stringify(file)}, content: 'written'.repeat(100) }); await tools.bash({ command: 'printf nested' }); for (let i = 0; i < 101; i++) await tools.mcp__probe__echo({ text: 'nested' }); await tools.bash({ command: 'printf tail' });`,
            }),
            fauxToolCall("codemode", { code: "return 'no nested calls'" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Script and read finished."),
      ]);
      return { agent };
    },
    "clear-script-read-diagnostics": async (body) => {
      const { agent } = body as { agent: string };
      if (!(await instance.durable.retire(agent)))
        throw new Error("Script host did not retire");
      await writeFile(
        join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
        JSON.stringify({ mcpServers: {} }),
      );
      return { ok: true };
    },
    "seed-live-tools": async (body) => {
      const { mode = "long", thinking } = body as {
        mode?: string;
        thinking?:
          | "claude"
          | "claude-redacted"
          | "chatgpt"
          | "chatgpt-encrypted";
      };
      const agent = `live-tools-${mode}-${hex(4)}`;
      await create(agent, "Live tools");
      const outputGate =
        thinking || mode.includes("output")
          ? join(
              await agentTemp.agentTempPath(conversations.load(agent)!),
              "live-output-ready",
            )
          : undefined;
      const commands = thinking
        ? ["sleep 30", `while [ ! -f '${outputGate}' ]; do sleep 0.05; done`]
        : mode.includes("output")
          ? Array.from(
              {
                length:
                  mode === "many-output"
                    ? 3
                    : mode === "background-output"
                      ? 2
                      : 1,
              },
              (_, i) =>
                `printf '%020000d\\n' 0; printf 'line-%s\\n' 1 2 3 4 5 6 7 8 9; while [ ! -f '${outputGate!.replaceAll("'", "'\\''")}' ]; do sleep 0.05; done; printf '${mode === "secret-output" ? "token=sk-example123456789" : `latest-${i}`}\\n'; sleep 30 # ${"safe ".repeat(430)}END_OF_COMMAND`,
            )
          : ["sleep 30"];
      const held = hold(agent);
      const finished = hold(agent, "finish");
      script(agent).setResponses([
        fauxAssistantMessage(
          [
            ...(thinking
              ? [
                  {
                    ...fauxThinking(
                      thinking.includes("redacted") ||
                        thinking.includes("encrypted")
                        ? ""
                        : "**Checking the background work**\nI am waiting for the command to finish before checking its result.",
                    ),
                    ...(thinking.startsWith("chatgpt")
                      ? {
                          thinkingSignature: JSON.stringify({
                            type: "reasoning",
                            id: "rs_last_thinking",
                            encrypted_content: "test-encrypted-reasoning",
                            summary: [],
                          }),
                        }
                      : {
                          thinkingSignature: "test-claude-signature",
                          ...(thinking === "claude-redacted"
                            ? { redacted: true }
                            : {}),
                        }),
                  },
                ]
              : []),
            ...commands.map((command, i) =>
              fauxToolCall("bash", {
                command,
                ...((thinking || mode === "background-output") && i === 0
                  ? { background: true }
                  : {}),
              }),
            ),
          ],
          { stopReason: "toolUse" },
        ),
        () =>
          held.then(() =>
            thinking
              ? fauxAssistantMessage(
                  [
                    fauxThinking(
                      "**Reviewing the command result**\nThe command finished; I am checking the result.",
                    ),
                    fauxToolCall("bash", {
                      command: "sleep 30",
                      background: true,
                    }),
                  ],
                  { stopReason: "toolUse" },
                )
              : fauxAssistantMessage("Live tools finished."),
          ),
        () => finished.then(() => fauxAssistantMessage("Live tools finished.")),
      ]);
      return { agent, outputGate };
    },
    "seed-durable-stop": async (body) => {
      const agent = body.agent ?? "durable-stop";
      await create(agent, "Durable stop");
      const call = fauxToolCall("bash", { command: "sleep 31.25" });
      const toolUse = { stopReason: "toolUse" } as const;
      script(agent).setResponses([
        fauxAssistantMessage([call], toolUse),
        (_context, options) => {
          const signal = options?.signal;
          if (!signal) throw new Error("Stop fixture requires an abort signal");
          return new Promise<ReturnType<typeof fauxAssistantMessage>>(
            (resolve) => {
              const aborted = () =>
                resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
              if (signal.aborted) aborted();
              else signal.addEventListener("abort", aborted, { once: true });
            },
          );
        },
      ]);
      return { agent };
    },
    release: async (body) => {
      const { agent, gate } = body as {
        agent: string;
        gate?: string;
      };
      await release(agent, gate);
      return { ok: true };
    },
    "seed-scroll-pin": async (body) => {
      body = body as {
        tokensPerSecond?: number;
        history?: boolean;
      };
      const agent = `scroll-pin-${hex(4)}`;
      await create(agent, "Scroll pin");
      for (let n = 0; n < (body.history === false ? 0 : 6); n += 1)
        await appendNative(
          load(agent)!,
          `History question ${n}`,
          `History answer ${n}. ${"Earlier context fills the thread. ".repeat(24)}`,
        );
      const faux = script(agent, body.tokensPerSecond);
      const gates = [0, 1, 2, 3, 4].map(() => hold(agent));
      const reply = (label: string) =>
        Array.from(
          { length: 10 },
          (_, n) =>
            `${label} paragraph ${n + 1}. ${"The reply keeps streaming below the message. ".repeat(5)}`,
        ).join("\n\n");
      const part = (label: string, gate?: Promise<void>) => async () => {
        await gate;
        return fauxAssistantMessage(
          [fauxText(reply(label)), fauxToolCall("bash", { command: "true" })],
          { stopReason: "toolUse" },
        );
      };
      faux.setResponses([
        fauxAssistantMessage(
          [fauxText("Short reply."), fauxToolCall("bash", { command: "true" })],
          { stopReason: "toolUse" },
        ),
        part("First", gates[0]),
        part("Second", gates[1]),
        part("Third", gates[2]),
        async () => {
          await gates[3];
          return fauxAssistantMessage("Scroll pin finished.");
        },
        ...Array.from({ length: 6 }, () => async (context: any) => {
          if (!JSON.stringify(context.messages.at(-1)).includes("Continue."))
            return fauxAssistantMessage("Answered.");
          await gates[4];
          return fauxAssistantMessage(reply("Handoff"));
        }),
      ]);
      return { agent };
    },
    "forget-conversation-request": async (body) => {
      const { agent } = body as { agent: string };
      (await instance.durable.open(agent)).captures.forget(agent);
      return { ok: true };
    },
    "seed-durable-compactable": async () => {
      const cid = "durable-compactable";
      await create(cid, "Durable compactable");
      for (let n = 0; n < 30; n += 1)
        await sayDurable(cid, `Task ${n} ${"y".repeat(4000)}`, `Reply ${n}`);
      const held = hold(cid);
      script(cid).setResponses([
        async () => {
          await held;
          return fauxAssistantMessage("Summary of the early tasks.");
        },
      ]);
      return { agent: cid };
    },
  };
}
