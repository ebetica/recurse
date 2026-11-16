import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BackendKeys } from "../../src/auth/backend_keys";
import { OperatorAuth } from "../../src/auth/session";
import { ServiceAuth } from "../../src/auth/service";
import { FffWorker } from "../../src/extensions/extra/fff/fff_worker";
import { logger } from "../../src/observability/runtime_logging";
import { composeApp, startServer } from "../../src/server";
import { registerExplorerRoutes } from "../../src/web/explorer";
import {
  EXPLORER_EDIT_BYTES,
  type ExplorerPreview,
} from "../../src/web/explorer_io";
import { publishLoopbackToken, requestAuth } from "../../src/web/request_auth";
import { Router } from "../../src/web/router";
import { fauxHost } from "./fixtures/durable_host/host";

type EditPreview = ExplorerPreview & {
  canonicalPath: string;
  promptResource: boolean;
};

async function editor() {
  const dir = await mkdtemp(join(tmpdir(), "http-explorer-edit-"));
  const state = join(dir, "state");
  await mkdir(state);
  const { host, work } = fauxHost(join(dir, "host"));
  const router = new Router();
  const io = registerExplorerRoutes(router, {
    cwd: async (cid) => (cid === "c1" ? work : null),
    search: (cid, cwd, query, signal) =>
      host.searchService(FffWorker).fileNames(cid, cwd, query, signal),
  });
  const sink = { write() {} };
  const running = startServer({
    port: 0,
    handler: composeApp({
      router,
      logger: logger("http", sink),
      summaryInterval: 0,
      compression: { enabled: true },
      auth: requestAuth({
        operator: new OperatorAuth({
          authFile: join(state, "auth.json"),
          env: {},
          displayName: "Recurse",
        }),
        backendKeys: new BackendKeys(state),
        service: new ServiceAuth({
          principalsFile: join(state, "principals.json"),
          tokenFile: null,
        }),
        loopbackToken: await publishLoopbackToken(state, 0),
        serviceOwns: async () => false,
        logger: logger("web", sink),
      }),
    }),
    logger: logger("web", sink),
  });
  const url = `http://127.0.0.1:${running.port}/api/conversations/c1/tree/file`;
  return {
    dir,
    work,
    async preview(path: string): Promise<EditPreview> {
      const response = await fetch(`${url}?${new URLSearchParams({ path })}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<EditPreview>;
    },
    put(
      query: Record<string, string>,
      body: string | Uint8Array,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${url}?${new URLSearchParams(query)}`, {
        method: "PUT",
        body,
        headers,
      });
    },
    async close() {
      await running.close();
      await io.close();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Regression: #3384 previews identify the final destination through file and directory symlinks.
test("Explorer previews canonical destinations before saving through aliases", async () => {
  const edit = await editor();
  try {
    const destination = join(edit.dir, "destination");
    await mkdir(destination);
    await writeFile(join(destination, "secret.env"), "fixture\n");
    await symlink(
      join(destination, "secret.env"),
      join(edit.work, "file-link"),
    );
    await symlink(destination, join(edit.work, "directory-link"));
    const canonical = await realpath(destination);
    for (const [path, target] of [
      ["file-link", "secret.env"],
      ["directory-link/secret.env", "secret.env"],
      ["directory-link/new.env", "new.env"],
    ]) {
      const preview = await edit.preview(path!);
      expect(preview.canonicalPath).toBe(join(canonical, target!));
      const saved = await edit.put(
        {
          path: path!,
          canonicalPath: preview.canonicalPath,
          version: preview.version,
        },
        "saved fixture\n",
      );
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as EditPreview).canonicalPath).toBe(
        preview.canonicalPath,
      );
      expect(await readFile(join(destination, target!), "utf8")).toBe(
        "saved fixture\n",
      );
    }
  } finally {
    await edit.close();
  }
});

// Regression: #3384 overwrite cannot redirect a save after a symlink destination changes.
test("Explorer refuses changed canonical destinations even with overwrite", async () => {
  const edit = await editor();
  try {
    for (const name of ["before", "after"]) {
      await mkdir(join(edit.dir, name));
      await writeFile(join(edit.dir, name, "secret.env"), `${name}\n`);
    }
    const statuses: number[] = [];
    const details: string[] = [];
    for (const directory of [false, true]) {
      const alias = join(edit.work, directory ? "directory-link" : "file-link");
      const path = directory ? "directory-link/secret.env" : "file-link";
      await symlink(
        join(edit.dir, "before", ...(directory ? [] : ["secret.env"])),
        alias,
      );
      const preview = await edit.preview(path);
      const canonicalPath = await realpath(join(edit.work, path));
      await unlink(alias);
      await symlink(
        join(edit.dir, "after", ...(directory ? [] : ["secret.env"])),
        alias,
      );
      const response = await edit.put(
        { path, canonicalPath, version: preview.version, overwrite: "true" },
        "redirected write\n",
      );
      statuses.push(response.status);
      details.push(await response.text());
    }
    expect(statuses).toEqual([409, 409]);
    for (const detail of details)
      expect(detail).toMatch(/destination.*changed/i);
    for (const name of ["before", "after"])
      expect(await readFile(join(edit.dir, name, "secret.env"), "utf8")).toBe(
        `${name}\n`,
      );
  } finally {
    await edit.close();
  }
});

// Regression: #3384 prompt warnings include imports and all Markdown files.
test("Explorer identifies instruction files and recursively imported prompt resources", async () => {
  const edit = await editor();
  try {
    await mkdir(join(edit.work, "docs"));
    await writeFile(
      join(edit.work, "AGENTS.md"),
      "Instructions\n@docs/imported.md\n`@unrelated.md`\n",
    );
    await writeFile(join(edit.work, "docs/imported.md"), "@nested.md\n");
    await writeFile(join(edit.work, "docs/nested.md"), "Nested instructions\n");
    await writeFile(join(edit.work, "unrelated.md"), "Not imported\n");
    await writeFile(join(edit.work, "private.txt"), "Not imported\n");
    await writeFile(join(edit.work, "x.markdown."), "Not imported\n");
    await symlink(join(edit.work, "private.txt"), join(edit.work, "notes.MD"));
    await symlink(
      join(edit.work, "docs/imported.md"),
      join(edit.work, "alias"),
    );
    const paths = [
      "AGENTS.md",
      "docs/imported.md",
      "docs/nested.md",
      "alias",
      "unrelated.md",
      "docs/MISSING.Md",
      "notes.MD",
      "x.markdown.",
      "docs/MISSING.mdx.",
    ];
    const flags: boolean[] = [];
    for (const path of paths)
      flags.push((await edit.preview(path)).promptResource);
    expect(flags).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  } finally {
    await edit.close();
  }
});

// Regression: #3384 compressed edit limits precede gzip integrity checks and full decoding.
test("Explorer rejects oversized decoded gzip before checking its corrupt trailer", async () => {
  const edit = await editor();
  try {
    const path = join(edit.work, "secret.env");
    await writeFile(path, "unchanged\n");
    const body = gzipSync("x".repeat(EXPLORER_EDIT_BYTES + 1));
    body[body.length - 8] = body[body.length - 8]! ^ 0xff;
    expect(body.length).toBeLessThan(EXPLORER_EDIT_BYTES);
    const response = await edit.put(
      { path, canonicalPath: await realpath(path), overwrite: "true" },
      new Uint8Array(body),
      { "content-encoding": "gzip" },
    );
    expect(response.status).toBe(413);
    expect(await readFile(path, "utf8")).toBe("unchanged\n");
  } finally {
    await edit.close();
  }
});

// Regression: #3384 new editor files are private while existing permissions survive saves.
test("Explorer creates files with mode 0600 and preserves existing modes", async () => {
  const edit = await editor();
  try {
    const path = join(edit.work, "secret.env");
    const canonicalPath = join(await realpath(edit.work), "secret.env");
    const created = await edit.put({ path, canonicalPath }, "fixture\n");
    expect(created.status).toBe(200);
    const createdMode = (await stat(path)).mode & 0o777;
    await chmod(path, 0o640);
    const preview = await edit.preview(path);
    const saved = await edit.put(
      { path, canonicalPath, version: preview.version },
      "updated fixture\n",
    );
    expect(saved.status).toBe(200);
    expect([createdMode, (await stat(path)).mode & 0o777]).toEqual([
      0o600, 0o640,
    ]);
    expect(await readFile(path, "utf8")).toBe("updated fixture\n");
  } finally {
    await edit.close();
  }
});
