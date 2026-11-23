// Recorded model identities shared by safety tests with simulated transports.
import promptRecording from "./durable_host/prompt-sections.json";
import rowRecording from "./durable_rows/recorded.json";
import codexRecording from "./provider_replay/openai-codex-sse.json";
import type { Recording } from "./provider_replay/server";

export const recordedActor = promptRecording.model;
export const recordedLuna = codexRecording.model as Recording["model"];
export const recordedSonnet = rowRecording.entries
  .map((entry) => entry.model)
  .flat()
  .flatMap((message) =>
    message.role === "assistant" &&
    "model" in message &&
    "provider" in message &&
    message.provider === recordedActor.provider
      ? [{ provider: message.provider, id: message.model }]
      : [],
  )[0]!;
