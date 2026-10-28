// A stdio MCP server for the MCP real-Pi tests and the live E2E; no network.
// Tools: echo (read-only), env (reads one variable), env_names (names only),
// write_note (writes a file), sleep. Flags:
//   --marker=<id>  names this server's processes in /proc cmdlines
//   --stubborn     ignores SIGTERM and stdin EOF, so only SIGKILL ends it
//   --spawn-child  starts a stubborn grandchild in the same process group
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const attempts = argv.find((arg) => arg.startsWith("--attempts="))?.slice(11);
if (attempts) appendFileSync(attempts, "start\n");
if (argv.includes("--exit-17")) {
  process.stderr.write("secret-looking-stderr-should-never-escape\n");
  process.exit(17);
}
const stubborn = argv.includes("--stubborn") || argv.includes("--grandchild");
if (stubborn) process.on("SIGTERM", () => {});
if (argv.includes("--grandchild")) {
  const started = argv
    .find((arg) => arg.startsWith("--started-file="))
    ?.slice(15);
  if (started) writeFileSync(started, "started\n");
  setInterval(() => {}, 1 << 30);
} else serve();

function serve() {
  if (argv.includes("--spawn-child")) {
    const marker = argv.filter((arg) => arg.startsWith("--marker="));
    const script = new URL(import.meta.url).pathname;
    spawn(process.execPath, [script, "--grandchild", ...marker], {
      stdio: "ignore",
    }).unref();
  }
  const note = argv.find((arg) => arg.startsWith("--startup-note="))?.slice(15);
  if (note)
    writeFileSync(
      note,
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        envNames: Object.keys(process.env),
      }),
    );
  const tools = [
    {
      name: "echo",
      description: "Echo text back",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "env",
      description: "Return one environment variable of this server",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "env_names",
      description: "Return this server's environment variable names",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "write_note",
      description: "Write text to a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
    },
    {
      name: "sleep",
      description: "Wait for ms milliseconds",
      inputSchema: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
    },
  ];
  const send = (id, result) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const text = (value) => ({ content: [{ type: "text", text: value }] });
  const call = async ({ name, arguments: input }) => {
    if (name === "echo" && argv.includes("--exit-on-echo")) {
      process.stderr.write("secret-looking-stderr-should-never-escape\n");
      process.exit(17);
    }
    if (name === "echo") return text(`echo:${input.text}`);
    if (name === "env")
      return text(`env:${process.env[input.name] ?? "(unset)"}`);
    if (name === "env_names")
      return text(JSON.stringify(Object.keys(process.env).sort()));
    if (name === "write_note") {
      writeFileSync(input.path, input.text);
      return text(`wrote ${input.path}`);
    }
    if (name === "sleep") {
      await new Promise((resolve) => setTimeout(resolve, input.ms));
      return text("slept");
    }
    return { ...text(`unknown tool ${name}`), isError: true };
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize")
      send(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-probe", version: "1" },
      });
    else if (message.method === "tools/list") {
      const gate = argv
        .find((arg) => arg.startsWith("--list-gate="))
        ?.slice(12);
      while (gate && !existsSync(gate))
        await new Promise((resolve) => setTimeout(resolve, 10));
      send(message.id, { tools });
    } else if (message.method === "tools/call")
      send(message.id, await call(message.params));
    else send(message.id, {});
  });
  lines.on("close", () => {
    if (!stubborn) process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
}
