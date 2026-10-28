#!/usr/bin/env bun
// Usage: bun wake.ts <minutes> <message...>
// Print a dated message only when this agent and descendants have no work:
// no turn, queued message or non-monitor shell. Busy rounds print nothing.
// Uses the local read-only routes and loopback token.

export {};

type Row = {
  id: string;
  parent?: string | null;
  status?: string;
  queued?: number;
  shells?: { mode?: string }[];
};

const [minutes, ...words] = process.argv.slice(2);
const me = process.env.RECURSE_AGENT_ID;
if (!(Number(minutes) > 0) || !words.length || !me) {
  console.error("usage: bun wake.ts <minutes> <message...> (inside an agent)");
  process.exit(2);
}

async function get(path: string): Promise<Row[]> {
  const file = `${process.env.CHAT_DATA_DIR}/server.json`;
  const { port, token } = await Bun.file(file).json();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-loopback-token": token },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body : body.conversations;
}

async function idle(): Promise<boolean> {
  const tree = await get("/api/tree");
  const index = await get("/api/subagent-tool/conversations");
  const mine = new Set([me!]);
  for (let size = 0; size < mine.size; ) {
    size = mine.size;
    for (const row of tree) if (mine.has(row.parent ?? "")) mine.add(row.id);
  }
  const busy = tree.some(
    (row) =>
      mine.has(row.id) &&
      (row.status === "running" ||
        row.status === "interrupting" ||
        (row.id === me && (row.queued ?? 0) > 0)),
  );
  const self = index.find((row) => row.id === me);
  const shells = (self?.shells ?? []).filter((s) => s.mode !== "monitor");
  return !busy && shells.length === 0;
}

while (true) {
  await Bun.sleep(Number(minutes) * 60_000);
  try {
    if (await idle())
      console.log(`${new Date().toISOString()} ${words.join(" ")}`);
  } catch (error) {
    // Invariant: Undated failures coalesce instead of repeatedly waking.
    console.log(`idle check failed: ${String(error)}`);
  }
}
