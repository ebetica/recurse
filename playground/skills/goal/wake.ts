#!/usr/bin/env bun
// Usage: bun wake.ts <minutes> <message...>
// Print a dated message only when this agent and descendants have no work:
// no turn, queued message or non-monitor shell. Busy rounds print nothing.
// Uses the local v1 idle route and loopback token.

export {};

const [minutes, ...words] = process.argv.slice(2);
const me = process.env.RECURSE_AGENT_ID;
if (!(Number(minutes) > 0) || !words.length || !me) {
  console.error("usage: bun wake.ts <minutes> <message...> (inside an agent)");
  process.exit(2);
}

async function idle(): Promise<boolean> {
  const file = `${process.env.CHAT_DATA_DIR}/server.json`;
  const { port, token } = await Bun.file(file).json();
  const path = `/api/v1/agents/${encodeURIComponent(me!)}/idle`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-loopback-token": token },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const body = await response.json();
  if (typeof body.idle !== "boolean") throw new Error("invalid idle response");
  return body.idle;
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
