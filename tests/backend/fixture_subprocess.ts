import { readdir, readlink } from "node:fs/promises";

async function ps(args: string[]): Promise<string> {
  const child = Bun.spawn(["ps", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    return await Promise.race([
      new Response(child.stdout).text(),
      Bun.sleep(1000).then(() => "ps diagnostic timed out"),
    ]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function describe(pid: number): Promise<string> {
  const rows = (await ps(["-eo", "pid,ppid,pgid"]))
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (const [child, , group] of rows) if (group === pid) ids.add(child!);
  for (;;) {
    const size = ids.size;
    for (const [child, parent] of rows) if (ids.has(parent!)) ids.add(child!);
    if (size === ids.size) break;
  }
  let detail = `process tree:\n${await ps(["-o", "pid,ppid,stat,wchan:32,etime,cmd", "-p", [...ids].join(",")])}`;
  for (const child of ids) {
    const dir = `/proc/${child}/fd`;
    try {
      for (const fd of await readdir(dir))
        detail += `\npid=${child} fd ${fd}: ${await readlink(`${dir}/${fd}`).catch(String)}`;
    } catch (error) {
      detail += `\npid=${child} fd links: ${String(error)}`;
    }
  }
  return detail;
}

export async function captureFixture(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const { timeoutMs = 10_000, input, ...spawn } = options;
  const started = performance.now();
  const child = Bun.spawn(argv, {
    ...spawn,
    detached: true,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([completed, deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (result !== null) {
    const [out, err, exitCode] = result;
    return { exitCode, stdout: Buffer.from(out), stderr: Buffer.from(err) };
  }
  let diagnostic = await Promise.race([
    describe(child.pid),
    Bun.sleep(2000).then(
      () => "process tree: diagnostic deadline reached; fd links unavailable",
    ),
  ]).catch((error) => `process tree: ${String(error)}; fd links unavailable`);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      diagnostic += `\ngroup kill failed: ${String(error)}`;
  }
  await Promise.race([child.exited, Bun.sleep(1000)]);
  throw new Error(
    `fixture command timed out: ${JSON.stringify(argv)} group=${child.pid} elapsed=${Math.round(performance.now() - started)}ms\n${diagnostic}`,
  );
}
