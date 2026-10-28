import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_ROOT, PI_PACKAGE_ROOT } from "../../src/build_dir";
import { Config, PI_MODEL_ROUTES } from "../../src/config";
import { captureFixture } from "./fixture_subprocess";

const MODULES = join(CHECKOUT_ROOT, "node_modules");
const FFF = join(MODULES, "@ff-labs/pi-fff");

test("pi-fff loads from the installed dependency", () => {
  const resolved = Bun.fileURLToPath(
    import.meta.resolve("@ff-labs/pi-fff/src/index.ts"),
  );
  expect(realpathSync(resolved)).toBe(realpathSync(join(FFF, "src/index.ts")));
});

test("installed Pi lists every model Recurse's defaults and routes use", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-list-"));
  try {
    const run = await captureFixture(
      [process.execPath, join(CHECKOUT_ROOT, "src/pi_auth_worker.mjs")],
      {
        input: `${JSON.stringify({ action: "list_models", providers: PI_MODEL_ROUTES.map(([p]) => p) })}\n`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(root, "home"),
          PI_OFFLINE: "1",
          RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
          RECURSE_PI_AUTH_PATH: join(root, "agent", "auth.json"),
        },
      },
    );
    expect(run.exitCode).toBe(0);
    const reply = JSON.parse(run.stdout.toString().trim());
    expect(reply.kind).toBe("models");
    const config = new Config({
      env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
      authenticatedProviders: () => ["anthropic", "openai-codex"],
    });
    config.setPiModelList(reply.models);
    expect(reply.reasoning_levels_unavailable).toBeUndefined();
    expect(
      reply.models.filter(
        (model: { reasoning_levels?: unknown }) => !model.reasoning_levels,
      ),
    ).toEqual([]);

    const used = new Set<string>();
    for (const authed of [
      ["anthropic"],
      ["openai-codex"],
      ["anthropic", "openai-codex"],
    ]) {
      const ladder = new Config({
        env: { CHAT_DATA_DIR: join(root, "data"), HOME: join(root, "home") },
        authenticatedProviders: () => authed,
      });
      for (const { model } of Object.values(ladder.effortLevels())) {
        used.add(model);
        const route = ladder.modelPolicy(model);
        for (const target of [route.reviewer, route.summary])
          used.add(`${target.provider}/${target.model}`);
      }
    }
    for (const model of used)
      expect([model, config.unlistedModelSentence(model, 1)]).toEqual([
        model,
        null,
      ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

async function listFromPackageCopy(
  piAi: { version: string; source: string } | null,
): Promise<{
  status: number | null;
  reply: {
    kind: string;
    models: { reasoning_levels?: string[] }[];
    reasoning_levels_unavailable?: string;
  };
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-levels-"));
  try {
    const real = realpathSync(PI_PACKAGE_ROOT);
    const copy = join(root, "pkg", "pi-coding-agent");
    mkdirSync(copy, { recursive: true });
    writeFileSync(
      join(copy, "package.json"),
      readFileSync(join(real, "package.json"), "utf8"),
    );
    symlinkSync(join(real, "dist"), join(copy, "dist"));
    if (piAi !== null) {
      const fake = join(root, "pkg", "pi-ai");
      mkdirSync(fake, { recursive: true });
      writeFileSync(
        join(fake, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-ai",
          version: piAi.version,
          type: "module",
          exports: { ".": { import: "./index.js" } },
        }),
      );
      writeFileSync(join(fake, "index.js"), piAi.source);
    }
    const run = await captureFixture(
      [process.execPath, join(CHECKOUT_ROOT, "src/pi_auth_worker.mjs")],
      {
        input: `${JSON.stringify({ action: "list_models", providers: ["anthropic"] })}\n`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(root, "home"),
          PI_OFFLINE: "1",
          RECURSE_PI_PACKAGE_ROOT: copy,
          RECURSE_PI_AUTH_PATH: join(root, "agent", "auth.json"),
        },
      },
    );
    return {
      status: run.exitCode,
      reply: JSON.parse(run.stdout.toString().trim()),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Pi's model list still lists when its reasoning levels cannot be read", async () => {
  const levels = (source: string) => ({ version: "1.3.0", source });
  for (const [piAi, reason] of [
    [null, "pi_ai_unresolved"],
    [{ version: "0.98.0", source: "export const x = 1;" }, "pi_ai_unresolved"],
    [levels("export const other = 1;"), "reasoning_levels_function_missing"],
    [levels("throw new Error('x');"), "pi_ai_import_failed"],
    [
      levels(
        "export function getSupportedThinkingLevels() { throw new Error('x'); }",
      ),
      "reasoning_levels_failed",
    ],
    [
      levels(
        "export function getSupportedThinkingLevels() { return ['huge']; }",
      ),
      "reasoning_levels_failed",
    ],
  ] as const) {
    const { status, reply } = await listFromPackageCopy(piAi);
    expect([reason, status, reply.kind]).toEqual([reason, 0, "models"]);
    expect(reply.reasoning_levels_unavailable).toBe(reason);
    expect(reply.models.length).toBeGreaterThan(5);
    expect(reply.models.some((model) => model.reasoning_levels)).toBe(false);
  }
}, 60_000);
