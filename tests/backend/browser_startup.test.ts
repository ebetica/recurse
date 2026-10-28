import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  scrubServerLogTail,
  startServer,
  stopServer,
} from "../mobile_browser/common";
import type { AddressInfo } from "node:net";

// Regression: #2484 startup uses an assigned port without disturbing existing listeners.
test("browser server announces its assigned port beside an existing listener", async () => {
  const occupied = createServer((socket) => socket.destroy());
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const port = (occupied.address() as AddressInfo).port;
    const conflict = Bun.spawn(
      [
        process.execPath,
        "-e",
        'Bun.serve({hostname:"127.0.0.1",port:Number(process.argv[1]),fetch:()=>new Response()})',
        String(port),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const stderr = await new Response(conflict.stderr).text();
    expect(await conflict.exited).toBe(1);
    const tail = scrubServerLogTail(stderr.split("\n"));
    expect(tail).toContain("native error: EADDRINUSE");
    expect(tail).not.toContain("Bun.serve");
    running = await startServer();
    expect((await fetch(`${running.base}api/tree`)).status).toBe(200);
    const discovery = JSON.parse(
      await readFile(join(running.data, "data/server.json"), "utf8"),
    );
    expect(discovery.port).toBe(Number(new URL(running.base).port));
    expect(discovery.port).not.toBe(port);
    expect(occupied.listening).toBe(true);
  } finally {
    if (running) await stopServer(running);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  expect(() => process.kill(-running!.process.pid, 0)).toThrow("ESRCH");
}, 60_000);
