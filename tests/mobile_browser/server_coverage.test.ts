import { test } from "bun:test";

const port = process.env.RECURSE_SERVER_COVERAGE_PORT;

test.skipIf(!port)(
  "serve the browser test app until SIGTERM",
  async () => {
    const stopped = new Promise<void>((resolve) => {
      (
        globalThis as { browserTestServerStopped?: () => void }
      ).browserTestServerStopped = resolve;
    });
    process.argv[2] = port!;
    await import("./browser_test_app");
    await stopped;
  },
  24 * 60 * 60 * 1000,
);
