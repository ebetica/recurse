import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_PACKAGE_ROOT } from "../../src/build_dir";

export const modelsJsonEnv = {
  PI_OFFLINE: "1",
  RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
  ANTHROPIC_LOG: "debug",
  OPENAI_LOG: "debug",
  MODELS_JSON_HEADER_SECRET: "env-marker-private",
  ANTHROPIC_API_KEY: "ambient-must-not-authenticate",
  OPENAI_ORG_ID: "ambient-organization-private",
  OPENAI_PROJECT_ID: "ambient-project-private",
  OPENAI_BASE_URL: "http://127.0.0.1:1/ambient-openai",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1/ambient-anthropic",
  OPENAI_API_KEY: "ambient-openai-must-not-authenticate",
  ANTHROPIC_AUTH_TOKEN: "ambient-anthropic-token",
  OPENAI_CUSTOM_HEADERS: "x-ambient-openai: ambient-openai-header-private",
  ANTHROPIC_CUSTOM_HEADERS:
    "x-ambient-anthropic: ambient-anthropic-header-private",
};

export async function modelsJsonWorker() {
  const home = await mkdtemp(join(tmpdir(), "models-json-worker-"));
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("fixtures/models_json_worker.ts", import.meta.url).pathname,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ...modelsJsonEnv,
      },
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ipc() {
        ready.resolve();
      },
    },
  );
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const read = async (reader: (typeof readers)[number]) => {
    let output = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`models.json fixture exited: ${output}`);
      output += decoder.decode(value, { stream: true });
      const marker = /\nMODELS_JSON_DONE=(\d+)\n$/.exec(output);
      if (marker)
        return {
          output: Buffer.from(output.slice(0, marker.index)),
          code: Number(marker[1]),
        };
    }
  };
  const exited = child.exited.then((code) => {
    throw new Error(`models.json worker exited with ${code}`);
  });
  const close = async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await Promise.allSettled([
      child.exited,
      ...readers.map((reader) => reader.cancel()),
    ]);
    await rm(home, { recursive: true, force: true });
  };
  const started = Promise.race([ready.promise, exited]);
  let pending = started;
  return {
    ready: started,
    request(
      fixture: "auth" | "turn" | "review" | "selection",
      options: { input: string; env: NodeJS.ProcessEnv },
    ) {
      const result = pending.then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const completed = Promise.all(readers.map(read));
          child.send({
            fixture,
            input: JSON.parse(options.input),
            env: options.env,
          });
          if (fixture === "auth") child.stdin.write(options.input);
          const [stdout, stderr] = await Promise.race([
            completed,
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                void close();
                reject(new Error("models.json fixture timed out"));
              }, 10_000);
            }),
          ]);
          return {
            exitCode: stdout.code,
            stdout: stdout.output,
            stderr: stderr.output,
          };
        } finally {
          clearTimeout(timer);
        }
      });
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    close,
  };
}
