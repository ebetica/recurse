import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import {
  logger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";
import { composeApp, startServer } from "../../src/server";
import { artifactFailure } from "../../src/web/files";
import { jsonResponse, Router } from "../../src/web/router";
import { WorkdirGit } from "../../src/workdir_git";

// Feature: #2778 slow Artifact requests report their real storage/Git phases and safe failure reason.
test("Artifact HTTP accounting includes bounded phases and safe errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "request-timing-"));
  const ctx = {
    artifactsDir: join(root, "artifacts"),
    trashDir: join(root, "trash"),
  };
  const source = join(root, "source.md");
  const records: RuntimeLogRecord[] = [];
  const log = logger("http", { write: (record) => records.push(record) });
  const router = new Router();
  let repo = "";
  const git = new WorkdirGit({
    repoUrl: root,
    repoDir: root,
    dataDir: root,
    env: { PATH: process.env.PATH },
  });
  router.get("/api/conversations/{cid}/diff", async () =>
    jsonResponse(await git.worktreeDiff(repo, "HEAD")),
  );
  router.get("/api/artifacts", async () =>
    jsonResponse(await artifacts.listArtifacts(ctx, "agent-A")),
  );
  router.get("/api/artifacts/{artifact_id}/versions", async (ex) => {
    try {
      return jsonResponse(
        await artifacts.versions(ctx, "agent-A", ex.params.artifact_id!),
      );
    } catch (error) {
      artifactFailure(error);
    }
  });
  router.get("/api/artifacts/{artifact_id}/file", async (ex) => {
    const [, bytes] = await artifacts.fileBytes(
      ctx,
      "agent-A",
      ex.params.artifact_id!,
      "index.md",
    );
    return new Response(new Uint8Array(bytes));
  });
  const server = startServer({
    logger: log,
    handler: composeApp({ router, logger: log }),
  });
  try {
    await writeFile(source, "# Private document contents\n");
    const item = await artifacts.create(ctx, {
      owner: "agent-A",
      title: "Private title",
      source,
    });
    const id = String(item.id);
    repo = String(item.repo_path);
    for (const path of [
      "/api/artifacts",
      `/api/artifacts/${id}/versions`,
      `/api/artifacts/${id}/file`,
      "/api/conversations/agent-A/diff",
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const responses = records.filter((record) =>
      record.message.startsWith("event=http_response"),
    );
    expect(responses).toHaveLength(4);
    expect(responses[0]!.message).toContain("step_artifact_metadata_calls=1");
    expect(responses[0]!.message).toContain("step_artifact_read_file_calls=");
    expect(responses[1]!.message).toContain(
      "step_artifact_git_for_each_ref_calls=1",
    );
    expect(responses[2]!.message).toContain(
      "step_artifact_git_cat_file_calls=1",
    );
    expect(responses[3]!.message).toContain("step_git_rev_parse_calls=");
    await writeFile(
      join(String(item.repo_path), ".git", "hooks", "post-commit"),
      "#!/bin/sh\nexit 0\n",
    );
    const failed = await fetch(`${server.url}/api/artifacts/${id}/versions`);
    expect(failed.status).toBe(409);
    await failed.arrayBuffer();
    const failure = records
      .filter((record) => record.message.startsWith("event=http_response"))
      .at(-1)!.message;
    expect(failure).toContain("artifact_error=ArtifactConflict");
    expect(failure).toContain("artifact_reason=existing_hook");
    expect(failure).toContain("failed_step=artifact_hook");
    for (const record of records) {
      expect(record.message).not.toContain(root);
      expect(record.message).not.toContain("Private");
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
