import { expect, test } from "bun:test";
import { MuseAuth } from "../../src/auth/muse";
import { OpenRouterAuth } from "../../src/auth/openrouter";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "../../src/auth/oauth";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { ProcessLifecycle } from "../../src/process_lifecycle";

test("provider auth errors do not carry secret markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-auth-"));
  const store = new OAuthStore({
    piAgentDir: async () => root,
    ambient: {},
    lifecycle: new ProcessLifecycle({
      registry: new ShellRegistry({
        enabled: false,
        stateDir: root,
        processStartedMs: Date.now(),
      }),
      shellStateDir: root,
    }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "forbidden" }, { status: 403 }),
  });
  try {
    await store.writePending("muse_oauth_pending.json", {
      expires_at: Date.now() / 1000 + 600,
      interval: 5,
      account_token: "MARKER-account-token",
    });
    const muse = new MuseAuth({
      store,
      config: { upsertCustomProvider: () => true },
      env: { MUSE_CODE_API_KEY: "MARKER-env" },
      userAgent: "test",
      timeoutMs: 5000,
      endpoints: {
        device: server.url.href,
        token: server.url.href,
        key: server.url.href,
      },
    });
    const router = new OpenRouterAuth({
      store,
      env: { OPENROUTER_API_KEY: "MARKER-env" },
    });
    await router.setApiKey("  MARKER-openrouter-key\n");
    for (const run of [() => muse.pollLogin(), () => router.setApiKey(null)]) {
      try {
        await run();
        throw new Error("expected auth refusal");
      } catch (error) {
        expect((error as Error).message).not.toContain("MARKER");
        expect((error as Error).message).not.toBe("expected auth refusal");
      }
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
