// Trace main-thread blocking calls and whole captured-request JSON encoding.
// Caller identities skip wall-span wrappers; full stacks retain every frame.
// Other JSON encoding (small metadata, provider bodies) is not this regression.
import { isMainThread } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

if (isMainThread && process.env.RECURSE_BLOCKING_TRACE) {
  Error.stackTraceLimit = 40;
  const root = process.cwd() + "/";
  const sites = new Map<
    string,
    { site: string; count: number; stack: string }
  >();
  let armed = false;
  let recording = false;
  let probing = false;
  const frame = (line: string) =>
    line
      .trim()
      .replaceAll(root, "")
      .replace(/\/[^ ()]*\/node_modules\//g, "node_modules/")
      .replace(/:\d+:\d+(?=\)?$)/, "");
  const record = (api: string) => {
    if (!armed || recording) return;
    recording = true;
    try {
      const stack = new Error().stack ?? "";
      if (
        api === "JSON.stringify" &&
        !probing &&
        !stack.includes("/durable/request_capture.ts:")
      )
        return;
      const frames = stack
        .split("\n")
        .slice(1)
        .filter(
          (line) =>
            !line.includes("blocking_trace_preload.ts") &&
            !line.includes("/observability/slow_span.ts:") &&
            line.includes("/") &&
            !line.includes("node:") &&
            !line.includes("bun:"),
        );
      const applicationIndex = frames.findIndex(
        (line) => !line.includes("/node_modules/"),
      );
      const application = frames[applicationIndex];
      const library = frames
        .slice(0, applicationIndex < 0 ? frames.length : applicationIndex)
        .find((line) => line.includes("/node_modules/"));
      const site = [
        api,
        application ? frame(application) : "<no application frame>",
        library ? frame(library) : "<no library frame>",
      ].join(" | ");
      const previous = sites.get(site);
      if (previous) previous.count++;
      else
        sites.set(site, { site, count: 1, stack: stack.replaceAll(root, "") });
    } finally {
      recording = false;
    }
  };
  const patch = (
    target: Record<string, unknown>,
    name: string,
    prefix: string,
  ) => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      record(`${prefix}.${name}`);
      return Reflect.apply(original, this, args);
    };
    Object.assign(wrapped, original);
    target[name] = wrapped;
  };
  for (const module of ["fs", "child_process"]) {
    const target = require(`node:${module}`) as Record<string, unknown>;
    for (const name of Object.keys(target))
      if (name.endsWith("Sync")) patch(target, name, module);
  }
  patch(
    (require("node:fs") as typeof import("node:fs"))
      .realpathSync as unknown as Record<string, unknown>,
    "native",
    "fs.realpathSync",
  );
  patch(Bun as unknown as Record<string, unknown>, "spawnSync", "Bun");
  for (const name of ["gc", "generateHeapSnapshot"])
    patch(Bun as unknown as Record<string, unknown>, name, "Bun");
  for (const name of [
    "cpuUsage",
    "threadCpuUsage",
    "memoryUsage",
    "resourceUsage",
    "availableMemory",
    "constrainedMemory",
  ])
    patch(process as unknown as Record<string, unknown>, name, "process");
  patch(
    process.memoryUsage as unknown as Record<string, unknown>,
    "rss",
    "process.memoryUsage",
  );
  const os = require("node:os") as Record<string, unknown>;
  for (const name of ["cpus", "freemem", "totalmem", "loadavg"])
    patch(os, name, "os");
  const v8 = require("node:v8") as Record<string, unknown>;
  for (const name of [
    "getHeapStatistics",
    "getHeapSpaceStatistics",
    "getHeapCodeStatistics",
    "getHeapSnapshot",
    "writeHeapSnapshot",
  ])
    patch(v8, name, "v8");
  const stringify = JSON.stringify;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    if (
      value !== null &&
      typeof value === "object" &&
      "model" in value &&
      "context" in value
    )
      record("JSON.stringify");
    return Reflect.apply(stringify, JSON, [value, ...args]);
  } as typeof JSON.stringify;
  syncBuiltinESMExports();
  const fsProbe = await import("node:fs");
  const childProbe = await import("node:child_process");
  const osProbe = await import("node:os");
  process.on("SIGUSR2", () => {
    armed = !armed;
    if (armed) {
      probing = true;
      JSON.stringify({ model: {}, context: {} });
      probing = false;
      fsProbe.readFileSync(import.meta.path);
      childProbe.spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
      Bun.spawnSync([process.execPath, "-e", "0"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      process.cpuUsage();
      process.memoryUsage();
      osProbe.freemem();
      const missing = [
        "JSON.stringify",
        "fs.readFileSync",
        "child_process.spawnSync",
        "Bun.spawnSync",
        "process.cpuUsage",
        "process.memoryUsage",
        "os.freemem",
      ].filter(
        (api) =>
          ![...sites.keys()].some((site) => site.startsWith(`${api} | `)),
      );
      sites.clear();
      void writeFile(
        `${process.env.RECURSE_BLOCKING_TRACE}.armed`,
        missing.length ? `Trace probes failed: ${missing.join(", ")}` : "ready",
      );
    }
    if (!armed)
      void writeFile(
        process.env.RECURSE_BLOCKING_TRACE!,
        JSON.stringify(
          [...sites.values()].sort((a, b) => a.site.localeCompare(b.site)),
          null,
          2,
        ),
      );
  });
}
