import { CHECKOUT_ROOT } from "../../src/build_dir";
import { buildApp } from "../../src/web/app";
import { jsonResponse, type Handler } from "../../src/web/router";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { createFixture } from "./server/fixture";
import { routes as sidebar } from "./server/routes/sidebar";
import { routes as artifacts } from "./server/routes/artifacts";
import { routes as git } from "./server/routes/git";
import { routes as files } from "./server/routes/files";
import { routes as thread } from "./server/routes/thread";
import { routes as providers } from "./server/routes/providers";
import { routes as runs } from "./server/routes/runs";
const port = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(port))
  throw new Error("usage: browser_test_app.ts <port>");

let operatorTime: number | undefined;
const app = await buildApp({
  env: process.env,
  sourceRoot: CHECKOUT_ROOT,
  operatorNow: () => operatorTime ?? Date.now() / 1000,
});
const { instance, router } = app;
const fx = createFixture(instance);
const { load } = fx;
const { create } = fx.agents;
const routes = {
  ...sidebar(fx),
  ...artifacts(fx),
  ...git(fx),
  ...files(fx),
  ...thread(fx),
  ...providers(fx),
  ...runs(fx),
};

let ready = false;
let failure: string | null = null;
router.post("/__browser-test/auth-clock", async (ex) => {
  const { now } = (await ex.request.json()) as { now: number };
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("invalid authentication time");
  operatorTime = now;
  return jsonResponse({ now });
});
for (const [name, work] of Object.entries(routes)) {
  const handler: Handler = async (ex) => {
    try {
      return jsonResponse(
        await work(
          ex.request.body === null ||
            ["seed-posted-pdf", "seed-posted-quadrants"].includes(name)
            ? {}
            : await ex.request.json(),
          ex.request,
        ),
      );
    } catch (error) {
      return jsonResponse({ error: String(error) }, 500);
    }
  };
  router.post(`/__browser-test/${name}`, handler);
}
router.get("/__browser-test/ready", async () =>
  failure !== null
    ? jsonResponse({ ready, error: failure }, 500)
    : jsonResponse({ ready }, ready ? 200 : 503),
);

const running = await app.serve({
  host: "127.0.0.1",
  port,
  installSignals: true,
});
await publishLoopbackToken(instance.config.paths.DATA_DIR, running.port);
process.send?.({ type: "browser-test-listening", port: running.port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    running.close().finally(() => {
      const stopped = (globalThis as { browserTestServerStopped?: () => void })
        .browserTestServerStopped;
      if (stopped) stopped();
      else process.exit(0);
    });
  });
try {
  while (!instance.lifecycle.readinessSnapshot().ready) await Bun.sleep(50);
  if (load("main") === null) await create("main", "Agent", null);
  ready = true;
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : `${error}`;
  console.error(`browser test setup failed: ${failure}`);
}
