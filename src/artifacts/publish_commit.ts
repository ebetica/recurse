#!/usr/bin/env bun
// Artifact post-commit entry point: publish the saved commit, then check apps.
// The hook derives ownership from its repository, not the calling agent.
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactError, publish, type AppPage } from "../artifacts";
import { checkPage } from "./check";
import { artifactWorkingPath } from "./working_path";

function errorPayload(error: ArtifactError) {
  return {
    code: error.name.replace(/^Artifact/u, "").toLowerCase(),
    message: error.message,
  };
}
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function publishCommit(path: string): Promise<void> {
  const repo = resolve(path);
  const owner = basename(dirname(repo));
  const id = basename(repo);
  const artifactsDir = dirname(dirname(repo));
  let build: AppPage | null = null;
  const published = await publish(
    {
      artifactsDir,
      trashDir: join(dirname(artifactsDir), "trash"),
    },
    owner,
    id,
    {
      committed: true,
      onBuild: (page) => {
        build = page;
      },
    },
  );
  const page = build as AppPage | null;
  emit({
    command: "publish",
    id,
    title: published.title,
    version: published.version,
    path: artifactWorkingPath(owner, id),
    link: `[${String(published.title).replace(/[\[\]<>\\]/g, "\\$&")}](#artifact=${id})`,
    ...(page ? { checking: true } : {}),
  });
  if (page) {
    const head = { command: "check", id, version: published.version };
    try {
      emit({
        ...head,
        ...(await checkPage(
          page.html,
          page.sourceMap,
          join(tmpdir(), `artifact-check-${id}`),
        )),
      });
    } catch (error) {
      emit({
        ...head,
        ok: false,
        error:
          error instanceof ArtifactError
            ? errorPayload(error)
            : { code: "check", message: "the page could not be checked" },
      });
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("expected repository path");
    await publishCommit(process.argv[2]!);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof ArtifactError ? errorPayload(error) : { code: "internal", message: "artifact publication failed" } })}\n`,
    );
    process.exitCode = 1;
  }
}
