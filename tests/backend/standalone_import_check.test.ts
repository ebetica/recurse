import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFixture } from "./fixture_subprocess";

// Feature: #3521 the standalone import gate rejects the release regression fixed by #3117.
test("standalone import check rejects the recorded #3116 release import", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "standalone-release-"));
  const check = (entry = "src/release.ts") =>
    captureFixture(
      [
        process.execPath,
        new URL("../checks/standalone_import_check.ts", import.meta.url)
          .pathname,
        entry,
      ],
      { cwd },
    );
  try {
    const release = join(cwd, "src/release.ts");
    const spans = join(cwd, "src/observability");
    await mkdir(spans, { recursive: true });
    await copyFile(new URL("../../src/release.ts", import.meta.url), release);
    await copyFile(
      new URL("../../src/observability/slow-span/span.ts", import.meta.url),
      join(spans, "slow_span.ts"),
    );
    const fixed = await check();
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout.toString()).toContain("1 entrypoint, 0 violations");
    await copyFile(
      new URL("./fixtures/standalone-import/release-3116.txt", import.meta.url),
      release,
    );
    const broken = await check();
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr.toString()).toBe(
      "Standalone import boundary: src/release.ts -> src/observability/slow_span.ts (not an allowed module)\n",
    );
    await Bun.write(
      join(cwd, "src/launch_cli.ts"),
      'import "./local_roots";\n',
    );
    await Bun.write(join(cwd, "src/local_roots.ts"), 'import "./release";\n');
    const transitive = await check("src/launch_cli.ts");
    expect(transitive.exitCode).toBe(1);
    expect(transitive.stderr.toString()).toBe(
      "Standalone import boundary: src/launch_cli.ts -> src/local_roots.ts -> src/release.ts (not an allowed module)\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
