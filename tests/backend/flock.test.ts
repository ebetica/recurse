import { expect, test } from "bun:test";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flockExclusive, TreeLifecycleBusy } from "../../src/utils/flock";

async function probe(path: string): Promise<boolean> {
  const proc = Bun.spawn(
    process.platform === "darwin"
      ? [
          "perl",
          "-e",
          'open(my $fh, "+<", $ARGV[0]) or die $!; exit(flock($fh, 2 | 4) ? 0 : 1)',
          path,
        ]
      : ["flock", "-n", path, "true"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return (await proc.exited) === 0;
}

test("invalid descriptors fail immediately instead of masquerading as contention", async () => {
  await expect(
    flockExclusive(-1, "invalid", { timeoutMs: 100 }),
  ).rejects.toThrow(/errno 9/);
});

// Regression: #2527 flock diagnostics must not pollute CLI stdout under contention.
test("external and Bun flock holders mutually exclude each other", async () => {
  const root = mkdtempSync(join(tmpdir(), "flock-ts-"));
  const path = join(root, "guard.lock");
  const proc = Bun.spawn(
    process.platform === "darwin"
      ? [
          "perl",
          "-e",
          'open(my $fh, "+>", $ARGV[0]) or die $!; flock($fh, 2) or die $!; $| = 1; print "held\\n"; <STDIN>',
          path,
        ]
      : ["flock", "-x", path, "sh", "-c", "printf 'held\\n'; cat"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "held",
    );
    reader.releaseLock();
    const cli = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { open } from "node:fs/promises";
         import { flockExclusive, TreeLifecycleBusy } from ${JSON.stringify(join(import.meta.dir, "../../src/utils/flock.ts"))};
         const fd = await open(process.argv[1], "r+");
         try {
           await flockExclusive(fd.fd, process.argv[1], { timeoutMs: 45 });
         } catch (error) {
           if (!(error instanceof TreeLifecycleBusy)) throw error;
           console.log("Lock busy.");
         } finally { await fd.close(); }`,
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe("Lock busy.\n");
    expect(stderr).toContain("flock_wait");
    expect(stderr).toContain(path);
    expect(stderr).toContain('outcome: "busy"');
    const fd = await open(path, constants.O_RDWR);
    try {
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 5);
      const events: Array<{ path: string; waitMs: number; outcome: string }> =
        [];
      await expect(
        flockExclusive(fd.fd, path, {
          timeoutMs: 45,
          log: (event) => events.push(event),
        }),
      ).rejects.toBeInstanceOf(TreeLifecycleBusy);
      expect(ticked).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]!.path).toBe(path);
      expect(events[0]!.outcome).toBe("busy");
      console.log("flock refused wait ms", events[0]!.waitMs);
    } finally {
      await fd.close();
    }
    const unlimited = await open(path, constants.O_RDWR);
    try {
      const events: Array<{ path: string; waitMs: number; outcome: string }> =
        [];
      const pending = flockExclusive(unlimited.fd, path, {
        timeoutMs: Infinity,
        log: (event) => events.push(event),
      });
      expect(await probe(path)).toBe(false);
      expect(events).toHaveLength(0);
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const release = await pending;
      release();
      expect(events).toHaveLength(1);
      expect(events[0]!.path).toBe(path);
      expect(events[0]!.outcome).toBe("held");
      console.log("flock acquired wait ms", events[0]!.waitMs);
    } finally {
      await unlimited.close();
    }
    const ours = await open(path, constants.O_RDWR);
    try {
      const release = await flockExclusive(ours.fd, path, { log: () => {} });
      expect(await probe(path)).toBe(false);
      release();
      release();
      expect(await probe(path)).toBe(true);
    } finally {
      await ours.close();
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
