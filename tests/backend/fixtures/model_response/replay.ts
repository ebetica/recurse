// Controlled replay: real Anthropic SSE; only the served model id changes.
import { Agent } from "@earendil-works/pi-agent-core";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type {
  AssistantMessage,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
interface Recording {
  provider: string;
  requestedModel: string;
  requestedEffort: ModelThinkingLevel;
  servedModel: string;
  events: { type: string; message?: { model: string } }[];
}

export async function loadRecording(): Promise<Recording> {
  return Bun.file(import.meta.dir + "/anthropic.json").json();
}

export async function replayResponse(downgrade: boolean) {
  const recording = await loadRecording();
  const model = anthropicProvider()
    .getModels()
    .find((item) => item.id === recording.requestedModel)!;
  const events = structuredClone(recording.events);
  if (downgrade)
    events.find((event) => event.type === "message_start")!.message!.model =
      recording.servedModel;
  const sse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel: recording.requestedEffort,
    },
    streamFn: (_model, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "recorded-stream-no-network",
        fetch: (async () =>
          new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      }),
  });
  await agent.prompt("Reply with exactly NORMAL_MODEL_OK. Do not use tools.");
  return agent.state.messages.findLast(
    (message) => message.role === "assistant",
  ) as AssistantMessage;
}
