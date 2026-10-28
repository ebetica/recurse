// Model-bound clock/transforms never alter the transcript. One clock per
// Harness. Pi helpers preserve system positions and substantive assistant
// output.
import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
  AgentDoc,
} from "@earendil-works/pi-durable";
import { applyTimestamps, createTimestampState } from "./timestamps.ts";

export type RequestTransform = (
  messages: Message[],
  provider: string,
) => Message[];

export interface ModelClockOptions {
  after: readonly RequestTransform[];
  now?: () => number;
}

export function createModelClock(options: ModelClockOptions) {
  const clock = createTimestampState();
  const transform = (
    messages: readonly Message[],
    provider: string,
    isolated = false,
    now = (options.now ?? Date.now)(),
  ): Message[] => {
    const state = isolated
      ? { stamps: new Map(clock.stamps), lastSeenMs: clock.lastSeenMs }
      : clock;
    const stamped = applyTimestamps(
      [...messages] as Parameters<typeof applyTimestamps>[0],
      state,
      now,
    );
    return options.after.reduce(
      (messages, after) => after(messages, provider),
      stamped as Message[],
    );
  };
  return {
    transform,
    extensions: [
      defineExtension({
        name: "recurse-request-transforms",
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async ({ messages }, api, context) => {
              const provider = await api.snapshot(
                AgentDoc,
                api.conversationId,
                context,
              );
              return {
                messages: transform(messages, provider?.model?.provider ?? ""),
              };
            },
          }),
        ],
      }),
    ],
  };
}
