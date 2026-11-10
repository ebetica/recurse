import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BackendKeys } from "../../src/auth/backend_keys";
import { OperatorAuth } from "../../src/auth/session";
import { ServiceAuth } from "../../src/auth/service";
import { FffWorker } from "../../src/extensions/extra/fff/fff_worker";
import { logger } from "../../src/observability/runtime_logging";
import { composeApp, startServer } from "../../src/server";
import { registerExplorerRoutes } from "../../src/web/explorer";
import {
  EXPLORER_CHUNK_BYTES,
  EXPLORER_PAGE_SIZE,
  type ExplorerListing,
  type ExplorerPreview,
} from "../../src/web/explorer_io";
import { publishLoopbackToken, requestAuth } from "../../src/web/request_auth";
import { Router } from "../../src/web/router";
import { captureFixture } from "./fixture_subprocess";
import { fauxHost, idle, until } from "./fixtures/durable_host/host";
import { exchange, normalise, requestBytes } from "./http_corpus";

// Feature: #3168 Explorer pages folders and refuses private or escaped paths.
test("operator Explorer reads only the current folder with bounded pages and previews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "http-explorer-"));
  const state = join(dir, "state");
  const settings = join(dir, "settings");
  const privateWorktree = join(state, "worktrees", "demo", "settings");
  await mkdir(state);
  const { host, faux, work, records } = fauxHost(join(dir, "host"));
  records.repo = { id: "repo", backend: "durable", workdir: process.cwd() };
  const roots = new Map([
    ["state", state],
    ["worktree", join(state, "worktrees", "demo")],
    ["other", work],
    ["unmanaged", join(state, "worktrees", "unmanaged")],
    ["home", dir],
    ["settings", settings],
    ["settings-alias", join(dir, "settings-alias")],
    ["private-worktree", privateWorktree],
  ]);
  const keys = new BackendKeys(state);
  const remote = await keys.mint("remote");
  const token = await publishLoopbackToken(state, 0);
  const serviceToken = "explorer-service-fixture";
  const serviceTokenFile = join(state, "service-token");
  await writeFile(serviceTokenFile, serviceToken);
  await writeFile(
    join(state, "principals.json"),
    JSON.stringify({
      test: { token_file: serviceTokenFile, scopes: ["conversation.read"] },
    }),
  );
  const router = new Router();
  const nativeResults = new Map<string, string[]>();
  const io = registerExplorerRoutes(router, {
    dataDir: state,
    privateRoots: [settings, join(settings, "pi-agent"), privateWorktree],
    cwd: async (cid) =>
      records[cid]
        ? (await host.effectiveCwd(cid)) || String(records[cid]!.workdir)
        : (roots.get(cid) ?? null),
    search: async (cid, cwd, query, signal) => {
      const found = await host
        .searchService(FffWorker)
        .fileNames(cid, cwd, query, signal);
      nativeResults.set(query, found.paths);
      return found;
    },
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
        backendKeys: keys,
        service: new ServiceAuth({
          principalsFile: join(state, "principals.json"),
          tokenFile: null,
        }),
        loopbackToken: token,
        serviceOwns: async () => false,
        logger: logger("web", sink),
      }),
    }),
    logger: logger("web", sink),
  });
  const base = `http://127.0.0.1:${running.port}/api/conversations`;
  const get = (
    suffix: string,
    cid = "c1",
    headers: Record<string, string> = {},
  ) => fetch(`${base}/${cid}/tree${suffix}`, { headers });
  const json = async <T>(suffix: string, cid = "c1"): Promise<T> => {
    const response = await get(suffix, cid);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  const measure = async (label: string, path: string) => {
    const response = await exchange(
      running.port,
      requestBytes({
        method: "GET",
        path,
        headers: [["Accept-Encoding", "gzip"]],
      }),
    );
    const normalized = normalise(response, "GET");
    expect(normalized.status).toBe(200);
    const encoding = normalized.headers["content-encoding"] || "identity";
    expect(["gzip", "identity"]).toContain(encoding);
    console.log(
      `explorer-wire ${label}: ${response.byteLength} response bytes (${encoding}, headers/framing included)`,
    );
    return {
      bytes: response.byteLength,
      data: (normalized.body as { json: Record<string, unknown> }).json,
    };
  };
  try {
    expect(
      (await captureFixture(["git", "init", "-q"], { cwd: work })).exitCode,
    ).toBe(0);
    await writeFile(join(work, ".gitignore"), "*.log\nnode_modules/\n");
    await writeFile(join(work, "ignored.log"), "ignored\n");
    await writeFile(join(work, "notes.md"), "# Notes\n\nhello\n");
    await writeFile(
      join(work, "unicode.txt"),
      "é".repeat(EXPLORER_CHUNK_BYTES),
    );
    await mkdir(join(work, "src"));
    await writeFile(
      join(work, "src", "application.ts"),
      "export const application = true;\n",
    );
    await mkdir(join(work, "node_modules"));
    await writeFile(
      join(work, "node_modules", "application-secret.txt"),
      "ignored dependency\n",
    );
    const big = randomBytes(5 * 1024 * 1024)
      .toString("base64")
      .slice(0, 5 * 1024 * 1024);
    await writeFile(join(work, "big.txt"), big);
    await writeFile(join(work, "blob.bin"), new Uint8Array([1, 0, 2]));
    await mkdir(join(work, "many"));
    for (let start = 0; start < 10_050; start += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, 10_050 - start) }, (_, index) =>
          writeFile(join(work, "many", `file-${start + index}.txt`), ""),
        ),
      );
    await writeFile(join(dir, "outside.txt"), "outside\n");
    await symlink(join(dir, "outside.txt"), join(work, "linked-file"));
    await symlink(dir, join(work, "linked-parent"));
    expect(
      (await captureFixture(["mkfifo", join(work, "pipe")], { cwd: work }))
        .exitCode,
    ).toBe(0);
    const credentials = [
      ".env.local",
      "server.pem",
      "id_ed25519",
      ".netrc",
      ".npmrc",
      "auth.json",
      "terraform.tfstate",
      ".ssh/config",
      ".SSH/config",
      ".git/config",
      ".GIT/CONFIG",
      ".kube/config",
      ".docker/config.json",
      ".config/gh/hosts.yml",
    ];
    for (const path of credentials) {
      await mkdir(join(work, path, ".."), { recursive: true });
      await writeFile(
        join(work, path),
        path.toLowerCase() === ".git/config"
          ? "[core]\nrepositoryformatversion = 0\n"
          : "fixture only\n",
      );
    }
    await mkdir(join(state, "worktrees", "demo"), { recursive: true });
    await writeFile(
      join(state, "worktrees", "demo", "allowed.txt"),
      "managed worktree\n",
    );
    await mkdir(join(state, "worktrees", ".markers"));
    await writeFile(
      join(state, "worktrees", ".markers", "demo.json"),
      JSON.stringify({
        version: 1,
        name: "demo",
        path: join(state, "worktrees", "demo"),
        holders: {},
      }),
    );
    await mkdir(join(state, "worktrees", "unmanaged"));
    await writeFile(
      join(state, "worktrees", "unmanaged", "private.txt"),
      "fixture only\n",
    );
    await writeFile(join(state, "private.txt"), "private state\n");
    await symlink(state, join(dir, "state-alias"));
    roots.set("alias", join(dir, "state-alias"));
    await mkdir(join(settings, "pi-agent"), { recursive: true });
    await writeFile(
      join(settings, "pi-agent", "recurse-backends.json"),
      JSON.stringify({ fixture: "not-a-secret" }),
    );
    await symlink(settings, join(dir, "settings-alias"));
    await mkdir(privateWorktree);
    await writeFile(
      join(privateWorktree, "recurse-backends.json"),
      JSON.stringify({ fixture: "not-a-secret" }),
    );
    const root = await json<ExplorerListing>("");
    expect(
      root.entries.find((entry) => entry.name === "ignored.log")?.ignored,
    ).toBe(true);
    expect(
      root.entries.find((entry) => entry.name === ".env.local")?.restricted,
    ).toBe(true);
    expect(
      root.entries.find((entry) => entry.name === "linked-file")?.type,
    ).toBe("symlink");
    const page = await json<ExplorerListing>("?path=many");
    expect(page.entries).toHaveLength(EXPLORER_PAGE_SIZE);
    expect(page.cursor).toBeString();
    expect(
      (await get(`?path=many&cursor=${page.cursor}`, "other")).status,
    ).toBe(409);
    expect((await get(`?path=src&cursor=${page.cursor}`)).status).toBe(409);
    const next = await json<ExplorerListing>(
      `?path=many&cursor=${page.cursor}`,
    );
    expect(next.entries).toHaveLength(EXPLORER_PAGE_SIZE);
    expect(
      next.entries.some((entry) =>
        page.entries.some((first) => first.name === entry.name),
      ),
    ).toBe(false);
    expect((await get(`?path=many&cursor=${page.cursor}`)).status).toBe(409);
    for (const path of [
      "..",
      "../outside.txt",
      "/etc/passwd",
      "src//application.ts",
      "./notes.md",
      "src/\0",
    ]) {
      expect((await get(`?path=${encodeURIComponent(path)}`)).status).toBe(422);
      expect((await get(`/file?path=${encodeURIComponent(path)}`)).status).toBe(
        422,
      );
    }
    for (const path of ["linked-file", "linked-parent/outside.txt", "pipe"])
      for (const suffix of ["file", "raw"])
        expect(
          (await get(`/${suffix}?path=${path}`)).status,
          `${suffix}: ${path}`,
        ).toBe(422);
    expect((await get("?path=linked-parent")).status).toBe(422);
    for (const path of credentials)
      for (const suffix of ["file", "raw"])
        expect(
          (await get(`/${suffix}?path=${encodeURIComponent(path)}`)).status,
        ).toBe(403);
    for (const cid of ["state", "alias", "unmanaged"]) {
      expect((await get("", cid)).status).toBe(403);
      expect((await get("/file?path=private.txt", cid)).status).toBe(403);
      expect((await get("/raw?path=private.txt", cid)).status).toBe(403);
      expect((await get("/search?q=private", cid)).status).toBe(403);
    }
    expect(
      (await get("/file?path=settings/pi-agent/recurse-backends.json", "home"))
        .status,
    ).toBe(403);
    expect(
      (await get("/raw?path=settings/pi-agent/recurse-backends.json", "home"))
        .status,
    ).toBe(403);
    for (const cid of ["settings", "settings-alias", "private-worktree"]) {
      const path =
        cid === "private-worktree"
          ? "recurse-backends.json"
          : "pi-agent/recurse-backends.json";
      expect((await get("", cid)).status).toBe(403);
      expect((await get(`/file?path=${path}`, cid)).status).toBe(403);
      expect((await get(`/raw?path=${path}`, cid)).status).toBe(403);
      expect((await get("/search?q=recurse", cid)).status).toBe(403);
    }
    const home = await json<ExplorerListing>("", "home");
    expect(
      home.entries.find((entry) => entry.name === "settings")?.restricted,
    ).toBe(true);
    expect(
      (await json<ExplorerPreview>("/file?path=allowed.txt", "worktree")).text,
    ).toBe("managed worktree\n");
    for (const suffix of [
      "",
      "/file?path=notes.md",
      "/raw?path=notes.md",
      "/search?q=notes",
    ]) {
      for (const headers of [
        { "x-recurse-agent": "c1" },
        { "x-loopback-token": token },
        {
          "x-loopback-token": token,
          "x-recurse-bundled-tool": "subagent",
          "x-recurse-agent": "c1",
        },
        { authorization: `Bearer ${remote.key}` },
        { authorization: `Bearer recurse_test_${serviceToken}` },
      ] as Record<string, string>[])
        expect(
          (await get(suffix, "c1", headers)).status,
          `${suffix}: ${Object.keys(headers).join(",")}`,
        ).toBe(403);
    }
    expect((await get("", "missing")).status).toBe(404);
    const preview = await json<ExplorerPreview>("/file?path=big.txt");
    expect(preview.text).toBe(big.slice(0, EXPLORER_CHUNK_BYTES));
    expect(preview.next).toBe(EXPLORER_CHUNK_BYTES);
    expect(preview.size).toBe(5 * 1024 * 1024);
    expect(preview.root).toBe(work);
    const rest = await json<ExplorerPreview>(
      `/file?path=big.txt&offset=${preview.next}&version=${encodeURIComponent(preview.version)}`,
    );
    expect(rest.text).toBe(
      big.slice(EXPLORER_CHUNK_BYTES, 2 * EXPLORER_CHUNK_BYTES),
    );
    await writeFile(join(work, "big.txt"), big + "changed");
    expect(
      (
        await get(
          `/file?path=big.txt&offset=${preview.next}&version=${encodeURIComponent(preview.version)}`,
        )
      ).status,
    ).toBe(409);
    await writeFile(join(work, "big.txt"), big);
    const unicode = await json<ExplorerPreview>("/file?path=unicode.txt");
    expect(unicode.text).toBe("é".repeat(EXPLORER_CHUNK_BYTES / 2));
    expect((await json<ExplorerPreview>("/file?path=blob.bin")).kind).toBe(
      "binary",
    );
    const download = await get("/raw?path=notes.md", "c1", {
      range: "bytes=2-6",
    });
    expect(download.status).toBe(206);
    expect(await download.text()).toBe("Notes");
    expect(download.headers.get("content-disposition")).toStartWith(
      "attachment",
    );
    expect(download.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    const found = await json<{ results: string[] }>("/search?q=appts");
    expect(found.results).toEqual(nativeResults.get("appts")!);
    expect(found.results).toContain("src/application.ts");
    expect(
      found.results.some(
        (path) => path.startsWith("node_modules/") || path.startsWith("../"),
      ),
    ).toBe(false);
    const bounded = await json<{ results: string[] }>("/search?q=file");
    expect(bounded.results.length).toBeLessThanOrEqual(50);
    expect(bounded.results.some((path) => path.startsWith("many/"))).toBe(true);
    expect(bounded.results).toEqual(nativeResults.get("file")!);
    const names = await json<{ results: string[] }>("/search?q=.env");
    expect(names.results).toEqual(nativeResults.get(".env")!);
    expect(
      (await stat(join(process.cwd(), "node_modules"))).isDirectory(),
    ).toBeTrue();
    const repoPage = await measure(
      "Recurse root",
      "/api/conversations/repo/tree",
    );
    expect(repoPage.bytes).toBeLessThan(12_000);
    expect(repoPage.data.root).toBe(process.cwd());
    expect(
      (
        await measure(
          "10050-entry folder",
          "/api/conversations/c1/tree?path=many",
        )
      ).bytes,
    ).toBeLessThan(12_000);
    expect(
      (
        await measure(
          "5 MB text preview",
          "/api/conversations/c1/tree/file?path=big.txt",
        )
      ).bytes,
    ).toBeLessThan(20_000);
    const repoSearch = await measure(
      "Recurse fuzzy with node_modules",
      "/api/conversations/repo/tree/search?q=explorer",
    );
    expect(repoSearch.bytes).toBeLessThan(20_000);
    expect(repoSearch.data.results).toContain("web/explorer.ts");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("chdir", { directory: join(work, "src") }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("changed directory"),
    ]);
    await host.send("c1", "Change into src", "explorer-chdir");
    await until(idle(host));
    const moved = await json<ExplorerListing>("");
    expect(moved.root).toBe(join(work, "src"));
    expect(
      (await json<ExplorerPreview>("/file?path=application.ts")).root,
    ).toBe(join(work, "src"));
    expect(moved.entries.map((entry) => entry.name)).toEqual([
      "application.ts",
    ]);
    expect((await get("/file?path=../notes.md")).status).toBe(422);
    expect((await get(`?path=many&cursor=${next.cursor}`)).status).toBe(409);
    expect(
      (await json<{ results: string[] }>("/search?q=application")).results,
    ).toEqual(["application.ts"]);
    expect(
      (await json<{ results: string[] }>("/search?q=notes")).results.every(
        (path) => path === "application.ts",
      ),
    ).toBe(true);
    if (process.platform === "linux") {
      const directoryHandles = async () =>
        Promise.all(
          (await readdir("/proc/self/fd")).map((fd) =>
            readlink(`/proc/self/fd/${fd}`).catch(() => ""),
          ),
        );
      expect(
        (await directoryHandles()).filter((path) => path === join(work, "many"))
          .length,
      ).toBeGreaterThan(0);
      await io.close();
      expect(
        (await directoryHandles()).filter(
          (path) => path === join(work, "many"),
        ),
      ).toEqual([]);
    }
  } finally {
    await running.close();
    await io.close();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
