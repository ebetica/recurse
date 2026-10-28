import { expect, test } from "bun:test";
import {
  replayProvider,
  type Recording,
} from "./fixtures/provider_replay/server";

test("WebSocket rejects an invalid protocol frame without replaying output", async () => {
  const recording: Recording = await Bun.file(
    `${import.meta.dir}/fixtures/provider_replay/openai-codex-auto.json`,
  ).json();
  const replay = replayProvider(recording, { timeScale: 0 });
  const exchange = recording.exchanges[0]!;
  const socket = new WebSocket(
    replay.baseUrl.replace("http:", "ws:") + exchange.path,
    { headers: exchange.requestHeaders },
  );
  const received: unknown[] = [];
  socket.addEventListener("message", (event) => received.push(event.data));
  const closed = new Promise<{ code: number }>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ type: "invalid_public_frame" }));
    expect((await closed).code).toBe(1008);
    expect(received).toEqual([]);
    expect(replay.requests).toEqual([]);
    expect(replay.failures).toHaveLength(1);
    expect(replay.failures[0]).toContain("request mismatch: WebSocket type");
  } finally {
    socket.close();
    await replay.server.stop(true);
  }
}, 10000);
