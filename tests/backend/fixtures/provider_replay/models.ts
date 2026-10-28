/** Real built-in Pi transports pointed at sanitized loopback recordings. */
import { createModels, cleanupSessionResources } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { replayProvider, type Recording } from "./server.ts";

export const recordingNames = [
  "openai-codex-sse",
  "openai-codex-auto",
  "anthropic-sse",
  "openai-codex-read",
] as const;
export type RecordingName = (typeof recordingNames)[number];

export async function recordedModels(name: RecordingName, copies = 1) {
  const recording = (await Bun.file(
    new URL(`./${name}.json`, import.meta.url).pathname,
  ).json()) as Recording;
  const replay = replayProvider({
    ...recording,
    exchanges: Array.from({ length: copies }, () => recording.exchanges).flat(),
  });
  const builtin = builtinProviders().find(
    (p) => p.id === recording.model.provider,
  )!;
  const baseUrl =
    replay.baseUrl +
    new URL(recording.model.baseUrl).pathname.replace(/\/$/, "");
  const model = { ...recording.model, baseUrl };
  const apiKey =
    model.provider === "anthropic"
      ? "sk-ant-oat-recorded-test"
      : `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "recorded-test" } })).toString("base64url")}.test`;
  const options = <T extends object>(o: T | undefined) => ({
    ...o,
    apiKey,
    ...(name.startsWith("openai") && name !== "openai-codex-auto"
      ? { transport: "sse" as const }
      : {}),
  });
  const provider = {
    ...builtin,
    baseUrl,
    auth: {
      apiKey: {
        name: "Recorded test",
        resolve: async () => ({ auth: { apiKey }, source: "recorded fixture" }),
      },
    },
    getModels: () => [model],
    stream: (
      m: Parameters<typeof builtin.stream>[0],
      c: Parameters<typeof builtin.stream>[1],
      o: Parameters<typeof builtin.stream>[2],
    ) => builtin.stream({ ...m, baseUrl }, c, options(o)),
    streamSimple: (
      m: Parameters<typeof builtin.streamSimple>[0],
      c: Parameters<typeof builtin.streamSimple>[1],
      o: Parameters<typeof builtin.streamSimple>[2],
    ) => builtin.streamSimple({ ...m, baseUrl }, c, options(o)),
  };
  const models = createModels();
  models.setProvider(provider);
  return {
    models,
    provider,
    replay,
    modelId: `${model.provider}/${model.id}`,
    close: () => {
      cleanupSessionResources();
      replay.server.stop(true);
    },
  };
}
